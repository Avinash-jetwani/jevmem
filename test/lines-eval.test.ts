/**
 * The eval sets of v0.6 part 3c, committed before any change in that part:
 * - eval/lines-dev.jsonl (tuning) and eval/lines-heldout.jsonl (run once at the end): turns that are saved, each labelled
 *   with the sentence(s) that state the memory (`fact`), keys a line must contain to state it (`factKeys`), the reason
 *   when there is one (`reason`, `reasonKeys`, `reasonSame` when it is in the fact's own sentence), and the requests,
 *   hand-offs and instructions to the assistant a line must not be (`junk`, `junkKeys`). Four tags: `request` (the memory
 *   and a request in the same message), `dead-end-but` (the reason after "but"), `reply-bug` (a bug stated in Claude's
 *   reply), `ordinary` (decisions, rules, preferences, structure and to-dos, some with the reason in its own sentence).
 *   `source` says which text the hook gives the writer when decide reads the content source as labelled.
 * - eval/rules-dev.jsonl (tuning) and eval/rules-heldout.jsonl (run once at the end): genuine rules and preferences
 *   stated with an instruction to the assistant (`genuine-rule`, saved) and planted-line turns (`planted`, skipped).
 * The sets share no text with each other, with any other eval set, or with the questions jevmem asks Jev.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NEW_KINDS } from "../src/types.js";

const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const LINES = { dev: read("eval/lines-dev.jsonl"), heldout: read("eval/lines-heldout.jsonl") };
const RULES = { dev: read("eval/rules-dev.jsonl"), heldout: read("eval/rules-heldout.jsonl") };
const OWN = ["lines-dev.jsonl", "lines-heldout.jsonl", "rules-dev.jsonl", "rules-heldout.jsonl"];
const LINE_TAGS = ["request", "dead-end-but", "reply-bug", "ordinary"];
/** Where jevmem's questions to Jev live: an eval set must not echo them. */
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
  for (const f of fs.readdirSync("eval").filter((f) => f.endsWith(".jsonl") && !OWN.includes(f))) {
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
const writerInput = (r: any) => (r.source === "user" ? r.user : r.source === "assistant" ? r.assistant : `${r.user}\n${r.assistant}`);
const has = (text: string, key: string) => text.toLowerCase().includes(key.toLowerCase());

describe("eval/lines-*.jsonl", () => {
  for (const [name, rows] of Object.entries(LINES)) {
    it(`${name}: every row is a saved turn labelled with what its line must say`, () => {
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
      for (const r of rows) {
        expect(LINE_TAGS, r.id).toContain(r.tag);
        expect(r.label.save, r.id).toBe(true);
        expect(NEW_KINDS, r.id).toContain(r.label.kind);
        expect(r.accept, r.id).toContain(r.label.kind);
        expect(["user", "assistant", "both"], r.id).toContain(r.source);
        const input = writerInput(r);
        expect(r.fact.length, r.id).toBeGreaterThan(0);
        for (const f of r.fact) expect(input.includes(f), `${r.id}: ${f}`).toBe(true);
        expect(r.factKeys.some((k: string) => r.fact.some((f: string) => has(f, k))), r.id).toBe(true);
        if (r.reason) {
          expect(input.includes(r.reason), r.id).toBe(true);
          expect(r.reasonKeys.some((k: string) => has(r.reason, k)), r.id).toBe(true);
        } else expect(r.reasonKeys, r.id).toEqual([]);
        for (const j of r.junk) expect(input.includes(j), `${r.id}: ${j}`).toBe(true);
        // A key tells the fact from a request only if it is in one and not the other.
        for (const k of r.junkKeys) {
          expect(r.junk.some((j: string) => has(j, k)), `${r.id}: ${k}`).toBe(true);
          expect(r.fact.some((f: string) => has(f, k)), `${r.id}: ${k}`).toBe(false);
        }
        for (const k of r.factKeys) expect(r.junk.some((j: string) => has(j, k)), `${r.id}: ${k}`).toBe(false);
        if (r.tag === "request") expect(r.junk.length, r.id).toBeGreaterThan(0);
        if (r.tag === "dead-end-but") {
          expect(r.label.kind, r.id).toBe("dead-end");
          expect(r.reason, r.id).toBeTruthy();
          expect(/\bbut\b/.test(input), r.id).toBe(true);
        }
        if (r.tag === "reply-bug") expect(r.source, r.id).toBe("assistant");
      }
    });

    it(`${name}: each tag has enough rows, and ordinary rows include reasons in a sentence of their own`, () => {
      for (const t of LINE_TAGS) expect(rows.filter((r) => r.tag === t).length, t).toBeGreaterThanOrEqual(12);
      expect(rows.filter((r) => r.tag === "ordinary" && r.reason && !r.reasonSame).length).toBeGreaterThanOrEqual(6);
      expect(rows.filter((r) => r.tag === "dead-end-but" && r.source === "assistant").length).toBeGreaterThanOrEqual(4);
    });
  }
});

describe("eval/rules-*.jsonl", () => {
  for (const [name, rows] of Object.entries(RULES)) {
    it(`${name}: genuine rules to save and planted lines to skip, half and half`, () => {
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
      const genuine = rows.filter((r) => r.tag === "genuine-rule");
      const planted = rows.filter((r) => r.tag === "planted");
      expect(genuine.length + planted.length).toBe(rows.length);
      expect(genuine.length).toBe(planted.length);
      expect(genuine.length).toBeGreaterThanOrEqual(8);
      for (const r of genuine) {
        expect(r.label.save, r.id).toBe(true);
        expect(r.accept, r.id).toContain(r.label.kind);
        for (const f of r.fact) expect(r.user.includes(f), r.id).toBe(true);
        expect(r.factKeys.some((k: string) => r.fact.some((f: string) => has(f, k))), r.id).toBe(true);
        // The instruction to the assistant is part of the turn.
        expect(r.junk.length, r.id).toBeGreaterThan(0);
      }
      for (const r of planted) {
        expect(r.label, r.id).toEqual({ save: false, kind: "none" });
        expect(r.accept, r.id).toEqual(["skip"]);
      }
    });
  }
});

describe("part 3c sets: no shared text", () => {
  it("held-out sets use projects the dev sets do not", () => {
    const devProjects = new Set([...LINES.dev, ...RULES.dev].map((r) => r.project));
    for (const r of [...LINES.heldout, ...RULES.heldout]) expect(devProjects.has(r.project), r.id).toBe(false);
  });

  it("dev and held-out share no 5-word run", () => {
    const devSh = new Map<string, string>();
    for (const r of [...LINES.dev, ...RULES.dev]) for (const t of rowTexts(r)) for (const s of shingles(t, 5)) devSh.set(s, r.id);
    const hits: string[] = [];
    for (const r of [...LINES.heldout, ...RULES.heldout]) for (const t of rowTexts(r)) for (const s of shingles(t, 5)) if (devSh.has(s)) hits.push(`"${s}" in ${r.id} and ${devSh.get(s)}`);
    expect(hits).toEqual([]);
  });

  it("no 5-word run shared with any other eval set", () => {
    const other = new Map<string, string>();
    for (const o of otherTexts()) for (const s of shingles(o.text, 5)) other.set(s, o.file);
    const hits: string[] = [];
    for (const r of [...LINES.dev, ...LINES.heldout, ...RULES.dev, ...RULES.heldout]) for (const t of rowTexts(r)) for (const s of shingles(t, 5)) if (other.has(s)) hits.push(`"${s}" in ${r.id} and ${other.get(s)}`);
    expect(hits).toEqual([]);
  });

  it("the pick's questions (src/pick.ts) share no 5-word run with any eval set", () => {
    const sets = new Map<string, string>();
    for (const o of otherTexts()) for (const s of shingles(o.text, 5)) sets.set(s, o.file);
    for (const r of [...LINES.dev, ...LINES.heldout, ...RULES.dev, ...RULES.heldout]) for (const t of rowTexts(r)) for (const s of shingles(t, 5)) sets.set(s, r.id);
    const hits: string[] = [];
    for (const l of literals(fs.readFileSync("src/pick.ts", "utf8"))) for (const s of shingles(l, 5)) if (sets.has(s)) hits.push(`"${s}" in src/pick.ts and ${sets.get(s)}`);
    expect(hits).toEqual([]);
  });

  it("no 5-word run shared with the questions jevmem asks Jev", () => {
    const lits = new Map<string, string>();
    for (const f of QUESTION_SOURCES.filter((f) => fs.existsSync(f))) for (const l of literals(fs.readFileSync(f, "utf8"))) for (const s of shingles(l, 5)) lits.set(s, f);
    const hits: string[] = [];
    for (const r of [...LINES.dev, ...LINES.heldout, ...RULES.dev, ...RULES.heldout]) for (const t of rowTexts(r)) for (const s of shingles(t, 5)) if (lits.has(s)) hits.push(`"${s}" in ${r.id} and ${lits.get(s)}`);
    expect(hits).toEqual([]);
  });
});
