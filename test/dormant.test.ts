/**
 * Opt-in per project. In a project without jevmem.config.json, the plugin's hooks (through the launcher), the plain
 * `jevmem hook` command and the MCP server make no Jev request, write no file (in the project, the home directory,
 * the plugin data directory or the temp directory) and print nothing. After `jevmem enable`, the same hook saves.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";
import { SAVE_DECISION } from "./helpers.js";

const CLI = path.resolve("dist/cli.js");
const LAUNCHER = path.resolve("plugin/hooks/jevmem-hook.sh");
/** A bin directory with `jevmem` (the built CLI, as `npm install -g` would link it) and `node`, like a global install. */
function binDir(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-bin-")));
  fs.symlinkSync(CLI, path.join(d, "jevmem"));
  fs.symlinkSync(process.execPath, path.join(d, "node"));
  return d;
}
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-dormant-")));
beforeAll(() => {
  if (!fs.existsSync(CLI)) execFileSync("pnpm", ["build"], { stdio: "ignore" });
}, 60_000);

let fake: FakeJev | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

/** Every file and directory under `dirs`, with a content hash. */
function snapshot(dirs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        out[p] = "dir";
        walk(p);
      } else out[p] = crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex");
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

function world() {
  const project = tmp();
  fs.writeFileSync(path.join(project, "package.json"), '{"name":"client-app"}\n');
  fs.writeFileSync(path.join(project, "README.md"), "# Client app\n");
  const home = tmp();
  fs.mkdirSync(path.join(home, ".jevmem"));
  fs.writeFileSync(path.join(home, ".jevmem", "env"), "TYPESAFE_API_KEY=test-key\n"); // a key is available: dormancy is not "no key"
  const pluginData = tmp();
  const tmpdir = tmp();
  return { project, home, pluginData, tmpdir, bin: binDir(), dirs: [project, home, pluginData, tmpdir] };
}

function env(w: ReturnType<typeof world>, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home, TMPDIR: w.tmpdir, CLAUDE_PROJECT_DIR: w.project, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: w.pluginData, TYPESAFE_BASE_URL: fake!.url, JEVMEM_WRITER: "none", JEVMEM_DAEMON: "0", ...extra };
}

const stop = (w: ReturnType<typeof world>) => JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: w.project, user_message: "We will use Postgres 16 for the primary store." });
const ups = (w: ReturnType<typeof world>) => JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: w.project, prompt: "add a users table" });
const settle = () => new Promise((r) => setTimeout(r, 1500)); // time for a detached process to have done something

/** Talk to `jevmem mcp` over stdio: initialize, list tools, call each one; returns the tool results' text. */
async function mcpSession(cmd: string, args: string[], e: Record<string, string>, cwd: string): Promise<{ tools: string[]; results: string[]; stderr: string }> {
  const p = spawn(cmd, args, { cwd, env: e, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let stderr = "";
  const pending = new Map<number, (v: any) => void>();
  p.stdout.on("data", (d) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  p.stderr.on("data", (d) => (stderr += d));
  let id = 0;
  const req = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      pending.set(++id, resolve);
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await req("tools/list", {});
  const calls: [string, Record<string, unknown>][] = [["search_memory", { query: "database" }], ["add_memory", { text: "We use Postgres 16 as the primary store.", kind: "decision" }], ["list_memory", {}], ["audit_memory", { apply: true }]];
  const results: string[] = [];
  for (const [name, a] of calls) results.push((await req("tools/call", { name, arguments: a })).result.content[0].text);
  p.kill();
  return { tools: list.result.tools.map((t: any) => t.name), results, stderr };
}

describe.skipIf(process.platform === "win32")("a project that has not run `jevmem enable`", () => {
  it("plugin hooks through the launcher: zero Jev requests, zero files anywhere, no output", async () => {
    fake = await startFakeJev(() => SAVE_DECISION);
    const w = world();
    const before = snapshot(w.dirs);
    const s = spawnSync("sh", [LAUNCHER, "--detach", "hook", "--plugin"], { cwd: w.project, env: env(w), input: stop(w), encoding: "utf8" });
    const u = spawnSync("sh", [LAUNCHER, "hook", "--plugin"], { cwd: w.project, env: env(w), input: ups(w), encoding: "utf8" });
    await settle();
    expect([s.status, u.status]).toEqual([0, 0]);
    expect(s.stdout + s.stderr + u.stdout + u.stderr).toBe("");
    expect(fake.requests).toHaveLength(0);
    expect(snapshot(w.dirs)).toEqual(before);
  });

  it("`jevmem hook` run directly (as `jevmem init` registers UserPromptSubmit), with and without CLAUDE_PROJECT_DIR: the same", async () => {
    fake = await startFakeJev(() => SAVE_DECISION);
    const w = world();
    const before = snapshot(w.dirs);
    const runs = [
      spawnSync(process.execPath, [CLI, "hook"], { cwd: w.project, env: env(w), input: ups(w), encoding: "utf8" }),
      spawnSync(process.execPath, [CLI, "hook"], { cwd: w.project, env: env(w), input: stop(w), encoding: "utf8" }),
      // No CLAUDE_PROJECT_DIR: the payload's cwd decides (checked after the input is read, before anything else).
      spawnSync(process.execPath, [CLI, "hook"], { cwd: w.project, env: env(w, { CLAUDE_PROJECT_DIR: "" }), input: stop(w), encoding: "utf8" }),
      spawnSync(process.execPath, [CLI, "hook"], { cwd: w.project, env: env(w, { CLAUDE_PROJECT_DIR: "", JEVMEM_DAEMON: "1" }), input: ups(w), encoding: "utf8" }),
    ];
    await settle();
    for (const r of runs) {
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toBe("");
    }
    expect(fake.requests).toHaveLength(0);
    expect(snapshot(w.dirs)).toEqual(before);
  });

  it("the MCP server (the plugin's plain `jevmem mcp`): every tool answers one message and does nothing else", async () => {
    fake = await startFakeJev(() => SAVE_DECISION);
    const w = world();
    const before = snapshot(w.dirs);
    const r = await mcpSession(path.join(w.bin, "jevmem"), ["mcp"], env(w), w.project);
    expect(r.tools.sort()).toEqual(["add_memory", "audit_memory", "list_memory", "search_memory"]);
    for (const t of r.results) expect(t).toBe("jevmem isn't enabled in this project: run `jevmem enable`");
    expect(r.stderr).toBe("");
    expect(fake.requests).toHaveLength(0);
    expect(snapshot(w.dirs)).toEqual(before);
  });

  it("after `jevmem enable` the same Stop hook saves a line (and `jevmem disable` makes the project dormant again)", async () => {
    fake = await startFakeJev(() => SAVE_DECISION);
    const w = world();
    const en = spawnSync(process.execPath, [CLI, "enable"], { cwd: w.project, env: env(w), encoding: "utf8" });
    expect(en.status).toBe(0);
    expect(en.stdout).toMatch(/created\s+jevmem\.config\.json/);
    expect(fs.existsSync(path.join(w.project, "JEVMEM.md"))).toBe(true);
    const s = spawnSync("sh", [LAUNCHER, "--detach", "hook", "--plugin"], { cwd: w.project, env: env(w), input: stop(w), encoding: "utf8" });
    expect(s.status).toBe(0);
    const until = Date.now() + 10_000;
    while (new MemoryStore(w.project).active().length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(new MemoryStore(w.project).active().map((m) => m.text)).toEqual(["We will use Postgres 16 for the primary store."]);
    expect(fake.requests.length).toBeGreaterThan(0);
    // The MCP server in the same process-less form now works too.
    const mcp = await mcpSession(path.join(w.bin, "jevmem"), ["mcp"], env(w), w.project);
    expect(JSON.parse(mcp.results[2]!).count).toBe(1);

    const jevmemMd = fs.readFileSync(path.join(w.project, "JEVMEM.md"), "utf8");
    const dis = spawnSync(process.execPath, [CLI, "disable"], { cwd: w.project, env: env(w), encoding: "utf8" });
    expect(dis.stdout).toMatch(/disabled/);
    expect(fs.existsSync(path.join(w.project, "jevmem.config.json"))).toBe(false);
    expect(fs.readFileSync(path.join(w.project, "JEVMEM.md"), "utf8")).toBe(jevmemMd);
    const n = fake.requests.length;
    const before = snapshot([w.project]);
    spawnSync("sh", [LAUNCHER, "hook", "--plugin"], { cwd: w.project, env: env(w), input: ups(w), encoding: "utf8" });
    await settle();
    expect(fake.requests.length).toBe(n);
    expect(snapshot([w.project])).toEqual(before);
    // enable brings the set-aside config back.
    const again = spawnSync(process.execPath, [CLI, "enable"], { cwd: w.project, env: env(w), encoding: "utf8" });
    expect(again.stdout).toMatch(/restored/);
  });
});
