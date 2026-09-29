#!/usr/bin/env node
// Why a run of scripts/eval-recall.mjs missed the lines it missed (v0.6 part 3b): a timeout, a line not sent, a relevance under
// recallRelevanceMin, or a threshold (relevance under the sure level and the choice under its floor). Each prompt that
// missed a wanted line is asked again, in process, with the hook's own questions (every live line, bare-id choice, one
// relevance noul per line, `replaces` context; Jev's cache off, 15 s to answer), --repeat times, and each wanted line's
// relevance and choice are kept. Above jev.maxRecallLines live lines, a line may not have been sent at all ("not sent").
// A diagnosis of a finished run: nothing here feeds back into recall.
//
//   node scripts/diag-recall-misses.mjs <eval-recall results.json> [--types direct,dead-end] [--repeat 3]
//                                        [--out results/diag-recall-misses-<label>-<date>.json]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const RUN_FILE = args.find((a) => a.endsWith(".json") && args[args.indexOf(a) - 1] !== "--out");
if (!RUN_FILE) throw new Error("usage: node scripts/diag-recall-misses.mjs <eval-recall results.json> [--types t,t] [--repeat 3] [--out file]");
const TYPES = opt("--types", null)?.split(",");
const REPEAT = Number(opt("--repeat", "3"));
const run = JSON.parse(fs.readFileSync(RUN_FILE, "utf8"));
const OUT = opt("--out", `results/diag-recall-misses-${path.basename(RUN_FILE, ".json").replace(/^recall-/, "")}-${new Date().toISOString().slice(0, 10)}.json`);
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const lib = await import(pathToFileURL(path.resolve("dist/index.js")).href);
const setRows = fs.readFileSync(run.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const files = new Map(setRows.filter((r) => r.row === "file").map((f) => [f.id, f]));
const jev = lib.createJev({ noLogFile: true, cache: false, timeoutMs: 15000 });

// The rule of the run (from its results file), and the current build's.
const T = run.thresholds;
const runRule = { relevanceMin: T.recallRelevanceMin ?? 0.8, sure: T.relevanceSure ?? 0.97, floor: T.recallChoiceMin ?? T.recallMin };
const D = lib.DEFAULT_CONFIG.thresholds;
const nowRule = { relevanceMin: D.recallRelevanceMin, sure: lib.RELEVANCE_SURE, floor: D.recallChoiceMin };
const picks = (rule, rel, ch) => rel !== null && rel >= rule.relevanceMin && (rel >= rule.sure || ch >= rule.floor);

const MAX_LINES = T.maxRecallLines ?? lib.DEFAULT_CONFIG.jev.maxRecallLines;

function cause(row, asks, sent) {
  if (!row.jevOk) return "timeout";
  if (!sent) return "not sent";
  const rels = asks.map((a) => a.relevance ?? 0);
  if (rels.every((r) => r < runRule.relevanceMin)) return "relevance";
  if (asks.every((a) => !picks(runRule, a.relevance, a.choice))) return "threshold";
  return "picked when asked again";
}

const out = [];
for (const row of run.rows.filter((r) => r.missed?.length && (!TYPES || TYPES.includes(r.type)))) {
  const f = files.get(row.file);
  const byKey = new Map(f.lines.map((l) => [l.key, l]));
  const mems = f.lines.map((l) => ({ id: l.id, kind: l.kind, text: l.text, ts: l.ts, conf: l.conf, ...(l.by ? { supersededBy: byKey.get(l.by).id } : {}) }));
  const live = mems.filter((m) => m.kind !== "superseded" && !m.supersededBy);
  const keyOf = new Map(f.lines.map((l) => [l.id, l.key]));
  // Above jev.maxRecallLines live lines, only the ones sharing the most words with the prompt are sent (as the hook does).
  const sentKeys = new Set(lib.prefilterByOverlap(row.prompt, live, MAX_LINES).map((m) => keyOf.get(m.id)));
  // What the hook's fallback would serve if this prompt's call failed or ran late (every line here is verified).
  const wordMatchKeys = new Set(lib.wordMatch(row.prompt, live, { topK: D.recallTopK ?? 5 }).map((r) => keyOf.get(r.memory.id)));
  const asked = [];
  for (let i = 0; i < REPEAT; i++) {
    let ranked = null;
    for (let attempt = 0; attempt < 3 && !ranked; attempt++) {
      try {
        ranked = await lib.rankMemories(jev, row.prompt, live, { forPrompt: true, replaced: lib.replacedTexts(mems), timeoutMs: 15000 });
      } catch (err) {
        process.stderr.write(`${row.id}: ${err?.message ?? err}\n`);
      }
    }
    asked.push(ranked ? new Map(ranked.map((r) => [keyOf.get(r.memory.id), { relevance: r.relevance ?? null, choice: r.choiceProbability }])) : null);
  }
  const lines = row.want.map((key) => {
    const asks = asked.filter(Boolean).map((m) => m.get(key) ?? { relevance: null, choice: 0 });
    return {
      key,
      kind: byKey.get(key).kind,
      text: byKey.get(key).text,
      missed: row.missed.includes(key),
      sent_to_jev: sentKeys.has(key),
      word_match_finds: wordMatchKeys.has(key),
      asks,
      picked_by_the_runs_rule: asks.filter((a) => picks(runRule, a.relevance, a.choice)).length,
      picked_by_the_current_rule: asks.filter((a) => picks(nowRule, a.relevance, a.choice)).length,
      ...(row.missed.includes(key) ? { cause: cause(row, asks, sentKeys.has(key)) } : {}),
    };
  });
  out.push({ id: row.id, type: row.type, size: row.size, prompt: row.prompt, live_lines: live.length, lines_sent: sentKeys.size, in_the_run: { path: row.path ?? "jev", jev_ok: row.jevOk, jev_ms: row.jevMs, error: row.error ?? null, injected: row.injected }, lines });
  process.stderr.write(`${row.id}: ${lines.filter((l) => l.missed).map((l) => `${l.key} ${l.cause} (${l.asks.map((a) => `rel ${a.relevance?.toFixed(2)} choice ${a.choice.toFixed(2)}`).join("; ")})`).join(", ")}\n`);
}

const missedLines = out.flatMap((r) => r.lines.filter((l) => l.missed));
const causes = {};
for (const l of missedLines) causes[l.cause] = (causes[l.cause] ?? 0) + 1;
const result = {
  kind: "diag-recall-misses",
  run_file: RUN_FILE,
  set: run.file,
  run_commit: run.commit ?? run.label,
  asked_with_commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(),
  date: new Date().toISOString(),
  repeat: REPEAT,
  types: TYPES,
  runs_rule: runRule,
  current_rule: nowRule,
  prompts: out.length,
  missed_lines: missedLines.length,
  causes,
  method: "Every prompt of the run that missed a wanted line, asked again in process with the hook's own questions (lib.rankMemories, forPrompt, every live line, `replaces` context; cache off, 15 s timeout), --repeat times. A cause per missed line: timeout (the run's call failed or ran past the budget), not sent (more than jev.maxRecallLines live lines, and the line was not among those sharing the most words with the prompt), relevance (under recallRelevanceMin in every ask), threshold (relevance at or over recallRelevanceMin but under the sure level, and the choice under its floor, in every ask), or picked when asked again (Jev's answers vary).",
  rows: out,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 1) + "\n");
console.log(`${missedLines.length} missed line(s) in ${out.length} prompt(s): ${JSON.stringify(causes)} → ${OUT}`);
