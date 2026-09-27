import type { Decision } from "./decide.js";
import { callAnthropic, callOpenAI, clampLine, combineRetest, extractFirstSentence, extractWorksNow, resolveWriter, stripFiller, systemPrompt, type WriterConfig } from "./llm/index.js";
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
  /**
   * Set when the configured LLM writer's line was not used (an error, an empty line), or when its request had to change
   * to get one (an endpoint that rejected `reasoning_effort`). The hook logs it; `jevmem doctor` and `stats` show it.
   */
  writerNote?: string;
}

/** Added to the LLM writer's input for a dead end (the system prompt is the same for every kind). */
export const DEAD_END_WRITER_NOTE =
  "an approach that was tried and failed or was dropped: say what was tried and why it failed or was dropped; the reason is the point of the line, never leave it out; if another approach then worked, name it at the end when it fits; state it as a past fact, not as an instruction, and don't start with 'Tried'";

/** Added to the LLM writer's input for a turn that makes a listed dead end work (docs/dead-ends.md). */
export const WORKS_NOW_WRITER_NOTE =
  "an approach that had failed before works now: say what works now and what was changed to make it work; state it as a fact about the project";

/** Added to the LLM writer's input for a listed dead end tried again that failed for a new reason (docs/dead-ends.md). */
export const RETEST_WRITER_NOTE =
  "an approach that had failed before was tried again and failed for a new reason: one line that says what was tried, the earlier reason (from the earlier line) and the new one; state it as a past fact, not as an instruction";

/** Why a dead-end line is not saved as one (docs/dead-ends.md). Jev decides whether a line says why, not a word list. */
export const DEAD_END_NO_REASON = "a dead end must say why it failed or was dropped, and Jev found no reason in this line";

/**
 * Turn a message into one memory line (max `maxChars`). Uses the configured LLM, else the local writer. `note` says why
 * the LLM writer's line was not used, or what its request needed; it is absent when no LLM writer is configured.
 */
export async function composeLine(message: string, kind: Kind, opts: WriteOptions, extra: { worksNow?: boolean; deadEnd?: string; retestOf?: string } = {}): Promise<{ line: string; writerUsed: WriteResult["writerUsed"]; note?: string }> {
  const env = opts.env ?? process.env;
  const w = resolveWriter(opts.writer, env);
  const safe = scrubSecrets(message).slice(0, 8000);
  const retest = kind === "dead-end" && extra.retestOf ? scrubSecrets(extra.retestOf) : null;
  const kindNote = retest ? RETEST_WRITER_NOTE : kind === "dead-end" ? DEAD_END_WRITER_NOTE : extra.worksNow ? WORKS_NOW_WRITER_NOTE : null;
  const user = `Memory kind: ${kind}${kindNote ? ` (${kindNote})` : ""}${retest ? `\n\nEarlier line: ${retest}` : ""}\n\nMessage:\n${safe}`;
  const system = systemPrompt(opts.writer.maxChars);
  let why: string | undefined;
  if (w.provider !== "none") {
    try {
      const reply =
        w.provider === "openai"
          ? await callOpenAI({ model: w.model, system, user, timeoutMs: opts.writer.timeoutMs, env, fetchImpl: opts.fetchImpl })
          : { text: await callAnthropic({ model: w.model, system, user, timeoutMs: opts.writer.timeoutMs, env, fetchImpl: opts.fetchImpl }) };
      const line = clampLine(stripFiller(reply.text.split("\n").map((l) => l.trim()).find(Boolean) ?? ""), opts.writer.maxChars);
      const changed = "note" in reply ? reply.note : undefined;
      if (line.length >= 3) return { line: scrubSecrets(line), writerUsed: w.provider, ...(changed ? { note: scrubSecrets(changed) } : {}) };
      why = [changed, ("empty" in reply && reply.empty) || `${w.provider} (${w.model}) returned an empty line`].filter(Boolean).join("; ");
    } catch (err) {
      why = `${w.provider} (${w.model}) failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const local = retest ? combineRetest(retest, message, opts.writer.maxChars) : extra.worksNow && kind !== "dead-end" ? extractWorksNow(message, opts.writer.maxChars, extra.deadEnd) : extractFirstSentence(message, opts.writer.maxChars, kind);
  return { line: clampLine(stripFiller(local), opts.writer.maxChars), writerUsed: "fallback", ...(why ? { note: scrubSecrets(`the line was written locally: ${why}`) } : {}) };
}

/**
 * Apply a positive decision: write one line, and when the turn supersedes a line, tag the old memory
 * `[superseded] … → id:new`. Only call this when `decision.save` is true. Whether a dead end says why is decided by Jev
 * in `decide` (the dead-end noul), so the line is not checked again here.
 */
export async function writeMemory(store: MemoryStore, message: string, decision: Decision, opts: WriteOptions): Promise<WriteResult> {
  if (!decision.save || decision.kind === "none") throw new Error("writeMemory called with a non-save decision");
  const kind: Kind = decision.kind;
  const worksNow = decision.worksNow?.id ?? null;
  const deadEnd = worksNow ? store.list().find((m) => m.id === worksNow)?.text : undefined;
  // A listed dead end tried again that failed for a new reason: the new line carries the earlier reason too.
  const retestId = kind === "dead-end" && decision.contradiction && decision.retest?.id && !decision.retest.same && decision.touchesMemoryId === decision.retest.id ? decision.retest.id : null;
  const retestOf = retestId ? store.list().find((m) => m.id === retestId)?.text : undefined;
  const { line, writerUsed, note } = await composeLine(message, kind, opts, { worksNow: Boolean(worksNow), deadEnd, retestOf });
  const saved = store.add({ kind, text: line, conf: decision.confidence });
  const superseded = decision.contradiction && decision.touchesMemoryId ? store.supersede(decision.touchesMemoryId, saved.id) : null;
  return { saved, superseded, writerUsed, line, ...(note ? { writerNote: note } : {}) };
}
