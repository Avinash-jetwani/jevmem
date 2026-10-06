/**
 * The cause-last sets (0.6.5), committed before the writer changed:
 * - eval/cause-last-dev.jsonl (tuning): the real replies of the 0.6.5 release gate's second full run (2026-10-04, the
 *   deadend and supersede scenarios, sessions served by claude-fable-5-1). Each gives the verdict first ("It didn't
 *   work, so I'm dropping the idea …") and the cause, or what was changed, last.
 * - eval/cause-last-heldout.jsonl (run once on the fixed build and once on 0.6.4): turns written in that style, in
 *   four other projects and other words.
 * Rows are labelled like the line-text sets (test/lines-eval.test.ts). `dead-end-cause-last`: `fact` is the sentence
 * that says what was tried, `reason` the words that say why it failed. `works-now-change-last`: the turn makes the
 * listed dead end `worksNow` names work, and `fact` is the sentence that says what was changed.
 * The two sets share no project and no run of five words, and neither shares one with another eval set or with the
 * questions jevmem asks Jev.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const SETS = { dev: read("eval/cause-last-dev.jsonl"), heldout: read("eval/cause-last-heldout.jsonl") };
const OWN = ["cause-last-dev.jsonl", "cause-last-heldout.jsonl"];
const TAGS = ["dead-end-cause-last", "works-now-change-last"];
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
/** Texts of every other eval set in eval/, whatever its shape, and the outcome A/B's literals. */
function otherTexts(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  // The attempts sets (0.6.6) are left out: their replies are real model output, their prompts were written by other
  // hands, and real text shares stock phrases ("can you find out why", an error's name) with any authored set. They have
  // their own overlap test, test/attempts-eval.test.ts.
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
  for (const t of literals(fs.readFileSync("eval/ab/tasks.mjs", "utf8"))) out.push({ file: "ab/tasks.mjs", text: t });
  return out;
}
const has = (text: string, key: string) => text.toLowerCase().includes(key.toLowerCase());

describe("eval/cause-last-*.jsonl", () => {
  for (const [name, rows] of Object.entries(SETS)) {
    it(`${name}: every row is a saved turn whose reply is labelled with what its line must say`, () => {
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
      for (const r of rows) {
        expect(TAGS, r.id).toContain(r.tag);
        expect(r.label.save, r.id).toBe(true);
        expect(r.accept, r.id).toContain(r.label.kind);
        expect(r.source, r.id).toBe("assistant");
        expect(r.fact.length, r.id).toBeGreaterThan(0);
        for (const f of r.fact) expect(r.assistant.includes(f), `${r.id}: ${f}`).toBe(true);
        expect(r.factKeys.some((k: string) => r.fact.some((f: string) => has(f, k))), r.id).toBe(true);
        expect(r.junk, r.id).toEqual([]);
        if (r.tag === "dead-end-cause-last") {
          expect(r.label.kind, r.id).toBe("dead-end");
          expect(r.assistant.includes(r.reason), r.id).toBe(true);
          expect(r.reasonKeys.some((k: string) => has(r.reason, k)), r.id).toBe(true);
          // The cause comes after what was tried: in the same sentence, or in a later one.
          expect(r.assistant.indexOf(r.reason), r.id).toBeGreaterThan(r.assistant.indexOf(r.fact[0]));
          // A key of the fact names the attempt, so it is in no sentence before it (the verdict, the preamble).
          for (const k of r.factKeys) expect(has(r.assistant.slice(0, r.assistant.indexOf(r.fact[0])), k), `${r.id}: ${k}`).toBe(false);
        } else {
          expect(r.reason, r.id).toBeNull();
          expect(r.reasonKeys, r.id).toEqual([]);
          // The turn makes a listed dead end work.
          expect(r.existing.find((m: any) => m.id === r.worksNow)?.kind, r.id).toBe("dead-end");
        }
      }
    });
  }

  it("held-out: enough rows of each tag, and most replies start with text that is not the attempt", () => {
    const rows = SETS.heldout;
    expect(rows.filter((r) => r.tag === "dead-end-cause-last").length).toBeGreaterThanOrEqual(12);
    expect(rows.filter((r) => r.tag === "works-now-change-last").length).toBeGreaterThanOrEqual(4);
    expect(rows.filter((r) => r.assistant.indexOf(r.fact[0]) > 0).length).toBe(rows.length);
    // The attempt's sentence with its cause is longer than a line in some rows, and fits in one in others.
    const sameSentence = rows.filter((r) => r.reasonSame);
    expect(sameSentence.filter((r) => r.fact[0].length > 200).length).toBeGreaterThanOrEqual(4);
    expect(new Set(rows.map((r) => r.project)).size).toBeGreaterThanOrEqual(4);
  });
});

describe("cause-last sets: no shared text", () => {
  it("the held-out set uses projects the dev set does not", () => {
    const dev = new Set(SETS.dev.map((r) => r.project));
    for (const r of SETS.heldout) expect(dev.has(r.project), r.id).toBe(false);
  });

  it("dev and held-out share no 5-word run", () => {
    const devSh = new Map<string, string>();
    for (const r of SETS.dev) for (const t of rowTexts(r)) for (const s of shingles(t, 5)) devSh.set(s, r.id);
    const hits: string[] = [];
    for (const r of SETS.heldout) for (const t of rowTexts(r)) for (const s of shingles(t, 5)) if (devSh.has(s)) hits.push(`"${s}" in ${r.id} and ${devSh.get(s)}`);
    expect(hits).toEqual([]);
  });

  it("no 5-word run shared with any other eval set", () => {
    const other = new Map<string, string>();
    for (const o of otherTexts()) for (const s of shingles(o.text, 5)) other.set(s, o.file);
    const hits: string[] = [];
    for (const r of [...SETS.dev, ...SETS.heldout]) for (const t of rowTexts(r)) for (const s of shingles(t, 5)) if (other.has(s)) hits.push(`"${s}" in ${r.id} and ${other.get(s)}`);
    expect(hits).toEqual([]);
  });

  it("no 5-word run shared with the questions jevmem asks Jev", () => {
    const lits = new Map<string, string>();
    for (const f of QUESTION_SOURCES.filter((f) => fs.existsSync(f))) for (const l of literals(fs.readFileSync(f, "utf8"))) for (const s of shingles(l, 5)) lits.set(s, f);
    const hits: string[] = [];
    for (const r of [...SETS.dev, ...SETS.heldout]) for (const t of rowTexts(r)) for (const s of shingles(t, 5)) if (lits.has(s)) hits.push(`"${s}" in ${r.id} and ${lits.get(s)}`);
    expect(hits).toEqual([]);
  });
});
