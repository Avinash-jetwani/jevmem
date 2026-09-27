#!/usr/bin/env node
// Every turn whose result differs between two runs of scripts/eval.mjs on the same set (for example the build before a
// change and the build after it), per mode: what was wanted, what each run gave, and each run's reason.
//
//   node scripts/compare-eval.mjs <before.json> <after.json> [--out results/…json]
//
// A turn's result is save/skip, the kind when saved, and the memory it superseded. The summary gives, per mode, each
// run's save/skip, save+kind and contradictions found, and the counts of turns that moved either way.
import fs from "node:fs";
import path from "node:path";

const [aFile, bFile] = process.argv.slice(2).filter((x) => !x.startsWith("--"));
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : null;
if (!aFile || !bFile) throw new Error("usage: compare-eval.mjs <before.json> <after.json> [--out file]");
const [A, B] = [aFile, bFile].map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
if (A.eval_set !== B.eval_set) throw new Error(`different sets: ${A.eval_set} and ${B.eval_set}`);
const result = (g) => (g.save ? `${g.kind}${g.contradicts ? ` ⊃${g.contradicts}` : ""}` : "skip");
const right = (r) => r.got.save === r.want.save && (!r.want.save || r.got.kind === r.want.kind);
const modes = [];
for (const ra of A.results) {
  const rb = B.results.find((x) => x.mode === ra.mode);
  if (!rb) continue;
  const changed = [];
  ra.rows.forEach((x, i) => {
    const y = rb.rows[i];
    if (x.tag !== y.tag || x.user !== y.user) throw new Error(`row ${i} differs between the files`);
    if (result(x.got) === result(y.got)) return;
    changed.push({
      i, tag: x.tag, user: x.user,
      want: x.want.save ? `${x.want.kind}${x.want.contradicts ? ` ⊃${x.want.contradicts}` : ""}` : "skip",
      before: { result: result(x.got), right: right(x), reason: x.reason, assistantIncluded: x.assistantIncluded ?? null, source: x.source ?? null },
      after: { result: result(y.got), right: right(y), reason: y.reason, assistantIncluded: y.assistantIncluded ?? null, source: y.source ?? null, deadEndNoul: y.deadEndNoul ?? null },
    });
  });
  const pick = (r) => ({ saveSkipCorrect: r.saveSkipCorrect, saveKindCorrect: r.saveKindCorrect, n: r.n, contradictionsDetected: r.contradictionsDetected, falseContradictions: r.falseContradictions, p50ms: r.p50ms, p95ms: r.p95ms, avgInputTokens: r.avgInputTokens, costPerTurn: r.costPerTurn, escalationRate: r.escalationRate });
  modes.push({ mode: ra.mode, before: pick(ra), after: pick(rb), changed: changed.length, gotRight: changed.filter((c) => !c.before.right && c.after.right).length, gotWrong: changed.filter((c) => c.before.right && !c.after.right).length, turns: changed });
}
const report = { kind: "eval-compare", set: A.eval_set, before: { file: path.relative(process.cwd(), aFile), commit: A.commit, dist: A.dist, started_at: A.results[0]?.started_at }, after: { file: path.relative(process.cwd(), bFile), commit: B.commit, dist: B.dist, started_at: B.results[0]?.started_at }, modes };
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
for (const m of modes) {
  console.log(`${m.mode}: save/skip ${m.before.saveSkipCorrect}/${m.before.n} → ${m.after.saveSkipCorrect}/${m.after.n}, save+kind ${m.before.saveKindCorrect}/${m.before.n} → ${m.after.saveKindCorrect}/${m.after.n}, contradictions ${m.before.contradictionsDetected} → ${m.after.contradictionsDetected}; ${m.changed} turn(s) changed (${m.gotRight} now right, ${m.gotWrong} now wrong)`);
  for (const c of m.turns) console.log(`  #${c.i} ${c.tag.padEnd(12)} want ${c.want.padEnd(14)} ${c.before.result} → ${c.after.result}  ${c.user}\n      before: ${c.before.reason}\n      after:  ${c.after.reason}${c.after.deadEndNoul !== null ? ` (dead-end noul ${c.after.deadEndNoul.toFixed(2)})` : ""}${c.before.assistantIncluded !== c.after.assistantIncluded ? `; reply in the state: ${c.before.assistantIncluded} → ${c.after.assistantIncluded}` : ""}`);
}
if (OUT) console.log(`\nwritten ${OUT}`);
