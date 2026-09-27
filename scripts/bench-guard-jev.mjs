#!/usr/bin/env node
// The guard's requests to Jev, each from a new hook process as Claude Code starts it: how many fail or time out, and how
// long they take.
//
//   node scripts/bench-guard-jev.mjs [--n 200] [--gap-ms 5000] [--out results/guard-jev-YYYY-MM-DD.json]
//
// Calls: those of eval/guard-dev.jsonl and eval/guard-heldout.jsonl that the prefilter sends to Jev at the shipped
// settings, in scratch projects whose JEVMEM.md holds each eval project's rules as verified [constraint] lines, taken in
// turn until --n calls per series. Each call is one `sh hooks/jevmem-hook.sh --node <node> hook` process (the launcher
// `jevmem init` registers), stdin a real-shaped PreToolUse payload, the key from this environment.
//   cold  --gap-ms of idle before each call, and the project's rule index and answer cache deleted: a new process that
//         parses JEVMEM.md, builds the index and asks Jev, like the first tool call after a pause.
//   warm  back to back, the index already built, only the answer cache deleted: a new process that asks Jev.
// Per call, from the project's .jevmem/log.jsonl and .jevmem/guard-log.jsonl: whether Jev answered within guard.budgetMs
// (1,000 ms), and if not why (the budget ran out, a network error, an HTTP error, no key); the request's latency as
// createJev logged it; the whole process's wall time. Needs TYPESAFE_API_KEY. Cost: input tokens × $0.042 per million.
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
const N = Number(opt("--n", "200"));
const GAP_MS = Number(opt("--gap-ms", "5000"));
const today = new Date().toISOString().slice(0, 10);
const OUT = opt("--out", `results/guard-jev-${today}.json`);
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const lib = await import(pathToFileURL(path.resolve("dist/index.js")).href);
const INIT_LAUNCHER = path.resolve("hooks/jevmem-hook.sh");
const G = lib.DEFAULT_CONFIG.guard;
const mk = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const home = mk("jevmem-bench-gjev-home-");

// Scratch projects and the calls that reach Jev.
const calls = [];
for (const set of ["dev", "heldout"]) {
  const recs = fs.readFileSync(`eval/guard-${set}.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const roots = new Map();
  for (const p of recs.filter((r) => r.type === "rules")) {
    const root = mk(`jevmem-bench-gjev-${p.project}-`);
    lib.init({ root, hooks: false });
    const store = new lib.MemoryStore(root);
    for (const r of p.rules) lib.recordProvenance(root, store.add({ kind: "constraint", text: r.text }), "hook");
    roots.set(p.project, root);
  }
  for (const c of recs.filter((r) => r.type === "call")) {
    const root = roots.get(c.project);
    const tool_input = c.tool === "Bash" ? { command: c.command } : c.tool === "Edit" ? { file_path: path.join(root, c.file), old_string: c.old, new_string: c.new } : { file_path: path.join(root, c.file), content: c.content };
    const input = { session_id: "bench", transcript_path: "/x.jsonl", cwd: root, permission_mode: "default", hook_event_name: "PreToolUse", tool_name: c.tool, tool_input, tool_use_id: "toolu_bench" };
    // In process, with a stand-in that records instead of asking: does the prefilter send this call to Jev?
    let asked = 0;
    const probe = { log: [], call: async (_s, q) => ((asked = Object.keys(q).length), { model: "probe", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }) };
    await lib.evaluateGuard(input, { jev: probe, root, noCache: true, log: false });
    if (asked) calls.push({ id: c.id, root, input: JSON.stringify(input), rules: asked });
  }
}
if (!calls.length) throw new Error("no call reaches Jev");

function hook(root, input) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const env = { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_PROJECT_DIR: root, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, ...(process.env.TYPESAFE_BASE_URL ? { TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL } : {}) };
    const p = spawn("sh", [INIT_LAUNCHER, "--node", process.execPath, "hook"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ wallMs: Math.round(performance.now() - t0), code, stdout, stderr }));
    p.stdin.end(input);
  });
}
const lines = (f) => {
  try {
    return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
/** What one call's log lines say: the Jev request (createJev's entry) and the guard's own failure line, if any. */
function outcome(root, logFrom, guardFrom) {
  const log = lines(path.join(root, ".jevmem", "log.jsonl")).slice(logFrom);
  const glog = lines(path.join(root, ".jevmem", "guard-log.jsonl")).slice(guardFrom);
  const request = log.find((e) => e.label === "guard" && !e.event && e.questions > 0);
  const failure = log.find((e) => e.label === "guard" && e.ok === false && e.questions === 0);
  const route = glog.at(-1)?.route ?? null;
  let result = "answered";
  let reason = null;
  if (failure || route !== "jev") {
    const err = failure?.error ?? `route ${route}`;
    reason = err.slice(0, 200);
    result = /no time left/.test(err) ? "no-time" : /timed out after|TimeoutError|timeout|aborted|AbortError/i.test(err) ? "timeout" : /no TypeSafe API key/.test(err) ? "no-key" : /\b(4\d\d|5\d\d)\b|status/i.test(err) ? "http-error" : /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|Connection/i.test(err) ? "network" : "other";
  }
  return { result, reason, route, requestMs: request?.latencyMs ?? null, requestOk: request ? request.ok : null, failureMs: failure?.latencyMs ?? null, inputTokens: request?.inputTokens ?? null };
}

const pct = (xs, q) => {
  const s = xs.filter((x) => x !== null).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startedAt = new Date().toISOString();
const series = {};
for (const name of ["cold", "warm"]) {
  const rows = [];
  if (name === "warm") for (const c of calls) await hook(c.root, c.input); // build every project's index first (these are not counted)
  for (let i = 0; i < N; i++) {
    const c = calls[i % calls.length];
    const dir = path.join(c.root, ".jevmem");
    fs.rmSync(path.join(dir, "guard-cache.json"), { force: true });
    if (name === "cold") {
      fs.rmSync(path.join(dir, "guard-index.json"), { force: true });
      if (i > 0) await sleep(GAP_MS);
    }
    const logFrom = lines(path.join(dir, "log.jsonl")).length;
    const guardFrom = lines(path.join(dir, "guard-log.jsonl")).length;
    const at = new Date().toISOString();
    const r = await hook(c.root, c.input);
    const o = outcome(c.root, logFrom, guardFrom);
    rows.push({ i, id: c.id, rules: c.rules, at, ...o, wallMs: r.wallMs, exit: r.code, stderr: r.stderr.slice(0, 200), decision: r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision ?? "context" : "none" });
    process.stderr.write(`\r${name} ${i + 1}/${N}  ${o.result}${o.requestMs !== null ? ` ${o.requestMs} ms` : ""}          `);
  }
  process.stderr.write("\n");
  const answered = rows.filter((r) => r.result === "answered");
  const byResult = {};
  for (const r of rows) byResult[r.result] = (byResult[r.result] ?? 0) + 1;
  // Latency of every request that got an answer, and of every call's Jev part (the failure's time for one that did not).
  const reqMs = answered.map((r) => r.requestMs);
  const allJevMs = rows.map((r) => (r.result === "answered" ? r.requestMs : r.failureMs));
  series[name] = {
    calls: rows.length,
    distinct_calls: new Set(rows.map((r) => r.id)).size,
    answered: answered.length,
    by_result: byResult,
    failed_or_timed_out: `${rows.length - answered.length}/${rows.length}`,
    request_latency_answered: { n: reqMs.length, p50_ms: pct(reqMs, 0.5), p95_ms: pct(reqMs, 0.95), p99_ms: pct(reqMs, 0.99), max_ms: pct(reqMs, 1) },
    jev_time_every_call: { n: allJevMs.filter((x) => x !== null).length, p50_ms: pct(allJevMs, 0.5), p95_ms: pct(allJevMs, 0.95), max_ms: pct(allJevMs, 1) },
    process_wall: { p50_ms: pct(rows.map((r) => r.wallMs), 0.5), p95_ms: pct(rows.map((r) => r.wallMs), 0.95), max_ms: pct(rows.map((r) => r.wallMs), 1) },
    over_budget_answered: answered.filter((r) => r.requestMs > G.budgetMs).length,
    exit_codes: [...new Set(rows.map((r) => r.exit))],
    stderr_empty: rows.every((r) => r.stderr === ""),
    avg_input_tokens: Math.round(answered.reduce((a, r) => a + (r.inputTokens ?? 0), 0) / Math.max(1, answered.length)),
    rows,
  };
  const s = series[name];
  console.log(`${name}: ${s.calls} calls (${s.distinct_calls} distinct), ${s.answered} answered, ${s.failed_or_timed_out} failed or timed out ${JSON.stringify(s.by_result)}; request p50 ${s.request_latency_answered.p50_ms} ms, p95 ${s.request_latency_answered.p95_ms} ms, max ${s.request_latency_answered.max_ms} ms; process p50 ${s.process_wall.p50_ms} ms, p95 ${s.process_wall.p95_ms} ms, max ${s.process_wall.max_ms} ms`);
}
let commit = null;
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src hooks", { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {
  /* not a git checkout */
}
const out = {
  kind: "guard-jev",
  date: today,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  jevmem_version: JSON.parse(fs.readFileSync("package.json", "utf8")).version,
  commit,
  machine: `${process.platform} ${process.arch}, ${os.cpus()[0]?.model ?? "cpu"}, node ${process.version}`,
  network_path: `direct HTTPS to ${process.env.TYPESAFE_BASE_URL ?? "the TypeSafe API default base URL"} (POST /v1/systemone), a new TLS connection per process`,
  settings: { budget_ms: G.budgetMs, max_candidates: G.maxCandidates, gap_ms_cold: GAP_MS },
  method: "Each call is one PreToolUse hook process, `sh hooks/jevmem-hook.sh --node <node> hook`, on a call from eval/guard-dev.jsonl or eval/guard-heldout.jsonl that the prefilter sends to Jev, in a scratch project with that eval project's rules. cold: --gap-ms idle before each call and the rule index and answer cache deleted. warm: back to back, index built, answer cache deleted. The outcome and the request's latency come from the project's .jevmem/log.jsonl (createJev's entry, and the guard's failure line with the time its Jev part took) and .jevmem/guard-log.jsonl (the route).",
  calls_reaching_jev: calls.length,
  series,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`written ${OUT}`);
