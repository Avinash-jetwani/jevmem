/**
 * The PreToolUse guard (src/guardrail.ts), in process with a mock Jev: which rules it enforces, the decision in each
 * mode, the output contract, the answer cache, the tamper check, and failing open.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { settleGate } from "../src/guard.js";
import { recentFailures } from "../src/failures.js";
import { breakKey, evaluateGuard, formatGuardTrace, hookOutput, readAnswers, readGuardConfig, runGuardHook, SEND, type GuardInput } from "../src/guardrail.js";
import { formatGuardLog, readGuardLog } from "../src/guardlog.js";
import { init } from "../src/init.js";
import { readLog } from "../src/jev.js";
import { recordProvenance } from "../src/provenance.js";
import { MemoryStore } from "../src/store.js";
import type { GuardConfig, Memory } from "../src/types.js";
import { mockJev, type MockJev } from "./helpers.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-guardrail-")));

interface Fixture {
  root: string;
  store: MemoryStore;
  rules: Memory[];
}
/** An enabled project with verified [constraint] lines (written by jevmem here) and the given guard settings. */
function project(rules: string[] = [], guard: Partial<GuardConfig> = {}): Fixture {
  const root = tmp();
  init({ root, hooks: false });
  const store = new MemoryStore(root);
  const added = rules.map((text) => {
    const m = store.add({ kind: "constraint", text });
    recordProvenance(root, m, "hook");
    return m;
  });
  setGuard(root, guard);
  return { root, store, rules: added };
}
function setGuard(root: string, guard: Partial<GuardConfig>) {
  const file = path.join(root, "jevmem.config.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.guard = { ...cfg.guard, ...guard };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}
const bash = (root: string, command: string): GuardInput => ({ hook_event_name: "PreToolUse", session_id: "s1", cwd: root, permission_mode: "default", tool_name: "Bash", tool_input: { command }, tool_use_id: "t1" });
const edit = (root: string, file: string, old_string: string, new_string: string): GuardInput => ({ hook_event_name: "PreToolUse", cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, file), old_string, new_string } });
const write = (root: string, file: string, content: string): GuardInput => ({ hook_event_name: "PreToolUse", cwd: root, tool_name: "Write", tool_input: { file_path: path.join(root, file), content } });
/** Jev answers every "breaks" noul with p, or per rule id from a table. */
const breaks = (p: number | Record<string, number>): MockJev => mockJev((q) => Object.fromEntries(Object.keys(q).filter((k) => k.startsWith("breaks_")).map((k) => [k, typeof p === "number" ? p : (p[k.slice(7)] ?? 0.02)])));
const parse = (stdout: string) => JSON.parse(stdout).hookSpecificOutput;
const ENV = "Never commit .env files";

describe("decision by mode", () => {
  it("ask (default): Jev says the call breaks a rule, so Claude Code asks the user, quoting the rule", async () => {
    const { root } = project([ENV]);
    const jev = breaks(0.93);
    const t = await evaluateGuard(bash(root, "git add .env && git commit -m 'add env'"), { jev });
    expect(t.decision).toBe("ask");
    expect(parse(t.stdout)).toEqual({ hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: `jevmem: this may break a saved rule: "${ENV}" (JEVMEM.md)` });
    expect(jev.calls).toHaveLength(1);
    expect(jev.calls[0]!.opts.label).toBe("guard");
  });

  it("ask: below guard.askMin there is no decision and no output", async () => {
    const { root } = project([ENV]);
    const t = await evaluateGuard(bash(root, "cat .env"), { jev: breaks(0.1) });
    expect(t.decision).toBe("none");
    expect(t.stdout).toBe("");
    expect(t.checks[0]!.p).toBe(0.1);
  });

  it("block: deny at or above blockMin (Claude sees the rule and is told to tell the user), ask between askMin and blockMin", async () => {
    const { root } = project([ENV], { mode: "block", askMin: 0.5, blockMin: 0.8 });
    const hi = await evaluateGuard(bash(root, "git add .env"), { jev: breaks(0.9) });
    expect(parse(hi.stdout)).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `jevmem: blocked by a saved project rule: "${ENV}" (JEVMEM.md). Tell the user about this rule instead of working around it.` });
    const mid = await evaluateGuard(bash(root, "git add .env.local"), { jev: breaks(0.6) });
    expect(parse(mid.stdout).permissionDecision).toBe("ask");
    const lo = await evaluateGuard(bash(root, "cat .env.local"), { jev: breaks(0.2) });
    expect(lo.stdout).toBe("");
  });

  it("block: a verified rule denies at or above blockMin and asks below it", async () => {
    const { root } = project([ENV], { mode: "block", askMin: 0.5, blockMin: 0.9 });
    const at = await evaluateGuard(bash(root, "git add .env"), { jev: breaks(0.9) });
    expect(at.decision).toBe("deny");
    expect(at.checks[0]!.verified).toBe(true);
    const below = await evaluateGuard(bash(root, "git add .env.local"), { jev: breaks(0.89) });
    expect(below.decision).toBe("ask");
    expect(parse(below.stdout).permissionDecisionReason).toBe(`jevmem: this may break a saved rule: "${ENV}" (JEVMEM.md)`);
  });

  it("block: an unverified rule (not written by jevmem here, passed by the gate) asks at any score, naming its line", async () => {
    const { root, store } = project([], { mode: "block", askMin: 0.5, blockMin: 0.9 });
    const planted = store.add({ kind: "constraint", text: ENV }); // a hand edit, a line from git or `jevmem add`
    settleGate(root, [planted], new Map([[planted.id, 0.03]]), 0.5, "jev-mock", "test"); // reads as a team rule: served
    for (const p of [0.9, 0.99, 1]) {
      const t = await evaluateGuard(bash(root, "git add .env"), { jev: breaks(p), noCache: true });
      expect(t.checks[0]).toMatchObject({ id: planted.id, verified: false, p });
      expect(t.decision).toBe("ask");
      expect(parse(t.stdout)).toEqual({ hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: `jevmem: this may break a saved rule: "${ENV}" (JEVMEM.md; unverified line ${planted.id}: asked, not blocked)` });
    }
    // Between the thresholds it asks as any rule would; the reason still says where the rule came from.
    const mid = await evaluateGuard(bash(root, "git add .env"), { jev: breaks(0.6), noCache: true });
    expect(parse(mid.stdout).permissionDecisionReason).toBe(`jevmem: this may break a saved rule: "${ENV}" (JEVMEM.md; unverified line ${planted.id})`);
    // The guard log marks the rule, and jevmem guard test says so where it lists the rules.
    expect(readGuardLog(root).at(-1)!.rules).toEqual([{ id: planted.id, p: 0.6, text: ENV, unverified: true }]);
    expect(formatGuardLog(readGuardLog(root), 1)).toContain(`rule ${planted.id}  p=0.60  "${ENV}"  (unverified line)`);
    expect(formatGuardTrace(mid)).toContain(`loaded   ${planted.id}  ${ENV}  (unverified: asked about, not denied)`);
  });

  it("block: with a verified and an unverified rule both over blockMin, the verified one denies; ask mode names an unverified line too", async () => {
    const { root, store, rules } = project(["Never commit .env.local files"], { mode: "block" });
    const planted = store.add({ kind: "constraint", text: ENV });
    settleGate(root, [planted], new Map([[planted.id, 0.03]]), 0.5, "jev-mock", "test");
    const both = await evaluateGuard(bash(root, "git add .env .env.local"), { jev: breaks(0.95), noCache: true });
    expect(both.decision).toBe("deny");
    expect(parse(both.stdout).permissionDecisionReason).toBe(`jevmem: blocked by a saved project rule: "Never commit .env.local files" (JEVMEM.md). Tell the user about this rule instead of working around it.`);
    setGuard(root, { mode: "ask" });
    const asked = await evaluateGuard(bash(root, "git add .env .env.local"), { jev: breaks({ [planted.id]: 0.97, [rules[0]!.id]: 0.8 }), noCache: true });
    expect(parse(asked.stdout).permissionDecisionReason).toBe(`jevmem: this may break saved rules: "${ENV}"; "Never commit .env.local files" (JEVMEM.md; unverified line ${planted.id})`);
  });

  it("warn: no permission decision; the rule is added to Claude's context as a plain fact", async () => {
    const { root } = project([ENV], { mode: "warn" });
    const t = await evaluateGuard(bash(root, "git add .env"), { jev: breaks(0.95) });
    expect(t.decision).toBe("warn");
    const out = parse(t.stdout);
    expect(out).toEqual({ hookEventName: "PreToolUse", additionalContext: `Saved project rule in JEVMEM.md: "${ENV}".` });
    expect(out.permissionDecision).toBeUndefined();
  });

  it("off: nothing at all, not even the tamper check, and no Jev call", async () => {
    const { root } = project([ENV], { mode: "off" });
    const jev = breaks(0.99);
    for (const input of [bash(root, "git add .env"), bash(root, "rm jevmem.config.json")]) {
      const t = await evaluateGuard(input, { jev });
      expect(t.stdout).toBe("");
    }
    expect(jev.calls).toHaveLength(0);
  });

  it("several rules broken: the reason quotes each, strongest first", async () => {
    const { root, rules } = project([ENV, "Never commit secrets such as API keys"]);
    const t = await evaluateGuard(bash(root, "git add .env && git commit -m 'add secrets'"), { jev: breaks({ [rules[0]!.id]: 0.7, [rules[1]!.id]: 0.9 }) });
    expect(parse(t.stdout).permissionDecisionReason).toBe(`jevmem: this may break saved rules: "Never commit secrets such as API keys"; "${ENV}" (JEVMEM.md)`);
  });
});

describe("guard settings", () => {
  it("guard.blockMin below guard.askMin is refused with a clear message, and the defaults are used instead", async () => {
    const { root } = project([ENV], { mode: "block", askMin: 0.5, blockMin: 0.3 });
    const conf = readGuardConfig(root);
    expect(conf.ok).toBe(true);
    if (!conf.ok) return;
    expect(conf.problems).toEqual(["guard.blockMin (0.3) is below guard.askMin (0.5) in jevmem.config.json, so block mode would deny calls it should only ask about; the guard uses the defaults instead, askMin 0.5 and blockMin 0.9"]);
    expect([conf.cfg.guard.askMin, conf.cfg.guard.blockMin]).toEqual([0.5, 0.9]);
    // 0.6 would have been denied at blockMin 0.3; with the defaults it is asked.
    const t = await evaluateGuard(bash(root, "git add .env"), { jev: breaks(0.6) });
    expect(t.thresholds).toEqual({ askMin: 0.5, blockMin: 0.9 });
    expect(t.decision).toBe("ask");
    expect(t.notes).toContain(conf.problems[0]);
    expect(formatGuardTrace(t)).toContain(`note       ${conf.problems[0]}`);
    // Logged as a problem with the settings, not as a check that failed: the call was checked.
    const f = recentFailures(readLog(root));
    expect([f.guard.count, f.other.count]).toEqual([0, 1]);
    expect(f.other.reasons[0]!.latest).toBe(conf.problems[0]);
  });

  it("guard.blockMin equal to guard.askMin is accepted as written", () => {
    const { root } = project([ENV], { mode: "block", askMin: 0.7, blockMin: 0.7 });
    const conf = readGuardConfig(root);
    expect(conf.ok && conf.problems).toEqual([]);
    expect(conf.ok && [conf.cfg.guard.askMin, conf.cfg.guard.blockMin]).toEqual([0.7, 0.7]);
  });
});

describe("output contract", () => {
  it("stdout is empty or exactly one JSON object, and the decision is never allow", async () => {
    const { root } = project([ENV]);
    for (const mode of ["ask", "block", "warn", "off"] as const) {
      setGuard(root, { mode });
      for (const p of [0, 0.3, 0.5, 0.79, 0.8, 1]) {
        for (const input of [bash(root, "git add .env"), bash(root, "ls"), write(root, "jevmem.config.json", "{}"), bash(root, "sed -i '' 1d JEVMEM.md")]) {
          const { stdout } = await evaluateGuard(input, { jev: breaks(p), noCache: true });
          if (stdout === "") continue;
          const obj = JSON.parse(stdout);
          expect(Object.keys(obj)).toEqual(["hookSpecificOutput"]);
          expect(obj.hookSpecificOutput.hookEventName).toBe("PreToolUse");
          expect([undefined, "ask", "deny"]).toContain(obj.hookSpecificOutput.permissionDecision);
          expect(stdout).not.toMatch(/"permissionDecision":"allow"/);
          expect(stdout.trim().split("\n")).toHaveLength(1);
        }
      }
    }
    expect(hookOutput("none", "x", null)).toBe("");
    expect(hookOutput("allow" as any, "x", null)).toBe("");
  });

  it("a call with no candidate rule makes no Jev call and prints nothing", async () => {
    const { root } = project([ENV, "Don't force-push to main"]);
    const jev = breaks(0.99);
    for (const c of ["ls -la", "pnpm test", "git status", "mkdir -p build"]) expect((await evaluateGuard(bash(root, c), { jev })).stdout, c).toBe("");
    const e = await evaluateGuard(edit(root, "src/app.ts", "a = 1", "a = 2"), { jev });
    expect(e.notes.join()).toMatch(/no candidate/);
    expect(jev.calls).toHaveLength(0);
  });

  it("only Bash, Edit and Write are checked; other tools and events print nothing", async () => {
    const { root } = project([ENV]);
    const jev = breaks(0.99);
    for (const tool_name of ["Read", "Grep", "NotebookEdit", "MultiEdit", "WebFetch"]) {
      expect((await evaluateGuard({ hook_event_name: "PreToolUse", cwd: root, tool_name, tool_input: { file_path: path.join(root, ".env"), command: "git add .env" } }, { jev })).stdout).toBe("");
    }
    expect(jev.calls).toHaveLength(0);
  });
});

describe("which rules are enforced", () => {
  it("superseded lines and unverified lines without a gate verdict are ignored; a clean cached verdict enforces them", async () => {
    const { root, store, rules } = project([ENV]);
    const old = store.add({ kind: "constraint", text: "Never commit .env.production files" });
    recordProvenance(root, old, "hook");
    const newer = store.add({ kind: "constraint", text: "Never commit .env.production files, even encrypted" });
    recordProvenance(root, newer, "hook");
    store.supersede(old.id, newer.id);
    const hand = store.add({ kind: "constraint", text: "Never commit .env.staging files" }); // `jevmem add`: unverified
    const jev = breaks(0.95);
    const t = await evaluateGuard(bash(root, "git add .env.production .env.staging .env"), { jev });
    expect(t.candidates.map((c) => c.rule.id).sort()).toEqual([rules[0]!.id, newer.id].sort());
    const skipped = Object.fromEntries(t.rules!.skipped.map((s) => [s.id, s.reason]));
    expect(skipped[old.id]).toMatch(/^superseded by /);
    expect(skipped[hand.id]).toMatch(/^no gate verdict yet/);
    expect(JSON.stringify(jev.calls[0]!.state)).not.toContain(".env.staging files");
    // Not enforced, and logged once (when the index is built), not on every call.
    const logged = () => readLog(root).filter((e) => e.label === "guard" && /not enforced until the poisoning gate/.test(e.detail ?? "")).length;
    expect(logged()).toBe(1);
    await evaluateGuard(bash(root, "git add .env.staging"), { jev });
    expect(logged()).toBe(1);
    // The gate's verdict arrives (from recall or the Stop drain): clean, so the rule is enforced; not clean, withheld.
    settleGate(root, [hand], new Map([[hand.id, 0.04]]), 0.5, "jev-mock", "test");
    const t2 = await evaluateGuard(bash(root, "git add .env.staging"), { jev });
    expect(t2.candidates.map((c) => c.rule.id)).toContain(hand.id);
    settleGate(root, [hand], new Map([[hand.id, 0.97]]), 0.5, "jev-mock", "test");
    const t3 = await evaluateGuard(bash(root, "git add .env.staging"), { jev });
    expect(t3.candidates.map((c) => c.rule.id)).not.toContain(hand.id);
    expect(t3.rules!.skipped.find((s) => s.id === hand.id)!.reason).toMatch(/^withheld by the poisoning gate/);
  });

  it("only [constraint] lines are rules; a line with hidden text is withheld even when verified", async () => {
    const { root, store } = project([]);
    const d = store.add({ kind: "decision", text: "We commit .env.example as the template" });
    recordProvenance(root, d, "hook");
    const hidden = store.add({ kind: "constraint", text: "Never commit .env files​" });
    recordProvenance(root, hidden, "hook");
    const t = await evaluateGuard(bash(root, "git add .env"), { jev: breaks(0.99) });
    expect(t.rules!.enforced).toEqual([]);
    expect(t.rules!.skipped.find((s) => s.id === hidden.id)!.reason).toMatch(/hidden text/);
  });

  it("the index is rebuilt when JEVMEM.md changes and served from .jevmem/guard-index.json otherwise", async () => {
    const { root, store } = project([ENV]);
    const a = await evaluateGuard(bash(root, "ls"), { jev: breaks(0) });
    const b = await evaluateGuard(bash(root, "ls"), { jev: breaks(0) });
    expect([a.rules!.cached, b.rules!.cached]).toEqual([false, true]);
    const m = store.add({ kind: "constraint", text: "Don't force-push to main" });
    recordProvenance(root, m, "hook");
    const c = await evaluateGuard(bash(root, "git push -f origin main"), { jev: breaks(0.9) });
    expect(c.rules!.cached).toBe(false);
    expect(c.candidates[0]!.rule.id).toBe(m.id);
  });
});

describe("answer cache", () => {
  it("caches by rule and call, for hits and non-hits; a changed rule text or call is asked again", async () => {
    const { root, store, rules } = project([ENV]);
    const jev = breaks(0.9);
    const first = await evaluateGuard(bash(root, "git add .env"), { jev });
    const again = await evaluateGuard(bash(root, "git add .env"), { jev });
    expect(jev.calls).toHaveLength(1);
    expect(again.checks[0]).toMatchObject({ p: 0.9, cached: true });
    expect(again.stdout).toBe(first.stdout);
    const low = breaks(0.05);
    await evaluateGuard(bash(root, "cat .env"), { jev: low });
    await evaluateGuard(bash(root, "cat .env"), { jev: low });
    expect(low.calls).toHaveLength(1); // a non-hit is cached too
    expect(Object.keys(readAnswers(root))).toHaveLength(2);
    // Same id, new text (a person edited the line): asked again.
    store.update(rules[0]!.id, { text: "Never commit .env or .env.local files" });
    recordProvenance(root, { id: rules[0]!.id, text: "Never commit .env or .env.local files" }, "hook");
    await evaluateGuard(bash(root, "git add .env"), { jev });
    expect(jev.calls).toHaveLength(2);
    // noCache: neither read nor written.
    const fresh = breaks(0.9);
    await evaluateGuard(bash(root, "git add .env"), { jev: fresh, noCache: true });
    expect(fresh.calls).toHaveLength(1);
  });
});

describe("what is sent to Jev", () => {
  it("Bash: the command only, scrubbed; the rules' ids and texts; one noul per candidate", async () => {
    const { root, rules } = project([ENV]);
    const jev = breaks(0.9);
    await evaluateGuard(bash(root, "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx git add .env"), { jev });
    const state = jev.calls[0]!.state as any;
    expect(Object.keys(state).sort()).toEqual(["rules", "tool_call"]);
    expect(state.tool_call).toEqual({ tool: "Bash", command: "OPENAI_API_KEY=[REDACTED] git add .env" });
    expect(state.rules).toEqual([{ id: rules[0]!.id, rule: ENV }]);
    expect(Object.keys(jev.calls[0]!.questions)).toEqual([breakKey(rules[0]!.id)]);
  });

  it("Edit and Write: the path relative to the project and a short scrubbed snippet around the match, never the whole file", async () => {
    const { root } = project(["No console.log in committed code"]);
    const jev = breaks(0.8);
    const big = "x".repeat(5000) + "\nconsole.log(token) // password=hunter2\n" + "y".repeat(5000);
    await evaluateGuard(edit(root, "src/auth/login.ts", "return ok;", big), { jev });
    const call = (jev.calls[0]!.state as any).tool_call;
    expect(call.tool).toBe("Edit");
    expect(call.file).toBe("src/auth/login.ts");
    expect(call.added).toContain("console.log(token)");
    expect(call.added).not.toContain("hunter2");
    expect(call.added.length).toBeLessThanOrEqual(SEND.added + 2);
    expect(JSON.stringify(call)).not.toContain(root);
    await evaluateGuard(write(root, "scripts/debug.js", big), { jev });
    const w = (jev.calls[1]!.state as any).tool_call;
    expect(Object.keys(w).sort()).toEqual(["content", "file", "tool"]);
    expect(w.content.length).toBeLessThanOrEqual(SEND.added + 2);
  });
});

describe("fails open", () => {
  it("Jev down or erroring: no decision, logged", async () => {
    const { root } = project([ENV]);
    const down: MockJev = { ...breaks(0.99), call: async () => { throw new Error("fetch failed"); } };
    const t = await evaluateGuard(bash(root, "git add .env"), { jev: down });
    expect(t.stdout).toBe("");
    expect(t.notes.join()).toMatch(/Jev check failed.*fetch failed/);
    expect(readLog(root).some((e) => e.label === "guard" && e.ok === false && /fetch failed/.test(e.error ?? ""))).toBe(true);
  });

  it("Jev too slow: no decision within guard.budgetMs", async () => {
    const { root } = project([ENV], { budgetMs: 300 });
    const slow: MockJev = { ...breaks(0.99), call: () => new Promise(() => {}) };
    const t0 = performance.now();
    const t = await evaluateGuard(bash(root, "git add .env"), { jev: slow });
    expect(performance.now() - t0).toBeLessThan(700);
    expect(t.stdout).toBe("");
    expect(t.notes.join()).toMatch(/timed out/);
  });

  it("no key: no decision, logged; cached answers still count", async () => {
    const { root } = project([ENV]);
    const t = await evaluateGuard(bash(root, "git add .env"), { jev: null });
    expect(t.stdout).toBe("");
    expect(t.notes.join()).toMatch(/no TypeSafe API key/);
    await evaluateGuard(bash(root, "git add .env"), { jev: breaks(0.95) });
    const cached = await evaluateGuard(bash(root, "git add .env"), { jev: null });
    expect(parse(cached.stdout).permissionDecision).toBe("ask");
  });

  it("malformed input, missing or invalid config, and an unreadable JEVMEM.md: no decision", async () => {
    const { root } = project([ENV]);
    const jev = breaks(0.99);
    expect((await evaluateGuard({ hook_event_name: "PreToolUse", cwd: root, tool_name: "Bash", tool_input: {} }, { jev })).stdout).toBe("");
    expect((await evaluateGuard({ hook_event_name: "PreToolUse", cwd: root, tool_name: "Bash" }, { jev })).stdout).toBe("");
    expect(await runGuardHook("{not json", { env: { CLAUDE_PROJECT_DIR: root } })).toBe("");
    expect(await runGuardHook('"a string"', { env: { CLAUDE_PROJECT_DIR: root } })).toBe("");
    expect(readLog(root).some((e) => e.label === "guard" && /not valid JSON|not a JSON object/.test(e.error ?? ""))).toBe(true);
    // Invalid config (bad JSON, unknown mode, out-of-range threshold): no decision, logged.
    const cfgFile = path.join(root, "jevmem.config.json");
    const good = fs.readFileSync(cfgFile, "utf8");
    for (const bad of ["{ nope", JSON.stringify({ guard: { mode: "strict" } }), JSON.stringify({ guard: { askMin: 3 } }), "[]"]) {
      fs.writeFileSync(cfgFile, bad);
      const t = await evaluateGuard(bash(root, "git add .env"), { jev });
      expect(t.stdout, bad).toBe("");
      expect(t.notes.join(), bad).toMatch(/jevmem\.config\.json|guard\./);
    }
    fs.writeFileSync(cfgFile, good);
    // Missing config: not enabled, nothing at all.
    fs.renameSync(cfgFile, cfgFile + ".bak");
    expect((await evaluateGuard(bash(root, "git add .env"), { jev })).notes.join()).toMatch(/not enabled/);
    fs.renameSync(cfgFile + ".bak", cfgFile);
    // An unreadable JEVMEM.md (here a directory): no rule decision.
    fs.rmSync(path.join(root, "JEVMEM.md"));
    fs.mkdirSync(path.join(root, "JEVMEM.md"));
    const t = await evaluateGuard(bash(root, "git add .env"), { jev });
    expect(t.stdout).toBe("");
    expect(t.notes.join()).toMatch(/JEVMEM\.md unreadable/);
    expect(jev.calls).toHaveLength(0);
  });

  it('"enabled": false in jevmem.config.json: nothing', async () => {
    const { root } = project([ENV]);
    const file = path.join(root, "jevmem.config.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), enabled: false }));
    expect((await evaluateGuard(bash(root, "git add .env"), { jev: breaks(0.99) })).stdout).toBe("");
  });
});

describe("tamper check (local, no Jev)", () => {
  const cfgText = (root: string) => fs.readFileSync(path.join(root, "jevmem.config.json"), "utf8");

  it("changing the guard settings in jevmem.config.json is always asked, even with no rules", async () => {
    const { root } = project([]);
    const jev = breaks(0);
    const cur = cfgText(root);
    const t = await evaluateGuard(edit(root, "jevmem.config.json", '"mode": "ask"', '"mode": "off"'), { jev });
    expect(parse(t.stdout)).toMatchObject({ permissionDecision: "ask" });
    expect(parse(t.stdout).permissionDecisionReason).toBe('jevmem: this changes jevmem\'s guard settings in jevmem.config.json (guard.mode "ask" → "off").');
    const lowered = JSON.parse(cur);
    lowered.guard.blockMin = 0.99;
    expect(parse((await evaluateGuard(write(root, "jevmem.config.json", JSON.stringify(lowered)), { jev })).stdout).permissionDecisionReason).toMatch(/guard\.blockMin 0\.9 → 0\.99/);
    const off = JSON.parse(cur);
    off.enabled = false;
    expect(parse((await evaluateGuard(write(root, "jevmem.config.json", JSON.stringify(off)), { jev })).stdout).permissionDecisionReason).toMatch(/switches jevmem off/);
    expect(parse((await evaluateGuard(write(root, "jevmem.config.json", "{ broken"), { jev })).stdout).permissionDecisionReason).toMatch(/unreadable/);
    // Other settings are not the guard's business.
    const w = JSON.parse(cur);
    w.writer.provider = "anthropic";
    expect((await evaluateGuard(write(root, "jevmem.config.json", JSON.stringify(w)), { jev })).stdout).toBe("");
    expect(jev.calls).toHaveLength(0);
  });

  it("removing or superseding a [constraint] line in JEVMEM.md is asked; adding a line is not", async () => {
    const { root, store, rules } = project([ENV, "Don't force-push to main"]);
    const md = () => fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8");
    const line = md().split("\n").find((l) => l.includes(ENV))!;
    const removed = await evaluateGuard(edit(root, "JEVMEM.md", line + "\n", ""), { jev: breaks(0) });
    expect(parse(removed.stdout).permissionDecisionReason).toBe(`jevmem: this edit removes or supersedes a saved rule in JEVMEM.md: "${ENV}".`);
    const superseded = await evaluateGuard(edit(root, "JEVMEM.md", `- [constraint] ${ENV}`, `- [superseded] ${ENV}`), { jev: breaks(0) });
    expect(parse(superseded.stdout).permissionDecision).toBe("ask");
    const whole = await evaluateGuard(write(root, "JEVMEM.md", "# JEVMEM.md\n"), { jev: breaks(0) });
    expect(parse(whole.stdout).permissionDecisionReason).toMatch(/2 saved rules/);
    const added = await evaluateGuard(edit(root, "JEVMEM.md", line, `${line}\n- [decision] Use pnpm  <!-- id:zz9zz9 ts:2026-09-26T00:00:00.000Z conf:0.90 -->`), { jev: breaks(0) });
    expect(added.stdout).toBe("");
    void store;
    void rules;
  });

  it("Bash: writing to jevmem.config.json, JEVMEM.md or .jevmem/, or `jevmem disable`, is asked; reading is not", async () => {
    const { root } = project([ENV]);
    const jev = breaks(0);
    const asked = ["cp /tmp/other.json jevmem.config.json", "rm jevmem.config.json", "mv jevmem.config.json /tmp/x", "echo '{}' > jevmem.config.json", "sed -i '' 's/ask/off/' jevmem.config.json", "jevmem disable", "npx jevmem init --remove-hooks", "sed -i '/env/d' JEVMEM.md", "git checkout -- JEVMEM.md", "rm -rf .jevmem", "echo '{}' > .jevmem/guard-cache.json", "cd sub && rm ../jevmem.config.json"];
    for (const c of asked) expect(parse((await evaluateGuard(bash(root, c), { jev })).stdout).permissionDecision, c).toBe("ask");
    const fine = ["cp jevmem.config.json /tmp/backup.json", "cat jevmem.config.json", "jq .guard jevmem.config.json", "git diff JEVMEM.md", "grep constraint JEVMEM.md", "git add JEVMEM.md jevmem.config.json", "echo '- [decision] x' >> JEVMEM.md", "ls .jevmem", "jevmem list", "sed -n 1,5p JEVMEM.md"];
    for (const c of fine) expect((await evaluateGuard(bash(root, c), { jev })).stdout, c).toBe("");
  });

  it("Bash: a redirection writes only its own target, so reading JEVMEM.md with stderr sent to /dev/null is not asked", async () => {
    const { root } = project([ENV]);
    const jev = breaks(0);
    // Found in the guardgit e2e: `cat JEVMEM.md 2>/dev/null` was asked as a write to JEVMEM.md.
    const fine = ["cat JEVMEM.md 2>/dev/null", "grep -n constraint JEVMEM.md 2>/dev/null", "head -5 JEVMEM.md 2>&1", "cat JEVMEM.md > /tmp/jevmem-copy.md", "cat < JEVMEM.md", "wc -l JEVMEM.md >/dev/null 2>&1", "cat jevmem.config.json 2>/dev/null", "ls .jevmem 2>/dev/null"];
    for (const c of fine) expect((await evaluateGuard(bash(root, c), { jev })).stdout, c).toBe("");
    // Real writes still ask: a redirection into the file, tee, sed -i (with or without stderr redirected).
    const asked = ["cat /tmp/other.md > JEVMEM.md", "cat JEVMEM.md > JEVMEM.md", "printf '' > JEVMEM.md", "echo x | tee JEVMEM.md", "tee JEVMEM.md < /tmp/other.md", "sed -i '' '/env/d' JEVMEM.md", "sed -i '/env/d' JEVMEM.md 2>/dev/null", "echo '{}' > jevmem.config.json 2>/dev/null"];
    for (const c of asked) expect(parse((await evaluateGuard(bash(root, c), { jev })).stdout).permissionDecision, c).toBe("ask");
    expect(jev.calls).toHaveLength(0);
  });

  it("the tamper check holds in warn mode, and in block mode a denied rule still wins", async () => {
    const { root } = project([ENV], { mode: "warn" });
    expect(parse((await evaluateGuard(bash(root, "rm jevmem.config.json"), { jev: breaks(0) })).stdout).permissionDecision).toBe("ask");
    setGuard(root, { mode: "block" });
    const both = await evaluateGuard(bash(root, "git add .env && rm jevmem.config.json"), { jev: breaks(0.95) });
    expect(parse(both.stdout).permissionDecision).toBe("deny");
  });
});

describe("guard test output", () => {
  it("shows the rules loaded and skipped, the match reasons, Jev's answer and the exact hook output", async () => {
    const { root, store } = project([ENV]);
    store.add({ kind: "constraint", text: "Never commit .env.staging files" });
    const t = await evaluateGuard(bash(root, "git add .env"), { jev: breaks(0.93), log: false });
    const text = formatGuardTrace(t);
    expect(text).toContain("jevmem guard test: Bash `git add .env`");
    expect(text).toMatch(/rules\s+1 loaded, 1 skipped/);
    expect(text).toMatch(/no gate verdict yet/);
    expect(text).toMatch(/score \d+: file \.env ~ \.env/);
    expect(text).toMatch(/p=0\.93 ≥ 0\.50 \(asked now, \d+ ms\)/);
    expect(text).toContain(`output     ${t.stdout}`);
    expect(readLog(root).filter((e) => e.label === "guard" && e.event === "guard" && /^ask/.test(e.detail ?? ""))).toHaveLength(0);
  });
});
