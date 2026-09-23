/**
 * The held-out eval set must not share text with anything jevmem's prompts contain (src/questions.ts), nor with the
 * older regression set. Otherwise jevmem sees its own few-shot examples at test time and the LLMs don't.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s: string) => norm(s).split(" ").filter(Boolean);
function shingles(s: string, n: number): Set<string> {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}
/** Every string literal in a TypeScript source file. */
function literals(src: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  for (const m of src.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1"));
  return out.filter((s) => words(s).length > 0);
}
const readJsonl = (f: string) => fs.readFileSync(path.resolve(f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const turnTexts = (t: any): string[] => [t.user, t.assistant, t.previous ?? "", ...(t.existing ?? []).map((m: any) => m.text)].filter(Boolean);

const heldout = readJsonl("eval/heldout.jsonl");
const promptLits = literals(fs.readFileSync(path.resolve("src/questions.ts"), "utf8"));

describe("eval/heldout.jsonl", () => {
  it("has at least 50 hand-labelled turns covering every kind, chit-chat, injection and contradiction", () => {
    expect(heldout.length).toBeGreaterThanOrEqual(50);
    const kinds = new Set(heldout.filter((t) => t.label.save).map((t) => t.label.kind));
    for (const k of ["decision", "constraint", "preference", "bug", "architecture", "todo"]) expect(kinds.has(k), k).toBe(true);
    expect(heldout.filter((t) => t.tag === "chit_chat").length).toBeGreaterThanOrEqual(3);
    expect(heldout.filter((t) => /injection/.test(t.tag)).length).toBeGreaterThanOrEqual(3);
    expect(heldout.filter((t) => t.contradicts).length).toBeGreaterThanOrEqual(3);
    for (const t of heldout) {
      expect(t.label.save ? t.label.kind !== "none" : t.label.kind === "none", t.user).toBe(true);
      if (t.contradicts) expect(t.existing.map((m: any) => m.id), t.user).toContain(t.contradicts);
    }
  });

  it("shares no text with any string in src/questions.ts (normalised: equal, contained phrase of 3+ words, or any shared 5-word run)", () => {
    const hits: string[] = [];
    const litShingles = new Map<string, string>();
    for (const l of promptLits) for (const sh of shingles(l, 5)) litShingles.set(sh, l);
    for (const t of heldout) {
      for (const text of turnTexts(t)) {
        const nt = ` ${norm(text)} `;
        for (const l of promptLits) {
          const nl = norm(l);
          if (nl === nt.trim()) hits.push(`equal: "${text}" = questions.ts "${l}"`);
          else if (words(l).length >= 3 && nt.includes(` ${nl} `)) hits.push(`contains: "${text}" ⊃ questions.ts "${l}"`);
        }
        for (const sh of shingles(text, 5)) if (litShingles.has(sh)) hits.push(`5-gram "${sh}": "${text}" ~ questions.ts "${litShingles.get(sh)}"`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("shares no 5-word run with the regression set (eval/transcript.jsonl)", () => {
    const reg = new Set<string>();
    for (const t of readJsonl("eval/transcript.jsonl")) for (const s of turnTexts(t)) for (const sh of shingles(s, 5)) reg.add(sh);
    const hits: string[] = [];
    for (const t of heldout) for (const s of turnTexts(t)) for (const sh of shingles(s, 5)) if (reg.has(sh)) hits.push(`"${sh}" in "${s}"`);
    expect(hits).toEqual([]);
  });

  it("the regression set's contamination count cited in the README is still 33 of 50 turns", () => {
    const litShingles = new Set<string>();
    for (const l of promptLits) for (const sh of shingles(l, 5)) litShingles.add(sh);
    const reg = readJsonl("eval/transcript.jsonl");
    const contaminated = reg.filter((t) =>
      turnTexts(t).some((text) => {
        const nt = ` ${norm(text)} `;
        return promptLits.some((l) => norm(l) === nt.trim() || (words(l).length >= 3 && nt.includes(` ${norm(l)} `))) || [...shingles(text, 5)].some((sh) => litShingles.has(sh));
      }),
    ).length;
    expect(reg.length).toBe(50);
    expect(contaminated).toBe(33);
  });
});
