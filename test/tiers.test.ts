import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { noul } from "@typesafe-ai/sdk";
import { borderlineReasons, decide } from "../src/decide.js";
import { cacheKey, createJev, summarizeLog } from "../src/jev.js";
import { examplesByTier, formatFit, formatWhy, runFit, labelRight, findDecision, readLabels } from "../src/labels.js";
import { buildDecideQuestions, buildTier1Questions, TIER1_NOULS, TIER1_QUESTION_COUNT, tier1Families } from "../src/questions.js";
import { runHook } from "../src/hook.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { MemoryStore } from "../src/store.js";
import { CHIT_CHAT, mockJev, SAVE_DECISION, type AnswerOverrides } from "./helpers.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-tiers-"));
const RULE = DEFAULT_CONFIG.tiers.borderline;

/** Tier-1 answers: a clear decision, sure about everything. */
const T1_SURE: AnswerOverrides = { contains_decision: 0.95, contains_constraint: 0.05, contains_preference: 0.05, contains_bug_finding: 0.05, contains_architecture_fact: 0.05, contains_todo: 0.05, is_only_chit_chat: 0.02, contradicts_existing_memory: 0.05, contains_instructions_aimed_at_an_automated_system: 0.03, kind: "decision", importance: 3 };
const T1_UNSURE: AnswerOverrides = { ...T1_SURE, contains_decision: 0.55 };

describe("tier 1 question set", () => {
  it("has nine broad nouls (+1 meta noul with the assistant reply) with one positive and one negative example each, plus kind/touches/importance", () => {
    expect(TIER1_NOULS).toHaveLength(10);
    expect(TIER1_NOULS.filter((n) => n.family !== "meta")).toHaveLength(9);
    expect(TIER1_QUESTION_COUNT).toBe(12);
    expect(Object.keys(buildTier1Questions([], { withAssistant: true }))).toHaveLength(14);
    for (const n of TIER1_NOULS) {
      expect(n.yes.examples).toHaveLength(1);
      expect(n.no.examples).toHaveLength(1);
      expect(n.question).toMatch(/^(Does|Is)\b/);
    }
    const q = buildTier1Questions([{ id: "m1", kind: "decision", text: "x" }]) as any;
    expect(Object.keys(q)).toHaveLength(12);
    for (const c of Object.values(q.kind.criteria) as any[]) expect(c.examples).toHaveLength(1);
    expect(Object.keys(q.touches_memory_id.criteria)).toEqual(["m1", "none"]);
    // Tier 1 is small: well under half of tier 2 (2 examples per side) serialized.
    const t1 = JSON.stringify(q).length;
    const t2 = JSON.stringify(buildDecideQuestions([{ id: "m1", kind: "decision", text: "x" }], { examplesPerSide: 2 })).length;
    expect(t1).toBeLessThan(t2 / 2);
  });
  it("maps each broad noul straight to its family score", () => {
    const f = tier1Families({ contains_decision: 0.9, is_only_chit_chat: 0.1, contradicts_existing_memory: 0.7 });
    expect(f.decision).toBe(0.9);
    expect(f.chit_chat).toBe(0.1);
    expect(f.contradiction).toBe(0.7);
    expect(f.bug).toBe(0);
  });
});

describe("borderline rule", () => {
  const t1 = (nouls: Record<string, number>, importanceConfidence = 0.9, kindConfidence = 0.9) => ({ nouls, importanceConfidence, kindConfidence });
  it("is quiet when tier 1 is sure, even if a secondary kind noul sits in the band (scope=max)", () => {
    expect(borderlineReasons(t1({ contains_decision: 0.95, contains_constraint: 0.5, contains_todo: 0.05, contradicts_existing_memory: 0.1, contains_instructions_aimed_at_an_automated_system: 0.02 }), RULE)).toEqual([]);
  });
  it("fires when the strongest kind noul is in [0.3, 0.7], or on any kind noul with scope=any", () => {
    expect(borderlineReasons(t1({ contains_bug_finding: 0.5 }), RULE)[0]).toMatch(/max kind noul contains_bug_finding=0.50/);
    expect(borderlineReasons(t1({ contains_bug_finding: 0.3 }), RULE)).toHaveLength(1);
    expect(borderlineReasons(t1({ contains_bug_finding: 0.71 }), RULE)).toHaveLength(0);
    expect(borderlineReasons(t1({ contains_decision: 0.95, contains_constraint: 0.5 }), { ...RULE, kindNoulScope: "any" })).toHaveLength(1);
  });
  it("fires on low kind confidence, contradiction ≥ 0.5, low importance confidence, and injection in [0.3, 0.7]", () => {
    expect(borderlineReasons(t1({ contains_decision: 0.9 }, 0.9, 0.5), RULE)[0]).toMatch(/kind confidence=0.50/);
    expect(borderlineReasons(t1({ contradicts_existing_memory: 0.5 }), RULE)[0]).toMatch(/contradicts/);
    expect(borderlineReasons(t1({}, 0.49), RULE)[0]).toMatch(/importance confidence/);
    expect(borderlineReasons(t1({}, 0.55), RULE)).toHaveLength(0);
    expect(borderlineReasons(t1({ contains_instructions_aimed_at_an_automated_system: 0.4 }), RULE)[0]).toMatch(/injection/);
    expect(borderlineReasons(t1({ contains_instructions_aimed_at_an_automated_system: 0.95 }), RULE)).toHaveLength(0); // sure it's injection: tier 1 handles it
  });
  it("does not escalate when tier 1 is sure the turn is injection or chit-chat", () => {
    expect(borderlineReasons(t1({ contains_instructions_aimed_at_an_automated_system: 0.95, contains_decision: 0.5 }, 0.1), RULE)).toEqual([]);
    expect(borderlineReasons(t1({ is_only_chit_chat: 0.95 }, 0.1), RULE)).toEqual([]);
    expect(borderlineReasons(t1({ is_only_chit_chat: 0.95 }, 0.1), { ...RULE, sureSkipChitChatMin: 1.01 })).toHaveLength(1);
  });
  it("honours a custom rule", () => {
    expect(borderlineReasons(t1({ contains_decision: 0.5 }), { ...RULE, kindNoulLow: 0.6 })).toHaveLength(0);
  });
});

describe("two-tier decide", () => {
  it("auto: tier 1 is final when sure (one call), escalates to tier 2 when unsure (two calls), tier 2 wins", async () => {
    const jev = mockJev((q) => ("contains_decision" in q ? T1_SURE : SAVE_DECISION));
    const d = await decide(jev, { message: "USER: use Postgres", existingMemories: [] });
    expect(jev.calls).toHaveLength(1);
    expect(jev.calls[0]!.opts.tier).toBe(1);
    expect(d.tier).toBe(1);
    expect(d.escalated).toBe(false);
    expect(d.save).toBe(true);
    expect(d.reason).toContain("[tier 1]");
    expect(Object.keys(d.nouls)).toHaveLength(9);
    expect(d.tier1?.save).toBe(true);
    expect(d.tier2).toBeUndefined();

    const jev2 = mockJev((q) => ("contains_decision" in q ? T1_UNSURE : CHIT_CHAT));
    const e = await decide(jev2, { message: "USER: hmm maybe", existingMemories: [] });
    expect(jev2.calls.map((c) => c.opts.tier)).toEqual([1, 2]);
    expect(e.tier).toBe(2);
    expect(e.escalated).toBe(true);
    expect(e.escalationReasons[0]).toMatch(/max kind noul contains_decision=0.55/);
    expect(e.save).toBe(false); // tier 2 said chit-chat, and it wins over tier 1's "save"
    expect(e.tier1?.save).toBe(true);
    expect(e.usage.inputTokens).toBe(1000); // both tiers counted
    expect(Object.keys(e.nouls)).toHaveLength(30);
  });

  it("fast: only tier 1, even when unsure; full: only tier 2", async () => {
    const jev = mockJev((q) => ("contains_decision" in q ? T1_UNSURE : SAVE_DECISION));
    const f = await decide(jev, { message: "m", existingMemories: [] }, { tiers: { mode: "fast" } });
    expect(jev.calls).toHaveLength(1);
    expect(f.tier).toBe(1);
    expect(f.escalated).toBe(false);
    const jev2 = mockJev((q) => ("contains_decision" in q ? T1_SURE : SAVE_DECISION));
    const g = await decide(jev2, { message: "m", existingMemories: [] }, { tiers: { mode: "full" } });
    expect(jev2.calls).toHaveLength(1);
    expect(jev2.calls[0]!.opts.tier).toBe(2);
    expect(g.tier).toBe(2);
    expect(g.tier1).toBeUndefined();
    expect(Object.keys(jev2.calls[0]!.questions)).toHaveLength(33);
  });

  it("uses tier-1 threshold overrides only for tier-1 finals", async () => {
    const jev = mockJev((q) => ("contains_decision" in q ? { ...T1_SURE, importance: 2 } : SAVE_DECISION));
    const strict = await decide(jev, { message: "m", existingMemories: [] }, { tiers: { tier1Thresholds: { importanceMin: "important" } } });
    expect(strict.save).toBe(false);
    expect(strict.reason).toContain("importance=useful<important");
  });

  it("tier 2 examples are trimmed to tier2ExamplesPerSide", async () => {
    const jev = mockJev((q) => ("contains_decision" in q ? T1_UNSURE : SAVE_DECISION));
    await decide(jev, { message: "m", existingMemories: [] }, { tiers: { tier2ExamplesPerSide: 1 } });
    const q2 = jev.calls[1]!.questions as any;
    expect(q2.states_a_choice_between_alternatives.criteria.true.examples).toHaveLength(1);
    await decide(jev, { message: "m2", existingMemories: [] }, { tiers: { tier2ExamplesPerSide: 2 } });
    expect((jev.calls[3]!.questions as any).states_a_choice_between_alternatives.criteria.true.examples).toHaveLength(2);
  });
});

describe("tier in cache, log, stats", () => {
  it("cache keys differ by tier and the log carries the tier so stats can compute the escalation rate", async () => {
    expect(cacheKey("m", "s", { q: noul("a") }, 1)).not.toBe(cacheKey("m", "s", { q: noul("a") }, 2));
    const root = tmp();
    const seen: any[] = [];
    const jev = createJev({ root, apiKey: "k", fetch: async (_u, init) => { seen.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ model: "t", answers: { q: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200 }); } });
    await jev.call("s", { q: noul("a") }, { label: "decide", tier: 1 });
    await jev.call("s", { q: noul("a") }, { label: "decide", tier: 2 });
    await jev.call("s", { q: noul("a") }, { label: "decide", tier: 1 });
    expect(seen).toHaveLength(2);
    expect(jev.log.map((e) => e.tier)).toEqual([1, 2, 1]);
    expect(jev.log[2]!.cacheHit).toBe(true);
    const s = summarizeLog(jev.log);
    expect(s.decideTier1).toBe(2);
    expect(s.decideTier2).toBe(1);
    expect(s.escalationRate).toBeCloseTo(0.5);
    expect(summarizeLog(jev.log.filter((e) => e.tier === 2)).escalationRate).toBeNull();
  });
});

describe("why and fit with tiers", () => {
  it("records the tier, shows both tiers in why, and fit routes labels per tier", async () => {
    const root = tmp();
    const env = { JEVMEM_WRITER: "none" } as NodeJS.ProcessEnv;
    const jev = mockJev((q, state: any) => {
      const tier1 = "contains_decision" in q;
      if (/unsure/.test(state.user_message)) return tier1 ? T1_UNSURE : SAVE_DECISION;
      return tier1 ? T1_SURE : SAVE_DECISION;
    });
    await runHook({ hook_event_name: "Stop", cwd: root, user_message: "Use Postgres, sure." }, { jev, env });
    await runHook({ hook_event_name: "Stop", cwd: root, user_message: "Use Postgres, unsure." }, { jev, env });
    const store = new MemoryStore(root);
    const [a, b] = store.active();
    const recA = findDecision(root, a!.id)!;
    const recB = findDecision(root, b!.id)!;
    expect(recA.decision.tier).toBe(1);
    expect(recB.decision.tier).toBe(2);
    const whyA = formatWhy(recA);
    expect(whyA).toContain("final answer from tier 1 (tier 1 was sure)");
    expect(whyA).toContain("contains_decision");
    expect(whyA).not.toContain("tier 2 (30 atomic nouls");
    const whyB = formatWhy(recB);
    expect(whyB).toContain("escalated: max kind noul contains_decision=0.55");
    expect(whyB).toContain("tier 1 (9 broad nouls");
    expect(whyB).toContain("tier 2 (30 atomic nouls");
    expect(whyB).toContain("states_a_choice_between_alternatives");

    labelRight(root, recA);
    labelRight(root, recB);
    const labels = readLabels(root);
    expect(labels[0]!.answers.tier).toBe(1);
    expect(labels[0]!.answers.tier1).toBeDefined();
    expect(labels[0]!.answers.tier2).toBeUndefined();
    expect(labels[1]!.answers.tier2).toBeDefined();
    const split = examplesByTier(labels);
    expect(split.tier1).toHaveLength(2); // tier 1 ran for both
    expect(split.tier2).toHaveLength(1); // tier 2 only for the escalated one
    expect(split.tier1[0]!.families!.decision).toBe(0.95);

    const r = runFit(root, { force: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.tier1?.n).toBe(2);
      expect(r.result.tier2?.n).toBe(1);
      const text = formatFit(r.result);
      expect(text).toContain("1 with tier-2 answers → family weights + thresholds; 2 with tier-1 answers → tier-1 thresholds");
      expect(text).toContain("tier 1: thresholds only");
    }
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "jevmem.config.json"), "utf8"));
    expect(cfg.tiers.tier1Thresholds.contentMin).toBeTypeOf("number");
    expect(cfg.weights.decision).toBeDefined();
    expect(JSON.parse(fs.readFileSync(path.join(root, ".jevmem", "fit.json"), "utf8"))).toMatchObject({ tier1Labels: 2, tier2Labels: 1 });
  });
});
