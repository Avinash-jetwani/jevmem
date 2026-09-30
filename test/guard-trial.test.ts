/**
 * The guard fixes from the trial (v0.6): the prefilter and the tamper check read a command line the way the shell
 * does (src/shell.ts); the tamper check resolves paths and asks on real writes only; a rule about commit messages is
 * matched against the message a commit would get; a strong candidate Jev could not answer in time is asked about.
 * In process with a mock Jev; the reader itself is tested in test/shell.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { callPayload, decideGuard, evaluateGuard, SEND, tamperCheck, type GuardInput } from "../src/guardrail.js";
import { formatGuardLog } from "../src/guardlog.js";
import { init } from "../src/init.js";
import { actionFeatures, COMMIT_MESSAGE_RULE, keywords, matchRules, ruleFeatures, type IndexedRule } from "../src/prefilter.js";
import { recordProvenance } from "../src/provenance.js";
import { MemoryStore } from "../src/store.js";
import { DEFAULT_CONFIG, type GuardConfig } from "../src/types.js";
import { mockJev, type MockJev } from "./helpers.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-guard-trial-")));
function project(rules: string[] = [], guard: Partial<GuardConfig> = {}): string {
  const root = tmp();
  init({ root, hooks: false });
  const store = new MemoryStore(root);
  for (const text of rules) recordProvenance(root, store.add({ kind: "constraint", text }), "hook");
  const file = path.join(root, "jevmem.config.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.guard = { ...cfg.guard, ...guard };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return root;
}
const bash = (root: string, command: string, cwd = root): GuardInput => ({ hook_event_name: "PreToolUse", session_id: "s1", cwd, permission_mode: "default", tool_name: "Bash", tool_input: { command }, tool_use_id: "t1" });
const breaks = (p: number | Record<string, number>): MockJev => mockJev((q) => Object.fromEntries(Object.keys(q).filter((k) => k.startsWith("breaks_")).map((k) => [k, typeof p === "number" ? p : (p[k.slice(7)] ?? 0.02)])));
const parse = (stdout: string) => JSON.parse(stdout).hookSpecificOutput;
const j = (...lines: string[]) => lines.join("\n");
const rule = (id: string, text: string): IndexedRule => ({ id, text, sha: "x", features: ruleFeatures(text) });
const ENV = "Never commit .env files";
const PUSH = "Don't force-push to main";

describe("the prefilter reads heredocs the way the shell does", () => {
  const RULES = [rule("push", PUSH), rule("pub", "Never run npm publish from a terminal"), rule("tag", "Pushed tags are permanent: never delete a tag")];
  const cands = (command: string) => matchRules(RULES, actionFeatures({ tool: "Bash", command }, "/p")).map((c) => `${c.rule.id}:${c.reasons.join("|")}`);

  it("a heredoc written to a file is checked like a Write of that file: its lines are not commands, its words are", () => {
    const f = actionFeatures({ tool: "Bash", command: j("cat > docs/notes.md <<'EOF'", "# never force-push main", "git push --force origin main", "EOF") }, "/p");
    expect(f.segments).toEqual(["cat > docs/notes.md <<'EOF'"]);
    expect(f.paths).toContain("docs/notes.md");
    // A Write's content gives command words for lines that start with a tool: this one does (`git push` in a script).
    expect(f.commands).toContain("git push");
    expect(f.keywords).toEqual(expect.arrayContaining(["forc", "push", "main"]));
    // The same body fed to a shell is commands; fed to python it is input, whose words are keywords only.
    const run = actionFeatures({ tool: "Bash", command: j("bash <<'EOF'", "git push --force origin main", "EOF") }, "/p");
    expect(run.segments).toEqual(["bash <<'EOF'", "git push --force origin main"]);
    expect(run.commands).toEqual(expect.arrayContaining(["bash", "git", "git push"]));
    const py = actionFeatures({ tool: "Bash", command: j("python3 - <<'EOF'", "print('git push --force origin main')", "EOF") }, "/p");
    expect(py.segments).toEqual(["python3 - <<'EOF'"]);
    expect(py.commands).toEqual(["python3"]);
    expect(py.keywords).toEqual(expect.arrayContaining(["push", "forc", "main"]));
  });

  it("candidates: a script that runs is matched on its commands; bash -c, eval and a written-then-run script too", () => {
    expect(cands(j("bash <<'EOF'", "git push --force origin main", "EOF"))).toEqual(["push:command git push|keyword forc|keyword push|keyword main"]);
    expect(cands("bash -c 'npm publish'")).toEqual(["pub:command npm publish|keyword publish"]);
    expect(cands('eval "npm publish"')).toEqual(["pub:command npm publish|keyword publish"]);
    expect(cands(j("cat > /tmp/x.sh <<'EOF'", "npm publish", "EOF", "sh /tmp/x.sh"))).toEqual(["pub:command npm publish|keyword publish"]);
    // Written and not run: the same features a Write of the file would give (still a candidate; Jev sees a file write).
    expect(cands(j("cat > /tmp/x.sh <<'EOF'", "npm publish", "EOF"))).toEqual(["pub:command npm publish|keyword publish"]);
    expect(cands(j("cat > /tmp/notes.md <<'EOF'", "we never delete a pushed tag", "EOF"))).toEqual(["tag:keyword push|keyword tag|keyword delet"]);
  });

  it("a camelCase word in a rule meets the same word written in capitals in a call", () => {
    expect(keywords("a TypeSafe key")).toEqual(expect.arrayContaining(["type", "safe", "typesaf", "key"]));
    expect(keywords("TYPESAFE_API_KEY=x")).toEqual(expect.arrayContaining(["typesaf", "key"]));
  });
});

describe("rules about commit messages", () => {
  it("are recognised by what they mention, and no other rule is", () => {
    for (const t of ["Commit messages follow Conventional Commits (feat:, fix:, chore: and so on)", "Commits are under Avinash Jetwani's name only, with no Co-Authored-By or other trailers.", "A commit subject begins with its ticket key", "Signed-off-by lines are required on every commit", "No sign-off trailers", "Every commit message ends with a Ticket: footer line"]) expect(COMMIT_MESSAGE_RULE.test(t), t).toBe(true);
    for (const t of [ENV, PUSH, "Never commit with --no-verify; the pre-commit hooks must run", "Migrations under db/migrations are never edited once merged"]) expect(COMMIT_MESSAGE_RULE.test(t), t).toBe(false);
    expect(ruleFeatures("Commit messages follow Conventional Commits").messageRule).toBe(true);
    expect(ruleFeatures(ENV).messageRule).toBeUndefined();
  });

  it("are matched against the message a git commit would get, as a strong match; a commit with no message in the call is not", () => {
    const R = [rule("msg", "Commits are under Avinash Jetwani's name only, with no Co-Authored-By or other trailers."), rule("env", ENV)];
    const cands = (command: string) => matchRules(R, actionFeatures({ tool: "Bash", command }, "/p")).map((c) => [c.rule.id, c.strong, c.reasons.join("|")]);
    expect(cands('git commit -m "docs: x"')).toEqual([["msg", true, "commit message"]]);
    expect(cands('git commit -m "docs: x" -m "Co-Authored-By: Someone <x@example.com>"')).toEqual([["msg", true, "commit message|keyword author"]]);
    expect(cands(j('git commit -m "$(cat <<\'EOF\'', "docs: x", "", "Co-Authored-By: Claude <noreply@anthropic.com>", "EOF", ')"'))).toEqual([["msg", true, "commit message|keyword author"]]);
    expect(actionFeatures({ tool: "Bash", command: 'git commit -m "docs: x" --trailer "Signed-off-by: A <a@example.com>"' }, "/p").message).toBe("docs: x\n\nSigned-off-by: A <a@example.com>");
    expect(cands("git commit")).toEqual([]);
    expect(cands("git commit --amend --no-edit")).toEqual([]);
    expect(cands("git status")).toEqual([]);
  });

  it("the message goes to Jev as `message`, scrubbed, only when a candidate rule is about commit messages", async () => {
    const root = project(["Commits are under Avinash Jetwani's name only, with no Co-Authored-By or other trailers."]);
    const jev = breaks(0.96);
    const t = await evaluateGuard(bash(root, 'git commit -m "docs: x" -m "Co-Authored-By: Someone <x@example.com>"'), { jev });
    expect(t.payload).toEqual({ tool: "Bash", command: 'git commit -m "docs: x" -m "Co-Authored-By: Someone <[REDACTED]>"', message: "docs: x\n\nCo-Authored-By: Someone <[REDACTED]>" });
    expect(parse(t.stdout).permissionDecision).toBe("ask");
    expect((jev.calls[0]!.state as { tool_call: { message: string } }).tool_call.message).toBe("docs: x\n\nCo-Authored-By: Someone <[REDACTED]>");
    // A message read from a file, relative to the folder the command runs in.
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
    fs.writeFileSync(path.join(root, "notes", "msg.txt"), "docs: y\n\nSigned-off-by: B <b@example.com>\n");
    const fromFile = await evaluateGuard(bash(root, "git commit -F notes/msg.txt"), { jev: breaks(0.9) });
    expect(fromFile.payload!.message).toBe("docs: y\n\nSigned-off-by: B <[REDACTED]>\n");
    // From a subfolder (the hook knows the project from CLAUDE_PROJECT_DIR; here `root`).
    const sub = await evaluateGuard(bash(root, "git commit -F msg.txt", path.join(root, "notes")), { jev: breaks(0.9), root });
    expect(sub.payload!.message).toBe("docs: y\n\nSigned-off-by: B <[REDACTED]>\n");
    // With no rule about commit messages, nothing extra is sent and a plain commit is no candidate.
    const other = project([ENV]);
    const plain = await evaluateGuard(bash(other, 'git commit -m "docs: x" -m "Co-Authored-By: Someone <x@example.com>"'), { jev: breaks(0.9) });
    expect(plain.candidates).toEqual([]);
    expect(plain.payload).toBeNull();
    expect(callPayload({ tool: "Bash", command: "git commit -m x" }, [], [], undefined)).toEqual({ tool: "Bash", command: "git commit -m x" });
  });
});

describe("what is sent for a heredoc", () => {
  it("each body is cut to SEND.added characters around what matched, and the command keeps its shape", () => {
    const body = Array.from({ length: 60 }, (_, i) => `echo "step ${i} of the deploy"`).join("\n");
    const command = j("cat > /tmp/deploy.sh <<'EOF'", body, "git push --force origin main", "EOF", "bash /tmp/deploy.sh");
    const p = callPayload({ tool: "Bash", command }, ["push", "forc"]) as { command: string };
    expect(p.command.startsWith("cat > /tmp/deploy.sh <<'EOF'\n")).toBe(true);
    expect(p.command.endsWith("\nEOF\nbash /tmp/deploy.sh")).toBe(true);
    expect(p.command).toContain("git push --force origin main");
    expect(p.command.length).toBeLessThan(SEND.added + 200);
  });
});

describe("the tamper check resolves paths and asks on real writes only", () => {
  const cfg = DEFAULT_CONFIG;
  const memory = "- [constraint] Never commit .env files  <!-- id:abc123 ts:2026-09-30T00:00:00.000Z conf:1.00 -->\n";
  const check = (root: string, command: string, extra: { cwd?: string; home?: string } = {}) => tamperCheck(root, cfg, { tool: "Bash", command }, { cwd: extra.cwd ?? root }, "{}", memory, { cwd: extra.cwd ?? root, home: extra.home ?? "/home/me" });

  it("reads never ask: the known readers, ~/.jevmem/…, another project's files, a name inside a code string, appends", () => {
    const root = "/p";
    const fine = [
      "cut -c1-300 .jevmem/guard-log.jsonl",
      "sort .jevmem/log.jsonl | uniq -c",
      "awk -F, '{print $1}' .jevmem/log.jsonl",
      "gawk '{n++} END {print n}' JEVMEM.md",
      "tr -d '\\r' < JEVMEM.md",
      "nl JEVMEM.md; column -t jevmem.config.json; tac JEVMEM.md; rev JEVMEM.md; fold -w 80 JEVMEM.md",
      "comm -12 JEVMEM.md /tmp/old.md; join /tmp/a .jevmem/b; paste JEVMEM.md /tmp/x",
      "source ~/.jevmem/env",
      '. "$HOME/.jevmem/env"; npm test',
      "cat ~/.jevmem/env | wc -l",
      "rm ~/.jevmem/cache.json",
      "cd ~/other && rm -rf .jevmem",
      "git -C ~/other checkout -- JEVMEM.md",
      "sort -u JEVMEM.md -o /tmp/sorted.md",
      "uniq JEVMEM.md /tmp/uniq.md",
      "awk -i inplace '{print}' /tmp/other.txt",
      "sed 's/a/b/' JEVMEM.md",
      "perl -ne 'print' JEVMEM.md",
      "tee /tmp/copy.md < JEVMEM.md",
      "echo '- [decision] x' >> JEVMEM.md",
      "python3 -c \"print(open('jevmem.config.json').read())\"",
      "cd .jevmem && cat guard-cache.json",
      "pushd .jevmem && ls && popd",
      "git diff JEVMEM.md; git log -p -- JEVMEM.md",
      j("cat > /tmp/notes.md <<'EOF'", "state lives in .jevmem/ and JEVMEM.md", "EOF"),
      j("cat > docs/memory.md <<'EOF'", "delete .jevmem/guard-cache.json to ask again", "EOF"),
      j("cat > /tmp/run.sh <<'EOF'", '. "$HOME/.jevmem/env"', "EOF", "chmod +x /tmp/run.sh"),
      "cp JEVMEM.md /tmp/backup.md",
      "grep -rn jevmem docs/",
    ];
    for (const c of fine) expect(check(root, c), c).toBeNull();
    // Run from a subfolder: a JEVMEM.md there is not the project's.
    expect(check(root, "rm JEVMEM.md", { cwd: "/p/apps/web" })).toBeNull();
  });

  it("writes, moves and deletes of the project's files ask, wherever the command runs from", () => {
    const root = "/p";
    const asked: [string, RegExp][] = [
      ["sort -o JEVMEM.md JEVMEM.md", /JEVMEM\.md/],
      ["uniq /tmp/x.md JEVMEM.md", /JEVMEM\.md/],
      ["awk -i inplace '/constraint/ {next} {print}' JEVMEM.md", /JEVMEM\.md/],
      ["gawk -i inplace '{print}' jevmem.config.json", /jevmem\.config\.json/],
      ["sed -i '' '/constraint/d' JEVMEM.md", /JEVMEM\.md/],
      ["perl -pi -e 's/ask/off/' jevmem.config.json", /jevmem\.config\.json/],
      ["truncate -s 0 .jevmem/guard-cache.json", /\.jevmem/],
      ["touch .jevmem/gate.json", /\.jevmem/],
      ["ln -sf /tmp/x jevmem.config.json", /jevmem\.config\.json/],
      ["dd if=/dev/null of=JEVMEM.md", /JEVMEM\.md/],
      ["cp /tmp/x.json .jevmem/", /\.jevmem/],
      ["cp /tmp/x.json .jevmem/guard-index.json", /\.jevmem/],
      ["mv JEVMEM.md /tmp/", /JEVMEM\.md/],
      ["mv .jevmem /tmp/state", /\.jevmem/],
      ["install -m 644 /tmp/x jevmem.config.json", /jevmem\.config\.json/],
      ["rsync -a /tmp/state/ .jevmem/", /\.jevmem/],
      ["rm -rf .jevmem", /\.jevmem/],
      ["rm .jevmem/*.json", /\.jevmem/],
      ["rm -rf *", /jevmem\.config\.json/],
      ["rm -rf .", /jevmem\.config\.json/],
      ["unlink jevmem.config.json", /jevmem\.config\.json/],
      ["git checkout -- JEVMEM.md", /JEVMEM\.md/],
      ["git checkout HEAD~1 -- JEVMEM.md", /JEVMEM\.md/],
      ["git restore JEVMEM.md", /JEVMEM\.md/],
      ["git restore --staged --worktree jevmem.config.json", /jevmem\.config\.json/],
      ["git rm JEVMEM.md", /JEVMEM\.md/],
      ["git rm --cached jevmem.config.json", /jevmem\.config\.json/],
      ["git clean -fdx", /\.jevmem/],
      ["git clean -fX", /\.jevmem/],
      ["git clean -xdf -- .", /\.jevmem/],
      ["git clean -xdf -- build/", /^$/],
      ["cd apps && rm ../.jevmem/guard-cache.json", /\.jevmem/],
      ["pushd .jevmem && rm guard-cache.json", /\.jevmem/],
      ["git -C . checkout -- JEVMEM.md", /JEVMEM\.md/],
      ["git -C apps checkout -- ../JEVMEM.md", /JEVMEM\.md/],
      ["echo '{}' > jevmem.config.json", /jevmem\.config\.json/],
      ["tee jevmem.config.json < /tmp/x", /jevmem\.config\.json/],
      ["cat /tmp/x | tee .jevmem/gate.json", /\.jevmem/],
      ["bash -c 'rm -rf .jevmem'", /\.jevmem/],
      [j("bash <<'EOF'", "rm JEVMEM.md", "EOF"), /JEVMEM\.md/],
      [j("cat > /tmp/wipe.sh <<'EOF'", "rm -rf .jevmem", "EOF", "bash /tmp/wipe.sh"), /\.jevmem/],
      ["rm -rf $PWD/.jevmem", /\.jevmem/],
      ["rm -rf ./.jevmem/", /\.jevmem/],
      ['rm -rf "$CLAUDE_PROJECT_DIR/.jevmem"', /\.jevmem/],
      ["mv jevmem.config.json jevmem.config.bak", /jevmem\.config\.json/],
      [j("cat > JEVMEM.md <<'EOF'", "# JEVMEM.md", "EOF"), /JEVMEM\.md/],
      [j("cat <<'EOF' > jevmem.config.json", "{}", "EOF"), /jevmem\.config\.json/],
      ["find .jevmem -name '*.json' -delete", /\.jevmem/],
      ["sudo rm -rf .jevmem", /\.jevmem/],
      ["npx some-tool JEVMEM.md", /JEVMEM\.md/],
    ];
    for (const [c, re] of asked) {
      const home = "/home/me";
      const r = check(root, c, { home, cwd: c === "git clean -xdf -- build/" ? root : root });
      if (re.source === "^$") expect(r, c).toBeNull();
      else expect(r ?? "", c).toMatch(re);
    }
    // `~/proj` is the project when HOME/proj is its root.
    expect(check("/home/me/proj", "rm -rf ~/proj/.jevmem")).toMatch(/\.jevmem/);
    expect(check("/home/me/proj", "cd .. && rm -rf proj/.jevmem")).toMatch(/\.jevmem/);
    expect(check("/p", "rm ../JEVMEM.md", { cwd: "/p/internal" })).toMatch(/JEVMEM\.md/);
    // A variable the guard cannot read is not the project's file.
    expect(check("/p", "rm $TARGET")).toBeNull();
    expect(check("/p", "rm -rf $S/.jevmem")).toBeNull();
  });

  it("through evaluateGuard, with the real project: the ask carries the tamper reason and the log keeps it", async () => {
    const root = project([ENV]);
    const jev = breaks(0);
    expect((await evaluateGuard(bash(root, "cut -c1-40 .jevmem/guard-log.jsonl"), { jev })).stdout).toBe("");
    expect((await evaluateGuard(bash(root, "cat ~/.jevmem/env"), { jev, env: { ...process.env, HOME: tmp() } })).stdout).toBe("");
    const asked = await evaluateGuard(bash(root, "git clean -fdx"), { jev });
    expect(parse(asked.stdout).permissionDecisionReason).toBe("jevmem: this command changes jevmem's local state in .jevmem/ (verdicts and cached answers the guard relies on).");
    expect(jev.calls).toHaveLength(0);
  });
});

describe("when Jev does not answer in time", () => {
  const checks = (p: number | null, strong: boolean) => [{ id: "r1", text: ENV, verified: true, p, cached: false, strong }];
  it("decideGuard: a strong candidate is asked about in ask and block mode, never denied; warn adds it as not checked; keywords alone stay fail-open", () => {
    expect(decideGuard("ask", 0.5, 0.9, checks(null, true), null, { unchecked: true })).toEqual({ decision: "ask", stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: `jevmem: couldn't check this call against a saved rule in time: "${ENV}" (JEVMEM.md).` } }) });
    expect(decideGuard("block", 0.5, 0.9, checks(null, true), null, { unchecked: true }).decision).toBe("ask");
    expect(decideGuard("warn", 0.5, 0.9, checks(null, true), null, { unchecked: true })).toEqual({ decision: "warn", stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `Saved project rule in JEVMEM.md, not checked against this call in time: "${ENV}".` } }) });
    expect(decideGuard("ask", 0.5, 0.9, checks(null, false), null, { unchecked: true }).decision).toBe("none");
    // Without the flag (no key, or an answer of null for another reason), nothing changes.
    expect(decideGuard("ask", 0.5, 0.9, checks(null, true), null).decision).toBe("none");
    expect(decideGuard("off", 0.5, 0.9, checks(null, true), null, { unchecked: true }).decision).toBe("none");
    // A tamper reason still comes first, and an answer at hand beats an unanswered one.
    expect(decideGuard("ask", 0.5, 0.9, checks(null, true), "jevmem: tamper", { unchecked: true }).stdout).toContain("jevmem: tamper");
    expect(decideGuard("ask", 0.5, 0.9, [...checks(null, true), { id: "r2", text: PUSH, verified: true, p: 0.02, cached: true, strong: true }], null, { unchecked: true }).decision).toBe("ask");
  });

  it("the default budget is 2,000 ms, capped at 2,500; `jevmem guard log` shows a rule that was not checked in time", () => {
    expect(DEFAULT_CONFIG.guard.budgetMs).toBe(2000);
    const out = formatGuardLog([{ ts: "2026-09-30T10:00:00.000Z", tool: "Bash", route: "jev-failed", decision: "ask", mode: "ask", rules: [{ id: "r1", text: ENV, unchecked: true }], action: "git add .env" }], 20);
    expect(out).toMatch(/rule r1 {2}not checked in time {2}"Never commit \.env files"/);
  });
});
