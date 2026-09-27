/**
 * v0.6 part 2c (docs/dead-ends.md): the content-source question asks which side states something, so a plain statement
 * whose reply adds nothing is saved and a question nobody decides is still skipped; a listed dead end tried again that
 * fails again is not saved twice (the same reason) or is one line with both reasons that replaces it (a new reason);
 * the reversal wording; the local writer keeps the reason after "but"; `jevmem add` is offline for every kind (in
 * test/dead-ends.test.ts). Jev is mocked (test/helpers.ts); the real Jev runs in scripts/eval-dead-ends.mjs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli-main.js";
import { evaluatePolicy, supersedeTarget } from "../src/combine.js";
import { decide, NEW_REASON_MIN } from "../src/decide.js";
import { runHook } from "../src/hook.js";
import { init } from "../src/init.js";
import { combineRetest, extractDeadEnd } from "../src/llm/index.js";
import { buildDecideQuestions, buildTier1Questions, NEW_REASON_NOUL, RETEST_CHOICE, RETEST_NOUL, SOURCE_QUESTION, WORKS_NOW_CHOICE, WORKS_NOW_NOUL } from "../src/questions.js";
import { MemoryStore } from "../src/store.js";
import { DEFAULT_CONFIG, type Memory } from "../src/types.js";
import { composeLine, RETEST_WRITER_NOTE } from "../src/write.js";
import { mockJev, T1_QUIET, type AnswerOverrides } from "./helpers.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-2c-"));
const env = { JEVMEM_WRITER: "none" } as NodeJS.ProcessEnv;
function project() {
  const root = tmp();
  init({ root, hooks: false });
  return { root, store: new MemoryStore(root) };
}
const t = DEFAULT_CONFIG.thresholds;
const fam = (over: Partial<Record<string, number>> = {}) => ({ decision: 0.1, constraint: 0.1, preference: 0.1, bug: 0.1, architecture: 0.1, todo: 0.1, "dead-end": 0.95, chit_chat: 0.02, injection: 0.02, contradiction: 0.05, meta: 0.05, ...over }) as any;

const GZIP = "Brotli for the tile responses: the CDN re-compressed them and edge CPU doubled, so tiles stay on gzip";
const DEAD_END: AnswerOverrides = { ...T1_QUIET, contains_dead_end: 0.95, kind: "dead-end", importance: 3 };

describe("the content-source question asks which side states something", () => {
  it("names what counts, scopes none to chatter and undecided questions, and is asked only with the reply, in both tiers", () => {
    expect(SOURCE_QUESTION).toBe("Which side of the turn states something for this project: a decision, rule, preference, bug, structure fact, failed approach, or work for later?");
    for (const q of [buildTier1Questions([], { withAssistant: true }) as Record<string, any>, buildDecideQuestions([], { examplesPerSide: 1, withAssistant: true }) as Record<string, any>]) {
      expect(q.content_source.instructions).toBe(SOURCE_QUESTION);
      expect(Object.keys(q.content_source.criteria)).toEqual(["user_message", "assistant_reply", "both", "none"]);
      expect(q.content_source.criteria.user_message.what).toMatch(/only acknowledges it, carries it out, or records it/);
      expect(q.content_source.criteria.none.what).toMatch(/^Neither side states anything for the project: thanks or chatter, or a question, proposal or list of options that nobody decides/);
      // No "memorable" or "worth remembering" left: whether a turn is worth keeping is the other questions' job.
      expect(JSON.stringify(q.content_source)).not.toMatch(/memorable|worth remembering/);
    }
    expect(Object.keys(buildTier1Questions([], { withAssistant: false }))).not.toContain("content_source");
  });

  it("a plain to-do acknowledged with a bare reply is saved (source user_message); an undecided proposal is still skipped (source none)", async () => {
    const { root, store } = project();
    const todo = mockJev(() => ({ ...T1_QUIET, contains_todo: 0.93, kind: "todo", importance: 2, content_source: "user_message" }));
    const r1 = await runHook({ hook_event_name: "Stop", cwd: root, user_message: "Before the beta, fix the upload retry that hangs on flaky hotel wifi.", assistant_message: "Will do." }, { jev: todo, env });
    expect(r1.action).toBe("saved");
    expect(todo.calls[0]!.state).toHaveProperty("assistant_reply", "Will do."); // "hangs" sends the reply, so the question is asked
    const q = mockJev(() => ({ ...T1_QUIET, contains_decision: 0.8, kind: "decision", importance: 3, content_source: "none" }));
    const r2 = await runHook({ hook_event_name: "Stop", cwd: root, user_message: "maybe the tiles could be served from R2 instead? thoughts", assistant_message: "R2 would cut egress costs, but the cache rules would need rewriting." }, { jev: q, env });
    expect(r2.action).toBe("skipped");
    expect(r2.detail).toMatch(/source=none/);
    expect(store.active().map((m) => m.kind)).toEqual(["todo"]);
  });
});

describe("a listed dead end tried again that fails again", () => {
  const mems: Pick<Memory, "id" | "kind" | "text">[] = [{ id: "d1", kind: "decision", text: "Tiles are served from the Go server behind the CDN" }, { id: "x1", kind: "dead-end", text: GZIP }];

  it("the retest nouls and their choice are asked with the works-now ones, only when a live dead end is listed, in the request each tier makes", () => {
    for (const q of [buildTier1Questions(mems) as Record<string, any>, buildDecideQuestions(mems, { examplesPerSide: 1 }) as Record<string, any>]) {
      expect(q[RETEST_NOUL].type).toBe("noul");
      expect(q[RETEST_NOUL].instructions).toMatch(/tried again and still failed, for the same reason or a new one\?$/);
      expect(q[NEW_REASON_NOUL].instructions).toMatch(/a reason the approach failed this time that the listed dead-end memory does not already give\?$/);
      expect(Object.keys(q[RETEST_CHOICE].criteria)).toEqual(["x1", "none"]);
      expect(Object.keys(q[WORKS_NOW_CHOICE].criteria)).toEqual(["x1", "none"]);
    }
    for (const n of [RETEST_NOUL, RETEST_CHOICE, NEW_REASON_NOUL]) expect(Object.keys(buildTier1Questions([mems[0]!]))).not.toContain(n);
  });

  it("the retest needs contradictionMin and a listed dead end; the same reason is skipped as a dead end or a bug, never another kind", () => {
    const base = { importanceScore: 3, families: fam(), touchesMemoryId: "none", retestId: "x1", retestSame: true };
    const same = evaluatePolicy({ ...base, kindChoice: "dead-end" }, t);
    expect([same.save, same.supersedes]).toEqual([false, null]);
    expect(same.reason).toBe("skip: retest of x1: failed again for the reason it gives (nothing new)");
    expect(evaluatePolicy({ ...base, kindChoice: "bug", families: fam({ bug: 0.9 }) }, t).save).toBe(false);
    // Another kind (a decision made in the same turn) is judged as usual.
    expect(evaluatePolicy({ ...base, kindChoice: "decision", families: fam({ decision: 0.9 }) }, t).save).toBe(true);
    // A new reason supersedes the old line, as a dead end only; works-now comes first.
    expect(supersedeTarget({ ...base, kindChoice: "dead-end", retestSame: false }, t)).toBe("x1");
    expect(supersedeTarget({ ...base, kindChoice: "bug", retestSame: false }, t)).toBeNull();
    expect(supersedeTarget({ ...base, kindChoice: "dead-end", retestSame: false, worksNowId: "x2" }, t)).toBe("x2");
  });

  it("decide reads the answers: id only at contradictionMin with a listed dead-end id; same below NEW_REASON_MIN", async () => {
    const run = (a: AnswerOverrides) => decide(mockJev(() => ({ ...DEAD_END, content_source: "assistant_reply", ...a })), { userMessage: "Try Brotli on the tiles again.", assistantReply: "I tried Brotli again; the CDN still re-compressed the tiles and edge CPU went up again.", existingMemories: mems });
    expect((await run({ [RETEST_NOUL]: 0.6, [RETEST_CHOICE]: "x1", [NEW_REASON_NOUL]: 0.1 })).retest).toEqual({ noul: 0.6, choice: "x1", newReason: 0.1, id: null, same: false });
    expect((await run({ [RETEST_NOUL]: 0.95, [RETEST_CHOICE]: "d1", [NEW_REASON_NOUL]: 0.1 })).retest?.id).toBeNull();
    const same = await run({ [RETEST_NOUL]: 0.95, [RETEST_CHOICE]: "x1", [NEW_REASON_NOUL]: NEW_REASON_MIN - 0.01 });
    expect([same.save, same.retest?.id, same.retest?.same]).toEqual([false, "x1", true]);
    const fresh = await run({ [RETEST_NOUL]: 0.95, [RETEST_CHOICE]: "x1", [NEW_REASON_NOUL]: NEW_REASON_MIN });
    expect([fresh.save, fresh.kind, fresh.contradiction, fresh.touchesMemoryId, fresh.retest?.same]).toEqual([true, "dead-end", true, "x1", false]);
    // A dead end that works now is not also a retest.
    const works = await run({ [WORKS_NOW_NOUL]: 0.95, [WORKS_NOW_CHOICE]: "x1", [RETEST_NOUL]: 0.95, [RETEST_CHOICE]: "x1", [NEW_REASON_NOUL]: 0.9 });
    expect([works.retest, works.worksNow?.id]).toEqual([null, "x1"]);
  });

  it("through the hook: the same reason saves nothing; a new reason is one line with both reasons that replaces the old one, and why says so", async () => {
    const { root, store } = project();
    const de = store.add({ kind: "dead-end", text: GZIP });
    const user = "Try Brotli on the tiles again now that the CDN has a passthrough setting.";
    const same = mockJev(() => ({ ...DEAD_END, content_source: "assistant_reply", [RETEST_NOUL]: 0.96, [RETEST_CHOICE]: de.id, [NEW_REASON_NOUL]: 0.08 }));
    const r1 = await runHook({ hook_event_name: "Stop", cwd: root, user_message: user, assistant_message: "I tried it with passthrough on: the CDN still re-compressed the tiles and edge CPU doubled again. Back on gzip." }, { jev: same, env });
    expect(r1.action).toBe("skipped");
    expect(r1.detail).toMatch(/retest of \w+: failed again for the reason it gives/);
    expect(store.active().map((m) => m.id)).toEqual([de.id]);
    const fresh = mockJev(() => ({ ...DEAD_END, content_source: "assistant_reply", [RETEST_NOUL]: 0.93, [RETEST_CHOICE]: de.id, [NEW_REASON_NOUL]: 0.91 }));
    const reply = "I tried Brotli with passthrough on. The CDN left the tiles alone this time, but Safari 15 on older iPads failed to decode them and showed blank map areas, so the tiles are back on gzip.";
    const r2 = await runHook({ hook_event_name: "Stop", cwd: root, user_message: user, assistant_message: reply }, { jev: fresh, env });
    expect(r2.action).toBe("saved");
    expect(r2.detail).toMatch(new RegExp(`\\(supersedes ${de.id}\\) via fallback$`));
    const live = store.active();
    expect(live.map((m) => m.kind)).toEqual(["dead-end"]);
    expect(live[0]!.text).toBe("Brotli for the tile responses: the CDN re-compressed them and edge CPU doubled; retried: Safari 15 on older iPads failed to decode them and showed blank map areas");
    expect(fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8")).toMatch(/- \[superseded\] Brotli for the tile responses.* → id:\w+/);
    const out: string[] = [];
    await main(["why", live[0]!.id], { out: (x: string) => void out.push(x), err: () => {}, cwd: root } as any);
    expect(out.join("")).toContain(`a listed dead end tried again and failed again: 0.93 (min 0.7), which: ${de.id}, a new reason: 0.91 (min 0.5)  ✓ supersedes ${de.id}, both reasons in the new line`);
  });

  it("the LLM writer gets the earlier line and a note to keep both reasons (stand-in endpoint)", async () => {
    let body: any = null;
    const f = (async (_u: any, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Brotli for tiles: the CDN re-compressed them; retried with passthrough, old Safari could not decode them" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await composeLine("I tried Brotli with passthrough on; old Safari failed to decode the tiles.", "dead-end", { writer: { provider: "openai", model: "gpt-4o-mini", maxChars: 200, timeoutMs: 2000 }, env: { OPENAI_API_KEY: "sk-test" }, fetchImpl: f }, { retestOf: GZIP });
    expect(r.writerUsed).toBe("openai");
    expect(body.messages[1].content).toBe(`Memory kind: dead-end (${RETEST_WRITER_NOTE})\n\nEarlier line: ${GZIP}\n\nMessage:\nI tried Brotli with passthrough on; old Safari failed to decode the tiles.`);
  });
});

describe("the local writer", () => {
  it("a retest line keeps what was tried and both reasons within the limit, cut at clause ends", () => {
    const earlier = "Moving the search index to OpenSearch Serverless: cold queries after idle periods took 9 seconds and the minimum bill was 700 dollars a month, so search stays on Postgres full-text";
    const turn = "I retried OpenSearch Serverless with a warm-up ping. Cold queries are gone, but the indexing lag reached four minutes during bulk imports, so new listings didn't show up in search. Search stays on Postgres.";
    const line = combineRetest(earlier, turn, 200);
    expect(line).toBe("Moving the search index to OpenSearch Serverless: cold queries after idle periods took 9 seconds; retried: the indexing lag reached four minutes during bulk imports");
    expect(line.length).toBeLessThanOrEqual(200);
    // Short enough: both whole, without the closing "so …" of either.
    expect(combineRetest("Brotli for tiles: the CDN re-compressed them, so gzip stays", "I tried Brotli again. The CDN is fine now, but old Safari failed to decode the tiles, so gzip stays.", 200)).toBe("Brotli for tiles: the CDN re-compressed them; retried: old Safari failed to decode the tiles");
  });

  it("a dead end keeps the reason after \"but\" and drops the upside before it when both do not fit", () => {
    const turn = "I tried moving the thumbnail generation to a worker pool of eight processes. Thumbnails came out about three times faster, but the pool held every source image in memory at once and the upload server was killed by the OOM killer twice during the morning batch. Thumbnails stay in the request path with a size cap.";
    const line = extractDeadEnd(turn, 200);
    expect(line).toBe("Moving the thumbnail generation to a worker pool of eight processes. The pool held every source image in memory at once");
    expect(line.length).toBeLessThanOrEqual(200);
    // When everything fits, the upside stays.
    expect(extractDeadEnd("I tried a worker pool for thumbnails. They were faster, but memory ran out twice.", 200)).toBe("A worker pool for thumbnails. They were faster, but memory ran out twice.");
  });
});

describe("reversals: the wording that lets a failed listed approach supersede its line", () => {
  it("the contradiction nouls count a listed approach that failed and is dropped; the bug kind leaves it to dead-end", () => {
    const q1 = buildTier1Questions([{ id: "d1", kind: "decision", text: "Tiles are served from the Go server" }]) as Record<string, any>;
    expect(q1.contradicts_existing_memory.instructions).toBe("Does the user message change, conflict with, or drop one of the existing memories listed in the state, for example because what it states failed?");
    expect(q1.contradicts_existing_memory.criteria.true.what).toMatch(/what a listed memory states kept failing, so it is dropped or replaced/);
    expect(q1.contradicts_existing_memory.criteria.false.what).toMatch(/an alternative to a listed memory that was tried and then undone, which leaves that memory standing/);
    const q2 = buildDecideQuestions([{ id: "d1", kind: "decision", text: "Tiles are served from the Go server" }], { examplesPerSide: 1 }) as Record<string, any>;
    expect(q2.reverses_or_replaces_a_listed_memory.instructions).toMatch(/reverse, replace, or drop something stated .* for example because it failed\?$/);
    expect(q2.kind.criteria.bug.not_for).toMatch(/an approach dropped or replaced because it failed \(dead-end\)/);
    expect(q2.kind.criteria["dead-end"].what).toMatch(/including one a listed memory states that is now dropped or replaced/);
  });
});
