/**
 * Recall as of v0.6 part 3 (docs/benchmark.md#retrieval): every live line is a candidate (up to `jev.maxRecallLines`),
 * the choice names bare ids, each line gets its own relevance noul, and a line that superseded others carries their
 * text as context. A line is injected when Jev is sure it bears on the prompt, or when it is relevant enough and the
 * choice also ranks it. Jev is mocked (test/helpers.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHook } from "../src/hook.js";
import { recordProvenance } from "../src/provenance.js";
import { GATE_MAX_PER_CALL, RELEVANCE_SURE, recallGuarded, relevanceNoul, replacedTexts, selectForPrompt, type RankedMemory } from "../src/recall.js";
import { init } from "../src/init.js";
import { MemoryStore } from "../src/store.js";
import { DEFAULT_CONFIG, type Memory } from "../src/types.js";
import { mockJev } from "./helpers.js";

const env = { JEVMEM_WRITER: "none" } as NodeJS.ProcessEnv;
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-recall3-"));
  init({ root, hooks: false });
  return { root, store: new MemoryStore(root) };
}
const mem = (id: string, text: string, extra: Partial<Memory> = {}): Memory => ({ id, kind: "decision", text, ts: "2026-01-01T00:00:00.000Z", conf: 0.9, ...extra });
const row = (id: string, relevance: number | null, choiceProbability: number): RankedMemory => ({ memory: mem(id, id), relevance, choiceProbability, injection: null });

describe("recall questions (v0.6 part 3)", () => {
  it("asks the choice over bare ids and one relevance noul per live line, with the text once, in the state", async () => {
    const { root, store } = project();
    const lines = [store.add({ kind: "decision", text: "Use Postgres 16" }), store.add({ kind: "constraint", text: "Never commit .env files" }), store.add({ kind: "dead-end", text: "Tried SQLite for the queue, but writes locked the file; Postgres stays" })];
    for (const m of lines) recordProvenance(root, m, "hook");
    const jev = mockJev(() => ({}));
    await runHook({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "which database?" }, { jev, env });
    const q = jev.calls[0]!.questions as Record<string, any>;
    expect(Object.keys(q).sort()).toEqual(["most_relevant", ...lines.map((m) => `rel_${m.id}`)].sort());
    for (const m of lines) {
      expect(q.most_relevant.criteria[m.id]).toBeNull();
      expect(q[`rel_${m.id}`]).toEqual(relevanceNoul(m.id));
    }
    expect((jev.calls[0]!.state as any).memories.map((m: any) => m.text)).toEqual(lines.map((m) => m.text));
  });

  it("sends every live line up to maxRecallLines (250), with no keyword pre-filter below it", async () => {
    const { root, store } = project();
    for (let i = 0; i < 120; i++) recordProvenance(root, store.add({ kind: "decision", text: `Service number ${i} runs on port ${3000 + i}` }), "hook");
    const jev = mockJev(() => ({}));
    await runHook({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "how do deploys work?" }, { jev, env });
    expect((jev.calls[0]!.state as any).memories).toHaveLength(120);
    expect(DEFAULT_CONFIG.jev.maxRecallLines).toBe(250);
    // Search keeps its own, smaller cap.
    expect(DEFAULT_CONFIG.jev.maxRecallCandidates).toBe(60);
  });

  it("a line that superseded others carries their text as `replaces` (newest first); superseded lines are never candidates", async () => {
    const { root, store } = project();
    const old1 = store.add({ kind: "decision", text: "Sessions live in Redis" });
    const old2 = store.add({ kind: "decision", text: "Sessions live in Memcached" });
    const now = store.add({ kind: "decision", text: "Sessions are signed cookies; no server-side store" });
    store.supersede(old1.id, old2.id);
    store.supersede(old2.id, now.id);
    const other = store.add({ kind: "preference", text: "Prefer named exports" });
    for (const m of [now, other]) recordProvenance(root, m, "hook");
    const jev = mockJev(() => ({}));
    await runHook({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "where do sessions live?" }, { jev, env });
    const sent = (jev.calls[0]!.state as any).memories;
    expect(sent.map((m: any) => m.id)).toEqual([now.id, other.id]);
    expect(sent[0].replaces).toEqual(["Sessions live in Memcached", "Sessions live in Redis"]);
    expect(sent[1].replaces).toBeUndefined();
  });

  it("replacedTexts follows chains, keeps at most what it finds, and leaves out lines with hidden text", () => {
    const all = [mem("a1", "first", { kind: "superseded", supersededBy: "b2" }), mem("b2", "second", { kind: "superseded", supersededBy: "c3" }), mem("c3", "third"), mem("d4", "hid\u200bden", { kind: "superseded", supersededBy: "c3" }), mem("e5", "alone")];
    const r = replacedTexts(all);
    expect(r.get("c3")).toEqual(["second", "first"]);
    expect(r.has("e5")).toBe(false);
  });
});

describe("which lines a prompt gets (selectForPrompt)", () => {
  const opts = { topK: 5, min: DEFAULT_CONFIG.thresholds.recallChoiceMin, relevanceMin: DEFAULT_CONFIG.thresholds.recallRelevanceMin };

  it("a line Jev is sure about is injected even when the choice gives it almost nothing (a second relevant line)", () => {
    const picked = selectForPrompt([row("first", 0.97, 0.96), row("second", 0.98, 0.01)], opts).map((r) => r.memory.id);
    expect(picked).toEqual(["second", "first"]);
    expect(RELEVANCE_SURE).toBe(0.97);
  });

  it("below the sure level, a line needs both recallRelevanceMin and the choice's recallChoiceMin; under recallRelevanceMin, never", () => {
    const picked = selectForPrompt([row("both", 0.85, 0.3), row("choiceLow", 0.9, 0.02), row("notRelevant", 0.6, 0.9)], opts).map((r) => r.memory.id);
    expect(picked).toEqual(["both"]);
  });

  it("a second line the first crowded out of the choice is kept at 0.03 (v0.6 part 3b; 0.05 before, which every existing jevmem.config.json still holds as recallMin)", () => {
    const picked = selectForPrompt([row("first", 0.97, 0.95), row("second", 0.95, 0.03)], opts).map((r) => r.memory.id);
    expect(picked).toEqual(["first", "second"]);
    expect(DEFAULT_CONFIG.thresholds.recallChoiceMin).toBe(0.03);
    expect(DEFAULT_CONFIG.thresholds.recallMin).toBe(0.05);
  });

  it("recallRelevanceMin above 1 turns recall off, even for a line Jev is sure about", () => {
    expect(selectForPrompt([row("sure", 0.99, 0.99)], { ...opts, relevanceMin: 1.01 })).toEqual([]);
  });

  it("a prompt no line bears on gets nothing, however the choice spreads (it sums to 1)", () => {
    expect(selectForPrompt([row("a", 0.1, 0.7), row("b", 0.2, 0.3)], opts)).toEqual([]);
  });

  it("at most recallTopK lines, the most relevant first; a line without a relevance answer is never picked", () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(`l${i}`, 0.9 + i / 100, 0.1));
    expect(selectForPrompt(rows, opts).map((r) => r.memory.id)).toEqual(["l7", "l6", "l5", "l4", "l3"]);
    expect(selectForPrompt([row("x", null, 0.9)], opts)).toEqual([]);
  });
});

describe("the poisoning gate in the recall call", () => {
  it(`gates at most ${GATE_MAX_PER_CALL} unchecked unverified lines per call; the rest are neither served nor withheld until a later prompt checks them`, async () => {
    const { root, store } = project();
    for (let i = 0; i < GATE_MAX_PER_CALL + 10; i++) store.add({ kind: "decision", text: `Team rule ${i}: invoices for region ${i} go out on day ${(i % 28) + 1}` });
    const jev = mockJev((q) => Object.fromEntries(Object.keys(q).map((k) => [k, k.startsWith("rel_") ? 0.98 : 0.02])));
    const r = await recallGuarded(jev, root, "when do invoices go out for region 3?", store.active(), { topK: 5, min: 0.05, relevanceMin: 0.8, injectionMax: 0.5 });
    const asked = Object.keys(jev.calls[0]!.questions).filter((k) => k.startsWith("inj_"));
    expect(asked).toHaveLength(GATE_MAX_PER_CALL);
    expect(r.deferred).toBe(10);
    expect(r.withheld).toEqual([]);
    expect((jev.calls[0]!.state as any).memories).toHaveLength(GATE_MAX_PER_CALL);
    // The next prompt asks only the 10 left; the 60 checked lines now have cached verdicts.
    await recallGuarded(jev, root, "when do invoices go out for region 3?", store.active(), { topK: 5, min: 0.05, relevanceMin: 0.8, injectionMax: 0.5 });
    expect(Object.keys(jev.calls[1]!.questions).filter((k) => k.startsWith("inj_"))).toHaveLength(10);
    expect((jev.calls[1]!.state as any).memories).toHaveLength(GATE_MAX_PER_CALL + 10);
  });

  it("the hook's detail says how many unchecked lines were left for a later prompt", async () => {
    const { root, store } = project();
    for (let i = 0; i < GATE_MAX_PER_CALL + 3; i++) store.add({ kind: "decision", text: `Queue ${i} drains every ${i + 1} minutes` });
    const jev = mockJev((q) => Object.fromEntries(Object.keys(q).filter((k) => k.startsWith("inj_")).map((k) => [k, 0.02])));
    const r = await runHook({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "how often does queue 4 drain?" }, { jev, env });
    expect(r.detail).toContain(`${GATE_MAX_PER_CALL} gated, 3 left for a later prompt`);
  });
});
