/**
 * Which sentences a saved line is made from (v0.6 part 3c). jevmem's own writer used to keep one sentence of the turn,
 * chosen by words it looked for per kind, so a hand-off to a subagent ("… and fix it") could win over the sentence that
 * described the bug, and a reason in a sentence of its own was dropped. Now, on a turn decide saves, Jev is asked
 * which sentence states the memory and which other sentence gives its reason, in one request; the line is those one or
 * two sentences, as written (src/write.ts). Skipped turns ask nothing.
 */
import { choice, type ChoiceCriteria, type EntryType, type Questions } from "@typesafe-ai/sdk";
import type { JevCaller } from "./jev.js";
import { REPORT_LABEL } from "./llm/index.js";
import { scrubSecrets } from "./scrub.js";

export interface Sentence {
  id: string;
  text: string;
  /** Which side of the turn it is from; only a text with both sides (a dead end from both) has assistant sentences. */
  from: "user" | "assistant";
}

/** What Jev picked, for the line and for `jevmem why`. */
export interface Pick {
  /** False when there was nothing to ask (one sentence) or the request failed. */
  asked: boolean;
  sentences: Sentence[];
  /** The ids the line is made from, in text order. */
  chosen: string[];
  /** The sentence that states the memory. */
  main: string | null;
  /** The sentence that gives its reason, when Jev named one (it is left out of `chosen` when the two do not fit). */
  second: string | null;
  /** Jev's first answer to the reason question was the main sentence itself: that sentence holds its own reason. */
  ownReason?: boolean;
  /** The request failed or ran past its budget: the line was written without Jev's pick. */
  error?: string;
}

/** What a line of each kind states, and what its reason is, as the pick's two questions name them. */
const SUBJECT: Record<string, { it: string; why: string }> = {
  decision: { it: "the decision made for the project", why: "why it was chosen" },
  constraint: { it: "the rule or limit the project must keep", why: "why the rule exists or what goes wrong without it" },
  preference: { it: "how the user wants things done", why: "why the user wants it that way" },
  bug: { it: "the bug (what goes wrong, or what causes it)", why: "what causes it, or how it was fixed" },
  architecture: { it: "how the system is built or where something lives", why: "why it is built that way" },
  todo: { it: "the work left for later", why: "why it waits, or what it waits for" },
  // A dead end's line is what was tried, then why it failed: asked for the failed approach itself, Jev picks the sentence
  // that says it failed and why, and the one that names the approach goes (eval/lines-dev.jsonl).
  "dead-end": { it: "what was tried: the approach itself (what was built, run or changed), not how it turned out", why: "why it failed or was dropped" },
};
/** A turn that makes a listed dead end work, and a listed dead end tried again that failed for a new reason. */
const WORKS_NOW = { it: "what works now that had failed before", why: "what was changed to make it work" };
// A retest's line is the earlier line, then "retried:" and the new reason (src/llm/index.ts, combineRetest): what matters
// is the new reason, so that is what is asked first; what was tried again is already in the earlier line.
const RETEST = { it: "why the approach failed this time: the new reason", why: "what was tried again" };

/**
 * When Jev's first answer to the reason question is the main sentence itself, another sentence counts as the reason only
 * at this probability or more. Below it the runner-up is what is left over, not an answer: on the 0.6.5 gate's replies
 * (a verdict sentence, then the sentence with the attempt and its cause; eval/cause-last-dev.jsonl) the main sentence
 * got 0.88 and the verdict before it 0.06, level with the answer for no sentence, and taking the verdict as the reason
 * used up the line before the cause.
 */
export const OTHER_REASON_MIN = 0.2;

/** Most sentences sent in one request (the text a hook passes is capped where decide caps it: 6,000 and 2,000 characters). */
export const MAX_SENTENCES = 60;
const MAX_USER_CHARS = 6000;
const MAX_REPLY_CHARS = 2000;

/**
 * Lines of a reply that are never the memory (0.6.6, from the real replies of eval/attempts-dev.jsonl): a table row, a
 * heading on its own ("## Cause", "What happened.", "Why."), and the lines Claude writes before and between its tool
 * calls that say what it is about to do ("I'll open that file next", "Now let me time both"): a plan, not what was
 * tried nor why it failed. Jev picked such a line as the attempt in 6 of 49 dead ends. A short real sentence inside
 * a longer line stays ("It leaked."), as does one typed by the user ("Use pnpm.").
 */
const TABLE_ROW = /^\s*\|/;
const HEADING = /^\s*#{1,6}\s/;
const PLAN_LINE = /^(?:(?:ok(?:ay)?|right|good|now|next|first|then|so)[,:]?\s+)*(?:i(?:'ll| will|'m going to| am going to|'m about to| need to| want to| should)|let me|let's|we'll|we will|time to|going to)\b/i;

/** Sentence ends: before an upper- or lowercase word (typed quickly), not after e.g., i.e., vs., etc., approx. */
const SENTENCE_END = /(?<=[.!?])(?<!\b(?:e\.g|i\.e|vs|etc|approx|cf)\.)\s+(?=[A-Za-z0-9"'(`[])/i;

/**
 * The sentences of a writer's input, in order: a merged turn (`USER: … ASSISTANT: …`) is split back into its sides, code
 * blocks go, every line of a list or a heading is its own sentence without its bullet, number or `#`, and bold markers
 * go. Each side is cut where decide cuts it, so Jev picks from the text decide judged: plain text is the user message,
 * or with `fromReply` the assistant reply (a line whose content came from the reply alone). Fragments without letters go.
 */
export function candidateSentences(text: string, opts: { fromReply?: boolean } = {}): Sentence[] {
  const clean = scrubSecrets(text).replace(/```[\s\S]*?```/g, "\n");
  const sides: { from: Sentence["from"]; text: string }[] = [];
  for (const chunk of clean.split(/(?=^|\n)\s*(?=(?:USER|ASSISTANT):)/)) {
    const m = /^\s*(USER|ASSISTANT):\s*([\s\S]*)$/.exec(chunk);
    if (m) sides.push({ from: m[1] === "USER" ? "user" : "assistant", text: m[2]! });
    else if (chunk.trim()) sides.push({ from: opts.fromReply ? "assistant" : "user", text: chunk });
  }
  const out: Sentence[] = [];
  for (const side of sides) {
    const body = side.text.slice(0, side.from === "user" ? MAX_USER_CHARS : MAX_REPLY_CHARS);
    for (const raw of body.split(/\n+/)) {
      if (TABLE_ROW.test(raw) || HEADING.test(raw)) continue;
      const line = raw
        .replace(/^\s*(?:>\s*|(?:[-*•+]|\d+[.)])\s+)+/, "")
        .replace(/\*\*|__/g, "")
        .trim()
        .replace(REPORT_LABEL, "");
      if (!line) continue;
      // A heading written as a line of its own, in bold or plain ("What happened.", "Why:"): two words at most.
      if (side.from === "assistant" && line.split(/\s+/).length <= 2 && /[.:]$/.test(line)) continue;
      for (const s of line.split(SENTENCE_END)) {
        const t = s.trim().replace(REPORT_LABEL, "");
        if (!/[A-Za-z]/.test(t) || t.length < 3) continue;
        if (side.from === "assistant" && PLAN_LINE.test(t)) continue;
        out.push({ id: `s${out.length + 1}`, text: t, from: side.from });
        if (out.length >= MAX_SENTENCES) return out;
      }
    }
  }
  return out;
}

/** The pick's request: the kind, what it states, and the sentences with bare ids; two choices over those ids. */
export function pickRequest(sentences: Sentence[], kind: string, mode: { worksNow?: boolean; retest?: boolean } = {}): { state: EntryType; questions: Questions } {
  const subject = mode.retest ? RETEST : mode.worksNow ? WORKS_NOW : (SUBJECT[kind] ?? SUBJECT.decision!);
  const bothSides = sentences.some((s) => s.from === "assistant") && sentences.some((s) => s.from === "user");
  const ids: ChoiceCriteria = {};
  for (const s of sentences) ids[s.id] = null;
  const state: EntryType = {
    memory: { kind, states: subject.it },
    sentences: sentences.map((s): Record<string, string> => (bothSides ? { id: s.id, from: s.from === "user" ? "user message" : "assistant reply", text: s.text } : { id: s.id, text: s.text })),
  };
  const questions: Questions = {
    states_the_memory: choice(`Which sentence states ${subject.it}, as a fact a later session on this project needs to know, not as a request, a hand-off or an instruction to the assistant?`, ids),
    gives_the_reason: choice(`Which other sentence says ${subject.why}? A request, a hand-off or an instruction to the assistant never does.`, { ...ids, none: "No other sentence says it." }),
  };
  return { state, questions };
}

/**
 * Ask Jev which sentences a saved line of this kind is made from: the one that states it, and another that gives its
 * reason (or none). One request, only when there are two sentences or more. Throws when the request fails, so the
 * caller can write the line without it.
 */
export async function pickSentences(jev: JevCaller, sentences: Sentence[], kind: string, opts: { timeoutMs?: number; worksNow?: boolean; retest?: boolean } = {}): Promise<Pick> {
  if (sentences.length <= 1) return { asked: false, sentences, chosen: sentences.map((s) => s.id), main: sentences[0]?.id ?? null, second: null };
  const { state, questions } = pickRequest(sentences, kind, opts);
  const res = await jev.call(state, questions, { label: "line", timeoutMs: opts.timeoutMs });
  const a = res.answers as Record<string, { choice?: string; probabilities?: Record<string, number> }>;
  const known = new Set(sentences.map((s) => s.id));
  const main = known.has(String(a.states_the_memory?.choice)) ? String(a.states_the_memory!.choice) : sentences[0]!.id;
  // The reason: the most likely answer other than the main sentence itself (Jev may put the main one first when it holds
  // its own reason), and none when none is more likely than every other sentence. When the main sentence is Jev's first
  // answer, the runner-up also needs OTHER_REASON_MIN: what is left of the probability is not an answer.
  const probs = a.gives_the_reason?.probabilities ?? {};
  const all = Object.entries(probs).filter(([id]) => id === "none" || known.has(id)).sort((x, y) => y[1] - x[1]);
  const ownReason = (all[0]?.[0] ?? String(a.gives_the_reason?.choice ?? "none")) === main;
  const ranked = all.filter(([id]) => id !== main);
  const top = ranked[0]?.[0] ?? String(a.gives_the_reason?.choice ?? "none");
  const second = top !== "none" && top !== main && known.has(top) && (!ownReason || (probs[top] ?? 0) >= OTHER_REASON_MIN) ? top : null;
  const order = (ids: string[]) => sentences.filter((s) => ids.includes(s.id)).map((s) => s.id);
  return { asked: true, sentences, chosen: order(second ? [main, second] : [main]), main, second, ...(ownReason ? { ownReason } : {}) };
}

/** The chosen sentences' texts, in text order, each but the last ending in a full stop when it had no end mark. */
export function pickedTexts(pick: Pick): string[] {
  const texts = pick.sentences.filter((s) => pick.chosen.includes(s.id)).map((s) => s.text);
  return texts.map((t, i) => (i < texts.length - 1 && !/[.!?:;]$/.test(t) ? `${t}.` : t));
}

/** A pick as `.jevmem/decisions.jsonl` keeps it: the chosen ids, out of how many sentences, and why Jev was not used. */
export interface PickRecord {
  asked: boolean;
  chosen: string[];
  of: number;
  error?: string;
}

export function pickRecord(pick: Pick): PickRecord {
  return { asked: pick.asked, chosen: pick.chosen, of: pick.sentences.length, ...(pick.error ? { error: pick.error } : {}) };
}

/** One phrase for the hook's outcome and `jevmem why`: which sentences the line is made from, and who chose them. */
export function describePick(p: PickRecord): string {
  if (p.error) return `Jev's pick failed (${p.error}): one sentence chosen by the words the writer looks for`;
  if (!p.asked) return p.of === 1 ? "the text's one sentence" : "chosen by the words the writer looks for";
  return `${p.chosen.length === 1 ? "sentence" : "sentences"} ${p.chosen.join("+")} of ${p.of}, picked by Jev`;
}
