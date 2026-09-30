/**
 * Nothing the guard reads may throw (0.6.1). Every call in the eval sets and a list of shell constructs go through the
 * reader, the tamper check, the prefilter, the git parser and the whole check with a mock Jev, each part called on its
 * own and then all of them together; none may throw, and no part may fail. 0.6.0's tamper check threw on `[` after
 * `if` or `while` ("Invalid regular expression: /^(?!\.)[$/") and the call ran unchecked.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandGitStaging, parseGitStaging } from "../src/gitstage.js";
import { evaluateGuard, readGuardConfig, tamperCheck, toAction, type GuardInput } from "../src/guardrail.js";
import { init } from "../src/init.js";
import { actionFeatures, matchRules, ruleFeatures, type IndexedRule } from "../src/prefilter.js";
import { recordProvenance } from "../src/provenance.js";
import { readCommandLine, withDirs } from "../src/shell.js";
import { MemoryStore } from "../src/store.js";
import { mockJev } from "./helpers.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-nothrow-")));
function project(rules: string[]): string {
  const root = tmp();
  init({ root, hooks: false });
  const store = new MemoryStore(root);
  for (const text of rules) recordProvenance(root, store.add({ kind: "constraint", text }), "hook");
  return root;
}
const quiet = mockJev((q) => Object.fromEntries(Object.keys(q).filter((k) => k.startsWith("breaks_")).map((k) => [k, 0.02])));
const j = (...lines: string[]) => lines.join("\n");
const index = (rules: { id: string; text: string }[]): IndexedRule[] => rules.map((x) => ({ id: x.id, text: x.text, sha: "x", features: ruleFeatures(x.text) }));

interface Row {
  type: string;
  project: string;
  id?: string;
  rules?: { id: string; text: string }[];
  tool?: string;
  command?: string;
  file?: string;
  old?: string;
  new?: string;
  content?: string;
  cwd?: string;
}
const read = (f: string): Row[] => fs.readFileSync(path.resolve("eval", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const SETS = ["guard-dev.jsonl", "guard-heldout.jsonl", "guard-heldout-v2.jsonl", "guard-git-dev.jsonl", "guard-shell-dev.jsonl"];

/** Compound commands, functions, subshells, tests, arithmetic, arrays, brace expansion, globs with brackets, process substitution, heredocs and here-strings. */
const CONSTRUCTS = [
  "if [ -f x ]; then git push origin directory; fi",
  "if [[ -f x && -d y ]]; then echo ok; fi",
  "if ! [ -e x ]; then touch x; fi",
  "if test -f x; then echo ok; elif [ -d x ]; then echo dir; else echo none; fi",
  j("if [ -f x ]", "then", "  echo yes", "fi"),
  'while [ -z "$id" ]; do sleep 1; done',
  'while read -r line; do echo "$line"; done < list.txt',
  "until [[ -f done.flag ]]; do sleep 5; done",
  'for f in *.md; do wc -l "$f"; done',
  'for f in src/[a-c]*.ts; do echo "$f"; done',
  "for ((i = 0; i < 3; i++)); do echo $i; done",
  "for i in {1..5}; do echo $i; done",
  "select opt in a b c; do echo $opt; break; done",
  'case "$1" in start) npm start;; stop|halt) npm stop;; *) echo usage;; esac',
  "case $x in [0-9]*) echo number;; esac",
  "deploy() { git push origin main; }",
  "function deploy { git push origin main; }",
  "function deploy() { echo hi; }",
  "f() ( cd /tmp && ls )",
  "( cd sub && npm test )",
  "(cd sub; make) && echo done",
  "$(ls) && echo `date`",
  "(( n = n + 1 ))",
  "n=$((n+1)); echo $n",
  'arr=(a b c); echo "${arr[@]}"; echo ${arr[0]} ${#arr[@]}',
  'declare -A m; m[key]=1; echo "${m[key]}"',
  "echo file{1,2,3}.txt",
  "cp src/{a,b}.ts dest/",
  "mv old{,.bak}",
  "ls [abc]*.txt",
  "rm -f *.[ch]",
  "ls [[:alpha:]]*",
  "echo [",
  "echo ]",
  "echo [[",
  "foo [ -f x ]",
  "grep -E 'x[' file",
  'grep \'a[\' f || echo "no match"',
  "diff <(sort a) <(sort b)",
  "cat < <(echo hi)",
  "tee >(gzip > out.gz) < in",
  j("cat <<EOF", "hello $USER", "EOF"),
  j("cat <<'EOF' > script.sh", "if [ -f x ]; then echo yes; fi", "EOF"),
  j("cat > run.sh <<'EOF'", "while [ $# -gt 0 ]; do shift; done", "EOF", "bash run.sh"),
  j("bash <<'EOF'", 'for f in *; do echo "$f"; done', "EOF"),
  j("cat <<-EOF", "\tindented", "\tEOF"),
  'grep x <<< "here string"',
  j("python3 - <<'PY'", "print([i for i in range(3)])", "PY"),
  "{ echo a; echo b; } > both.txt",
  "! grep -q x f",
  "[ -f x ] && echo yes || echo no",
  "[[ $a == b* ]] && echo prefix",
  "time make",
  "coproc mycop { sleep 1; }",
  "trap 'rm -f \"$tmp\"' EXIT",
  'x="[unclosed"; echo "$x"',
  "echo \"$(printf '[%s]' a)\"",
  "git add 'foo[bar].txt'",
  "git add foo\\[bar\\].txt",
  "git add [",
  "git add '[' ']' '[['",
  "ls ~/[a-z]*",
  "find . -name '*.[ch]' -o -name '[Mm]akefile'",
  'export PATH="[weird]:$PATH"',
  "cd [ && ls",
  "cd '[dir]' && rm -rf .jevmem",
  "rm -rf .jevmem[",
  "rm -rf [.]jevmem",
  "rm JEVMEM.m[d]",
  "cp jevmem.config.js[o]n /tmp/",
  "bash -c 'if [ -f x ]; then git push origin directory; fi'",
  "eval 'while [ 1 ]; do break; done'",
];

/** Every part of the check on one call, each called on its own, then the whole check: nothing may throw or fail. */
async function sweep(root: string, rules: IndexedRule[], input: GuardInput, label: string): Promise<void> {
  const home = process.env.HOME;
  const action = toAction(input, root);
  expect(action, label).not.toBeNull();
  const cwd = input.cwd ?? root;
  if (action!.tool === "Bash") {
    const cmd = action!.command ?? "";
    expect(() => withDirs(readCommandLine(cmd), cwd, home, root), label).not.toThrow();
    expect(() => parseGitStaging(cmd, cwd, home), label).not.toThrow();
    expect(() => expandGitStaging(cmd, { cwd, root, budgetMs: 200, home }), label).not.toThrow();
  }
  const conf = readGuardConfig(root);
  expect(conf.ok, label).toBe(true);
  if (!conf.ok) return;
  const memory = fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8");
  expect(() => tamperCheck(root, conf.cfg, action!, input, conf.text, memory, { cwd, home }), label).not.toThrow();
  expect(() => matchRules(rules, actionFeatures(action!, root, { cwd, home })), label).not.toThrow();
  const t = await evaluateGuard(input, { jev: quiet, root, log: false, noCache: true });
  expect(t.errors, label).toEqual([]);
  expect(t.route, label).not.toBe("error");
}

describe("nothing the guard reads throws", () => {
  for (const file of SETS) {
    it(`every call in eval/${file}`, async () => {
      const rows = read(file);
      const projects = new Map<string, { root: string; rules: IndexedRule[] }>();
      for (const r of rows) if (r.type === "rules") projects.set(r.project, { root: project((r.rules ?? []).map((x) => x.text)), rules: index(r.rules ?? []) });
      let n = 0;
      for (const r of rows) {
        if (r.type !== "call") continue;
        const p = projects.get(r.project)!;
        expect(p, `${file} ${r.id}: unknown project ${r.project}`).toBeDefined();
        const cwd = r.cwd ? path.join(p.root, r.cwd) : p.root;
        fs.mkdirSync(cwd, { recursive: true });
        const tool_input = r.tool === "Bash" ? { command: r.command } : r.tool === "Edit" ? { file_path: path.join(p.root, r.file!), old_string: r.old, new_string: r.new } : { file_path: path.join(p.root, r.file!), content: r.content };
        await sweep(p.root, p.rules, { hook_event_name: "PreToolUse", cwd, tool_name: r.tool, tool_input }, `${file} ${r.id}`);
        n++;
      }
      expect(n).toBeGreaterThan(10);
    });
  }

  it("shell constructs: if/while/until/for/case/select, functions, subshells, [[ ]], (( )), arrays, braces, globs with [ ], process substitution, heredocs, here-strings", async () => {
    const rules = read("guard-shell-dev.jsonl").find((r) => r.type === "rules")!.rules!;
    const root = project(rules.map((x) => x.text));
    const indexed = index(rules);
    for (const c of CONSTRUCTS) await sweep(root, indexed, { hook_event_name: "PreToolUse", cwd: root, tool_name: "Bash", tool_input: { command: c } }, c);
    // The call 0.6.0 let through: `[` is the test command, and the push after `then` is a candidate for the rule.
    const t = await evaluateGuard({ hook_event_name: "PreToolUse", cwd: root, tool_name: "Bash", tool_input: { command: "if [ -f x ]; then git push origin directory; fi" } }, { jev: quiet, root, log: false, noCache: true });
    expect(t.candidates.map((c) => c.rule.text)).toContain("Never push to the `directory` branch by hand; only release.yml moves it.");
    // A tamper ask still comes through a keyword.
    const w = await evaluateGuard({ hook_event_name: "PreToolUse", cwd: root, tool_name: "Bash", tool_input: { command: "if [ -f x ]; then rm -rf .jevmem; fi" } }, { jev: quiet, root, log: false, noCache: true });
    expect([w.errors, w.decision, w.tamper !== null]).toEqual([[], "ask", true]);
  });
});
