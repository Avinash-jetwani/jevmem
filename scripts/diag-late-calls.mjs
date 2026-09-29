#!/usr/bin/env node
// The recall calls that ran past the hook's budget in a paired run of scripts/eval-recall.mjs, next to the other build's
// call for the same prompt, sent seconds before or after (v0.6 part 3b): were they slow requests, or slow moments?
//
//   node scripts/diag-late-calls.mjs <late.json> <other.json> [--out results/diag-recall-late-calls-<date>.json]
import fs from "node:fs";
import path from "node:path";

const [lateFile, otherFile] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : `results/diag-recall-late-calls-${new Date().toISOString().slice(0, 10)}.json`;
const A = JSON.parse(fs.readFileSync(lateFile, "utf8"));
const B = JSON.parse(fs.readFileSync(otherFile, "utf8"));
const other = new Map(B.rows.map((r) => [r.id, r]));
const late = A.rows.filter((r) => !r.jevOk);
const pairs = late.map((r) => {
  const o = other.get(r.id);
  return { id: r.id, size: r.size, at: r.at, error: r.error ?? null, other_at: o?.at ?? null, seconds_apart: o ? Math.round(Math.abs(Date.parse(o.at) - Date.parse(r.at)) / 100) / 10 : null, other_ok: o?.jevOk ?? null, other_jev_ms: o?.jevMs ?? null };
});
const okMs = pairs.filter((p) => p.other_ok).map((p) => p.other_jev_ms);
const out = {
  kind: "diag-recall-late-calls",
  late_file: lateFile,
  other_file: otherFile,
  late_build: A.label,
  other_build: B.label,
  calls_past_the_budget: late.length,
  other_build_answered: `${okMs.length}/${late.length}`,
  other_build_min_ms: okMs.length ? Math.min(...okMs) : null,
  other_build_max_ms: okMs.length ? Math.max(...okMs) : null,
  max_seconds_apart: Math.max(...pairs.map((p) => p.seconds_apart ?? 0)),
  max_ms_apart: Math.round(Math.max(...pairs.map((p) => p.seconds_apart ?? 0)) * 1000),
  method: "For every prompt whose recall call failed or ran past the hook's budget in the first file, the same prompt's call in the paired run of the other build (eval-recall.mjs sends each prompt to each build in turn, seconds apart).",
  rows: pairs,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`${late.length} late calls in ${A.label}; ${B.label} answered ${out.other_build_answered} of the same prompts, in ${out.other_build_min_ms}–${out.other_build_max_ms} ms, at most ${out.max_seconds_apart} s apart → ${OUT}`);
for (const p of pairs) console.log(`  ${p.id} ${p.at} ${p.error} | ${B.label} ${p.other_jev_ms} ms at ${p.other_at}`);
