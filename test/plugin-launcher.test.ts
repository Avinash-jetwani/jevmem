/**
 * plugin/hooks/jevmem-hook.sh: the plugin runs the jevmem CLI already on the machine. It finds the CLI with
 * `command -v jevmem`, else the path it cached the last time it found one, else a fixed list of common global bin
 * directories; it runs no package manager. Without a CLI it is silent in a project that is not enabled, and in an
 * enabled one shows the user one message per session on UserPromptSubmit. It warns when the CLI is older than the
 * plugin, and the plugin's typesafe_api_key option (userConfig) wins over TYPESAFE_API_KEY without ever being
 * written to a file.
 */
import { execFileSync, spawn, spawnSync, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store.js";
import { SETUP_NOTICE_TEXTS, setupNoticeRelay } from "../src/setup.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";
import { SAVE_DECISION } from "./helpers.js";

const CLI = path.resolve("dist/cli.js");
const LAUNCHER = path.resolve("plugin/hooks/jevmem-hook.sh");
const PLUGIN_VERSION = JSON.parse(fs.readFileSync("plugin/.claude-plugin/plugin.json", "utf8")).version as string;
const tmp = (p = "jevmem-pl-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
beforeAll(() => {
  if (!fs.existsSync(CLI)) execFileSync("pnpm", ["build"], { stdio: "ignore" });
}, 60_000);
let fake: FakeJev | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

function enabledProject(): string {
  const root = tmp();
  fs.writeFileSync(path.join(root, "jevmem.config.json"), "{}\n");
  return root;
}
function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else out.push(path.join(d, e.name));
    }
  };
  walk(dir);
  return out.sort();
}
/** A global-install-like bin dir: `jevmem` → the built CLI, plus `node`. */
function npmBin(dir = tmp("jevmem-bin-")): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(CLI, path.join(dir, "jevmem"));
  fs.symlinkSync(process.execPath, path.join(dir, "node"));
  return dir;
}
const stop = (root: string, text = "We will use Postgres 16 for the primary store.") => JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: root, user_message: text });
const ups = (root: string) => JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: root, prompt: "add a table" });
function runAsync(cmd: string, args: string[], opts: SpawnOptions & { input: string; encoding?: string }): Promise<{ status: number | null; stdout: string; stderr: string }> {
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
async function waitFor(cond: () => boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return cond();
}

describe.skipIf(process.platform === "win32")("plugin/hooks/jevmem-hook.sh", () => {
  it("in a project that is not enabled: exit 0, no output, no files, with or without a CLI", async () => {
    const root = tmp(); // no jevmem.config.json
    const home = tmp();
    const data = tmp();
    const tmpdir = tmp();
    const before = [files(root), files(home), files(data), files(tmpdir)];
    for (const PATH of ["/usr/bin:/bin", `${npmBin()}:/usr/bin:/bin`]) {
      const env = { PATH, HOME: home, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: data, TMPDIR: tmpdir };
      for (const [args, input] of [[["hook", "--plugin"], ups(root)], [["--detach", "hook", "--plugin"], stop(root)]] as const) {
        const r = spawnSync("sh", [LAUNCHER, ...args], { cwd: root, env, input, encoding: "utf8" });
        expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
      }
    }
    await new Promise((r) => setTimeout(r, 500));
    expect([files(root), files(home), files(data), files(tmpdir)]).toEqual(before);
  });

  it("enabled, no CLI anywhere: UserPromptSubmit shows one message per session, Stop stays silent, nothing written but the list of sessions told", async () => {
    const root = enabledProject();
    const home = tmp();
    const data = tmp();
    const tmpdir = tmp();
    const before = [files(root), files(home), files(tmpdir)];
    const env = { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: data, TMPDIR: tmpdir };
    const run = (args: string[], input: string) => spawnSync("sh", [LAUNCHER, ...args], { cwd: root, env, input, encoding: "utf8" });
    const upsIn = (session: string) => JSON.stringify({ session_id: session, transcript_path: "/x.jsonl", cwd: root, hook_event_name: "UserPromptSubmit", prompt: 'a prompt quoting {"session_id":"other"}' });
    const stopIn = (session: string) => JSON.stringify({ session_id: session, cwd: root, hook_event_name: "Stop" });
    const MESSAGE = "jevmem: CLI not found, so memory is off in this project. See the jevmem README to set it up: https://github.com/Avinash-jetwani/jevmem#readme";
    const outputs: string[] = [];
    for (const [args, input] of [
      [["--detach", "hook", "--plugin"], stopIn("s-1")],
      [["hook", "--plugin"], upsIn("s-1")],
      [["--detach", "hook", "--plugin"], stopIn("s-1")],
      [["hook", "--plugin"], upsIn("s-1")],
      [["hook", "--plugin"], upsIn("s-2")],
      [["hook", "--plugin"], upsIn("s-1")],
    ] as const) {
      const r = run([...args], input);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
      outputs.push(r.stdout);
    }
    const shown = JSON.stringify({ systemMessage: MESSAGE }) + "\n";
    expect(outputs).toEqual(["", shown, "", "", shown, ""]);
    expect(JSON.parse(outputs[1]!)).toEqual({ systemMessage: MESSAGE });
    await new Promise((r) => setTimeout(r, 500));
    expect([files(root), files(home), files(tmpdir)]).toEqual(before);
    expect(files(data)).toEqual([path.join(data, "notified")]);
    expect(fs.readFileSync(path.join(data, "notified"), "utf8")).toBe("s-1\ns-2\n");
  });

  it("finds the CLI on PATH and runs it; the Stop hook saves the turn", async () => {
    fake = await startFakeJev(() => SAVE_DECISION);
    const root = enabledProject();
    const bin = npmBin();
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp(), TMPDIR: tmp(), CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: tmp(), TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url, JEVMEM_WRITER: "none", JEVMEM_DAEMON: "0" };
    const r = spawnSync("sh", [LAUNCHER, "--detach", "hook", "--plugin"], { cwd: root, env, input: stop(root), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(await waitFor(() => new MemoryStore(root).active().length === 1)).toBe(true);
  });

  it("on a bare PATH (the desktop app), uses the CLI path cached by an earlier run that found it on PATH", async () => {
    fake = await startFakeJev(() => SAVE_DECISION);
    const root = enabledProject();
    const bin = npmBin();
    const data = tmp();
    const base = { HOME: tmp(), TMPDIR: tmp(), CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: data, TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url, JEVMEM_WRITER: "none", JEVMEM_DAEMON: "0" };
    // First run from a terminal-started session: jevmem is on PATH, and the launcher caches where.
    expect(spawnSync("sh", [LAUNCHER, "hook", "--plugin"], { cwd: root, env: { ...base, PATH: `${bin}:/usr/bin:/bin` }, input: ups(root), encoding: "utf8" }).status).toBe(0);
    expect(fs.readFileSync(path.join(data, "cli"), "utf8").split("\n")[0]).toBe(path.join(bin, "jevmem"));
    // Then a bare PATH: the cached path is used.
    const r = spawnSync("sh", [LAUNCHER, "--detach", "hook", "--plugin"], { cwd: root, env: { ...base, PATH: "/usr/bin:/bin" }, input: stop(root), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(await waitFor(() => new MemoryStore(root).active().length === 1)).toBe(true);
  });

  // /opt/homebrew/bin and /usr/local/bin come first in the list; a jevmem there would win over the test's HOME.
  const systemCli = ["/opt/homebrew/bin/jevmem", "/usr/local/bin/jevmem"].some((f) => fs.existsSync(f));
  it.skipIf(systemCli)("on a bare PATH with nothing cached, finds the CLI in ~/.local/bin, runs it and caches the path", async () => {
    fake = await startFakeJev(() => SAVE_DECISION);
    const root = enabledProject();
    const home = tmp();
    const bin = npmBin(path.join(home, ".local", "bin"));
    const data = tmp();
    const env = { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: tmp(), CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: data, TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url, JEVMEM_WRITER: "none", JEVMEM_DAEMON: "0" };
    const r = spawnSync("sh", [LAUNCHER, "--detach", "hook", "--plugin"], { cwd: root, env, input: stop(root), encoding: "utf8" });
    expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
    expect(await waitFor(() => new MemoryStore(root).active().length === 1)).toBe(true);
    expect(fs.readFileSync(path.join(data, "cli"), "utf8").split("\n")[0]).toBe(path.join(bin, "jevmem"));
  });

  it.skipIf(systemCli)("search order: PATH, the cached path, ~/.local/bin, ~/.volta/bin, then the newest nvm version that has jevmem", () => {
    const root = enabledProject();
    const home = tmp();
    const ran = path.join(tmp(), "ran");
    // Stand-in CLIs (shell scripts, run directly): report the plugin's version, and record which one ran.
    const stand = (dir: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "jevmem"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${PLUGIN_VERSION}; exit 0; fi\ncat > /dev/null\necho "$0" > "${ran}"\n`, { mode: 0o755 });
      return path.join(dir, "jevmem");
    };
    const nvm = (v: string) => path.join(home, ".nvm", "versions", "node", v, "bin");
    fs.mkdirSync(nvm("v23.0.0"), { recursive: true }); // the newest Node, without jevmem
    const n22 = stand(nvm("v22.10.0"));
    stand(nvm("v22.9.0"));
    stand(nvm("v9.11.2")); // newer than v22 as text, older as a version
    const which = (PATH: string, data = tmp()) => {
      fs.rmSync(ran, { force: true });
      const r = spawnSync("sh", [LAUNCHER, "hook", "--plugin"], { cwd: root, env: { PATH, HOME: home, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: data }, input: ups(root), encoding: "utf8" });
      expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
      return fs.readFileSync(ran, "utf8").trim();
    };
    expect(which("/usr/bin:/bin")).toBe(n22);
    const volta = stand(path.join(home, ".volta", "bin"));
    expect(which("/usr/bin:/bin")).toBe(volta);
    const local = stand(path.join(home, ".local", "bin"));
    expect(which("/usr/bin:/bin")).toBe(local);
    // A cached path wins over the list; PATH wins over both.
    const data = tmp();
    const cached = stand(path.join(tmp(), "cached-bin"));
    expect(which(`${path.dirname(cached)}:/usr/bin:/bin`, data)).toBe(cached);
    expect(which("/usr/bin:/bin", data)).toBe(cached);
    const onPath = stand(path.join(tmp(), "path-bin"));
    expect(which(`${path.dirname(onPath)}:/usr/bin:/bin`, data)).toBe(onPath);
  });

  // Skipped where a node sits on the bare PATH itself (some Linux images).
  it.skipIf(["/usr/bin/node", "/bin/node"].some((f) => fs.existsSync(f)))("enabled, a CLI but no Node 20+ to run it: the same once-per-session message, Stop silent", () => {
    // A copy of the plugin whose launcher looks for Node in missing system paths (this machine may have them).
    const plugin = path.join(tmp(), "plugin");
    fs.cpSync("plugin", plugin, { recursive: true });
    const launcher = path.join(plugin, "hooks", "jevmem-hook.sh");
    const text = fs.readFileSync(launcher, "utf8");
    expect(text).toContain(" /opt/homebrew/bin/node /usr/local/bin/node ");
    fs.writeFileSync(launcher, text.replace(" /opt/homebrew/bin/node /usr/local/bin/node ", " /nonexistent/node /nonexistent/node "));
    const root = enabledProject();
    const bin = tmp("jevmem-nonode-");
    fs.symlinkSync(CLI, path.join(bin, "jevmem")); // a Node script, and no node next to it or on PATH
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp(), CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PLUGIN_DATA: tmp() };
    const run = (args: string[], input: string) => spawnSync("sh", [launcher, ...args], { cwd: root, env, input, encoding: "utf8" });
    const s = run(["--detach", "hook", "--plugin"], stop(root));
    const a = run(["hook", "--plugin"], ups(root));
    const b = run(["hook", "--plugin"], ups(root));
    expect([s.status, s.stdout, s.stderr]).toEqual([0, "", ""]);
    expect([a.status, a.stderr]).toEqual([0, ""]);
    expect(JSON.parse(a.stdout).systemMessage).toBe("jevmem: Node.js 20 or newer not found, so memory is off in this project. See the jevmem README to set it up: https://github.com/Avinash-jetwani/jevmem#readme");
    expect([b.status, b.stdout, b.stderr]).toEqual([0, "", ""]);
  });

  it("runs no package manager or installer, and names none (the directory reads such text as an install step)", () => {
    for (const f of ["plugin/hooks/jevmem-hook.sh", "plugin/hooks/hooks.json"]) {
      const text = fs.readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/\b(npm|npx|pnpm|yarn|bunx?|pip3?|pipx|uvx?|brew)\b/i);
      expect(text, f).not.toMatch(/install/i);
    }
  });

  it("warns once on stderr when the CLI is older than the plugin, keeps working, and checks the version once per CLI file", () => {
    const root = enabledProject();
    const bin = tmp("jevmem-oldbin-");
    const calls = path.join(bin, "version-calls");
    // A stand-in CLI (a shell script, run directly like a version manager's shim): reports 0.4.0, counts --version calls.
    fs.writeFileSync(path.join(bin, "jevmem"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo x >> "${calls}"; echo 0.4.0; exit 0; fi\ncat > /dev/null\nexit 0\n`, { mode: 0o755 });
    const data = tmp();
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp(), CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: data };
    const a = spawnSync("sh", [LAUNCHER, "hook", "--plugin"], { cwd: root, env, input: ups(root), encoding: "utf8" });
    const b = spawnSync("sh", [LAUNCHER, "hook", "--plugin"], { cwd: root, env, input: ups(root), encoding: "utf8" });
    for (const r of [a, b]) {
      expect(r.status).toBe(0);
      expect(r.stderr).toBe(`jevmem: the jevmem CLI is 0.4.0, older than this plugin (${PLUGIN_VERSION}); update the jevmem CLI\n`);
    }
    expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1); // cached in CLAUDE_PLUGIN_DATA
    // The same CLI version as the plugin: no warning.
    fs.writeFileSync(path.join(bin, "jevmem"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${PLUGIN_VERSION}; exit 0; fi\ncat > /dev/null\n`, { mode: 0o755 });
    const c = spawnSync("sh", [LAUNCHER, "hook", "--plugin"], { cwd: root, env, input: ups(root), encoding: "utf8" });
    expect(c.stderr).toBe("");
  });
});

describe("the API key", () => {
  it("the plugin's typesafe_api_key option wins over TYPESAFE_API_KEY; an unsubstituted ${user_config…} falls back; the key is never written to a file", async () => {
    fake = await startFakeJev(() => SAVE_DECISION);
    const cases = [
      { opt: "<key from user config>", expect: "<key from user config>" },
      { opt: "${user_config.typesafe_api_key}", expect: "<key from env>" },
      { opt: "", expect: "<key from env>" },
    ];
    for (const [i, c] of cases.entries()) {
      const root = enabledProject();
      const n = fake.requests.length;
      // Async: a synchronous spawn would block this process, and with it the in-process fake Jev.
      const r = await runAsync(process.execPath, [CLI, "hook", "--plugin"], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: tmp(), CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY: c.opt, TYPESAFE_API_KEY: "<key from env>", TYPESAFE_BASE_URL: fake.url, JEVMEM_WRITER: "none", JEVMEM_DAEMON: "0", JEVMEM_DEBUG: "1" }, input: stop(root, `Decision ${i}: we use Postgres 16 for the primary store.`), encoding: "utf8" });
      expect(r.status).toBe(0);
      const got = fake.requests.slice(n).map((q) => String(q.headers.authorization ?? q.headers["x-api-key"] ?? ""));
      expect(got.length).toBeGreaterThan(0);
      for (const h of got) expect(h).toContain(c.expect);
      for (const f of files(root)) {
        const body = fs.readFileSync(f, "utf8");
        expect(body.includes("<key from user config>") || body.includes("<key from env>"), f).toBe(false);
      }
    }
  });
});

// 0.7.2: the one-time setup message on the SessionStart hook (--start), once per machine (~/.jevmem/setup-notice). The
// launcher reads no key: its two states are no CLI, and the CLI there but this project not turned on; a project that
// is on gets the CLI, which says itself when no key is saved. Since 0.7.3 the message shows only where Claude Code's
// entrypoint says the marker persists (the describe below), so these tests run as the desktop app's Code tab.
describe.skipIf(process.platform === "win32")("the one-time setup message (0.7.2)", () => {
  const start = (root: string, session = "s1") => JSON.stringify({ hook_event_name: "SessionStart", session_id: session, cwd: root, source: "startup", transcript_path: "/x.jsonl" });
  const baseEnv = (root: string, home: string, PATH = "/usr/bin:/bin") => ({ PATH, HOME: home, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: tmp(), TMPDIR: tmp(), CLAUDE_CODE_ENTRYPOINT: "claude-desktop" });
  const run = (root: string, env: Record<string, string>, input = start(root), args = ["--start", "hook", "--plugin"]) => spawnSync("sh", [LAUNCHER, ...args], { cwd: root, env, input, encoding: "utf8" });
  const marker = (home: string) => {
    try {
      return fs.readFileSync(path.join(home, ".jevmem", "setup-notice"), "utf8").trim();
    } catch {
      return null;
    }
  };
  const keyFile = (home: string) => {
    fs.mkdirSync(path.join(home, ".jevmem"), { recursive: true });
    fs.writeFileSync(path.join(home, ".jevmem", "env"), "TYPESAFE_API_KEY=<example key>\n");
  };

  it("the launcher's two texts are the library's, word for word, with no quote or backslash in them; it names no key file and no key variable", () => {
    const sh = fs.readFileSync(LAUNCHER, "utf8");
    expect(Object.keys(SETUP_NOTICE_TEXTS).sort()).toEqual(["no-cli", "not-on"]);
    for (const [state, text] of Object.entries(SETUP_NOTICE_TEXTS)) {
      expect(sh, state).toContain(`"${text}"`);
      expect(text).not.toMatch(/["\\]/);
    }
    // The directory's review lists a hook that reads a credential from the machine: the launcher reads none.
    expect(sh).not.toMatch(/TYPESAFE_API_KEY|\.jevmem\/env|CLAUDE_PLUGIN_OPTION/);
  });

  it("no CLI, a project not turned on: the no-CLI text once per machine, as systemMessage and as context for Claude; nothing in the project", () => {
    const root = tmp();
    const home = tmp();
    const before = files(root);
    const a = run(root, baseEnv(root, home));
    expect([a.status, a.stderr]).toEqual([0, ""]);
    const out = JSON.parse(a.stdout);
    expect(out.systemMessage).toBe(SETUP_NOTICE_TEXTS["no-cli"]);
    expect(out.hookSpecificOutput).toEqual({ hookEventName: "SessionStart", additionalContext: setupNoticeRelay(SETUP_NOTICE_TEXTS["no-cli"]) });
    expect(marker(home)).toMatch(/^shown no-cli 20\d\d-\d\d-\d\dT/);
    expect(files(root)).toEqual(before);
    // A resume of the same session and a new session: nothing more, ever.
    for (const input of [start(root, "s1"), start(root, "s2")]) {
      const r = run(root, baseEnv(root, home), input);
      expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
    }
    // The other hooks in a project that is not on stay silent, marker or not.
    const u = run(root, baseEnv(root, tmp()), ups(root), ["hook", "--plugin"]);
    expect([u.status, u.stdout, u.stderr]).toEqual([0, "", ""]);
  });

  it("in the terminal (CLAUDE_CODE_ENTRYPOINT=cli) the message is the systemMessage alone; the opt-out is a marker made by hand", () => {
    const root = tmp();
    const home = tmp();
    const r = run(root, { ...baseEnv(root, home), CLAUDE_CODE_ENTRYPOINT: "cli" });
    expect(JSON.parse(r.stdout)).toEqual({ systemMessage: SETUP_NOTICE_TEXTS["no-cli"] });
    const home2 = tmp();
    fs.mkdirSync(path.join(home2, ".jevmem"));
    fs.writeFileSync(path.join(home2, ".jevmem", "setup-notice"), "");
    const o = run(root, baseEnv(root, home2));
    expect([o.status, o.stdout, o.stderr]).toEqual([0, "", ""]);
    expect(fs.readFileSync(path.join(home2, ".jevmem", "setup-notice"), "utf8")).toBe("");
  });

  it("the CLI there but this project not on: the not-on text, whether or not a key is saved or set (the launcher does not look)", () => {
    const bin = npmBin();
    const root = tmp();
    const PATH = `${bin}:/usr/bin:/bin`;
    const home = tmp();
    const r = run(root, baseEnv(root, home, PATH));
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(JSON.parse(r.stdout).systemMessage).toBe(SETUP_NOTICE_TEXTS["not-on"]);
    expect(marker(home)).toMatch(/^shown not-on /);
    const home2 = tmp();
    keyFile(home2);
    const r2 = run(root, baseEnv(root, home2, PATH));
    expect(JSON.parse(r2.stdout).systemMessage).toBe(SETUP_NOTICE_TEXTS["not-on"]);
    expect(r2.stdout + r2.stderr).not.toContain("<example key>");
    expect(JSON.parse(run(root, { ...baseEnv(root, tmp(), PATH), CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY: "<example key>" }).stdout).systemMessage).toBe(SETUP_NOTICE_TEXTS["not-on"]);
    expect(JSON.parse(run(root, { ...baseEnv(root, tmp(), PATH), TYPESAFE_API_KEY: "<example key>" }).stdout).systemMessage).toBe(SETUP_NOTICE_TEXTS["not-on"]);
  });

  it("the CLI there and the project on: the marker says done and the launcher says nothing, with or without a key; the CLI's own notice covers a missing key", async () => {
    const bin = npmBin();
    const PATH = `${bin}:/usr/bin:/bin`;
    const root = enabledProject();
    const data = tmp();
    for (const withKey of [true, false]) {
      const home = tmp();
      if (withKey) keyFile(home);
      const r = await runAsync("sh", [LAUNCHER, "--start", "hook", "--plugin"], { cwd: root, env: { ...baseEnv(root, home, PATH), CLAUDE_PLUGIN_DATA: data, JEVMEM_DAEMON: "0" }, input: start(root), encoding: "utf8" });
      expect([r.status, r.stdout, r.stderr], `key saved: ${withKey}`).toEqual([0, "", ""]); // no always-on lines, no message
      expect(marker(home)).toMatch(/^done /);
      const again = await runAsync("sh", [LAUNCHER, "--start", "hook", "--plugin"], { cwd: root, env: { ...baseEnv(root, home, PATH), CLAUDE_PLUGIN_DATA: data, JEVMEM_DAEMON: "0" }, input: start(root, "s2"), encoding: "utf8" });
      expect([again.status, again.stdout, again.stderr]).toEqual([0, "", ""]);
    }
  });
});

// 0.7.3: the message and its marker only where the marker persists and the advice fits: a terminal (`cli`), the desktop
// app's Code tab (`claude-desktop`), the VS Code extension (`claude-vscode`) and the desktop app's SSH sessions
// (`ssh-remote`). A cloud session (CLAUDE_CODE_REMOTE=true, or an entrypoint that starts with `remote`, as a claude.ai
// chat's `remote_cowork` does), Cowork on the desktop (`local-agent`, CLAUDE_CODE_IS_COWORK) and every other entrypoint,
// unset included (`sdk-cli` is every `claude -p`), get no message and no marker: nothing is written anywhere. 0.7.2 showed
// the message at the start of every cloud chat, since each chat's workspace is new and its marker went with it. The
// per-session "CLI not found" line in a project that is on stays silent in a cloud or Cowork session and as it was elsewhere.
describe.skipIf(process.platform === "win32")("where the one-time message shows (0.7.3)", () => {
  const start = (root: string, session = "s1") => JSON.stringify({ hook_event_name: "SessionStart", session_id: session, cwd: root, source: "startup", transcript_path: "/x.jsonl" });
  const upsIn = (root: string, session: string) => JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, cwd: root, transcript_path: "/x.jsonl", prompt: "add a table" });
  const env = (root: string, home: string, extra: Record<string, string>, PATH = "/usr/bin:/bin") => ({ PATH, HOME: home, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: tmp(), TMPDIR: tmp(), ...extra });
  const run = (root: string, e: Record<string, string>, input: string, args = ["--start", "hook", "--plugin"]) => spawnSync("sh", [LAUNCHER, ...args], { cwd: root, env: e, input, encoding: "utf8" });
  const marker = (home: string) => {
    try {
      return fs.readFileSync(path.join(home, ".jevmem", "setup-notice"), "utf8").trim();
    } catch {
      return null;
    }
  };
  const MESSAGE = "jevmem: CLI not found, so memory is off in this project. See the jevmem README to set it up: https://github.com/Avinash-jetwani/jevmem#readme";
  // A cloud session, Cowork on the desktop, Claude Tag, GitHub Actions: Claude Code's own values, and its two variables.
  const REMOTE: Record<string, string>[] = [
    { CLAUDE_CODE_REMOTE: "true" },
    { CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_ENTRYPOINT: "cli" }, // the variable wins over the entrypoint
    { CLAUDE_CODE_IS_COWORK: "1" },
    { CLAUDE_CODE_ENTRYPOINT: "remote_cowork" },
    { CLAUDE_CODE_ENTRYPOINT: "remote_desktop" },
    { CLAUDE_CODE_ENTRYPOINT: "remote" },
    { CLAUDE_CODE_ENTRYPOINT: "local-agent" },
    { CLAUDE_CODE_ENTRYPOINT: "local_agent" },
    { CLAUDE_CODE_ENTRYPOINT: "claude-in-teams" },
    { CLAUDE_CODE_ENTRYPOINT: "claude_in_slack" },
    { CLAUDE_CODE_ENTRYPOINT: "claude-code-github-action" },
  ];
  // Not placed: a `claude -p` run (sdk-cli), SDK apps, an MCP launch, a value not known, and no value at all.
  const OTHER: Record<string, string>[] = [{ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }, { CLAUDE_CODE_ENTRYPOINT: "mcp" }, { CLAUDE_CODE_ENTRYPOINT: "something-new" }, {}];

  it("a cloud or Cowork session, and any entrypoint not placed: no message, no marker, no ~/.jevmem, nothing in the project or the plugin data", () => {
    for (const extra of [...REMOTE, ...OTHER]) {
      const root = tmp();
      const home = tmp();
      const before = files(root);
      const e = env(root, home, extra);
      for (const input of [start(root, "s1"), start(root, "s2")]) {
        const r = run(root, e, input);
        expect([r.status, r.stdout, r.stderr], JSON.stringify(extra)).toEqual([0, "", ""]);
      }
      expect(fs.existsSync(path.join(home, ".jevmem")), JSON.stringify(extra)).toBe(false);
      expect(files(home), JSON.stringify(extra)).toEqual([]);
      expect(files(root)).toEqual(before);
      expect(files(e.CLAUDE_PLUGIN_DATA)).toEqual([]);
    }
  });

  it("a terminal gets the message alone; the Code tab, the VS Code extension and the desktop app's SSH sessions get it with the context for Claude; once per computer, whichever showed it", () => {
    for (const [entry, relay] of [
      ["cli", false],
      ["claude-desktop", true],
      ["claude-vscode", true],
      ["ssh-remote", true],
    ] as const) {
      const root = tmp();
      const home = tmp();
      const e = env(root, home, { CLAUDE_CODE_ENTRYPOINT: entry });
      const first = run(root, e, start(root));
      expect([first.status, first.stderr], entry).toEqual([0, ""]);
      const out = JSON.parse(first.stdout);
      expect(out.systemMessage, entry).toBe(SETUP_NOTICE_TEXTS["no-cli"]);
      if (relay) expect(out.hookSpecificOutput, entry).toEqual({ hookEventName: "SessionStart", additionalContext: setupNoticeRelay(SETUP_NOTICE_TEXTS["no-cli"]) });
      else expect(out.hookSpecificOutput, entry).toBeUndefined();
      expect(marker(home), entry).toMatch(/^shown no-cli 20\d\d-/);
      // The same computer, a new session, and the other local entrypoints: nothing more.
      for (const next of ["cli", "claude-desktop", "claude-vscode", "ssh-remote"]) {
        const again = run(root, env(root, home, { CLAUDE_CODE_ENTRYPOINT: next }), start(root, "s2"));
        expect([again.status, again.stdout, again.stderr], `${entry} then ${next}`).toEqual([0, "", ""]);
      }
    }
  });

  it("the CLI there and the project on: in a cloud session the CLI runs as today and no marker is written; in the Code tab the marker says done", async () => {
    const bin = npmBin();
    const PATH = `${bin}:/usr/bin:/bin`;
    const root = enabledProject();
    const home = tmp();
    const remote = await runAsync("sh", [LAUNCHER, "--start", "hook", "--plugin"], { cwd: root, env: { ...env(root, home, { CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_ENTRYPOINT: "remote_cowork" }, PATH), JEVMEM_DAEMON: "0" }, input: start(root), encoding: "utf8" });
    expect([remote.status, remote.stdout, remote.stderr]).toEqual([0, "", ""]); // the CLI ran: no always-on lines, no message
    expect(marker(home)).toBeNull();
    expect(files(home)).toEqual([]);
    const home2 = tmp();
    const local = await runAsync("sh", [LAUNCHER, "--start", "hook", "--plugin"], { cwd: root, env: { ...env(root, home2, { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, PATH), JEVMEM_DAEMON: "0" }, input: start(root), encoding: "utf8" });
    expect([local.status, local.stdout, local.stderr]).toEqual([0, "", ""]);
    expect(marker(home2)).toMatch(/^done /);
  });

  it("the per-session CLI-not-found line in a project that is on: silent in a cloud or Cowork session, once per session elsewhere; Stop silent throughout", () => {
    const silent: Record<string, string>[] = [{ CLAUDE_CODE_REMOTE: "true" }, { CLAUDE_CODE_ENTRYPOINT: "remote_cowork" }, { CLAUDE_CODE_ENTRYPOINT: "local-agent" }, { CLAUDE_CODE_IS_COWORK: "1" }];
    for (const extra of silent) {
      const root = enabledProject();
      const home = tmp();
      const e = env(root, home, extra);
      const before = files(root);
      for (const [args, input] of [
        [["hook", "--plugin"], upsIn(root, "s1")],
        [["--detach", "hook", "--plugin"], stop(root)],
        [["hook", "--plugin"], upsIn(root, "s2")],
      ] as const) {
        const r = run(root, e, input, [...args]);
        expect([r.status, r.stdout, r.stderr], JSON.stringify(extra)).toEqual([0, "", ""]);
      }
      expect(files(e.CLAUDE_PLUGIN_DATA), JSON.stringify(extra)).toEqual([]); // no list of sessions told
      expect(files(home)).toEqual([]);
      expect(files(root)).toEqual(before);
    }
    const told: Record<string, string>[] = [{ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, { CLAUDE_CODE_ENTRYPOINT: "cli" }, { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, {}];
    for (const extra of told) {
      const root = enabledProject();
      const e = env(root, tmp(), extra);
      const a = run(root, e, upsIn(root, "s1"), ["hook", "--plugin"]);
      expect([a.status, JSON.parse(a.stdout), a.stderr], JSON.stringify(extra)).toEqual([0, { systemMessage: MESSAGE }, ""]);
      const b = run(root, e, upsIn(root, "s1"), ["hook", "--plugin"]);
      expect([b.status, b.stdout, b.stderr], JSON.stringify(extra)).toEqual([0, "", ""]);
    }
  });
});
