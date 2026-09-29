/**
 * Jev picks the sentences a saved line is made from (v0.6 part 3c, src/pick.ts): one request, only on a turn that is
 * saved; the line is the sentence that states the memory, and the one that gives its reason when both fit. Jev is a
 * mock here (test/helpers.ts); its answers stand in for Jev's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli-main.js";
import { runHook } from "../src/hook.js";
import { composeDeadEnd } from "../src/llm/index.js";
import { candidateSentences, describePick, MAX_SENTENCES, pickRequest, pickSentences } from "../src/pick.js";
import { MemoryStore } from "../src/store.js";
import { composeLine } from "../src/write.js";
import { CHIT_CHAT, mockJev, SAVE_DECISION, T1_QUIET, type AnswerOverrides } from "./helpers.js";

const env = { HOME: "/nonexistent", JEVMEM_DAEMON: "0", TYPESAFE_API_KEY: "test" } as NodeJS.ProcessEnv;
const writer = { provider: "none" as const, maxChars: 200, timeoutMs: 1000 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-pick-"));
/** A mock that answers only the pick's two questions. */
const picker = (main: string, reason = "none") => mockJev((q): AnswerOverrides => ("states_the_memory" in q ? { states_the_memory: main, gives_the_reason: reason } : {}));

describe("candidateSentences", () => {
  it("splits a message into its sentences, with ids in order", () => {
    const s = candidateSentences("The oven double-books when two orders share a minute. Have a subagent look at it.");
    expect(s).toEqual([
      { id: "s1", text: "The oven double-books when two orders share a minute.", from: "user" },
      { id: "s2", text: "Have a subagent look at it.", from: "user" },
    ]);
  });

  it("drops code blocks, bullets, numbers, headings and bold markers; keeps e.g. and version numbers inside a sentence", () => {
    const s = candidateSentences("## Cause\nThe cache is keyed by path, e.g. /tmp/a, in v1.2.3 too.\n```\nrm -rf /\n```\n- **Fixed** the key.\n2. Added a test.");
    expect(s.map((x) => x.text)).toEqual(["Cause", "The cache is keyed by path, e.g. /tmp/a, in v1.2.3 too.", "Fixed the key.", "Added a test."]);
  });

  it("splits a merged turn back into its sides, and a sentence typed in lowercase after a full stop is its own", () => {
    const s = candidateSentences("USER: try the pool. it may help\n\nASSISTANT: I tried the pool. It leaked, so I removed it.");
    expect(s.map((x) => [x.from, x.text])).toEqual([
      ["user", "try the pool."],
      ["user", "it may help"],
      ["assistant", "I tried the pool."],
      ["assistant", "It leaked, so I removed it."],
    ]);
  });

  it("sends at most MAX_SENTENCES, from the text decide judged (the reply cut at 2,000 characters)", () => {
    expect(candidateSentences(Array.from({ length: 100 }, (_, i) => `Sentence number ${i} is here.`).join(" "))).toHaveLength(MAX_SENTENCES);
    const reply = `${"These filler words take up a lot of room in the reply. ".repeat(45)}The real cause is at the end.`;
    expect(candidateSentences(`USER: why?\n\nASSISTANT: ${reply}`).some((x) => /real cause/.test(x.text))).toBe(false);
    // The reply alone (a line whose content came from it): cut at 2,000 too, not at the user message's 6,000.
    expect(candidateSentences(reply, { fromReply: true }).some((x) => /real cause/.test(x.text))).toBe(false);
    expect(candidateSentences(reply).some((x) => /real cause/.test(x.text))).toBe(true);
    expect(candidateSentences("It leaked. I removed it.", { fromReply: true }).map((x) => x.from)).toEqual(["assistant", "assistant"]);
  });
});

describe("the pick's request", () => {
  it("names the kind and what it states, lists the sentences once with bare ids, and asks two choices; only the second has none", () => {
    const { state, questions } = pickRequest(candidateSentences("Use Redis for sessions. The old store dropped logins. Do it now."), "decision") as any;
    expect(state.memory).toEqual({ kind: "decision", states: "the decision made for the project" });
    expect(state.sentences).toEqual([
      { id: "s1", text: "Use Redis for sessions." },
      { id: "s2", text: "The old store dropped logins." },
      { id: "s3", text: "Do it now." },
    ]);
    expect(Object.keys(questions)).toEqual(["states_the_memory", "gives_the_reason"]);
    expect(questions.states_the_memory.criteria).toEqual({ s1: null, s2: null, s3: null });
    expect(questions.states_the_memory.instructions).toMatch(/not as a request, a hand-off or an instruction to the assistant\?$/);
    expect(Object.keys(questions.gives_the_reason.criteria)).toEqual(["s1", "s2", "s3", "none"]);
    expect(questions.gives_the_reason.instructions).toMatch(/^Which other sentence says why it was chosen\?/);
  });

  it("asks a dead end for what was tried, not how it turned out; a turn with both sides says which side each sentence is from", () => {
    const { state, questions } = pickRequest(candidateSentences("USER: Try the pool.\n\nASSISTANT: I tried the pool. It leaked."), "dead-end") as any;
    expect(questions.states_the_memory.instructions).toMatch(/what was tried: the approach itself/);
    expect(questions.gives_the_reason.instructions).toMatch(/why it failed or was dropped/);
    expect(state.sentences[0]).toEqual({ id: "s1", from: "user message", text: "Try the pool." });
    expect(pickRequest(candidateSentences("It works now. I pinned the driver."), "decision", { worksNow: true }).questions.states_the_memory).toMatchObject({ instructions: expect.stringMatching(/what works now that had failed before/) });
  });
});

describe("pickSentences", () => {
  it("one sentence: nothing to ask", async () => {
    const jev = picker("s1");
    const p = await pickSentences(jev, candidateSentences("Use pnpm."), "preference");
    expect(p).toMatchObject({ asked: false, chosen: ["s1"], main: "s1", second: null });
    expect(jev.calls).toHaveLength(0);
  });

  it("the main sentence, and the reason when Jev names one; in text order; the reason is never the main sentence itself", async () => {
    const s = candidateSentences("The collector truncates big batches. Batches stay under 4 MB. Ship it.");
    expect(await pickSentences(picker("s2", "s1"), s, "constraint")).toMatchObject({ asked: true, chosen: ["s1", "s2"], main: "s2", second: "s1" });
    expect(await pickSentences(picker("s2"), s, "constraint")).toMatchObject({ chosen: ["s2"], second: null });
    // Jev may put the main sentence first for the reason too (it holds its own reason): the next most likely answer counts.
    const own = mockJev(() => ({ states_the_memory: "s2", gives_the_reason: { choice: "s2", probabilities: { s1: 0.05, s2: 0.7, s3: 0.05, none: 0.2 } } }));
    expect(await pickSentences(own, s, "constraint")).toMatchObject({ chosen: ["s2"], second: null });
    const next = mockJev(() => ({ states_the_memory: "s2", gives_the_reason: { choice: "s2", probabilities: { s1: 0.25, s2: 0.6, s3: 0.05, none: 0.1 } } }));
    expect(await pickSentences(next, s, "constraint")).toMatchObject({ chosen: ["s1", "s2"], second: "s1" });
  });

  it("is one request, labelled line, within the given budget", async () => {
    const jev = picker("s1");
    await pickSentences(jev, candidateSentences("Keep batches small. This is the rule here."), "constraint", { timeoutMs: 1234 });
    expect(jev.calls.map((c) => [c.opts.label, c.opts.timeoutMs])).toEqual([["line", 1234]]);
  });
});

describe("composeLine with Jev's pick", () => {
  it("a request next to the memory: the line is the memory, not the hand-off", async () => {
    const msg = "ISBN-10s that end in X are reported as invalid. Have a subagent find the cause and fix it.";
    // Without Jev, the words the writer looks for pick the hand-off ("fix"), as in part 3b.
    expect((await composeLine(msg, "bug", { writer })).line).toBe("Have a subagent find the cause and fix it.");
    const r = await composeLine(msg, "bug", { writer, jev: picker("s1") });
    expect(r.line).toBe("ISBN-10s that end in X are reported as invalid.");
    expect(r.writerUsed).toBe("fallback");
    expect(r.pick).toMatchObject({ asked: true, chosen: ["s1"] });
    expect(r.note).toBeUndefined();
  });

  it("keeps the reason when it fits, and leaves it out when both do not fit", async () => {
    const fits = await composeLine("Batches must never exceed 4 MB. The collector truncates anything bigger.", "constraint", { writer, jev: picker("s1", "s2") });
    expect(fits.line).toBe("Batches must never exceed 4 MB. The collector truncates anything bigger.");
    const long = `Every endpoint that changes an order writes an audit row with the user and the old and new values, in the same transaction. ${"The franchise agreement says any owner may ask for the full history of an order at any time, within two days.".repeat(1)}`;
    const r = await composeLine(long, "constraint", { writer, jev: picker("s1", "s2") });
    expect(r.line).toBe("Every endpoint that changes an order writes an audit row with the user and the old and new values, in the same transaction.");
  });

  it("the reason first when it comes first: the sentences stay in the order they were written; filler goes", async () => {
    const r = await composeLine("Decision: bookings now hold the berth for five minutes. Harbour masters kept double-booking by phone.", "decision", { writer, jev: picker("s1", "s2") });
    expect(r.line).toBe("Bookings now hold the berth for five minutes. Harbour masters kept double-booking by phone.");
    const first = await composeLine("Harbour masters kept double-booking by phone. So bookings now hold the berth for five minutes.", "decision", { writer, jev: picker("s2", "s1") });
    expect(first.line).toBe("Harbour masters kept double-booking by phone. So bookings now hold the berth for five minutes.");
  });

  it("a dead end: what was tried and why it failed, through the dead-end fitter (no 'I tried' first)", async () => {
    const reply = "Good idea to check. I tried the bank's JSON API for statements. It gave us same-day data, but it only returns the last 90 days, so SFTP stays.";
    const r = await composeLine(reply, "dead-end", { writer, jev: picker("s2", "s3") });
    expect(r.line).toBe("The bank's JSON API for statements. It gave us same-day data, but it only returns the last 90 days, so SFTP stays.");
  });

  it("a failed request: the line is chosen by the words the writer looks for, and the note says why", async () => {
    const jev = mockJev(() => {
      throw new Error("timeout after 2000 ms");
    });
    const r = await composeLine("Refunds span two statement days. Pass it to a subagent because I'm busy.", "bug", { writer, jev });
    expect(r.line).toBe("Pass it to a subagent because I'm busy.");
    expect(r.pick).toMatchObject({ asked: false, chosen: [], error: "Error: timeout after 2000 ms" });
    expect(r.note).toBe("Jev's pick of the line's sentences failed (Error: timeout after 2000 ms), so the writer chose one by the words it looks for");
  });

  it("an LLM writer's line is used as before, and no pick is asked", async () => {
    const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "Batches stay under 4 MB" }, finish_reason: "stop" }] }), { status: 200 })) as unknown as typeof fetch;
    const jev = picker("s1");
    const r = await composeLine("Batches must never exceed 4 MB. Please check.", "constraint", { writer: { provider: "openai", model: "gpt-4o-mini", maxChars: 200, timeoutMs: 2000 }, env: { OPENAI_API_KEY: "sk-test" }, fetchImpl: f, jev });
    expect([r.line, r.writerUsed, r.pick]).toEqual(["Batches stay under 4 MB", "openai", undefined]);
    expect(jev.calls).toHaveLength(0);
  });
});

describe("the dead-end fitter", () => {
  it("one long sentence with the reason after 'but': what was tried, then the reason; the upside between them goes", () => {
    const s = "Parsing the bank files with a generic CSV library seemed like the fast way to cover all eleven banks, and it handled the big four without trouble in the first week, but three of the smaller banks put thousands separators inside unquoted amount fields and every amount above 999 came out split across two columns.";
    const line = composeDeadEnd([s], 200);
    expect(line).toBe("Parsing the bank files with a generic CSV library seemed like the fast way to cover all eleven banks, but three of the smaller banks put thousands separators inside unquoted amount fields");
    expect(line.length).toBeLessThanOrEqual(200);
    // A sentence that fits is kept whole.
    expect(composeDeadEnd(["Prawn waivers looked fine, but phone signatures came out jagged, so waivers are signed in the browser."], 200)).toBe("Prawn waivers looked fine, but phone signatures came out jagged, so waivers are signed in the browser.");
  });
});

describe("through the hook", () => {
  it("a saved turn gets one pick request after decide; a skipped turn gets none; why names the sentences", async () => {
    const root = tmp();
    const jev = mockJev((q, state: any) => {
      if ("states_the_memory" in q) return { states_the_memory: "s1" };
      return /thanks/.test(state.user_message) ? CHIT_CHAT : SAVE_DECISION;
    });
    const r = await runHook({ hook_event_name: "Stop", cwd: root, user_message: "We are moving tide data to the Admiralty API. Use a subagent to swap the importer over." }, { jev, env });
    expect(r.action).toBe("saved");
    expect(r.detail).toMatch(/^\[decision\] We are moving tide data to the Admiralty API\. id:\w+ via fallback \(sentence s1 of 2, picked by Jev\)$/);
    expect(jev.calls.map((c) => c.opts.label)).toEqual(["decide", "line"]);
    const skipped = await runHook({ hook_event_name: "Stop", cwd: root, user_message: "thanks, looks good" }, { jev, env });
    expect(skipped.action).toBe("skipped");
    expect(jev.calls.map((c) => c.opts.label)).toEqual(["decide", "line", "decide"]);
    const out: string[] = [];
    const id = new MemoryStore(root).active()[0]!.id;
    await main(["why", id], { out: (x: string) => void out.push(x), err: () => {}, cwd: root } as any);
    expect(out.join("")).toContain("line: sentence s1 of 2, picked by Jev");
  });

  it("a failed pick still saves the line, logs why, and doctor's writer failures list it", async () => {
    const root = tmp();
    const jev = mockJev((q) => {
      if ("states_the_memory" in q) throw new Error("socket hang up");
      return { ...T1_QUIET, contains_constraint: 0.95, kind: "constraint", importance: 3 };
    });
    const r = await runHook({ hook_event_name: "Stop", cwd: root, user_message: "Batches must never exceed 4 MB. Only touch the shipper." }, { jev, env });
    expect(r.action).toBe("saved");
    const log = fs.readFileSync(path.join(root, ".jevmem", "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const fallback = log.find((e) => e.event === "writer-fallback");
    expect(fallback).toMatchObject({ label: "writer", ok: false });
    expect(fallback.detail).toMatch(/Jev's pick of the line's sentences failed \(Error: socket hang up\)/);
    expect(describePick({ asked: false, chosen: [], of: 2, error: "Error: socket hang up" })).toMatch(/^Jev's pick failed/);
  });
});
