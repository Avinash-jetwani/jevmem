/**
 * The attempts sets (0.6.6): eval/attempts-dev.jsonl for tuning (replies captured from real Claude Code sessions in
 * three scratch projects), eval/attempts-heldout-captured.jsonl (the captured sessions of two other scratch projects,
 * whose replies nobody who tuned the change read) and eval/attempts-heldout.jsonl, written in four more projects before
 * any code changed. Well formed, labelled by keys that are in the turn's own text, each captured row the turn its
 * session's transcript gives, no project shared between dev and held-out, no sentence or run of nine words shared
 * between the written held-out set and the dev set, and no run of five words between the written held-out set and the
 * code that decides when Claude's reply is read (src/decide.ts, src/questions.ts): a phrase of a held-out set must not
 * end up in a word list or an example.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTranscriptTurns } from "../src/transcript.js";

const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const dev = read("eval/attempts-dev.jsonl");
const heldout = read("eval/attempts-heldout.jsonl");
const captured = read("eval/attempts-heldout-captured.jsonl");
/** attempt-open is in the dev set only: a real session that declined to try, or hit a blocker and asked what to do. */
const TAGS = ["attempt-failed", "attempt-open", "attempt-worked", "decision-request", "ordinary"];
const KINDS = ["decision", "constraint", "preference", "bug", "architecture", "todo", "dead-end"];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function shingles(s: string, n: number): Set<string> {
  const w = norm(s).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}
const has = (text: string, key: string) => text.toLowerCase().includes(key.toLowerCase());

function wellFormed(rows: any[], idPrefix: string) {
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  for (const r of rows) {
    expect(r.id.startsWith(`${idPrefix}-${r.project}-`), r.id).toBe(true);
    expect(TAGS, r.id).toContain(r.tag);
    expect(typeof r.user === "string" && r.user.length > 0, r.id).toBe(true);
    expect(typeof r.assistant === "string" && r.assistant.length > 0, r.id).toBe(true);
    expect(Array.isArray(r.existing) && r.existing.length >= 2, r.id).toBe(true);
    if (r.label.save) {
      expect(KINDS, r.id).toContain(r.label.kind);
      expect(r.accept, r.id).toContain(r.label.kind);
      for (const k of r.accept) expect([...KINDS, "skip"], r.id).toContain(k);
    } else expect(r.accept, r.id).toEqual([]);
    if (r.tag === "attempt-failed") {
      // A failed attempt is a dead end told by the reply: what was tried and why it failed are in Claude's words, and
      // the request's own words are not.
      expect(r.label, r.id).toEqual({ save: true, kind: "dead-end" });
      expect(r.fact.length, r.id).toBeGreaterThanOrEqual(1);
      for (const f of r.fact) expect(r.assistant.includes(f), `${r.id} fact`).toBe(true);
      expect(r.factKeys.length, r.id).toBeGreaterThanOrEqual(1);
      for (const k of r.factKeys) expect(has(r.assistant, k), `${r.id} factKey ${k}`).toBe(true);
      expect(typeof r.reason === "string" && r.assistant.includes(r.reason), `${r.id} reason`).toBe(true);
      expect(r.reasonKeys.length, r.id).toBeGreaterThanOrEqual(1);
      for (const k of r.reasonKeys) expect(has(r.reason, k), `${r.id} reasonKey ${k}`).toBe(true);
      expect(r.requestKeys.length, r.id).toBeGreaterThanOrEqual(1);
      for (const k of r.requestKeys) {
        expect(has(r.user, k), `${r.id} requestKey ${k}`).toBe(true);
        expect(has(r.assistant, k), `${r.id} requestKey ${k} is in the reply too`).toBe(false);
      }
    } else if (r.tag === "attempt-open") {
      // Nothing was kept and nothing clearly failed: a dead end or nothing may be saved, the request itself may not.
      expect(r.label, r.id).toEqual({ save: true, kind: "dead-end" });
      expect([...r.accept].sort(), r.id).toEqual(["dead-end", "skip"]);
      expect(r.requestKeys.length, r.id).toBeGreaterThanOrEqual(1);
      for (const k of r.requestKeys) {
        expect(has(r.user, k), `${r.id} requestKey ${k}`).toBe(true);
        expect(has(r.assistant, k), `${r.id} requestKey ${k} is in the reply too`).toBe(false);
      }
    } else {
      expect(r.label.kind, r.id).not.toBe("dead-end");
      expect(r.accept, r.id).not.toContain("dead-end");
    }
  }
}

describe("eval/attempts-*.jsonl", () => {
  it("held-out: four projects, each with failed attempts, attempts that worked, decisions given as requests and ordinary turns", () => {
    wellFormed(heldout, "ah");
    expect(heldout.some((r) => r.tag === "attempt-open")).toBe(false);
    const projects = [...new Set(heldout.map((r) => r.project))];
    expect(projects.length).toBe(4);
    for (const p of projects) {
      const n = (t: string) => heldout.filter((r) => r.project === p && r.tag === t).length;
      expect(n("attempt-failed"), p).toBeGreaterThanOrEqual(8);
      expect(n("attempt-worked"), p).toBeGreaterThanOrEqual(2);
      expect(n("decision-request"), p).toBeGreaterThanOrEqual(2);
      expect(n("ordinary"), p).toBeGreaterThanOrEqual(3);
    }
  });

  for (const [name, rows, prefix, sessionsFile] of [["dev", dev, "ad", "eval/attempts-dev-sessions.jsonl"], ["held-out, captured", captured, "ac", "eval/attempts-heldout-sessions.jsonl"]] as const) {
    it(`${name}: every row is a turn of a real Claude Code session and names the model that served it`, () => {
      wellFormed(rows, prefix);
      for (const r of rows) {
        expect(typeof r.model === "string" && /^claude-/.test(r.model), r.id).toBe(true);
        expect(r.claude_code, r.id).toMatch(/^\d+\.\d+\.\d+/);
        expect(typeof r.session === "string" && r.session.length > 0, r.id).toBe(true);
      }
      for (const t of TAGS.filter((x) => x !== "attempt-open")) expect(rows.filter((r) => r.tag === t).length, t).toBeGreaterThanOrEqual(4);
    });

    it(`${name}: each row's text is what the hook reads from its captured session`, () => {
      const sessions = new Map(read(sessionsFile).map((s) => [s.id, s]));
      const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "attempts-eval-"));
      try {
        for (const r of rows) {
          const s = sessions.get(r.session);
          expect(s, r.id).toBeDefined();
          const stop = s.stops.at(-1);
          const file = path.join(tmp, `${r.session}.jsonl`);
          fs.writeFileSync(file, stop.transcript.map((e: any) => JSON.stringify(e)).join("\n") + "\n");
          const turn = readTranscriptTurns(file, { lastAssistantMessage: stop.payload.last_assistant_message })!.at(-1)!;
          expect(turn.user, r.id).toBe(r.user);
          expect(turn.assistant, r.id).toBe(r.assistant);
          expect(stop.payload.last_assistant_message.trim(), r.id).toBe(r.final);
          expect(s.served_by, r.id).toContain(r.model);
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  // The dev set's replies are real model output and its prompts were written by other hands than the held-out set's,
  // so the two share a few request idioms ("back it out and tell me", "what got in the way": 15 runs of five words
  // when the sets were written, the longest of eight). No sentence is shared, and no run of nine words.
  it("the held-out sets share no project with the dev set, and the written one shares no sentence and no run of nine words with it", () => {
    const devProjects = new Set(dev.map((r) => r.project));
    for (const r of [...heldout, ...captured]) expect(devProjects.has(r.project), r.project).toBe(false);
    const sentences = (s: string) => s.split(/(?<=[.!?])\s+/).map(norm).filter((x) => x.split(" ").length >= 4);
    const devSh = new Set<string>();
    const devSentences = new Set<string>();
    for (const r of dev) for (const t of [r.user, r.assistant]) {
      for (const sh of shingles(t, 9)) devSh.add(sh);
      for (const x of sentences(t)) devSentences.add(x);
    }
    const hits: string[] = [];
    for (const r of heldout) for (const t of [r.user, r.assistant]) {
      for (const sh of shingles(t, 9)) if (devSh.has(sh)) hits.push(`${r.id}: "${sh}"`);
      for (const x of sentences(t)) if (devSentences.has(x)) hits.push(`${r.id}: sentence "${x}"`);
    }
    expect(hits).toEqual([]);
  });

  it("the held-out set shares no run of five words with the code that decides when the reply is read", () => {
    const code = ["src/decide.ts", "src/questions.ts"].map((f) => fs.readFileSync(path.resolve(f), "utf8")).join("\n");
    const codeSh = shingles(code, 5);
    const hits: string[] = [];
    for (const r of heldout) for (const t of [r.user, r.assistant]) for (const sh of shingles(t, 5)) if (codeSh.has(sh)) hits.push(`${r.id}: "${sh}"`);
    expect(hits).toEqual([]);
  });
});
