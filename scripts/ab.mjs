#!/usr/bin/env node
// The outcome A/B (v0.6 part 3): real Claude Code sessions on the tasks in eval/ab/tasks.mjs, in four arms.
//
//   node scripts/ab.mjs [--arms none,jevmem,guard,claudemd] [--tasks all|id,id] [--runs 3] [--concurrency 4]
//                       [--subagent] [--model <id>] [--out results/ab-<date>.json] [--transcripts <dir>] [--keep]
//
// Every session: a fresh copy of the task's project (eval/ab/projects/<project>, plus the task's own files) in a new
// temporary folder, committed as the first commit of a new git repository on `main`; a new, empty CLAUDE_CONFIG_DIR (so
// Claude Code's auto memory starts empty and nothing from ~/.claude is read) and a temporary HOME; the desktop app's bare
// PATH plus Node's folder; `claude -p <prompt> --permission-mode acceptEdits` with the task's Bash commands allowed.
// Arms:
//   none      no jevmem, no CLAUDE.md, no memory at all
//   jevmem    `jevmem init --tool claude` (this checkout's dist/cli.js): the project's lines in JEVMEM.md, written as
//             jevmem writes them (verified), superseded lines tagged; guard.mode "off", so only recall acts
//   guard     as jevmem, with guard.mode "ask" (the default); run on constraint tasks only. In `claude -p` nobody can
//             answer an ask, so an asked call does not run
//   claudemd  no jevmem; the same live lines (superseded ones left out) pasted into CLAUDE.md as a list
// No arm has an AGENTS.md. Claude Code authenticates with CLAUDE_CODE_OAUTH_TOKEN (or ~/.jevmem/e2e-oauth-token), as
// scripts/e2e.sh does; the TypeSafe key goes into the session HOME's ~/.jevmem/env.
//
// Judging: each task's `check` (eval/ab/tasks.mjs) reads the project's final files, what changed since the first
// commit, and the session's tool calls. No LLM judges anything. Each session's record keeps its tool calls, what jevmem
// injected, the guard's decisions, and the check's result; the raw stream-json transcripts go to --transcripts
// (default: a folder in the OS temp dir), outside the repository.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hookSummary, makeContext, readEvents, toolCallsOf } from "./ab-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const flag = (n) => args.includes(n);
const ARMS = opt("--arms", "none,jevmem,guard,claudemd").split(",");
const RUNS = Number(opt("--runs", "3"));
const CONCURRENCY = Number(opt("--concurrency", "4"));
const MODEL = opt("--model", null);
const today = new Date().toISOString().slice(0, 10);
const OUT = opt("--out", `results/ab-${today}.json`);
const TRANSCRIPTS = path.resolve(opt("--transcripts", path.join(os.tmpdir(), `jevmem-ab-transcripts-${today}`)));
const KEEP = flag("--keep");
const SUBAGENT = flag("--subagent");
const MAX_TURNS = Number(opt("--max-turns", "25"));
const TIMEOUT_MS = Number(opt("--timeout-ms", String(10 * 60_000)));

const TASKS_FILE = path.resolve(opt("--tasks-file", path.join(ROOT, "eval/ab/tasks.mjs")));
const { PROJECTS, TASKS, SUBAGENT_TASKS } = await import(pathToFileURL(TASKS_FILE).href);
const lib = await import(pathToFileURL(path.join(ROOT, "dist/index.js")).href);
const CLI = path.join(ROOT, "dist/cli.js");
const NODE = process.execPath;

function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const dir = path.join(os.homedir(), "Library/Application Support/Claude/claude-code");
  try {
    const versions = fs.readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const v of versions.reverse()) {
      const bin = path.join(dir, v, "claude.app/Contents/MacOS/claude");
      if (fs.existsSync(bin)) return bin;
    }
  } catch {
    /* no desktop bundle */
  }
  return "claude";
}
const CLAUDE = claudeBin();
let TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null;
const tokenFile = process.env.E2E_TOKEN_FILE ?? path.join(os.homedir(), ".jevmem/e2e-oauth-token");
if (!TOKEN && !process.env.ANTHROPIC_API_KEY && fs.existsSync(tokenFile)) TOKEN = fs.readFileSync(tokenFile, "utf8").trim();
if (!TOKEN && !process.env.ANTHROPIC_API_KEY) throw new Error("set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or put it in ~/.jevmem/e2e-oauth-token");
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required (the jevmem arms)");
const CLAUDE_VERSION = execFileSync(CLAUDE, ["--version"], { encoding: "utf8", env: { ...process.env, DISABLE_AUTOUPDATER: "1" } }).trim();
let COMMIT = null;
try {
  COMMIT = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() + (execFileSync("git", ["status", "--porcelain", "src", "dist"], { cwd: ROOT, encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {
  /* not a checkout */
}

/** A memory line's id: stable per project and key, in jevmem's id shape (6 lowercase letters and digits). */
const idOf = (project, key) => {
  const h = crypto.createHash("sha1").update(`${project}:${key}`).digest();
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; s.length < 6; i++) s += a[h[i] % 36];
  return /^\d+$/.test(s) ? "x" + s.slice(1) : s;
};

function memoriesOf(projectName) {
  const p = PROJECTS[projectName];
  const start = Date.parse("2026-01-12T09:00:00Z");
  return p.memory.map(([key, kind, text, by], i) => ({
    key,
    id: idOf(projectName, key),
    kind,
    text,
    ts: new Date(start + i * 3.7 * 86_400_000).toISOString(),
    conf: 0.9,
    ...(by ? { supersededBy: idOf(projectName, by) } : {}),
  }));
}

function claudeMd(projectName) {
  const live = memoriesOf(projectName).filter((m) => m.kind !== "superseded");
  return `# ${PROJECTS[projectName].title}: project notes\n\n${live.map((m) => `- [${m.kind}] ${m.text}`).join("\n")}\n`;
}

const git = (cwd, a, extra = {}) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Sam Rivera", GIT_AUTHOR_EMAIL: "sam@example.com", GIT_COMMITTER_NAME: "Sam Rivera", GIT_COMMITTER_EMAIL: "sam@example.com", ...extra }, stdio: ["ignore", "pipe", "pipe"] });

function setupProject(task, arm, home) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `jevmem-ab-${task.id}-${arm}-`)));
  fs.cpSync(path.resolve(ROOT, PROJECTS[task.project].dir), root, { recursive: true });
  for (const [f, text] of Object.entries(task.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  const mems = memoriesOf(task.project);
  if (arm === "jevmem" || arm === "guard") {
    execFileSync(NODE, [CLI, "init", "--tool", "claude"], { cwd: root, env: { PATH: process.env.PATH, HOME: home }, stdio: "ignore" });
    const cfgFile = path.join(root, "jevmem.config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    cfg.guard = { ...cfg.guard, mode: arm === "guard" ? "ask" : "off" };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
    fs.writeFileSync(path.join(root, "JEVMEM.md"), lib.MEMORY_HEADER + mems.map((m) => lib.formatLine(m)).join("\n") + "\n");
    for (const m of mems) if (m.kind !== "superseded") lib.recordProvenance(root, m, "hook");
  } else if (arm === "claudemd") {
    fs.writeFileSync(path.join(root, "CLAUDE.md"), claudeMd(task.project));
  }
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "initial import"]);
  const base = git(root, ["rev-parse", "HEAD"]).trim();
  for (const [f, text] of Object.entries(task.setup?.modify ?? {})) fs.writeFileSync(path.join(root, f), text);
  return { root, base, mems };
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-ab-home-"));
  fs.mkdirSync(path.join(home, ".jevmem"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, ".jevmem", "env"), `TYPESAFE_API_KEY=${process.env.TYPESAFE_API_KEY}\n`, { mode: 0o600 });
  return home;
}

function allowedTools(task) {
  const bash = ["git status", "git diff:*", "git log:*", "ls:*", ...(task.bash ?? [])];
  return ["Read", "Edit", "Write", "Glob", "Grep", "Agent", "Task", ...bash.map((b) => `Bash(${b})`)];
}

function runClaude({ root, home, prompt, task, transcript }) {
  return new Promise((resolve) => {
    const config = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-ab-config-"));
    const env = { HOME: home, USER: process.env.USER ?? "user", PATH: `${path.dirname(NODE)}:/usr/bin:/bin:/usr/sbin:/sbin`, TERM: "dumb", CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: "1" };
    if (TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
    else env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    const a = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-hook-events", "--permission-mode", "acceptEdits", "--max-turns", String(MAX_TURNS), "--allowedTools", ...allowedTools(task)];
    if (MODEL) a.push("--model", MODEL);
    const t0 = Date.now();
    const child = spawn(CLAUDE, a, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = fs.createWriteStream(transcript);
    let err = "";
    child.stdout.pipe(out);
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      out.end(() => {
        fs.rmSync(config, { recursive: true, force: true });
        resolve({ code, signal, ms: Date.now() - t0, stderr: err.slice(-2000) });
      });
    });
  });
}

async function waitForDrain(root) {
  for (let i = 0; i < 200; i++) {
    if (!fs.existsSync(path.join(root, ".jevmem", "queue.jsonl")) || fs.readFileSync(path.join(root, ".jevmem", "queue.jsonl"), "utf8").trim() === "") {
      if (!fs.existsSync(path.join(root, ".jevmem", "drain.lock"))) return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function session(job) {
  const { task, arm, run, prompt, kind } = job;
  const home = makeHome();
  const { root, base, mems } = setupProject(task, arm, home);
  const transcript = path.join(TRANSCRIPTS, `${kind === "subagent" ? job.id : task.id}.${arm}.${run}.jsonl`);
  const r = await runClaude({ root, home, prompt, task, transcript });
  if (arm === "jevmem" || arm === "guard") {
    await waitForDrain(root);
    try {
      execFileSync(NODE, [CLI, "daemon", "stop"], { cwd: root, env: { PATH: process.env.PATH, HOME: home }, stdio: "ignore" });
    } catch {
      /* not running */
    }
  }
  const events = readEvents(transcript);
  const init = events.find((e) => e.type === "system" && e.subtype === "init") ?? {};
  const result = events.find((e) => e.type === "result") ?? {};
  const ctx = makeContext(root, base, events);
  let check;
  try {
    check = task.check(ctx);
  } catch (err) {
    check = { error: String(err?.stack ?? err) };
  }
  const hooks = hookSummary(events);
  const keyOf = new Map(mems.map((m) => [m.id, m.key]));
  const calls = toolCallsOf(events);
  let guardLog = [];
  try {
    guardLog = fs.readFileSync(path.join(root, ".jevmem", "guard-log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    /* no guard log */
  }
  // The prompt hook's Jev call, from .jevmem/log.jsonl: a failed or timed-out recall injects nothing (it fails open).
  let recallLog = null;
  try {
    const log = fs.readFileSync(path.join(root, ".jevmem", "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    recallLog = log.filter((e) => e.label === "recall" && !e.event).map((e) => ({ ok: e.ok, ms: e.latencyMs, inputTokens: e.inputTokens, error: e.error }));
  } catch {
    /* no jevmem in this arm */
  }
  const record = {
    id: kind === "subagent" ? job.id : task.id,
    task: task.id,
    kind: kind ?? "task",
    project: task.project,
    category: task.category,
    arm,
    run,
    model: init.model ?? null,
    claudeCode: init.claude_code_version ?? null,
    exit: r.code,
    signal: r.signal,
    ms: r.ms,
    turns: result.num_turns ?? null,
    costUsd: result.total_cost_usd ?? null,
    resultText: String(result.result ?? "").slice(0, 600),
    check,
    lineInjected: hooks.injected.some((x) => keyOf.get(x.id) === task.line),
    staleInjected: task.stale ? hooks.injected.some((x) => keyOf.get(x.id) === task.stale) : null,
    injected: hooks.injected.map((x) => ({ key: keyOf.get(x.id) ?? x.id, p: x.p })),
    contextChars: hooks.contextChars,
    guard: hooks.guard,
    guardLog: guardLog.map((g) => ({ tool: g.tool, route: g.route, decision: g.decision, action: String(g.action ?? "").slice(0, 160), rules: (g.rules ?? []).map((x) => ({ key: keyOf.get(x.id) ?? x.id, p: x.p })) })),
    recall: recallLog,
    hookFailures: hooks.failed,
    toolCalls: calls.map((c) => ({ name: c.name, parent: c.parent, error: c.error, arg: String(c.input.command ?? c.input.file_path ?? c.input.pattern ?? c.input.description ?? "").slice(0, 200), result: c.error ? c.result : undefined })),
    subagentCalls: calls.filter((c) => c.parent).length,
    agentUsed: calls.some((c) => (c.name === "Task" || c.name === "Agent") && !c.parent),
    stderr: r.code === 0 ? undefined : r.stderr,
    transcript: path.basename(transcript),
  };
  if (!KEEP) fs.rmSync(root, { recursive: true, force: true });
  else record.scratch = root;
  fs.rmSync(home, { recursive: true, force: true });
  return record;
}

// ------------------------------------------------------------------ plan
const selected = opt("--tasks", "all") === "all" ? TASKS : TASKS.filter((t) => opt("--tasks").split(",").includes(t.id));
const jobs = [];
if (SUBAGENT) {
  for (let run = 1; run <= RUNS; run++) for (const s of SUBAGENT_TASKS) jobs.push({ id: s.id, kind: "subagent", task: TASKS.find((t) => t.id === s.base), arm: "guard", run, prompt: s.prompt });
} else {
  // Runs outermost and arms interleaved, so no arm gets a time slot to itself.
  for (let run = 1; run <= RUNS; run++)
    for (const task of selected)
      for (const arm of ARMS) {
        if (arm === "guard" && task.category !== "constraint") continue;
        jobs.push({ task, arm, run, prompt: task.prompt });
      }
}
fs.mkdirSync(TRANSCRIPTS, { recursive: true });
console.error(`${jobs.length} sessions, ${CONCURRENCY} at a time; ${CLAUDE_VERSION}; jevmem ${COMMIT}; transcripts in ${TRANSCRIPTS}`);

const records = [];
let next = 0;
const partial = OUT.replace(/\.json$/, ".partial.jsonl");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const rec = await session(job);
    records.push(rec);
    fs.appendFileSync(partial, JSON.stringify(rec) + "\n");
    const c = rec.check ?? {};
    console.error(`[${records.length}/${jobs.length}] ${rec.id} ${rec.arm} run ${rec.run}: followed=${c.followed} done=${c.done}${c.stale !== undefined ? ` stale=${c.stale}` : ""}${c.repeated !== undefined ? ` repeated=${c.repeated}` : ""}${c.attempted !== undefined ? ` attempted=${c.attempted} landed=${c.landed}` : ""}${rec.arm === "jevmem" || rec.arm === "guard" ? ` injected=${rec.lineInjected}` : ""}${rec.guard.length ? ` guard=${rec.guard.map((g) => g.decision).join(",")}` : ""} (${Math.round(rec.ms / 1000)} s, ${rec.turns} turns${c.error ? `, CHECK ERROR ${c.error.split("\n")[0]}` : ""}) ${c.note ?? ""}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
records.sort((a, b) => a.id.localeCompare(b.id) || a.arm.localeCompare(b.arm) || a.run - b.run);
const out = {
  kind: SUBAGENT ? "ab-subagent" : "ab",
  date: today,
  claude_code: CLAUDE_VERSION,
  jevmem_commit: COMMIT,
  model: [...new Set(records.map((r) => r.model))].join(", "),
  sessions: records.length,
  method: "See scripts/ab.mjs and eval/ab/tasks.mjs.",
  records,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.error(`wrote ${OUT}`);
