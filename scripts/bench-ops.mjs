#!/usr/bin/env node
// Measure the non-decide Jev calls and the process paths the README's cost table cites.
//
//   node scripts/bench-ops.mjs [--n 20] [--out results/ops-YYYY-MM-DD.json]
//
// Fixture: a scratch project with 20 memories (the held-out set's memory lines plus a few more).
//   warm in-process: recall, search and audit through one warm client (the daemon path), cache off
//   cache hit:       decide on a turn already in .jevmem/cache/ (no request)
//   hook via daemon: wall time of `node dist/cli.js hook` (Stop, then UserPromptSubmit) with the warm daemon running,
//                    i.e. what Claude Code waits for: node start-up + socket round trip + Jev
//   cold process:    the same with JEVMEM_DAEMON=0, plus `jevmem search` and `jevmem audit --dry-run`, each a new process
// Cost = input tokens × $0.042/M (output free). Needs TYPESAFE_API_KEY.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const N = Number(opt("--n", "20"));
const today = new Date().toISOString().slice(0, 10);
const OUT = opt("--out", `results/ops-${today}.json`);
const CLI = path.resolve("dist/cli.js");
const lib = await import(pathToFileURL(path.resolve("dist/index.js")).href);
const USD_PER_M_INPUT = 0.042;
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");

const heldout = fs.readFileSync("eval/heldout.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const memLines = new Map();
for (const t of heldout) for (const m of t.existing ?? []) memLines.set(m.text, m.kind);
const extra = [
  ["decision", "Recipe comments are moderated by a queue worker before they appear"],
  ["constraint", "The mobile app must work offline for saved recipes"],
  ["architecture", "The query API is a Hono app deployed as a Cloudflare Worker"],
  ["todo", "Add a CSV export for fleet managers after the pilot"],
  ["preference", "Use conventional commit prefixes"],
  ["bug", "Clock drift on dashboards came from a per-request Go ticker"],
  ["decision", "sift ships prebuilt binaries through GitHub Releases"],
  ["architecture", "Recipe search is served by Meilisearch, synced by a worker"],
  ["constraint", "No PII in analytics events"],
  ["decision", "Feature flags come from a flags table cached in the gateway"],
  ["todo", "Replace the hand-rolled CSV parser in the importer"],
];
const PROMPTS = [
  "Add a new column for cook time to the recipe table",
  "Why do some vehicle pings arrive late?",
  "Set up the release workflow for the next sift version",
  "How should images be uploaded from the admin console?",
  "Write tests for the nutrition worker",
  "Can we keep ping data longer for the analytics team?",
  "Refactor the argument parsing in sift",
  "Add an allergens filter to search",
  "Make the dashboard load faster",
  "Where should the new webhook handler live?",
];

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-ops-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pantry", version: "1.0.0", description: "recipe sharing app" }));
  fs.writeFileSync(path.join(root, "README.md"), "# Pantry\n\nRecipe sharing app. Images in R2, search in Meilisearch.\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
  lib.init({ root, hooks: false });
  const store = new lib.MemoryStore(root);
  for (const [text, kind] of memLines) store.add({ kind, text });
  for (const [kind, text] of extra) store.add({ kind, text });
  return { root, store };
}

const pctl = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
};
const summary = (rows) => ({
  n: rows.length,
  p50_ms: pctl(rows.map((r) => r.ms), 0.5),
  p95_ms: pctl(rows.map((r) => r.ms), 0.95),
  avg_input_tokens: rows.length && rows[0].inputTokens !== undefined ? Math.round(rows.reduce((a, r) => a + r.inputTokens, 0) / rows.length) : null,
  cost_per_call_usd: rows.length && rows[0].inputTokens !== undefined ? (rows.reduce((a, r) => a + r.inputTokens, 0) / rows.length / 1e6) * USD_PER_M_INPUT : null,
});

async function timed(fn) {
  const t0 = performance.now();
  await fn();
  return Math.round(performance.now() - t0);
}

function lastLog(jev) {
  return jev.log[jev.log.length - 1];
}

const { root, store } = project();
const memories = store.active();
const startedAt = new Date().toISOString();
const results = { memories: memories.length };

// --- warm in-process ------------------------------------------------------------------------
const jev = lib.createJev({ noLogFile: true, cache: false });
await lib.decide(jev, { userMessage: "warm-up", existingMemories: [] });
const recall = [];
const search = [];
const audit = [];
for (let i = 0; i < N; i++) {
  const q = PROMPTS[i % PROMPTS.length];
  let ms = await timed(() => lib.recallForPrompt(jev, q, memories, { topK: 5, min: 0.05, maxIds: 60 }));
  recall.push({ ms, inputTokens: lastLog(jev).inputTokens });
  ms = await timed(() => lib.rankMemories(jev, q, memories, { perCandidateNouls: true, noulCap: 50, maxIds: 60, label: "search" }));
  search.push({ ms, inputTokens: lastLog(jev).inputTokens });
}
for (let i = 0; i < Math.min(N, 10); i++) {
  const ms = await timed(() => lib.auditMemories(jev, store, { staleBelow: 0.4 }));
  audit.push({ ms, inputTokens: lastLog(jev).inputTokens });
}
results.warm = { recall: summary(recall), search: summary(search), audit_20_memories: summary(audit) };

// --- cache hit ------------------------------------------------------------------------------
const cjev = lib.createJev({ root, noLogFile: true, cache: true });
const hits = [];
for (let i = 0; i < N; i++) {
  const input = { userMessage: `We will use ${["Postgres", "MySQL", "Redis", "Kafka", "NATS"][i % 5]} for service ${i}.`, existingMemories: memories };
  await lib.decide(cjev, input, { tiers: { mode: "fast" } });
  const ms = await timed(() => lib.decide(cjev, input, { tiers: { mode: "fast" } }));
  if (lastLog(cjev).cacheHit) hits.push({ ms });
}
results.cache_hit_decide = summary(hits);

// --- processes ------------------------------------------------------------------------------
function runCli(argv, { stdin = "", env = {} } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const p = spawn(process.execPath, [CLI, ...argv], { cwd: root, env: { ...process.env, JEVMEM_WRITER: "none", ...env }, stdio: ["pipe", "ignore", "ignore"] });
    p.on("close", (code) => resolve({ ms: Math.round(performance.now() - t0), code }));
    p.stdin.end(stdin);
  });
}
const stop = (i) => JSON.stringify({ hook_event_name: "Stop", cwd: root, user_message: `Decision ${i}: the worker pool size for the importer is ${4 + i} in production.` });
const ups = (i) => JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: PROMPTS[i % PROMPTS.length] });
const nProc = Math.min(N, 10);

async function procSeries(label, make, env) {
  const rows = [];
  for (let i = 0; i < nProc; i++) rows.push(await make(i, env));
  if (rows.some((r) => r.code !== 0)) throw new Error(`${label}: non-zero exit`);
  return summary(rows);
}
const cold = { JEVMEM_DAEMON: "0", JEVMEM_CACHE: "0" };
results.cold_process = {
  hook_stop_decide: await procSeries("stop", (i, env) => runCli(["hook"], { stdin: stop(100 + i), env }), cold),
  hook_prompt_recall: await procSeries("ups", (i, env) => runCli(["hook"], { stdin: ups(i), env }), cold),
  search: await procSeries("search", (i, env) => runCli(["search", PROMPTS[i % PROMPTS.length]], { env }), cold),
  audit_dry_run_20_memories: await procSeries("audit", (_i, env) => runCli(["audit", "--dry-run"], { env }), cold),
};
// Warm daemon: start it, wait for the socket, then time hook processes that go through it.
const daemonEnv = { JEVMEM_DAEMON: "1", JEVMEM_CACHE: "0" };
await runCli(["daemon", "start"], { env: daemonEnv });
for (let i = 0; i < 50 && !(await lib.daemonRequest(root, { type: "ping" })); i++) await new Promise((r) => setTimeout(r, 100));
await runCli(["hook"], { stdin: stop(0), env: daemonEnv }); // first request through the daemon warms its client
results.hook_via_warm_daemon = {
  hook_stop_decide: await procSeries("stop-daemon", (i, env) => runCli(["hook"], { stdin: stop(200 + i), env }), daemonEnv),
  hook_prompt_recall: await procSeries("ups-daemon", (i, env) => runCli(["hook"], { stdin: ups(i + 3), env }), daemonEnv),
};
// Were the hook runs really served by the daemon? It counts the requests it handled.
const pong = await lib.daemonRequest(root, { type: "ping" });
results.hook_via_warm_daemon.daemon_served_requests = pong && pong.type === "pong" ? pong.served : null;
await runCli(["daemon", "stop"], { env: daemonEnv });

let commit = null;
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src", { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {
  /* not a git checkout */
}
const out = {
  kind: "ops",
  date: today,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  jevmem_version: JSON.parse(fs.readFileSync("package.json", "utf8")).version,
  commit,
  machine: `${process.platform} ${process.arch}, node ${process.version}`,
  network_path: `direct HTTPS to ${process.env.TYPESAFE_BASE_URL ?? "the TypeSafe API default base URL"} (POST /v1/systemone)`,
  cost_method: "input tokens × $0.042 per million; output tokens free",
  method: "Scratch project with the memories listed in `memories`. warm: one in-process client after one warm-up call, cache off. cache_hit_decide: second identical decide call (fast mode) served from .jevmem/cache/. cold_process: wall time of a new `node dist/cli.js …` process per call (node start-up + TLS + Jev), daemon off, cache off. hook_via_warm_daemon: wall time of a new hook process that hands the event to an already-warm daemon.",
  results,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
console.log(`written ${OUT}`);
