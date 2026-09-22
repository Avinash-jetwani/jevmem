import type { JevCaller } from "./jev.js";
import { combine, defaultWeights, evaluatePolicy, mergeWeights, type Weights } from "./combine.js";
import { ATOMIC_NOULS, buildDecideQuestions, NOUL_NAMES, type Family } from "./questions.js";
import { scrubSecrets } from "./scrub.js";
import { DEFAULT_CONFIG, type Importance, type Kind, type Memory, type Thresholds } from "./types.js";

export { evaluatePolicy } from "./combine.js";
export { buildDecideQuestions, NOUL_NAMES, ATOMIC_NOULS } from "./questions.js";
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
  maxIds?: number;
  timeoutMs?: number;
  /** Max characters of `message` sent to Jev. */
  maxMessageChars?: number;
  maxContextChars?: number;
}

export interface Decision {
  save: boolean;
  kind: Kind | "none";
  importance: Importance;
  importanceScore: number;
  contradiction: boolean;
  touchesMemoryId: string | null;
  /** Every atomic noul probability, by name. */
  nouls: Record<string, number>;
  /** Combined per-family scores (logistic over the atomic nouls). */
  families: Record<Family, number>;
  /** max over the six kind families; the "is there anything here" score. */
  content: number;
  kindProbabilities: Record<string, number>;
  confidence: number;
  /** Human-readable reason for the save/skip outcome. */
  reason: string;
  usage: { inputTokens: number; outputTokens: number };
  cacheHit: boolean;
  /** The thresholds that were applied, so `why` can show what was cleared. */
  thresholds: Thresholds;
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

/** One Jev call: 30 atomic nouls, two choices, one score. Combined in code; returns a fully explained decision. */
export async function decide(jev: JevCaller, input: DecideInput, opts: DecideOptions = {}): Promise<Decision> {
  const thresholds: Thresholds = { ...DEFAULT_CONFIG.thresholds, ...opts.thresholds };
  const weights = resolveWeights(opts.weights);
  const maxIds = opts.maxIds ?? DEFAULT_CONFIG.jev.maxIdsPerCall;
  // Secrets and PII are stripped here, before anything is batched into the state. (createJev scrubs again at the
  // HTTP boundary; doing it here too means a mocked or custom JevCaller never sees a credential either.)
  const message = scrubSecrets(input.message).slice(0, opts.maxMessageChars ?? 6000);
  const recent = scrubSecrets(input.recentContext ?? "").slice(-(opts.maxContextChars ?? 1500));
  const candidates = prefilterByOverlap(message, input.existingMemories, maxIds).map((m) => ({ ...m, text: scrubSecrets(m.text) }));

  const questions = buildDecideQuestions(candidates);
  const state = {
    message,
    previous_turns: recent || null,
    existing_memories: candidates.map((m) => ({ id: m.id, kind: m.kind, text: m.text })),
  };
  const res = await jev.call(state, questions, { label: "decide", timeoutMs: opts.timeoutMs });
  const a = res.answers as any;
  const nouls: Record<string, number> = {};
  for (const n of NOUL_NAMES) nouls[n] = a[n]?.noul ?? 0;
  const families = combine(nouls, weights);
  const kind = a.kind.choice as string;
  const touches = a.touches_memory_id.choice as string;
  const policy = evaluatePolicy({ kindChoice: kind, importanceScore: a.importance.score, families, touchesMemoryId: touches }, thresholds);
  return {
    save: policy.save,
    kind: kind as Kind | "none",
    importance: policy.importance,
    importanceScore: a.importance.score,
    contradiction: policy.contradiction,
    touchesMemoryId: touches === "none" ? null : touches,
    nouls,
    families,
    content: policy.content,
    kindProbabilities: { ...a.kind.probabilities },
    confidence: a.kind.confidence,
    reason: policy.reason,
    usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    cacheHit: Boolean((res as any).cacheHit),
    thresholds,
  };
}

export const FAMILY_OF: Record<string, Family> = Object.fromEntries(ATOMIC_NOULS.map((n) => [n.name, n.family]));
