/**
 * An enabled project with no TypeSafe key anywhere: the hooks do nothing, and the user is told once per project, on a
 * prompt (the only hook output Claude Code shows), what is missing, where jevmem looks and the one command that fixes
 * it. Through the plugin's launcher and through the hooks `jevmem init` registers. The notice comes back only after a
 * key was found and went missing again. `jevmem key` saves a key where every hook finds it.
 */
import { execFileSync, spawn, spawnSync, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli-main.js";
import { cleanPastedKey, resolveJevKey } from "../src/env.js";
import { init, resolveHookCommand, resolveStopCommand } from "../src/init.js";
import { readLog } from "../src/jev.js";
import { MISSING_KEY_NOTICE_INIT, MISSING_KEY_NOTICE_PLUGIN } from "../src/notice.js";
import { MemoryStore } from "../src/store.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";
import { relevance, SAVE_DECISION } from "./helpers.js";

const CLI = path.resolve("dist/cli.js");
const PLUGIN_LAUNCHER = path.resolve("plugin/hooks/jevmem-hook.sh");
const tmp = (p = "jevmem-nokey-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
beforeAll(() => {
  if (!fs.existsSync(CLI)) execFileSync("pnpm", ["build"], { stdio: "ignore" });
}, 60_000);
let fake: FakeJev | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});
/** Async, so the stand-in Jev in this process can answer while the hook runs. */
function runAsync(cmd: string, args: string[], opts: SpawnOptions & { input: string }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout!.on("data", (d) => (stdout += d));
    p.stderr!.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
    p.stdin!.end(opts.input);
  });
}
type Run = (kind: "ups" | "stop", input: string) => Promise<{ status: number | null; stdout: string; stderr: string }>;
async function waitFor(cond: () => boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return cond();
}
const ups = (root: string, session: string) => JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, cwd: root, prompt: "which database do we use?" });
const stopIn = (root: string, text: string) => JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: root, user_message: text });
const noticeOut = (m: string) => JSON.stringify({ systemMessage: m }) + "\n";
const state = (root: string) => JSON.parse(fs.readFileSync(path.join(root, ".jevmem", "state.json"), "utf8"));
/** `jevmem key`, the command the notice names, as a user runs it (the key piped in). */
const saveKey = (home: string, key: string) => spawnSync(process.execPath, [CLI, "key"], { env: { PATH: "/usr/bin:/bin", HOME: home }, input: key + "\n", encoding: "utf8" });

/**
 * The same story through one launcher: no key; three prompts in two sessions and a Stop; then `jevmem key` and a Stop
 * that saves a line and a prompt that gets it; then the key removed again.
 */
async function story(run: Run, root: string, home: string, notice: string) {
  const outputs: string[] = [];
  for (const [kind, input] of [
    ["ups", ups(root, "s1")],
    ["stop", stopIn(root, "We will use Postgres 16 for the primary store.")],
    ["ups", ups(root, "s1")],
    ["ups", ups(root, "s2")],
  ] as const) {
    const r = await run(kind, input);
    expect([r.status, r.stderr]).toEqual([0, ""]);
    outputs.push(r.stdout);
  }
  // Once per project, on the first prompt; the Stop hook is silent; a new session is not told again.
  expect(outputs).toEqual([noticeOut(notice), "", "", ""]);
  expect(typeof state(root).missingKeyNotice).toBe("string");
  expect(new MemoryStore(root).active()).toEqual([]);
  // doctor and stats count these from the log.
  await waitFor(() => readLog(root).filter((e) => /TYPESAFE_API_KEY not set/.test(e.error ?? "")).length >= 4);
  expect(readLog(root).filter((e) => /TYPESAFE_API_KEY not set/.test(e.error ?? "")).map((e) => e.error!.split(":")[0]).sort()).toEqual(["Stop", "UserPromptSubmit", "UserPromptSubmit", "UserPromptSubmit"]);

  // The fix the notice names for `jevmem init` (the plugin's hooks read the same file): then jevmem works.
  fake = await startFakeJev((q: Record<string, any>) => (q.most_relevant ? { most_relevant: Object.keys(q.most_relevant.criteria).find((k) => k !== "none")!, ...relevance(q) } : SAVE_DECISION));
  fs.writeFileSync(path.join(root, ".jevmem", ".env"), `TYPESAFE_BASE_URL=${fake.url}\n`);
  const saved = saveKey(home, "typesafe-test-key-0001");
  expect([saved.status, saved.stderr]).toEqual([0, ""]);
  expect(saved.stdout).not.toContain("typesafe-test-key-0001");
  const s = await run("stop", stopIn(root, "Decision: we use Postgres 16 for the primary store."));
  expect([s.status, s.stdout, s.stderr]).toEqual([0, "", ""]);
  expect(await waitFor(() => new MemoryStore(root).active().length === 1)).toBe(true);
  const u = await run("ups", ups(root, "s3"));
  expect(u.stderr).toBe("");
  const out = JSON.parse(u.stdout);
  // No missing-key notice now; jevmem's first line in this project is announced instead, once.
  expect(out.systemMessage).toBe("jevmem saved its first line to JEVMEM.md.");
  expect(out.hookSpecificOutput.additionalContext).toContain("Postgres 16");
  expect(state(root).missingKeyNotice).toBeUndefined();

  // The key goes missing again: told once more.
  fs.rmSync(path.join(home, ".jevmem", "env"));
  expect((await run("ups", ups(root, "s3"))).stdout).toBe(noticeOut(notice));
  expect((await run("ups", ups(root, "s4"))).stdout).toBe("");
}

describe.skipIf(process.platform === "win32")("no TypeSafe key in an enabled project", () => {
  it("the plugin's launcher: the notice names the plugin setting among the places, and jevmem key as the fix", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const home = tmp();
    const bin = tmp("jevmem-nokey-bin-");
    fs.symlinkSync(CLI, path.join(bin, "jevmem"));
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: tmp(), CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: tmp(), JEVMEM_DAEMON: "0", JEVMEM_CACHE: "0" };
    const run: Run = (kind, input) => runAsync("sh", [PLUGIN_LAUNCHER, ...(kind === "stop" ? ["--detach"] : []), "hook", "--plugin"], { cwd: root, env, input });
    expect(MISSING_KEY_NOTICE_PLUGIN).toMatch(/no TypeSafe API key found.*plugin setting.*TYPESAFE_API_KEY.*\.jevmem\/\.env.*~\/\.jevmem\/env.*To fix it, run jevmem key in a terminal and paste your key \(get one at https:\/\/console\.typesafe\.ai\/keys\)\.$/);
    // No command that names a marketplace, and the same fix as the init hooks'.
    expect(MISSING_KEY_NOTICE_PLUGIN).not.toContain("@");
    expect(MISSING_KEY_NOTICE_PLUGIN.slice(MISSING_KEY_NOTICE_PLUGIN.indexOf("To fix it"))).toBe(MISSING_KEY_NOTICE_INIT.slice(MISSING_KEY_NOTICE_INIT.indexOf("To fix it")));
    await story(run, root, home, MISSING_KEY_NOTICE_PLUGIN);
  });

  it("the hooks `jevmem init` registers: the notice names jevmem key", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const home = tmp();
    // Exactly the commands `jevmem init` writes to .claude/settings.local.json, run the way Claude Code runs them.
    const commands = { ups: resolveHookCommand(root, CLI), stop: resolveStopCommand(root, CLI) };
    expect(commands.stop).toContain("hooks/jevmem-hook.sh");
    const env = { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: tmp(), CLAUDE_PROJECT_DIR: root, JEVMEM_DAEMON: "0", JEVMEM_CACHE: "0" };
    const run: Run = (kind, input) => runAsync("sh", ["-c", commands[kind]], { cwd: root, env, input });
    expect(MISSING_KEY_NOTICE_INIT).toMatch(/no TypeSafe API key found.*TYPESAFE_API_KEY.*\.jevmem\/\.env.*~\/\.jevmem\/env.*run jevmem key/);
    expect(MISSING_KEY_NOTICE_INIT).not.toContain("/plugin");
    await story(run, root, home, MISSING_KEY_NOTICE_INIT);
  });

  it("a project that is not enabled, or a key from the plugin setting: no notice", () => {
    const off = tmp();
    const home = tmp();
    const r = spawnSync(process.execPath, [CLI, "hook"], { cwd: off, env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_PROJECT_DIR: off }, input: ups(off, "s1"), encoding: "utf8" });
    expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
    const root = tmp();
    init({ root, hooks: false });
    const env = { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY: "typesafe-test-key-0002", TYPESAFE_BASE_URL: "http://127.0.0.1:9", JEVMEM_DAEMON: "0" };
    const withKey = spawnSync(process.execPath, [CLI, "hook", "--plugin"], { cwd: root, env, input: ups(root, "s1"), encoding: "utf8" });
    expect([withKey.status, withKey.stdout]).toEqual([0, ""]);
    expect(fs.existsSync(path.join(root, ".jevmem", "state.json")) && state(root).missingKeyNotice).toBeFalsy();
  });
});

/**
 * A command run on a real pseudo-terminal (python3's pty), as in a terminal: each step waits for a text, then types.
 * Returns everything the terminal showed and the exit code.
 */
const PTY = `
import json, os, pty, select, sys, time
argv, env, steps = json.loads(sys.argv[1]), json.loads(sys.argv[2]), json.loads(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    os.execve(argv[0], argv, env)
out = b""
def pump(timeout):
    global out
    r, _, _ = select.select([fd], [], [], timeout)
    if not r:
        return True
    try:
        data = os.read(fd, 4096)
    except OSError:
        return False
    if not data:
        return False
    out += data
    return True
for wait_for, send in steps:
    end = time.time() + 15
    while wait_for.encode() not in out and time.time() < end:
        if not pump(0.1):
            break
    os.write(fd, send.encode())
end = time.time() + 15
while time.time() < end and pump(0.1):
    pass
_, status = os.waitpid(pid, 0)
print(json.dumps({"out": out.decode("utf-8", "replace"), "code": os.waitstatus_to_exitcode(status)}))
`;
function inTerminal(home: string, steps: [string, string][], cwd = tmp()): { out: string; code: number } {
  const env = { PATH: "/usr/bin:/bin", HOME: home, TERM: "xterm" };
  const r = spawnSync("python3", ["-c", PTY, JSON.stringify([process.execPath, CLI, "key"]), JSON.stringify(env), JSON.stringify(steps)], { cwd, encoding: "utf8", timeout: 40_000 });
  if (r.status !== 0) throw new Error(`pty helper failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
/** Every file under `dir` whose text contains `needle`. */
function filesWith(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.readFileSync(p, "utf8").includes(needle)) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}
const SAVED = "Saved your TypeSafe API key to ~/.jevmem/env (readable only by you). jevmem uses it from your next prompt, unless a key from the plugin setting, the environment or the project's .jevmem/.env comes first.\n";

describe("jevmem key", () => {
  const home0 = process.env.HOME;
  afterEach(() => {
    process.env.HOME = home0;
  });
  async function key(stdin: string, home: string) {
    process.env.HOME = home;
    let out = "";
    let err = "";
    const code = await main(["key"], { out: (s) => void (out += s), err: (s) => void (err += s), cwd: tmp() }, { stdin });
    return { code, out, err };
  }

  it("saves the key to ~/.jevmem/env: the folder 700 and the file 600; the key never printed or logged", async () => {
    const home = tmp();
    const r = await key("typesafe-test-key-0003\n", home);
    expect(r).toEqual({ code: 0, out: SAVED, err: "" });
    const file = path.join(home, ".jevmem", "env");
    expect(fs.readFileSync(file, "utf8")).toBe("TYPESAFE_API_KEY=typesafe-test-key-0003\n");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(resolveJevKey(tmp(), {}, home)).toBe("~/.jevmem/env");
    expect(filesWith(home, "typesafe-test-key-0003")).toEqual([file]);
  });

  it("makes an existing folder 700 and an existing file 600, before the key goes in", async () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, ".jevmem"), { mode: 0o755 });
    fs.chmodSync(path.join(home, ".jevmem"), 0o755);
    fs.writeFileSync(path.join(home, ".jevmem", "env"), "OPENAI_API_KEY=sk-other\n", { mode: 0o644 });
    fs.chmodSync(path.join(home, ".jevmem", "env"), 0o644);
    expect((await key("typesafe-test-key-0006", home)).code).toBe(0);
    expect(fs.statSync(path.join(home, ".jevmem")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(home, ".jevmem", "env")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(home, ".jevmem", "env"), "utf8")).toBe("OPENAI_API_KEY=sk-other\nTYPESAFE_API_KEY=typesafe-test-key-0006\n");
  });

  it("does not replace a saved key without a terminal to ask in: nothing changes", async () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, ".jevmem"));
    const before = "OPENAI_API_KEY=sk-other\nexport TYPESAFE_API_KEY=old-key-000000\n";
    fs.writeFileSync(path.join(home, ".jevmem", "env"), before, { mode: 0o600 });
    const r = await key("typesafe-test-key-0004", home);
    expect(r.code).toBe(1);
    expect(r.err).toBe("jevmem key: ~/.jevmem/env already has a TypeSafe API key, so nothing was changed. To replace it, run jevmem key in a terminal: it asks first.\n");
    expect(fs.readFileSync(path.join(home, ".jevmem", "env"), "utf8")).toBe(before);
    expect(r.out + r.err).not.toContain("old-key-000000");
  });

  it.skipIf(process.platform === "win32")("in a terminal: asks for the key without echoing it", () => {
    const home = tmp();
    const t = inTerminal(home, [["TypeSafe API key (input hidden): ", "typesafe-test-key-0007\r"]]);
    expect(t.code).toBe(0);
    expect(t.out).toContain("TypeSafe API key (input hidden): ");
    expect(t.out).toContain("Saved your TypeSafe API key to ~/.jevmem/env");
    expect(t.out).not.toContain("typesafe-test-key-0007");
    expect(fs.readFileSync(path.join(home, ".jevmem", "env"), "utf8")).toBe("TYPESAFE_API_KEY=typesafe-test-key-0007\n");
    expect(filesWith(home, "typesafe-test-key-0007")).toEqual([path.join(home, ".jevmem", "env")]);
  });

  it.skipIf(process.platform === "win32")("in a terminal, with a key saved: asks first; no keeps it, yes replaces it and keeps the other lines", () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, ".jevmem"));
    const file = path.join(home, ".jevmem", "env");
    const before = "OPENAI_API_KEY=sk-other\nexport TYPESAFE_API_KEY=old-key-000000\n\n";
    fs.writeFileSync(file, before, { mode: 0o600 });
    const ASK = "A TypeSafe API key is already saved in ~/.jevmem/env. Replace it? [y/N] ";
    for (const answer of ["\r", "n\r", "no\r"]) {
      const t = inTerminal(home, [[ASK, answer]]);
      expect(t.code, JSON.stringify(answer)).toBe(0);
      expect(t.out).toContain("Kept the key already saved in ~/.jevmem/env.");
      expect(t.out).not.toContain("TypeSafe API key (input hidden)");
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    }
    const t = inTerminal(home, [[ASK, "y\r"], ["TypeSafe API key (input hidden): ", "typesafe-test-key-0008\r"]]);
    expect(t.code).toBe(0);
    expect(t.out).toContain("Saved your TypeSafe API key to ~/.jevmem/env");
    expect(t.out).not.toContain("typesafe-test-key-0008");
    expect(t.out).not.toContain("old-key-000000");
    expect(fs.readFileSync(file, "utf8")).toBe("OPENAI_API_KEY=sk-other\nTYPESAFE_API_KEY=typesafe-test-key-0008\n");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses what cannot be a key, and writes nothing", async () => {
    for (const bad of ["", "   \n", "short", "two words here", "$TYPESAFE_API_KEY", "abc#defghijk", 'a"bcdefghijk']) {
      const home = tmp();
      const r = await key(bad, home);
      expect(r.code, bad).toBe(1);
      expect(r.err).toMatch(/no usable key read, so nothing was changed/);
      expect(fs.existsSync(path.join(home, ".jevmem")), bad).toBe(false);
    }
    expect(cleanPastedKey('  "typesafe-test-key-0005"  ')).toBe("typesafe-test-key-0005");
  });
});
