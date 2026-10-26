/**
 * The instruction family (0.7.7, docs/how-it-works.md): an answer to the assistant's questions, a pick among its options,
 * a hand-off or a step to take next, with nothing for the project to keep, is not saved whatever the kind choice reads
 * into it; a turn that reverses a listed line still is. Jev is mocked here (test/helpers.ts); the real Jev runs in
 * scripts/eval.mjs on eval/todo-instructions-dev.jsonl and eval/todo-instructions-heldout.jsonl.
 */
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../src/combine.js";
import { decide } from "../src/decide.js";
import { FAMILIES, REPLY_NOUL, TIER1_NOULS, tier1NoulsFor, type Family } from "../src/questions.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { mockJev, SAVE_DECISION, type AnswerOverrides } from "./helpers.js";

const PICK = "Go with option 2, then run the test suite and paste the failures, if any.";
const CHANGE = "The export format is JSON Lines from now on, not CSV; change the writer.";
/** Tier 1 reads a decision into the pick ("go with option 2"); the instruction noul says what it is. */
const pickedOption: AnswerOverrides = { ...SAVE_DECISION, is_an_instruction_for_this_conversation: 0.9, answers_or_picks_among_the_assistants_options: 0.9, directs_the_assistants_next_step_only: 0.8, states_nothing_that_outlasts_the_conversation: 0.9 };
const families = (over: Partial<Record<Family, number>>) => Object.fromEntries(FAMILIES.map((f) => [f, over[f] ?? 0])) as Record<Family, number>;

describe("the instruction family", () => {
  it("is one broad noul in tier 1, asked with or without the reply, and three atomic nouls in tier 2", () => {
    expect(TIER1_NOULS.filter((n) => n.family === "instruction").map((n) => n.name)).toEqual(["is_an_instruction_for_this_conversation"]);
    expect(tier1NoulsFor(false).some((n) => n.family === "instruction")).toBe(true);
    expect(DEFAULT_CONFIG.thresholds.instructionMax).toBe(0.5);
  });

  it("an answer or pick for this conversation is skipped, though tier 1 reads a decision into it", async () => {
    const jev = mockJev(() => pickedOption);
    const d = await decide(jev, { userMessage: PICK, assistantReply: "Done: option 2 is in, the suite passes.", existingMemories: [] });
    expect(d.save).toBe(false);
    expect(d.reason).toContain("instruction=0.90");
    expect(d.families.instruction).toBe(0.9);
  });

  it("under the threshold the turn is decided as before, at tier 1 (the noul is not an escalation reason)", async () => {
    const quiet = { ...pickedOption, is_an_instruction_for_this_conversation: 0.2, answers_or_picks_among_the_assistants_options: 0.2, directs_the_assistants_next_step_only: 0.2, states_nothing_that_outlasts_the_conversation: 0.2 };
    const jev = mockJev(() => quiet);
    const d = await decide(jev, { userMessage: CHANGE, existingMemories: [] });
    expect(jev.calls).toHaveLength(1);
    expect(d.save).toBe(true);
    expect(d.kind).toBe("decision");
  });

  it("a request is an instruction too: what its reply found is still saved from the reply", async () => {
    // The reply question (0.6.6) reads the reply; the dead end comes from it with source assistant_reply, and the user's
    // instruction score does not gate it.
    const failed: AnswerOverrides = { ...pickedOption, contains_dead_end: 0.95, tried_an_approach_that_failed_or_was_dropped: 0.95, kind: "dead-end", importance: 3, content_source: "assistant_reply", assistant_reply_is_meta: 0.05 };
    const jev = mockJev((q, state: any) => (REPLY_NOUL in q ? { [REPLY_NOUL]: 0.9 } : "assistant_reply" in state ? failed : pickedOption));
    const d = await decide(jev, { userMessage: "Switch the thumbnail decoder to the new library on the detail screen.", assistantReply: "I switched it and frames dropped badly because it decoded the originals at full size, so the old decoder is back.", existingMemories: [] });
    expect(d.save).toBe(true);
    expect(d.kind).toBe("dead-end");
    expect(d.source).toBe("assistant_reply");
    // The policy alone: the gate applies to the user's words only.
    const t = DEFAULT_CONFIG.thresholds;
    expect(evaluatePolicy({ kindChoice: "bug", importanceScore: 3, families: families({ bug: 0.9, instruction: 0.9 }), touchesMemoryId: "none", source: "assistant_reply" }, t).save).toBe(true);
    expect(evaluatePolicy({ kindChoice: "decision", importanceScore: 3, families: families({ decision: 0.9, instruction: 0.9 }), touchesMemoryId: "none", source: "user_message" }, t).save).toBe(false);
  });

  it("a change of plan phrased as an order still reverses the listed line", async () => {
    const jev = mockJev(() => ({ ...pickedOption, contradicts_existing_memory: 0.9, reverses_or_replaces_a_listed_memory: 0.9, touches_memory_id: "m1" }));
    const d = await decide(jev, { userMessage: CHANGE, existingMemories: [{ id: "m1", kind: "decision", text: "Exports are CSV files" }] });
    expect(d.save).toBe(true);
    expect(d.contradiction).toBe(true);
    expect(d.touchesMemoryId).toBe("m1");
  });

  it("the policy: at instructionMax the turn is skipped, just under it saved; a config without the key uses 0.5", () => {
    const t = DEFAULT_CONFIG.thresholds;
    const input = (instruction: number) => ({ kindChoice: "decision", importanceScore: 3, families: families({ decision: 0.9, instruction }), touchesMemoryId: "none" });
    expect(evaluatePolicy(input(0.5), t).save).toBe(false);
    expect(evaluatePolicy(input(0.49), t).save).toBe(true);
    const old = { ...t } as Partial<typeof t>;
    delete old.instructionMax;
    expect(evaluatePolicy(input(0.5), old as typeof t).save).toBe(false);
    expect(evaluatePolicy(input(0.6), { ...t, instructionMax: 0.7 }).save).toBe(true);
  });
});
