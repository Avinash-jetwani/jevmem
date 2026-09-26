/**
 * plugin/hooks/jevmem-hook.sh: the plugin runs the jevmem CLI installed from npm. It finds the CLI on PATH or in the
 * usual global bin directories, stays silent when there is none, warns when the CLI is older than the plugin, and the
 * plugin's typesafe_api_key option (userConfig) wins over TYPESAFE_API_KEY without ever being written to a file.
 */
import { execFileSync, spawn, spawnSync, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store.js";
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
  it("without a jevmem CLI anywhere: exit 0, no output, no files, even in an enabled project", async () => {
    const root = enabledProject();
    const home = tmp();
    const data = tmp();
    const tmpdir = tmp();
    const before = [files(root), files(home), files(data), files(tmpdir)];
    const env = { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: data, TMPDIR: tmpdir };
    for (const [args, input] of [[["hook", "--plugin"], ups(root)], [["--detach", "hook", "--plugin"], stop(root)]] as const) {
      const r = spawnSync("sh", [LAUNCHER, ...args], { cwd: root, env, input, encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toBe("");
    }
    await new Promise((r) => setTimeout(r, 500));
    expect([files(root), files(home), files(data), files(tmpdir)]).toEqual(before);
  });

  it("finds the CLI on PATH and runs it; the Stop hook saves the turn", async () => {
    fake = await startFakeJev(() => SAVE_DECISION);
    const root = enabledProject();
    const bin = npmBin();
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp(), CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: tmp(), TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url, JEVMEM_WRITER: "none", JEVMEM_DAEMON: "0" };
    const r = spawnSync("sh", [LAUNCHER, "--detach", "hook", "--plugin"], { cwd: root, env, input: stop(root), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(await waitFor(() => new MemoryStore(root).active().length === 1)).toBe(true);
  });

  it("on a bare PATH (the desktop app), finds a global install under nvm and the node next to it", async () => {
    fake = await startFakeJev(() => SAVE_DECISION);
    const root = enabledProject();
    const home = tmp();
    npmBin(path.join(home, ".nvm", "versions", "node", "v22.9.0", "bin"));
    const env = { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: tmp(), TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url, JEVMEM_WRITER: "none", JEVMEM_DAEMON: "0" };
    const r = spawnSync("sh", [LAUNCHER, "--detach", "hook", "--plugin"], { cwd: root, env, input: stop(root), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(await waitFor(() => new MemoryStore(root).active().length === 1)).toBe(true);
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
      expect(r.stderr).toBe(`jevmem: the installed CLI is 0.4.0, older than this plugin (${PLUGIN_VERSION}); update the jevmem package from npm\n`);
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
      { opt: "ts-from-userconfig", expect: "ts-from-userconfig" },
      { opt: "${user_config.typesafe_api_key}", expect: "ts-from-env" },
      { opt: "", expect: "ts-from-env" },
    ];
    for (const [i, c] of cases.entries()) {
      const root = enabledProject();
      const n = fake.requests.length;
      // Async: a synchronous spawn would block this process, and with it the in-process fake Jev.
      const r = await runAsync(process.execPath, [CLI, "hook", "--plugin"], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: tmp(), CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY: c.opt, TYPESAFE_API_KEY: "ts-from-env", TYPESAFE_BASE_URL: fake.url, JEVMEM_WRITER: "none", JEVMEM_DAEMON: "0", JEVMEM_DEBUG: "1" }, input: stop(root, `Decision ${i}: we use Postgres 16 for the primary store.`), encoding: "utf8" });
      expect(r.status).toBe(0);
      const got = fake.requests.slice(n).map((q) => String(q.headers.authorization ?? q.headers["x-api-key"] ?? ""));
      expect(got.length).toBeGreaterThan(0);
      for (const h of got) expect(h).toContain(c.expect);
      for (const f of files(root)) {
        const body = fs.readFileSync(f, "utf8");
        expect(body.includes("ts-from-userconfig") || body.includes("ts-from-env"), f).toBe(false);
      }
    }
  });
});
