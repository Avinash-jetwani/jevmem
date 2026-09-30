/**
 * The guard as Claude Code runs it: the built CLI (`node dist/cli.js hook`) and both launchers, fed PreToolUse
 * payloads, with Jev behind a local stand-in. Exit code always 0, stdout empty or one JSON object, never "allow",
 * nothing on stderr; failures fall open and go to .jevmem/log.jsonl.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { init } from "../src/init.js";
import { readLog } from "../src/jev.js";
import { recordProvenance } from "../src/provenance.js";
import { MemoryStore } from "../src/store.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";

const CLI = path.resolve("dist/cli.js");
const INIT_LAUNCHER = path.resolve("hooks/jevmem-hook.sh");
const PLUGIN_LAUNCHER = path.resolve("plugin/hooks/jevmem-hook.sh");
const tmp = (p = "jevmem-gh-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
beforeAll(() => {
  if (!fs.existsSync(CLI)) execFileSync("pnpm", ["build"], { stdio: "ignore" });
}, 60_000);
let fake: FakeJev | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

function project(rules: string[], guard: Record<string, unknown> = {}): string {
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
const pre = (root: string, command: string) => JSON.stringify({ session_id: "s1", transcript_path: "/x.jsonl", cwd: root, permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "x" }, tool_use_id: "toolu_1" });
/** Run a process without blocking this one (the stand-in Jev answers from this process's event loop). */
function run(cmd: string[], opts: { cwd: string; env: Record<string, string>; input: string }): Promise<{ status: number | null; stdout: string; stderr: string; ms: number }> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const p = spawn(cmd[0]!, cmd.slice(1), { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
    p.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, ms: performance.now() - t0 });
    });
    p.stdin.end(opts.input);
  });
}
function hook(root: string, input: string, env: Record<string, string> = {}, cmd: string[] = [process.execPath, CLI, "hook"]) {
  return run(cmd, { cwd: root, env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: tmp(), CLAUDE_PROJECT_DIR: root, JEVMEM_DAEMON: "0", ...env }, input });
}
/** A stand-in Jev that answers every "breaks" noul with p. */
const jevSaying = (p: number, opts: { delayMs?: number } = {}) => startFakeJev((q) => Object.fromEntries(Object.keys(q).filter((k) => k.startsWith("breaks_")).map((k) => [k, p])), opts);
function contract(r: { status: number | null; stdout: string; stderr: string }) {
  expect(r.status).toBe(0);
  expect(r.stderr).toBe("");
  if (r.stdout === "") return null;
  expect(r.stdout.endsWith("\n")).toBe(true);
  expect(r.stdout.trim().split("\n")).toHaveLength(1);
  const obj = JSON.parse(r.stdout);
  expect(Object.keys(obj)).toEqual(["hookSpecificOutput"]);
  expect(["ask", "deny", undefined]).toContain(obj.hookSpecificOutput.permissionDecision);
  expect(r.stdout).not.toMatch(/"allow"/);
  return obj.hookSpecificOutput;
}

describe.skipIf(process.platform === "win32")("the PreToolUse hook process", () => {
  it("asks, quoting the rule, when Jev says the call breaks it; prints nothing when it does not", async () => {
    const root = project(["Never commit .env files"]);
    fake = await jevSaying(0.94);
    const env = { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url };
    const out = contract(await hook(root, pre(root, "git add .env && git commit -m env"), env));
    expect(out).toEqual({ hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: 'jevmem: this may break a saved rule: "Never commit .env files" (JEVMEM.md)' });
    // What went over the wire: the command and the rule, nothing else.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.state).toEqual({ tool_call: { tool: "Bash", command: "git add .env && git commit -m env" }, rules: [{ id: expect.any(String), rule: "Never commit .env files" }] });
    // No candidate: no request at all.
    expect(contract(await hook(root, pre(root, "ls -la"), env))).toBeNull();
    expect(fake.requests).toHaveLength(1);
  });

  it("block mode denies, warn mode adds context, both through the real process", async () => {
    fake = await jevSaying(0.97);
    const env = { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url };
    const blocked = project(["Never commit .env files"], { mode: "block" });
    expect(contract(await hook(blocked, pre(blocked, "git add .env"), env))!.permissionDecision).toBe("deny");
    const warned = project(["Never commit .env files"], { mode: "warn" });
    expect(contract(await hook(warned, pre(warned, "git add .env"), env))).toEqual({ hookEventName: "PreToolUse", additionalContext: 'Saved project rule in JEVMEM.md: "Never commit .env files".' });
  });

  it("Jev too slow or down: a strong match is asked about without a score; keywords alone or no key let the call through; exit 0, nothing on stderr, logged", async () => {
    const root = project(["Never commit .env files", "Don't print or log customer email addresses"], { budgetMs: 400 });
    fake = await jevSaying(0.99, { delayMs: 4000 });
    const slow = await hook(root, pre(root, "git add .env"), { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url });
    expect(contract(slow)!.permissionDecisionReason).toBe('jevmem: couldn\'t check this call against a saved rule in time: "Never commit .env files" (JEVMEM.md).');
    expect(slow.ms).toBeLessThan(2500);
    expect(contract(await hook(root, pre(root, "git add .env.local"), { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "http://127.0.0.1:9" }))!.permissionDecision).toBe("ask");
    expect(contract(await hook(root, pre(root, "rg 'customer email' src/"), { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "http://127.0.0.1:9" }))).toBeNull();
    expect(contract(await hook(root, pre(root, "git add .env.production"), {}))).toBeNull();
    const errors = readLog(root).filter((e) => e.label === "guard" && e.ok === false).map((e) => e.error ?? "");
    expect(errors.some((e) => /timed out|abort/i.test(e))).toBe(true);
    expect(errors.some((e) => /Jev check failed/.test(e))).toBe(true);
    expect(errors.some((e) => /no TypeSafe API key/.test(e))).toBe(true);
  });

  it("fails open on malformed stdin, a missing or invalid config and an unreadable JEVMEM.md", async () => {
    const root = project(["Never commit .env files"]);
    const env = { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "http://127.0.0.1:9" };
    expect(contract(await hook(root, '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git add .e', env))).toBeNull();
    expect(contract(await hook(root, "", env))).toBeNull();
    fs.writeFileSync(path.join(root, "jevmem.config.json"), '{"guard": {"mode": "loud"}}');
    expect(contract(await hook(root, pre(root, "git add .env"), env))).toBeNull();
    fs.writeFileSync(path.join(root, "jevmem.config.json"), "{ not json");
    expect(contract(await hook(root, pre(root, "git add .env"), env))).toBeNull();
    fs.rmSync(path.join(root, "jevmem.config.json"));
    expect(contract(await hook(root, pre(root, "git add .env"), env))).toBeNull();
    const other = project(["Never commit .env files"]);
    fs.rmSync(path.join(other, "JEVMEM.md"));
    fs.mkdirSync(path.join(other, "JEVMEM.md"));
    expect(contract(await hook(other, pre(other, "git add .env"), env))).toBeNull();
    expect(readLog(other).some((e) => e.label === "guard" && /JEVMEM\.md unreadable/.test(e.error ?? ""))).toBe(true);
    // Nothing from these reached the Stop path's queue.
    expect(fs.existsSync(path.join(root, ".jevmem", "queue.jsonl"))).toBe(false);
  });

  it("the tamper check needs no Jev and no key", async () => {
    const root = project([]);
    const out = contract(await hook(root, pre(root, "sed -i '' 's/\"ask\"/\"off\"/' jevmem.config.json"), {}));
    expect(out!.permissionDecision).toBe("ask");
    expect(out!.permissionDecisionReason).toMatch(/jevmem\.config\.json/);
  });

  it("a Stop or UserPromptSubmit payload is not handled by the guard, and other events do nothing at all", async () => {
    const root = project(["Never commit .env files"]);
    for (const event of ["PostToolUse", "SubagentStop", "Notification", "SessionStart"]) {
      const r = await hook(root, JSON.stringify({ hook_event_name: event, cwd: root, session_id: "s1", transcript_path: "/nope.jsonl", tool_name: "Bash", tool_input: { command: "git add .env" } }), { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "http://127.0.0.1:9" });
      expect([r.status, r.stdout, r.stderr], event).toEqual([0, "", ""]);
    }
    expect(fs.existsSync(path.join(root, ".jevmem", "queue.jsonl"))).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("the guard through the launchers", () => {
  it("init's launcher: dormant in a project that is not enabled, the guard in one that is", async () => {
    const off = tmp();
    const r = await hook(off, pre(off, "git add .env"), {}, ["sh", INIT_LAUNCHER, "--node", process.execPath, "hook"]);
    expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
    expect(fs.readdirSync(off)).toEqual([]);
    const root = project(["Never commit .env files"]);
    fake = await jevSaying(0.9);
    const out = contract(await hook(root, pre(root, "git add .env"), { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url }, ["sh", INIT_LAUNCHER, "--node", process.execPath, "hook"]));
    expect(out!.permissionDecision).toBe("ask");
  });

  /** A bin dir with `jevmem` and `node`, as a global install leaves them. */
  function binWith(cli: string): string {
    const dir = tmp("jevmem-gh-bin-");
    fs.symlinkSync(cli, path.join(dir, "jevmem"));
    fs.symlinkSync(process.execPath, path.join(dir, "node"));
    return dir;
  }
  const pluginEnv = (root: string, bin: string, data: string, extra: Record<string, string> = {}) => ({ PATH: `${bin}:/usr/bin:/bin`, HOME: tmp(), CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: data, JEVMEM_DAEMON: "0", ...extra });
  const runPlugin = (root: string, input: string, env: Record<string, string>) => run(["sh", PLUGIN_LAUNCHER, "--guard", "hook", "--plugin"], { cwd: root, env, input });

  it("the plugin's launcher runs a CLI that has the guard, caching that it does", async () => {
    const root = project(["Never commit .env files"]);
    fake = await jevSaying(0.9);
    const data = tmp();
    const env = pluginEnv(root, binWith(CLI), data, { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url });
    expect(contract(await runPlugin(root, pre(root, "git add .env"), env))!.permissionDecision).toBe("ask");
    expect(fs.readFileSync(path.join(data, "cli"), "utf8").split("\n")[4]).toBe("1");
    expect(contract(await runPlugin(root, pre(root, "git add .env"), env))!.permissionDecision).toBe("ask"); // warm: from the cache
  });

  it("with a CLI from before the guard, the plugin's launcher reads the input and exits 0 without running it", async () => {
    const root = project(["Never commit .env files"]);
    // An older CLI: `guard` is an unknown command (exit 1), and any hook run is recorded.
    const dir = tmp("jevmem-gh-old-");
    const calls = path.join(dir, "calls");
    const old = path.join(dir, "jevmem");
    fs.writeFileSync(old, `#!/bin/sh\necho "$*" >> "${calls}"\nif [ "$1" = "--version" ]; then echo 0.5.7; exit 0; fi\nif [ "$1" = "guard" ]; then echo "unknown command: guard" >&2; exit 1; fi\ncat > /dev/null\nexit 0\n`);
    fs.chmodSync(old, 0o755);
    const bin = tmp("jevmem-gh-bin-");
    fs.symlinkSync(old, path.join(bin, "jevmem"));
    const data = tmp();
    const r = await runPlugin(root, pre(root, "git add .env"), pluginEnv(root, bin, data));
    expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
    expect(fs.readFileSync(path.join(data, "cli"), "utf8").split("\n")[4]).toBe("0");
    const r2 = await runPlugin(root, pre(root, "git add .env"), pluginEnv(root, bin, data));
    expect([r2.status, r2.stdout, r2.stderr]).toEqual([0, "", ""]);
    // It was asked for its version and about the guard, once; it never saw a hook event.
    expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toEqual(["--version", "guard --help"]);
    // The other hooks still run it.
    await run(["sh", PLUGIN_LAUNCHER, "hook", "--plugin"], { cwd: root, env: pluginEnv(root, bin, data), input: "{}" });
    expect(fs.readFileSync(calls, "utf8").trim().split("\n").pop()).toBe("hook --plugin");
  });

  it("the plugin's guard stands down when `jevmem init` registered its own", async () => {
    const root = project(["Never commit .env files"]);
    init({ root });
    fake = await jevSaying(0.9);
    const r = await runPlugin(root, pre(root, "git add .env"), pluginEnv(root, binWith(CLI), tmp(), { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url }));
    expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
    expect(fake.requests).toHaveLength(0);
  });

  it("the plugin's launcher: dormant in a project that is not enabled (no CLI, Node or network)", async () => {
    const off = tmp();
    const data = tmp();
    const r = await runPlugin(off, pre(off, "git add .env"), pluginEnv(off, binWith(CLI), data));
    expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
    expect(fs.readdirSync(off)).toEqual([]);
    expect(fs.readdirSync(data)).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("a slow guard never holds Claude Code past its hook timeout", () => {
  it("the process exits once its budget is spent even with a request still open", async () => {
    const root = project(["Never commit .env files"], { budgetMs: 600 });
    fake = await jevSaying(0.99, { delayMs: 10_000 });
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const p = spawn(process.execPath, [CLI, "hook"], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: tmp(), CLAUDE_PROJECT_DIR: root, TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake!.url }, stdio: ["pipe", "ignore", "ignore"] });
      p.on("close", () => resolve());
      p.stdin.end(pre(root, "git add .env"));
    });
    expect(performance.now() - t0).toBeLessThan(2500);
  });
});
