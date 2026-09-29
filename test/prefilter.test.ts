/**
 * The guard's local prefilter (src/prefilter.ts): what it reads from a rule and from a tool call, and which rules a
 * call is matched to. Nothing here touches the network or the disk.
 */
import { describe, expect, it } from "vitest";
import { actionFeatures, globToRegExp, keywords, matchRules, pathKind, ruleFeatures, shellWords, snippetAround, splitCommand, stem, type GuardAction, type IndexedRule } from "../src/prefilter.js";

const rule = (id: string, text: string): IndexedRule => ({ id, text, sha: "x", features: ruleFeatures(text) });
const RULES = [
  rule("envrul", "Never commit .env files"),
  rule("pushrl", "Don't force-push to main"),
  rule("pnpmrl", "Use pnpm, never npm"),
  rule("migrat", "Migrations in db/migrations are never edited after they are merged"),
  rule("pemrul", "Keys matching *.pem stay out of the repository"),
  rule("logrul", "No console.log in committed code"),
];
const match = (a: GuardAction, max = 3, minScore = 1) => matchRules(RULES, actionFeatures(a, "/proj"), { max, minScore }).map((c) => c.rule.id);
const bash = (command: string): GuardAction => ({ tool: "Bash", command });

describe("words and stems", () => {
  it("stems the same word the same way on both sides, and drops stop words, numbers and short words", () => {
    expect(new Set(["commit", "commits", "committed", "committing"].map(stem))).toEqual(new Set(["commit"]));
    expect(stem("migrations")).toBe(stem("migration"));
    expect(stem("forced")).toBe(stem("force"));
    expect(keywords("Never commit the .env files, always use 42 of them")).toEqual(["commit"]);
    expect(keywords("userEmail and user_name")).toEqual(expect.arrayContaining(["email", "name"]));
  });

  it("classifies paths, globs and filenames, and leaves words, versions, URLs and abbreviations alone", () => {
    expect(pathKind(".env")).toBe("file");
    expect(pathKind("package-lock.json")).toBe("file");
    expect(pathKind("Dockerfile")).toBe("file");
    expect(pathKind("db/migrations/")).toBe("path");
    expect(pathKind("*.pem")).toBe("glob");
    expect(pathKind("src/**/*.test.ts")).toBe("glob");
    for (const t of ["main", "1.2.3", "v1.2", "e.g.", "i.e.", "https://example.com/a.js", "don't", "."]) expect(pathKind(t), t).toBeNull();
    expect(globToRegExp("*.pem").test("certs/server.pem")).toBe(true);
    expect(globToRegExp("db/*.sql").test("app/db/001.sql")).toBe(true);
    expect(globToRegExp("db/*.sql").test("db/sub/001.sql")).toBe(false);
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
  });
});

describe("rule features", () => {
  it("reads filenames, paths, globs, command words and keywords from a rule", () => {
    expect(ruleFeatures("Never commit .env files")).toEqual({ paths: [], files: [".env"], commands: [], keywords: ["commit"] });
    expect(ruleFeatures("Never use npm in this repo").commands).toEqual(["npm"]);
    expect(ruleFeatures("Don't force-push to main").commands).toContain("git push");
    expect(ruleFeatures("Migrations in db/migrations are never edited").paths).toEqual(["db/migrations"]);
    expect(ruleFeatures("Keys matching *.pem stay out of the repository").paths).toEqual(["*.pem"]);
    const code = ruleFeatures("Never run `npm publish --access public` or `git push --tags` by hand");
    expect(code.commands.sort()).toEqual(["git push", "npm publish"]); // a pair replaces the bare tool
  });

  it("in a rule that both prefers and forbids, commands and keywords come from the forbidding clauses; paths from all", () => {
    expect(ruleFeatures("Use pnpm for everything; never run npm or yarn").commands.sort()).toEqual(["npm", "yarn"]);
    expect(ruleFeatures("Format Python with ruff, not black")).toMatchObject({ commands: ["black"], keywords: [] });
    const gen = ruleFeatures("Everything in docs/api/ is generated from openapi.yaml; never edit it directly");
    expect(gen.paths).toEqual(["docs/api/"]);
    expect(gen.files).toEqual(["openapi.yaml"]);
    expect(gen.keywords).toEqual(["edit"]);
    // A rule with no negation at all keeps everything.
    expect(ruleFeatures("Only the release job runs cargo publish").commands).toEqual(["cargo publish"]);
  });

  it("tool names that are everyday words count only in pairs or code spans; path words are not keywords", () => {
    expect(ruleFeatures("Applies go through the CI pipeline and never through make").commands).toEqual([]);
    expect(ruleFeatures("Never run `go build` with cgo on").commands).toEqual(["go build"]);
    expect(ruleFeatures("Never run make release by hand").commands).toEqual(["make release"]);
    expect(ruleFeatures("Don't hand-edit files in internal/pb/").keywords).not.toContain("intern");
    expect(ruleFeatures("node_modules must never be committed").paths).toEqual(["node_modules"]);
  });
});

describe("shell command lines", () => {
  it("splits compound commands on && || ; | & and newlines, and runs substitutions as commands of their own", () => {
    expect(splitCommand("a && b || c; d | e & f\ng")).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(splitCommand('echo "x && y" \'z; w\'')).toEqual(['echo "x && y" \'z; w\'']);
    expect(splitCommand("echo $(git add .env) `rm x`")).toEqual(["echo", "git add .env", "rm x"]);
    expect(splitCommand('echo "$(git push -f)"')).toEqual(['echo "$(git push -f)"', "git push -f"]);
    expect(splitCommand("(cd app && git add .env)")).toEqual(["cd app", "git add .env"]);
    expect(splitCommand("ls # && rm -rf /")).toEqual(["ls"]);
    expect(splitCommand("make 2>&1 | tee build.log")).toEqual(["make 2>&1", "tee build.log"]);
  });

  it("reads words, redirection targets and operators; heredoc delimiters and descriptors are not files", () => {
    expect(shellWords('git commit -m "add env" > out.txt 2>&1')).toEqual({ words: ["git", "commit", "-m", "add env"], redirects: ["out.txt"], redirectOps: [">"], ops: [">"] });
    expect(shellWords("cat <<'EOF' >> notes.md")).toEqual({ words: ["cat"], redirects: ["notes.md"], redirectOps: [">>"], ops: ["<<", ">>"] });
    expect(shellWords("sort < in.txt 2>/dev/null").redirectOps).toEqual(["<", ">"]);
    expect(shellWords("echo a\\ b 'c d'").words).toEqual(["echo", "a b", "c d"]);
  });

  it("reads >|, &>, &>> and >& as writes to their target, and >&2, 2>&-, <&0 as descriptors (v0.6 part 3c)", () => {
    expect(splitCommand("cat x >| JEVMEM.md")).toEqual(["cat x >| JEVMEM.md"]);
    expect(splitCommand("sort <&0 && ls")).toEqual(["sort <&0", "ls"]);
    expect(shellWords("cat x >| JEVMEM.md")).toEqual({ words: ["cat", "x"], redirects: ["JEVMEM.md"], redirectOps: [">|"], ops: [">|"] });
    expect(shellWords("cat x 2>|out")).toEqual({ words: ["cat", "x"], redirects: ["out"], redirectOps: [">|"], ops: [">|"] });
    expect(shellWords("cat x &> out")).toEqual({ words: ["cat", "x"], redirects: ["out"], redirectOps: ["&>"], ops: ["&>"] });
    expect(shellWords("cat x &>>out")).toEqual({ words: ["cat", "x"], redirects: ["out"], redirectOps: ["&>>"], ops: ["&>>"] });
    expect(shellWords("cat x >& out")).toEqual({ words: ["cat", "x"], redirects: ["out"], redirectOps: [">&"], ops: [">&"] });
    expect(shellWords("cat x >&out")).toEqual({ words: ["cat", "x"], redirects: ["out"], redirectOps: [">&"], ops: [">&"] });
    for (const c of ["make >&2", "make 2>&1", "make 2>&-", "make >& 2", "sort <&0", "sort <&-"]) expect(shellWords(c), c).toEqual({ words: [c.split(" ")[0]], redirects: [], redirectOps: [], ops: [] });
    expect(shellWords("cat < in.txt").redirectOps).toEqual(["<"]);
  });

  it("finds the command word past sudo, env and VAR=value, and git's subcommand past -C", () => {
    const f = actionFeatures(bash("FOO=1 sudo git -C app push --force origin main"));
    expect(f.commands).toEqual(expect.arrayContaining(["git", "git push"]));
    expect(f.keywords).toEqual(expect.arrayContaining(["push", stem("force"), "main"]));
  });
});

describe("call features", () => {
  it("Bash: paths from arguments and redirections, relative to the project; a path outside it gives only its last segment", () => {
    const f = actionFeatures(bash("cp /proj/config/app.yml /tmp/backup/app.yml && echo ok > /Users/someone/notes.txt"), "/proj");
    expect(f.paths).toEqual(expect.arrayContaining(["config/app.yml", "/tmp/backup/app.yml", "/Users/someone/notes.txt"]));
    expect(f.keywords).not.toContain("someon");
    expect(f.keywords).not.toContain(stem("Users"));
  });

  it("Edit and Write: the file, and words, paths and shell commands in the new and replaced text", () => {
    const f = actionFeatures({ tool: "Edit", file: "src/api/users.ts", removed: "return user;", added: "console.log(user);\n  return user;" });
    expect(f.paths).toEqual(["src/api/users.ts"]);
    expect(f.files).toEqual(expect.arrayContaining(["users.ts", "console.log"]));
    const ci = actionFeatures({ tool: "Write", file: ".github/workflows/release.yml", added: "steps:\n  - run: npm publish\n" });
    expect(ci.commands).toEqual(expect.arrayContaining(["npm", "npm publish"]));
  });
});

describe("matching", () => {
  it("plain hits match the rule they break", () => {
    expect(match(bash("git add .env"))[0]).toBe("envrul");
    expect(match(bash("git push -f origin main"))[0]).toBe("pushrl");
    expect(match(bash("npm install lodash"))[0]).toBe("pnpmrl");
    expect(match({ tool: "Edit", file: "db/migrations/0003_users.sql", removed: "a", added: "b" })[0]).toBe("migrat");
    expect(match({ tool: "Write", file: "certs/server.pem", added: "-----BEGIN CERT" })[0]).toBe("pemrul");
    expect(match({ tool: "Edit", file: "src/a.ts", removed: "x", added: "console.log(x)" })[0]).toBe("logrul");
  });

  it("compound commands match on any of their parts", () => {
    expect(match(bash("npm test && git add .env && git commit -m 'env'"))).toEqual(expect.arrayContaining(["envrul", "pnpmrl"]));
  });

  it(".env covers .env.local but not the committed template .env.example", () => {
    expect(match(bash("git add .env.local"))).toContain("envrul");
    const ex = matchRules(RULES, actionFeatures(bash("git add .env.example")), { max: 3, minScore: 1 }).find((c) => c.rule.id === "envrul");
    expect(ex?.reasons ?? []).not.toContain("file .env ~ .env.example");
  });

  it("everyday calls share nothing with the rules: no candidate, nothing leaves the machine", () => {
    for (const c of ["ls -la", "pytest -q tests/", "cat README.md", "mkdir -p build", "go test ./...", "grep -rn TODO src"]) expect(match(bash(c)), c).toEqual([]);
    expect(match({ tool: "Edit", file: "src/app.ts", removed: "const a = 1;", added: "const a = 2;" })).toEqual([]);
  });

  it("an indirect hit is invisible to the prefilter: `git add .` shares nothing with the .env rule", () => {
    expect(match(bash("git add ."))).not.toContain("envrul");
  });

  it("caps the candidates at max, strongest first, and applies minScore", () => {
    const many = Array.from({ length: 8 }, (_, i) => rule(`r${i}`, `Deploys to region${i} go through the deploy pipeline`));
    const got = matchRules(many, actionFeatures(bash("./scripts/deploy.sh --pipeline")), { max: 3, minScore: 1 });
    expect(got).toHaveLength(3);
    expect(matchRules(RULES, actionFeatures(bash("npm test")), { max: 3, minScore: 2 }).map((c) => c.rule.id)).toEqual(["pnpmrl"]);
    expect(matchRules(RULES, actionFeatures(bash("npm test")), { max: 3, minScore: 3 })).toEqual([]);
    // The preferred tool is not a candidate.
    expect(matchRules(RULES, actionFeatures(bash("pnpm test")), { max: 3, minScore: 1 })).toEqual([]);
  });

  it("weights: a broad directory and a common tool are weak; a call's own command word matches a rule keyword", () => {
    const src = [rule("srcrul", "No console.log calls in committed source under src/")];
    const plainEdit = matchRules(src, actionFeatures({ tool: "Edit", file: "src/checkout/total.ts", removed: "a", added: "b" }), { max: 3, minScore: 1 });
    expect(plainEdit.map((c) => c.score)).toEqual([1]);
    expect(matchRules(src, actionFeatures({ tool: "Edit", file: "src/checkout/total.ts", removed: "a", added: "b" }), { max: 3, minScore: 2 })).toEqual([]);
    const gitRule = [rule("gitrul", "Never rewrite git history")];
    expect(matchRules(gitRule, actionFeatures(bash("git status")), { max: 3, minScore: 1 }).map((c) => c.score)).toEqual([1]);
    const fmt = [rule("fmtrul", "Format Python with ruff, not black")];
    expect(matchRules(fmt, actionFeatures(bash("black .")), { max: 3, minScore: 2 }).map((c) => c.rule.id)).toEqual(["fmtrul"]);
    expect(matchRules(fmt, actionFeatures(bash("ruff format .")), { max: 3, minScore: 1 })).toEqual([]);
  });
});

describe("snippet", () => {
  it("keeps short text whole and centres a long one on the first matched term", () => {
    expect(snippetAround("short", ["x"], 100)).toBe("short");
    const long = "a".repeat(2000) + " console.log(secret) " + "b".repeat(2000);
    const s = snippetAround(long, ["console.log"], 300);
    expect(s).toContain("console.log(secret)");
    expect(s.length).toBeLessThanOrEqual(302);
    expect(snippetAround(long, ["missing"], 300).startsWith("aaa")).toBe(true);
  });
});
