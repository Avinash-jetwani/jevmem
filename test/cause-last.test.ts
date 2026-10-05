/**
 * Replies that give the verdict first and the cause last (0.6.5). In the 0.6.5 release gate's first full run
 * (2026-10-04) three of six dead-end lines lost their reason: Claude's reply opened with "It didn't work, so I'm
 * dropping the idea …", then said what it ran and why it failed in one long sentence, and the line was those two
 * sentences cut before the cause. Jev had answered the reason question with the attempt's own sentence (0.88), and the
 * writer took the runner-up, the verdict at 0.06, as "the reason". The replies below are that run's and the second
 * run's, as the harness logged them; Jev is a mock that answers as Jev did (test/helpers.ts).
 */
import { describe, expect, it } from "vitest";
import { composeDeadEnd, extractWorksNow } from "../src/llm/index.js";
import { candidateSentences, OTHER_REASON_MIN, pickSentences } from "../src/pick.js";
import { composeLine } from "../src/write.js";
import { mockJev, type AnswerOverrides } from "./helpers.js";

const writer = { provider: "none" as const, maxChars: 200, timeoutMs: 1000 };
/** A mock that answers the pick's two questions: the main sentence, and the reason question's probabilities. */
const picks = (main: string, reason: Record<string, number>) =>
  mockJev((q): AnswerOverrides => {
    if (!("states_the_memory" in q)) return {};
    const choice = Object.entries(reason).sort((a, b) => b[1] - a[1])[0]![0];
    return { states_the_memory: main, gives_the_reason: { choice, probabilities: reason } };
  });

// The first run's supersede scenario, session 1 (the whole reply fits in the harness's log).
const RUN1 = "It didn't work, so I'm dropping the idea and leaving the tsc build and all files unchanged. I ran `node --experimental-strip-types src/app.ts` on Node 22, and it failed immediately because the file declares a TypeScript enum, which strip-only mode rejects since enums need real transformation rather than type erasure.";
// The second run, as the hook passes a turn: the text before the tool call, then the final message.
const RUN2_SHORT =
  "I'll run the file once with Node's type-stripping flag and report the result.\nIt didn't work, so I'm dropping the idea with no files changed. I ran `node --experimental-strip-types src/app.ts` on Node 22, and it failed immediately with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` because the file declares a TypeScript `enum`, which strip-only mode cannot handle. The tsc build into dist/ stays as is.";
const RUN2_LONG =
  "I'll check the Node version, then try running the file directly once.\nDropping the idea; no files changed and the tsc build stays as is.\n\nI ran `node --experimental-strip-types src/app.ts` on Node v22.22.0 and it failed immediately with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, because the file declares a TypeScript `enum` at line 1 and strip-only mode cannot handle enums. Getting it to work would require either rewriting the enum as a plain object or using the transform flag, both of which are changes you asked me not to make.";

describe("the pick: a runner-up is not a reason", () => {
  it("when Jev's first answer to the reason question is the main sentence, another sentence needs real support", async () => {
    const s = candidateSentences(RUN1, { fromReply: true });
    expect(s.map((x) => x.id)).toEqual(["s1", "s2"]);
    // As Jev answered: the attempt's sentence holds its own reason; the verdict and "none" share what is left.
    const asJev = await pickSentences(picks("s2", { s2: 0.89, s1: 0.07, none: 0.04 }), s, "dead-end");
    expect(asJev).toMatchObject({ main: "s2", second: null, chosen: ["s2"], ownReason: true });
    // Just under and at the floor.
    expect((await pickSentences(picks("s2", { s2: 0.7, s1: OTHER_REASON_MIN - 0.01, none: 0.11 }), s, "dead-end")).second).toBeNull();
    expect(await pickSentences(picks("s2", { s2: 0.7, s1: OTHER_REASON_MIN, none: 0.1 }), s, "dead-end")).toMatchObject({ second: "s1", chosen: ["s1", "s2"], ownReason: true });
    // Jev's first answer is another sentence: it is the reason at any probability above "none", as before.
    const other = await pickSentences(picks("s2", { s1: 0.15, none: 0.1, s2: 0.05 }), s, "dead-end");
    expect(other).toMatchObject({ second: "s1" });
    expect(other.ownReason).toBeUndefined();
  });
});

describe("a dead end keeps its reason when the reply puts the cause last", () => {
  it("the gate's replies: the line is the attempt with its cause, not the verdict and half the attempt", async () => {
    const r1 = await composeLine(RUN1, "dead-end", { writer, jev: picks("s2", { s2: 0.89, s1: 0.07, none: 0.04 }) }, { fromReply: true });
    expect(r1.line).toBe("I ran `node --experimental-strip-types src/app.ts` on Node 22, and it failed immediately because the file declares a TypeScript enum");
    const r2 = await composeLine(RUN2_SHORT, "dead-end", { writer, jev: picks("s3", { s3: 0.89, s2: 0.07, none: 0.04 }) }, { fromReply: true });
    expect(r2.line).toBe("I ran `node --experimental-strip-types src/app.ts` on Node 22, and it failed immediately with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` because the file declares a TypeScript `enum`");
    for (const r of [r1, r2]) {
      expect(r.line.length).toBeLessThanOrEqual(200);
      expect(r.line).not.toMatch(/dropping the idea|…$/);
    }
  });

  it("the attempt leads when the picked sentences do not fit as written, whichever sentence Jev named as the reason", async () => {
    // Jev names the verdict as the reason with real support: both are picked, in text order, and do not fit in 200.
    const r = await composeLine(RUN1, "dead-end", { writer, jev: picks("s2", { s2: 0.55, s1: 0.4, none: 0.05 }) }, { fromReply: true });
    expect(r.pick).toMatchObject({ chosen: ["s1", "s2"], main: "s2", second: "s1" });
    expect(r.line).toMatch(/^I ran `node --experimental-strip-types src\/app\.ts` on Node 22/);
    expect(r.line).toContain("because the file declares a TypeScript enum");
    // Sentences that fit stay as written, in text order.
    const fits = "It was no use. I ran the linter with the new preset once, and it flagged 40 files because the preset bans default exports.";
    const f = await composeLine(fits, "dead-end", { writer, jev: picks("s2", { s2: 0.5, s1: 0.4, none: 0.1 }) }, { fromReply: true });
    expect(f.line).toBe(fits);
    expect(composeDeadEnd(["It was no use.", "I ran the linter once."], 200, { main: 1, ownReason: true })).toBe("It was no use. I ran the linter once.");
    // With the reason in the other sentence (Jev's first answer was not the main one), text order stays even when they do not fit.
    const mess = "Delta compression has been a mess: one dropped packet desyncs a client until the next full state, and players on mobile networks see rubber-banding every few seconds.";
    const moves = "Match state moves to full snapshots at 20 Hz with client-side interpolation.";
    expect(composeDeadEnd([mess, moves], 200, { main: 1, ownReason: false })).toBe(composeDeadEnd([mess, moves], 200));
    expect(composeDeadEnd([mess, moves], 200, { main: 1, ownReason: false })).toMatch(/^Delta compression has been a mess: one dropped packet desyncs a client/);
  });

  it("an attempt sentence longer than the line keeps its cause: cut at the cause's own clause end, or what was tried and the cause after a colon", async () => {
    // The second run's long reply: 232 characters in the attempt's sentence, the cause last, no clause end inside it.
    const long = await composeLine(RUN2_LONG, "dead-end", { writer, jev: picks("s3", { s3: 0.7, s4: 0.25, none: 0.03, s2: 0.02 }) }, { fromReply: true });
    expect(long.line).toBe("I ran `node --experimental-strip-types src/app.ts` on Node v22.22.0 and it failed immediately with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, because the file declares a TypeScript `enum` at line 1");
    // The text before the cause leaves it no room: what was tried, then the cause after a colon.
    const crowded = "I ran the whole export through the new streaming encoder on the staging box with compression switched on and it failed after about twenty minutes of steady progress, because the encoder holds every open file handle until the end of the run.";
    expect(composeDeadEnd([crowded], 200, { main: 0, ownReason: true })).toBe("I ran the whole export through the new streaming encoder on the staging box with compression switched on: the encoder holds every open file handle until the end of the run");
    // The cause has a clause end of its own: the sentence stays as written up to it.
    const two = "I pointed the importer at the nightly dump once and it stopped after forty minutes with an out-of-memory kill from the kernel, because the parser keeps every row in a list and the dump has grown to nine million rows this year.";
    expect(composeDeadEnd([two], 200, { main: 0, ownReason: true })).toBe("I pointed the importer at the nightly dump once and it stopped after forty minutes with an out-of-memory kill from the kernel, because the parser keeps every row in a list");
    // ", since" after a comma is a cause; "since" that dates something is not.
    const since = "I moved the session store to the edge cache for one deploy and logins started failing for a third of users within the hour, since the cache drops keys under memory pressure and gives no warning when it does so at all.";
    expect(composeDeadEnd([since], 200, { main: 0, ownReason: true })).toContain("since the cache drops keys under memory pressure");
    const dated = "I ran the report against the archive we have kept since 2019 with the new index in place and every query in the suite came back slower than before by a wide margin on both the small and the large tenants we host today.";
    expect(composeDeadEnd([dated], 200, { main: 0, ownReason: true })).toMatch(/…$/);
  });

  it("with the reason in another sentence, that sentence keeps its room", () => {
    // "because" here is why it was tried; Jev named the next sentence as the reason, so nothing is rearranged.
    const tried = "We tried rayon's par_bridge on the merge step because profiling showed that path was the hottest.";
    const why = "It made each merge four times faster, but the pool stole cores from the tick thread and frames started arriving late.";
    const want = "We tried rayon's par_bridge on the merge step because profiling showed that path was the hottest. The pool stole cores from the tick thread and frames started arriving late.";
    expect(`${tried} ${why}`.length).toBeGreaterThan(200);
    expect(composeDeadEnd([tried, why], 200, { main: 0, ownReason: false })).toBe(want);
    expect(composeDeadEnd([tried, why], 200)).toBe(want);
  });
});

describe("a line that makes a dead end work keeps what was changed", () => {
  const DEAD_END = "I ran `node --experimental-strip-types src/app.ts` on Node 22, and it failed immediately with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`";

  it("the statement leads, not a plan Claude wrote before the work", async () => {
    // The second run's supersede scenario, session 2, as the hook passes it (shortened to the sentences that matter).
    const turn =
      "The only blocker is the `enum`, which strip-only mode rejects. I'll replace it with a `const` object plus a derived union type, which is erasable and keeps the same call sites.\nI replaced the `enum Unit` in `src/app.ts` with a `const` object plus a derived `Unit` union type, because strip-only mode rejects enums as non-erasable syntax while leaving the call sites and output unchanged.";
    const r = await composeLine(turn, "decision", { writer, jev: picks("s3", { s3: 0.48, s2: 0.44, none: 0.03, s1: 0.05 }) }, { fromReply: true, worksNow: true, deadEnd: DEAD_END });
    expect(r.pick).toMatchObject({ chosen: ["s2", "s3"], main: "s3" });
    expect(r.line).toMatch(/^I replaced the `enum Unit` in `src\/app\.ts` with a `const` object plus a derived `Unit` union type/);
    expect(r.line).not.toContain("I'll replace it");
  });

  it("a sentence that says what was changed last, after \", so\", keeps that clause", async () => {
    // The first run's superseding reply: its line was this sentence cut before "so I replaced it".
    const blocker =
      "The `enum` in src/app.ts was the blocker, since `--experimental-strip-types` only erases type annotations and refuses to transform enums, so I replaced it with an `as const` object plus a derived `Unit` union type, which gives the same `Unit.Seconds` and `Unit.Minutes` values and the same type safety.";
    const want = "The `enum` in src/app.ts was the blocker, so I replaced it with an `as const` object plus a derived `Unit` union type";
    expect(extractWorksNow(blocker, 200, DEAD_END, [blocker], { main: 0, ownReason: true })).toBe(want);
    const r = await composeLine(`The underlying command already ran successfully above. ${blocker}`, "decision", { writer, jev: picks("s2", { s2: 0.8, s1: 0.1, none: 0.1 }) }, { fromReply: true, worksNow: true, deadEnd: DEAD_END });
    expect(r.line).toBe(want);
    expect(r.line.length).toBeLessThanOrEqual(200);
    // Sentences that fit are left as they are.
    expect(extractWorksNow("x", 200, DEAD_END, ["The enum was the blocker, so I replaced it with a const object."], { main: 0, ownReason: true })).toBe("The enum was the blocker, so I replaced it with a const object.");
  });
});
