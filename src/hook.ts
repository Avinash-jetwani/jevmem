import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { decide } from "./decide.js";
import { loadEnvFallbacks } from "./env.js";
import { appendLog, createJev, hasJevKey, summarizeLog, type JevCaller } from "./jev.js";
import { recordDecision } from "./labels.js";
import { formatInjection, recallForPrompt } from "./recall.js";
import { MemoryStore } from "./store.js";
import { lastTurnFromTranscript, mergeTurn } from "./transcript.js";
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
  /** Simulation fields (used by tests and `jevmem hook --simulate`): bypass the transcript. */
  message?: string;
  user_message?: string;
  assistant_message?: string;
  recent_context?: string;
}

export interface HookOutcome {
  event: string;
  action: "saved" | "skipped" | "injected" | "noop" | "error";
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

/** Handle one Claude Code hook event. Never throws; never blocks longer than the configured Jev timeout. */
export async function runHook(input: HookInput, deps: HookDeps = {}): Promise<HookOutcome> {
  const env = deps.env ?? process.env;
  const root = hookRoot(input, env);
  debugLogPayload(root, input, env);
  const cfg = loadConfig(root);
  const store = new MemoryStore(root, cfg.memoryFile);
  const event = hookEvent(input);
  // Desktop-app hooks get no shell profile: pull the key from .jevmem/.env, ~/.jevmem/env, or the user's profiles.
  if (!deps.jev && !hasJevKey()) loadEnvFallbacks(root, process.env, deps.env?.HOME);
  const jev =
    deps.jev ??
    (hasJevKey()
      ? createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, timeoutMs: cfg.jev.timeoutMs, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention })
      : null);
  if (!jev) {
    const detail = "TYPESAFE_API_KEY not set (checked env, .jevmem/.env, ~/.jevmem/env, shell profiles); jevmem skipped";
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
  const env = deps.env ?? process.env;
  try {
    if (event === "UserPromptSubmit") {
      const prompt = (input.user_prompt ?? input.prompt ?? input.user_prompt_raw ?? input.message ?? "").trim();
      const memories = store.active();
      if (!prompt || memories.length === 0) return { event, action: "noop", detail: "no prompt or no memories" };
      const ranked = await recallForPrompt(jev, prompt, memories, {
        topK: cfg.thresholds.recallTopK,
        min: cfg.thresholds.recallMin,
        timeoutMs: cfg.jev.timeoutMs,
        maxIds: cfg.jev.maxRecallCandidates,
      });
      if (ranked.length === 0) return { event, action: "noop", detail: "no relevant memories" };
      const additionalContext = formatInjection(ranked);
      const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } });
      return { event, action: "injected", detail: `${ranked.length} memories: ${ranked.map((r) => r.memory.id).join(",")}`, stdout };
    }

    // Stop (and anything else): evaluate the latest turn. Real payloads carry no user text, only `transcript_path`
    // (and, on newer Claude Code, `last_assistant_message`); the simulated shape carries the text directly.
    // `stop_hook_active` means another Stop hook already made Claude continue; we never block, so no loop is
    // possible from here, and the turn-hash check below stops the same content being evaluated twice.
    let user = input.user_message ?? input.message ?? "";
    let assistant = input.assistant_message ?? "";
    let previous = input.recent_context ?? "";
    let source = "payload";
    if (!user && !assistant && input.transcript_path) {
      const t = lastTurnFromTranscript(input.transcript_path);
      if (t) {
        ({ user, assistant, previous } = t);
        source = "transcript";
      } else source = "transcript-unreadable";
    }
    if (!assistant && input.last_assistant_message) {
      assistant = input.last_assistant_message;
      source += "+last_assistant_message";
    }
    const message = mergeTurn(user, assistant);
    if (message.trim().length < 8) {
      const detail = `empty turn (source: ${source}${input.transcript_path ? `, transcript ${fs.existsSync(input.transcript_path) ? "exists" : "missing"}` : ", no transcript_path"})`;
      if (source !== "payload") logHookProblem(store.root, event, detail);
      return { event, action: "noop", detail };
    }

    // Don't evaluate the same turn twice (Stop can fire more than once per turn).
    const hash = crypto.createHash("sha1").update(message).digest("hex").slice(0, 16);
    const state = readStateFile(store.dir);
    if (state.lastTurnHash === hash) return { event, action: "noop", detail: "turn already evaluated" };
    writeStateFile(store.dir, { ...state, lastTurnHash: hash, lastRunAt: (deps.now ?? (() => new Date()))().toISOString() });

    const existing = store.active();
    const decision = await decide(
      jev,
      { userMessage: user, assistantReply: assistant, recentContext: previous, existingMemories: existing },
      { thresholds: cfg.thresholds, weights: cfg.weights, tiers: cfg.tiers, maxIds: cfg.jev.maxIdsPerCall, timeoutMs: cfg.jev.timeoutMs },
    );
    if (!decision.save) {
      recordDecision(store.root, { hash, message, decision });
      return { event, action: "skipped", detail: decision.reason, decision };
    }

    const result = await writeMemory(store, decision.sourceText || message, decision, { writer: cfg.writer, env, fetchImpl: deps.fetchImpl });
    recordDecision(store.root, { hash, memoryId: result.saved.id, message, decision });
    // Exact duplicate of a live memory: drop the new line again.
    const dup = existing.find((m) => m.text.toLowerCase() === result.line.toLowerCase());
    if (dup && !result.superseded) {
      store.remove(result.saved.id);
      return { event, action: "skipped", detail: `duplicate of ${dup.id}`, decision };
    }
    const sup = result.superseded ? ` (supersedes ${result.superseded.id})` : "";
    return { event, action: "saved", detail: `[${result.saved.kind}] ${result.line} id:${result.saved.id}${sup} via ${result.writerUsed}`, decision };
  } catch (err) {
    return { event, action: "error", detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

export async function readStdinJson(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return { message: raw };
  }
}
