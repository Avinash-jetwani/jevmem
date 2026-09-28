#!/usr/bin/env node
// Added latency of the PreToolUse guard: wall time of the whole hook process as Claude Code runs it (spawn included),
// through the plugin's launcher and through the one `jevmem init` registers.
//
//   node scripts/bench-guard.mjs [--n 30] [--cases a,b,…] [--out results/guard-latency-YYYY-MM-DD.json]
//
// Cases:
//   not_enabled             a project without jevmem.config.json: the launcher's shell file check, no Node
//   enabled_no_constraints  enabled, JEVMEM.md without [constraint] lines
//   constraints_no_candidate  the 6 rules of eval/guard-dev.jsonl's first project; `ls -la` shares nothing with them
//   candidate_sent_to_jev   the same rules; `git add .env` is a candidate; the answer cache is cleared before each run,
//                           so each run asks Jev from a new process (TLS included)
//   candidate_cached_answer the same call with its answer cached (every repeat of a call)
//   git_add_all_nothing_named  a git repository with the same rules and a work-in-progress tree (two changed source
//                           files, a new one, a .env that .gitignore keeps out): `git add -A && git commit -m wip`
//   git_add_all_untracked_env  the same with the .env untracked and not ignored; the answer cache is cleared before
//                           each run (a new process asking Jev when the call is a candidate)
//   git_add_all_large_repo  a repository of 20,000 tracked files (200 folders of 100) with the same work-in-progress
//                           tree: `git add -A && git commit -m wip`
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
const ONLY = opt("--cases", null)?.split(",");
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
// Git projects: the rules, a committed tree, then a work in progress on top. No global or system git config.
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@example.com", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@example.com" };
const git = (root, cmd) => execSync(`git ${cmd}`, { cwd: root, env: gitEnv, stdio: "ignore" });
function gitProject({ envIgnored, folders = 0 }) {
  const root = project(true);
  const w = (f, text) => {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  };
  w(".gitignore", `.jevmem/\nnode_modules/\n${envIgnored ? ".env\n" : ""}`);
  for (const f of ["src/checkout/total.ts", "src/components/Badge.tsx", "README.md", "package.json"]) w(f, `// ${f}\n`);
  for (let d = 0; d < folders; d++) for (let i = 0; i < 100; i++) w(`pkg/m${d}/f${i}.ts`, `export const v${i} = ${d};\n`);
  git(root, "init -q");
  git(root, "add -A");
  git(root, "commit -q -m base");
  w("src/checkout/total.ts", "// rounded to cents\n");
  w("src/components/Badge.tsx", "// badge colours\n");
  w("src/checkout/discount.ts", "// new\n");
  w(".env", "STRIPE_KEY=sk_test_abcdef1234567890\n");
  return root;
}
const gitWip = gitProject({ envIgnored: true });
const gitUntrackedEnv = gitProject({ envIgnored: false });
const gitLarge = gitProject({ envIgnored: true, folders: 200 });
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
  { name: "git_add_all_nothing_named", root: gitWip, command: "git add -A && git commit -m wip" },
  { name: "git_add_all_untracked_env", root: gitUntrackedEnv, command: "git add -A && git commit -m wip", clearCache: true },
  { name: "git_add_all_large_repo", root: gitLarge, command: "git add -A && git commit -m wip" },
].filter((c) => !ONLY || ONLY.includes(c.name));
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
const jevLat = [withRules, gitUntrackedEnv].flatMap((r) => lib.readLog(r).filter((e) => e.label === "guard" && !e.event && e.ok && !e.cacheHit)).map((e) => e.latencyMs);
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
  method: "Wall time of one PreToolUse hook process as Claude Code starts it, from spawn to exit, stdin a real-shaped payload. plugin: sh plugin/hooks/jevmem-hook.sh --guard hook --plugin with the CLI on PATH and a warm data folder; init: sh hooks/jevmem-hook.sh --node <node> hook. Rules: the 6 [constraint] lines of eval/guard-dev.jsonl's first project, verified. candidate_sent_to_jev and git_add_all_untracked_env clear .jevmem/guard-cache.json before each run, so each run is a new process asking Jev (TLS included) when the call is a candidate. The git_* cases run in git repositories (see the script's header); both launchers run with PATH /usr/bin:/bin plus the CLI's folder, so git is /usr/bin/git.",
  cases: cases.map((c) => c.name),
  results,
  jev_requests_in_candidate_case: { n: jevLat.length, latency_p50_ms: pct(jevLat, 0.5), latency_p95_ms: pct(jevLat, 0.95) },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
console.log(`written ${OUT}`);
