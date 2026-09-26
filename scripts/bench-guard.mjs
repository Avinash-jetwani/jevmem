#!/usr/bin/env node
// Added latency of the PreToolUse guard: wall time of the whole hook process as Claude Code runs it (spawn included),
// through the plugin's launcher and through the one `jevmem init` registers.
//
//   node scripts/bench-guard.mjs [--n 30] [--out results/guard-latency-YYYY-MM-DD.json]
//
// Cases:
//   not_enabled             a project without jevmem.config.json: the launcher's shell file check, no Node
//   enabled_no_constraints  enabled, JEVMEM.md without [constraint] lines
//   constraints_no_candidate  the 6 rules of eval/guard-dev.jsonl's first project; `ls -la` shares nothing with them
//   candidate_sent_to_jev   the same rules; `git add .env` is a candidate; the answer cache is cleared before each run,
//                           so each run asks Jev from a new process (TLS included)
//   candidate_cached_answer the same call with its answer cached (every repeat of a call)
// The plugin launcher runs with its data folder warm (the CLI path and its guard check cached), the CLI on PATH.
// Needs TYPESAFE_API_KEY for the Jev case.
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const N = Number(opt("--n", "30"));
const today = new Date().toISOString().slice(0, 10);
const OUT = opt("--out", `results/guard-latency-${today}.json`);
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const lib = await import(pathToFileURL(path.resolve("dist/index.js")).href);
const CLI = path.resolve("dist/cli.js");
const INIT_LAUNCHER = path.resolve("hooks/jevmem-hook.sh");
const PLUGIN_LAUNCHER = path.resolve("plugin/hooks/jevmem-hook.sh");

const mk = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const rules = fs.readFileSync("eval/guard-dev.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.type === "rules");
function project(withRules) {
  const root = mk("jevmem-bench-guard-");
  lib.init({ root, hooks: false });
  if (withRules) {
    const store = new lib.MemoryStore(root);
    for (const r of rules.rules) lib.recordProvenance(root, store.add({ kind: "constraint", text: r.text }), "hook");
  }
  return root;
}
const notEnabled = mk("jevmem-bench-guard-off-");
const empty = project(false);
const withRules = project(true);
// The plugin's view of the machine: `jevmem` (→ dist/cli.js) and `node` on PATH, a data folder, a home.
const bin = mk("jevmem-bench-guard-bin-");
fs.symlinkSync(CLI, path.join(bin, "jevmem"));
fs.symlinkSync(process.execPath, path.join(bin, "node"));
const data = mk("jevmem-bench-guard-data-");
const home = mk("jevmem-bench-guard-home-");

const payload = (root, command) => JSON.stringify({ session_id: "bench", transcript_path: "/x.jsonl", cwd: root, permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "bench" }, tool_use_id: "toolu_bench" });
const launchers = {
  plugin: (root) => ({ cmd: "sh", argv: [PLUGIN_LAUNCHER, "--guard", "hook", "--plugin"], env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: path.resolve("plugin"), CLAUDE_PLUGIN_DATA: data, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, ...(process.env.TYPESAFE_BASE_URL ? { TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL } : {}) } }),
  init: (root) => ({ cmd: "sh", argv: [INIT_LAUNCHER, "--node", process.execPath, "hook"], env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_PROJECT_DIR: root, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, ...(process.env.TYPESAFE_BASE_URL ? { TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL } : {}) } }),
};
function run(l, root, input) {
  return new Promise((resolve) => {
    const { cmd, argv, env } = l(root);
    const t0 = performance.now();
    const p = spawn(cmd, argv, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ ms: performance.now() - t0, code, stdout, stderr }));
    p.stdin.end(input);
  });
}
const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]) : null;
};
const cases = [
  { name: "not_enabled", root: notEnabled, command: "git add .env" },
  { name: "enabled_no_constraints", root: empty, command: "git add .env" },
  { name: "constraints_no_candidate", root: withRules, command: "ls -la" },
  { name: "candidate_sent_to_jev", root: withRules, command: "git add .env", clearCache: true },
  { name: "candidate_cached_answer", root: withRules, command: "git add .env" },
];
const startedAt = new Date().toISOString();
// Warm-up: fills the plugin launcher's cache (CLI path, version, guard check) and each project's rule index.
for (const c of cases) for (const l of Object.values(launchers)) await run(l, c.root, payload(c.root, c.command));
const results = {};
for (const [lname, l] of Object.entries(launchers)) {
  results[lname] = {};
  for (const c of cases) {
    const rows = [];
    for (let i = 0; i < N; i++) {
      if (c.clearCache) fs.rmSync(path.join(c.root, ".jevmem", "guard-cache.json"), { force: true });
      rows.push(await run(l, c.root, payload(c.root, c.command)));
    }
    const outputs = [...new Set(rows.map((r) => (r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision ?? "context" : "none")))];
    results[lname][c.name] = { n: rows.length, p50_ms: pct(rows.map((r) => r.ms), 0.5), p95_ms: pct(rows.map((r) => r.ms), 0.95), exit_codes: [...new Set(rows.map((r) => r.code))], stderr_empty: rows.every((r) => r.stderr === ""), decisions: outputs };
    process.stderr.write(`${lname} ${c.name}: p50 ${results[lname][c.name].p50_ms} ms, p95 ${results[lname][c.name].p95_ms} ms, decisions ${outputs.join(",")}\n`);
  }
}
// The Jev requests the candidate case made, from the project's log (no request is made for the other cases).
const log = lib.readLog(withRules).filter((e) => e.label === "guard" && !e.event && e.ok && !e.cacheHit);
const jevLat = log.map((e) => e.latencyMs);
let commit = null;
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src hooks plugin", { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {
  /* not a git checkout */
}
const out = {
  kind: "guard-latency",
  date: today,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  jevmem_version: JSON.parse(fs.readFileSync("package.json", "utf8")).version,
  commit,
  machine: `${process.platform} ${process.arch}, ${os.cpus()[0]?.model ?? "cpu"}, node ${process.version}`,
  network_path: `direct HTTPS to ${process.env.TYPESAFE_BASE_URL ?? "the TypeSafe API default base URL"} (POST /v1/systemone)`,
  method: "Wall time of one PreToolUse hook process as Claude Code starts it, from spawn to exit, stdin a real-shaped payload. plugin: sh plugin/hooks/jevmem-hook.sh --guard hook --plugin with the CLI on PATH and a warm data folder; init: sh hooks/jevmem-hook.sh --node <node> hook. Rules: the 6 [constraint] lines of eval/guard-dev.jsonl's first project, verified. candidate_sent_to_jev clears .jevmem/guard-cache.json before each run, so each run is a new process asking Jev (TLS included).",
  results,
  jev_requests_in_candidate_case: { n: jevLat.length, latency_p50_ms: pct(jevLat, 0.5), latency_p95_ms: pct(jevLat, 0.95) },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
console.log(`written ${OUT}`);
