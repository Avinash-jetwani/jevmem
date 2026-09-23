#!/usr/bin/env node
// Score a jevmem build's `decide` against the hand-labelled 40-turn transcript in eval/transcript.jsonl.
// usage: node scripts/eval.mjs [path/to/dist/index.js] [--modes fast,auto,full] [--json]
// Runs each tier mode with a warm in-process client (same as the daemon path), no cache.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const distArg = args[0] && !args[0].startsWith("--") ? args[0] : path.resolve("dist/index.js");
const asJson = args.includes("--json");
const modesIdx = args.indexOf("--modes");
const lib = await import(pathToFileURL(path.resolve(distArg)).href);
const supportsTiers = Boolean(lib.buildTier1Questions);
const modes = modesIdx >= 0 ? args[modesIdx + 1].split(",") : supportsTiers ? ["fast", "auto", "full"] : ["legacy"];
const turns = fs.readFileSync(path.resolve("eval/transcript.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
// Default context for every turn; a turn may carry its own `existing` list (e.g. the real reversal follows the sideload decision).
const DEFAULT_EXISTING = [{ id: "sqlite1", kind: "decision", text: "Use SQLite as the single-file primary store; no server" }];
const USD_PER_M = 0.042;

async function runMode(mode) {
  const jev = lib.createJev({ noLogFile: true, cache: false });
  // Warm the connection once so the p50 reflects the daemon path, not the first TLS handshake.
  try { await lib.decide(jev, { message: "USER: warm-up", existingMemories: [] }, mode === "legacy" ? {} : { tiers: { mode } }); } catch {}
  const rows = [];
  const lineErrors = [];
  for (const t of turns) {
    if (t.expectLine && mode === modes[0]) {
      const { line } = await lib.composeLine(t.user, t.label.kind, { writer: { provider: "none", maxChars: 200, timeoutMs: 1000 }, env: {} });
      if (line !== t.expectLine) lineErrors.push({ tag: t.tag, got: line, want: t.expectLine });
    }
    const message = lib.mergeTurn ? lib.mergeTurn(t.user, t.assistant) : `USER: ${t.user}\n\nASSISTANT: ${t.assistant}`;
    const t0 = performance.now();
    const existing = t.existing ?? DEFAULT_EXISTING;
    const d = await lib.decide(jev, { message, existingMemories: existing }, mode === "legacy" ? {} : { tiers: { mode } });
    rows.push({ tag: t.tag, want: t.label, got: { save: d.save, kind: d.save ? d.kind : "none" }, ms: Math.round(performance.now() - t0), tokens: d.usage.inputTokens + d.usage.outputTokens, escalated: Boolean(d.escalated), reason: d.reason });
  }
  const saveAcc = rows.filter((r) => r.got.save === r.want.save).length / rows.length;
  const kindAcc = rows.filter((r) => r.got.save === r.want.save && (!r.want.save || r.got.kind === r.want.kind)).length / rows.length;
  let tp = 0, fp = 0, fn = 0;
  for (const r of rows) { if (r.got.save && r.want.save) tp++; else if (r.got.save && !r.want.save) fp++; else if (!r.got.save && r.want.save) fn++; }
  const precision = tp / Math.max(1, tp + fp), recall = tp / Math.max(1, tp + fn);
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
  const avgTokens = rows.reduce((a, r) => a + r.tokens, 0) / rows.length;
  return {
    mode, n: rows.length, saveAccuracy: saveAcc, accuracy: kindAcc, f1, precision, recall,
    p50ms: lat[Math.floor(lat.length / 2)], p95ms: lat[Math.floor(lat.length * 0.95)],
    avgTokens: Math.round(avgTokens), costPerTurn: (avgTokens / 1e6) * USD_PER_M,
    escalationRate: rows.filter((r) => r.escalated).length / rows.length,
    lineErrors,
    errors: rows.filter((r) => r.got.save !== r.want.save || (r.want.save && r.got.kind !== r.want.kind)).map((r) => ({ tag: r.tag, want: r.want, got: r.got, reason: r.reason })),
  };
}

const results = [];
for (const m of modes) results.push(await runMode(m));
if (asJson) { console.log(JSON.stringify({ dist: distArg, results }, null, 2)); process.exit(0); }
const pct = (x) => (x * 100).toFixed(1).padStart(5) + "%";
console.log(`${distArg}  (n=${turns.length}, warm in-process client, no cache)`);
console.log("mode    accuracy   F1      tokens/turn  cost/turn    p50     p95    escalated");
for (const r of results) console.log(`${r.mode.padEnd(7)} ${pct(r.accuracy)}   ${pct(r.f1)}  ${String(r.avgTokens).padStart(8)}     $${r.costPerTurn.toFixed(6)}  ${String(r.p50ms).padStart(4)} ms ${String(r.p95ms).padStart(5)} ms  ${r.mode === "auto" ? pct(r.escalationRate) : "   –  "}`);
for (const r of results) for (const e of r.errors) console.log(`  ✗ [${r.mode}] ${e.tag.padEnd(12)} want ${e.want.save ? e.want.kind : "skip"} got ${e.got.save ? e.got.kind : "skip"}  (${e.reason})`);
const le = results[0].lineErrors ?? [];
console.log(`writer (fallback) expectLine checks: ${turns.filter((t) => t.expectLine).length - le.length}/${turns.filter((t) => t.expectLine).length} ok`);
for (const e of le) console.log(`  ✗ line [${e.tag}] got "${e.got}" want "${e.want}"`);
