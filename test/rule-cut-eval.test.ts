/**
 * The rule-cut sets (0.7.7), committed before the writer changed:
 * - eval/rule-cut-dev.jsonl (tuning): the six teaching statements of the 0.7.7 comparison whose jevmem line lost the
 *   rule (`from` names each), and seven rows of the same shapes in two other projects.
 * - eval/rule-cut-heldout.jsonl (run once on the fixed build and once on 7137dfe): thirty rows in seven other projects.
 * Rows are labelled like the line-text sets (test/lines-eval.test.ts), plus `rule`, the part of the statement that carries
 * the rule, and `ruleKeys`, the words a line must keep. Tags: `cut-one-sentence` (one sentence of 201 to 300 characters
 * whose rule ends past character 200), `cut-two-sentences` (a first sentence of at most 200 and the rule in a later one,
 * past 200), `past-300` (a statement longer than 300 with its rule past 200), `pick-rule-sentence` (the rule in a sentence
 * of its own after the first, which Jev may leave out of its pick) and `short-control` (a statement of at most 200
 * characters with its rule in it).
 * The two sets share no project and no run of five words, and the held-out set shares none with another eval set, with
 * the comparison's tasks, or with the questions jevmem asks Jev.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NEW_KINDS } from "../src/types.js";
// @ts-expect-error: a JavaScript module without types
import { TASKS as AUTOMEM } from "../eval/ab/tasks-automem.mjs";

const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
/** A dev row from the comparison names its task (`fromTask`); its user text is that task's first teaching statement. */
const resolve = (r: any) => (r.fromTask ? { ...r, user: AUTOMEM.find((t: any) => t.id === r.fromTask).teach[0] } : r);
const SETS = { dev: read("eval/rule-cut-dev.jsonl").map(resolve), heldout: read("eval/rule-cut-heldout.jsonl").map(resolve) };
const OWN = ["rule-cut-dev.jsonl", "rule-cut-heldout.jsonl"];
const TAGS = ["cut-one-sentence", "cut-two-sentences", "past-300", "pick-rule-sentence", "short-control"];
const QUESTION_SOURCES = ["src/questions.ts", "src/guard.ts", "src/recall.ts", "src/guardrail.ts", "src/pick.ts"];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s: string) => norm(s).split(" ").filter(Boolean);
function shingles(s: string, n: number): Set<string> {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}
function literals(src: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  for (const m of src.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1"));
  return out.filter((s) => words(s).length > 0);
}
const rowTexts = (r: any): string[] => [r.user, r.assistant, ...(r.existing ?? []).map((m: any) => m.text)].filter(Boolean);
/** Texts of every other eval set in eval/, whatever its shape, and the A/B tasks' literals (the comparison's included). */
function otherTexts(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const f of fs.readdirSync("eval").filter((f) => f.endsWith(".jsonl") && !OWN.includes(f) && !f.startsWith("attempts-"))) {
    for (const r of read(path.join("eval", f))) {
      const texts: string[] = [];
      if (r.row === "session") texts.push(...r.prompts);
      else if (r.row === "file") texts.push(...r.lines.map((l: any) => l.text));
      else if (r.row === "prompt") texts.push(r.prompt);
      else if (r.type === "rules") texts.push(...r.rules.map((x: any) => x.text));
      else if (r.type === "call") texts.push(...[r.command, r.file, r.old, r.new, r.content].filter(Boolean));
      else if (typeof r.text === "string") texts.push(...[r.text, r.query].filter(Boolean));
      else texts.push(...[r.user, r.assistant, r.previous, ...(r.existing ?? []).map((m: any) => m.text)].filter(Boolean));
      for (const t of texts) out.push({ file: f, text: String(t) });
    }
  }
  for (const f of ["eval/ab/tasks.mjs", "eval/ab/tasks-automem.mjs"]) for (const t of literals(fs.readFileSync(f, "utf8"))) out.push({ file: f, text: t });
  return out;
}
const has = (text: string, key: string) => text.toLowerCase().includes(key.toLowerCase());

describe("eval/rule-cut-*.jsonl", () => {
  for (const [name, rows] of Object.entries(SETS)) {
    it(`${name}: every row is a saved turn labelled with its fact and the rule its line must keep`, () => {
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
      for (const r of rows) {
        expect(TAGS, r.id).toContain(r.tag);
        expect(r.label.save, r.id).toBe(true);
        expect(NEW_KINDS, r.id).toContain(r.label.kind);
        expect(r.accept, r.id).toContain(r.label.kind);
        expect(r.source, r.id).toBe("user");
        expect(r.fact.length, r.id).toBeGreaterThan(0);
        for (const f of r.fact) expect(r.user.includes(f), `${r.id}: ${f}`).toBe(true);
        expect(r.factKeys.some((k: string) => r.fact.some((f: string) => has(f, k))), r.id).toBe(true);
        expect(r.user.includes(r.rule), r.id).toBe(true);
        expect(r.ruleKeys.length, r.id).toBeGreaterThan(0);
        expect(r.ruleKeys.some((k: string) => has(r.rule, k)), r.id).toBe(true);
        expect(r.junk, r.id).toEqual([]);
      }
    });
    it(`${name}: each row has its tag's shape`, () => {
      for (const r of rows) {
        const fact = r.fact[0] as string;
        const at = r.user.indexOf(r.rule);
        if (r.tag === "cut-one-sentence") {
          expect(fact.length, r.id).toBeGreaterThan(200);
          expect(fact.length, r.id).toBeLessThanOrEqual(300);
          expect(fact.includes(r.rule), r.id).toBe(true);
          expect(fact.indexOf(r.rule) + r.rule.length, r.id).toBeGreaterThan(200);
        } else if (r.tag === "cut-two-sentences") {
          // The old writer keeps the first sentence alone when the two do not fit in 200 characters.
          const end = at + r.rule.length + (/^[^.!?]*[.!?]/.exec(r.user.slice(at + r.rule.length))?.[0].length ?? 0);
          expect(fact.length, r.id).toBeLessThanOrEqual(200);
          expect(r.ruleKeys.some((k: string) => has(fact, k)), r.id).toBe(false);
          expect(at, r.id).toBeGreaterThanOrEqual(fact.length);
          expect(end, r.id).toBeGreaterThan(200);
          expect(end, r.id).toBeLessThanOrEqual(300);
        } else if (r.tag === "past-300") {
          expect(at + r.rule.length, r.id).toBeGreaterThan(200);
          expect(Math.max(fact.length, at + r.rule.length), r.id).toBeGreaterThan(300);
        } else if (r.tag === "pick-rule-sentence") {
          expect(r.ruleKeys.some((k: string) => has(fact, k)), r.id).toBe(false);
          expect(at, r.id).toBeGreaterThanOrEqual(fact.length);
        } else {
          expect(fact.length, r.id).toBeLessThanOrEqual(200);
          expect(fact.includes(r.rule), r.id).toBe(true);
        }
      }
    });
  }
  it("the held-out set has enough rows of each tag", () => {
    const count = (t: string) => SETS.heldout.filter((r) => r.tag === t).length;
    expect(count("cut-one-sentence")).toBeGreaterThanOrEqual(8);
    expect(count("cut-two-sentences")).toBeGreaterThanOrEqual(8);
    expect(count("past-300")).toBeGreaterThanOrEqual(3);
    expect(count("pick-rule-sentence")).toBeGreaterThanOrEqual(5);
    expect(count("short-control")).toBeGreaterThanOrEqual(6);
  });
  it("the dev set holds the comparison's six statements whose jevmem line lost the rule, by reference", () => {
    const raw = read("eval/rule-cut-dev.jsonl").filter((r) => r.fromTask);
    for (const r of raw) expect(r.user, r.id).toBeUndefined();
    const from = SETS.dev.filter((r) => r.fromTask);
    expect(from.map((r) => r.id).sort()).toEqual(["rd-ab-bn-sms", "rd-ab-bn-statuses", "rd-ab-cm-exit", "rd-ab-cm-parallel", "rd-ab-sl-capacity", "rd-ab-sl-live"]);
  });
});

describe("rule-cut sets: no shared text", () => {
  it("held-out projects are not the dev set's", () => {
    const dev = new Set(SETS.dev.map((r) => r.project));
    for (const r of SETS.heldout) expect(dev.has(r.project), r.id).toBe(false);
  });
  it("dev and held-out share no 5-word run", () => {
    const dev = new Set(SETS.dev.flatMap((r) => rowTexts(r).flatMap((t) => [...shingles(t, 5)])));
    for (const r of SETS.heldout) for (const t of rowTexts(r)) for (const s of shingles(t, 5)) expect(dev.has(s), `${r.id}: "${s}"`).toBe(false);
  });
  it("the held-out set shares no 5-word run with any other eval set or the A/B tasks", () => {
    const others = new Map<string, string>();
    for (const o of otherTexts()) for (const s of shingles(o.text, 5)) others.set(s, o.file);
    for (const r of SETS.heldout) for (const t of rowTexts(r)) for (const s of shingles(t, 5)) expect(others.get(s), `${r.id}: "${s}"`).toBeUndefined();
  });
  it("the dev set's own rows (not the comparison's statements) share no 5-word run with any other eval set", () => {
    const others = new Map<string, string>();
    for (const o of otherTexts()) for (const s of shingles(o.text, 5)) others.set(s, o.file);
    for (const r of SETS.dev.filter((x) => !x.fromTask)) for (const t of rowTexts(r)) for (const s of shingles(t, 5)) expect(others.get(s), `${r.id}: "${s}"`).toBeUndefined();
  });
  it("no 5-word run shared with the questions jevmem asks Jev (the comparison's statements are quoted as taught)", () => {
    const q = new Set(QUESTION_SOURCES.flatMap((f) => literals(fs.readFileSync(f, "utf8")).flatMap((t) => [...shingles(t, 5)])));
    for (const rows of Object.values(SETS)) for (const r of rows.filter((x) => !x.fromTask)) for (const t of rowTexts(r)) for (const s of shingles(t, 5)) expect(q.has(s), `${r.id}: "${s}"`).toBe(false);
  });
});
