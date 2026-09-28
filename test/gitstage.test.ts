/**
 * What `git add`, `git stage` and `git commit` would stage or commit (src/gitstage.ts), and the guard matching rules
 * about committing against those files: the parser on its own, then real git in scratch repositories, then the guard
 * with a stand-in Jev (simulated answers).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandGitStaging, parseGitStaging } from "../src/gitstage.js";
import { evaluateGuard, type GuardInput } from "../src/guardrail.js";
import { readGuardLog } from "../src/guardlog.js";
import { init } from "../src/init.js";
import { recordProvenance } from "../src/provenance.js";
import { MemoryStore } from "../src/store.js";
import { mockJev, type MockJev } from "./helpers.js";

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), "jevmem-no-gitconfig"), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" });
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-gitstage-")));
function write(root: string, file: string, text = `${file}\n`) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}
/** A repository with `committed` files in its first commit, then `changes` on top (text, or null to delete). */
function repo(committed: string[], changes: Record<string, string | null> = {}, ignore = [".jevmem/"]): string {
  const root = tmp();
  git(root, "init", "-q");
  write(root, ".gitignore", ignore.join("\n") + "\n");
  for (const f of committed) write(root, f);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  for (const [f, text] of Object.entries(changes)) {
    if (text === null) fs.rmSync(path.join(root, f));
    else write(root, f, text);
  }
  return root;
}
const expand = (command: string, root: string, opts: Partial<Parameters<typeof expandGitStaging>[1]> = {}) => expandGitStaging(command, { cwd: root, root, budgetMs: 2000, env: GIT_ENV, ...opts });
const files = (command: string, root: string, opts: Partial<Parameters<typeof expandGitStaging>[1]> = {}) =>
  Object.fromEntries(expand(command, root, opts).files.map((f) => [f.path, f.state]));

describe("parseGitStaging", () => {
  const one = (command: string, cwd = "/p", home?: string) => parseGitStaging(command, cwd, home);
  it("reads git add, git stage and git commit and their options the way git does", () => {
    expect(one("git add .")).toMatchObject([{ kind: "add", pathspecs: ["."], all: false, update: false, skip: null, cwd: "/p" }]);
    expect(one("git add -A")[0]).toMatchObject({ all: true, pathspecs: [], skip: null });
    expect(one("git add --all -- docs")[0]).toMatchObject({ all: true, pathspecs: ["docs"] });
    expect(one("git add -u")[0]).toMatchObject({ update: true, skip: null });
    expect(one("git add -Af .")[0]).toMatchObject({ all: true, force: true, pathspecs: ["."] });
    expect(one("git stage src")[0]).toMatchObject({ kind: "add", pathspecs: ["src"] });
    expect(one("git commit -am 'add -a flag'")[0]).toMatchObject({ kind: "commit", all: true, pathspecs: [] });
    expect(one("git commit -m 'add -a flag'")[0]).toMatchObject({ all: false, pathspecs: [] });
    expect(one("git commit --message wip --all")[0]).toMatchObject({ all: true, pathspecs: [] });
    expect(one("git commit -n -m x -- src/a.ts")[0]).toMatchObject({ all: false, pathspecs: ["src/a.ts"], skip: null });
    expect(one("git commit -i -F msg.txt src/a.ts")[0]).toMatchObject({ include: true, pathspecs: ["src/a.ts"] });
    expect(one("sudo -E git add -A")[0]).toMatchObject({ all: true });
    expect(one("git status && git log --all && git add -A && git commit -m wip").map((s) => s.kind)).toEqual(["add", "commit"]);
  });

  it("follows cd, pushd and git -C, and gives up on a folder it cannot tell", () => {
    expect(one("cd web && git add .")[0]!.cwd).toBe("/p/web");
    expect(one("pushd web/app; git add .")[0]!.cwd).toBe("/p/web/app");
    expect(one("git -C web -C app add .")[0]!.cwd).toBe("/p/web/app");
    expect(one("cd ~/work && git add .", "/p", "/home/me")[0]!.cwd).toBe("/home/me/work");
    expect(one('cd "$DIR" && git add .')[0]!.cwd).toBeNull();
    expect(one("cd - && git add .")[0]!.cwd).toBeNull();
  });

  it("does not expand what stages nothing or what it cannot follow", () => {
    expect(one("git add")[0]!.skip).toMatch(/no pathspec/);
    expect(one("git add -n .")[0]!.skip).toMatch(/dry run/);
    expect(one("git add --dry-run -A")[0]!.skip).toMatch(/dry run/);
    expect(one("git commit --dry-run -a")[0]!.skip).toMatch(/dry run/);
    expect(one("git add --pathspec-from-file=list.txt")[0]!.skip).toMatch(/file/);
    expect(one("GIT_DIR=/tmp/x git add .")[0]!.skip).toMatch(/GIT_DIR/);
    expect(one("git --work-tree=/tmp/x add .")[0]!.skip).toMatch(/work-tree/);
    expect(one("echo git add . && xargs git add < list")).toEqual([]);
  });
});

describe("expandGitStaging, with real git", () => {
  it("git add -A and git add . take an untracked .env; an ignored one only with -f", () => {
    const root = repo(["src/a.ts"], { "src/a.ts": "changed\n", ".env": "K=1\n" });
    expect(files("git add -A && git commit -m wip", root)).toEqual({ "src/a.ts": "changed", ".env": "untracked" });
    expect(files("git add .", root)).toEqual({ "src/a.ts": "changed", ".env": "untracked" });
    const ignored = repo(["src/a.ts"], { ".env": "K=1\n" }, [".jevmem/", ".env"]);
    expect(files("git add -A", ignored)).toEqual({});
    expect(files("git add -f .", ignored)).toMatchObject({ ".env": "ignored" });
  });

  it("-u and git commit -a take changed tracked files, never untracked ones; git commit takes what is staged", () => {
    const root = repo(["src/a.ts", "config/.env.test"], { "src/a.ts": "changed\n", "config/.env.test": "K=2\n", ".env": "K=1\n", "notes.md": "new\n" });
    expect(files("git add -u", root)).toEqual({ "src/a.ts": "changed", "config/.env.test": "changed" });
    expect(files("git commit -am wip", root)).toEqual({ "src/a.ts": "changed", "config/.env.test": "changed" });
    expect(files("git commit -m wip", root)).toEqual({});
    git(root, "add", ".env");
    expect(files("git commit -m wip", root)).toEqual({ ".env": "staged" });
    // With pathspecs a commit takes only them (and with -i what is staged too).
    expect(files("git commit -m wip -- src/a.ts", root)).toEqual({ "src/a.ts": "changed" });
    expect(files("git commit -i -m wip -- src/a.ts", root)).toEqual({ ".env": "staged", "src/a.ts": "changed" });
  });

  it("pathspecs, the shell's globbing, cd and a project inside a larger repository", () => {
    const root = repo(["web/page.ts", "old.txt"], { ".env": "K=1\n", "web/.env.local": "K=3\n", "web/new.ts": "x\n", "a.json": "{}\n", "web/b.json": "{}\n", "old.txt": null });
    expect(files("cd web && git add .", root)).toEqual({ "web/.env.local": "untracked", "web/b.json": "untracked", "web/new.ts": "untracked" });
    // An unquoted * is the shell's: no dotfiles. A quoted one is git's: it crosses folders.
    expect(Object.keys(files("git add *", root)).sort()).toEqual(["a.json", "web/.env.local", "web/b.json", "web/new.ts"]);
    expect(Object.keys(files("git add '*.json'", root)).sort()).toEqual(["a.json", "web/b.json"]);
    expect(Object.keys(files("git add -A ':!web'", root)).sort()).toEqual([".env", "a.json"]);
    // Deletions put nothing into the commit.
    expect(files("git add -A", root)["old.txt"]).toBeUndefined();
    // The project is web/: paths are relative to it, and files outside it are absolute.
    const got = files("git add -A", path.join(root, "web"));
    expect(got["new.ts"]).toBe("untracked");
    expect(got[`${root}/.env`]).toBe("untracked");
  });

  it("never takes the index lock: it works while another git command holds it, and leaves it alone", () => {
    const root = repo(["src/a.ts"], { ".env": "K=1\n" });
    const lock = path.join(root, ".git", "index.lock");
    fs.writeFileSync(lock, "");
    expect(files("git add -A", root)).toEqual({ ".env": "untracked" });
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("fails open: no repository, no git, a timeout or too much output give no files (or what was read) and a note", () => {
    const plain = tmp();
    const none = expand("git add -A", plain);
    expect(none.files).toEqual([]);
    expect(none.notes.join()).toMatch(/not in a git repository/);
    const root = repo(["src/a.ts"], { ".env": "K=1\n" });
    const missing = expand("git add -A", root, { git: path.join(root, "no-such-git") });
    expect(missing.files).toEqual([]);
    expect(missing.notes.join()).toMatch(/could not run/);
    if (process.platform !== "win32") {
      const slow = path.join(tmp(), "git");
      fs.writeFileSync(slow, "#!/bin/sh\nsleep 5\n");
      fs.chmodSync(slow, 0o755);
      const t = expand("git add -A", root, { git: slow, budgetMs: 150 });
      expect(t.files).toEqual([]);
      expect(t.notes.join()).toMatch(/longer than/);
      expect(t.ms).toBeLessThan(1500);
    }
    // Output is read in pipe-sized chunks, so a cap is reached some way past maxBytes: 4,000 entries are ~100 KB.
    for (let i = 0; i < 4000; i++) write(root, `gen/file-${String(i).padStart(4, "0")}.txt`);
    const cut = expand("git add -A", root, { maxBytes: 1000 });
    expect(cut.files.length).toBeGreaterThan(10);
    expect(cut.files.length).toBeLessThan(4000);
    expect(cut.notes.join()).toMatch(/only what came first/);
    expect(expand("ls -la", root)).toMatchObject({ files: [], commands: [], notes: [] });
  });
});

describe("the guard, with the files git would stage (stand-in Jev, simulated answers)", () => {
  const bash = (root: string, command: string, cwd = root): GuardInput => ({ hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_input: { command } });
  const breaks = (p: number): MockJev => mockJev((q) => Object.fromEntries(Object.keys(q).filter((k) => k.startsWith("breaks_")).map((k) => [k, p])));
  function project(rules: string[], committed: string[], changes: Record<string, string | null>, ignore?: string[]) {
    const root = repo(committed, changes, ignore);
    init({ root, hooks: false });
    const store = new MemoryStore(root);
    for (const text of rules) recordProvenance(root, store.add({ kind: "constraint", text }), "hook");
    return root;
  }

  it("git add -A && git commit with an untracked .env: the rule is a candidate and Jev is told which file", async () => {
    const root = project(["Never commit .env files"], ["src/a.ts"], { ".env": "STRIPE_KEY=sk_test_abcdef1234567890\n", "src/a.ts": "x\n" });
    const jev = breaks(0.9);
    const t = await evaluateGuard(bash(root, "git add -A && git commit -m wip"), { jev, root });
    expect(t.candidates.map((c) => c.reasons)).toEqual([["file .env ~ .env (staged by git)", "keyword commit"]]);
    expect(t.payload).toEqual({ tool: "Bash", command: "git add -A && git commit -m wip", stages: ".env (untracked)" });
    expect((jev.calls[0]!.state as any).tool_call).toEqual(t.payload);
    expect(t.decision).toBe("ask");
    expect(readGuardLog(root).at(-1)!.action).toBe("git add -A && git commit -m wip [stages .env (untracked)]");
  });

  it("nothing is sent when the .env is ignored, for -u and commit -a, or for a rule about editing a path", async () => {
    const rules = ["Never commit .env files", "Everything in docs/api/ is generated from openapi.yaml; never edit it directly"];
    const ignored = project(rules, ["src/a.ts"], { ".env": "K=1\n", "docs/api/users.md": "regenerated\n" }, [".jevmem/", ".env"]);
    const tracked = project(rules, ["src/a.ts"], { ".env": "K=1\n", "src/a.ts": "x\n" });
    for (const [root, command] of [
      [ignored, "git add -A && git commit -m 'regenerate the API docs'"],
      [tracked, "git add -u && git commit -m wip"],
      [tracked, "git commit -am wip"],
    ] as const) {
      const jev = breaks(0.9);
      const t = await evaluateGuard(bash(root, command), { jev, root });
      expect(t.candidates, command).toEqual([]);
      expect(jev.calls, command).toHaveLength(0);
      expect(t.staged!.files.length, command).toBeGreaterThan(0);
    }
  });

  it("git is not asked for a call that is not a git staging command, or when no rule about committing names a file", async () => {
    const root = project(["Never commit .env files"], ["src/a.ts"], { ".env": "K=1\n" });
    expect((await evaluateGuard(bash(root, "ls -la"), { jev: breaks(0.9), root })).staged).toBeNull();
    const other = project(["Never run psql against the production host"], ["src/a.ts"], { ".env": "K=1\n" });
    expect((await evaluateGuard(bash(other, "git add -A"), { jev: breaks(0.9), root: other })).staged).toBeNull();
  });

  it("the command's own folder: cd into a subfolder stages only what is under it", async () => {
    const root = project(["Never commit .env files"], ["web/page.ts"], { ".env": "K=1\n", "web/new.ts": "x\n" });
    const t = await evaluateGuard(bash(root, "cd web && git add . && git commit -m web"), { jev: breaks(0.9), root });
    expect(t.staged!.files).toEqual([{ path: "web/new.ts", state: "untracked" }]);
    expect(t.decision).toBe("none");
    const sub = await evaluateGuard(bash(root, "git add -A", path.join(root, "web")), { jev: breaks(0.9), root });
    expect(sub.decision).toBe("ask"); // -A takes the whole tree from any folder
  });
});
