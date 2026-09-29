#!/usr/bin/env node
// What recall's fallback would inject on the retrieval dev set (v0.6 part 3b), offline: no Jev call.
//
//   node scripts/diag-word-match.mjs [--set-file eval/recall-dev.jsonl] [--out results/diag-word-match-dev-<date>.json]
//
// When the prompt hook's Jev call fails or runs past jev.recallTimeoutMs, the prompt gets the live lines that share the
// most words with it (src/recall.ts wordMatch: 0.5.9's keyword count, at least `min` shared words, at most `topK` lines,
// newest first on a tie). This scores that selection alone, for several minimums and caps, as if every prompt had
// fallen back: recall, precision, unrelated prompts that got a line, and lines per prompt. Every line counts as served
// (the eval's lines are all verified); superseded lines are never candidates.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const SET_FILE = opt("--set-file", "eval/recall-dev.jsonl");
const OUT = opt("--out", `results/diag-word-match-dev-${new Date().toISOString().slice(0, 10)}.json`);
const lib = await import(pathToFileURL(path.resolve("dist/index.js")).href);
const rows = fs.readFileSync(SET_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const files = new Map(rows.filter((r) => r.row === "file").map((f) => [f.id, f]));
const prompts = rows.filter((r) => r.row === "prompt");

const rules = [];
for (const min of [1, 2, 3])
  for (const topK of [3, 5]) {
    let wanted = 0, hits = 0, injected = 0, good = 0, unrelated = 0, unrelatedHit = 0, withWant = 0, gotOne = 0;
    const byType = {};
    for (const p of prompts) {
      const f = files.get(p.file);
      const keyOf = new Map(f.lines.map((l) => [l.id, l.key]));
      const live = f.lines.filter((l) => l.kind !== "superseded").map((l) => ({ id: l.id, kind: l.kind, text: l.text, ts: l.ts, conf: l.conf }));
      const keys = lib.wordMatch(p.prompt, live, { topK, min }).map((r) => keyOf.get(r.memory.id));
      const w = p.want.filter((k) => keys.includes(k)).length;
      wanted += p.want.length;
      hits += w;
      injected += keys.length;
      good += keys.filter((k) => p.want.includes(k) || p.ok.includes(k)).length;
      if (p.type === "unrelated") {
        unrelated++;
        if (keys.length) unrelatedHit++;
      }
      if (p.want.length) {
        withWant++;
        if (w > 0) gotOne++;
      }
      const t = (byType[p.type] ??= { wanted: 0, hits: 0 });
      t.wanted += p.want.length;
      t.hits += w;
    }
    rules.push({ min, topK, recall: `${hits}/${wanted}`, prompts_with_a_wanted_line_that_got_one: `${gotOne}/${withWant}`, precision: `${good}/${injected}`, unrelated: `${unrelatedHit}/${unrelated}`, lines_per_prompt: Number((injected / prompts.length).toFixed(2)), recall_by_type: Object.fromEntries(Object.entries(byType).filter(([, v]) => v.wanted).map(([k, v]) => [k, `${v.hits}/${v.wanted}`])) });
  }
const out = { kind: "diag-word-match", set: SET_FILE, date: new Date().toISOString().slice(0, 10), prompts: prompts.length, shipped: { min: lib.WORD_MATCH_MIN, topK: lib.DEFAULT_CONFIG.thresholds.recallTopK }, method: "Offline, no Jev call: src/recall.ts wordMatch over each prompt's file's live lines (every line served, as all are verified in this eval), scored as if every prompt had fallen back. recall = wanted lines picked / wanted lines; precision = picked lines that are wanted or fine / picked lines; unrelated = unrelated prompts that got any line.", rules };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
for (const r of rules) console.log(`min ${r.min} top ${r.topK}: recall ${r.recall} (prompts ${r.prompts_with_a_wanted_line_that_got_one}), precision ${r.precision}, unrelated ${r.unrelated}, ${r.lines_per_prompt} lines/prompt  ${JSON.stringify(r.recall_by_type)}`);
console.log(`→ ${OUT}`);
