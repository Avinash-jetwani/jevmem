/**
 * The dead-end eval sets (eval/dead-ends-dev.jsonl for tuning, eval/dead-ends-heldout.jsonl run once): well formed,
 * the mix the docs describe, and no text shared between the two, with any other eval set, or with jevmem's prompts
 * (src/questions.ts, and src/guard.ts, whose gate noul recall asks about unverified lines).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sets = { dev: read("eval/dead-ends-dev.jsonl"), heldout: read("eval/dead-ends-heldout.jsonl") };
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
/** Every text a row sends: the turn, the previous turns and the project's memory lines. */
const rowTexts = (t: any): string[] => [t.user, t.assistant, t.previous ?? "", ...(t.existing ?? []).map((m: any) => m.text)].filter(Boolean);
/** Texts of the other eval sets, whatever their shape. */
function otherTexts(file: string): string[] {
  return read(file).flatMap((r: any) => {
    if (r.type === "rules") return r.rules.map((x: any) => x.text);
    if (r.type === "call") return [r.command, r.file, r.old, r.new, r.content].filter(Boolean);
    if (typeof r.text === "string") return [r.text, r.query].filter(Boolean);
    return rowTexts(r);
  });
}
const OTHER_SETS = ["eval/transcript.jsonl", "eval/heldout.jsonl", "eval/contradictions-dev.jsonl", "eval/guard-dev.jsonl", "eval/guard-heldout.jsonl", "eval/memory-injection.jsonl", "eval/memory-injection-dev.jsonl"];
const TAGS = ["dead-end", "a-failed-b-worked", "dead-end-reversal", "supersede", "supersede-near-miss", "transient", "test-first", "options-not-tried", "taste-change", "no-reason", "ordinary"];
const KINDS = ["decision", "constraint", "preference", "bug", "architecture", "todo", "dead-end"];

describe("eval/dead-ends-*.jsonl", () => {
  for (const [name, rows] of Object.entries(sets)) {
    it(`${name}: every row is labelled, dead ends say what was tried and why (keys found in the turn), and the mix holds every case the brief names`, () => {
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
      for (const r of rows) {
        expect(TAGS, r.id).toContain(r.tag);
        expect(typeof r.user === "string" && typeof r.assistant === "string", r.id).toBe(true);
        expect(r.existing.length, r.id).toBeGreaterThanOrEqual(3);
        expect(r.existing.length, r.id).toBeLessThanOrEqual(15);
        expect(r.label.save ? KINDS.includes(r.label.kind) : r.label.kind === "none", r.id).toBe(true);
        expect(Array.isArray(r.accept) && r.accept.length > 0, r.id).toBe(true);
        for (const a of r.accept) expect([...KINDS, "skip"], r.id).toContain(a);
        if (r.contradicts) expect(r.existing.map((m: any) => m.id), r.id).toContain(r.contradicts);
        // Dead ends, and only they, carry what was tried and why; each has at least one key of each in its turn text.
        expect(Boolean(r.deadEnd), r.id).toBe(["dead-end", "a-failed-b-worked", "dead-end-reversal"].includes(r.tag));
        expect(r.label.kind === "dead-end", r.id).toBe(Boolean(r.deadEnd));
        if (r.deadEnd) {
          const d = r.deadEnd;
          const text = (d.source === "user" ? r.user : d.source === "assistant" ? r.assistant : `${r.user} ${r.assistant}`).toLowerCase();
          expect(["user", "assistant", "both"], r.id).toContain(d.source);
          expect(d.tried && d.why, r.id).toBeTruthy();
          expect(d.triedKeys.some((k: string) => text.includes(k.toLowerCase())), `${r.id} tried`).toBe(true);
          expect(d.whyKeys.some((k: string) => text.includes(k.toLowerCase())), `${r.id} why`).toBe(true);
          if (d.worked) expect(d.workedKeys.some((k: string) => text.includes(k.toLowerCase())), `${r.id} worked`).toBe(true);
        }
        if (r.tag === "supersede") expect(r.existing.find((m: any) => m.id === r.contradicts)?.kind, r.id).toBe("dead-end");
      }
      const n = (tag: string) => rows.filter((r) => r.tag === tag).length;
      expect(rows.filter((r) => r.deadEnd).length).toBeGreaterThanOrEqual(25);
      expect(n("a-failed-b-worked")).toBeGreaterThanOrEqual(5);
      expect(n("dead-end-reversal")).toBeGreaterThanOrEqual(4);
      expect(n("supersede")).toBeGreaterThanOrEqual(5);
      for (const tag of ["transient", "test-first", "options-not-tried", "taste-change", "no-reason"]) expect(n(tag), tag).toBeGreaterThanOrEqual(4);
      expect(n("ordinary")).toBeGreaterThanOrEqual(30);
      const ordinaryKinds = new Set(rows.filter((r) => r.tag === "ordinary" && r.label.save).map((r) => r.label.kind));
      for (const k of ["decision", "constraint", "preference", "bug", "architecture", "todo"]) expect(ordinaryKinds.has(k), k).toBe(true);
      // Dead ends reported by the user and by the assistant, and the assistant's where the user did not ask a question.
      expect(rows.filter((r) => r.deadEnd?.source === "user").length).toBeGreaterThanOrEqual(8);
      expect(rows.filter((r) => r.deadEnd?.source === "assistant").length).toBeGreaterThanOrEqual(8);
    });
  }

  it("the two sets share no project, no equal text and no run of five words", () => {
    const hits: string[] = [];
    const devSh = new Map<string, string>();
    const devNorm = new Set<string>();
    for (const r of sets.dev) for (const t of rowTexts(r)) {
      devNorm.add(norm(t));
      for (const sh of shingles(t, 5)) devSh.set(sh, t);
    }
    for (const r of sets.heldout) for (const t of rowTexts(r)) {
      if (devNorm.has(norm(t)) && words(t).length > 2) hits.push(`equal: ${t}`);
      for (const sh of shingles(t, 5)) if (devSh.has(sh)) hits.push(`5 words "${sh}": ${t} ~ ${devSh.get(sh)}`);
    }
    const devProjects = new Set(sets.dev.map((r) => r.project));
    for (const p of new Set(sets.heldout.map((r) => r.project))) if (devProjects.has(p)) hits.push(`project ${p}`);
    expect(hits).toEqual([]);
  });

  it("neither set shares a run of five words with any other eval set", () => {
    const other = new Map<string, string>();
    for (const f of OTHER_SETS) for (const t of otherTexts(f)) for (const sh of shingles(t, 5)) other.set(sh, f);
    const hits: string[] = [];
    for (const [name, rows] of Object.entries(sets)) for (const r of rows) for (const t of rowTexts(r)) for (const sh of shingles(t, 5)) if (other.has(sh)) hits.push(`${name} ${r.id}: "${sh}" (${other.get(sh)})`);
    expect(hits).toEqual([]);
  });

  it("neither set shares text with jevmem's prompts (src/questions.ts, src/guard.ts): no equal string, no contained phrase of 3+ words, no shared 5-word run", () => {
    const lits = [...literals(fs.readFileSync(path.resolve("src/questions.ts"), "utf8")), ...literals(fs.readFileSync(path.resolve("src/guard.ts"), "utf8"))];
    const litSh = new Map<string, string>();
    for (const l of lits) for (const sh of shingles(l, 5)) litSh.set(sh, l);
    const hits: string[] = [];
    for (const [name, rows] of Object.entries(sets)) {
      for (const r of rows) {
        for (const text of rowTexts(r)) {
          const nt = ` ${norm(text)} `;
          for (const l of lits) {
            const nl = norm(l);
            if (nl === nt.trim()) hits.push(`${name} ${r.id} equal: "${text}" = prompt "${l}"`);
            else if (words(l).length >= 3 && nt.includes(` ${nl} `)) hits.push(`${name} ${r.id} contains prompt "${l}"`);
          }
          for (const sh of shingles(text, 5)) if (litSh.has(sh)) hits.push(`${name} ${r.id} 5-gram "${sh}" (prompt "${litSh.get(sh)}")`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
