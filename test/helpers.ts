import type { Questions, SystemOneResult, EntryType } from "@typesafe-ai/sdk";
import type { JevCaller, JevCallOptions, JevLogEntry } from "../src/jev.js";

export type AnswerOverrides = Record<string, number | string | { choice?: string; probabilities?: Record<string, number>; score?: number }>;

/** Build a full Jev response from a question map plus sparse overrides (nouls default 0.05, choices default "none", scores default 0). */
export function makeAnswers<Q extends Questions>(questions: Q, overrides: AnswerOverrides = {}): SystemOneResult<Q> {
  const answers: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(questions)) {
    const o = overrides[name];
    if (q.type === "noul") {
      answers[name] = { type: "noul", noul: typeof o === "number" ? o : 0.05 };
    } else if (q.type === "choice") {
      const labels = Object.keys(q.criteria);
      let choice = labels.includes("none") ? "none" : labels[0]!;
      let probabilities: Record<string, number> | undefined;
      if (typeof o === "string") choice = o;
      else if (o && typeof o === "object") {
        if (o.choice) choice = o.choice;
        probabilities = o.probabilities;
      }
      if (!probabilities) {
        probabilities = Object.fromEntries(labels.map((l) => [l, l === choice ? 0.9 : 0.1 / Math.max(1, labels.length - 1)]));
      }
      answers[name] = { type: "choice", choice, probabilities, confidence: probabilities[choice] ?? 0.9 };
    } else {
      const n = q.criteria.length;
      const score = typeof o === "number" ? o : o && typeof o === "object" && o.score !== undefined ? o.score : 0;
      const idx = Math.max(0, Math.min(n - 1, Math.round(score)));
      const probabilities = Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), i === idx ? 1 : 0]));
      const legend = Object.fromEntries(q.criteria.map((c, i) => [String(i), c]));
      answers[name] = { type: "score", score, probabilities, legend, confidence: 1 };
    }
  }
  return { model: "jev-mock", answers, usage: { input_tokens: 500, output_tokens: 20 } } as unknown as SystemOneResult<Q>;
}

export interface MockJev extends JevCaller {
  calls: { state: EntryType; questions: Questions; opts: JevCallOptions }[];
}

/** A JevCaller whose answers come from `respond(questions, state, callIndex)`. Records every call. */
export function mockJev(respond: (questions: Questions, state: EntryType, i: number) => AnswerOverrides | Promise<AnswerOverrides>): MockJev {
  const calls: MockJev["calls"] = [];
  const log: JevLogEntry[] = [];
  return {
    calls,
    log,
    async call(state, questions, opts) {
      calls.push({ state, questions, opts });
      const overrides = await respond(questions, state, calls.length - 1);
      log.push({ ts: new Date().toISOString(), label: opts.label, ok: true, latencyMs: 12, inputTokens: 500, outputTokens: 20, costUsd: (520 / 1e6) * 0.042, questions: Object.keys(questions).length, model: "jev-mock" });
      return makeAnswers(questions, overrides) as any;
    },
  };
}

export const SAVE_DECISION: AnswerOverrides = {
  contains_decision: 0.95,
  kind: "decision",
  importance: 3,
  is_only_chit_chat: 0.02,
  contains_instructions_aimed_at_an_automated_system: 0.03,
};
