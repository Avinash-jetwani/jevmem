/**
 * v0.5.4: jevmem uses only the keys and services the user chose.
 * - The LLM writer runs only when jevmem.config.json sets "writer": "openai" or "anthropic". An OpenAI or Anthropic
 *   key being present is not enough (checked against a fake OpenAI and a fake Anthropic server).
 * - Keys are read from the plugin setting, the environment, <project>/.jevmem/.env and ~/.jevmem/env, never from
 *   shell profiles.
 * - Hooks registered by `jevmem init`, run as a GUI app runs them (no shell variables, a bare PATH), find the key in
 *   ~/.jevmem/env.
 * Every process here gets an explicit environment, so nothing from the machine running the tests leaks in.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { init } from "../src/init.js";
import { MemoryStore } from "../src/store.js";
import { WRITER_OPT_IN_NOTICE } from "../src/notice.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";
import { SAVE_DECISION } from "./helpers.js";

const CLI = path.resolve("dist/cli.js");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-optin-")));
beforeAll(() => {
  if (!fs.existsSync(CLI)) execFileSync("pnpm", ["build"], { stdio: "ignore" });
}, 60_000);

/** Stands in for both api.openai.com and api.anthropic.com, and counts every request. */
async function startFakeLlm(): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      const text = "Postgres 16 is the primary store (LLM writer).";
      res.end(JSON.stringify(req.url?.includes("/messages") ? { content: [{ type: "text", text }] } : { choices: [{ message: { content: text } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, close: () => new Promise((r) => server.close(() => r())) };
}

let jev: FakeJev | null = null;
let llm: Awaited<ReturnType<typeof startFakeLlm>> | null = null;
afterEach(async () => {
  await jev?.close();
  await llm?.close();
  jev = null;
  llm = null;
});

function project(config: object | null): string {
  const root = tmp();
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"client-app"}\n');
  if (config) fs.writeFileSync(path.join(root, "jevmem.config.json"), JSON.stringify(config));
  return root;
}
const stop = (root: string) => JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: root, user_message: "We will use Postgres 16 for the primary store." });
const ups = (root: string) => JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: root, prompt: "add a users table" });

function env(root: string, home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: home,
    CLAUDE_PROJECT_DIR: root,
    JEVMEM_DAEMON: "0",
    TYPESAFE_API_KEY: "test-key",
    TYPESAFE_BASE_URL: jev!.url,
    OPENAI_API_KEY: "sk-test-openai",
    OPENAI_BASE_URL: `${llm!.url}/v1`,
    ANTHROPIC_API_KEY: "sk-ant-test",
    ANTHROPIC_BASE_URL: llm!.url,
    ...extra,
  };
}

/** Run a process without blocking this one: the fake servers live in this process and must keep answering. */
function run(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string>; input?: string }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
    p.stdin.end(opts.input ?? "");
  });
}

/** Run the Stop hook as a process and wait until the turn's decision is recorded. */
async function stopHook(root: string, e: Record<string, string>): Promise<{ lines: string[]; writer: string | undefined }> {
  const r = await run(process.execPath, [CLI, "hook"], { cwd: root, env: e, input: stop(root) });
  expect(r.status).toBe(0);
  const file = path.join(root, ".jevmem", "decisions.jsonl");
  const until = Date.now() + 15_000;
  while (!fs.existsSync(file) && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
  const decisions = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { lines: new MemoryStore(root).active().map((m) => m.text), writer: decisions.at(-1)?.writer };
}

describe.skipIf(process.platform === "win32")("the LLM writer is opt-in per project", () => {
  it("OPENAI_API_KEY and ANTHROPIC_API_KEY set, no writer in jevmem.config.json: zero requests to OpenAI or Anthropic", async () => {
    jev = await startFakeJev(() => SAVE_DECISION);
    llm = await startFakeLlm();
    const root = project({});
    const r = await stopHook(root, env(root, tmp()));
    expect(r.lines).toEqual(["We will use Postgres 16 for the primary store."]);
    expect(r.writer).toBe("fallback");
    expect(llm.requests).toHaveLength(0);
    expect(jev.requests.length).toBeGreaterThan(0);
  });

  it("the default config that `jevmem enable` writes: zero requests too", async () => {
    jev = await startFakeJev(() => SAVE_DECISION);
    llm = await startFakeLlm();
    const root = project(null);
    const e = env(root, tmp());
    expect((await run(process.execPath, [CLI, "enable"], { cwd: root, env: e })).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(root, "jevmem.config.json"), "utf8")).writer.provider).toBe("none");
    const r = await stopHook(root, e);
    expect(r.writer).toBe("fallback");
    expect(llm.requests).toHaveLength(0);
  });

  it('"writer": "openai" in the config turns it on (one request to OpenAI), and "anthropic" likewise', async () => {
    jev = await startFakeJev(() => SAVE_DECISION);
    llm = await startFakeLlm();
    const a = project({ writer: "openai" });
    expect((await stopHook(a, env(a, tmp()))).lines).toEqual(["Postgres 16 is the primary store (LLM writer)."]);
    expect(llm.requests).toEqual(["/v1/chat/completions"]);
    const b = project({ writer: { provider: "anthropic" } });
    expect((await stopHook(b, env(b, tmp()))).writer).toBe("anthropic");
    expect(llm.requests).toEqual(["/v1/chat/completions", "/v1/messages"]);
  });

  it('a pre-0.5.4 config ("provider": "auto") with a key: no LLM request, and the opt-in notice once, on the first prompt', async () => {
    jev = await startFakeJev(() => SAVE_DECISION);
    llm = await startFakeLlm();
    const root = project({ writer: { provider: "auto", maxChars: 200, timeoutMs: 8000 } });
    const home = tmp();
    const r = await stopHook(root, env(root, home));
    expect(r.writer).toBe("fallback");
    expect(llm.requests).toHaveLength(0);
    const first = await run(process.execPath, [CLI, "hook"], { cwd: root, env: env(root, home), input: ups(root) });
    expect(JSON.parse(first.stdout).systemMessage).toBe(WRITER_OPT_IN_NOTICE);
    const second = await run(process.execPath, [CLI, "hook"], { cwd: root, env: env(root, home), input: ups(root) });
    expect(second.stdout).not.toContain("opt-in");
    // A CLI command in the same project stays quiet too: the notice is once per project.
    const stats = await run(process.execPath, [CLI, "stats"], { cwd: root, env: env(root, home) });
    expect(stats.stderr).not.toContain("opt-in");
    expect(stats.stdout).toMatch(/^writer: jevmem \(local, no LLM\): no LLM writer set in jevmem\.config\.json/m);
  });

  it("no notice for a project without OpenAI or Anthropic keys and no LLM-written lines", () => {
    const root = project({ writer: { provider: "auto" } });
    const r = spawnSync(process.execPath, [CLI, "list"], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: tmp() }, encoding: "utf8" });
    expect(r.stderr).not.toContain("opt-in");
  });
});

describe.skipIf(process.platform === "win32")("keys come only from places the user chose", () => {
  it("a TypeSafe key only in ~/.zshrc (and the other shell profiles) is not used: zero requests to Jev", async () => {
    jev = await startFakeJev(() => SAVE_DECISION);
    const root = project({});
    const home = tmp();
    for (const f of [".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc", ".profile"]) fs.writeFileSync(path.join(home, f), "export TYPESAFE_API_KEY=from-profile\n");
    const e = { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_PROJECT_DIR: root, JEVMEM_DAEMON: "0", TYPESAFE_BASE_URL: jev.url };
    for (const input of [stop(root), ups(root)]) expect((await run(process.execPath, [CLI, "hook"], { cwd: root, env: e, input })).status).toBe(0);
    await new Promise((r) => setTimeout(r, 1500));
    expect(jev.requests).toHaveLength(0);
    const log = fs.readFileSync(path.join(root, ".jevmem", "log.jsonl"), "utf8");
    expect(log).toContain("TYPESAFE_API_KEY not set");
  });

  it("`jevmem init` hooks run as a GUI app runs them (no shell variables, bare PATH) find the key in ~/.jevmem/env", async () => {
    jev = await startFakeJev(() => SAVE_DECISION);
    const root = project(null);
    init({ root, cliPath: CLI });
    new MemoryStore(root).add({ kind: "decision", text: "Use Postgres 16 as the primary store.", conf: 1 }); // recall has a line to rank
    const home = tmp();
    fs.mkdirSync(path.join(home, ".jevmem"));
    fs.writeFileSync(path.join(home, ".jevmem", "env"), `TYPESAFE_API_KEY=gui-key\nTYPESAFE_BASE_URL=${jev.url}\n`, { mode: 0o600 });
    const hooks = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8")).hooks;
    const upsCommand: string = hooks.UserPromptSubmit[0].hooks[0].command;
    // Claude Code runs a hook command with `sh -c`; a GUI app's environment has no shell variables at all.
    const r = await run("/bin/sh", ["-c", upsCommand], { cwd: root, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, CLAUDE_PROJECT_DIR: root, JEVMEM_DAEMON: "0" }, input: ups(root) });
    expect(r.status).toBe(0);
    expect(jev.requests.length).toBeGreaterThan(0);
    expect(jev.requests[0]!.headers.authorization).toBe("Bearer gui-key");
  });
});

describe("jevmem doctor", () => {
  it("says where the key comes from and which writer is active and why, and never prints a key", () => {
    const root = project({ writer: "openai" });
    const home = tmp();
    fs.mkdirSync(path.join(home, ".jevmem"));
    fs.writeFileSync(path.join(home, ".jevmem", "env"), "TYPESAFE_API_KEY=secret-typesafe-value\nOPENAI_API_KEY=secret-openai-value\n");
    const r = spawnSync(process.execPath, [CLI, "doctor"], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: home, JEVMEM_WRITER: "anthropic" }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("enabled (jevmem.config.json)");
    expect(r.stdout).toContain("TypeSafe key found (~/.jevmem/env)");
    expect(r.stdout).toMatch(/writer +openai \(gpt-5-mini\): writer is "openai" in jevmem\.config\.json and OPENAI_API_KEY is set/);
    expect(r.stdout).toContain("JEVMEM_WRITER=anthropic is ignored");
    expect(r.stdout + r.stderr).not.toContain("secret-");
  });

  it("finds a writer key in ~/.jevmem/env when TYPESAFE_API_KEY comes from the environment", () => {
    const root = project({ writer: "anthropic" });
    const home = tmp();
    fs.mkdirSync(path.join(home, ".jevmem"));
    fs.writeFileSync(path.join(home, ".jevmem", "env"), "ANTHROPIC_API_KEY=secret-anthropic-value\n");
    const r = spawnSync(process.execPath, [CLI, "doctor"], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: home, TYPESAFE_API_KEY: "secret-typesafe-value" }, encoding: "utf8" });
    expect(r.stdout).toContain("TypeSafe key found (environment)");
    expect(r.stdout).toContain('writer is "anthropic" in jevmem.config.json and ANTHROPIC_API_KEY is set');
    expect(r.stdout + r.stderr).not.toContain("secret-");
  });

  it("with no key: names the plugin setting and ~/.jevmem/env; init says the same", () => {
    const root = project({});
    const e = { PATH: "/usr/bin:/bin", HOME: tmp() };
    const d = spawnSync(process.execPath, [CLI, "doctor"], { cwd: root, env: e, encoding: "utf8" });
    expect(d.stdout).toContain("/plugin configure jevmem@jevmem");
    expect(d.stdout).toContain("~/.jevmem/env");
    expect(d.stdout).toMatch(/writer +jevmem \(local, no LLM\)/);
    const i = spawnSync(process.execPath, [CLI, "init", "--tool", "claude"], { cwd: project(null), env: e, encoding: "utf8" });
    expect(i.stdout).toContain("/plugin configure jevmem@jevmem");
    expect(i.stdout).toContain("~/.jevmem/env");
  });
});
