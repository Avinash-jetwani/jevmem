/**
 * The reply question (0.6.6, docs/how-it-works.md): on a turn whose reply the state would not hold, one small request
 * beside the usual one asks whether Claude's reply says something tried in this turn failed and why; at REPLY_MIN the
 * turn is decided again with the reply, so a failed attempt is saved as a dead end from the reply and the request is
 * not saved as a decision. It is asked only on a request to try or change something (looksLikeRequest). A dead end from
 * the user's own message is kept; every other answer stays what it was. Jev is mocked here (test/helpers.ts); the real
 * Jev runs in scripts/eval-attempts.mjs.
 */
import { describe, expect, it } from "vitest";
import { decide, looksLikeRequest, REPLY_CHARS, REPLY_MIN } from "../src/decide.js";
import { REPLY_NOUL } from "../src/questions.js";
import { mockJev, SAVE_DECISION, T1_QUIET, type AnswerOverrides } from "./helpers.js";

const DEAD_END: AnswerOverrides = { ...T1_QUIET, contains_dead_end: 0.95, tried_an_approach_that_failed_or_was_dropped: 0.95, kind: "dead-end", importance: 3, content_source: "assistant_reply", assistant_reply_is_meta: 0.05 };
const REQUEST = "Switch the thumbnail decoder to the new library on the detail screen.";
const FAILED = "I switched it and scrolled the gallery once, and frames dropped badly because it decoded the originals at full size, so the old decoder is back.";
const DONE = "Done: the detail screen decodes thumbnails with the new library, and the gallery test passes.";
/** Answers by request: the reply question gets `reply`, a request whose state holds the reply gets `withReply`, the rest `plain`. */
const answers = (reply: number, plain: AnswerOverrides, withReply: AnswerOverrides = plain) =>
  mockJev((q, state: any) => (REPLY_NOUL in q ? { [REPLY_NOUL]: reply } : "assistant_reply" in state ? withReply : plain));
const replyCalls = (jev: ReturnType<typeof mockJev>) => jev.calls.filter((c) => REPLY_NOUL in c.questions);
const usualCalls = (jev: ReturnType<typeof mockJev>) => jev.calls.filter((c) => !(REPLY_NOUL in c.questions));

describe("the reply question", () => {
  it("is one small request beside the usual one, with the user's message and the reply's first 2,000 characters, and nothing else", async () => {
    const jev = answers(0.1, SAVE_DECISION);
    const d = await decide(jev, { userMessage: REQUEST, assistantReply: DONE, existingMemories: [{ id: "m1", kind: "decision", text: "Thumbnails are 200 px wide" }] });
    expect(jev.calls).toHaveLength(2);
    const [usual, small] = jev.calls;
    expect(Object.keys(small!.questions)).toEqual([REPLY_NOUL]);
    expect(small!.state).toEqual({ user_message: REQUEST, assistant_reply: DONE });
    expect(small!.opts).toMatchObject({ label: "decide", tier: 1 });
    expect((usual!.state as any).assistant_reply).toBeUndefined();
    expect((usual!.state as any).existing_memories).toHaveLength(1);
    // An attempt that worked is still the user's decision, as before.
    expect(d.save).toBe(true);
    expect(d.kind).toBe("decision");
    expect(d.assistantIncluded).toBe(false);
    expect(d.replyNoul).toBe(0.1);
    expect(d.reason).toContain("[reply question: 0.10, the reply not read]");
    // The small request's tokens count toward the turn.
    expect(d.usage.inputTokens).toBe(1000);
  });

  it("at REPLY_MIN the turn is decided again with the reply, and a failed attempt is a dead end from the reply, not the request", async () => {
    const jev = answers(0.9, SAVE_DECISION, DEAD_END);
    const d = await decide(jev, { userMessage: REQUEST, assistantReply: FAILED, existingMemories: [] });
    expect(usualCalls(jev)).toHaveLength(2);
    expect(replyCalls(jev)).toHaveLength(1);
    expect((usualCalls(jev)[1]!.state as any).assistant_reply).toBe(FAILED);
    expect(d.save).toBe(true);
    expect(d.kind).toBe("dead-end");
    expect(d.source).toBe("assistant_reply");
    expect(d.sourceText).toBe(FAILED);
    expect(d.assistantIncluded).toBe(true);
    expect(d.replyNoul).toBe(0.9);
    expect(d.reason).toContain("the reply read");
    expect(d.usage.inputTokens).toBe(1500);
    expect(REPLY_MIN).toBe(0.5);
    const edge = await decide(answers(REPLY_MIN, SAVE_DECISION, DEAD_END), { userMessage: REQUEST, assistantReply: FAILED, existingMemories: [] });
    expect(edge.kind).toBe("dead-end");
    const under = await decide(answers(REPLY_MIN - 0.01, SAVE_DECISION, DEAD_END), { userMessage: REQUEST, assistantReply: FAILED, existingMemories: [] });
    expect(under.kind).toBe("decision");
  });

  it("a dead end the user's own message gives is kept, whatever the reply question says", async () => {
    const own: AnswerOverrides = { ...T1_QUIET, contains_dead_end: 0.95, tried_an_approach_that_failed_or_was_dropped: 0.95, kind: "dead-end", importance: 3 };
    const jev = answers(0.95, own, SAVE_DECISION);
    const d = await decide(jev, { userMessage: "Switch the job queue back to Postgres: SQS added 300 ms per job, so we rolled it back last week.", assistantReply: "Done: the queue is on Postgres again, and the SQS branch is deleted.", existingMemories: [] });
    expect(usualCalls(jev)).toHaveLength(1);
    expect(d.kind).toBe("dead-end");
    expect(d.source).toBe("user_message");
    expect(d.reason).toContain("a dead end from the user's message kept");
  });

  it("is asked only on a request to try or change something: not on a statement, a to-do or a bug report", async () => {
    for (const u of ["Try Coil for the plant photos in place of Glide.", "See if a worker pool helps the import.", "Give util.parseArgs a go for the option parsing.", "Have a go at polling the stations one after another.", "Switch the thumbnail decoder to the new library.", "Use the native Promise.try for the task call.", "Turn on slots for the Page dataclass.", "Let's order the categories with localeCompare from now on.", "We're going to talk HTTP/2 to the gateways; go ahead and move the client.", "ok, please replace the pool with a plain Promise.all", "Can you bump Tailwind to 4.1?"]) expect(looksLikeRequest(u), u).toBe(true);
    for (const u of ["For search we'll adopt Meilisearch; Algolia's pricing doesn't work at our volume.", "Going forward, recipe IDs are ULIDs, not auto-increment integers.", "Note for later: once the gateways are on firmware 3 the readings will carry a pressure field.", "The report prints EUR 7.5600000000000005 for a 3-zone trip.", "thanks, that's all", "Never log the carrier API key."]) expect(looksLikeRequest(u), u).toBe(false);
    const statement = answers(0.9, SAVE_DECISION, DEAD_END);
    const d = await decide(statement, { userMessage: "Going forward, recipe IDs are ULIDs, not auto-increment integers.", assistantReply: FAILED, existingMemories: [] });
    expect(statement.calls).toHaveLength(1);
    expect(d.replyNoul).toBeUndefined();
  });

  it("is not asked when the usual request already holds the reply (a question, an attempt in known words, a live dead end), when there is no reply, or when the setting is off", async () => {
    const question = answers(0.9, DEAD_END);
    await decide(question, { userMessage: "Why does the gallery stutter?", assistantReply: FAILED, existingMemories: [] });
    expect(replyCalls(question)).toHaveLength(0);
    expect((question.calls[0]!.state as any).assistant_reply).toBe(FAILED);
    const known = answers(0.9, DEAD_END);
    await decide(known, { userMessage: REQUEST, assistantReply: "I tried it; it stuttered, so I reverted it.", existingMemories: [] });
    expect(replyCalls(known)).toHaveLength(0);
    const silent = answers(0.9, SAVE_DECISION);
    await decide(silent, { userMessage: "We're going with the new decoder.", assistantReply: "", existingMemories: [] });
    expect(silent.calls).toHaveLength(1);
    const off = answers(0.9, SAVE_DECISION, DEAD_END);
    const d = await decide(off, { userMessage: REQUEST, assistantReply: FAILED, existingMemories: [] }, { askAboutReply: false });
    expect(off.calls).toHaveLength(1);
    expect(d.kind).toBe("decision");
    expect(d.replyNoul).toBeUndefined();
  });

  it("sends the reply's first 2,000 characters, scrubbed", async () => {
    const jev = answers(0.1, SAVE_DECISION);
    const long = `The key is sk-${"a".repeat(48)} and then ${"a word ".repeat(500)}`;
    await decide(jev, { userMessage: REQUEST, assistantReply: long, existingMemories: [] });
    const sent = (replyCalls(jev)[0]!.state as any).assistant_reply as string;
    expect(sent.length).toBe(REPLY_CHARS);
    expect(sent).toContain("[REDACTED]");
    expect(sent).not.toContain("sk-aaaa");
  });
});
