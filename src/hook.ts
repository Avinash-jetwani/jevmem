import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { decide } from "./decide.js";
import { createJev, hasJevKey, summarizeLog, type JevCaller } from "./jev.js";
import { formatInjection, recallForPrompt } from "./recall.js";
import { MemoryStore } from "./store.js";
import { lastTurnFromTranscript, mergeTurn } from "./transcript.js";
import { writeMemory } from "./write.js";

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
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

/** Handle one Claude Code hook event. Never throws; never blocks longer than the configured Jev timeout. */
export async function runHook(input: HookInput, deps: HookDeps = {}): Promise<HookOutcome> {
  const env = deps.env ?? process.env;
  const root = input.cwd && fs.existsSync(input.cwd) ? input.cwd : process.cwd();
  const cfg = loadConfig(root);
  const store = new MemoryStore(root, cfg.memoryFile);
  const event = input.hook_event_name ?? (input.prompt !== undefined ? "UserPromptSubmit" : "Stop");
  const jev =
    deps.jev ??
    (hasJevKey()
      ? createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, timeoutMs: cfg.jev.timeoutMs })
      : null);
  if (!jev) return { event, action: "noop", detail: "TYPESAFE_API_KEY not set; jevmem skipped" };

  try {
    if (event === "UserPromptSubmit") {
      const prompt = (input.prompt ?? input.message ?? "").trim();
      const memories = store.active();
      if (!prompt || memories.length === 0) return { event, action: "noop", detail: "no prompt or no memories" };
      const ranked = await recallForPrompt(jev, prompt, memories, {
        topK: cfg.thresholds.recallTopK,
        min: cfg.thresholds.recallMin,
        timeoutMs: cfg.jev.timeoutMs,
        maxIds: cfg.jev.maxIdsPerCall,
      });
      if (ranked.length === 0) return { event, action: "noop", detail: "no relevant memories" };
      const additionalContext = formatInjection(ranked);
      const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } });
      return { event, action: "injected", detail: `${ranked.length} memories: ${ranked.map((r) => r.memory.id).join(",")}`, stdout };
    }

    // Stop (and anything else): evaluate the latest turn.
    let user = input.user_message ?? input.message ?? "";
    let assistant = input.assistant_message ?? "";
    let previous = input.recent_context ?? "";
    if (!user && !assistant && input.transcript_path) {
      const t = lastTurnFromTranscript(input.transcript_path);
      if (t) ({ user, assistant, previous } = t);
    }
    const message = mergeTurn(user, assistant);
    if (message.trim().length < 8) return { event, action: "noop", detail: "empty turn" };

    // Don't evaluate the same turn twice (Stop can fire more than once per turn).
    const hash = crypto.createHash("sha1").update(message).digest("hex").slice(0, 16);
    const state = readStateFile(store.dir);
    if (state.lastTurnHash === hash) return { event, action: "noop", detail: "turn already evaluated" };
    writeStateFile(store.dir, { ...state, lastTurnHash: hash, lastRunAt: (deps.now ?? (() => new Date()))().toISOString() });

    const existing = store.active();
    const decision = await decide(
      jev,
      { message, recentContext: previous, existingMemories: existing },
      { thresholds: cfg.thresholds, maxIds: cfg.jev.maxIdsPerCall, timeoutMs: cfg.jev.timeoutMs },
    );
    if (!decision.save) return { event, action: "skipped", detail: decision.reason, decision };

    const result = await writeMemory(store, message, decision, { writer: cfg.writer, env, fetchImpl: deps.fetchImpl });
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
  } finally {
    if (env.JEVMEM_VERBOSE === "1") {
      const s = summarizeLog(jev.log);
      process.stderr.write(`jevmem: ${s.calls} jev call(s), p50 ${s.p50LatencyMs} ms, ${s.totalTokens} tokens, $${s.totalCostUsd.toFixed(6)}\n`);
    }
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
