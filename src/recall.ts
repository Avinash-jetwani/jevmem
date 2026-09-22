import { choice, noul, type ChoiceCriteria, type Questions } from "@typesafe-ai/sdk";
import type { JevCaller } from "./jev.js";
import { prefilterByOverlap } from "./decide.js";
import type { Memory } from "./types.js";

export interface RankedMemory {
  memory: Memory;
  /** Probability from the `choice` over memory ids (sums to 1 across candidates). */
  choiceProbability: number;
  /** Per-candidate noul "is this memory relevant to the query?" when requested; otherwise null. */
  relevance: number | null;
}

export interface RankOptions {
  /** Add one noul per candidate (batched into the same call). Capped at `noulCap` candidates. */
  perCandidateNouls?: boolean;
  noulCap?: number;
  /** Max candidates in the choice (pre-filtered by keyword overlap when exceeded). */
  maxIds?: number;
  timeoutMs?: number;
  label?: string;
}

/**
 * One Jev call: a `choice` over memory ids ("most relevant to the query") and, optionally, a noul per candidate.
 * Returns every candidate ranked by relevance (noul when available, else choice probability).
 */
export async function rankMemories(jev: JevCaller, query: string, memories: Memory[], opts: RankOptions = {}): Promise<RankedMemory[]> {
  if (memories.length === 0) return [];
  const maxIds = opts.maxIds ?? 200;
  const candidates = prefilterByOverlap(query, memories, maxIds);
  const noulCap = opts.noulCap ?? 50;
  const noulCandidates = opts.perCandidateNouls ? prefilterByOverlap(query, candidates, noulCap) : [];

  const criteria: ChoiceCriteria = {};
  for (const m of candidates) criteria[m.id] = `[${m.kind}] ${m.text}`;
  criteria.none = "No listed memory is relevant to the query.";

  const questions: Questions = {
    most_relevant: choice("Which memory is most relevant to the query?", criteria),
  };
  for (const m of noulCandidates) {
    questions[`rel_${m.id}`] = noul(`Is memory ${m.id} relevant to the query?`, {
      true: "The memory would help answer or act on the query.",
      false: "The memory is about something else.",
    });
  }

  const state = {
    query: query.slice(0, 4000),
    memories: candidates.map((m) => ({ id: m.id, kind: m.kind, text: m.text })),
  };
  const res = await jev.call(state, questions, { label: opts.label ?? "recall", timeoutMs: opts.timeoutMs });
  const probs = (res.answers.most_relevant as any).probabilities as Record<string, number>;
  const ranked: RankedMemory[] = candidates.map((m) => {
    const rel = res.answers[`rel_${m.id}`];
    return {
      memory: m,
      choiceProbability: probs[m.id] ?? 0,
      relevance: rel && rel.type === "noul" ? rel.noul : null,
    };
  });
  ranked.sort((a, b) => (b.relevance ?? b.choiceProbability) - (a.relevance ?? a.choiceProbability) || b.choiceProbability - a.choiceProbability);
  return ranked;
}

/** The read side of the hook: top-K memories worth injecting for a prompt, by choice probability. */
export async function recallForPrompt(jev: JevCaller, prompt: string, memories: Memory[], opts: { topK: number; min: number; timeoutMs?: number; maxIds?: number }): Promise<RankedMemory[]> {
  const ranked = await rankMemories(jev, prompt, memories, { maxIds: opts.maxIds, timeoutMs: opts.timeoutMs, label: "recall" });
  return ranked.filter((r) => r.choiceProbability >= opts.min).slice(0, opts.topK);
}

export function formatInjection(ranked: RankedMemory[]): string {
  if (ranked.length === 0) return "";
  const lines = ranked.map((r) => `- [${r.memory.kind}] ${r.memory.text} (id:${r.memory.id}, p=${r.choiceProbability.toFixed(2)})`);
  return ["<jevmem-memory>", "Relevant project memory from JEVMEM.md (selected by Jev):", ...lines, "</jevmem-memory>"].join("\n");
}
