/**
 * The Stop hook's turns (v0.6 part 3b): which turns of a Claude Code session have been handed to decide, and which are
 * still running, in `.jevmem/turns.json`.
 *
 * With a background subagent the main agent stops while the subagent works, so Claude Code runs the `Stop` hooks in the
 * middle of the turn; the subagent's report comes back later as a task notification, and the turn goes on. The hook
 * never decides a turn while a subagent it launched has not reported back (src/transcript.ts): it keeps the turn here
 * instead, with its text so far, and decides it once, when it is over:
 * - at the `Stop` that ends it, when every subagent has reported (the usual case);
 * - at the next `Stop` in the same session, when the user has typed a new prompt since (the turn is closed);
 * - or when its session has written nothing for QUIET_MS (the session ended, or the subagent was stopped): at the next
 *   `Stop` in the project, or from the daemon, which looks every few seconds while a turn waits here.
 * A turn handed to decide is recorded by its session and prompt uuid, so later `Stop` hooks of the same turn (another
 * `Stop` hook made Claude go on, or a background shell's notification woke it) do not decide it again.
 * Writes happen under the queue's short file lock. The text is scrubbed, as in the queue.
 */
import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "./queue.js";
import { scrubSecrets } from "./scrub.js";
import { readTranscriptTurns, type TranscriptTurn } from "./transcript.js";

/** A running turn is decided anyway once its session has written nothing for this long. */
export const QUIET_MS = 10 * 60_000;
const MAX_DECIDED = 500;
const MAX_DEFERRED = 20;

export interface DeferredTurn {
  session: string;
  /** The prompt's uuid (null in a transcript without uuids). */
  turn: string | null;
  transcript: string | null;
  firstAt: string;
  lastAt: string;
  user: string;
  assistant: string;
  previous: string;
  /** The background subagents it was waiting for at its last Stop. */
  waiting: string[];
}

interface TurnState {
  decided: { session: string; turn: string; at: string }[];
  deferred: DeferredTurn[];
}

const file = (root: string) => path.join(root, ".jevmem", "turns.json");

export function readTurnState(root: string): TurnState {
  try {
    const raw = JSON.parse(fs.readFileSync(file(root), "utf8"));
    return { decided: Array.isArray(raw?.decided) ? raw.decided : [], deferred: Array.isArray(raw?.deferred) ? raw.deferred : [] };
  } catch {
    return { decided: [], deferred: [] };
  }
}

function writeTurnState(root: string, s: TurnState): void {
  const f = file(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ decided: s.decided.slice(-MAX_DECIDED), deferred: s.deferred.slice(-MAX_DEFERRED) }, null, 1));
  fs.renameSync(tmp, f);
}

function update<T>(root: string, fn: (s: TurnState) => T): T {
  return withFileLock(root, () => {
    const s = readTurnState(root);
    const out = fn(s);
    writeTurnState(root, s);
    return out;
  });
}

export function deferredTurns(root: string): DeferredTurn[] {
  return readTurnState(root).deferred;
}

export function isDecided(root: string, session: string, turn: string | null): boolean {
  return turn !== null && readTurnState(root).decided.some((d) => d.session === session && d.turn === turn);
}

/** Record that a turn was handed to decide; its waiting entry, if any, is removed. */
export function markDecided(root: string, session: string, turn: string | null, now: Date = new Date()): void {
  update(root, (s) => {
    s.deferred = s.deferred.filter((d) => !(d.session === session && d.turn === turn));
    if (turn !== null && !s.decided.some((d) => d.session === session && d.turn === turn)) s.decided.push({ session, turn, at: now.toISOString() });
  });
}

/** Keep a running turn (or update the one kept), with its text so far. */
export function deferTurn(root: string, t: { session: string; turn: string | null; transcript: string | null; user: string; assistant: string; previous: string; waiting: string[] }, now: Date = new Date()): void {
  update(root, (s) => {
    const cur = s.deferred.find((d) => d.session === t.session && d.turn === t.turn);
    const text = { user: scrubSecrets(t.user), assistant: scrubSecrets(t.assistant), previous: scrubSecrets(t.previous) };
    if (cur) Object.assign(cur, text, { transcript: t.transcript, waiting: t.waiting, lastAt: now.toISOString() });
    else s.deferred.push({ session: t.session, turn: t.turn, transcript: t.transcript, firstAt: now.toISOString(), lastAt: now.toISOString(), ...text, waiting: t.waiting });
  });
}

/** When a session last wrote anything: its transcript, or a subagent's transcript next to it. Null when it is gone. */
export function sessionWrittenAt(transcript: string | null): number | null {
  if (!transcript) return null;
  let at: number;
  try {
    at = fs.statSync(transcript).mtimeMs;
  } catch {
    return null;
  }
  const dir = path.join(transcript.replace(/\.jsonl$/, ""), "subagents");
  try {
    for (const f of fs.readdirSync(dir)) at = Math.max(at, fs.statSync(path.join(dir, f)).mtimeMs);
  } catch {
    /* no subagents */
  }
  return at;
}

export interface ReleasedTurn {
  session: string;
  turn: string | null;
  user: string;
  assistant: string;
  previous: string;
  why: "closed" | "quiet" | "gone";
}

/**
 * Take the waiting turns that are over, oldest first, and record them as decided. `current` is the session and the
 * turns just read from its transcript (at a Stop): its kept turns that a later prompt has closed are over, and so is
 * any kept turn whose session is gone or has been quiet for QUIET_MS. A turn's text is read again from its transcript
 * when it is still there (by now it holds the whole turn); otherwise the text kept at its last Stop is used.
 */
export function releaseDeferred(root: string, opts: { now?: number; current?: { session: string; turns: TranscriptTurn[] } } = {}): ReleasedTurn[] {
  const now = opts.now ?? Date.now();
  const kept = deferredTurns(root);
  if (!kept.length) return [];
  const out: ReleasedTurn[] = [];
  for (const d of kept) {
    let why: ReleasedTurn["why"] | null = null;
    let text: TranscriptTurn | undefined;
    if (opts.current && d.session === opts.current.session) {
      text = d.turn === null ? undefined : opts.current.turns.find((t) => t.id === d.turn);
      if (text?.closed) why = "closed";
      else if (!text && d.turn !== null) why = "closed"; // no longer in its transcript (compacted, or rewritten)
    }
    if (!why) {
      const at = sessionWrittenAt(d.transcript);
      if (at === null) why = "gone";
      else if (now - at >= QUIET_MS) why = "quiet";
      if (why && d.turn !== null && d.transcript) text = readTranscriptTurns(d.transcript)?.find((t) => t.id === d.turn);
    }
    if (!why) continue;
    out.push({ session: d.session, turn: d.turn, user: text?.user ?? d.user, assistant: text?.assistant || d.assistant, previous: text?.previous ?? d.previous, why });
  }
  if (!out.length) return [];
  update(root, (s) => {
    for (const r of out) {
      s.deferred = s.deferred.filter((d) => !(d.session === r.session && d.turn === r.turn));
      if (r.turn !== null && !s.decided.some((d) => d.session === r.session && d.turn === r.turn)) s.decided.push({ session: r.session, turn: r.turn, at: new Date(now).toISOString() });
    }
  });
  return out;
}
