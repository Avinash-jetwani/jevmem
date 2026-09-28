/**
 * The guard's eval sets (eval/guard-dev.jsonl for tuning, eval/guard-heldout.jsonl run once, and the git staging dev
 * set eval/guard-git-dev.jsonl): well formed, the mix the docs describe, no text shared between dev and held-out, and
 * none shared with the guard's own question examples.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sets = { dev: read("eval/guard-dev.jsonl"), heldout: read("eval/guard-heldout.jsonl") };
const gitDev = read("eval/guard-git-dev.jsonl");
const TREE_KEYS = ["committed", "modified", "staged", "untracked", "ignored"];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s: string) => norm(s).split(" ").filter(Boolean);
function shingles(s: string, n: number): Set<string> {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}
/** Every text in a set: rule texts, commands, file paths and edit contents. */
const texts = (recs: any[]): string[] =>
  recs.flatMap((r) => (r.type === "rules" ? r.rules.map((x: any) => x.text) : [r.command, r.file, r.old, r.new, r.content].filter(Boolean)));

describe("eval/guard-*.jsonl", () => {
  for (const [name, recs] of Object.entries(sets)) {
    it(`${name}: calls reference their project's rules, and the mix holds plain, content, compound and indirect hits, near misses and a majority of everyday calls`, () => {
      const rules = new Map(recs.filter((r) => r.type === "rules").map((r) => [r.project, new Set(r.rules.map((x: any) => x.id))]));
      const calls = recs.filter((r) => r.type === "call");
      expect(new Set(calls.map((c) => c.id)).size).toBe(calls.length);
      for (const c of calls) {
        expect(rules.has(c.project), c.id).toBe(true);
        for (const b of c.breaks) expect(rules.get(c.project)!.has(b), `${c.id} ${b}`).toBe(true);
        expect(["plain", "content", "compound", "indirect", "near-miss", "everyday"]).toContain(c.category);
        expect(["near-miss", "everyday"].includes(c.category), c.id).toBe(c.breaks.length === 0);
        expect(c.tool === "Bash" ? typeof c.command : typeof c.file, c.id).toBe("string");
      }
      const n = (cat: string) => calls.filter((c) => c.category === cat).length;
      expect(calls.length).toBeGreaterThanOrEqual(150);
      expect(calls.filter((c) => c.breaks.length).length).toBeGreaterThanOrEqual(35);
      expect(n("indirect")).toBeGreaterThanOrEqual(8);
      expect(n("content")).toBeGreaterThanOrEqual(5);
      expect(n("compound")).toBeGreaterThanOrEqual(5);
      expect(n("near-miss")).toBeGreaterThanOrEqual(25);
      expect(n("everyday") / calls.length).toBeGreaterThan(0.6);
    });
  }

  it("the two sets share no text: no equal rule or call, and no run of five words in common", () => {
    const hits: string[] = [];
    const dev = texts(sets.dev);
    const devNorm = new Set(dev.map(norm));
    const devSh = new Map<string, string>();
    for (const t of dev) for (const sh of shingles(t, 5)) devSh.set(sh, t);
    for (const t of texts(sets.heldout)) {
      if (devNorm.has(norm(t)) && words(t).length > 1) hits.push(`equal: ${t}`);
      for (const sh of shingles(t, 5)) if (devSh.has(sh)) hits.push(`5 words "${sh}": ${t} ~ ${devSh.get(sh)}`);
    }
    const devProjects = new Set(sets.dev.filter((r) => r.type === "rules").map((r) => r.project));
    for (const r of sets.heldout.filter((x) => x.type === "rules")) if (devProjects.has(r.project)) hits.push(`project ${r.project}`);
    expect(hits).toEqual([]);
  });

  it("a call's working tree (`tree`) names only known states and relative paths; every indirect git add or commit has one", () => {
    for (const recs of [...Object.values(sets), gitDev])
      for (const c of recs.filter((r) => r.type === "call" && r.tree)) {
        for (const [k, v] of Object.entries(c.tree)) {
          expect(TREE_KEYS, `${c.id} ${k}`).toContain(k);
          for (const f of v as string[]) expect(f, c.id).toMatch(/^[^/.][^]*$|^\.[^./][^]*$/);
        }
      }
    for (const recs of Object.values(sets))
      for (const c of recs.filter((r) => r.type === "call" && r.category === "indirect" && /\bgit (?:add|commit)\b/.test(r.command ?? ""))) expect(c.tree, c.id).toBeTruthy();
  });

  it("git-dev: 20 git add and git commit calls in one project, each with a working tree; breaks are indirect", () => {
    const rules = new Set(gitDev.filter((r) => r.type === "rules").flatMap((r) => r.rules.map((x: any) => `${r.project}/${x.id}`)));
    const calls = gitDev.filter((r) => r.type === "call");
    expect(calls).toHaveLength(20);
    for (const c of calls) {
      expect(c.tool, c.id).toBe("Bash");
      expect(c.tree, c.id).toBeTruthy();
      for (const b of c.breaks) expect(rules.has(`${c.project}/${b}`), `${c.id} ${b}`).toBe(true);
      expect(c.category, c.id).toBe(c.breaks.length ? "indirect" : c.category);
      expect(["indirect", "near-miss", "everyday"]).toContain(c.category);
    }
    expect(calls.filter((c) => c.breaks.length)).toHaveLength(6);
  });

  it("neither set shares a run of four words with the guard's question and its examples (src/guardrail.ts)", () => {
    const src = fs.readFileSync(path.resolve("src/guardrail.ts"), "utf8");
    const noul = src.slice(src.indexOf("export function breakNoul"), src.indexOf("// Input"));
    const lits = [...noul.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? "").filter((s) => words(s).length >= 4);
    const litSh = new Map<string, string>();
    for (const l of lits) for (const sh of shingles(l, 4)) litSh.set(sh, l);
    const hits: string[] = [];
    for (const recs of [...Object.values(sets), gitDev]) for (const t of texts(recs)) for (const sh of shingles(t, 4)) if (litSh.has(sh)) hits.push(`"${sh}": ${t}`);
    expect(hits).toEqual([]);
  });
});
