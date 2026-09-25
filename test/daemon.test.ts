import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { daemonEnabled, daemonRequest, serveDaemon, socketPath } from "../src/daemon.js";
import { loadConfig } from "../src/config.js";
import { enqueueTurn, readQueue } from "../src/queue.js";
import { MemoryStore } from "../src/store.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { startFakeJev } from "./fakejev.js";
import { SAVE_DECISION } from "./helpers.js";

async function waitFor(cond: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jd-"));

describe("daemon", () => {
  const servers: { close(): void }[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("resolves null when nothing is listening, without throwing", async () => {
    const root = tmp();
    expect(await daemonRequest(root, { type: "ping" }, { connectMs: 100 })).toBeNull();
  });

  it("answers ping and serves a hook request over the socket, then stops", async () => {
    const root = tmp();
    const prev = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = prev ?? "test-key";
    try {
      const server = await serveDaemon(root, { prewarm: false, idleMs: 60_000, exit: () => {} });
      servers.push(server);
      expect(fs.existsSync(socketPath(root))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(root, ".jevmem", "daemon.json"), "utf8")).pid).toBe(process.pid);
      const pong = await daemonRequest(root, { type: "ping" });
      expect(pong).toMatchObject({ ok: true, type: "pong", pid: process.pid });
      // A UserPromptSubmit with no memories short-circuits before any Jev call, so this is safe offline.
      const r = await daemonRequest(root, { type: "hook", input: { hook_event_name: "UserPromptSubmit", cwd: root, prompt: "hi" } });
      expect(r).toMatchObject({ ok: true, type: "hook", outcome: { action: "noop", via: "daemon" } });
      const stop = await daemonRequest(root, { type: "stop" });
      expect(stop).toMatchObject({ ok: true, type: "stopping" });
    } finally {
      if (prev === undefined) delete process.env.TYPESAFE_API_KEY;
    }
  });

  it("retries a queued turn on its own once the backoff has passed, and answers a drain request at once", async () => {
    const root = tmp();
    const saved = { key: process.env.TYPESAFE_API_KEY, base: process.env.TYPESAFE_BASE_URL, writer: process.env.JEVMEM_WRITER };
    const fake = await startFakeJev(() => SAVE_DECISION);
    process.env.TYPESAFE_API_KEY = "test-key";
    process.env.TYPESAFE_BASE_URL = fake.url;
    process.env.JEVMEM_WRITER = "none";
    try {
      // A turn that failed earlier and may be retried 300 ms from now.
      enqueueTurn(root, { hash: "d".repeat(16), user: "We will use Postgres 16 for the primary store.", assistant: "", previous: "", source: "payload" });
      const q = readQueue(root);
      q[0]!.attempts = 1;
      q[0]!.nextAttemptAt = new Date(Date.now() + 300).toISOString();
      fs.writeFileSync(path.join(root, ".jevmem", "queue.jsonl"), JSON.stringify(q[0]) + "\n");
      const server = await serveDaemon(root, { prewarm: false, idleMs: 60_000, retryTickMs: 50, exit: () => {} });
      servers.push(server);
      await waitFor(() => readQueue(root).length === 0);
      expect(new MemoryStore(root).active().map((m) => m.text)).toEqual(["We will use Postgres 16 for the primary store."]);

      // The Stop handoff: queue a turn, ask the daemon to drain, and get the answer before the turn is evaluated.
      enqueueTurn(root, { hash: "e".repeat(16), user: "Workers live in apps/worker and use BullMQ.", assistant: "", previous: "", source: "payload" });
      const before = fake.requests.length;
      const r = await daemonRequest(root, { type: "drain" });
      expect(r).toMatchObject({ ok: true, type: "draining", pending: 1 });
      expect(fake.requests.length).toBe(before);
      await waitFor(() => new MemoryStore(root).active().length === 2);
    } finally {
      await fake.close();
      for (const [k, v] of [["TYPESAFE_API_KEY", saved.key], ["TYPESAFE_BASE_URL", saved.base], ["JEVMEM_WRITER", saved.writer]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("is enabled by default and can be switched off by env or config", () => {
    expect(daemonEnabled(DEFAULT_CONFIG, {})).toBe(true);
    expect(daemonEnabled(DEFAULT_CONFIG, { JEVMEM_DAEMON: "0" })).toBe(false);
    expect(daemonEnabled({ ...DEFAULT_CONFIG, daemon: { enabled: false, idleMinutes: 1 } }, {})).toBe(false);
    expect(daemonEnabled({ ...DEFAULT_CONFIG, daemon: { enabled: false, idleMinutes: 1 } }, { JEVMEM_DAEMON: "1" })).toBe(true);
    const root = tmp();
    fs.writeFileSync(path.join(root, "jevmem.config.json"), JSON.stringify({ daemon: { enabled: false } }));
    expect(loadConfig(root).daemon).toEqual({ enabled: false, idleMinutes: 30 });
  });
});
