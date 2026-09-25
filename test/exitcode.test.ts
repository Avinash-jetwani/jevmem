/**
 * The hook must never block Claude Code: the built CLI exits 0 on every path. These tests spawn `dist/cli.js hook`
 * as Claude Code does (JSON on stdin) with bad input, no key, a broken transcript, and an unreachable Jev endpoint.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const CLI = path.resolve("dist/cli.js");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-exit-"));

beforeAll(() => {
  if (!fs.existsSync(CLI)) execFileSync("pnpm", ["build"], { stdio: "ignore" });
}, 60_000);

function runHookCli(stdin: string, extraEnv: Record<string, string> = {}) {
  const cwd = tmp();
  // An opted-in project (jevmem acts only where jevmem.config.json exists; test/dormant.test.ts covers the rest).
  fs.writeFileSync(path.join(cwd, "jevmem.config.json"), "{}\n");
  const home = tmp(); // no ~/.jevmem/env and no shell profiles, so no key is found unless given
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: home, JEVMEM_DAEMON: "0", JEVMEM_WRITER: "none", ...extraEnv };
  const r = spawnSync(process.execPath, [CLI, "hook"], { cwd, env, input: stdin, encoding: "utf8", timeout: 20_000 });
  return { ...r, cwd };
}

describe("built CLI hook exits 0", () => {
  it("on input that is not JSON", () => {
    const r = runHookCli("{this is not json");
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
  });

  it("on empty stdin", () => {
    expect(runHookCli("").status).toBe(0);
  });

  it("with no TYPESAFE_API_KEY anywhere, and logs why", () => {
    const r = runHookCli(JSON.stringify({ hook_event_name: "Stop", user_message: "We will use Postgres 16 as the primary store." }));
    expect(r.status).toBe(0);
    const log = fs.readFileSync(path.join(r.cwd, ".jevmem", "log.jsonl"), "utf8");
    expect(log).toContain("TYPESAFE_API_KEY not set");
  });

  it("with a broken transcript file", () => {
    const dir = tmp();
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(transcript, "\u0000garbage{{{\n[not, json\n");
    const r = runHookCli(JSON.stringify({ hook_event_name: "Stop", transcript_path: transcript, cwd: dir }), { TYPESAFE_API_KEY: "ts-test-invalid", TYPESAFE_BASE_URL: "http://127.0.0.1:9" });
    expect(r.status).toBe(0);
  });

  it("with a missing transcript file", () => {
    const r = runHookCli(JSON.stringify({ hook_event_name: "Stop", transcript_path: "/nonexistent/t.jsonl" }), { TYPESAFE_API_KEY: "ts-test-invalid", TYPESAFE_BASE_URL: "http://127.0.0.1:9" });
    expect(r.status).toBe(0);
  });

  it("when Jev is unreachable, and logs the failure", () => {
    const r = runHookCli(JSON.stringify({ hook_event_name: "Stop", user_message: "We will use Postgres 16 as the primary store." }), { TYPESAFE_API_KEY: "ts-test-invalid", TYPESAFE_BASE_URL: "http://127.0.0.1:9" });
    expect(r.status).toBe(0);
    const log = fs.readFileSync(path.join(r.cwd, ".jevmem", "log.jsonl"), "utf8");
    expect(log).toMatch(/"ok":false/);
  });

  it("on UserPromptSubmit with no memories and an unreachable Jev", () => {
    const r = runHookCli(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "add a login page" }), { TYPESAFE_API_KEY: "ts-test-invalid", TYPESAFE_BASE_URL: "http://127.0.0.1:9" });
    expect(r.status).toBe(0);
  });
});
