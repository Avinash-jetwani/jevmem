/**
 * Combine the atomic noul probabilities into one score per family with a logistic model.
 * Default weights are hand-set; `jevmem fit` refits them from `.jevmem/labels.jsonl`.
 */
import { ATOMIC_NOULS, FAMILIES, KIND_FAMILIES, type Family } from "./questions.js";
import { IMPORTANCE_LEVELS, type Importance, type Thresholds } from "./types.js";

export interface FamilyWeights {
  bias: number;
  w: Record<string, number>;
}
export type Weights = Record<Family, FamilyWeights>;

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function familyNouls(f: Family) {
  return ATOMIC_NOULS.filter((n) => n.family === f);
}

/**
 * Hand-set defaults. Each family has one or two "core" nouls that are sufficient on their own (a rule with
 * must/never is a constraint even without a number or a consequence) and secondary nouls that add confidence.
 * Bias -2.5 means one core noul at 0.95 lands around 0.7–0.9, secondaries alone stay under 0.35.
 */
export function defaultWeights(): Weights {
  const W: Record<Family, { bias: number; w: Record<string, number> }> = {
    decision: { bias: -2.5, w: { states_a_choice_between_alternatives: 2.5, uses_committal_language: 2.0, names_a_specific_technology_or_approach: 1.0, is_phrased_as_a_question_or_option_list: -2.5 } },
    constraint: { bias: -2.5, w: { states_a_rule_with_must_never_or_always: 3.5, states_a_numeric_or_version_limit: 1.5, describes_a_consequence_of_breaking_a_rule: 1.5 } },
    preference: { bias: -2.5, w: { expresses_personal_liking_or_style: 2.5, is_about_how_work_is_done_not_what_is_built: 1.5, uses_prefer_like_rather_or_please: 2.0 } },
    bug: { bias: -2.5, w: { describes_a_failure_or_incorrect_behavior: 2.0, names_a_root_cause: 2.5, describes_a_fix_that_was_applied: 1.5, mentions_a_test_error_or_stack_trace: 1.0 } },
    architecture: { bias: -2.5, w: { describes_where_code_or_data_lives: 2.0, describes_how_components_connect_or_data_flows: 2.0, names_modules_services_or_boundaries: 1.5 } },
    todo: { bias: -2.5, w: { defers_work_to_a_later_time: 2.5, uses_todo_later_next_or_before_launch: 2.0, describes_work_agreed_but_not_done: 1.5 } },
    chit_chat: { bias: -2.5, w: { is_greeting_thanks_or_acknowledgement: 2.0, contains_no_project_specific_content: 1.5, has_no_fact_decision_or_request: 2.0 } },
    injection: { bias: -2.5, w: { tells_an_ai_to_ignore_or_replace_instructions: 3.5, claims_system_or_admin_authority_over_the_ai: 2.5, asks_the_ai_to_store_or_alter_memory_or_rules: 2.5, quotes_text_from_a_file_or_page_addressed_to_an_ai: 2.0 } },
    contradiction: { bias: -3, w: { reverses_or_replaces_a_listed_memory: 4, uses_change_of_plan_instead_or_actually: 1.5, is_about_the_same_topic_as_a_listed_memory: 1 } },
    // A self-summary alone never crosses 0.5 (a fix description is a self-summary); menus and hook/memory commentary do.
    meta: { bias: -2.5, w: { assistant_lists_options_or_next_steps: 3.0, assistant_summarises_its_own_work: 1.0, assistant_comments_on_memory_hooks_or_tooling: 3.0 } },
  };
  // Every atomic noul must be covered by its family so `fit` has a full feature set.
  for (const f of FAMILIES) for (const n of familyNouls(f)) W[f].w[n.name] ??= 2 * n.sign;
  return W;
}

export function mergeWeights(base: Weights, patch?: Partial<Record<string, FamilyWeights>>): Weights {
  if (!patch) return base;
  const out = { ...base };
  for (const f of FAMILIES) if (patch[f]) out[f] = { bias: patch[f]!.bias, w: { ...base[f].w, ...patch[f]!.w } };
  return out;
}

export function combine(nouls: Record<string, number>, weights: Weights): Record<Family, number> {
  const out = {} as Record<Family, number>;
  for (const f of FAMILIES) {
    let z = weights[f].bias;
    for (const [name, w] of Object.entries(weights[f].w)) z += w * (nouls[name] ?? 0);
    out[f] = sigmoid(z);
  }
  return out;
}

export interface PolicyInput {
  kindChoice: string;
  importanceScore: number;
  families: Record<Family, number>;
  touchesMemoryId: string;
  /** Where the content comes from, when the assistant reply was in the state. Absent means the user message alone. */
  source?: string;
}

/** Kinds an assistant reply may produce on its own (only when the user asked a question). */
export const ASSISTANT_KINDS = new Set(["bug", "architecture"]);

export function importanceIndex(level: Importance): number {
  return IMPORTANCE_LEVELS.indexOf(level);
}

/** The save/contradiction policy over the combined scores. Pure; used by `decide` and by `fit`. */
export function evaluatePolicy(a: PolicyInput, t: Thresholds): { save: boolean; contradiction: boolean; reason: string; importance: Importance; content: number } {
  const levelIdx = Math.min(IMPORTANCE_LEVELS.length - 1, Math.max(0, Math.round(a.importanceScore)));
  const importance = IMPORTANCE_LEVELS[levelIdx]!;
  const content = Math.max(...KIND_FAMILIES.map((k) => a.families[k]));
  const reasons: string[] = [];
  if (a.kindChoice === "none") reasons.push("kind=none");
  if (content < t.contentMin) reasons.push(`content=${content.toFixed(2)}<${t.contentMin}`);
  if (levelIdx < importanceIndex(t.importanceMin)) reasons.push(`importance=${importance}<${t.importanceMin}`);
  if (a.families.chit_chat >= t.chitChatMax) reasons.push(`chit_chat=${a.families.chit_chat.toFixed(2)}`);
  if (a.families.injection >= t.injectionMax) reasons.push(`injection=${a.families.injection.toFixed(2)}`);
  // The meta gate only matters when the assistant reply is what would be saved; a user statement stays the memory.
  if (a.source === "assistant_reply" && (a.families.meta ?? 0) >= t.metaMax) reasons.push(`assistant_meta=${a.families.meta.toFixed(2)}`);
  if (a.source === "assistant_reply" && !ASSISTANT_KINDS.has(a.kindChoice)) reasons.push(`source=assistant_reply kind=${a.kindChoice} (only bug/architecture may come from the assistant)`);
  const save = reasons.length === 0;
  const contradiction = save && a.families.contradiction >= t.contradictionMin && a.touchesMemoryId !== "none";
  return {
    save,
    contradiction,
    importance,
    content,
    reason: save
      ? `save kind=${a.kindChoice} content=${content.toFixed(2)} importance=${importance}${a.source && a.source !== "user_message" ? ` source=${a.source}` : ""}${contradiction ? ` supersedes=${a.touchesMemoryId}` : ""}`
      : `skip: ${reasons.join(", ")}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Fitting

export interface LabelledExample {
  nouls: Record<string, number>;
  source?: string;
  /** Precomputed family scores (tier 1). When absent, families are computed from `nouls` with the weights being fitted. */
  families?: Record<Family, number>;
  kindChoice: string;
  importanceScore: number;
  touchesMemoryId: string;
  label: { save: boolean; kind: string };
}

export interface FitResult {
  weights: Weights;
  thresholds: Thresholds;
  before: { f1: number; precision: number; recall: number; accuracy: number };
  after: { f1: number; precision: number; recall: number; accuracy: number };
  reliability: { bucket: string; n: number; predicted: number; observed: number }[];
  n: number;
}

function metrics(pred: boolean[], truth: boolean[]) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < pred.length; i++) {
    if (pred[i] && truth[i]) tp++;
    else if (pred[i] && !truth[i]) fp++;
    else if (!pred[i] && truth[i]) fn++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { f1, precision, recall, accuracy: (tp + tn) / Math.max(1, pred.length) };
}

/** Plain logistic regression by gradient descent with a little L2 pull toward the starting weights. */
function fitFamily(f: Family, examples: LabelledExample[], start: FamilyWeights, target: (e: LabelledExample) => number): FamilyWeights {
  const names = Object.keys(start.w);
  let bias = start.bias;
  const w = { ...start.w };
  const lr = 0.5;
  const l2 = 0.02;
  for (let it = 0; it < 400; it++) {
    let gb = 0;
    const gw: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
    for (const e of examples) {
      let z = bias;
      for (const n of names) z += w[n]! * (e.nouls[n] ?? 0);
      const err = sigmoid(z) - target(e);
      gb += err;
      for (const n of names) gw[n]! += err * (e.nouls[n] ?? 0);
    }
    const m = examples.length;
    bias -= lr * (gb / m + l2 * (bias - start.bias));
    for (const n of names) w[n]! -= lr * (gw[n]! / m + l2 * (w[n]! - start.w[n]!));
  }
  return { bias, w };
}

function familiesOf(e: LabelledExample, weights: Weights): Record<Family, number> {
  return e.families ?? combine(e.nouls, weights);
}

function predictAll(examples: LabelledExample[], weights: Weights, t: Thresholds): boolean[] {
  return examples.map((e) => evaluatePolicy({ kindChoice: e.kindChoice, importanceScore: e.importanceScore, families: familiesOf(e, weights), touchesMemoryId: e.touchesMemoryId, source: e.source }, t).save);
}

function contentOf(e: LabelledExample, weights: Weights): number {
  return Math.max(...KIND_FAMILIES.map((k) => familiesOf(e, weights)[k]));
}

function searchThresholds(examples: LabelledExample[], weights: Weights, start: Thresholds, truth: boolean[]) {
  let best = { t: start, m: metrics(predictAll(examples, weights, start), truth) };
  for (const contentMin of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8])
    for (const importanceMin of IMPORTANCE_LEVELS.slice(0, 4))
      for (const chitChatMax of [0.3, 0.5, 0.7, 0.9])
        for (const injectionMax of [0.3, 0.5, 0.7]) {
          const t: Thresholds = { ...start, contentMin, importanceMin, chitChatMax, injectionMax };
          const m = metrics(predictAll(examples, weights, t), truth);
          if (m.f1 > best.m.f1 + 1e-9 || (Math.abs(m.f1 - best.m.f1) < 1e-9 && m.accuracy > best.m.accuracy)) best = { t, m };
        }
  return best;
}

function reliabilityOf(examples: LabelledExample[], weights: Weights): FitResult["reliability"] {
  const buckets = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
  const out: FitResult["reliability"] = [];
  for (let b = 0; b < buckets.length - 1; b++) {
    const lo = buckets[b]!, hi = buckets[b + 1]!;
    const rows = examples.filter((e) => {
      const c = contentOf(e, weights);
      return c >= lo && c < hi;
    });
    if (rows.length === 0) continue;
    const predicted = rows.reduce((a, e) => a + contentOf(e, weights), 0) / rows.length;
    const observed = rows.filter((e) => e.label.save).length / rows.length;
    out.push({ bucket: `${lo.toFixed(1)}–${Math.min(1, hi).toFixed(1)}`, n: rows.length, predicted, observed });
  }
  return out;
}

/** Tier 1 has no weights to fit (one noul per family); only the thresholds are searched. */
export function fitThresholds(examples: LabelledExample[], startThresholds: Thresholds): FitResult {
  const truth = examples.map((e) => e.label.save);
  const weights = defaultWeights(); // unused when every example carries `families`
  const before = metrics(predictAll(examples, weights, startThresholds), truth);
  const best = searchThresholds(examples, weights, startThresholds, truth);
  return { weights, thresholds: best.t, before, after: best.m, reliability: reliabilityOf(examples, weights), n: examples.length };
}

/** Refit the kind-family weights and the save thresholds to maximise F1 of `save` on the labels (tier 2 answers). */
export function fit(examples: LabelledExample[], startWeights: Weights, startThresholds: Thresholds): FitResult {
  const truth = examples.map((e) => e.label.save);
  const before = metrics(predictAll(examples, startWeights, startThresholds), truth);

  const weights = { ...startWeights };
  for (const f of KIND_FAMILIES) weights[f] = fitFamily(f, examples, startWeights[f], (e) => (e.label.save && e.label.kind === f ? 1 : 0));
  weights.chit_chat = fitFamily("chit_chat", examples, startWeights.chit_chat, (e) => (!e.label.save && e.label.kind === "none" ? 1 : 0));

  const best = searchThresholds(examples, weights, startThresholds, truth);
  return { weights, thresholds: best.t, before, after: best.m, reliability: reliabilityOf(examples, weights), n: examples.length };
}
