/**
 * The retrieval eval sets of v0.6 part 3 (eval/recall-dev.jsonl for tuning, eval/recall-heldout.jsonl run once at the
 * end), committed before any change to recall, and part 3b's fresh held-out set (eval/recall-heldout-v2.jsonl, the same
 * design, committed before any change in that part): each holds three memory files (small, medium, large) and prompts of
 * five types, labelled with the lines they need, the lines that are fine to add, and the lines they must never get. The
 * sets share no text with each other, with any other eval set (including the outcome A/B's memory lines and the Stop
 * hook's sessions), or with the questions jevmem asks Jev (src/questions.ts, src/guard.ts, src/recall.ts,
 * src/guardrail.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseLine } from "../src/memfile.js";
import { formatLine } from "../src/store.js";

const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const SETS = { dev: read("eval/recall-dev.jsonl"), heldout: read("eval/recall-heldout.jsonl"), heldout2: read("eval/recall-heldout-v2.jsonl") };
const TYPES = ["direct", "indirect", "unrelated", "supersede", "dead-end"];
const SIZES: Record<string, [number, number]> = { small: [15, 30], medium: [60, 100], large: [200, 300] };
const MIN_PROMPTS: Record<string, number> = { small: 4, medium: 6, large: 8 };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s: string) => norm(s).split(" ").filter(Boolean);
function shingles(s: string, n: number): Set<string> {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}
/** Every string literal in a source file. */
function literals(src: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  for (const m of src.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1"));
  return out.filter((s) => words(s).length > 0);
}
const setTexts = (rows: any[]) => rows.flatMap((r) => (r.row === "file" ? r.lines.map((l: any) => l.text) : [r.prompt]));

/** Texts of every other eval set in eval/, whatever its shape. */
function otherTexts(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const f of fs.readdirSync("eval").filter((f) => f.endsWith(".jsonl") && !f.startsWith("recall-"))) {
    for (const r of read(path.join("eval", f))) {
      const texts: string[] = [];
      if (r.row === "session") texts.push(...r.prompts);
      else if (r.type === "rules") texts.push(...r.rules.map((x: any) => x.text));
      else if (r.type === "call") texts.push(...[r.command, r.file, r.old, r.new, r.content].filter(Boolean));
      else if (typeof r.text === "string") texts.push(...[r.text, r.query].filter(Boolean));
      else texts.push(...[r.user, r.assistant, r.previous, ...(r.existing ?? []).map((m: any) => m.text)].filter(Boolean));
      for (const t of texts) out.push({ file: f, text: String(t) });
    }
  }
  // The outcome A/B's memory lines and prompts (eval/ab/tasks.mjs) are written as literals.
  for (const t of literals(fs.readFileSync("eval/ab/tasks.mjs", "utf8"))) out.push({ file: "ab/tasks.mjs", text: t });
  return out;
}

describe("eval/recall-*.jsonl", () => {
  for (const [name, rows] of Object.entries(SETS)) {
    it(`${name}: three memory files, one per size, realistic and in jevmem's own line format`, () => {
      const files = rows.filter((r) => r.row === "file");
      expect(files.map((f) => f.size).sort()).toEqual(["large", "medium", "small"]);
      for (const f of files) {
        const [lo, hi] = SIZES[f.size]!;
        expect(f.lines.length, f.id).toBeGreaterThanOrEqual(lo);
        expect(f.lines.length, f.id).toBeLessThanOrEqual(hi);
        const ids = new Set(f.lines.map((l: any) => l.id));
        const keys = new Set(f.lines.map((l: any) => l.key));
        expect(ids.size, f.id).toBe(f.lines.length);
        expect(keys.size, f.id).toBe(f.lines.length);
        expect(new Set(f.lines.map((l: any) => norm(l.text))).size, `${f.id}: two lines say the same`).toBe(f.lines.length);
        const pos = new Map(f.lines.map((l: any, i: number) => [l.key, i]));
        const kinds = new Set(f.lines.map((l: any) => l.kind));
        // Decisions, rules, dead ends, bugs and superseded lines, as the brief asks.
        for (const k of ["decision", "constraint", "dead-end", "bug", "superseded"]) expect(kinds.has(k), `${f.id} has ${k}`).toBe(true);
        for (const l of f.lines) {
          expect(l.text.length, l.key).toBeLessThanOrEqual(200);
          expect(/^[a-z0-9]{6}$/.test(l.id), l.key).toBe(true);
          // Superseded lines point at a later, live line; nothing else points anywhere.
          // A replacement can itself be superseded later (old → newer → live), as jevmem writes it.
          if (l.kind === "superseded") {
            expect(pos.get(l.by), l.key).toBeGreaterThan(pos.get(l.key) as number);
            let at = l;
            for (let hops = 0; at.kind === "superseded" && hops < 5; hops++) at = f.lines.find((x: any) => x.key === at.by);
            expect(at.kind, `${l.key}: its chain ends in a live line`).not.toBe("superseded");
          } else expect(l.by, l.key).toBeNull();
          // The line round-trips through jevmem's own format and parser.
          const byId = l.by ? f.lines.find((x: any) => x.key === l.by).id : undefined;
          const parsed = parseLine(formatLine({ id: l.id, kind: l.kind, text: l.text, ts: l.ts, conf: l.conf, ...(byId ? { supersededBy: byId } : {}) }));
          expect(parsed?.text, l.key).toBe(l.text);
          expect(parsed?.supersededBy, l.key).toBe(byId);
        }
        // Timestamps rise through the file (older lines first).
        for (let i = 1; i < f.lines.length; i++) expect(f.lines[i].ts > f.lines[i - 1].ts, f.id).toBe(true);
        // Look-alike lines (near-duplicate distractors) are named, and exist.
        expect(f.nearDuplicates.length, f.id).toBeGreaterThanOrEqual(f.size === "small" ? 2 : f.size === "medium" ? 5 : 15);
        for (const g of f.nearDuplicates) for (const k of g) expect(keys.has(k), `${f.id} near-duplicate ${k}`).toBe(true);
      }
    });

    it(`${name}: every prompt type for every file, labelled with lines of that file`, () => {
      const files = new Map(rows.filter((r) => r.row === "file").map((f) => [f.id, f]));
      const prompts = rows.filter((r) => r.row === "prompt");
      expect(new Set(prompts.map((p) => p.id)).size).toBe(prompts.length);
      for (const [id, f] of files) {
        for (const t of TYPES) expect(prompts.filter((p) => p.file === id && p.type === t).length, `${id} ${t}`).toBeGreaterThanOrEqual(MIN_PROMPTS[f.size]!);
      }
      for (const p of prompts) {
        const f = files.get(p.file);
        expect(f, p.id).toBeDefined();
        expect(TYPES, p.id).toContain(p.type);
        const kind = (k: string) => f.lines.find((l: any) => l.key === k)?.kind;
        for (const k of [...p.want, ...p.ok, ...p.never]) expect(kind(k), `${p.id} ${k}`).toBeDefined();
        // Wanted and acceptable lines are live; a line is in one list only.
        for (const k of [...p.want, ...p.ok]) expect(kind(k), `${p.id} ${k}`).not.toBe("superseded");
        expect(new Set([...p.want, ...p.ok, ...p.never]).size, p.id).toBe(p.want.length + p.ok.length + p.never.length);
        if (p.type === "unrelated") expect(p.want, p.id).toEqual([]);
        else expect(p.want.length, p.id).toBeGreaterThan(0);
        // After a supersede: the prompt needs the live line at the end of the chain and must never get the superseded
        // lines on the way (a line can be superseded twice: old → newer → live).
        if (p.type === "supersede") {
          expect(p.never.length, p.id).toBeGreaterThan(0);
          for (const k of p.never) {
            expect(kind(k), p.id).toBe("superseded");
            let at = f.lines.find((l: any) => l.key === k);
            for (let hops = 0; at.kind === "superseded" && hops < 5; hops++) at = f.lines.find((l: any) => l.key === at.by);
            expect(p.want, `${p.id}: ${k} ends at ${at.key}`).toContain(at.key);
          }
        }
        if (p.type === "dead-end") expect(p.want.some((k: string) => kind(k) === "dead-end"), p.id).toBe(true);
      }
    });
  }

  it("the sets share no text with each other (normalised: no equal text, and no shared 5-word run)", () => {
    const names = Object.keys(SETS) as (keyof typeof SETS)[];
    const hits: string[] = [];
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++) {
        const a = setTexts(SETS[names[i]!]);
        const b = setTexts(SETS[names[j]!]);
        const aSh = new Map<string, string>();
        for (const t of a) for (const s of shingles(t, 5)) aSh.set(s, t);
        const aNorm = new Set(a.map(norm));
        for (const t of b) {
          if (aNorm.has(norm(t))) hits.push(`equal in ${names[i]} and ${names[j]}: ${t}`);
          for (const s of shingles(t, 5)) if (aSh.has(s)) hits.push(`"${s}" in ${names[j]} "${t}" and ${names[i]} "${aSh.get(s)}"`);
        }
      }
    expect(hits).toEqual([]);
  });

  it("the sets share no text with any other eval set or the outcome A/B (no equal text, no shared 5-word run)", () => {
    const others = otherTexts();
    const sh = new Map<string, string>();
    for (const o of others) for (const s of shingles(o.text, 5)) sh.set(s, `${o.file}: ${o.text.slice(0, 80)}`);
    const eq = new Map(others.map((o) => [norm(o.text), o.file]));
    const hits: string[] = [];
    for (const [name, rows] of Object.entries(SETS)) {
      for (const t of setTexts(rows)) {
        if (eq.has(norm(t))) hits.push(`${name} equal to ${eq.get(norm(t))}: ${t}`);
        for (const s of shingles(t, 5)) if (sh.has(s)) hits.push(`${name} "${s}" (${sh.get(s)})`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the sets share no text with the questions jevmem asks (src/questions.ts, guard.ts, recall.ts, guardrail.ts)", () => {
    const lits = ["src/questions.ts", "src/guard.ts", "src/recall.ts", "src/guardrail.ts"].flatMap((f) => literals(fs.readFileSync(f, "utf8")));
    const litSh = new Map<string, string>();
    for (const l of lits) for (const s of shingles(l, 5)) litSh.set(s, l);
    const hits: string[] = [];
    for (const [name, rows] of Object.entries(SETS)) {
      for (const text of setTexts(rows)) {
        const nt = ` ${norm(text)} `;
        for (const l of lits) {
          const nl = norm(l);
          if (words(l).length >= 3 && nt.includes(` ${nl} `)) hits.push(`${name} contains prompt text "${l}": ${text}`);
        }
        for (const s of shingles(text, 5)) if (litSh.has(s)) hits.push(`${name} 5-gram "${s}" (prompt "${litSh.get(s)}")`);
      }
    }
    expect(hits).toEqual([]);
  });
});
