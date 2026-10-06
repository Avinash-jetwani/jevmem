import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { decide } from "./decide.js";
import { loadEnvFallbacks } from "./env.js";
import { appendLog, createJev, hasJevKey, summarizeLog, type JevCaller } from "./jev.js";
import { gatePendingRules } from "./guardrail.js";
import { recordDecision } from "./labels.js";
import { recordProvenance, savedBefore } from "./provenance.js";
import { noteFirstLine } from "./notice.js";
import { formatInjection, recallGuarded, replacedTexts, type RecallPath } from "./recall.js";
import { DEFAULT_CONFIG } from "./types.js";
import { drainQueue, enqueueTurn, readQueue, type QueuedTurn } from "./queue.js";
import { MemoryStore } from "./store.js";
import { mergeTurn, readTranscriptTurns } from "./transcript.js";
import { describePick, pickRecord } from "./pick.js";
import { deferTurn, isDecided, markDecided, releaseDeferred, type ReleasedTurn } from "./turns.js";
import { writeMemory } from "./write.js";

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  /** UserPromptSubmit: the prompt text (current Claude Code field; `prompt` is the older name). */
  user_prompt?: string;
  user_prompt_raw?: string;
  prompt?: string;
  /** Stop: the final assistant text of the turn (Claude Code ≥ 2.1). The user text still comes from the transcript. */
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  /** Stop (Claude Code 2.1.2xx): the session's background tasks, a subagent `running` while the main agent stops. */
  background_tasks?: { id?: string; type?: string; status?: string }[];
  /** Simulation fields (used by tests and `jevmem hook --simulate`): bypass the transcript. */
  message?: string;
  user_message?: string;
  assistant_message?: string;
  recent_context?: string;
}

export interface HookOutcome {
  event: string;
  /** `queued`: the turn is in `.jevmem/queue.jsonl` and will be evaluated later (behind older turns, or after a Jev failure). */
  action: "saved" | "skipped" | "injected" | "noop" | "error" | "queued";
  detail: string;
  stdout?: string;
  decision?: unknown;
  /** One-line Jev latency/cost summary for this run (printed by the CLI when JEVMEM_VERBOSE=1). */
  summary?: string;
  /** Where the work ran: in this process or in the warm daemon. */
  via?: "inline" | "daemon";
}

export interface HookDeps {
  jev?: JevCaller;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function readStateFile(dir: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  } catch {
    return {};
  }
}
function writeStateFile(dir: string, s: Record<string, unknown>): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(s, null, 2));
  } catch {
    /* best effort */
  }
}

/** The project root a hook event belongs to: CLAUDE_PROJECT_DIR (stable across worktrees) → payload cwd → process cwd. */
export function hookRoot(input: HookInput, env: NodeJS.ProcessEnv = process.env): string {
  for (const c of [env.CLAUDE_PROJECT_DIR, input.cwd]) if (c && fs.existsSync(c)) return c;
  return process.cwd();
}

export function hookEvent(input: HookInput): string {
  return input.hook_event_name ?? (input.user_prompt !== undefined || input.prompt !== undefined ? "UserPromptSubmit" : "Stop");
}

/** Append the raw payload to `.jevmem/hook-debug.log` (opt-in with JEVMEM_DEBUG=1). Keeps the last 200 entries. */
export function debugLogPayload(root: string, input: HookInput, env: NodeJS.ProcessEnv = process.env): void {
  if (env.JEVMEM_DEBUG !== "1") return;
  try {
    const dir = path.join(root, ".jevmem");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "hook-debug.log");
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, execPath: process.execPath, env: { PATH: env.PATH, CLAUDE_PROJECT_DIR: env.CLAUDE_PROJECT_DIR, TYPESAFE_API_KEY: env.TYPESAFE_API_KEY ? "set" : "missing" }, payload: input }) + "\n");
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > 200) fs.writeFileSync(file, lines.slice(-200).join("\n") + "\n");
  } catch {
    /* best effort */
  }
}

/** Record a hook problem in `.jevmem/log.jsonl` so nothing fails silently. */
export function logHookProblem(root: string, event: string, error: string): void {
  appendLog(root, { ts: new Date().toISOString(), label: "hook", ok: false, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, error: `${event}: ${error}` });
}

/**
 * Record how a prompt's lines were picked (v0.6 part 3b): `served` events in `.jevmem/log.jsonl`, which `jevmem stats`
 * counts. `detail` starts with "jev" or "word match" and says how many lines the prompt got; a word match also says
 * why Jev did not answer (failed, or ran past `jev.recallTimeoutMs`).
 */
export function logRecallPath(root: string, served: RecallPath, lines: number, latencyMs: number, error?: string): void {
  appendLog(root, { ts: new Date().toISOString(), label: "recall", event: "served", ok: served === "jev", latencyMs, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, detail: served === "jev" ? `jev: ${lines} line(s)` : `word match: ${lines} line(s); ${error ?? "Jev did not answer"}` });
}

/** How `served` events split: prompts whose lines Jev picked, prompts served by word match, and prompts that got no line. */
export function recallPathStats(entries: { label?: string; event?: string; detail?: string }[]): { total: number; jev: number; wordMatch: number; noLine: number } {
  const served = entries.filter((e) => e.label === "recall" && e.event === "served");
  return {
    total: served.length,
    jev: served.filter((e) => /^jev\b/.test(e.detail ?? "")).length,
    wordMatch: served.filter((e) => /^word match\b/.test(e.detail ?? "")).length,
    noLine: served.filter((e) => /: 0 line\(s\)/.test(e.detail ?? "")).length,
  };
}

/** Handle one Claude Code hook event. Never throws; never blocks longer than the configured Jev timeout. */
export async function runHook(input: HookInput, deps: HookDeps = {}): Promise<HookOutcome> {
  const env = deps.env ?? process.env;
  const root = hookRoot(input, env);
  debugLogPayload(root, input, env);
  const cfg = loadConfig(root);
  const store = new MemoryStore(root, cfg.memoryFile);
  const event = hookEvent(input);
  if (cfg.enabled === false) return { event, action: "noop", detail: "jevmem is switched off for this project (jevmem.config.json: enabled false)" };
  // Desktop-app hooks get no shell environment: pull the key from .jevmem/.env or ~/.jevmem/env.
  if (!deps.jev && !hasJevKey()) loadEnvFallbacks(root, process.env, deps.env?.HOME);
  const jev =
    deps.jev ??
    (hasJevKey()
      ? createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, timeoutMs: cfg.jev.timeoutMs, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention })
      : null);
  if (!jev) {
    const detail = "TYPESAFE_API_KEY not set (checked the plugin setting, env, .jevmem/.env, ~/.jevmem/env); jevmem skipped";
    logHookProblem(root, event, detail);
    return { event, action: "noop", detail };
  }
  const logStart = jev.log.length;
  const outcome = await runHookInner(event, input, store, cfg, jev, deps);
  if (outcome.action === "error") logHookProblem(root, event, outcome.detail);
  const s = summarizeLog(jev.log.slice(logStart));
  outcome.summary = `${s.calls} jev call(s), p50 ${s.p50LatencyMs} ms, ${s.totalTokens} tokens, $${s.totalCostUsd.toFixed(6)}`;
  outcome.via = "inline";
  return outcome;
}

async function runHookInner(event: string, input: HookInput, store: MemoryStore, cfg: ReturnType<typeof loadConfig>, jev: JevCaller, deps: HookDeps): Promise<HookOutcome> {
  try {
    if (event === "UserPromptSubmit") {
      const prompt = (input.user_prompt ?? input.prompt ?? input.user_prompt_raw ?? input.message ?? "").trim();
      const all = store.list();
      const memories = all.filter((m) => m.kind !== "superseded" && !m.supersededBy);
      if (!prompt || memories.length === 0) return { event, action: "noop", detail: "no prompt or no memories" };
      // Unverified lines (not written here by jevmem) go through the poisoning gate in the same Jev call. When the call
      // fails or runs past its budget, the prompt gets the lines sharing the most words with it instead (src/recall.ts).
      const t0 = performance.now();
      const { ranked, withheld, gated, deferred, path: served, error } = await recallGuarded(jev, store.root, prompt, memories, {
        topK: cfg.thresholds.recallTopK,
        min: cfg.thresholds.recallChoiceMin ?? DEFAULT_CONFIG.thresholds.recallChoiceMin,
        relevanceMin: cfg.thresholds.recallRelevanceMin,
        injectionMax: cfg.thresholds.injectionMax,
        timeoutMs: cfg.jev.recallTimeoutMs ?? DEFAULT_CONFIG.jev.recallTimeoutMs,
        maxIds: cfg.jev.maxRecallLines,
        replaced: replacedTexts(all),
      });
      logRecallPath(store.root, served, ranked.length, Math.round(performance.now() - t0), error);
      const how = served === "word-match" ? `; by word match, Jev: ${error}` : "";
      const gate = `${gated} gated${deferred ? `, ${deferred} left for a later prompt` : ""}${withheld.length ? `, withheld ${withheld.map((w) => w.memory.id).join(",")}` : ""}`;
      if (ranked.length === 0) return { event, action: "noop", detail: `no relevant memories (${gate}${how})` };
      const additionalContext = formatInjection(ranked);
      const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } });
      return { event, action: "injected", detail: `${ranked.length} memories${served === "word-match" ? " by word match" : ""}: ${ranked.map((r) => r.memory.id).join(",")} (${gate}${how})`, stdout };
    }

    // Stop (and anything else): capture the turns that are over (the latest, unless it is still running), queue them,
    // and evaluate the queue in order.
    const cap = captureTurns(input, store.root, event, deps);
    for (const t of cap.turns) enqueueTurn(store.root, t);
    const current = cap.turns.find((t) => t.current);
    if (!current) {
      if (!cap.turns.length) return cap.outcome!;
      await drainTurns(store.root, cfg, jev, deps, { deadlineMs: 12_000 });
      return cap.outcome!;
    }
    const r = await drainTurns(store.root, cfg, jev, deps, { deadlineMs: 12_000 });
    const mine = r.processed.find((p) => p.turn.hash === current.hash);
    if (mine) {
      const others = r.processed.length - 1;
      return others > 0 ? { ...mine.outcome, detail: `${mine.outcome.detail} (after ${others} queued turn(s))` } : mine.outcome;
    }
    const q = readQueue(store.root);
    const head = q[0];
    const detail = !r.ran
      ? "queued; another jevmem process is evaluating the queue"
      : head && head.hash === current.hash && head.attempts > 0
        ? `queued for retry: Jev failed (${head.lastError ?? "unknown error"}); next try after ${head.nextAttemptAt}`
        : `queued behind ${Math.max(0, q.findIndex((t) => t.hash === current.hash))} older turn(s)${head?.lastError ? ` (head failed: ${head.lastError})` : ""}`;
    return { event, action: "queued", detail };
  } catch (err) {
    return { event, action: "error", detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

/** A turn the Stop hook hands to decide. `current`: the turn this Stop ended (the others are earlier turns now over). */
export type CapturedTurn = Omit<QueuedTurn, "enqueuedAt" | "attempts"> & { current: boolean };

const hashOf = (message: string) => crypto.createHash("sha1").update(message).digest("hex").slice(0, 16);

function releasedTurn(r: ReleasedTurn): CapturedTurn | null {
  const message = mergeTurn(r.user, r.assistant);
  if (message.trim().length < 8) return null;
  return { hash: hashOf(message), user: r.user, assistant: r.assistant, previous: r.previous, source: `transcript (a turn that waited for its background subagents; ${r.why})`, current: false };
}

/**
 * The turns a Stop event hands to decide, oldest first, and the outcome when the turn it ended is not among them.
 * Real payloads carry no user text, only `transcript_path` (and, on newer Claude Code, `last_assistant_message`, the
 * final text, which the transcript does not hold yet when the hook runs); the simulated shape carries the text directly.
 *
 * A turn is decided once, when it is over (src/turns.ts, v0.6 part 3b): while a background subagent it launched has not
 * reported back, the turn is kept and nothing is decided; a turn kept earlier is handed on when a later prompt has closed
 * it or its session has gone quiet. A turn already handed on is not decided again, nor is the same text (Stop can fire
 * more than once per turn).
 */
export function captureTurns(input: HookInput, root: string, event: string, deps: Pick<HookDeps, "now"> = {}): { turns: CapturedTurn[]; outcome?: HookOutcome } {
  // `stop_hook_active` means another Stop hook already made Claude continue; we never block, so no loop is possible
  // from here, and the turn checks below stop the same turn being evaluated twice.
  const now = (deps.now ?? (() => new Date()))();
  let user = input.user_message ?? input.message ?? "";
  let assistant = input.assistant_message ?? "";
  let previous = input.recent_context ?? "";
  let source = "payload";
  let turnId: string | null = null;
  const session = input.session_id ?? input.transcript_path ?? "";
  const before: CapturedTurn[] = [];
  if (!user && !assistant && input.transcript_path) {
    const turns = readTranscriptTurns(input.transcript_path, { lastAssistantMessage: input.last_assistant_message });
    if (turns) {
      for (const r of releaseDeferred(root, { now: now.getTime(), current: { session, turns } })) {
        const t = releasedTurn(r);
        if (t) before.push(t);
      }
      const t = turns[turns.length - 1]!;
      ({ user, assistant, previous } = t);
      turnId = t.id;
      source = input.last_assistant_message ? "transcript+last_assistant_message" : "transcript";
      if (t.waiting.length) {
        deferTurn(root, { session, turn: t.id, transcript: input.transcript_path, user, assistant, previous, waiting: t.waiting }, now);
        return { turns: before, outcome: { event, action: "noop", detail: `turn still running: ${t.waiting.length} background subagent(s) it launched have not reported back; it is decided once they have` } };
      }
      if (isDecided(root, session, t.id)) return { turns: before, outcome: { event, action: "noop", detail: "turn already decided" } };
    } else {
      source = "transcript-unreadable";
      for (const r of releaseDeferred(root, { now: now.getTime() })) {
        const t = releasedTurn(r);
        if (t) before.push(t);
      }
    }
  }
  if (!assistant && input.last_assistant_message) {
    assistant = input.last_assistant_message;
    source += "+last_assistant_message";
  }
  const message = mergeTurn(user, assistant);
  if (message.trim().length < 8) {
    const detail = `empty turn (source: ${source}${input.transcript_path ? `, transcript ${fs.existsSync(input.transcript_path) ? "exists" : "missing"}` : ", no transcript_path"})`;
    if (source !== "payload") logHookProblem(root, event, detail);
    return { turns: before, outcome: { event, action: "noop", detail } };
  }
  const hash = hashOf(message);
  const dir = path.join(root, ".jevmem");
  const state = readStateFile(dir);
  if (state.lastTurnHash === hash) return { turns: before, outcome: { event, action: "noop", detail: "turn already captured" } };
  writeStateFile(dir, { ...state, lastTurnHash: hash, lastRunAt: now.toISOString() });
  if (input.transcript_path && source.startsWith("transcript")) markDecided(root, session, turnId, now);
  return { turns: [...before, { hash, user, assistant, previous, source, current: true }] };
}

/** Queue the kept turns whose sessions have gone quiet or are gone (the daemon's timer). Returns how many were queued. */
export function releaseQuietTurns(root: string, now: number = Date.now()): number {
  let n = 0;
  for (const r of releaseDeferred(root, { now })) {
    const t = releasedTurn(r);
    if (!t) continue;
    enqueueTurn(root, t);
    n++;
  }
  return n;
}

/** The turn a Stop event ended, or the outcome when there is none to decide (for library users; the hook uses captureTurns). */
export function captureTurn(input: HookInput, root: string, event: string, deps: Pick<HookDeps, "now"> = {}): { turn: Omit<QueuedTurn, "enqueuedAt" | "attempts"> } | { outcome: HookOutcome } {
  const r = captureTurns(input, root, event, deps);
  const cur = r.turns.find((t) => t.current);
  if (!cur) return { outcome: r.outcome! };
  const { current: _current, ...turn } = cur;
  return { turn };
}

/**
 * Evaluate one queued turn: decide, then write. Throws when Jev fails, so the queue keeps the turn for a retry.
 * The text was scrubbed when it was queued; decide and the writer scrub again.
 */
export async function evaluateTurn(store: MemoryStore, cfg: ReturnType<typeof loadConfig>, jev: JevCaller, turn: Pick<QueuedTurn, "hash" | "user" | "assistant" | "previous">, deps: HookDeps = {}): Promise<HookOutcome> {
  const env = deps.env ?? process.env;
  const event = "Stop";
  const { hash, user, assistant, previous } = turn;
  const message = mergeTurn(user, assistant);
  const existing = store.active();
  const decision = await decide(
    jev,
    { userMessage: user, assistantReply: assistant, recentContext: previous, existingMemories: existing },
    { thresholds: cfg.thresholds, weights: cfg.weights, tiers: cfg.tiers, maxIds: cfg.jev.maxIdsPerCall, timeoutMs: cfg.jev.timeoutMs, askAboutReply: cfg.jev.askAboutReply },
  );
  if (!decision.save) {
    recordDecision(store.root, { hash, message, decision });
    return { event, action: "skipped", detail: decision.reason, decision };
  }

  // Jev picks the sentences jevmem's own writer makes the line from: one more request, only for a turn that is saved.
  const result = await writeMemory(store, decision.sourceText || message, decision, { writer: cfg.writer, env, fetchImpl: deps.fetchImpl, jev, jevTimeoutMs: cfg.jev.timeoutMs });
  // The LLM writer could not give its line (or needed its request changed), or Jev's pick failed: say so in the log,
  // which doctor and stats read.
  if (result.writerNote) appendLog(store.root, { ts: new Date().toISOString(), label: "writer", event: "writer-fallback", ok: result.writerUsed !== "fallback" && !result.pick?.error, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, memoryId: result.saved.id, detail: result.writerNote });
  const pick = result.pick ? pickRecord(result.pick) : undefined;
  recordDecision(store.root, { hash, memoryId: result.saved.id, message, decision, writer: result.writerUsed, ...(pick ? { pick } : {}) });
  // Exact duplicate of a live memory: drop the new line again.
  const dup = existing.find((m) => m.text.toLowerCase() === result.line.toLowerCase());
  if (dup && !result.superseded) {
    store.remove(result.saved.id);
    return { event, action: "skipped", detail: `duplicate of ${dup.id}`, decision };
  }
  // The project's first line saved by jevmem is announced on the next prompt (src/notice.ts).
  noteFirstLine(store.root, savedBefore(store.root, result.saved.id));
  recordProvenance(store.root, result.saved, "hook");
  const sup = result.superseded ? ` (supersedes ${result.superseded.id})` : "";
  return { event, action: "saved", detail: `[${result.saved.kind}] ${result.line} id:${result.saved.id}${sup} via ${result.writerUsed}${pick && !pick.error ? ` (${describePick(pick)})` : ""}${result.writerNote ? ` (${result.writerNote})` : ""}`, decision };
}

/**
 * Evaluate the queue in order with `jev` (the hook's client, or the daemon's warm one). Then, still off any hot path,
 * give the guard a gate verdict for [constraint] lines that have none (written by hand, merged from git, or added with
 * `jevmem add`): the PreToolUse hook never asks the gate itself and does not enforce a line until it has one.
 */
export async function drainTurns(root: string, cfg: ReturnType<typeof loadConfig>, jev: JevCaller, deps: HookDeps = {}, opts: { deadlineMs?: number; ignoreBackoff?: boolean } = {}) {
  const store = new MemoryStore(root, cfg.memoryFile);
  const r = await drainQueue<HookOutcome>(root, (t) => evaluateTurn(store, cfg, jev, t, deps), { now: deps.now, deadlineMs: opts.deadlineMs, ignoreBackoff: opts.ignoreBackoff });
  if (r.ran && cfg.guard?.mode !== "off") {
    try {
      await gatePendingRules(root, cfg, jev, store.active());
    } catch (err) {
      logHookProblem(root, "Stop", `gate check of new rules for the guard failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return r;
}

export async function readStdinJson(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return parseHookInput(Buffer.concat(chunks).toString("utf8"));
}

/** A hook's stdin as a payload. Text that is not JSON is taken as a turn to simulate (`message`). */
export function parseHookInput(text: string): HookInput {
  const raw = text.trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return { message: raw };
  }
}
