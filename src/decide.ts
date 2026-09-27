import type { JevCaller } from "./jev.js";
import { combine, defaultWeights, evaluatePolicy, mergeWeights, resolveKind, supersedeTarget, type PolicyInput, type Weights } from "./combine.js";
import { ATOMIC_NOULS, atomicNoulsFor, buildDecideQuestions, buildTier1Questions, TIER1_INJECTION_NOULS, TIER1_KIND_NOULS, tier1Families, tier1NoulsFor, WORKS_NOW_CHOICE, WORKS_NOW_NOUL, type Family } from "./questions.js";
import { scrubSecrets } from "./scrub.js";
import { mergeTurn } from "./transcript.js";
import { DEFAULT_CONFIG, type BorderlineRule, type Importance, type Kind, type Memory, type Thresholds, type TiersConfig } from "./types.js";

export { evaluatePolicy } from "./combine.js";
export { buildDecideQuestions, buildTier1Questions, NOUL_NAMES, ATOMIC_NOULS, TIER1_NOULS } from "./questions.js";
export type { NoulName } from "./questions.js";

export interface DecideInput {
  /**
   * The new turn. Either give `userMessage` (+ optional `assistantReply`), or a merged `message` in the
   * `USER: …\n\nASSISTANT: …` form produced by `mergeTurn`, which is split back into the two parts.
   */
  message?: string;
  userMessage?: string;
  assistantReply?: string;
  /** The previous two turns at most. Jev accuracy drops with irrelevant context, so keep it short. */
  recentContext?: string;
  /** Live memories; used for `touches_memory_id`. Pre-filtered to `maxIds` by keyword overlap when larger. */
  existingMemories: Pick<Memory, "id" | "kind" | "text">[];
}

export interface DecideOptions {
  thresholds?: Partial<Thresholds>;
  weights?: Partial<Record<string, { bias: number; w: Record<string, number> }>>;
  tiers?: Partial<TiersConfig>;
  maxIds?: number;
  timeoutMs?: number;
  /** Max characters of `message` sent to Jev. */
  maxMessageChars?: number;
  maxContextChars?: number;
}

/** What one tier answered, kept for `why` and `fit`. */
export interface TierAnswers {
  tier: 1 | 2;
  nouls: Record<string, number>;
  families: Record<Family, number>;
  kind: string;
  kindProbabilities: Record<string, number>;
  kindConfidence: number;
  importanceScore: number;
  importanceConfidence: number;
  touchesMemoryId: string;
  /** The works-now noul and choice (asked only when the state lists a live dead end), else null. */
  worksNow: WorksNow | null;
  /** The policy outcome using this tier's answers alone. */
  save: boolean;
  reason: string;
  usage: { inputTokens: number; outputTokens: number };
  cacheHit: boolean;
}

/** What Jev answered about the live dead-end lines: does the turn show one now works, and which (docs/dead-ends.md). */
export interface WorksNow {
  noul: number;
  choice: string;
  /** The dead-end line the turn supersedes because it now works (noul at `contradictionMin`, a listed id chosen), or null. */
  id: string | null;
}

export interface Decision {
  save: boolean;
  kind: Kind | "none";
  importance: Importance;
  importanceScore: number;
  /** True when the turn supersedes `touchesMemoryId`. */
  contradiction: boolean;
  /** The line the turn supersedes when `contradiction` is true, else the line Jev said the turn touches (or null). */
  touchesMemoryId: string | null;
  /** The works-now answer, when the state listed a live dead end. */
  worksNow: WorksNow | null;
  /** The nouls of the tier that produced the final answer. */
  nouls: Record<string, number>;
  /** Family scores of the tier that produced the final answer. */
  families: Record<Family, number>;
  /** max over the six kind families; the "is there anything here" score. */
  content: number;
  kindProbabilities: Record<string, number>;
  confidence: number;
  /** Human-readable reason for the save/skip outcome. */
  reason: string;
  /** Total over both tiers. */
  usage: { inputTokens: number; outputTokens: number };
  cacheHit: boolean;
  /** The thresholds that were applied, so `why` can show what was cleared. */
  thresholds: Thresholds;
  /** Where the saved content comes from. `user_message` unless the assistant reply was in the state and Jev said otherwise. */
  source: "user_message" | "assistant_reply" | "both" | "none";
  /** True when the assistant reply was sent to Jev (a question, a reported attempt, or a turn about a live dead end). */
  assistantIncluded: boolean;
  /**
   * The text the writer should condense: the assistant reply when `source` is `assistant_reply`, else the user message.
   * For a dead end with `source` `both`, the whole turn: what was tried is often in the request, why it failed in the reply.
   */
  sourceText: string;
  /** Which tier's answer is final. */
  tier: 1 | 2;
  mode: TiersConfig["mode"];
  escalated: boolean;
  escalationReasons: string[];
  tier1?: TierAnswers;
  tier2?: TierAnswers;
}

const STOPWORDS = new Set(
  "a an the and or but if then else for to of in on at by with from as is are was were be been being it its this that these those we you i they he she our your their not no yes do does did done have has had will would can could should may might must use using used let lets so also just into over under about".split(" "),
);

export function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/** Keep the `max` memories with the most keyword overlap with `message` (ties: most recent last in file wins). */
export function prefilterByOverlap<M extends Pick<Memory, "text">>(message: string, memories: M[], max: number): M[] {
  if (memories.length <= max) return memories;
  const kw = keywords(message);
  const scored = memories.map((m, i) => {
    let overlap = 0;
    for (const w of keywords(m.text)) if (kw.has(w)) overlap++;
    return { m, i, overlap };
  });
  scored.sort((a, b) => b.overlap - a.overlap || b.i - a.i);
  return scored.slice(0, max).map((s) => s.m);
}

export function resolveWeights(patch?: DecideOptions["weights"]): Weights {
  return mergeWeights(defaultWeights(), patch);
}

/** Split a `mergeTurn` string back into its parts. Plain text with no markers is treated as the user message. */
export function splitTurn(message: string): { user: string; assistant: string } {
  const m = /^\s*USER:\s*([\s\S]*?)(?:\n\s*\n\s*ASSISTANT:\s*([\s\S]*))?$/.exec(message);
  if (m) return { user: (m[1] ?? "").trim(), assistant: (m[2] ?? "").trim() };
  const a = /^\s*ASSISTANT:\s*([\s\S]*)$/.exec(message);
  if (a) return { user: "", assistant: (a[1] ?? "").trim() };
  return { user: message.trim(), assistant: "" };
}

const QUESTION_START = /^(why|how|what|where|which|when|who|whose|whom|can|could|would|should|does|do|is|are|did|was|were|will|explain|tell me|help me|show me|any idea|anyone know|find out|investigate|debug|diagnose|look into|check why|figure out)\b/i;

// Bug-report vocabulary. A bare 3-digit number is not enough ("under 500 KB", "port 443"); a 4xx/5xx counts only in an
// HTTP context: "returns 500", "HTTP 404", "status 503", "502 error".
const BUG_REPORT = /\b(fails?|failing|failed|broken|breaks?|crash(es|ed|ing)?|error|exception|flaky|stale|wrong|incorrect|doesn'?t work|not working|isn'?t working|won'?t (start|build|load|compile)|hangs?|timeout|times out|returns? (a |an )?[45]\d\d|(http|status|code|with an?) [45]\d\d|[45]\d\d (error|response|status)|bug|regression|leak|slow)\b|\b[A-Z][a-zA-Z]*Error\b/i;

/**
 * Does the user's message invite an answer from the assistant? Only then is the assistant reply part of the state:
 * a statement from the user is the memory, and the assistant's acknowledgement, options, or summary never is.
 * It is a keyword heuristic, and deliberately broad. True when any of:
 * - the message ends with `?`, or its first line contains one;
 * - it starts with a question or investigation word (why, how, what, do, is, will, can, explain, debug, look into, …);
 * - its first 400 characters contain bug-report vocabulary (error, fails, broken, crash, flaky, stale, wrong, slow,
 *   timeout, bug, regression, leak, a `…Error` name, or an HTTP-context 4xx/5xx such as "returns 500").
 * So "Use Sentry for error reporting." also sends the reply; the content_source question then decides which side
 * the memory comes from, and only bug, architecture and dead-end may come from the assistant.
 */
export function looksLikeQuestion(user: string): boolean {
  const t = user.trim();
  if (!t) return false;
  if (/\?\s*$/.test(t) || /\?/.test(t.split("\n")[0] ?? "")) return true;
  if (QUESTION_START.test(t)) return true;
  return BUG_REPORT.test(t.slice(0, 400));
}

// An attempt and how it ended, in the assistant's words: "I tried …", "reverted", "rolled back", "didn't help".
const ATTEMPT_REPORT = /\b(tried|attempted|reverted|rolled (it |that |this |them )?back|backed (it|that|this|them) out|switched (it |that |them )?back|went back to|gave up on|abandoned|(didn't|did not|doesn't|does not) (work|help)|made no difference|no luck|still (fails|failed|failing))\b/i;

/**
 * Does the assistant reply report an attempt that ended (tried, reverted, rolled back, didn't help)? Then the reply is
 * part of the state even when the user made a statement: a dead end is usually found by the assistant while it works
 * ("Try keepalive" → "I tried keepalive at 10 s; the server answered GOAWAY, so I removed it"). A keyword heuristic, like
 * `looksLikeQuestion`; the content_source question still decides which side a memory comes from.
 */
export function reportsAnAttempt(assistant: string): boolean {
  return ATTEMPT_REPORT.test(assistant);
}

/** Distinct keywords (see `keywords`) a turn and a live dead-end line must share for the turn to be about that dead end. */
export const DEAD_END_TOPIC_MIN = 3;

/**
 * Is the turn (the user message and the reply) about a live dead-end line: at least DEAD_END_TOPIC_MIN keywords in
 * common with one? Then the reply is part of the state, because Claude may have made the dead end work, which only the
 * reply shows ("Make X work" → "X works now: …"). Only live dead ends count, and only the works-now question lets the
 * reply supersede anything, and only a dead-end line (docs/dead-ends.md).
 */
export function aboutADeadEnd(text: string, memories: Pick<Memory, "kind" | "text">[]): boolean {
  const kw = keywords(text);
  return memories.some((m) => {
    if (m.kind !== "dead-end") return false;
    let n = 0;
    for (const w of keywords(m.text)) if (kw.has(w) && ++n >= DEAD_END_TOPIC_MIN) return true;
    return false;
  });
}

/** The borderline rule: which conditions say tier 1 is unsure. Pure, so it is testable and shown by `why`. */
export function borderlineReasons(t1: Pick<TierAnswers, "nouls" | "importanceConfidence"> & { kindConfidence?: number }, rule: BorderlineRule): string[] {
  const reasons: string[] = [];
  // Injection is the max over the tier-1 injection nouls (currently one: the broad noul).
  const inj0 = Math.max(0, ...TIER1_INJECTION_NOULS.map((n) => t1.nouls[n] ?? 0));
  const chat0 = t1.nouls.is_only_chit_chat ?? 0;
  // Tier 1 is sure this turn is skipped; tier 2 could only agree, so don't pay for it.
  if (inj0 > rule.injectionHigh || chat0 >= rule.sureSkipChitChatMin) return [];
  const inBand = (v: number) => v >= rule.kindNoulLow && v <= rule.kindNoulHigh;
  if (rule.kindNoulScope === "any") {
    for (const n of TIER1_KIND_NOULS) {
      const v = t1.nouls[n] ?? 0;
      if (inBand(v)) reasons.push(`${n}=${v.toFixed(2)} in [${rule.kindNoulLow}, ${rule.kindNoulHigh}]`);
    }
  } else {
    let top = TIER1_KIND_NOULS[0]!;
    for (const n of TIER1_KIND_NOULS) if ((t1.nouls[n] ?? 0) > (t1.nouls[top] ?? 0)) top = n;
    const v = t1.nouls[top] ?? 0;
    if (inBand(v)) reasons.push(`max kind noul ${top}=${v.toFixed(2)} in [${rule.kindNoulLow}, ${rule.kindNoulHigh}]`);
  }
  if (t1.kindConfidence !== undefined && t1.kindConfidence < rule.kindConfidenceMin) reasons.push(`kind confidence=${t1.kindConfidence.toFixed(2)} < ${rule.kindConfidenceMin}`);
  const c = t1.nouls.contradicts_existing_memory ?? 0;
  if (c >= rule.contradictionMin) reasons.push(`contradicts_existing_memory=${c.toFixed(2)} ≥ ${rule.contradictionMin}`);
  if (t1.importanceConfidence < rule.importanceConfidenceMin) reasons.push(`importance confidence=${t1.importanceConfidence.toFixed(2)} < ${rule.importanceConfidenceMin}`);
  const inj = inj0;
  if (inj >= rule.injectionLow && inj <= rule.injectionHigh) reasons.push(`injection=${inj.toFixed(2)} in [${rule.injectionLow}, ${rule.injectionHigh}]`);
  return reasons;
}

/** The works-now answer from one tier's response, when it was asked (the state listed a live dead end). */
function worksNowOf(a: any, deadEndIds: ReadonlySet<string>, t: Thresholds): WorksNow | null {
  const n = a[WORKS_NOW_NOUL];
  const c = a[WORKS_NOW_CHOICE];
  if (!n || !c) return null;
  const noul = typeof n.noul === "number" ? n.noul : 0;
  const choice = String(c.choice ?? "none");
  return { noul, choice, id: noul >= t.contradictionMin && deadEndIds.has(choice) ? choice : null };
}

function answersToTier(tier: 1 | 2, res: any, names: readonly string[], families: Record<Family, number>, thresholds: Thresholds, candidates: Pick<Memory, "id" | "kind">[]): TierAnswers & { source: string } {
  const a = res.answers;
  const nouls: Record<string, number> = {};
  for (const n of names) nouls[n] = a[n]?.noul ?? 0;
  const kind = a.kind.choice as string;
  const touches = a.touches_memory_id.choice as string;
  const source = (a.content_source?.choice as string | undefined) ?? "user_message";
  const worksNow = worksNowOf(a, new Set(candidates.filter((m) => m.kind === "dead-end").map((m) => m.id)), thresholds);
  const policy = evaluatePolicy({ kindChoice: kind, importanceScore: a.importance.score, families, touchesMemoryId: touches, touchesKind: candidates.find((m) => m.id === touches)?.kind, source, worksNowId: worksNow?.id ?? undefined }, thresholds);
  return {
    tier,
    nouls,
    families,
    source,
    kind,
    kindProbabilities: { ...a.kind.probabilities },
    kindConfidence: a.kind.confidence,
    importanceScore: a.importance.score,
    importanceConfidence: a.importance.confidence,
    touchesMemoryId: touches,
    worksNow,
    save: policy.save,
    reason: policy.reason,
    usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    cacheHit: Boolean(res.cacheHit),
  };
}

export type DecideState = {
  user_message: string;
  assistant_reply?: string;
  previous_turns: string | null;
  existing_memories: { id: string; kind: string; text: string }[];
};

/**
 * The exact state `decide` sends Jev for a turn. Exported so the benchmark gives other deciders the identical input.
 * The user message is the state; the assistant reply joins it only when `looksLikeQuestion` is true, when the reply
 * reports an attempt (`reportsAnAttempt`), when the turn is about a live dead-end line (`aboutADeadEnd`), or when there
 * is no user text at all, because otherwise the assistant's acknowledgement, options, or summary would be remembered.
 */
export function buildDecideState(input: DecideInput, opts: Pick<DecideOptions, "maxIds" | "maxMessageChars" | "maxContextChars"> = {}) {
  const parts = input.userMessage !== undefined ? { user: input.userMessage, assistant: input.assistantReply ?? "" } : splitTurn(input.message ?? "");
  // Secrets and PII are stripped here, before anything is batched into the state. (createJev scrubs again at the
  // HTTP boundary; doing it here too means a mocked or custom JevCaller never sees a credential either.)
  const userMessage = scrubSecrets(parts.user).slice(0, opts.maxMessageChars ?? 6000);
  // Also included when there is no user text at all (transcript unreadable, only `last_assistant_message`): the
  // content_source choice then decides, and only bug, architecture and dead-end may come from the assistant.
  const assistantIncluded =
    parts.assistant.trim().length > 0 &&
    (looksLikeQuestion(userMessage) || userMessage.trim().length === 0 || reportsAnAttempt(parts.assistant) || aboutADeadEnd(`${userMessage} ${scrubSecrets(parts.assistant).slice(0, 2000)}`, input.existingMemories));
  const assistantReply = assistantIncluded ? scrubSecrets(parts.assistant).slice(0, 2000) : "";
  const recent = scrubSecrets(input.recentContext ?? "").slice(-(opts.maxContextChars ?? 1500));
  const candidates = prefilterByOverlap(userMessage + " " + assistantReply, input.existingMemories, opts.maxIds ?? DEFAULT_CONFIG.jev.maxIdsPerCall).map((m) => ({ ...m, text: scrubSecrets(m.text) }));
  const state: DecideState = {
    user_message: userMessage,
    ...(assistantIncluded ? { assistant_reply: assistantReply } : {}),
    previous_turns: recent || null,
    existing_memories: candidates.map((m) => ({ id: m.id, kind: m.kind, text: m.text })),
  };
  return { state, parts, assistantIncluded, candidates };
}

/**
 * Two-tier decide. Tier 1 (10 broad nouls) runs every turn; tier 2 (31 atomic nouls) runs only when the
 * borderline rule says tier 1 is unsure. `tiers.mode` forces `fast` (tier 1 only) or `full` (always tier 2).
 */
export async function decide(jev: JevCaller, input: DecideInput, opts: DecideOptions = {}): Promise<Decision> {
  const thresholds: Thresholds = { ...DEFAULT_CONFIG.thresholds, ...opts.thresholds };
  const tiers: TiersConfig = { ...DEFAULT_CONFIG.tiers, ...opts.tiers, borderline: { ...DEFAULT_CONFIG.tiers.borderline, ...opts.tiers?.borderline } };
  const tier1Thresholds: Thresholds = { ...thresholds, ...tiers.tier1Thresholds };
  const weights = resolveWeights(opts.weights);
  const maxIds = opts.maxIds ?? DEFAULT_CONFIG.jev.maxIdsPerCall;
  const { state, parts, assistantIncluded, candidates } = buildDecideState(input, { ...opts, maxIds });
  const tier1Names = tier1NoulsFor(assistantIncluded).map((n) => n.name);
  const tier2Names = atomicNoulsFor(assistantIncluded).map((n) => n.name);

  let tier1: (TierAnswers & { source: string }) | undefined;
  let tier2: (TierAnswers & { source: string }) | undefined;
  let escalationReasons: string[] = [];

  if (tiers.mode !== "full") {
    const res = await jev.call(state, buildTier1Questions(candidates, { withAssistant: assistantIncluded }), { label: "decide", tier: 1, timeoutMs: opts.timeoutMs });
    const nouls: Record<string, number> = {};
    for (const n of tier1Names) nouls[n] = (res.answers as any)[n]?.noul ?? 0;
    tier1 = answersToTier(1, res, tier1Names, tier1Families(nouls), tier1Thresholds, candidates);
    if (tiers.mode === "auto") escalationReasons = borderlineReasons(tier1, tiers.borderline);
  }
  if (tiers.mode === "full" || escalationReasons.length > 0) {
    const res = await jev.call(state, buildDecideQuestions(candidates, { examplesPerSide: tiers.tier2ExamplesPerSide, withAssistant: assistantIncluded }), { label: "decide", tier: 2, timeoutMs: opts.timeoutMs });
    const nouls: Record<string, number> = {};
    for (const n of tier2Names) nouls[n] = (res.answers as any)[n]?.noul ?? 0;
    tier2 = answersToTier(2, res, tier2Names, combine(nouls, weights), thresholds, candidates);
  }

  const final = tier2 ?? tier1!;
  const t = final.tier === 2 ? thresholds : tier1Thresholds;
  const source = (assistantIncluded ? final.source : "user_message") as Decision["source"];
  const worksNowId = final.worksNow?.id ?? undefined;
  const policyIn: PolicyInput = { kindChoice: final.kind, importanceScore: final.importanceScore, families: final.families, touchesMemoryId: final.touchesMemoryId, touchesKind: candidates.find((m) => m.id === final.touchesMemoryId)?.kind, source, worksNowId };
  const { kind, note } = resolveKind(final.kind, final.kindProbabilities, final.families, supersedeTarget(policyIn, t) !== null, t, Boolean(worksNowId));
  const policy = evaluatePolicy({ ...policyIn, kindChoice: kind }, t);
  const usage = { inputTokens: (tier1?.usage.inputTokens ?? 0) + (tier2?.usage.inputTokens ?? 0), outputTokens: (tier1?.usage.outputTokens ?? 0) + (tier2?.usage.outputTokens ?? 0) };
  return {
    save: policy.save,
    kind: kind as Kind | "none",
    importance: policy.importance,
    importanceScore: final.importanceScore,
    contradiction: policy.contradiction,
    touchesMemoryId: policy.supersedes ?? (final.touchesMemoryId === "none" ? null : final.touchesMemoryId),
    worksNow: final.worksNow,
    nouls: final.nouls,
    families: final.families,
    content: policy.content,
    kindProbabilities: final.kindProbabilities,
    confidence: final.kindConfidence,
    reason: `${policy.reason}${note} [tier ${final.tier}${tier2 && tier1 ? ", escalated" : ""}]`,
    usage,
    cacheHit: Boolean(tier1?.cacheHit || tier2?.cacheHit) && !(tier1 && !tier1.cacheHit) && !(tier2 && !tier2.cacheHit),
    thresholds: t,
    source,
    assistantIncluded,
    // A dead end or a dead end that now works, from both sides: the whole turn (what was asked is often in the request,
    // what happened in the reply).
    sourceText: source === "assistant_reply" ? parts.assistant.trim() : (kind === "dead-end" || worksNowId) && source === "both" ? mergeTurn(parts.user, parts.assistant) : parts.user.trim(),
    tier: final.tier,
    mode: tiers.mode,
    escalated: Boolean(tier1 && tier2),
    escalationReasons,
    tier1,
    tier2,
  };
}

export const FAMILY_OF: Record<string, Family> = Object.fromEntries(ATOMIC_NOULS.map((n) => [n.name, n.family]));
