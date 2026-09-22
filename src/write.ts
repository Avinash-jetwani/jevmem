import type { Decision } from "./decide.js";
import { callAnthropic, callOpenAI, clampLine, extractFirstSentence, resolveWriter, systemPrompt, type WriterConfig } from "./llm/index.js";
import { scrubSecrets } from "./scrub.js";
import type { MemoryStore } from "./store.js";
import type { Kind, Memory } from "./types.js";

export interface WriteOptions {
  writer: WriterConfig & { maxChars: number };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface WriteResult {
  saved: Memory;
  superseded: Memory | null;
  writerUsed: "openai" | "anthropic" | "fallback";
  line: string;
}

/** Turn a message into one memory line (max `maxChars`). Uses the configured LLM, else the deterministic extract. */
export async function composeLine(message: string, kind: Kind, opts: WriteOptions): Promise<{ line: string; writerUsed: WriteResult["writerUsed"] }> {
  const env = opts.env ?? process.env;
  const w = resolveWriter(opts.writer, env);
  const safe = scrubSecrets(message).slice(0, 8000);
  const user = `Memory kind: ${kind}\n\nMessage:\n${safe}`;
  const system = systemPrompt(opts.writer.maxChars);
  if (w.provider !== "none") {
    try {
      const raw =
        w.provider === "openai"
          ? await callOpenAI({ model: w.model, system, user, timeoutMs: opts.writer.timeoutMs, env, fetchImpl: opts.fetchImpl })
          : await callAnthropic({ model: w.model, system, user, timeoutMs: opts.writer.timeoutMs, env, fetchImpl: opts.fetchImpl });
      const line = clampLine(raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "", opts.writer.maxChars);
      if (line.length >= 3) return { line: scrubSecrets(line), writerUsed: w.provider };
    } catch {
      /* fall through to the deterministic extract */
    }
  }
  return { line: extractFirstSentence(message, opts.writer.maxChars, kind), writerUsed: "fallback" };
}

/**
 * Apply a positive decision: write one line, and on contradiction tag the old memory `[superseded] … → id:new`.
 * Only call this when `decision.save` is true.
 */
export async function writeMemory(store: MemoryStore, message: string, decision: Decision, opts: WriteOptions): Promise<WriteResult> {
  if (!decision.save || decision.kind === "none") throw new Error("writeMemory called with a non-save decision");
  const { line, writerUsed } = await composeLine(message, decision.kind, opts);
  const saved = store.add({ kind: decision.kind, text: line, conf: decision.confidence });
  let superseded: Memory | null = null;
  if (decision.contradiction && decision.touchesMemoryId) {
    superseded = store.supersede(decision.touchesMemoryId, saved.id);
  }
  return { saved, superseded, writerUsed, line };
}
