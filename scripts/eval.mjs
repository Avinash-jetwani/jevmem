#!/usr/bin/env node
// Score a jevmem build's `decide` against the hand-labelled 40-turn transcript in eval/transcript.jsonl.
// usage: node scripts/eval.mjs [path/to/dist/index.js] [--json]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const distArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : path.resolve("dist/index.js");
const asJson = process.argv.includes("--json");
const lib = await import(pathToFileURL(path.resolve(distArg)).href);
const turns = fs.readFileSync(path.resolve("eval/transcript.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const jev = lib.createJev({ noLogFile: true, cache: false });
const existing = [{ id: "sqlite1", kind: "decision", text: "Use SQLite as the single-file primary store; no server" }];

const rows = [];
for (const t of turns) {
  const message = lib.mergeTurn ? lib.mergeTurn(t.user, t.assistant) : `USER: ${t.user}\n\nASSISTANT: ${t.assistant}`;
  const t0 = performance.now();
  const d = await lib.decide(jev, { message, existingMemories: existing });
  rows.push({ tag: t.tag, want: t.label, got: { save: d.save, kind: d.save ? d.kind : "none" }, ms: Math.round(performance.now() - t0), tokens: d.usage.inputTokens + d.usage.outputTokens, reason: d.reason });
}
const saveAcc = rows.filter((r) => r.got.save === r.want.save).length / rows.length;
const kindAcc = rows.filter((r) => r.got.save === r.want.save && (!r.want.save || r.got.kind === r.want.kind)).length / rows.length;
let tp = 0, fp = 0, fn = 0;
for (const r of rows) { if (r.got.save && r.want.save) tp++; else if (r.got.save && !r.want.save) fp++; else if (!r.got.save && r.want.save) fn++; }
const precision = tp / Math.max(1, tp + fp), recall = tp / Math.max(1, tp + fn);
const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
const summary = { dist: distArg, n: rows.length, saveAccuracy: saveAcc, saveAndKindAccuracy: kindAcc, precision, recall, f1, p50ms: lat[Math.floor(lat.length / 2)], p95ms: lat[Math.floor(lat.length * 0.95)], avgTokens: Math.round(rows.reduce((a, r) => a + r.tokens, 0) / rows.length), errors: rows.filter((r) => r.got.save !== r.want.save || (r.want.save && r.got.kind !== r.want.kind)).map((r) => ({ tag: r.tag, want: r.want, got: r.got, reason: r.reason })) };
if (asJson) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`${distArg}: n=${summary.n} save/skip accuracy ${(saveAcc * 100).toFixed(1)}%  save+kind accuracy ${(kindAcc * 100).toFixed(1)}%  F1 ${(f1 * 100).toFixed(1)}%  p50 ${summary.p50ms} ms  avg tokens ${summary.avgTokens}`);
  for (const e of summary.errors) console.log(`  ✗ ${e.tag.padEnd(12)} want ${e.want.save ? e.want.kind : "skip"} got ${e.got.save ? e.got.kind : "skip"}  (${e.reason})`);
}
