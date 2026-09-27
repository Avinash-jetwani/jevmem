/**
 * Silent failures made visible (src/failures.ts): `jevmem doctor` and `jevmem stats` show, for the last 7 days and from
 * .jevmem/log.jsonl alone, the turns that were dropped, the recall requests that failed and the guard checks that
 * failed or timed out, each with its reasons.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatFailures, recentFailures } from "../src/failures.js";
import { evaluateGuard } from "../src/guardrail.js";
import { runHook } from "../src/hook.js";
import { init } from "../src/init.js";
import { createJev, readLog, type JevLogEntry } from "../src/jev.js";
import { recordProvenance } from "../src/provenance.js";
import { MemoryStore } from "../src/store.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-failures-")));
const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const entry = (e: Partial<JevLogEntry>): JevLogEntry => ({ ts: at(1), label: "hook", ok: true, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, ...e });

describe("recentFailures", () => {
  it("counts drops, failed recalls and failed guard checks from the last 7 days, grouped by reason", () => {
    const syntax = (pos: number) => `SyntaxError: Expected ',' or '}' after property value in JSON at position ${pos} (line 1 column ${pos + 1})`;
    const f = recentFailures(
      [
        entry({ ts: at(3), label: "queue", event: "dropped", detail: `not retryable: ${syntax(58)}` }),
        entry({ ts: at(2), label: "queue", event: "dropped", detail: `not retryable: ${syntax(173)}` }),
        // The same drop logged again by runHook (jevmem watch) as the hook's error: counted once.
        entry({ ts: at(2), label: "hook", ok: false, error: `Stop: ${syntax(173)}` }),
        entry({ ts: at(5), label: "queue", event: "dropped", detail: "older than 24 h (7 failed attempt(s); last error: APIConnectionTimeoutError: Request timed out.)" }),
        entry({ ts: at(4), label: "hook", ok: false, error: "Stop: TYPESAFE_API_KEY not set (checked the plugin setting, env, .jevmem/.env, ~/.jevmem/env); jevmem skipped" }),
        entry({ ts: at(4), label: "hook", ok: false, error: "Stop: empty turn (source: transcript-unreadable, transcript missing)" }),
        entry({ ts: at(4), label: "hook", ok: false, error: "Stop: empty turn (source: transcript, transcript exists)" }), // nothing to save: not a drop
        entry({ ts: at(4), label: "hook", ok: false, error: "Stop: gate check of new rules for the guard failed: fetch failed" }),
        entry({ ts: at(1), label: "hook", ok: false, error: `UserPromptSubmit: ${syntax(136)}` }),
        entry({ ts: at(1), label: "recall", ok: false, questions: 2, error: "APIConnectionError: fetch failed" }), // createJev's line
        entry({ ts: at(1), label: "hook", ok: false, error: "UserPromptSubmit: APIConnectionError: fetch failed" }),
        entry({ ts: at(6), label: "guard", ok: false, error: "Jev check failed, no decision: Error: timed out after 941 ms (guard.budgetMs)" }),
        entry({ ts: at(6), label: "guard", ok: false, error: "Jev check failed, no decision: Error: timed out after 958 ms (guard.budgetMs)" }),
        entry({ ts: at(6), label: "guard", ok: false, questions: 1, error: "APIConnectionTimeoutError: Request timed out." }), // createJev's line
        entry({ ts: at(7), label: "guard", ok: false, error: "no TypeSafe API key (checked the plugin setting, env, .jevmem/.env, ~/.jevmem/env): no decision" }),
        // Not failures, or too old.
        entry({ ts: at(1), label: "queue", event: "queued", detail: "Jev failed (...)" }),
        entry({ ts: at(1), label: "guard", event: "guard", detail: "ask Bash: r1 p=0.91" }),
        entry({ ts: at(1), label: "decide", ok: true, questions: 12 }),
        entry({ ts: at(8 * 24), label: "queue", event: "dropped", detail: "not retryable: old" }),
      ],
      { now: NOW },
    );
    expect([f.dropped.count, f.recall.count, f.guard.count, f.other.count]).toEqual([5, 2, 3, 1]);
    expect(f.dropped.reasons.map((r) => [r.count, r.latest])).toEqual([
      [2, `not retryable: ${syntax(173)}`],
      [1, "TYPESAFE_API_KEY not set (checked the plugin setting, env, .jevmem/.env, ~/.jevmem/env); jevmem skipped"],
      [1, "empty turn (source: transcript-unreadable, transcript missing)"],
      [1, "older than 24 h (7 failed attempt(s); last error: APIConnectionTimeoutError: Request timed out.)"],
    ]);
    expect(f.guard.reasons.map((r) => [r.count, r.latest])).toEqual([
      [2, "Error: timed out after 958 ms (guard.budgetMs)"], // same time: the later line is the latest
      [1, "no TypeSafe API key (checked the plugin setting, env, .jevmem/.env, ~/.jevmem/env): no decision"],
    ]);
    const lines = formatFailures(f, "failures: ", "  ");
    expect(lines[0]).toBe("failures: in the last 7 days: 5 dropped turn(s), 2 failed recall(s), 3 guard check(s) failed or timed out, 1 other hook problem(s) (.jevmem/log.jsonl)");
    expect(lines).toContain("  dropped turns, never evaluated:");
    expect(lines).toContain(`    2× not retryable: ${syntax(173)} (last ${at(2).slice(0, 16).replace("T", " ")} UTC)`);
    expect(lines).toContain("  failed recalls, the prompt got no project memory:");
    expect(lines).toContain("  guard checks that failed or timed out, the call ran unchecked:");
    expect(formatFailures(recentFailures([], { now: NOW }), "failures ", "  ")).toEqual(["failures none in the last 7 days: no dropped turn, failed recall or failed guard check in .jevmem/log.jsonl"]);
  });
});

describe("jevmem stats and doctor show the failures the hooks logged", () => {
  let fakes: FakeJev[] = [];
  afterEach(async () => {
    for (const f of fakes) await f.close();
    fakes = [];
  });
  async function cli(argv: string[], cwd: string) {
    const { main } = await import("../src/cli-main.js");
    let out = "";
    const code = await main(argv, { out: (s) => void (out += s), err: () => {}, cwd });
    return { code, out };
  }

  it("a dropped turn, a failed recall, a guard check that timed out and one with Jev down, and a hook with no key", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const store = new MemoryStore(root);
    store.add({ kind: "decision", text: "Use Postgres 16 for the primary store" });
    recordProvenance(root, store.add({ kind: "constraint", text: "Never commit .env files" }), "hook");
    const env = { HOME: root };
    const rejecting = await startFakeJev(() => ({ status: 400 }));
    const failing = await startFakeJev(() => ({ status: 500 }));
    const slow = await startFakeJev((q) => Object.fromEntries(Object.keys(q).map((k) => [k, 0.9])), { delayMs: 3000 });
    fakes = [rejecting, failing, slow];
    const jevAt = (url: string) => createJev({ root, apiKey: "k", baseURL: url, cache: false });
    // Jev rejects the turn (not retryable): the queue drops it.
    expect((await runHook({ hook_event_name: "Stop", cwd: root, user_message: "Decision: deploys go through CI only." }, { jev: jevAt(rejecting.url), env })).action).toBe("error");
    // Jev fails the recall request: the prompt gets no memory.
    expect((await runHook({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "which database do we use?" }, { jev: jevAt(failing.url), env })).action).toBe("error");
    // The guard: Jev too slow for the budget, then Jev down.
    const cfgFile = path.join(root, "jevmem.config.json");
    fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, "utf8")), guard: { mode: "ask", askMin: 0.5, blockMin: 0.9, budgetMs: 400, maxCandidates: 3 } }));
    const pre = (command: string) => ({ hook_event_name: "PreToolUse", cwd: root, tool_name: "Bash", tool_input: { command } });
    expect((await evaluateGuard(pre("git add .env"), { jev: jevAt(slow.url), root })).stdout).toBe("");
    expect((await evaluateGuard(pre("git add .env.local"), { jev: jevAt("http://127.0.0.1:9"), root })).stdout).toBe("");
    // No key anywhere (the test setup removed it from the environment): the Stop hook skips the turn.
    expect((await runHook({ hook_event_name: "Stop", cwd: root, user_message: "Decision: we use Redis for queues." }, { env })).action).toBe("noop");
    expect(readLog(root).filter((e) => e.label === "hook" && e.ok === false).length).toBeGreaterThanOrEqual(3);

    const stats = (await cli(["stats"], root)).out.split("\n");
    const at = stats.findIndex((l) => l.startsWith("failures: "));
    expect(stats[at]).toBe("failures: in the last 7 days: 2 dropped turn(s), 1 failed recall(s), 2 guard check(s) failed or timed out (.jevmem/log.jsonl)");
    const block = stats.slice(at + 1, at + 9);
    expect(block[0]).toBe("  dropped turns, never evaluated:");
    expect(block.slice(1, 3).some((l) => /^ {4}1× not retryable: BadRequestError: 400 .* \(last \d{4}-\d\d-\d\d \d\d:\d\d UTC\)$/.test(l))).toBe(true);
    expect(block.slice(1, 3).some((l) => /^ {4}1× TYPESAFE_API_KEY not set/.test(l))).toBe(true);
    expect(block[3]).toBe("  failed recalls, the prompt got no project memory:");
    expect(block[4]).toMatch(/^ {4}1× .*500/);
    expect(block[5]).toBe("  guard checks that failed or timed out, the call ran unchecked:");
    // The SDK's own timeout (at the budget) usually fires before the guard's timer (25 ms later); either counts.
    expect(block.slice(6).some((l) => /APITimeoutError: Request timed out|timed out after \d+ ms \(guard\.budgetMs\)/.test(l))).toBe(true);
    expect(block.slice(6).some((l) => /APIConnectionError|fetch failed|ECONNREFUSED/.test(l))).toBe(true);
    // doctor: the same, under its own label.
    const doctor = (await cli(["doctor"], root)).out;
    expect(doctor).toMatch(/^failures in the last 7 days: 2 dropped turn\(s\), 1 failed recall\(s\), 2 guard check\(s\) failed or timed out \(\.jevmem\/log\.jsonl\)$/m);
    expect(doctor).toMatch(/^ {9}dropped turns, never evaluated:$/m);
  }, 30_000);

  it("a project with nothing failed says so", async () => {
    const root = tmp();
    init({ root, hooks: false });
    expect((await cli(["doctor"], root)).out).toMatch(/^failures none in the last 7 days: no dropped turn, failed recall or failed guard check in \.jevmem\/log\.jsonl$/m);
    expect((await cli(["stats"], root)).out).toMatch(/^failures: none in the last 7 days/m);
  });
});
