import { describe, expect, it } from "vitest";
import { decide, evaluatePolicy, prefilterByOverlap, NOUL_NAMES, buildDecideQuestions } from "../src/decide.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { mockJev, SAVE_DECISION } from "./helpers.js";

const T = DEFAULT_CONFIG.thresholds;
const quietNouls = () => Object.fromEntries(NOUL_NAMES.map((n) => [n, 0.05])) as any;

describe("threshold policy", () => {
  it("saves when kind != none, importance >= useful, not chit-chat, not injection", () => {
    const r = evaluatePolicy({ kind: "decision", importanceScore: 2.1, nouls: quietNouls(), touchesMemoryId: "none" }, T);
    expect(r.save).toBe(true);
    expect(r.importance).toBe("useful");
    expect(r.contradiction).toBe(false);
  });
  it("skips kind=none", () => {
    expect(evaluatePolicy({ kind: "none", importanceScore: 4, nouls: quietNouls(), touchesMemoryId: "none" }, T).save).toBe(false);
  });
  it("skips importance below useful (rounded)", () => {
    expect(evaluatePolicy({ kind: "todo", importanceScore: 1.4, nouls: quietNouls(), touchesMemoryId: "none" }, T).save).toBe(false);
    expect(evaluatePolicy({ kind: "todo", importanceScore: 1.6, nouls: quietNouls(), touchesMemoryId: "none" }, T).save).toBe(true);
  });
  it("skips chit-chat at or above chitChatMax", () => {
    const n = { ...quietNouls(), is_only_chit_chat: 0.5 };
    const r = evaluatePolicy({ kind: "preference", importanceScore: 3, nouls: n, touchesMemoryId: "none" }, T);
    expect(r.save).toBe(false);
    expect(r.reason).toContain("chit_chat");
  });
  it("skips injection attempts at or above injectionMax", () => {
    const n = { ...quietNouls(), contains_instructions_aimed_at_an_automated_system: 0.8 };
    const r = evaluatePolicy({ kind: "constraint", importanceScore: 4, nouls: n, touchesMemoryId: "none" }, T);
    expect(r.save).toBe(false);
    expect(r.reason).toContain("injection");
  });
  it("marks contradiction only when the noul >= contradictionMin AND a memory id was picked", () => {
    const n = { ...quietNouls(), contradicts_existing_memory: 0.85 };
    expect(evaluatePolicy({ kind: "decision", importanceScore: 3, nouls: n, touchesMemoryId: "abc123" }, T).contradiction).toBe(true);
    expect(evaluatePolicy({ kind: "decision", importanceScore: 3, nouls: n, touchesMemoryId: "none" }, T).contradiction).toBe(false);
    const low = { ...quietNouls(), contradicts_existing_memory: 0.6 };
    expect(evaluatePolicy({ kind: "decision", importanceScore: 3, nouls: low, touchesMemoryId: "abc123" }, T).contradiction).toBe(false);
  });
  it("honours custom thresholds", () => {
    const strict = { ...T, importanceMin: "critical" as const };
    expect(evaluatePolicy({ kind: "decision", importanceScore: 3, nouls: quietNouls(), touchesMemoryId: "none" }, strict).save).toBe(false);
  });
});

describe("question set", () => {
  it("asks exactly the nine nouls, two choices, and one score, each with a none option", () => {
    const q = buildDecideQuestions([{ id: "m1", kind: "decision", text: "Use Postgres" }]);
    const names = Object.keys(q);
    expect(names).toHaveLength(12);
    for (const n of NOUL_NAMES) expect((q as any)[n].type).toBe("noul");
    expect(q.kind.type).toBe("choice");
    expect(Object.keys(q.kind.criteria)).toEqual(["decision", "constraint", "preference", "bug", "architecture", "todo", "none"]);
    expect(q.touches_memory_id.type).toBe("choice");
    expect(Object.keys(q.touches_memory_id.criteria)).toEqual(["m1", "none"]);
    expect(q.importance.type).toBe("score");
    expect(q.importance.criteria).toHaveLength(5);
  });
});

describe("prefilterByOverlap", () => {
  it("returns everything when under the cap and the best keyword matches when over", () => {
    const mems = [
      { id: "a", text: "Use Postgres for storage" },
      { id: "b", text: "Prefer tabs over spaces" },
      { id: "c", text: "Postgres runs on port 5433 locally" },
    ];
    expect(prefilterByOverlap("anything", mems, 3)).toHaveLength(3);
    const top = prefilterByOverlap("Switch Postgres to a managed instance", mems, 2).map((m) => m.id);
    expect(top).toEqual(["c", "a"]);
  });
});

describe("decide() with a mocked Jev", () => {
  it("makes exactly one call, batches all questions, and caps memory ids", async () => {
    const jev = mockJev(() => SAVE_DECISION);
    const existing = Array.from({ length: 250 }, (_, i) => ({ id: `id${i}`, kind: "todo" as const, text: `memory number ${i}` }));
    const d = await decide(jev, { message: "USER: let's use Postgres", existingMemories: existing }, { maxIds: 200 });
    expect(jev.calls).toHaveLength(1);
    expect(Object.keys(jev.calls[0]!.questions)).toHaveLength(12);
    expect(Object.keys((jev.calls[0]!.questions.touches_memory_id as any).criteria)).toHaveLength(201);
    expect(d.save).toBe(true);
    expect(d.kind).toBe("decision");
    expect(d.importance).toBe("important");
    expect(d.usage.inputTokens).toBe(500);
  });
  it("returns a skip decision with the reason for chit-chat", async () => {
    const jev = mockJev(() => ({ is_only_chit_chat: 0.97, kind: "none", importance: 0 }));
    const d = await decide(jev, { message: "USER: thanks!", existingMemories: [] });
    expect(d.save).toBe(false);
    expect(d.reason).toMatch(/kind=none/);
    expect(d.reason).toMatch(/chit_chat/);
  });
});

describe("secrets never reach Jev", () => {
  it("strips pasted keys from the message, context, and memory texts before the state is built", async () => {
    const jev = mockJev(() => SAVE_DECISION);
    const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    await decide(jev, {
      message: `USER: deploy uses OPENAI_API_KEY=${key} and password=hunter2secret, keep Node 20`,
      recentContext: `assistant: earlier I saw ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 in the logs`,
      existingMemories: [{ id: "m1", kind: "constraint", text: `DB url is postgres://app:s3cretpass@db.internal/app` }],
    });
    const sent = JSON.stringify(jev.calls[0]!.state) + JSON.stringify(jev.calls[0]!.questions);
    expect(sent).not.toContain("sk-proj-abcdefghijklmnop");
    expect(sent).not.toContain("hunter2secret");
    expect(sent).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(sent).not.toContain("s3cretpass");
    expect(sent).toContain("[REDACTED]");
    expect(sent).toContain("keep Node 20");
  });
});
