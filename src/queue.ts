/**
 * The turn queue: `.jevmem/queue.jsonl`.
 *
 * Every Stop turn is appended here (scrubbed) before it is evaluated, and evaluated from here, oldest first. When Jev
 * times out, is unreachable, or answers 408/429/5xx (including 529), the turn stays at the head with a backoff and is
 * retried on the next hook run or when the daemon is idle; later turns wait behind it, so a reversal is never decided
 * before the decision it reverses. Caps: 24 hours and 200 entries; the oldest are dropped with a log line.
 *
 * Two locks, both files in `.jevmem/`:
 * - `queue.lock`, held only for a read-modify-write of `queue.jsonl` (milliseconds), so an append from a hook process
 *   and a removal by the daemon cannot lose each other's change;
 * - `drain.lock`, held by the one process evaluating turns (seconds), so turns are evaluated once and in order.
 * Exactly once: before a turn is evaluated, its hash is looked up in `.jevmem/decisions.jsonl`; a turn already decided
 * (by a drainer that died before removing it) is dropped from the queue without a second Jev call.
 */
import fs from "node:fs";
import path from "node:path";
import { appendLog } from "./jev.js";
import { scrubSecrets } from "./scrub.js";

export const QUEUE_MAX_ENTRIES = 200;
export const QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Backoff before retry n (1-based): 15 s, 30 s, 1 min, 2 min, 5 min, then every 10 min. */
export const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000];

export interface QueuedTurn {
  /** sha1 of the merged turn (the same hash the Stop hook dedupes on). */
  hash: string;
  user: string;
  assistant: string;
  previous: string;
  /** Where the text came from (payload, transcript, watch). */
  source: string;
  enqueuedAt: string;
  /** Failed evaluations so far. */
  attempts: number;
  /** Not before this time (ISO); absent on a fresh turn. */
  nextAttemptAt?: string;
  lastError?: string;
}

const file = (root: string) => path.join(root, ".jevmem", "queue.jsonl");
const fileLock = (root: string) => path.join(root, ".jevmem", "queue.lock");
const drainLockFile = (root: string) => path.join(root, ".jevmem", "drain.lock");

export function backoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
}

export function readQueue(root: string): QueuedTurn[] {
  let raw = "";
  try {
    raw = fs.readFileSync(file(root), "utf8");
  } catch {
    return [];
  }
  const out: QueuedTurn[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const t = JSON.parse(line) as QueuedTurn;
      if (typeof t.hash === "string") out.push(t);
    } catch {
      /* a torn line; skip */
    }
  }
  return out;
}

function writeQueue(root: string, items: QueuedTurn[]): void {
  const f = file(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, items.map((t) => JSON.stringify(t)).join("\n") + (items.length ? "\n" : ""));
  fs.renameSync(tmp, f);
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Create `lock` exclusively. A lock whose owner is dead, or older than `staleMs`, is taken over. */
function tryLock(lock: string, staleMs: number): boolean {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }
  try {
    const cur = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid: number; ts: number };
    if (cur.pid !== process.pid && pidAlive(cur.pid) && Date.now() - cur.ts < staleMs) return false;
    fs.unlinkSync(lock);
  } catch {
    try {
      // Unreadable (being written right now, or corrupt): stale only when old.
      if (Date.now() - fs.statSync(lock).mtimeMs < staleMs) return false;
      fs.unlinkSync(lock);
    } catch {
      /* gone meanwhile */
    }
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** Run `fn` holding the short queue-file lock (waits up to 3 s). */
function withFileLock<T>(root: string, fn: () => T): T {
  const lock = fileLock(root);
  const until = Date.now() + 3000;
  while (!tryLock(lock, 10_000)) {
    if (Date.now() > until) throw new Error("queue.lock busy");
    sleepSync(10);
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

function logEvent(root: string, event: "queued" | "retried" | "dequeued" | "dropped", detail: string, extra: { turn?: string; attempts?: number } = {}): void {
  appendLog(root, { ts: new Date().toISOString(), label: "queue", event, ok: true, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, detail, ...extra });
}

/** Drop entries past the caps, oldest first, each with a log line. */
function applyCaps(root: string, items: QueuedTurn[], now: number): QueuedTurn[] {
  const kept: QueuedTurn[] = [];
  for (const t of items) {
    if (now - Date.parse(t.enqueuedAt) > QUEUE_MAX_AGE_MS) logEvent(root, "dropped", `older than 24 h (${t.attempts} failed attempt(s); last error: ${t.lastError ?? "none"})`, { turn: t.hash });
    else kept.push(t);
  }
  while (kept.length > QUEUE_MAX_ENTRIES) {
    const t = kept.shift()!;
    logEvent(root, "dropped", `queue over ${QUEUE_MAX_ENTRIES} entries (${t.attempts} failed attempt(s))`, { turn: t.hash });
  }
  return kept;
}

/** Append a scrubbed turn (a turn already in the queue is not added twice). Returns the queue length. */
export function enqueueTurn(root: string, turn: { hash: string; user: string; assistant: string; previous: string; source: string }, now: Date = new Date()): number {
  const entry: QueuedTurn = {
    hash: turn.hash,
    user: scrubSecrets(turn.user),
    assistant: scrubSecrets(turn.assistant),
    previous: scrubSecrets(turn.previous),
    source: turn.source,
    enqueuedAt: now.toISOString(),
    attempts: 0,
  };
  return withFileLock(root, () => {
    const items = readQueue(root);
    if (!items.some((t) => t.hash === entry.hash)) items.push(entry);
    const kept = applyCaps(root, items, now.getTime());
    writeQueue(root, kept);
    return kept.length;
  });
}

/** Is this Jev failure worth retrying? Timeouts, network errors, 408, 429 and 5xx (including 529). */
export function isRetryable(err: unknown): boolean {
  const e = err as { status?: unknown; name?: unknown; message?: unknown; code?: unknown } | null;
  if (!e) return false;
  if (typeof e.status === "number") return e.status === 408 || e.status === 429 || e.status >= 500;
  const name = String(e.name ?? "");
  if (/APIConnectionError|APITimeoutError|TimeoutError|AbortError|FetchError/.test(name)) return true;
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|fetch failed|socket hang up|timed out|timeout|network/i.test(String(e.message ?? "") + " " + String(e.code ?? ""));
}

/** Hashes of turns already decided, from `.jevmem/decisions.jsonl` (only the hash field is read). */
function decidedHashes(root: string): Set<string> {
  const out = new Set<string>();
  try {
    const raw = fs.readFileSync(path.join(root, ".jevmem", "decisions.jsonl"), "utf8");
    for (const m of raw.matchAll(/"hash":"([0-9a-f]{16})"/g)) out.add(m[1]!);
  } catch {
    /* none yet */
  }
  return out;
}

export interface DrainResult<O> {
  /** Outcomes of turns evaluated in this drain, in order. */
  processed: { turn: QueuedTurn; outcome: O }[];
  /** True when the head is waiting for its backoff or failed again (later turns wait behind it). */
  blocked: boolean;
  /** False when another process holds the drain lock. */
  ran: boolean;
  remaining: number;
}

/**
 * Evaluate queued turns oldest first until the queue is empty, the head is not yet due, a retryable failure puts the
 * head back with a backoff, or `deadlineMs` passes. `evaluate` throws on a Jev failure; a non-retryable failure drops
 * the turn with a log line (as before v0.5.0). Only one process drains at a time.
 */
export async function drainQueue<O>(root: string, evaluate: (t: QueuedTurn) => Promise<O>, opts: { now?: () => Date; deadlineMs?: number; ignoreBackoff?: boolean } = {}): Promise<DrainResult<O>> {
  const now = opts.now ?? (() => new Date());
  const lock = drainLockFile(root);
  if (!tryLock(lock, 5 * 60_000)) return { processed: [], blocked: false, ran: false, remaining: readQueue(root).length };
  const started = Date.now();
  const processed: DrainResult<O>["processed"] = [];
  let blocked = false;
  try {
    const decided = decidedHashes(root);
    for (;;) {
      if (opts.deadlineMs !== undefined && Date.now() - started > opts.deadlineMs) break;
      const head = withFileLock(root, () => {
        const items = applyCaps(root, readQueue(root), now().getTime());
        writeQueue(root, items);
        return items[0];
      });
      if (!head) break;
      if (!opts.ignoreBackoff && head.nextAttemptAt && Date.parse(head.nextAttemptAt) > now().getTime()) {
        blocked = true;
        break;
      }
      const remove = () => withFileLock(root, () => writeQueue(root, readQueue(root).filter((t) => t.hash !== head.hash)));
      if (decided.has(head.hash)) {
        remove(); // decided by an earlier drainer that stopped before removing it
        continue;
      }
      if (head.attempts > 0) logEvent(root, "retried", `attempt ${head.attempts + 1}`, { turn: head.hash });
      try {
        const outcome = await evaluate(head);
        decided.add(head.hash);
        remove();
        if (head.attempts > 0) logEvent(root, "dequeued", describe(outcome), { turn: head.hash, attempts: head.attempts });
        processed.push({ turn: head, outcome });
      } catch (err) {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        if (!isRetryable(err)) {
          remove();
          logEvent(root, "dropped", `not retryable: ${msg}`, { turn: head.hash });
          processed.push({ turn: head, outcome: { action: "error", detail: msg } as unknown as O });
          continue;
        }
        const attempts = head.attempts + 1;
        const next = new Date(now().getTime() + backoffMs(attempts)).toISOString();
        withFileLock(root, () => writeQueue(root, readQueue(root).map((t) => (t.hash === head.hash ? { ...t, attempts, nextAttemptAt: next, lastError: msg.slice(0, 300) } : t))));
        if (attempts === 1) logEvent(root, "queued", `Jev failed (${msg.slice(0, 200)}); retry after ${next}`, { turn: head.hash });
        blocked = true;
        break;
      }
    }
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
  return { processed, blocked, ran: true, remaining: readQueue(root).length };
}

function describe(o: unknown): string {
  const x = o as { action?: string; detail?: string } | null;
  return x && typeof x === "object" ? `${x.action ?? "?"}: ${String(x.detail ?? "").slice(0, 200)}` : String(o);
}

/** When the head of the queue may next be tried (null when the queue is empty). */
export function nextDue(root: string): Date | null {
  const head = readQueue(root)[0];
  if (!head) return null;
  return head.nextAttemptAt ? new Date(head.nextAttemptAt) : new Date(0);
}

export interface QueueStats {
  pending: number;
  queued: number;
  retried: number;
  savedFromQueue: number;
  skippedFromQueue: number;
  dropped: number;
}

/** Counts for `jevmem stats`, from the log's queue events and the current queue. */
export function queueStats(root: string, entries: { event?: string; detail?: string }[]): QueueStats {
  const ev = (e: string) => entries.filter((x) => x.event === e);
  const deq = ev("dequeued");
  return {
    pending: readQueue(root).length,
    queued: ev("queued").length,
    retried: ev("retried").length,
    savedFromQueue: deq.filter((x) => (x.detail ?? "").startsWith("saved")).length,
    skippedFromQueue: deq.filter((x) => !(x.detail ?? "").startsWith("saved")).length,
    dropped: ev("dropped").length,
  };
}
