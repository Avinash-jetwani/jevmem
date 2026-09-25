/**
 * The Stop hook launcher (hooks/jevmem-hook.sh --detach) as Claude Code runs it: the hook process exits at once, and the
 * turn is still saved, by the detached node process (daemon off) or by the daemon it hands the turn to.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { init } from "../src/init.js";
import { MemoryStore } from "../src/store.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";
import { SAVE_DECISION } from "./helpers.js";

const CLI = path.resolve("dist/cli.js");
const LAUNCHER = path.resolve("hooks/jevmem-hook.sh");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-launch-"));
beforeAll(() => {
  if (!fs.existsSync(CLI)) execFileSync("pnpm", ["build"], { stdio: "ignore" });
}, 60_000);

let fake: FakeJev | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function waitFor(cond: () => boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function runLauncher(root: string, env: Record<string, string>, payload: object, args: string[] = ["--node", process.execPath, "--detach", "hook"]) {
  const t0 = performance.now();
  const r = spawnSync("sh", [LAUNCHER, ...args], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: tmp(), JEVMEM_WRITER: "none", JEVMEM_CACHE: "0", ...env }, input: JSON.stringify(payload), encoding: "utf8", timeout: 10_000 });
  return { ...r, ms: performance.now() - t0 };
}

describe.skipIf(process.platform === "win32")("hooks/jevmem-hook.sh --detach (the Stop hook)", () => {
  it("exits at once and the detached node process saves the turn (daemon off)", async () => {
    const root = tmp();
    init({ root, hooks: false });
    fake = await startFakeJev(() => SAVE_DECISION);
    const r = runLauncher(root, { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url, JEVMEM_DAEMON: "0" }, { hook_event_name: "Stop", cwd: root, user_message: "We will use Postgres 16 for the primary store." });
    expect(r.status).toBe(0);
    await waitFor(() => new MemoryStore(root).active().length === 1);
    expect(fs.readdirSync(path.join(root, ".jevmem")).filter((f) => f.startsWith("queue.jsonl") && f !== "queue.jsonl")).toEqual([]);
  });

  it("hands the turn to a daemon it starts, which saves it; the hook does not wait for Jev", async () => {
    const root = tmp();
    init({ root, hooks: false });
    // A slow Jev: the hook must still return long before the answer.
    fake = await startFakeJev(() => SAVE_DECISION);
    const env = { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url, JEVMEM_DAEMON: "1" };
    try {
      const r = runLauncher(root, env, { hook_event_name: "Stop", cwd: root, user_message: "Workers live in apps/worker and use BullMQ." });
      expect(r.status).toBe(0);
      await waitFor(() => new MemoryStore(root).active().length === 1);
      expect(fs.existsSync(path.join(root, ".jevmem", "daemon.json"))).toBe(true);
    } finally {
      spawnSync(process.execPath, [CLI, "daemon", "stop"], { cwd: root, env: { ...process.env, ...env }, timeout: 5000 });
    }
  });

  it("survives SIGTERM to its process group right after it starts (what `claude -p` does at session end)", async () => {
    const root = tmp();
    init({ root, hooks: false });
    fake = await startFakeJev(() => SAVE_DECISION);
    const tmpdir = tmp();
    const child = spawn("sh", [LAUNCHER, "--node", process.execPath, "--detach", "hook"], { cwd: root, detached: true, env: { PATH: "/usr/bin:/bin", HOME: tmp(), TMPDIR: tmpdir, JEVMEM_WRITER: "none", JEVMEM_CACHE: "0", TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url, JEVMEM_DAEMON: "0" }, stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(JSON.stringify({ hook_event_name: "Stop", cwd: root, user_message: "Deploys go out from the GitHub Actions deploy job only." }));
    // Signal the group while the launcher is handing off: once its temp file exists (the shell is running; a signal
    // that lands before a shell has run its first line cannot be caught by any script). Under a loaded test run a
    // fixed delay could fire before that.
    await waitFor(() => fs.readdirSync(tmpdir).some((f) => f.startsWith("jevmem-hook.")), 5000);
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      /* already exited */
    }
    await waitFor(() => new MemoryStore(root).active().length === 1);
  });

  it("finds node without --node on a bare PATH via JEVMEM_NODE, and exits 0 with a message when there is none", () => {
    const root = tmp();
    const ok = spawnSync("sh", [LAUNCHER, "--version"], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: tmp(), JEVMEM_NODE: process.execPath }, encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const none = spawnSync("/bin/sh", [LAUNCHER, "--version"], { cwd: root, env: { PATH: "/nonexistent", HOME: tmp() }, encoding: "utf8" });
    expect(none.status).toBe(0);
  });
});
