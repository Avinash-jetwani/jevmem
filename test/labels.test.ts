import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHook } from "../src/hook.js";
import { findDecision, footerMeta, formatFooter, formatWhy, labelMissed, labelRight, labelWrong, readDecisions, readLabels, runFit } from "../src/labels.js";
import { MemoryStore } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import { CHIT_CHAT, mockJev, SAVE_DECISION } from "./helpers.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-labels-"));
const env = { JEVMEM_WRITER: "none" } as NodeJS.ProcessEnv;

describe("feedback loop", () => {
  it("records every decision, explains it with `why`, and labels right/wrong/missed", async () => {
    const root = tmp();
    const jev = mockJev((_q, state: any) => (/thanks/.test(state.user_message) ? CHIT_CHAT : SAVE_DECISION));
    const saved = await runHook({ hook_event_name: "Stop", cwd: root, user_message: "Let's use Postgres 16." }, { jev, env });
    const skipped = await runHook({ hook_event_name: "Stop", cwd: root, user_message: "thanks!" }, { jev, env });
    expect(saved.action).toBe("saved");
    expect(skipped.action).toBe("skipped");
    const decisions = readDecisions(root);
    expect(decisions).toHaveLength(2);
    const store = new MemoryStore(root);
    const memId = store.active()[0]!.id;
    const rec = findDecision(root, memId)!;
    expect(rec.memoryId).toBe(memId);
    const why = formatWhy(rec);
    expect(why).toContain("SAVED");
    expect(why).toContain("contains_decision"); // tier 1 was sure, so the broad nouls are shown
    expect(why).toContain("kind choice: decision");
    expect(why).toMatch(/content \(max kind family\) 0\.\d\d {2}min 0\.5 ✓/);
    const skippedRec = findDecision(root, decisions[1]!.hash.slice(0, 6))!;
    expect(formatWhy(skippedRec)).toContain("SKIPPED");

    expect(labelRight(root, rec)).toBe(1);
    const w = labelWrong(root, skippedRec);
    expect(w.count).toBe(2);
    expect(w.label).toEqual({ save: true, kind: "decision" }); // opposite of what happened, kind falls back to decision
    const w2 = labelWrong(root, rec, "constraint");
    expect(w2.label).toEqual({ save: true, kind: "constraint" });
    const m = await labelMissed(jev, root, loadConfig(root), "USER: we must keep Node 20", "constraint");
    expect(m.count).toBe(4);
    expect(m.label.kind).toBe("constraint");
    const labels = readLabels(root);
    expect(labels.map((l) => l.source)).toEqual(["right", "wrong", "wrong", "missed"]);
    expect(labels[0]!.answers.nouls.contains_decision).toBe(0.95); // tier 1 was final
    expect(labels[3]!.message).toContain("Node 20");

    // Footer reflects labels.
    store.touchFooter();
    const raw = fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8");
    expect(raw.trim().endsWith("<!-- jevmem: 4 labels, last fit never -->")).toBe(true);
    expect(store.list()).toHaveLength(1); // footer is not a memory line
    expect(formatFooter(footerMeta(root)!)).toBe("<!-- jevmem: 4 labels, last fit never -->");
  });

  it("refuses to fit under 40 labels unless forced, then writes weights and thresholds to config", async () => {
    const root = tmp();
    const jev = mockJev((_q, state: any) => (/thanks|ok/.test(state.user_message) ? CHIT_CHAT : SAVE_DECISION));
    for (let i = 0; i < 10; i++) {
      const r = await runHook({ hook_event_name: "Stop", cwd: root, user_message: i % 2 ? `thanks ${i}` : `Use lib${i} for parsing.` }, { jev, env });
      const rec = findDecision(root, r.action === "saved" ? new MemoryStore(root).active().at(-1)!.id : readDecisions(root).at(-1)!.hash)!;
      labelRight(root, rec);
    }
    const under = runFit(root);
    expect(under.ok).toBe(false);
    if (!under.ok) expect(under.reason).toMatch(/40/);
    const forced = runFit(root, { force: true });
    expect(forced.ok).toBe(true);
    if (forced.ok) {
      expect(forced.written).toBe(true);
      // These labels were all decided by tier 1 (sure), so only tier-1 thresholds are fitted.
      expect(forced.result.tier2).toBeNull();
      expect(forced.result.tier1!.after.f1).toBeGreaterThanOrEqual(forced.result.tier1!.before.f1);
    }
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "jevmem.config.json"), "utf8"));
    expect(cfg.tiers.tier1Thresholds.contentMin).toBeTypeOf("number");
    expect(cfg.weights).toBeUndefined();
    expect(fs.existsSync(path.join(root, ".jevmem", "fit.json"))).toBe(true);
    new MemoryStore(root).touchFooter();
    expect(fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8")).toMatch(/<!-- jevmem: 10 labels, last fit \d{4}-\d{2}-\d{2} -->/);
    // Fitted tier-1 thresholds are picked up by the hook through config.
    expect(loadConfig(root).tiers.tier1Thresholds!.contentMin).toBeTypeOf("number");
  });
});
