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
// The poisoning gate on recall (src/guard.ts). The fixture's lines were added with store.add, so none is verified.
//   gated_uncached: every line unverified, no cached verdict (a fresh clone's first prompt): one gate noul per line
//   gated_cached:   the same lines once their verdicts are cached (every later prompt): no gate nouls
//   verified:       every line written by jevmem on this machine: no gate nouls
const gateFile = path.join(root, ".jevmem", "gate.json");
const gUncached = [];
const gCached = [];
const gVerified = [];
for (let i = 0; i < N; i++) {
  const q = PROMPTS[i % PROMPTS.length];
  fs.rmSync(gateFile, { force: true });
  let ms = await timed(() => lib.recallGuarded(jev, root, q, memories, { topK: 5, min: 0.05, maxIds: 60, injectionMax: 0.5 }));
  gUncached.push({ ms, inputTokens: lastLog(jev).inputTokens });
  ms = await timed(() => lib.recallGuarded(jev, root, q, memories, { topK: 5, min: 0.05, maxIds: 60, injectionMax: 0.5 }));
  gCached.push({ ms, inputTokens: lastLog(jev).inputTokens });
}
const gateWithheld = lib.knownWithheld(root, memories, 0.5).length; // fixture lines the gate flagged (expected 0)
const provFile = lib.provenanceFile(root);
for (const m of memories) lib.recordProvenance(root, m, "hook");
for (let i = 0; i < N; i++) {
  const q = PROMPTS[i % PROMPTS.length];
  const ms = await timed(() => lib.recallGuarded(jev, root, q, memories, { topK: 5, min: 0.05, maxIds: 60, injectionMax: 0.5 }));
  gVerified.push({ ms, inputTokens: lastLog(jev).inputTokens });
}
results.warm = {
  recall: summary(recall),
  recall_gated_all_unverified_uncached: summary(gUncached),
  recall_gated_all_unverified_cached: summary(gCached),
  recall_gated_all_verified: summary(gVerified),
  gate_withheld_fixture_lines: gateWithheld,
  search: summary(search),
  audit_all_memories: summary(audit),
};
// The process measurements below run with every fixture line verified (the author's own machine).
void provFile;

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
  // Since v0.5.0 a Stop hook process with the daemon off evaluates the queue itself (the pre-v0.5.0 path, in effect).
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
const LAUNCHER = path.resolve("hooks/jevmem-hook.sh");
const decisionsCount = () => {
  try {
    return fs.readFileSync(path.join(root, ".jevmem", "decisions.jsonl"), "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};
/** The Stop hook as `jevmem init` registers it (v0.5.0): the launcher with --detach. Also times until the turn is decided. */
function runLauncher(stdin, env) {
  return new Promise((resolve) => {
    const before = decisionsCount();
    const t0 = performance.now();
    const p = spawn("sh", [LAUNCHER, "--node", process.execPath, "--detach", "hook"], { cwd: root, env: { ...process.env, JEVMEM_WRITER: "none", ...env }, stdio: ["pipe", "ignore", "ignore"] });
    p.on("close", async (code) => {
      const ms = Math.round(performance.now() - t0);
      while (decisionsCount() <= before && performance.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 5));
      resolve({ ms, code, decidedMs: Math.round(performance.now() - t0) });
    });
    p.stdin.end(stdin);
  });
}
const launcherRows = [];
for (let i = 0; i < nProc; i++) launcherRows.push(await runLauncher(stop(300 + i), daemonEnv));
// v0.5.3 plugin: plugin/hooks/jevmem-hook.sh finds the installed CLI (here a global-install-like bin dir: `jevmem` linked
// to dist/cli.js, and `node`), checks its version once per CLI file (cached in CLAUDE_PLUGIN_DATA), then detaches.
const PLUGIN_LAUNCHER = path.resolve("plugin/hooks/jevmem-hook.sh");
const pbin = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-ops-bin-"));
fs.symlinkSync(CLI, path.join(pbin, "jevmem"));
fs.symlinkSync(process.execPath, path.join(pbin, "node"));
const pdata = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-ops-data-"));
function runPluginLauncher(stdin, env) {
  return new Promise((resolve) => {
    const before = decisionsCount();
    const t0 = performance.now();
    const p = spawn("sh", [PLUGIN_LAUNCHER, "--detach", "hook", "--plugin"], { cwd: root, env: { ...process.env, PATH: `${pbin}:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: pdata, JEVMEM_WRITER: "none", ...env }, stdio: ["pipe", "ignore", "ignore"] });
    p.on("close", async (code) => {
      const ms = Math.round(performance.now() - t0);
      while (decisionsCount() <= before && performance.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 5));
      resolve({ ms, code, decidedMs: Math.round(performance.now() - t0) });
    });
    p.stdin.end(stdin);
  });
}
await runPluginLauncher(stop(399), daemonEnv); // first run: the version check fills the cache
const pluginRows = [];
for (let i = 0; i < nProc; i++) pluginRows.push(await runPluginLauncher(stop(400 + i), daemonEnv));
if (pluginRows.some((r) => r.code !== 0)) throw new Error("plugin launcher: non-zero exit");
// v0.5.6: the desktop app's case. A bare PATH without jevmem, the CLI in ~/.local/bin of a temporary HOME: the first
// run finds it in the launcher's directory list and caches the path, later runs use the cached path.
const phome = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-ops-home-"));
fs.mkdirSync(path.join(phome, ".local", "bin"), { recursive: true });
fs.symlinkSync(CLI, path.join(phome, ".local", "bin", "jevmem"));
fs.symlinkSync(process.execPath, path.join(phome, ".local", "bin", "node"));
const pdataBare = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-ops-data-"));
const bareEnv = { ...daemonEnv, PATH: "/usr/bin:/bin", HOME: phome, CLAUDE_PLUGIN_DATA: pdataBare };
await runPluginLauncher(stop(499), bareEnv);
if (fs.readFileSync(path.join(pdataBare, "cli"), "utf8").split("\n")[0] !== path.join(phome, ".local", "bin", "jevmem")) throw new Error("bare PATH: the CLI in ~/.local/bin was not found and cached");
const bareRows = [];
for (let i = 0; i < nProc; i++) bareRows.push(await runPluginLauncher(stop(500 + i), bareEnv));
if (bareRows.some((r) => r.code !== 0)) throw new Error("plugin launcher (bare PATH): non-zero exit");
if (launcherRows.some((r) => r.code !== 0)) throw new Error("launcher: non-zero exit");
results.hook_via_warm_daemon = {
  // v0.5.0: `node dist/cli.js hook` for Stop only queues the turn and hands it to the daemon (no Jev wait).
  hook_stop_handoff: await procSeries("stop-daemon", (i, env) => runCli(["hook"], { stdin: stop(200 + i), env }), daemonEnv),
  // v0.5.0: the process Claude Code starts for Stop (registered async, so it does not wait for it either).
  hook_stop_launcher_detach: summary(launcherRows),
  // From the launcher's start until the turn's decision is recorded by the daemon (the line lands then).
  hook_stop_start_to_decided: summary(launcherRows.map((r) => ({ ms: r.decidedMs }))),
  // v0.5.3: the Stop hook as the plugin registers it (plugin/hooks/jevmem-hook.sh --detach, the installed CLI).
  hook_stop_plugin_launcher_detach: summary(pluginRows),
  hook_stop_plugin_start_to_decided: summary(pluginRows.map((r) => ({ ms: r.decidedMs }))),
  // v0.5.6: the same on a bare PATH, the CLI found once in ~/.local/bin and then read from the cache.
  hook_stop_plugin_launcher_bare_path_detach: summary(bareRows),
  hook_stop_plugin_bare_path_start_to_decided: summary(bareRows.map((r) => ({ ms: r.decidedMs }))),
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
  method: "Scratch project with the memories listed in `memories`. warm: one in-process client after one warm-up call, cache off; recall_gated_*: the poisoning gate with every line unverified (no cached verdicts, then cached) and with every line verified. cache_hit_decide: second identical decide call (fast mode) served from .jevmem/cache/. cold_process: wall time of a new `node dist/cli.js …` process per call (node start-up + TLS + Jev), daemon off, cache off. hook_via_warm_daemon: wall time of a new hook process with an already-warm daemon; for Stop (v0.5.0) `hook_stop_handoff` is `node dist/cli.js hook` (queue + hand off), `hook_stop_launcher_detach` is `sh hooks/jevmem-hook.sh --detach hook` as init registers it, and `hook_stop_start_to_decided` runs from the launcher's start until the daemon has recorded the turn's decision. `hook_stop_plugin_*` is `sh plugin/hooks/jevmem-hook.sh --detach hook --plugin` with the CLI on PATH (v0.5.3); `hook_stop_plugin_*bare_path*` is the same with PATH=/usr/bin:/bin and the CLI in ~/.local/bin of a temporary HOME, found there once and then read from the launcher's cache (v0.5.6).",
  results,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
console.log(`written ${OUT}`);
