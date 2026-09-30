/**
 * The guard's local log (src/guardlog.ts): one line per call the PreToolUse hook checked, with how it was decided; asks,
 * denials and warnings keep the rule, Jev's score and a short scrubbed summary of the call. `jevmem guard log` lists
 * them and `jevmem stats` counts them. Nothing is logged for a call the guard did not check, or by `jevmem guard test`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateGuard, type GuardInput } from "../src/guardrail.js";
import { actionSummary, GUARD_LOG_FILE, GUARD_LOG_MAX_BYTES, readGuardLog, recordGuardCall } from "../src/guardlog.js";
import { init } from "../src/init.js";
import { recordProvenance } from "../src/provenance.js";
import { MemoryStore } from "../src/store.js";
import type { GuardConfig } from "../src/types.js";
import { mockJev, type MockJev } from "./helpers.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-guardlog-")));
function project(rules: string[] = [], guard: Partial<GuardConfig> = {}): string {
  const root = tmp();
  init({ root, hooks: false });
  const store = new MemoryStore(root);
  for (const text of rules) recordProvenance(root, store.add({ kind: "constraint", text }), "hook");
  const file = path.join(root, "jevmem.config.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.guard = { ...cfg.guard, ...guard };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return root;
}
const bash = (root: string, command: string): GuardInput => ({ hook_event_name: "PreToolUse", session_id: "s1", cwd: root, tool_name: "Bash", tool_input: { command } });
const breaks = (p: number): MockJev => mockJev((q) => Object.fromEntries(Object.keys(q).filter((k) => k.startsWith("breaks_")).map((k) => [k, p])));
const ENV = "Never commit .env files";
const logExists = (root: string) => fs.existsSync(path.join(root, ".jevmem", GUARD_LOG_FILE));

async function cli(argv: string[], cwd: string) {
  const { main } = await import("../src/cli-main.js");
  let out = "";
  let err = "";
  const code = await main(argv, { out: (s) => void (out += s), err: (s) => void (err += s), cwd });
  return { code, out, err };
}

describe("the guard's local log", () => {
  it("one line per checked call with its route; an ask keeps the rule, the score and a scrubbed summary of the call", async () => {
    const root = project([ENV]);
    await evaluateGuard(bash(root, "ls -la"), { jev: breaks(0.93) }); // no candidate: nothing sent
    await evaluateGuard(bash(root, "DB_PASSWORD=hunter2 git add .env"), { jev: breaks(0.93) }); // sent, asked
    await evaluateGuard(bash(root, "DB_PASSWORD=hunter2 git add .env"), { jev: null }); // the cached answer, asked again
    await evaluateGuard(bash(root, "git add .env.local"), { jev: breaks(0.1) }); // sent, below askMin
    await evaluateGuard(bash(root, "git add .env.production"), { jev: { ...breaks(0.9), call: async () => { throw new Error("fetch failed"); } } }); // sent, failed: asked without a score
    await evaluateGuard(bash(root, "git add .env.staging"), { jev: null }); // no key
    await evaluateGuard(bash(root, `sed -i '' 's/"ask"/"off"/' jevmem.config.json`), { jev: breaks(0.93) }); // tamper, no candidate
    const log = readGuardLog(root);
    expect(log.map((e) => [e.tool, e.route, e.decision])).toEqual([
      ["Bash", "no-candidate", "none"],
      ["Bash", "jev", "ask"],
      ["Bash", "cache", "ask"],
      ["Bash", "jev", "none"],
      ["Bash", "jev-failed", "ask"],
      ["Bash", "no-key", "none"],
      ["Bash", "no-candidate", "ask"],
    ]);
    // A call with no decision keeps no text at all.
    for (const e of log.filter((x) => x.decision === "none")) expect(Object.keys(e).sort()).toEqual(["decision", "route", "tool", "ts"]);
    const ask = log[1]!;
    expect(ask.mode).toBe("ask");
    expect(ask.rules).toEqual([{ id: expect.any(String), p: 0.93, text: ENV }]);
    expect(ask.action).toBe("DB_PASSWORD=[REDACTED] git add .env");
    expect(JSON.stringify(log)).not.toContain("hunter2");
    expect(log[4]!.rules).toEqual([{ id: expect.any(String), text: ENV, unchecked: true }]);
    expect(log[4]!.tamper).toBeUndefined();
    expect(log[6]!.tamper).toMatch(/^jevmem: this command changes jevmem\.config\.json/);
    expect(log[6]!.rules).toBeUndefined();
    expect(Date.parse(log[0]!.ts)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("nothing is logged for a call the guard does not check, nor by `jevmem guard test` and the evals (log: false)", async () => {
    const off = tmp(); // not enabled
    await evaluateGuard(bash(off, "git add .env"), { jev: breaks(0.99) });
    expect(fs.readdirSync(off)).toEqual([]);
    const modeOff = project([ENV], { mode: "off" });
    await evaluateGuard(bash(modeOff, "git add .env"), { jev: breaks(0.99) });
    const root = project([ENV]);
    await evaluateGuard({ hook_event_name: "PreToolUse", cwd: root, tool_name: "Read", tool_input: { file_path: path.join(root, ".env") } }, { jev: breaks(0.99) });
    await evaluateGuard(bash(root, "git add .env"), { jev: breaks(0.99), log: false });
    const disabled = project([ENV]);
    const file = path.join(disabled, "jevmem.config.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), enabled: false }));
    await evaluateGuard(bash(disabled, "git add .env"), { jev: breaks(0.99) });
    expect([logExists(modeOff), logExists(root), logExists(disabled)]).toEqual([false, false, false]);
    // `jevmem guard test` is a dry run.
    const r = await cli(["guard", "test", "git add .env"], root);
    expect(r.code).toBe(0);
    expect(logExists(root)).toBe(false);
  });

  it("a bad config, malformed input, and a project with no rules are logged too (no decision)", async () => {
    const root = project([]);
    await evaluateGuard(bash(root, "npm test"), { jev: breaks(0.99) });
    await evaluateGuard({ hook_event_name: "PreToolUse", cwd: root, tool_name: "Bash", tool_input: {} }, { jev: breaks(0.99) });
    fs.writeFileSync(path.join(root, "jevmem.config.json"), JSON.stringify({ guard: { mode: "strict" } }));
    await evaluateGuard(bash(root, "npm test"), { jev: breaks(0.99) });
    expect(readGuardLog(root).map((e) => [e.route, e.decision])).toEqual([
      ["no-rules", "none"],
      ["error", "none"],
      ["error", "none"],
    ]);
  });

  it("the summary of an Edit or Write is the path and the start of the new text, scrubbed, at most 160 characters", () => {
    const secret = "sk-proj-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
    const long = `OPENAI_API_KEY=${secret}\n` + "x ".repeat(50_000);
    const s = actionSummary({ tool: "Write", file: "config/app.env", added: long }, null);
    expect(s.length).toBeLessThanOrEqual(160);
    expect(s.startsWith('config/app.env "OPENAI_API_KEY=[REDACTED] x x')).toBe(true);
    expect(s).not.toContain(secret);
    expect(actionSummary({ tool: "Edit", file: "a.ts", removed: "x", added: "" }, null)).toBe("a.ts");
    // When a snippet was sent, the summary starts from it.
    expect(actionSummary({ tool: "Edit", file: "a.ts", removed: "", added: "whatever" }, { tool: "Edit", file: "a.ts", removed: "", added: "…the part that matched" })).toBe('a.ts "…the part that matched"');
  });

  it("past its size cap the log moves to guard-log.1.jsonl, and both are read, oldest first", () => {
    const root = project([]);
    const dir = path.join(root, ".jevmem");
    const old = JSON.stringify({ ts: "2026-09-01T00:00:00.000Z", tool: "Bash", route: "no-rules", decision: "none" }) + "\n";
    fs.writeFileSync(path.join(dir, GUARD_LOG_FILE), old.repeat(Math.ceil(GUARD_LOG_MAX_BYTES / old.length) + 1));
    const before = readGuardLog(root).length;
    recordGuardCall(root, { ts: "2026-09-02T00:00:00.000Z", tool: "Edit", route: "no-rules", decision: "none" });
    expect(fs.existsSync(path.join(dir, "guard-log.1.jsonl"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, GUARD_LOG_FILE), "utf8").trim().split("\n")).toHaveLength(1);
    const all = readGuardLog(root);
    expect(all).toHaveLength(before + 1);
    expect(all.at(-1)!.tool).toBe("Edit");
    // A torn line is skipped.
    fs.appendFileSync(path.join(dir, GUARD_LOG_FILE), '{"ts":"2026-09-02T00:00:01.000Z","tool":"Ba');
    expect(readGuardLog(root)).toHaveLength(before + 1);
  });
});

describe("jevmem guard log and jevmem stats", () => {
  it("guard log lists the most recent asks and denials, newest first, with the rule, the score and the summary", async () => {
    const root = project([ENV, "Never force-push to main"], { mode: "block" });
    await evaluateGuard(bash(root, "ls"), { jev: breaks(0.97) });
    await evaluateGuard(bash(root, "git add .env"), { jev: breaks(0.97) }); // denied
    await evaluateGuard(bash(root, "git push --force origin main"), { jev: breaks(0.7) }); // asked (below blockMin)
    const r = await cli(["guard", "log"], root);
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^jevmem guard log: 1 ask, 1 denial since \d{4}-\d\d-\d\d \d\d:\d\d:\d\d, newest first \(\.jevmem\/guard-log\.jsonl\)$/);
    expect(lines.slice(2)).toEqual([
      expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}ask {3}Bash {3}git push --force origin main$/),
      expect.stringMatching(/^ {21}rule \w+ {2}p=0\.70 {2}"Never force-push to main"$/),
      expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}deny {2}Bash {3}git add \.env$/),
      expect.stringMatching(/^ {21}rule \w+ {2}p=0\.97 {2}"Never commit \.env files"$/),
    ]);
    const one = await cli(["guard", "log", "-n", "1"], root);
    expect(one.out).toMatch(/^jevmem guard log: the 1 most recent of 1 ask, 1 denial since /);
    expect(one.out).not.toContain("git add .env");
    expect((await cli(["guard", "log", "-n", "0"], root)).code).toBe(1);
    expect((await cli(["guard", "log"], tmp())).err).toMatch(/isn't enabled/);
    const empty = project([ENV]);
    expect((await cli(["guard", "log"], empty)).out).toBe("jevmem guard log: no asks or denials logged in this project (.jevmem/guard-log.jsonl)\n");
  });

  it("stats counts calls seen, the fast path, cached answers, calls sent to Jev, asks (tamper among them), denials and warnings", async () => {
    const root = project([ENV]);
    for (const c of ["ls", "npm test", "git status"]) await evaluateGuard(bash(root, c), { jev: breaks(0.9) });
    await evaluateGuard(bash(root, "git add .env"), { jev: breaks(0.9) });
    await evaluateGuard(bash(root, "git add .env"), { jev: breaks(0.9) });
    await evaluateGuard(bash(root, "git add .env.local"), { jev: { ...breaks(0.9), call: async () => { throw new Error("fetch failed"); } } });
    await evaluateGuard(bash(root, "rm jevmem.config.json"), { jev: breaks(0.9) });
    const r = await cli(["stats"], root);
    expect(r.out).toMatch(/^guard: 7 call\(s\) seen since \d{4}-\d\d-\d\d \d\d:\d\d:\d\d: 4 fast path \(no candidate rule, nothing sent\), 1 answered from the cache, 2 sent to Jev \(1 failed or timed out\)$/m);
    expect(r.out).toMatch(/^ {7}4 asked \(1 tamper\), 0 denied, 0 warned; `jevmem guard log` lists them$/m);
    // No guard line in a project where the guard has checked nothing.
    expect((await cli(["stats"], project([ENV]))).out).not.toMatch(/^guard/m);
  });
});
