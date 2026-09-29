import type { Decision } from "./decide.js";
import type { JevCaller } from "./jev.js";
import { callAnthropic, callOpenAI, clampLine, combineRetest, composeDeadEnd, extractFirstSentence, extractWorksNow, joinPicked, resolveWriter, stripFiller, systemPrompt, type WriterConfig } from "./llm/index.js";
import { candidateSentences, pickedTexts, pickSentences, type Pick } from "./pick.js";
import { scrubSecrets } from "./scrub.js";
import type { MemoryStore } from "./store.js";
import type { Kind, Memory } from "./types.js";

export interface WriteOptions {
  writer: WriterConfig & { maxChars: number };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /**
   * Jev, to pick the sentences jevmem's own writer makes the line from (v0.6 part 3c, src/pick.ts). Without it (or when
   * its request fails) the writer chooses one sentence by the words it looks for per kind, as before.
   */
  jev?: JevCaller;
  /** The pick request's budget, in milliseconds (the hook passes `jev.timeoutMs`). */
  jevTimeoutMs?: number;
}

export interface WriteResult {
  saved: Memory;
  superseded: Memory | null;
  writerUsed: "openai" | "anthropic" | "fallback";
  line: string;
  /**
   * Set when the configured LLM writer's line was not used (an error, an empty line), when its request had to change
   * to get one (an endpoint that rejected `reasoning_effort`), or when Jev's pick of the sentences failed. The hook logs
   * it; `jevmem doctor` and `stats` show it.
   */
  writerNote?: string;
  /** The sentences Jev picked for jevmem's own writer, when it was given Jev (absent with an LLM writer's line). */
  pick?: Pick;
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
 * Turn a message into one memory line (max `maxChars`). Uses the configured LLM, else jevmem's own writer: with `jev`,
 * the one or two sentences Jev picks (the one that states the memory, and another that gives its reason when they fit
 * together), else one sentence chosen by the words the writer looks for per kind. `note` says why the LLM writer's line
 * was not used, what its request needed, or why Jev's pick was not; it is absent when all went as configured.
 */
export async function composeLine(message: string, kind: Kind, opts: WriteOptions, extra: { worksNow?: boolean; deadEnd?: string; retestOf?: string; fromReply?: boolean } = {}): Promise<{ line: string; writerUsed: WriteResult["writerUsed"]; note?: string; pick?: Pick }> {
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
  const max = opts.writer.maxChars;
  const worksNow = Boolean(extra.worksNow) && kind !== "dead-end";
  // Which sentences the line is made from: Jev's pick (v0.6 part 3c), asked only here, for a turn that is saved.
  let pick: Pick | undefined;
  let pickWhy: string | undefined;
  if (opts.jev) {
    const sentences = candidateSentences(safe, { fromReply: extra.fromReply });
    try {
      pick = await pickSentences(opts.jev, sentences, kind, { timeoutMs: opts.jevTimeoutMs, worksNow, retest: Boolean(retest) });
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      pick = { asked: false, sentences, chosen: [], main: null, second: null, error };
      pickWhy = `Jev's pick of the line's sentences failed (${error}), so the writer chose one by the words it looks for`;
    }
  }
  const picked = pick?.chosen.length ? pickedTexts(pick) : null;
  const main = pick?.main ? (pick.sentences.find((s) => s.id === pick!.main)?.text ?? "") : "";
  const local = picked
    ? retest
      ? combineRetest(retest, message, max, picked)
      : worksNow
        ? extractWorksNow(message, max, extra.deadEnd, picked)
        : kind === "dead-end"
          ? composeDeadEnd(picked, max)
          : joinPicked(picked, main, max)
    : retest
      ? combineRetest(retest, message, max)
      : worksNow
        ? extractWorksNow(message, max, extra.deadEnd)
        : extractFirstSentence(message, max, kind);
  const note = [why ? `the line was written locally: ${why}` : null, pickWhy].filter(Boolean).join("; ");
  return { line: clampLine(stripFiller(local), max), writerUsed: "fallback", ...(note ? { note: scrubSecrets(note) } : {}), ...(pick ? { pick } : {}) };
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
  // The text is the assistant reply alone when the content came from it (decide's `sourceText`).
  const { line, writerUsed, note, pick } = await composeLine(message, kind, opts, { worksNow: Boolean(worksNow), deadEnd, retestOf, fromReply: decision.source === "assistant_reply" });
  const saved = store.add({ kind, text: line, conf: decision.confidence });
  const superseded = decision.contradiction && decision.touchesMemoryId ? store.supersede(decision.touchesMemoryId, saved.id) : null;
  return { saved, superseded, writerUsed, line, ...(note ? { writerNote: note } : {}), ...(pick ? { pick } : {}) };
}
