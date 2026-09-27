import { ASSISTANT_KINDS, runnerUpKind } from "./combine.js";
import type { Decision } from "./decide.js";
import { callAnthropic, callOpenAI, clampLine, deadEndHasReason, extractFirstSentence, resolveWriter, stripFiller, systemPrompt, type WriterConfig } from "./llm/index.js";
import { scrubSecrets } from "./scrub.js";
import type { MemoryStore } from "./store.js";
import type { Kind, Memory } from "./types.js";

export interface WriteOptions {
  writer: WriterConfig & { maxChars: number };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface WriteResult {
  /** Null when nothing was written: a dead-end line that gives no reason (`refused` says so). */
  saved: Memory | null;
  superseded: Memory | null;
  writerUsed: "openai" | "anthropic" | "fallback";
  line: string;
  refused?: string;
  /** Set when a dead end with no reason was saved as another kind because it reverses a listed line. */
  rekinded?: { from: Kind; to: Kind; why: string };
}

/** Added to the LLM writer's input for a dead end (the system prompt is the same for every kind). */
export const DEAD_END_WRITER_NOTE =
  "an approach that was tried and failed or was dropped: say what was tried and why it failed or was dropped; the reason is the point of the line, never leave it out; if another approach then worked, name it at the end when it fits; state it as a past fact, not as an instruction, and don't start with 'Tried'";

/** Why a dead-end line is not saved as one (docs/dead-ends.md). */
export const DEAD_END_NO_REASON = "a dead end must say why it failed or was dropped, and this line gives no reason";

/** Turn a message into one memory line (max `maxChars`). Uses the configured LLM, else the deterministic extract. */
export async function composeLine(message: string, kind: Kind, opts: WriteOptions): Promise<{ line: string; writerUsed: WriteResult["writerUsed"] }> {
  const env = opts.env ?? process.env;
  const w = resolveWriter(opts.writer, env);
  const safe = scrubSecrets(message).slice(0, 8000);
  const user = `Memory kind: ${kind}${kind === "dead-end" ? ` (${DEAD_END_WRITER_NOTE})` : ""}\n\nMessage:\n${safe}`;
  const system = systemPrompt(opts.writer.maxChars);
  if (w.provider !== "none") {
    try {
      const raw =
        w.provider === "openai"
          ? await callOpenAI({ model: w.model, system, user, timeoutMs: opts.writer.timeoutMs, env, fetchImpl: opts.fetchImpl })
          : await callAnthropic({ model: w.model, system, user, timeoutMs: opts.writer.timeoutMs, env, fetchImpl: opts.fetchImpl });
      const line = clampLine(stripFiller(raw.split("\n").map((l) => l.trim()).find(Boolean) ?? ""), opts.writer.maxChars);
      // A dead-end line without its reason falls back to the local extract, which keeps the reason sentence.
      if (line.length >= 3 && (kind !== "dead-end" || deadEndHasReason(line))) return { line: scrubSecrets(line), writerUsed: w.provider };
    } catch {
      /* fall through to the deterministic extract */
    }
  }
  return { line: clampLine(stripFiller(extractFirstSentence(message, opts.writer.maxChars, kind)), opts.writer.maxChars), writerUsed: "fallback" };
}

/**
 * Apply a positive decision: write one line, and on contradiction tag the old memory `[superseded] … → id:new`.
 * Only call this when `decision.save` is true. A dead-end line that gives no reason is not saved as a dead end: it is
 * not written (`saved` is null), unless the turn reverses a listed line, which must not be lost (the old line would stay
 * live): then it is saved as Jev's next most likely kind (`rekinded`).
 */
export async function writeMemory(store: MemoryStore, message: string, decision: Decision, opts: WriteOptions): Promise<WriteResult> {
  if (!decision.save || decision.kind === "none") throw new Error("writeMemory called with a non-save decision");
  let kind: Kind = decision.kind;
  let { line, writerUsed } = await composeLine(message, kind, opts);
  let rekinded: WriteResult["rekinded"];
  if (kind === "dead-end" && !deadEndHasReason(line)) {
    const alt = runnerUpKind(decision.kindProbabilities) as Kind;
    const allowed = decision.source !== "assistant_reply" || ASSISTANT_KINDS.has(alt);
    if (!(decision.contradiction && decision.touchesMemoryId && allowed)) return { saved: null, superseded: null, writerUsed, line, refused: DEAD_END_NO_REASON };
    kind = alt;
    ({ line, writerUsed } = await composeLine(message, kind, opts));
    rekinded = { from: "dead-end", to: kind, why: DEAD_END_NO_REASON };
  }
  const saved = store.add({ kind, text: line, conf: decision.confidence });
  let superseded: Memory | null = null;
  if (decision.contradiction && decision.touchesMemoryId) {
    superseded = store.supersede(decision.touchesMemoryId, saved.id);
  }
  return { saved, superseded, writerUsed, line, ...(rekinded ? { rekinded } : {}) };
}
