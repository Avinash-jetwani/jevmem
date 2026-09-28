/**
 * The Stop hook's eval sets (v0.6 part 3b): sessions captured from real Claude Code with scripts/capture-stops.mjs,
 * eval/stops-dev.jsonl for building the change and eval/stops-heldout-v4.jsonl (decide held-out v4), written and
 * committed before the change. Each row is one session: its prompts, one label per prompt (what that whole turn should
 * save), and every Stop with its payload and the transcript as it was when the hook ran.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { NEW_KINDS } from "../src/types.js";

const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const SETS: Record<string, { rows: any[]; cases: string }> = {
  dev: { rows: read("eval/stops-dev.jsonl"), cases: "eval/stops/dev.cases.mjs" },
  "heldout-v4": { rows: read("eval/stops-heldout-v4.jsonl"), cases: "eval/stops/heldout-v4.cases.mjs" },
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function shingles(s: string, n: number): Set<string> {
  const w = norm(s).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}
const runningSubagent = (stop: any) => (stop.payload.background_tasks ?? []).some((t: any) => t.status === "running" && t.type !== "shell");

describe("eval/stops-*.jsonl", () => {
  for (const [name, { rows, cases }] of Object.entries(SETS)) {
    it(`${name}: every session is labelled and has its Stops, and the cases file says the same`, async () => {
      const { CASES, SET } = await import(pathToFileURL(path.resolve(cases)).href);
      expect(SET).toBe(name);
      expect(rows.map((r) => r.id)).toEqual(CASES.map((c: any) => c.id));
      for (const r of rows) {
        const c = CASES.find((x: any) => x.id === r.id);
        expect(r.set, r.id).toBe(name);
        expect(r.prompts, r.id).toEqual(c.prompts);
        expect(r.labels ?? r.label, r.id).toEqual(c.labels);
        expect(r.mode, r.id).toBe(c.mode);
        expect(["background", "foreground", "none"]).toContain(r.mode);
        expect(r.labels.length, r.id).toBe(r.prompts.length);
        for (const l of r.labels) {
          expect(typeof l.save, r.id).toBe("boolean");
          if (l.save) expect(NEW_KINDS, r.id).toContain(l.kind);
        }
        // Every prompt ran to the end of its turn: at least one Stop per prompt, in prompt order.
        for (let run = 0; run < r.prompts.length; run++) expect(r.stops.some((s: any) => s.run === run), `${r.id} prompt ${run}`).toBe(true);
        expect(r.stops.map((s: any) => s.run), r.id).toEqual([...r.stops.map((s: any) => s.run)].sort((a: number, b: number) => a - b));
        for (const s of r.stops) {
          expect(s.payload.hook_event_name, r.id).toBe("Stop");
          expect(Array.isArray(s.transcript) && s.transcript.length > 0, r.id).toBe(true);
          for (const e of s.transcript) expect(["user", "assistant", "system", "queue-operation"], r.id).toContain(e.type);
        }
        const lastOfRun = new Map<number, number>();
        r.stops.forEach((s: any, i: number) => lastOfRun.set(s.run, i));
        const midTurn = r.stops.filter((s: any, i: number) => lastOfRun.get(s.run) !== i);
        if (r.mode === "background") {
          // The main agent stopped while its subagent worked: a Stop before the turn's last one, with the subagent running.
          expect(midTurn.length, r.id).toBeGreaterThan(0);
          expect(midTurn.some(runningSubagent), r.id).toBe(true);
          for (const [run, i] of lastOfRun) expect(runningSubagent(r.stops[i]), `${r.id} prompt ${run}: nothing running at the turn's last Stop`).toBe(false);
        } else {
          expect(midTurn, r.id).toEqual([]);
          for (const s of r.stops) expect(runningSubagent(s), r.id).toBe(false);
        }
      }
    });
  }

  it("the held-out set has background-subagent turns and ordinary turns, on projects dev does not use", () => {
    const held = SETS["heldout-v4"]!.rows;
    const dev = SETS.dev!.rows;
    expect(held.filter((r) => r.mode === "background").length).toBeGreaterThanOrEqual(10);
    expect(held.filter((r) => r.mode === "none").length).toBeGreaterThanOrEqual(10);
    expect(held.filter((r) => r.mode === "foreground").length).toBeGreaterThanOrEqual(3);
    const heldProjects = new Set(held.map((r) => r.project));
    for (const r of dev) expect(heldProjects.has(r.project), r.id).toBe(false);
  });

  it("dev and held-out share no prompt text (no shared 5-word run)", () => {
    const devSh = new Map<string, string>();
    for (const r of SETS.dev!.rows) for (const p of r.prompts) for (const s of shingles(p, 5)) devSh.set(s, p);
    const hits: string[] = [];
    for (const r of SETS["heldout-v4"]!.rows) for (const p of r.prompts) for (const s of shingles(p, 5)) if (devSh.has(s)) hits.push(`"${s}" in ${r.id}`);
    expect(hits).toEqual([]);
  });
});
