#!/usr/bin/env node
// The always-on marking question (0.7.1): precision and recall of "mark it" against the hand labels, per threshold.
// The always-on marking question (0.7.1) against the hand labels: each live line of the labelled projects is sent as
// a user message through the build's decide (tier 1 only, no existing memories) and the question's answer is read;
// precision and recall of "mark it" at thresholds 0.5 to 0.9. Dev: the first A/B's three projects (eval/ab/always-dev.mjs);
// held-out: the two new projects' lines with their labels in eval/ab/tasks-alwayson.mjs (run once on the build that ships).
//   node scripts/eval-always-marking.mjs [path/to/dist/index.js] --set dev|heldout [--out results/…json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const args = process.argv.slice(2);
const distArg = args[0] && !args[0].startsWith("--") ? args[0] : path.resolve("dist/index.js");
const SET = args.includes("--set") ? args[args.indexOf("--set") + 1] : "dev";
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lib = await import(pathToFileURL(path.resolve(distArg)).href);
const items = [];
if (SET === "dev") {
  const { PROJECTS } = await import(pathToFileURL(path.join(ROOT, "eval/ab/tasks.mjs")).href);
  const { ALWAYS } = await import(pathToFileURL(path.join(ROOT, "eval/ab/always-dev.mjs")).href);
  for (const [p, v] of Object.entries(PROJECTS)) for (const m of v.memory) if (m[1] !== "superseded") items.push({ project: p, key: m[0], kind: m[1], text: m[2], always: ALWAYS[p].includes(m[0]) });
} else {
  const { PROJECTS } = await import(pathToFileURL(path.join(ROOT, "eval/ab/tasks-alwayson.mjs")).href);
  for (const [p, v] of Object.entries(PROJECTS)) for (const m of v.memory) if (m[1] !== "superseded") items.push({ project: p, key: m[0], kind: m[1], text: m[2], always: Boolean(m[4]?.always) });
}
const jev = lib.createJev({ noLogFile: true, cache: false });
const rows = [];
for (const it of items) {
  const d = await lib.decide(jev, { userMessage: it.text, existingMemories: [] }, { tiers: { mode: "fast" } });
  rows.push({ ...it, noul: d.alwaysNoul, kindChosen: d.kind, save: d.save, marked: d.always });
  process.stderr.write(it.always ? "A" : ".");
}
process.stderr.write("\n");
const sweep = {};
for (const th of [0.5, 0.6, 0.7, 0.8, 0.9]) {
  const KINDS = ["constraint", "preference", "decision", "architecture"];
  const pred = rows.map((r) => r.noul >= th && KINDS.includes(r.kind));
  const tp = rows.filter((r, i) => pred[i] && r.always).length, fp = rows.filter((r, i) => pred[i] && !r.always).length, fn = rows.filter((r, i) => !pred[i] && r.always).length;
  sweep[th] = { marked: `${tp + fp}/${rows.length}`, precision: `${tp}/${tp + fp}`, recall: `${tp}/${tp + fn}`, false_marks: rows.filter((r, i) => pred[i] && !r.always).map((r) => r.key), missed: rows.filter((r, i) => !pred[i] && r.always).map((r) => r.key) };
}
const out = { kind: "alwayson-marking", set: SET, date: new Date().toISOString().slice(0, 10), dist: distArg, lines: rows.length, labelled_always: rows.filter((r) => r.always).length, note: "each line's text sent as a user message through decide (tier 1, no existing memories); a line is marked when the question is at the threshold and its kind is one of constraint, preference, decision, architecture", sweep, rows };
console.log(`${SET}: ${rows.length} lines, ${out.labelled_always} labelled always-on`);
for (const [th, s] of Object.entries(sweep)) console.log(`  at ${th}: marked ${s.marked}, precision ${s.precision}, recall ${s.recall}; false marks: ${s.false_marks.join(",") || "none"}; missed: ${s.missed.join(",") || "none"}`);
console.log("  answers, labelled always:", rows.filter((r) => r.always).map((r) => r.noul.toFixed(2)).sort().join(" "));
console.log("  answers, labelled not:", rows.filter((r) => !r.always).map((r) => r.noul.toFixed(2)).sort().join(" "));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
