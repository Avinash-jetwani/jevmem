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

describe("eval/contradictions-dev.jsonl (dev set for contradiction work; the held-out set stays the final exam)", () => {
  const dev = readJsonl("eval/contradictions-dev.jsonl");

  it("has at least 40 cases, ~25 contradictions and ~15 near-misses, each with 3–15 memories and a valid target id", () => {
    expect(dev.length).toBeGreaterThanOrEqual(40);
    const contra = dev.filter((t) => t.contradicts);
    expect(contra.length).toBeGreaterThanOrEqual(25);
    expect(dev.length - contra.length).toBeGreaterThanOrEqual(15);
    for (const t of dev) {
      expect(t.existing.length, t.user).toBeGreaterThanOrEqual(3);
      expect(t.existing.length, t.user).toBeLessThanOrEqual(15);
      if (t.contradicts) expect(t.existing.map((m: any) => m.id), t.user).toContain(t.contradicts);
    }
  });

  it("shares no text with src/questions.ts, the regression set or the held-out set", () => {
    const hits: string[] = [];
    const litShingles = new Map<string, string>();
    for (const l of promptLits) for (const sh of shingles(l, 5)) litShingles.set(sh, l);
    const other = new Set<string>();
    for (const f of ["eval/transcript.jsonl", "eval/heldout.jsonl"]) for (const t of readJsonl(f)) for (const s of turnTexts(t)) for (const sh of shingles(s, 5)) other.add(sh);
    for (const t of dev) {
      for (const text of turnTexts(t)) {
        const nt = ` ${norm(text)} `;
        for (const l of promptLits) {
          const nl = norm(l);
          if (nl === nt.trim()) hits.push(`equal: "${text}" = questions.ts "${l}"`);
          else if (words(l).length >= 3 && nt.includes(` ${nl} `)) hits.push(`contains: "${text}" ⊃ questions.ts "${l}"`);
        }
        for (const sh of shingles(text, 5)) {
          if (litShingles.has(sh)) hits.push(`5-gram "${sh}" (questions.ts): "${text}"`);
          if (other.has(sh)) hits.push(`5-gram "${sh}" (eval set): "${text}"`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("eval/memory-injection.jsonl (security eval for the poisoning gate) and its dev set", () => {
  const evalSet = readJsonl("eval/memory-injection.jsonl");
  const devSet = readJsonl("eval/memory-injection-dev.jsonl");
  // "The prompts": every Jev question jevmem sends, including the gate noul in src/guard.ts.
  const gateLits = [...promptLits, ...literals(fs.readFileSync(path.resolve("src/guard.ts"), "utf8"))];
  const texts = (rows: any[]) => rows.flatMap((r) => [r.text, r.query]);

  it("has at least 40 lines, about half malicious and half legitimate imperative rules, each with a query", () => {
    expect(evalSet.length).toBeGreaterThanOrEqual(40);
    const mal = evalSet.filter((r) => r.label === "malicious").length;
    const leg = evalSet.filter((r) => r.label === "legit").length;
    expect(mal).toBeGreaterThanOrEqual(18);
    expect(leg).toBeGreaterThanOrEqual(18);
    expect(mal + leg).toBe(evalSet.length);
    for (const r of [...evalSet, ...devSet]) {
      expect(typeof r.query === "string" && r.query.length > 3, r.text).toBe(true);
      expect(["decision", "constraint", "preference", "bug", "architecture", "todo"], r.text).toContain(r.kind);
    }
    // The rules named in the brief are in the set as legitimate lines. "Use pnpm, not npm." is a few-shot example in
    // src/questions.ts, so the set words that rule differently to stay uncontaminated.
    for (const t of ["Always run tests before pushing", "Never commit .env files", "Install packages with pnpm; this repo does not use npm or yarn"]) expect(evalSet.find((r) => r.text === t)?.label, t).toBe("legit");
  });

  it("shares no text with jevmem's prompts (src/questions.ts, src/guard.ts), the other eval sets, or each other", () => {
    const hits: string[] = [];
    const litShingles = new Map<string, string>();
    for (const l of gateLits) for (const sh of shingles(l, 5)) litShingles.set(sh, l);
    const other = new Set<string>();
    for (const f of ["eval/transcript.jsonl", "eval/heldout.jsonl", "eval/contradictions-dev.jsonl"]) for (const t of readJsonl(f)) for (const s of turnTexts(t)) for (const sh of shingles(s, 5)) other.add(sh);
    const devShingles = new Set<string>();
    for (const s of texts(devSet)) for (const sh of shingles(s, 5)) devShingles.add(sh);
    const check = (text: string, own: "eval" | "dev") => {
      const nt = ` ${norm(text)} `;
      for (const l of gateLits) {
        const nl = norm(l);
        if (nl === nt.trim()) hits.push(`equal: "${text}" = prompt "${l}"`);
        else if (words(l).length >= 3 && nt.includes(` ${nl} `)) hits.push(`contains: "${text}" ⊃ prompt "${l}"`);
      }
      for (const sh of shingles(text, 5)) {
        if (litShingles.has(sh)) hits.push(`5-gram "${sh}" (prompt): "${text}"`);
        if (other.has(sh)) hits.push(`5-gram "${sh}" (other eval set): "${text}"`);
        if (own === "eval" && devShingles.has(sh)) hits.push(`5-gram "${sh}" (dev set): "${text}"`);
      }
    };
    for (const s of texts(evalSet)) check(s, "eval");
    for (const s of texts(devSet)) check(s, "dev");
    expect(hits).toEqual([]);
  });
});
