/**
 * Always-on rules (0.7.1): the marker in the file, the session-start context per mode, the marking at save time, and
 * the hand switches.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { decide } from "../src/decide.js";
import { runHook, sessionStartOutcome } from "../src/hook.js";
import { init, registerClaudeHooks } from "../src/init.js";
import { ALWAYS_NOUL } from "../src/questions.js";
import { alwaysOnLines, formatSessionStart } from "../src/recall.js";
import { formatLine, MemoryStore, parseLine } from "../src/store.js";
import { mockJev, SAVE_DECISION } from "./helpers.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-alwayson-"));

describe("the always-on marker", () => {
  it("round-trips through the file as always:1 and is dropped by setAlways --off", () => {
    const root = tmp();
    const store = new MemoryStore(root);
    const m = store.add({ kind: "preference", text: "Every string goes through t()", always: true });
    expect(fs.readFileSync(store.file, "utf8")).toMatch(/always:1 -->/);
    expect(parseLine(formatLine(m))?.always).toBe(true);
    expect(store.setAlways(m.id, false)?.always).toBeUndefined();
    expect(fs.readFileSync(store.file, "utf8")).not.toMatch(/always:1/);
    expect(store.setAlways("nosuch", true)).toBeNull();
  });
});

describe("the session-start context", () => {
  const lines = [
    { id: "a1", kind: "constraint" as const, text: "Never commit .env files", ts: "", conf: 1 },
    { id: "b2", kind: "preference" as const, text: "Every string goes through t()", ts: "", conf: 1, always: true },
    { id: "c3", kind: "decision" as const, text: "SQLite", ts: "", conf: 1 },
    { id: "d4", kind: "retired" as const, text: "old rule", ts: "", conf: 1, always: true },
  ];
  it("picks the marked lines in mode always and the constraints in mode constraints, live ones only, capped", () => {
    expect(alwaysOnLines(lines, "always", 40).lines.map((m) => m.id)).toEqual(["b2"]);
    expect(alwaysOnLines(lines, "constraints", 40).lines.map((m) => m.id)).toEqual(["a1"]);
    expect(alwaysOnLines(lines, "off", 40).lines).toEqual([]);
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, kind: "constraint" as const, text: `rule ${i}`, ts: "", conf: 1 }));
    const capped = alwaysOnLines(many, "constraints", 3);
    expect(capped.lines).toHaveLength(3);
    expect(capped.more).toBe(2);
    expect(formatSessionStart(capped.lines, capped.more)).toMatch(/2 more rule/);
  });
  it("is empty with no lines, and names each line's id", () => {
    expect(formatSessionStart([])).toBe("");
    const ctx = formatSessionStart(lines.slice(1, 2));
    expect(ctx).toMatch(/^<jevmem-rules>/);
    expect(ctx).toContain("- [preference] Every string goes through t() (id:b2)");
    expect(ctx).toMatch(/<\/jevmem-rules>$/);
  });
  it("the hook answers SessionStart from the file alone, with no key", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const store = new MemoryStore(root);
    store.add({ kind: "constraint", text: "Never commit .env files", always: true });
    const cfg = { ...loadConfig(root), alwaysOn: { mode: "always" as const, maxLines: 40 } };
    const out = sessionStartOutcome(store, cfg);
    expect(out.action).toBe("injected");
    expect(JSON.parse(out.stdout!).hookSpecificOutput.hookEventName).toBe("SessionStart");
    const viaRunHook = await runHook({ hook_event_name: "SessionStart", cwd: root }, { env: {} as NodeJS.ProcessEnv });
    expect(viaRunHook.action).toMatch(/injected|noop/); // the config file's mode decides; no Jev client is needed
  });
  it("init registers the SessionStart hook with the plain command", () => {
    const root = tmp();
    registerClaudeHooks(root, "cmd", "stop", "guard");
    const s = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8"));
    expect(s.hooks.SessionStart[0].hooks[0]).toMatchObject({ command: "cmd", timeout: 5 });
  });
});

describe("marking at save time", () => {
  it("marks a rule the question says applies to every change, on a kind that can be a rule", async () => {
    const jev = mockJev(() => ({ ...SAVE_DECISION, kind: "constraint", [ALWAYS_NOUL]: 0.9 }));
    const d = await decide(jev, { userMessage: "Every string shown to people goes through t().", existingMemories: [] }, { tiers: { mode: "fast" } });
    expect(d.alwaysNoul).toBe(0.9);
    expect(d.always).toBe(true);
    const low = await decide(mockJev(() => ({ ...SAVE_DECISION, kind: "constraint", [ALWAYS_NOUL]: 0.3 })), { userMessage: "x", existingMemories: [] }, { tiers: { mode: "fast" } });
    expect(low.always).toBe(false);
    const bug = await decide(mockJev(() => ({ ...SAVE_DECISION, kind: "bug", [ALWAYS_NOUL]: 0.9 })), { userMessage: "x", existingMemories: [] }, { tiers: { mode: "fast" } });
    expect(bug.always).toBe(false);
  });
});
