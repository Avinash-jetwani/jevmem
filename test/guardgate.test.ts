/**
 * Gate verdicts for the guard, off the hot path: the Stop drain asks the memory-poisoning gate about [constraint] lines
 * that have no verdict yet; the PreToolUse hook never asks it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { evaluateGuard, type GuardInput } from "../src/guardrail.js";
import { drainTurns } from "../src/hook.js";
import { init } from "../src/init.js";
import { recordProvenance } from "../src/provenance.js";
import { MemoryStore } from "../src/store.js";
import { mockJev, type MockJev } from "./helpers.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-guardgate-")));
function project(rules: string[] = []) {
  const root = tmp();
  init({ root, hooks: false });
  const store = new MemoryStore(root);
  for (const text of rules) recordProvenance(root, store.add({ kind: "constraint", text }), "hook");
  return { root, store };
}
const bash = (root: string, command: string): GuardInput => ({ hook_event_name: "PreToolUse", cwd: root, tool_name: "Bash", tool_input: { command } });
const breaks = (p: number): MockJev => mockJev((q) => Object.fromEntries(Object.keys(q).filter((k) => k.startsWith("breaks_")).map((k) => [k, p])));
const ENV = "Never commit .env files";
describe("gate verdicts, off the hot path", () => {
  it("the Stop drain asks the gate about rules with no verdict; the guard enforces them from then on", async () => {
    const { root, store } = project([]);
    const hand = store.add({ kind: "constraint", text: ENV }); // `jevmem add` or a hand edit: unverified
    const before = await evaluateGuard(bash(root, "git add .env"), { jev: breaks(0.9) });
    expect(before.candidates).toEqual([]);
    const gate = mockJev((q) => Object.fromEntries(Object.keys(q).filter((k) => k.startsWith("inj_")).map((k) => [k, 0.03])));
    await drainTurns(root, loadConfig(root), gate); // an empty queue still runs the drain
    expect(gate.calls).toHaveLength(1);
    expect(Object.keys(gate.calls[0]!.questions)).toEqual([`inj_${hand.id}`]);
    const after = await evaluateGuard(bash(root, "git add .env"), { jev: breaks(0.9) });
    expect(after.decision).toBe("ask");
    await drainTurns(root, loadConfig(root), gate);
    expect(gate.calls).toHaveLength(1); // nothing left to check
  });

  it("the PreToolUse path never asks the gate: its only questions are the breaks nouls", async () => {
    const { root, store } = project([ENV]);
    store.add({ kind: "constraint", text: "Never commit .env.local files" });
    const jev = breaks(0.9);
    await evaluateGuard(bash(root, "git add .env .env.local"), { jev });
    for (const c of jev.calls) expect(Object.keys(c.questions).every((k) => k.startsWith("breaks_"))).toBe(true);
  });
});
