/**
 * Never lose a turn: a Jev outage (timeout, 5xx, 529) queues the scrubbed turn in `.jevmem/queue.jsonl`; it is
 * retried later with backoff, in the original order, and saved exactly once.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli-main.js";
import { runHook } from "../src/hook.js";
import { init } from "../src/init.js";
import { appendLog, readLog } from "../src/jev.js";
import { recordDecision } from "../src/labels.js";
import { drainQueue, enqueueTurn, isRetryable, QUEUE_MAX_ENTRIES, queueStats, readQueue } from "../src/queue.js";
import { MemoryStore } from "../src/store.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";
import { CONTRADICTS, SAVE_DECISION } from "./helpers.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-queue-"));
const env = { JEVMEM_WRITER: "none" } as NodeJS.ProcessEnv;
const saved = { key: process.env.TYPESAFE_API_KEY, base: process.env.TYPESAFE_BASE_URL, cache: process.env.JEVMEM_CACHE };
let fake: FakeJev | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
  for (const [k, v] of [["TYPESAFE_API_KEY", saved.key], ["TYPESAFE_BASE_URL", saved.base], ["JEVMEM_CACHE", saved.cache]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Point the real client (runHook with no injected Jev) at a fake that fails `outage` times with `status`, then answers. */
async function outage(status: number, failures: number, answer: (state: any) => Record<string, unknown>) {
  let failed = 0;
  fake = await startFakeJev((_q, state) => {
    if (failed < failures) {
      failed++;
      return { status };
    }
    return answer(state) as any;
  });
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.TYPESAFE_BASE_URL = fake.url;
  process.env.JEVMEM_CACHE = "0";
  return fake;
}

const at = (base: number, s: number) => () => new Date(base + s * 1000);

describe("retry queue", () => {
  it("a 529 queues the turn; after Jev recovers it is saved on a later hook run, exactly once, before the newer turn", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const f = await outage(529, 1, (state) => (/MySQL/.test(state.user_message) ? CONTRADICTS(state.existing_memories[0]?.id ?? "none") : SAVE_DECISION));
    const t0 = Date.parse("2026-09-25T10:00:00Z");

    const a = await runHook({ hook_event_name: "Stop", cwd: root, user_message: "We will use Postgres 16 for the primary store." }, { env, now: at(t0, 0) });
    expect(a.action).toBe("queued");
    expect(a.detail).toMatch(/529|Overloaded|overloaded|APIError/i);
    const q = readQueue(root);
    expect(q).toHaveLength(1);
    expect(q[0]!.attempts).toBe(1);
    expect(new MemoryStore(root).list()).toHaveLength(0);

    // A newer turn (it reverses the first) arrives after Jev recovered and the backoff has passed: the queued turn is
    // evaluated first, so the reversal finds the Postgres line and supersedes it.
    const b = await runHook({ hook_event_name: "Stop", cwd: root, user_message: "Change of plan: MySQL instead of Postgres, the host only offers MySQL." }, { env, now: at(t0, 20) });
    expect(b.action).toBe("saved");
    expect(b.detail).toMatch(/supersedes/);
    expect(b.detail).toMatch(/after 1 queued turn/);
    expect(readQueue(root)).toHaveLength(0);
    const store = new MemoryStore(root);
    const all = store.list();
    expect(all).toHaveLength(2);
    expect(all[0]!.kind).toBe("superseded");
    expect(all[0]!.text).toMatch(/Postgres 16/);
    expect(store.active()).toHaveLength(1);

    // Exactly once: one decision per turn hash, and nothing left to retry.
    const decisions = fs.readFileSync(path.join(root, ".jevmem", "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(new Set(decisions.map((d) => d.hash)).size).toBe(decisions.length);
    expect(decisions).toHaveLength(2);
    // Requests: one failed, then the queued turn, then the new turn (tier 1 each).
    expect(f.requests).toHaveLength(3);
    // Stop firing again for the same turn does not queue it twice.
    const again = await runHook({ hook_event_name: "Stop", cwd: root, user_message: "Change of plan: MySQL instead of Postgres, the host only offers MySQL." }, { env, now: at(t0, 40) });
    expect(again.action).toBe("noop");
    expect(store.list()).toHaveLength(2);

    const s = queueStats(root, readLog(root));
    expect(s).toEqual({ pending: 0, queued: 1, retried: 1, savedFromQueue: 1, skippedFromQueue: 0, dropped: 0 });
  });

  it("respects the backoff: a hook run before the retry time only queues the new turn behind the failed one", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const f = await outage(503, 1, () => SAVE_DECISION);
    const t0 = Date.parse("2026-09-25T10:00:00Z");
    await runHook({ hook_event_name: "Stop", cwd: root, user_message: "We will use Redis for the job queue." }, { env, now: at(t0, 0) });
    const b = await runHook({ hook_event_name: "Stop", cwd: root, user_message: "Workers live in apps/worker." }, { env, now: at(t0, 5) });
    expect(b.action).toBe("queued");
    expect(b.detail).toMatch(/behind 1 older turn/);
    expect(readQueue(root).map((t) => t.user)).toEqual(["We will use Redis for the job queue.", "Workers live in apps/worker."]);
    expect(f.requests).toHaveLength(1); // nothing sent during the backoff
  });

  it("scrubs the turn before it is written to the queue", () => {
    const root = tmp();
    enqueueTurn(root, { hash: "a".repeat(16), user: "the DB_PASSWORD=hunter2 is set; use Postgres", assistant: "", previous: "", source: "payload" });
    const raw = fs.readFileSync(path.join(root, ".jevmem", "queue.jsonl"), "utf8");
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain("DB_PASSWORD=[REDACTED]");
  });

  it("drops a turn that is already decided (a drainer that died before removing it) without calling Jev", async () => {
    const root = tmp();
    const hash = "b".repeat(16);
    enqueueTurn(root, { hash, user: "Use Vite for the web build.", assistant: "", previous: "", source: "payload" });
    recordDecision(root, { hash, message: "USER: Use Vite for the web build.", decision: { save: false } as any });
    let calls = 0;
    const r = await drainQueue(root, async () => {
      calls++;
      return { action: "saved", detail: "x" };
    });
    expect(calls).toBe(0);
    expect(r.remaining).toBe(0);
  });

  it("caps the queue at 200 entries and 24 hours, dropping the oldest with a log line", () => {
    const root = tmp();
    const t0 = Date.parse("2026-09-25T00:00:00Z");
    enqueueTurn(root, { hash: "old".padEnd(16, "0"), user: "an old turn", assistant: "", previous: "", source: "payload" }, new Date(t0));
    for (let i = 0; i < QUEUE_MAX_ENTRIES + 3; i++) enqueueTurn(root, { hash: String(i).padStart(16, "x"), user: `turn ${i}`, assistant: "", previous: "", source: "payload" }, new Date(t0 + 25 * 3600_000 + i));
    const q = readQueue(root);
    expect(q).toHaveLength(QUEUE_MAX_ENTRIES);
    expect(q[0]!.user).toBe("turn 3");
    const dropped = readLog(root).filter((e) => e.event === "dropped");
    expect(dropped).toHaveLength(4);
    expect(dropped[0]!.detail).toMatch(/older than 24 h/);
    expect(dropped[1]!.detail).toMatch(/over 200 entries/);
  });

  it("only one process drains at a time", async () => {
    const root = tmp();
    enqueueTurn(root, { hash: "c".repeat(16), user: "Use Vite.", assistant: "", previous: "", source: "payload" });
    fs.writeFileSync(path.join(root, ".jevmem", "drain.lock"), JSON.stringify({ pid: process.ppid, ts: Date.now() }));
    const r = await drainQueue(root, async () => ({ action: "saved" }));
    expect(r.ran).toBe(false);
    expect(readQueue(root)).toHaveLength(1);
    // A lock left by a dead process is taken over.
    fs.writeFileSync(path.join(root, ".jevmem", "drain.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, ts: Date.now() }));
    const r2 = await drainQueue(root, async () => ({ action: "saved" }));
    expect(r2.ran).toBe(true);
    expect(r2.remaining).toBe(0);
  });

  it("classifies failures: timeouts, network errors, 408, 429 and 5xx retry; 4xx does not", () => {
    for (const e of [{ status: 529 }, { status: 503 }, { status: 500 }, { status: 429 }, { status: 408 }, { name: "APITimeoutError", message: "x" }, { name: "APIConnectionError", message: "x" }, new Error("fetch failed"), new Error("connect ECONNREFUSED 127.0.0.1:9")]) expect(isRetryable(e), JSON.stringify(e)).toBe(true);
    for (const e of [{ status: 400 }, { status: 401 }, { status: 403 }, { status: 422 }, new Error("boom"), null]) expect(isRetryable(e), JSON.stringify(e)).toBe(false);
  });

  it("jevmem stats shows queued, retried, saved-from-queue and dropped counts", async () => {
    const root = tmp();
    for (const [event, detail] of [["queued", "x"], ["retried", "attempt 2"], ["retried", "attempt 3"], ["dequeued", "saved: [decision] x"], ["dequeued", "skipped: chit-chat"], ["dropped", "older than 24 h"]] as const)
      appendLog(root, { ts: new Date().toISOString(), label: "queue", event, ok: true, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, detail });
    let out = "";
    await main(["stats"], { out: (s) => void (out += s), err: () => {}, cwd: root });
    expect(out).toMatch(/retry queue: 1 queued after a Jev failure, 2 retries, 1 saved from the queue \(1 skipped by Jev\), 1 dropped, 0 pending/);
    // Queue events are not Jev calls: they do not count toward calls or latency.
    expect(out).toMatch(/^0 call\(s\)/);
  });
});
