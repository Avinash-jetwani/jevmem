#!/usr/bin/env node
// Score a jevmem build's `decide` against a hand-labelled eval set.
// usage: node scripts/eval.mjs [path/to/dist/index.js] [--set heldout|regression] [--modes fast,auto,full] [--json] [--out results/eval-….json]
//   --set heldout     eval/heldout.jsonl: 66 turns written after v0.3.8, sharing no text with src/questions.ts (default)
//   --set regression  eval/transcript.jsonl: the original 50 turns; many overlap jevmem's own few-shot examples
// Runs each tier mode with a warm in-process client (same as the daemon path), no cache.
// Cost = input tokens × $0.042/M (Jev output tokens are free), the same method as `jevmem stats` and bench-llm.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const distArg = args[0] && !args[0].startsWith("--") ? args[0] : path.resolve("dist/index.js");
const asJson = args.includes("--json");
const OUT = opt("--out", null);
const SET = opt("--set", "heldout");
const SET_FILE = { heldout: "eval/heldout.jsonl", regression: "eval/transcript.jsonl" }[SET];
if (!SET_FILE) throw new Error(`unknown --set ${SET}`);
const lib = await import(pathToFileURL(path.resolve(distArg)).href);
const modes = opt("--modes", "fast,auto,full").split(",");
const turns = fs.readFileSync(path.resolve(SET_FILE), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
// Default context for a turn with no `existing` list (the regression set; every held-out turn carries its own).
const DEFAULT_EXISTING = [{ id: "sqlite1", kind: "decision", text: "Use SQLite as the single-file primary store; no server" }];
const USD_PER_M_INPUT = 0.042;

async function runMode(mode) {
  const jev = lib.createJev({ noLogFile: true, cache: false });
  // Warm the connection once so the p50 reflects the daemon path, not the first TLS handshake.
  try { await lib.decide(jev, { userMessage: "warm-up", existingMemories: [] }, { tiers: { mode } }); } catch {}
  const rows = [];
  const lineErrors = [];
  const startedAt = new Date().toISOString();
  for (const t of turns) {
    if (t.expectLine && mode === modes[0]) {
      const { line } = await lib.composeLine(t.user, t.label.kind, { writer: { provider: "none", maxChars: 200, timeoutMs: 1000 }, env: {} });
      if (line !== t.expectLine) lineErrors.push({ tag: t.tag, got: line, want: t.expectLine });
    }
    const t0 = performance.now();
    const existing = t.existing ?? DEFAULT_EXISTING;
    const d = await lib.decide(jev, { userMessage: t.user, assistantReply: t.assistant, recentContext: t.previous, existingMemories: existing }, { tiers: { mode } });
    rows.push({
      tag: t.tag,
      user: t.user.slice(0, 80),
      want: { ...t.label, contradicts: t.contradicts ?? null },
      got: { save: d.save, kind: d.save ? d.kind : "none", contradicts: d.contradiction ? d.touchesMemoryId : null },
      ms: Math.round(performance.now() - t0),
      inputTokens: d.usage.inputTokens,
      outputTokens: d.usage.outputTokens,
      escalated: Boolean(d.escalated),
      reason: d.reason,
    });
  }
  const finishedAt = new Date().toISOString();
  const n = rows.length;
  const saveAcc = rows.filter((r) => r.got.save === r.want.save).length / n;
  const kindAcc = rows.filter((r) => r.got.save === r.want.save && (!r.want.save || r.got.kind === r.want.kind)).length / n;
  let tp = 0, fp = 0, fn = 0;
  for (const r of rows) { if (r.got.save && r.want.save) tp++; else if (r.got.save && !r.want.save) fp++; else if (!r.got.save && r.want.save) fn++; }
  const precision = tp / Math.max(1, tp + fp), recall = tp / Math.max(1, tp + fn);
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  const avgIn = rows.reduce((a, r) => a + r.inputTokens, 0) / n;
  const avgOut = rows.reduce((a, r) => a + r.outputTokens, 0) / n;
  const contra = rows.filter((r) => r.want.contradicts);
  const falseContra = rows.filter((r) => r.got.contradicts && r.got.contradicts !== r.want.contradicts).length;
  const inj = rows.filter((r) => /injection/.test(r.tag));
  return {
    mode, n, started_at: startedAt, finished_at: finishedAt,
    saveAccuracy: saveAcc, accuracy: kindAcc, f1, precision, recall,
    saveSkipCorrect: rows.filter((r) => r.got.save === r.want.save).length,
    saveKindCorrect: rows.filter((r) => r.got.save === r.want.save && (!r.want.save || r.got.kind === r.want.kind)).length,
    contradictionsDetected: `${contra.filter((r) => r.got.contradicts === r.want.contradicts).length}/${contra.length}`,
    falseContradictions: falseContra,
    injectionNotSaved: `${inj.filter((r) => !r.got.save).length}/${inj.length}`,
    p50ms: pct(0.5), p95ms: pct(0.95),
    avgInputTokens: Math.round(avgIn), avgOutputTokens: Math.round(avgOut), avgTokens: Math.round(avgIn + avgOut),
    costPerTurn: (avgIn / 1e6) * USD_PER_M_INPUT,
    escalationRate: rows.filter((r) => r.escalated).length / n,
    lineErrors,
    errors: rows.filter((r) => r.got.save !== r.want.save || (r.want.save && r.got.kind !== r.want.kind)).map((r) => ({ tag: r.tag, user: r.user, want: r.want, got: r.got, reason: r.reason })),
    rows,
  };
}

let commit = null;
try { commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src", { encoding: "utf8" }).trim() ? "+dirty" : ""); } catch {}
const results = [];
for (const m of modes) results.push(await runMode(m));
const pj = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
const report = {
  kind: "eval",
  date: new Date().toISOString().slice(0, 10),
  jevmem_version: pj.version,
  commit,
  dist: path.relative(process.cwd(), path.resolve(distArg)),
  eval_set: SET_FILE,
  turns: turns.length,
  machine: `${process.platform} ${process.arch}, node ${process.version}, ${os.cpus()[0]?.model ?? "cpu"}`,
  network_path: `direct HTTPS to ${process.env.TYPESAFE_BASE_URL ?? "the TypeSafe API default base URL"} (POST /v1/systemone), warm in-process client, cache off`,
  cost_method: "input tokens × $0.042 per million; output tokens free (https://typesafe.ai/blog/introducing-system-one-models-and-jev)",
  results,
};
if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
}
if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
const p = (x) => (x * 100).toFixed(1).padStart(5) + "%";
console.log(`${report.dist}  set=${SET_FILE} (n=${turns.length}), warm in-process client, no cache${commit ? `, commit ${commit}` : ""}`);
console.log("mode    save/skip  save+kind  F1      in-tok/turn  cost/turn    p50     p95    escalated  contra  inj-not-saved");
for (const r of results) console.log(`${r.mode.padEnd(7)} ${p(r.saveAccuracy)}     ${p(r.accuracy)}    ${p(r.f1)}  ${String(r.avgInputTokens).padStart(8)}     $${r.costPerTurn.toFixed(6)}  ${String(r.p50ms).padStart(4)} ms ${String(r.p95ms).padStart(5)} ms  ${r.mode === "auto" ? p(r.escalationRate) : "   –  "}     ${r.contradictionsDetected.padEnd(6)}  ${r.injectionNotSaved}`);
for (const r of results) for (const e of r.errors) console.log(`  ✗ [${r.mode}] ${e.tag.padEnd(14)} want ${e.want.save ? e.want.kind : "skip"} got ${e.got.save ? e.got.kind : "skip"}  ${e.user}`);
const le = results[0].lineErrors ?? [];
if (turns.some((t) => t.expectLine)) console.log(`writer (fallback) expectLine checks: ${turns.filter((t) => t.expectLine).length - le.length}/${turns.filter((t) => t.expectLine).length} ok`);
for (const e of le) console.log(`  ✗ line [${e.tag}] got "${e.got}" want "${e.want}"`);
if (OUT) console.log(`\nwritten ${OUT}`);
