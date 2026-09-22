import type { JevCaller } from "./jev.js";
import { combine, defaultWeights, evaluatePolicy, mergeWeights, type Weights } from "./combine.js";
import { ATOMIC_NOULS, buildDecideQuestions, buildTier1Questions, NOUL_NAMES, TIER1_KIND_NOULS, TIER1_NOUL_NAMES, tier1Families, type Family } from "./questions.js";
import { scrubSecrets } from "./scrub.js";
import { DEFAULT_CONFIG, type BorderlineRule, type Importance, type Kind, type Memory, type Thresholds, type TiersConfig } from "./types.js";

export { evaluatePolicy } from "./combine.js";
export { buildDecideQuestions, buildTier1Questions, NOUL_NAMES, ATOMIC_NOULS, TIER1_NOULS } from "./questions.js";
export type { NoulName } from "./questions.js";

export interface DecideInput {
  /** The new turn to evaluate (user prompt and/or assistant reply, already merged into one string). */
  message: string;
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
  /** The policy outcome using this tier's answers alone. */
  save: boolean;
  reason: string;
  usage: { inputTokens: number; outputTokens: number };
  cacheHit: boolean;
}

export interface Decision {
  save: boolean;
  kind: Kind | "none";
  importance: Importance;
  importanceScore: number;
  contradiction: boolean;
  touchesMemoryId: string | null;
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

/** The borderline rule: which conditions say tier 1 is unsure. Pure, so it is testable and shown by `why`. */
export function borderlineReasons(t1: Pick<TierAnswers, "nouls" | "importanceConfidence"> & { kindConfidence?: number }, rule: BorderlineRule): string[] {
  const reasons: string[] = [];
  const inj0 = t1.nouls.contains_instructions_aimed_at_an_automated_system ?? 0;
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
  const inj = t1.nouls.contains_instructions_aimed_at_an_automated_system ?? 0;
  if (inj >= rule.injectionLow && inj <= rule.injectionHigh) reasons.push(`injection=${inj.toFixed(2)} in [${rule.injectionLow}, ${rule.injectionHigh}]`);
  return reasons;
}

function answersToTier(tier: 1 | 2, res: any, names: readonly string[], families: Record<Family, number>, thresholds: Thresholds): TierAnswers {
  const a = res.answers;
  const nouls: Record<string, number> = {};
  for (const n of names) nouls[n] = a[n]?.noul ?? 0;
  const kind = a.kind.choice as string;
  const touches = a.touches_memory_id.choice as string;
  const policy = evaluatePolicy({ kindChoice: kind, importanceScore: a.importance.score, families, touchesMemoryId: touches }, thresholds);
  return {
    tier,
    nouls,
    families,
    kind,
    kindProbabilities: { ...a.kind.probabilities },
    kindConfidence: a.kind.confidence,
    importanceScore: a.importance.score,
    importanceConfidence: a.importance.confidence,
    touchesMemoryId: touches,
    save: policy.save,
    reason: policy.reason,
    usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    cacheHit: Boolean(res.cacheHit),
  };
}

/**
 * Two-tier decide. Tier 1 (9 broad nouls, ~1.5k tokens) runs every turn; tier 2 (30 atomic nouls) runs only when the
 * borderline rule says tier 1 is unsure. `tiers.mode` forces `fast` (tier 1 only) or `full` (always tier 2).
 */
export async function decide(jev: JevCaller, input: DecideInput, opts: DecideOptions = {}): Promise<Decision> {
  const thresholds: Thresholds = { ...DEFAULT_CONFIG.thresholds, ...opts.thresholds };
  const tiers: TiersConfig = { ...DEFAULT_CONFIG.tiers, ...opts.tiers, borderline: { ...DEFAULT_CONFIG.tiers.borderline, ...opts.tiers?.borderline } };
  const tier1Thresholds: Thresholds = { ...thresholds, ...tiers.tier1Thresholds };
  const weights = resolveWeights(opts.weights);
  const maxIds = opts.maxIds ?? DEFAULT_CONFIG.jev.maxIdsPerCall;
  // Secrets and PII are stripped here, before anything is batched into the state. (createJev scrubs again at the
  // HTTP boundary; doing it here too means a mocked or custom JevCaller never sees a credential either.)
  const message = scrubSecrets(input.message).slice(0, opts.maxMessageChars ?? 6000);
  const recent = scrubSecrets(input.recentContext ?? "").slice(-(opts.maxContextChars ?? 1500));
  const candidates = prefilterByOverlap(message, input.existingMemories, maxIds).map((m) => ({ ...m, text: scrubSecrets(m.text) }));
  const state = {
    message,
    previous_turns: recent || null,
    existing_memories: candidates.map((m) => ({ id: m.id, kind: m.kind, text: m.text })),
  };

  let tier1: TierAnswers | undefined;
  let tier2: TierAnswers | undefined;
  let escalationReasons: string[] = [];

  if (tiers.mode !== "full") {
    const res = await jev.call(state, buildTier1Questions(candidates), { label: "decide", tier: 1, timeoutMs: opts.timeoutMs });
    const nouls: Record<string, number> = {};
    for (const n of TIER1_NOUL_NAMES) nouls[n] = (res.answers as any)[n]?.noul ?? 0;
    tier1 = answersToTier(1, res, TIER1_NOUL_NAMES, tier1Families(nouls), tier1Thresholds);
    if (tiers.mode === "auto") escalationReasons = borderlineReasons(tier1, tiers.borderline);
  }
  if (tiers.mode === "full" || escalationReasons.length > 0) {
    const res = await jev.call(state, buildDecideQuestions(candidates, { examplesPerSide: tiers.tier2ExamplesPerSide }), { label: "decide", tier: 2, timeoutMs: opts.timeoutMs });
    const nouls: Record<string, number> = {};
    for (const n of NOUL_NAMES) nouls[n] = (res.answers as any)[n]?.noul ?? 0;
    tier2 = answersToTier(2, res, NOUL_NAMES, combine(nouls, weights), thresholds);
  }

  const final = tier2 ?? tier1!;
  const t = final.tier === 2 ? thresholds : tier1Thresholds;
  const policy = evaluatePolicy({ kindChoice: final.kind, importanceScore: final.importanceScore, families: final.families, touchesMemoryId: final.touchesMemoryId }, t);
  const usage = { inputTokens: (tier1?.usage.inputTokens ?? 0) + (tier2?.usage.inputTokens ?? 0), outputTokens: (tier1?.usage.outputTokens ?? 0) + (tier2?.usage.outputTokens ?? 0) };
  return {
    save: policy.save,
    kind: final.kind as Kind | "none",
    importance: policy.importance,
    importanceScore: final.importanceScore,
    contradiction: policy.contradiction,
    touchesMemoryId: final.touchesMemoryId === "none" ? null : final.touchesMemoryId,
    nouls: final.nouls,
    families: final.families,
    content: policy.content,
    kindProbabilities: final.kindProbabilities,
    confidence: final.kindConfidence,
    reason: `${policy.reason} [tier ${final.tier}${tier2 && tier1 ? ", escalated" : ""}]`,
    usage,
    cacheHit: Boolean(tier1?.cacheHit || tier2?.cacheHit) && !(tier1 && !tier1.cacheHit) && !(tier2 && !tier2.cacheHit),
    thresholds: t,
    tier: final.tier,
    mode: tiers.mode,
    escalated: Boolean(tier1 && tier2),
    escalationReasons,
    tier1,
    tier2,
  };
}

export const FAMILY_OF: Record<string, Family> = Object.fromEntries(ATOMIC_NOULS.map((n) => [n.name, n.family]));
