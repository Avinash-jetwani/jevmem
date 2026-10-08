/**
 * Dedupe on save (0.7.0): the local match before any request, Jev's restatement question read with the line it picks,
 * the normalised match after the writer; a reversal is never a duplicate; MCP add_memory and import answer with the
 * line that already says it; `jevmem why` shows the question.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../src/combine.js";
import { decide } from "../src/decide.js";
import { findDuplicate, normalizeForDupe } from "../src/dupe.js";
import { gatedAdd } from "../src/gate.js";
import { evaluateTurn } from "../src/hook.js";
import { collectCandidates, runImport } from "../src/import.js";
import { formatWhy } from "../src/labels.js";
import { buildTier1Questions, DUP_NOUL } from "../src/questions.js";
import { MemoryStore } from "../src/store.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { CONTRADICTS, mockJev, SAVE_DECISION } from "./helpers.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-dedupe-")));
const cfg = structuredClone(DEFAULT_CONFIG);
const LIVE = "Use Postgres 16 for the main database";

describe("the local match", () => {
  it("normalises tags, backticks, quotes, spacing, case and final punctuation, and matches nothing short", () => {
    expect(normalizeForDupe("[constraint] [constraint]  Never commit `.env` files!")).toBe("never commit .env files");
    expect(normalizeForDupe('"Use Postgres 16."')).toBe("use postgres 16");
    const live = [{ id: "m1", text: LIVE }];
    expect(findDuplicate("[decision] use postgres 16 for the main database.", live)?.id).toBe("m1");
    expect(findDuplicate("`Use Postgres 16 for the main database`", live)?.id).toBe("m1");
    expect(findDuplicate("Use Postgres 16 for the main database, with pgvector", live)).toBeNull();
    expect(findDuplicate("ok", [{ id: "m2", text: "ok" }])).toBeNull();
  });
});

describe("the question and the policy", () => {
  it("is asked in the decide call only when the state lists memories", () => {
    expect(Object.keys(buildTier1Questions([{ id: "m1", kind: "decision", text: LIVE }]))).toContain(DUP_NOUL);
    expect(Object.keys(buildTier1Questions([]))).not.toContain(DUP_NOUL);
  });

  it("skips the turn as a duplicate at duplicateMin with the picked line, never on a reversal, and the default applies to an older config", () => {
    const base = { kindChoice: "decision", importanceScore: 3, families: { decision: 0.9, constraint: 0, preference: 0, bug: 0, architecture: 0, todo: 0, "dead-end": 0, chit_chat: 0, injection: 0, contradiction: 0.1, meta: 0 } as any, touchesMemoryId: "m1" };
    expect(evaluatePolicy({ ...base, duplicateNoul: 0.8, duplicateId: "m1" }, cfg.thresholds)).toMatchObject({ save: false, duplicateOf: "m1" });
    expect(evaluatePolicy({ ...base, duplicateNoul: 0.8, duplicateId: "m1" }, cfg.thresholds).reason).toContain("duplicate of m1 (restates it: 0.80 ≥ 0.7)");
    expect(evaluatePolicy({ ...base, duplicateNoul: 0.69, duplicateId: "m1" }, cfg.thresholds)).toMatchObject({ save: true, duplicateOf: null });
    expect(evaluatePolicy({ ...base, duplicateNoul: 0.9 }, cfg.thresholds)).toMatchObject({ save: true, duplicateOf: null });
    const reversal = { ...base, families: { ...base.families, contradiction: 0.9 }, duplicateNoul: 0.9, duplicateId: "m1" };
    expect(evaluatePolicy(reversal, cfg.thresholds)).toMatchObject({ save: true, duplicateOf: null, supersedes: "m1" });
    const old = { ...cfg.thresholds } as any;
    delete old.duplicateMin;
    expect(evaluatePolicy({ ...base, duplicateNoul: 0.75, duplicateId: "m1" }, old)).toMatchObject({ save: false, duplicateOf: "m1" });
  });

  it("decide carries the answer, the id and whether it applied", async () => {
    const existing = [{ id: "m1", kind: "decision" as const, text: LIVE }];
    const dup = mockJev(() => ({ ...SAVE_DECISION, [DUP_NOUL]: 0.93, touches_memory_id: "m1" }));
    const d = await decide(dup, { userMessage: "We settled on Postgres 16 as the main database.", existingMemories: existing });
    expect(d).toMatchObject({ save: false, duplicateOf: "m1", duplicate: { noul: 0.93, id: "m1", applied: true } });
    const fresh = mockJev(() => ({ ...SAVE_DECISION, [DUP_NOUL]: 0.1, touches_memory_id: "m1" }));
    expect(await decide(fresh, { userMessage: "Postgres 16, and now with pgvector for embeddings.", existingMemories: existing })).toMatchObject({ save: true, duplicateOf: null, duplicate: { noul: 0.1, id: "m1", applied: false } });
    const rev = mockJev(() => ({ ...CONTRADICTS("m1"), [DUP_NOUL]: 0.9 }));
    expect(await decide(rev, { userMessage: "Actually, we're moving the main database to MySQL.", existingMemories: existing })).toMatchObject({ save: true, duplicateOf: null, contradiction: true, touchesMemoryId: "m1" });
  });
});

describe("the hook path", () => {
  it("stops a word-for-word restatement before any request, a paraphrase on Jev's answer, and a rewritten line after the writer", async () => {
    const store = new MemoryStore(tmp());
    const m = store.add({ kind: "decision", text: LIVE });
    const quiet = mockJev(() => ({ ...SAVE_DECISION, [DUP_NOUL]: 0.05 }));
    const local = await evaluateTurn(store, cfg, quiet, { hash: "h1", user: "[decision] Use Postgres 16 for the main database.", assistant: "Noted.", previous: "" });
    expect(local).toMatchObject({ action: "skipped" });
    expect(local.detail).toBe(`duplicate of ${m.id} (the message restates it word for word; nothing was sent)`);
    expect(quiet.calls).toHaveLength(0);
    const byJev = mockJev(() => ({ ...SAVE_DECISION, [DUP_NOUL]: 0.91, touches_memory_id: m.id }));
    const para = await evaluateTurn(store, cfg, byJev, { hash: "h2", user: "We settled on Postgres 16 as the main database.", assistant: "Noted.", previous: "" });
    expect(para.action).toBe("skipped");
    expect(para.detail).toBe(`duplicate of ${m.id} (Jev read the message as restating it: 0.91)`);
    const after = await evaluateTurn(store, cfg, quiet, { hash: "h3", user: "Decision: use Postgres 16 for the main database.", assistant: "Noted.", previous: "" });
    expect(after.action).toBe("skipped");
    expect(after.detail).toBe(`duplicate of ${m.id} (the line written for the turn is the same as that line)`);
    expect(store.active().map((x) => x.id)).toEqual([m.id]);
    const log = fs.readFileSync(path.join(store.root, ".jevmem", "log.jsonl"), "utf8").split("\n").filter((l) => l.includes('"event":"duplicate"'));
    expect(log).toHaveLength(3);
    const decisions = fs.readFileSync(path.join(store.root, ".jevmem", "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(decisions.map((d) => d.decision.duplicateOf)).toEqual([m.id, m.id, null]);
    expect(formatWhy(decisions[1])).toContain(`restates a listed line: 0.91 (min 0.7), which: ${m.id}  ✓ duplicate of ${m.id}: not saved`);
  });

  it("saves a restatement of a retired line, which is not live", async () => {
    const store = new MemoryStore(tmp());
    const m = store.add({ kind: "decision", text: LIVE });
    store.retire(m.id);
    const jev = mockJev(() => ({ ...SAVE_DECISION }));
    const o = await evaluateTurn(store, cfg, jev, { hash: "h4", user: LIVE + ".", assistant: "Noted.", previous: "" });
    expect(o.action).toBe("saved");
    expect(store.active()).toHaveLength(1);
  });
});

describe("add_memory and import", () => {
  it("gatedAdd answers a duplicate with the line that has it, not an error, before and after Jev", async () => {
    const store = new MemoryStore(tmp());
    const m = store.add({ kind: "decision", text: LIVE });
    const quiet = mockJev(() => ({ ...SAVE_DECISION, [DUP_NOUL]: 0.05 }));
    const local = await gatedAdd(quiet, store, cfg, "use postgres 16 for the main database", "decision");
    expect(local).toMatchObject({ ok: false, duplicateOf: m.id });
    expect(quiet.calls).toHaveLength(0);
    const byJev = mockJev(() => ({ ...SAVE_DECISION, [DUP_NOUL]: 0.88, touches_memory_id: m.id }));
    const para = await gatedAdd(byJev, store, cfg, "The main database is Postgres 16", "decision");
    expect(para).toMatchObject({ ok: false, duplicateOf: m.id });
    expect((para as { reason: string }).reason).toContain(`duplicate of ${m.id}`);
    expect(store.active()).toHaveLength(1);
  });

  it("import marks a restated statement as a duplicate, word for word before Jev and by Jev's answer", async () => {
    const root = tmp();
    const store = new MemoryStore(root);
    const m = store.add({ kind: "decision", text: LIVE });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), `- [decision] Use Postgres 16 for the main database.\n- The main database is Postgres 16.\n- Deploys go through GitHub Actions.\n`);
    const jev = mockJev((q, state: any) => (String(state.user_message).includes("Postgres 16") ? { ...SAVE_DECISION, [DUP_NOUL]: 0.9, touches_memory_id: m.id } : { ...SAVE_DECISION, [DUP_NOUL]: 0.05 }));
    const { candidates } = collectCandidates(root, ["claude-md"], { maxChars: 200 });
    const rows = await runImport(jev, store, cfg, candidates, { apply: false });
    expect(rows.map((r) => r.outcome)).toEqual(["duplicate", "duplicate", "add"]);
    expect(rows[0]!.reason).toBe(`duplicate of ${m.id}`);
    expect(rows[1]!.reason).toBe(`duplicate of ${m.id} (restates it)`);
    expect(jev.calls.filter((c) => c.opts.label === "decide")).toHaveLength(2);
  });
});
