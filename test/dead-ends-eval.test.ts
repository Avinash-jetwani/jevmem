/**
 * The dead-end eval sets (eval/dead-ends-dev.jsonl for tuning, eval/dead-ends-heldout.jsonl run once): well formed,
 * the mix the docs describe, and no text shared between the two, with any other eval set, or with jevmem's prompts
 * (src/questions.ts, and src/guard.ts, whose gate noul recall asks about unverified lines).
 *
 * Part 2b added four sets, committed before any fix: eval/dead-ends-dev-v2.jsonl (tuning: a dead end Claude makes work,
 * a dead end that agrees with a listed line, Claude's reply contradicting a listed line, questions with no content),
 * eval/dead-ends-heldout-v2.jsonl (held-out v2, run once at the end, every case), and the planted dead-end lines for the
 * poisoning gate, eval/dead-ends-gate-dev.jsonl and eval/dead-ends-gate-heldout-v2.jsonl. They get the same checks.
 *
 * Part 2c added two more, committed before any part 2c change: eval/dead-ends-dev-v3.jsonl (tuning) and
 * eval/dead-ends-heldout-v3.jsonl (held-out v3, run once at the end): plain statements whose reply adds nothing,
 * questions and proposals next to a listed line, dead ends that reverse a listed line, retests of a listed dead end
 * that fail again (for the same reason, or a new one), dead ends with the reason after "but", and ordinary turns.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sets = { dev: read("eval/dead-ends-dev.jsonl"), heldout: read("eval/dead-ends-heldout.jsonl") };
const setsV2 = { devV2: read("eval/dead-ends-dev-v2.jsonl"), heldoutV2: read("eval/dead-ends-heldout-v2.jsonl") };
const gateSets = { gateDev: read("eval/dead-ends-gate-dev.jsonl"), gateHeldoutV2: read("eval/dead-ends-gate-heldout-v2.jsonl") };
const setsV3 = { devV3: read("eval/dead-ends-dev-v3.jsonl"), heldoutV3: read("eval/dead-ends-heldout-v3.jsonl") };
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
/** v2 adds: Claude makes a listed dead end work, a dead end that keeps a listed line, the reply contradicting a listed line, a question with no content. */
const TAGS_V2 = [...TAGS, "supersede-by-reply", "dead-end-agrees", "reply-chatter", "question-no-content"];
const DEAD_END_TAGS = ["dead-end", "a-failed-b-worked", "dead-end-reversal", "dead-end-agrees"];
/** v3: a plain statement whose reply adds nothing, a question or proposal next to a listed line, a dead end that reverses a
 * listed line, a retest of a listed dead end that fails again for the same reason or a new one, a dead end, ordinary turns. */
const TAGS_V3 = ["plain-statement", "question-proposal", "dead-end-reversal", "retest-same", "retest-new", "dead-end", "ordinary"];
const DEAD_END_TAGS_V3 = ["dead-end-reversal", "retest-new", "dead-end"];
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

describe("part 2b: eval/dead-ends-*-v2.jsonl and the planted dead-end lines", () => {
  for (const [name, rows] of Object.entries(setsV2)) {
    it(`${name}: every row is labelled, each case has the label it needs, and dead ends carry what was tried and why`, () => {
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
      for (const r of rows) {
        expect(TAGS_V2, r.id).toContain(r.tag);
        expect(typeof r.user === "string" && typeof r.assistant === "string", r.id).toBe(true);
        expect(r.existing.length, r.id).toBeGreaterThanOrEqual(3);
        expect(r.existing.length, r.id).toBeLessThanOrEqual(15);
        expect(r.label.save ? KINDS.includes(r.label.kind) : r.label.kind === "none", r.id).toBe(true);
        expect(Array.isArray(r.accept) && r.accept.length > 0, r.id).toBe(true);
        for (const a of r.accept) expect([...KINDS, "skip"], r.id).toContain(a);
        expect(r.accept, r.id).toContain(r.label.save ? r.label.kind : "skip");
        if (r.contradicts) expect(r.existing.map((m: any) => m.id), r.id).toContain(r.contradicts);
        expect(Boolean(r.deadEnd), r.id).toBe(DEAD_END_TAGS.includes(r.tag));
        expect(r.label.kind === "dead-end", r.id).toBe(Boolean(r.deadEnd));
        if (r.deadEnd) {
          const d = r.deadEnd;
          const text = (d.source === "user" ? r.user : d.source === "assistant" ? r.assistant : `${r.user} ${r.assistant}`).toLowerCase();
          expect(["user", "assistant", "both"], r.id).toContain(d.source);
          expect(d.triedKeys.some((k: string) => text.includes(k.toLowerCase())), `${r.id} tried`).toBe(true);
          expect(d.whyKeys.some((k: string) => text.includes(k.toLowerCase())), `${r.id} why`).toBe(true);
          if (d.worked) expect(d.workedKeys.some((k: string) => text.includes(k.toLowerCase())), `${r.id} worked`).toBe(true);
        }
        // A dead end that now works, told by the user or made to work by Claude, supersedes that dead end, and is not saved
        // as a second one.
        if (r.tag === "supersede" || r.tag === "supersede-by-reply") {
          expect(r.existing.find((m: any) => m.id === r.contradicts)?.kind, r.id).toBe("dead-end");
          expect(r.accept, r.id).not.toContain("dead-end");
        }
        // These must never supersede anything.
        if (["dead-end-agrees", "reply-chatter", "question-no-content", "supersede-near-miss"].includes(r.tag)) expect(r.contradicts, r.id).toBeUndefined();
        if (r.tag === "question-no-content") expect(r.accept, r.id).toEqual(["skip"]);
        // A reply that contradicts a listed line: the listed lines it could reach are not dead ends.
        if (r.tag === "reply-chatter") expect(r.existing.every((m: any) => m.kind !== "dead-end"), r.id).toBe(true);
      }
    });
  }

  it("held-out v2 holds every case, and dev v2 the new ones", () => {
    const h = setsV2.heldoutV2;
    const n = (rows: any[], tag: string, subtype?: string) => rows.filter((r) => r.tag === tag && (!subtype || r.subtype === subtype)).length;
    expect(h.filter((r) => r.deadEnd).length).toBeGreaterThanOrEqual(30);
    expect(h.filter((r) => r.deadEnd?.source === "user").length).toBeGreaterThanOrEqual(8);
    expect(h.filter((r) => r.deadEnd?.source === "assistant").length).toBeGreaterThanOrEqual(8);
    for (const tag of ["a-failed-b-worked", "dead-end-reversal", "dead-end-agrees", "supersede", "reply-chatter", "question-no-content", "transient", "test-first", "options-not-tried", "taste-change", "no-reason"]) expect(n(h, tag), tag).toBeGreaterThanOrEqual(5);
    expect(n(h, "supersede-by-reply", "question")).toBeGreaterThanOrEqual(4);
    expect(n(h, "supersede-by-reply", "order")).toBeGreaterThanOrEqual(4);
    for (const s of ["mention", "retest", "proposed"]) expect(n(h, "supersede-near-miss", s), s).toBeGreaterThanOrEqual(2);
    expect(n(h, "ordinary")).toBeGreaterThanOrEqual(25);
    const kinds = new Set(h.filter((r) => r.tag === "ordinary" && r.label.save).map((r) => r.label.kind));
    for (const k of ["decision", "constraint", "preference", "bug", "architecture", "todo"]) expect(kinds.has(k), k).toBe(true);
    // Ordinary turns in a project with a live dead end on a related topic.
    expect(h.filter((r) => r.tag === "ordinary" && r.existing.some((m: any) => m.kind === "dead-end")).length).toBeGreaterThanOrEqual(5);
    const d = setsV2.devV2;
    expect(n(d, "supersede-by-reply")).toBeGreaterThanOrEqual(8);
    for (const tag of ["dead-end-agrees", "dead-end-reversal", "supersede"]) expect(n(d, tag), tag).toBeGreaterThanOrEqual(3);
    for (const tag of ["reply-chatter", "question-no-content", "supersede-near-miss"]) expect(n(d, tag), tag).toBeGreaterThanOrEqual(6);
  });

  for (const [name, rows] of Object.entries(gateSets)) {
    it(`${name}: planted lines drop review, tests, CI, backups or approvals; real dead ends, many about the same steps, must pass`, () => {
      const cats = ["drop-review", "drop-tests", "drop-ci", "drop-backups", "drop-approvals"];
      const min = name === "gateDev" ? 3 : 4;
      for (const r of rows) {
        expect(["malicious", "legit"]).toContain(r.label);
        expect(r.kind).toBe("dead-end");
        expect(typeof r.text === "string" && r.text.length > 20 && r.text.length <= 200, r.text).toBe(true);
        expect(typeof r.query === "string" && r.query.length > 0).toBe(true);
        expect(r.label === "malicious", r.text).toBe(cats.includes(r.category));
      }
      for (const c of cats) expect(rows.filter((r) => r.category === c).length, c).toBeGreaterThanOrEqual(min);
      const legit = rows.filter((r) => r.label === "legit");
      expect(legit.length).toBe(rows.length - legit.length);
      // Hard cases: real dead ends about review, tests, CI, backups or approvals.
      expect(legit.filter((r) => r.category !== "other").length).toBeGreaterThanOrEqual(min * 3);
      expect(new Set(rows.map((r) => r.text)).size).toBe(rows.length);
    });
  }

  it("no two dead-end sets share a project, an equal text or a run of five words", () => {
    const all: Record<string, string[]> = {};
    for (const [name, rows] of Object.entries({ ...sets, ...setsV2, ...setsV3 })) all[name] = rows.flatMap(rowTexts);
    for (const [name, rows] of Object.entries(gateSets)) all[name] = rows.flatMap((r) => [r.text, r.query]);
    const hits: string[] = [];
    const names = Object.keys(all);
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i]!, b = names[j]!;
        const sh = new Map<string, string>();
        const eq = new Set<string>();
        for (const t of all[a]!) {
          eq.add(norm(t));
          for (const s of shingles(t, 5)) sh.set(s, t);
        }
        for (const t of all[b]!) {
          if (eq.has(norm(t)) && words(t).length > 2) hits.push(`${a}/${b} equal: ${t}`);
          for (const s of shingles(t, 5)) if (sh.has(s)) hits.push(`${a}/${b} "${s}": ${t} ~ ${sh.get(s)}`);
        }
      }
    const projects = (rows: any[]) => new Set(rows.map((r) => r.project));
    const v2 = new Set([...projects(setsV2.devV2), ...projects(setsV2.heldoutV2)]);
    for (const p of [...projects(sets.dev), ...projects(sets.heldout)]) if (v2.has(p)) hits.push(`project ${p} in v1 and v2`);
    for (const p of projects(setsV2.devV2)) if (projects(setsV2.heldoutV2).has(p)) hits.push(`project ${p} in dev v2 and held-out v2`);
    const v3 = new Set([...projects(setsV3.devV3), ...projects(setsV3.heldoutV3)]);
    for (const p of [...projects(sets.dev), ...projects(sets.heldout), ...v2]) if (v3.has(p)) hits.push(`project ${p} in v3 and an earlier set`);
    for (const p of projects(setsV3.devV3)) if (projects(setsV3.heldoutV3).has(p)) hits.push(`project ${p} in dev v3 and held-out v3`);
    expect(hits).toEqual([]);
  });

  it("no v2 or v3 set shares a run of five words with any other eval set, or text with jevmem's prompts", () => {
    const other = new Map<string, string>();
    for (const f of OTHER_SETS) for (const t of otherTexts(f)) for (const sh of shingles(t, 5)) other.set(sh, f);
    const texts: [string, string][] = [];
    for (const [name, rows] of Object.entries({ ...setsV2, ...setsV3 })) for (const r of rows) for (const t of rowTexts(r)) texts.push([`${name} ${r.id}`, t]);
    for (const [name, rows] of Object.entries(gateSets)) for (const r of rows) for (const t of [r.text, r.query]) texts.push([name, t]);
    const lits = [...literals(fs.readFileSync(path.resolve("src/questions.ts"), "utf8")), ...literals(fs.readFileSync(path.resolve("src/guard.ts"), "utf8"))];
    const litSh = new Map<string, string>();
    for (const l of lits) for (const sh of shingles(l, 5)) litSh.set(sh, l);
    const hits: string[] = [];
    for (const [where, text] of texts) {
      for (const sh of shingles(text, 5)) {
        if (other.has(sh)) hits.push(`${where}: "${sh}" (${other.get(sh)})`);
        if (litSh.has(sh)) hits.push(`${where}: 5-gram "${sh}" (prompt "${litSh.get(sh)}")`);
      }
      const nt = ` ${norm(text)} `;
      for (const l of lits) {
        const nl = norm(l);
        if (nl === nt.trim()) hits.push(`${where} equal: "${text}" = prompt "${l}"`);
        else if (words(l).length >= 3 && nt.includes(` ${nl} `)) hits.push(`${where} contains prompt "${l}"`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("part 2c: eval/dead-ends-dev-v3.jsonl and eval/dead-ends-heldout-v3.jsonl", () => {
  for (const [name, rows] of Object.entries(setsV3)) {
    it(`${name}: every row is labelled, each case has the label it needs, and dead ends carry what was tried and why`, () => {
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
      for (const r of rows) {
        expect(TAGS_V3, r.id).toContain(r.tag);
        expect(typeof r.user === "string" && typeof r.assistant === "string", r.id).toBe(true);
        expect(r.existing.length, r.id).toBeGreaterThanOrEqual(3);
        expect(r.existing.length, r.id).toBeLessThanOrEqual(15);
        expect(new Set(r.existing.map((m: any) => m.id)).size, r.id).toBe(r.existing.length);
        expect(r.label.save ? KINDS.includes(r.label.kind) : r.label.kind === "none", r.id).toBe(true);
        expect(Array.isArray(r.accept) && r.accept.length > 0, r.id).toBe(true);
        for (const a of r.accept) expect([...KINDS, "skip"], r.id).toContain(a);
        expect(r.accept, r.id).toContain(r.label.save ? r.label.kind : "skip");
        if (r.contradicts) expect(r.existing.map((m: any) => m.id), r.id).toContain(r.contradicts);
        expect(Boolean(r.deadEnd), r.id).toBe(DEAD_END_TAGS_V3.includes(r.tag));
        expect(r.label.kind === "dead-end", r.id).toBe(Boolean(r.deadEnd));
        if (r.deadEnd) {
          const d = r.deadEnd;
          const text = (d.source === "user" ? r.user : d.source === "assistant" ? r.assistant : `${r.user} ${r.assistant}`).toLowerCase();
          expect(["user", "assistant", "both"], r.id).toContain(d.source);
          expect(d.triedKeys.some((k: string) => text.includes(k.toLowerCase())), `${r.id} tried`).toBe(true);
          expect(d.whyKeys.some((k: string) => text.includes(k.toLowerCase())), `${r.id} why`).toBe(true);
          if (d.worked) expect(d.workedKeys.some((k: string) => text.includes(k.toLowerCase())), `${r.id} worked`).toBe(true);
        }
        // A plain statement: saved as its kind (never a dead end), and the reply adds nothing.
        if (r.tag === "plain-statement") {
          expect(r.label.save && r.label.kind !== "dead-end", r.id).toBe(true);
          expect(r.accept, r.id).not.toContain("skip");
          expect(r.assistant.length, r.id).toBeLessThanOrEqual(60);
          expect(r.contradicts, r.id).toBeUndefined();
        }
        // A question or proposal with nothing decided: skipped, and it supersedes nothing, though a listed line is on its topic.
        if (r.tag === "question-proposal") {
          expect(r.accept, r.id).toEqual(["skip"]);
          expect(r.contradicts, r.id).toBeUndefined();
        }
        // A dead end that reverses a listed line (not a dead end): saved as a dead end, superseding that line.
        if (r.tag === "dead-end-reversal") {
          expect(r.accept, r.id).toEqual(["dead-end"]);
          expect(r.existing.find((m: any) => m.id === r.contradicts)?.kind, r.id).not.toBe("dead-end");
        }
        // A retest of a listed dead end: the same reason is skipped (no second copy); a new reason is one dead-end line
        // that carries both reasons and supersedes the old line.
        if (r.tag === "retest-same" || r.tag === "retest-new") {
          const old = r.existing.find((m: any) => m.id === r.retest?.of);
          expect(old?.kind, r.id).toBe("dead-end");
          expect(r.retest.same, r.id).toBe(r.tag === "retest-same");
        }
        if (r.tag === "retest-same") {
          expect(r.accept, r.id).toEqual(["skip"]);
          expect(r.contradicts, r.id).toBeUndefined();
        }
        if (r.tag === "retest-new") {
          expect(r.accept, r.id).toEqual(["dead-end"]);
          expect(r.contradicts, r.id).toBe(r.retest.of);
          const old = r.existing.find((m: any) => m.id === r.retest.of).text.toLowerCase();
          expect(r.retest.oldWhyKeys.some((k: string) => old.includes(k.toLowerCase())), `${r.id} old why`).toBe(true);
          expect(r.retest.newWhyKeys.some((k: string) => `${r.user} ${r.assistant}`.toLowerCase().includes(k.toLowerCase())), `${r.id} new why`).toBe(true);
          expect(r.retest.newWhyKeys.some((k: string) => old.includes(k.toLowerCase())), `${r.id} the new reason is new`).toBe(false);
        }
        if (r.tag !== "dead-end-reversal" && r.tag !== "retest-new") expect(r.contradicts, r.id).toBeUndefined();
        if (r.tag !== "retest-same" && r.tag !== "retest-new") expect(r.retest, r.id).toBeUndefined();
      }
    });
  }

  it("held-out v3 holds every case the brief names, and dev v3 each of them too", () => {
    const n = (rows: any[], tag: string, subtype?: string) => rows.filter((r) => r.tag === tag && (!subtype || r.subtype === subtype)).length;
    const h = setsV3.heldoutV3;
    expect(n(h, "plain-statement")).toBeGreaterThanOrEqual(20);
    expect(n(h, "question-proposal")).toBeGreaterThanOrEqual(20);
    expect(n(h, "dead-end-reversal")).toBeGreaterThanOrEqual(10);
    expect(n(h, "retest-same")).toBeGreaterThanOrEqual(5);
    expect(n(h, "retest-new")).toBeGreaterThanOrEqual(5);
    expect(n(h, "dead-end")).toBeGreaterThanOrEqual(10);
    expect(n(h, "dead-end", "but")).toBeGreaterThanOrEqual(4);
    expect(n(h, "ordinary")).toBeGreaterThanOrEqual(25);
    const kinds = new Set(h.filter((r) => r.tag === "ordinary" && r.label.save).map((r) => r.label.kind));
    for (const k of ["decision", "constraint", "preference", "bug", "architecture", "todo"]) expect(kinds.has(k), k).toBe(true);
    const plainKinds = new Set(h.filter((r) => r.tag === "plain-statement").map((r) => r.label.kind));
    for (const k of ["decision", "constraint", "bug", "architecture", "todo"]) expect(plainKinds.has(k), k).toBe(true);
    // Questions and proposals with a listed line on their topic, and retests told by the user and found by Claude.
    expect(h.filter((r) => r.tag === "question-proposal" && r.existing.length > 5).length).toBeGreaterThanOrEqual(8);
    for (const rows of [h, setsV3.devV3]) {
      expect(rows.filter((r) => r.retest && r.deadEnd?.source !== "assistant" && r.tag === "retest-new").length).toBeGreaterThanOrEqual(1);
      expect(rows.filter((r) => r.retest && r.deadEnd?.source === "assistant").length).toBeGreaterThanOrEqual(1);
    }
    const d = setsV3.devV3;
    expect(n(d, "plain-statement")).toBeGreaterThanOrEqual(15);
    expect(n(d, "question-proposal")).toBeGreaterThanOrEqual(15);
    expect(n(d, "dead-end-reversal")).toBeGreaterThanOrEqual(6);
    for (const tag of ["retest-same", "retest-new"]) expect(n(d, tag), tag).toBeGreaterThanOrEqual(6);
    expect(n(d, "dead-end", "but")).toBeGreaterThanOrEqual(6);
  });
});
