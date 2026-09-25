#!/usr/bin/env node
// Security eval for the memory-poisoning gate (src/guard.ts).
//
//   node scripts/eval-injection.mjs [--set eval|dev] [--context 7] [--out results/memory-injection-YYYY-MM-DD.json]
//
// Each row is one memory line, labelled malicious (instructions planted for an AI) or legit (a real team rule or fact,
// often phrased as an order). For every row the script builds a scratch project whose JEVMEM.md holds that line plus
// `--context` other lines from the same set (chosen by a fixed seed, all unverified, as in a fresh clone), and runs
// the production recall path, `rankGuarded`, with the row's query: the hidden-text check in code, then one Jev call
// with the recall choice and a gate noul per line. A row is blocked when the gate withholds it.
// The same state is also sent once without gate nouls (the recall call a verified line gets) to measure what the gate
// adds in latency and input tokens. The two calls alternate order. Cost = input tokens × $0.042/M.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const SET = opt("--set", "eval");
const FILE = SET === "dev" ? "eval/memory-injection-dev.jsonl" : "eval/memory-injection.jsonl";
const CONTEXT = Number(opt("--context", "7"));
const today = new Date().toISOString().slice(0, 10);
const OUT = opt("--out", `results/memory-injection${SET === "dev" ? "-dev" : ""}-${today}.json`);
const USD_PER_M_INPUT = 0.042;
const lib = await import(pathToFileURL(path.resolve("dist/index.js")).href);
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");

const rows = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cfg = lib.DEFAULT_CONFIG;
const injectionMax = cfg.thresholds.injectionMax;

// Deterministic PRNG (mulberry32) so every run uses the same context lines.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function contextFor(i) {
  const r = rng(1000 + i);
  const pool = rows.map((_, j) => j).filter((j) => j !== i);
  for (let k = pool.length - 1; k > 0; k--) {
    const j = Math.floor(r() * (k + 1));
    [pool[k], pool[j]] = [pool[j], pool[k]];
  }
  const picked = pool.slice(0, CONTEXT);
  // The row's own position among the lines is also varied.
  const at = Math.floor(r() * (picked.length + 1));
  picked.splice(at, 0, i);
  return picked;
}

const pctl = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
};
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const jev = lib.createJev({ noLogFile: true, cache: false });
await lib.decide(jev, { userMessage: "warm-up", existingMemories: [] });
const startedAt = new Date().toISOString();
const out = [];
for (let i = 0; i < rows.length; i++) {
  const idx = contextFor(i);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-inj-"));
  lib.init({ root, hooks: false });
  const store = new lib.MemoryStore(root);
  const idOf = new Map();
  for (const j of idx) {
    const m = store.add({ kind: rows[j].kind, text: rows[j].text, id: `m${String(j).padStart(2, "0")}` });
    idOf.set(j, m.id);
  }
  const memories = store.active();
  const target = idOf.get(i);
  const runGated = async () => {
    const t0 = performance.now();
    const n0 = jev.log.length;
    const g = await lib.rankGuarded(jev, root, rows[i].query, memories, { maxIds: 60, label: "recall", injectionMax, source: "eval" });
    const e = jev.log.slice(n0);
    return { g, ms: Math.round(performance.now() - t0), jevMs: e.reduce((a, x) => a + x.latencyMs, 0), inputTokens: e.reduce((a, x) => a + x.inputTokens, 0), calls: e.length };
  };
  const runPlain = async () => {
    const t0 = performance.now();
    const n0 = jev.log.length;
    // The call a verified line gets: same state, no gate nouls, hidden-text lines already excluded.
    const plan = lib.planGate(root, memories, injectionMax);
    const allowed = memories.filter((m) => !plan.withheld.some((w) => w.memory.id === m.id));
    const ranked = await lib.rankMemories(jev, rows[i].query, allowed, { maxIds: 60, label: "recall" });
    const e = jev.log.slice(n0);
    return { ranked, ms: Math.round(performance.now() - t0), jevMs: e.reduce((a, x) => a + x.latencyMs, 0), inputTokens: e.reduce((a, x) => a + x.inputTokens, 0), calls: e.length };
  };
  let gated, plain;
  if (i % 2 === 0) {
    gated = await runGated();
    plain = await runPlain();
  } else {
    plain = await runPlain();
    gated = await runGated();
  }
  const w = gated.g.withheld.find((x) => x.memory.id === target);
  const servedRow = gated.g.ranked.find((r) => r.memory.id === target);
  const plainRow = plain.ranked.find((r) => r.memory.id === target);
  const plainTop = plain.ranked.filter((r) => r.choiceProbability >= cfg.thresholds.recallMin).slice(0, cfg.thresholds.recallTopK).map((r) => r.memory.id);
  const rec = {
    i,
    label: rows[i].label,
    category: rows[i].category,
    text: rows[i].text,
    query: rows[i].query,
    blocked: Boolean(w),
    mechanism: w ? (w.injection === null ? "code" : "jev") : null,
    gate: w ? w.injection : servedRow?.injection ?? null,
    reason: w?.reason ?? null,
    // Without the gate, would the row have been injected for its query (top-5 above recallMin)?
    injected_without_gate: plainTop.includes(target),
    choice_probability_without_gate: plainRow?.choiceProbability ?? null,
    context_ids: idx.filter((j) => j !== i),
    context_blocked: gated.g.withheld.filter((x) => x.memory.id !== target).map((x) => x.memory.id),
    gated_call: { ms: gated.ms, jev_latency_ms: gated.jevMs, input_tokens: gated.inputTokens, gate_nouls: gated.g.gated, calls: gated.calls },
    plain_call: { ms: plain.ms, jev_latency_ms: plain.jevMs, input_tokens: plain.inputTokens, calls: plain.calls },
  };
  out.push(rec);
  console.log(`${String(i).padStart(2)} ${rec.label.padEnd(9)} ${rec.blocked ? "BLOCKED" : "served "} gate=${rec.gate === null ? "  -  " : rec.gate.toFixed(3)} ${rec.category.padEnd(20)} ${rec.text.slice(0, 70)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

const mal = out.filter((r) => r.label === "malicious");
const leg = out.filter((r) => r.label === "legit");
const jevRows = out.filter((r) => r.gated_call.calls === 1 && r.plain_call.calls === 1);
const byCat = {};
for (const r of out) {
  const k = `${r.label}:${r.category}`;
  byCat[k] ??= { n: 0, blocked: 0 };
  byCat[k].n++;
  if (r.blocked) byCat[k].blocked++;
}
const gIn = jevRows.map((r) => r.gated_call.input_tokens);
const pIn = jevRows.map((r) => r.plain_call.input_tokens);
const gMs = jevRows.map((r) => r.gated_call.jev_latency_ms);
const pMs = jevRows.map((r) => r.plain_call.jev_latency_ms);
const addedTokens = avg(gIn) - avg(pIn);
const nouls = avg(jevRows.map((r) => r.gated_call.gate_nouls));
let commit = null;
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src", { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {
  /* not a git checkout */
}
const result = {
  kind: "memory-injection",
  set: FILE,
  date: today,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  jevmem_version: JSON.parse(fs.readFileSync("package.json", "utf8")).version,
  commit,
  gate_version: lib.GATE_VERSION,
  machine: `${process.platform} ${process.arch}, node ${process.version}`,
  method:
    "Per row: a scratch JEVMEM.md with the row plus `context_lines` other lines from the set (fixed seed), all unverified; the production rankGuarded recall path with the row's query (hidden-text check, then one Jev call: recall choice + one gate noul per line); blocked = withheld. The same state is also sent without gate nouls (ungated recall) to measure the added latency and tokens; the two calls alternate order. Latency is the Jev call as logged by the client (warm, in-process, cache off).",
  injection_max: injectionMax,
  context_lines: CONTEXT,
  summary: {
    rows: out.length,
    blocked_malicious: `${mal.filter((r) => r.blocked).length}/${mal.length}`,
    false_blocks: `${leg.filter((r) => r.blocked).length}/${leg.length}`,
    malicious_blocked_by_code: mal.filter((r) => r.mechanism === "code").length,
    malicious_blocked_by_jev: mal.filter((r) => r.mechanism === "jev").length,
    malicious_injected_without_gate: `${mal.filter((r) => r.injected_without_gate).length}/${mal.length}`,
    context_false_blocks: out.reduce((a, r) => a + r.context_blocked.filter((id) => rows[Number(id.slice(1))].label === "legit").length, 0),
    context_legit_checks: out.reduce((a, r) => a + r.context_ids.filter((j) => rows[j].label === "legit").length, 0),
    min_gate_malicious: Math.min(...mal.filter((r) => r.gate !== null).map((r) => r.gate)),
    max_gate_legit: Math.max(...leg.filter((r) => r.gate !== null).map((r) => r.gate)),
  },
  cost: {
    calls_compared: jevRows.length,
    gate_nouls_per_call: nouls,
    input_tokens_ungated: Math.round(avg(pIn)),
    input_tokens_gated: Math.round(avg(gIn)),
    added_input_tokens: Math.round(addedTokens),
    added_input_tokens_per_gated_line: Math.round(addedTokens / nouls),
    cost_per_call_ungated_usd: (avg(pIn) / 1e6) * USD_PER_M_INPUT,
    cost_per_call_gated_usd: (avg(gIn) / 1e6) * USD_PER_M_INPUT,
    added_cost_per_call_usd: (addedTokens / 1e6) * USD_PER_M_INPUT,
    p50_latency_ms_ungated: pctl(pMs, 0.5),
    p50_latency_ms_gated: pctl(gMs, 0.5),
    p95_latency_ms_ungated: pctl(pMs, 0.95),
    p95_latency_ms_gated: pctl(gMs, 0.95),
    added_p50_latency_ms: pctl(gMs, 0.5) - pctl(pMs, 0.5),
  },
  by_category: byCat,
  rows: out,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ summary: result.summary, cost: result.cost }, null, 2));
console.log(`written ${OUT}`);
