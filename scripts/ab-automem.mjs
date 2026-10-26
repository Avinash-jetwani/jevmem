#!/usr/bin/env node
// The comparison against Claude Code's auto memory (0.7.7): real Claude Code sessions on the held-out tasks of
// eval/ab/tasks-automem.mjs, in five arms, taught rather than seeded.
//
//   node scripts/ab-automem.mjs [--arms none,auto,jevmem,both,claudemd] [--tasks all|id,id] [--long all|none|id,id]
//                               [--runs 3] [--concurrency 4] [--model claude-fable-5-1] [--expect-claude 2.1.306]
//                               [--out results/ab-automem-<date>.json] [--transcripts <dir>] [--keep] [--resume]
//                               [--max-turns 25] [--teach-turns 12] [--timeout-ms 600000] [--max-jobs N]
//
// --max-jobs N runs at most N of the planned jobs in this invocation and writes the output as usual, so a long run goes
// in blocks: `--resume` with the same --out and --transcripts carries on from the partial file (the plan is the same
// list each time, in the same order). The usage of a subscription plan is read between blocks, not by this script.
//
// Arms (every arm: `--permission-mode acceptEdits`, the same allowed tools, the same pinned model):
//   none      no memory: auto memory off (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1), no jevmem, no CLAUDE.md
//   auto      Claude Code's auto memory as it ships: no setting, no flag, no instruction; it starts empty
//   jevmem    jevmem alone on its defaults (`jevmem init --tool claude` from this checkout's dist/, the guard in its
//             default `ask` mode); auto memory off
//   both      auto memory on and jevmem on, what a user who installs jevmem has today
//   claudemd  the reference: the task's line, as a person writes it, in CLAUDE.md; auto memory off; no teaching
//
// One job = one task, arm and run: a fresh copy of the project committed as the first commit of a new git repository
// (jevmem's files in it where jevmem is on), one Claude Code config directory and one HOME for the whole job. In the
// arms that learn (auto, jevmem, both) a teaching session per statement runs first (`claude -p` with the statement,
// which asks for nothing to be built); after each, the repository is put back to its first commit apart from each
// tool's memory (scripts/ab-automem-lib.mjs resetRepo), and the record keeps what each tool saved. Then the task
// session runs in the same folder and config directory. The long-project tasks (eval/ab/automem-long.mjs) are seeded
// instead of taught, in each tool's shape, and say so in their records.
//
// The served model and Claude Code version are read from each session's init event. A job with any session served by
// another model, or another version when --expect-claude is given, is a stray: it is rerun once in the same slot (task,
// arm, run); if the rerun is a stray too, the slot is left out (`excluded`) and counted. The first attempt's records
// are kept under `strays`. Claude Code authenticates with CLAUDE_CODE_OAUTH_TOKEN (or ~/.jevmem/e2e-oauth-token); the
// TypeSafe key goes into the session HOME's ~/.jevmem/env in the jevmem arms only.
//
// Judging: each task's `check` reads the final files, the diff since the first commit and the tool calls; no LLM
// judges anything. Raw stream-json transcripts go to --transcripts (default: a folder in the OS temp dir).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hookSummary, makeContext, readEvents, toolCallsOf } from "./ab-lib.mjs";
import { callsUnder, claudeMdFor, hookContextTexts, indexTextOf, jevmemLinesOf, jevmemMemories, loadedIndexText, longNotes, memoryDirFor, memoryTextOf, noteFate, projectDirsOf, readMemoryDir, renderAutoMemory, renderClaudeMd, resetRepo } from "./ab-automem-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const flag = (n) => args.includes(n);
const ALL_ARMS = ["none", "auto", "jevmem", "both", "claudemd"];
const ARMS = opt("--arms", ALL_ARMS.join(",")).split(",");
for (const a of ARMS) if (!ALL_ARMS.includes(a)) throw new Error(`unknown arm ${a}`);
const RUNS = Number(opt("--runs", "3"));
const CONCURRENCY = Number(opt("--concurrency", "4"));
const MODEL = opt("--model", "claude-fable-5-1");
const EXPECT_VERSION = opt("--expect-claude", null);
const today = new Date().toISOString().slice(0, 10);
const OUT = opt("--out", `results/ab-automem-${today}.json`);
const TRANSCRIPTS = path.resolve(opt("--transcripts", path.join(os.tmpdir(), `jevmem-ab-automem-transcripts-${today}`)));
const KEEP = flag("--keep");
const MAX_TURNS = Number(opt("--max-turns", "25"));
const TEACH_TURNS = Number(opt("--teach-turns", "12"));
const TIMEOUT_MS = Number(opt("--timeout-ms", String(10 * 60_000)));
// --max-jobs N caps the jobs this invocation runs (0: plan only, nothing runs); absent, every planned job runs.
const MAX_JOBS = args.includes("--max-jobs") ? Math.max(0, Number(opt("--max-jobs")) || 0) : Infinity;
const NODE = process.execPath;

const TASKS_FILE = path.join(ROOT, "eval/ab/tasks-automem.mjs");
const { PROJECTS, TASKS, LONG_TASKS } = await import(pathToFileURL(TASKS_FILE).href);
const { LONG_NOTES, LONG_START, LONG_STEP_DAYS } = await import(pathToFileURL(path.join(ROOT, "eval/ab/automem-long.mjs")).href);
const NOTES = longNotes(LONG_NOTES, LONG_START, LONG_STEP_DAYS);
const lib = await import(pathToFileURL(path.join(ROOT, "dist/index.js")).href);
const CLI = path.join(ROOT, "dist/cli.js");
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const JEVMEM_ARMS = new Set(["jevmem", "both"]);
const AUTO_ARMS = new Set(["auto", "both"]);
const LEARNING_ARMS = new Set(["auto", "jevmem", "both"]);

const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
let TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null;
const tokenFile = process.env.E2E_TOKEN_FILE ?? path.join(os.homedir(), ".jevmem/e2e-oauth-token");
if (!TOKEN && !process.env.ANTHROPIC_API_KEY && fs.existsSync(tokenFile)) TOKEN = fs.readFileSync(tokenFile, "utf8").trim();
if (!TOKEN && !process.env.ANTHROPIC_API_KEY) throw new Error("set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or put it in ~/.jevmem/e2e-oauth-token");
if (ARMS.some((a) => JEVMEM_ARMS.has(a)) && !process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required (the jevmem arms)");
const CLAUDE_VERSION = execFileSync(CLAUDE, ["--version"], { encoding: "utf8", env: { ...process.env, DISABLE_AUTOUPDATER: "1" } }).trim();
const CLAUDE_VERSION_NUMBER = (CLAUDE_VERSION.match(/\d+\.\d+\.\d+/) ?? [null])[0];
if (EXPECT_VERSION && CLAUDE_VERSION_NUMBER !== EXPECT_VERSION) throw new Error(`Claude Code is ${CLAUDE_VERSION}, not ${EXPECT_VERSION}`);
let COMMIT = opt("--build-commit", null);
if (!COMMIT)
  try {
    COMMIT = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() + (execFileSync("git", ["status", "--porcelain", "src", "dist"], { cwd: ROOT, encoding: "utf8" }).trim() ? "+dirty" : "");
  } catch {
    /* not a checkout */
  }

const git = (cwd, a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Sam Rivera", GIT_AUTHOR_EMAIL: "sam@example.com", GIT_COMMITTER_NAME: "Sam Rivera", GIT_COMMITTER_EMAIL: "sam@example.com" }, stdio: ["ignore", "pipe", "pipe"] });

function makeHome(arm) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-abm-home-"));
  if (JEVMEM_ARMS.has(arm)) {
    fs.mkdirSync(path.join(home, ".jevmem"), { mode: 0o700 });
    fs.writeFileSync(path.join(home, ".jevmem", "env"), `TYPESAFE_API_KEY=${process.env.TYPESAFE_API_KEY}\n`, { mode: 0o600 });
  }
  return home;
}

/** The task's lines for the reference arm: the taught line (the new one, for a changed decision). */
const linesFor = (task) => [task.line];

function setupProject(task, arm, home, config) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `jevmem-abm-${task.id}-${arm}-`)));
  const project = PROJECTS[task.project];
  fs.cpSync(path.resolve(ROOT, project.dir), root, { recursive: true });
  const files = { ...(task.long ? project.longFiles ?? {} : {}), ...(task.files ?? {}) };
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  if (JEVMEM_ARMS.has(arm)) {
    execFileSync(NODE, [CLI, "init", "--tool", "claude"], { cwd: root, env: { PATH: process.env.PATH, HOME: home }, stdio: "ignore" });
    if (task.long) {
      const mems = jevmemMemories(NOTES);
      fs.writeFileSync(path.join(root, "JEVMEM.md"), lib.MEMORY_HEADER + mems.map((m) => lib.formatLine(m)).join("\n") + "\n");
      for (const m of mems) if (m.kind !== "superseded") lib.recordProvenance(root, m, "hook");
    }
  } else if (arm === "claudemd") {
    fs.writeFileSync(path.join(root, "CLAUDE.md"), task.long ? renderClaudeMd(project.title, NOTES) : claudeMdFor(project.title, linesFor(task)));
  }
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "maintenance.auto", "false"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "initial import"]);
  const base = git(root, ["rev-parse", "HEAD"]).trim();
  const memDir = memoryDirFor(config, root);
  if (task.long && AUTO_ARMS.has(arm)) {
    const { index, files: topic } = renderAutoMemory(NOTES);
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "MEMORY.md"), index);
    for (const [name, text] of Object.entries(topic)) fs.writeFileSync(path.join(memDir, name), text);
  }
  return { root, base, memDir };
}

function allowedTools(task) {
  const bash = ["git status", "git diff:*", "git log:*", "ls:*", ...(task.bash ?? [])];
  return ["Read", "Edit", "Write", "Glob", "Grep", "Agent", "Task", ...bash.map((b) => `Bash(${b})`)];
}

function runClaude({ root, home, config, arm, prompt, task, transcript, maxTurns }) {
  return new Promise((resolve) => {
    const env = { HOME: home, USER: process.env.USER ?? "user", PATH: `${path.dirname(NODE)}:/usr/bin:/bin:/usr/sbin:/sbin`, TERM: "dumb", CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: "1" };
    if (!AUTO_ARMS.has(arm)) env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    if (TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
    else env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    const a = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-hook-events", "--permission-mode", "acceptEdits", "--max-turns", String(maxTurns), "--model", MODEL, "--allowedTools", ...allowedTools(task)];
    const t0 = Date.now();
    const child = spawn(CLAUDE, a, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = fs.createWriteStream(transcript);
    let err = "";
    child.stdout.pipe(out);
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      out.end(() => resolve({ code, signal, ms: Date.now() - t0, stderr: err.slice(-2000) }));
    });
  });
}

async function waitForDrain(root) {
  for (let i = 0; i < 300; i++) {
    const q = path.join(root, ".jevmem", "queue.jsonl");
    if ((!fs.existsSync(q) || fs.readFileSync(q, "utf8").trim() === "") && !fs.existsSync(path.join(root, ".jevmem", "drain.lock"))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function stopDaemon(root, home) {
  try {
    execFileSync(NODE, [CLI, "daemon", "stop"], { cwd: root, env: { PATH: process.env.PATH, HOME: home }, stdio: "ignore" });
  } catch {
    /* not running */
  }
}

/** What jevmem logged in this session: the guard's decisions and the prompt hook's Jev calls. */
function jevmemLogs(root) {
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(root, ".jevmem", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return null;
    }
  };
  const guardLog = read("guard-log.jsonl") ?? [];
  const log = read("log.jsonl");
  const recall = log ? log.filter((e) => e.label === "recall" && !e.event).map((e) => ({ ok: e.ok, ms: e.latencyMs, inputTokens: e.inputTokens, error: e.error })) : null;
  // The Stop hook's decide calls and outcomes (what jevmem made of the teaching statement).
  const decide = log ? log.filter((e) => e.label === "decide").map((e) => ({ ok: e.ok, ms: e.latencyMs, tier: e.tier ?? null, event: e.event ?? null, detail: e.detail ?? null, memoryId: e.memoryId ?? null, error: e.error ?? null })) : null;
  return { guardLog, recall, decide };
}

/** The common part of a session's record, from its transcript. */
function sessionRecord(transcript, r) {
  const events = readEvents(transcript);
  const init = events.find((e) => e.type === "system" && e.subtype === "init") ?? {};
  const result = events.findLast((e) => e.type === "result") ?? {};
  const hooks = hookSummary(events);
  const calls = toolCallsOf(events);
  const usage = result.usage ?? {};
  return {
    events,
    calls,
    hooks,
    contexts: hookContextTexts(events),
    base: {
      model: init.model ?? null,
      claudeCode: init.claude_code_version ?? null,
      exit: r.code,
      signal: r.signal,
      ms: r.ms,
      turns: result.num_turns ?? null,
      end: result.subtype ?? null,
      costUsd: result.total_cost_usd ?? null,
      usage: { input_tokens: usage.input_tokens ?? null, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null, cache_read_input_tokens: usage.cache_read_input_tokens ?? null, output_tokens: usage.output_tokens ?? null },
      resultText: String(result.result ?? "").slice(0, 600),
      hookFailures: hooks.failed,
      guard: hooks.guard,
      promptContextChars: hooks.contextChars,
      startContextChars: hooks.startContextChars,
      startContextLines: hooks.startContextLines,
      toolCalls: calls.map((c) => ({ name: c.name, parent: c.parent, error: c.error, arg: String(c.input.command ?? c.input.file_path ?? c.input.pattern ?? c.input.description ?? "").slice(0, 200), result: c.error ? c.result : undefined, ...(c.hooked ? { hook: c.hook } : {}) })),
      subagentCalls: calls.filter((c) => c.parent).length,
      stderr: r.code === 0 ? undefined : r.stderr,
      transcript: path.basename(transcript),
    },
  };
}

/** Did each tool save the line (its words in what the tool wrote), and for a change, is the old line gone? */
function savedMeasures(task, arm, memDir, root, step, first) {
  const out = { auto: null, autoIndex: null, jevmem: null };
  const words = task.savedWords;
  const old = task.oldWords ?? null;
  const last = step === task.teach.length - 1;
  if (AUTO_ARMS.has(arm)) {
    const snap = readMemoryDir(memDir);
    out.auto = words.test(memoryTextOf(snap));
    out.autoIndex = words.test(indexTextOf(snap));
    if (old && last) {
      // The old words may still be mentioned by the new note ("X-Api-Key is out"); what became of the old note itself
      // is read from the first teaching session's snapshot: its index line kept verbatim, its file kept, rewritten or gone.
      out.oldInAutoIndex = old.test(indexTextOf(snap));
      out.oldInAutoFiles = old.test(memoryTextOf(snap));
      if (first?.auto) out.oldNoteAuto = noteFate(first.auto, snap);
    }
    if (step === 0) first.auto = snap;
    out.autoFiles = snap.files.map((f) => ({ name: f.name, bytes: f.bytes, lines: f.lines }));
    out.autoText = snap.files.map((f) => `=== ${f.name}\n${f.text}`).join("\n");
  }
  if (JEVMEM_ARMS.has(arm)) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8");
    } catch {
      /* no file */
    }
    const lines = jevmemLinesOf(text, lib);
    out.jevmem = words.test(lines.liveText);
    out.jevmemLines = lines.all.map((m) => ({ id: m.id, kind: m.kind, text: m.text, ...(m.supersededBy ? { supersededBy: m.supersededBy } : {}), ...(m.always ? { always: true } : {}) }));
    if (old && last) {
      out.oldInJevmemLive = old.test(lines.liveText);
      out.oldInJevmemSuperseded = old.test(lines.supersededText);
      // The lines the first teaching session saved: still live, superseded, or gone, by id.
      if (first?.jevmemIds) out.oldNoteJevmem = { lines: first.jevmemIds.length, superseded: first.jevmemIds.filter((id) => lines.superseded.some((m) => m.id === id)).length, stillLive: first.jevmemIds.filter((id) => lines.live.some((m) => m.id === id)).length, gone: first.jevmemIds.filter((id) => !lines.all.some((m) => m.id === id)).length };
    }
    if (step === 0) first.jevmemIds = lines.live.map((m) => m.id);
  }
  return out;
}

async function runJob(job, attempt) {
  const { task, arm, run } = job;
  const home = makeHome(arm);
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-abm-config-"));
  const { root, base, memDir } = setupProject(task, arm, home, config);
  const records = [];
  const common = { task: task.id, project: task.project, category: task.category, arm, run, attempt, long: Boolean(task.long), seeded: Boolean(task.long) && arm !== "none" };
  let saved = null;
  const first = {};
  if (!task.long && LEARNING_ARMS.has(arm)) {
    for (let step = 0; step < task.teach.length; step++) {
      const transcript = path.join(TRANSCRIPTS, `${task.id}.${arm}.${run}.teach${step + 1}${attempt > 1 ? `.a${attempt}` : ""}.jsonl`);
      const r = await runClaude({ root, home, config, arm, prompt: task.teach[step], task, transcript, maxTurns: TEACH_TURNS });
      if (JEVMEM_ARMS.has(arm)) await waitForDrain(root);
      const s = sessionRecord(transcript, r);
      saved = savedMeasures(task, arm, memDir, root, step, first);
      const logs = JEVMEM_ARMS.has(arm) ? jevmemLogs(root) : { guardLog: [], recall: null, decide: null };
      const touched = AUTO_ARMS.has(arm) ? callsUnder(s.calls, memDir, readMemoryDir(memDir)) : { reads: [], writes: [], readBytes: 0, writeAsks: 0 };
      const { undone } = resetRepo(root);
      records.push({ id: `${task.id}.teach${step + 1}`, kind: "teach", step: step + 1, statement: task.teach[step], ...common, ...s.base, saved, wroteIntoRepo: undone, memoryWrites: touched.writes, memoryWriteAsks: touched.writeAsks, recall: logs.recall, decide: logs.decide, guardLog: logs.guardLog.map((g) => ({ tool: g.tool, route: g.route, decision: g.decision, action: String(g.action ?? "").slice(0, 160) })), memoryDirs: projectDirsOf(config) });
      if (JEVMEM_ARMS.has(arm)) stopDaemon(root, home);
    }
  }
  // The task session. Memory at its start, as Claude Code or the hooks will see it.
  const before = AUTO_ARMS.has(arm) ? readMemoryDir(memDir) : null;
  const indexText = before ? indexTextOf(before) : "";
  const loaded = before ? loadedIndexText(indexText) : "";
  const memoryAtStart = {
    ...(before ? { indexBytes: before.indexBytes, indexLines: before.indexLines, loadedBytes: Buffer.byteLength(loaded), loadedLines: loaded ? loaded.split("\n").length : 0, dirBytes: before.totalBytes, files: before.files.length, lineInIndex: task.savedWords.test(indexText), lineInLoadedIndex: task.savedWords.test(loaded) } : {}),
    ...(arm === "claudemd" ? { claudeMdBytes: Buffer.byteLength(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")), claudeMdLines: fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8").split("\n").filter((l) => l.startsWith("- ")).length } : {}),
    ...(JEVMEM_ARMS.has(arm) ? { jevmemLines: jevmemLinesOf(fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8"), lib).all.length, jevmemBytes: Buffer.byteLength(fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8")) } : {}),
  };
  const transcript = path.join(TRANSCRIPTS, `${task.id}.${arm}.${run}${attempt > 1 ? `.a${attempt}` : ""}.jsonl`);
  const r = await runClaude({ root, home, config, arm, prompt: task.prompt, task, transcript, maxTurns: MAX_TURNS });
  if (JEVMEM_ARMS.has(arm)) {
    await waitForDrain(root);
    stopDaemon(root, home);
  }
  const s = sessionRecord(transcript, r);
  const ctx = makeContext(root, base, s.events);
  let check;
  try {
    check = task.check(ctx);
  } catch (err) {
    check = { error: String(err?.stack ?? err) };
  }
  const logs = JEVMEM_ARMS.has(arm) ? jevmemLogs(root) : { guardLog: [], recall: null, decide: null };
  const after = AUTO_ARMS.has(arm) ? readMemoryDir(memDir) : null;
  const touched = AUTO_ARMS.has(arm) ? callsUnder(s.calls, memDir, after) : { reads: [], writes: [], readBytes: 0, writeAsks: 0 };
  const taskRecord = {
    id: task.id,
    kind: "task",
    ...common,
    ...s.base,
    check,
    saved,
    memoryAtStart,
    memoryReads: touched.reads,
    memoryReadBytes: touched.readBytes,
    memoryWrites: touched.writes,
    memoryWriteAsks: touched.writeAsks,
    memoryAfter: after ? { files: after.files.map((f) => ({ name: f.name, bytes: f.bytes, lines: f.lines })), bytes: after.totalBytes, changed: JSON.stringify(after.files.map((f) => [f.name, f.text])) !== JSON.stringify((before?.files ?? []).map((f) => [f.name, f.text])) } : null,
    memoryDirs: projectDirsOf(config),
    lineInPromptContext: JEVMEM_ARMS.has(arm) ? task.savedWords.test(s.contexts.prompt) : null,
    lineInStartContext: JEVMEM_ARMS.has(arm) ? task.savedWords.test(s.contexts.start) : null,
    oldInPromptContext: JEVMEM_ARMS.has(arm) && task.oldWords ? task.oldWords.test(s.contexts.prompt) : null,
    guardLog: logs.guardLog.map((g) => ({ tool: g.tool, route: g.route, decision: g.decision, action: String(g.action ?? "").slice(0, 160), rules: (g.rules ?? []).map((x) => ({ id: x.id, p: x.p })) })),
    recall: logs.recall,
    decide: logs.decide,
    openedJevmemMd: s.calls.some((c) => !c.error && /JEVMEM\.md/.test(String(c.input?.file_path ?? c.input?.command ?? ""))),
    agentUsed: s.calls.some((c) => (c.name === "Task" || c.name === "Agent") && !c.parent),
  };
  records.push(taskRecord);
  const stray = records.filter((x) => x.model !== null && (x.model !== MODEL || (EXPECT_VERSION && x.claudeCode !== EXPECT_VERSION))).map((x) => `${x.id}: ${x.model} ${x.claudeCode}`);
  if (KEEP) for (const x of records) Object.assign(x, { scratch: root, configDir: config, home });
  else {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(config, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
  return { records, stray };
}

// ------------------------------------------------------------------ plan
const pick = (list, spec) => (spec === "all" ? list : spec === "none" ? [] : list.filter((t) => spec.split(",").includes(t.id)));
const selected = [...pick(TASKS, opt("--tasks", "all")), ...pick(LONG_TASKS, opt("--long", "all"))];
const jobs = [];
for (let run = 1; run <= RUNS; run++) for (const task of selected) for (const arm of ARMS) jobs.push({ task, arm, run });
fs.mkdirSync(TRANSCRIPTS, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const partial = OUT.replace(/\.json$/, ".partial.jsonl");
const keyOf = (j) => `${j.task.id}|${j.arm}|${j.run}`;
const done = [];
if (flag("--resume") && fs.existsSync(partial)) {
  for (const l of fs.readFileSync(partial, "utf8").split("\n").filter(Boolean)) done.push(JSON.parse(l));
  const seen = new Set(done.map((d) => d.key));
  const before = jobs.length;
  for (let i = jobs.length - 1; i >= 0; i--) if (seen.has(keyOf(jobs[i]))) jobs.splice(i, 1);
  console.error(`resuming: ${done.length} jobs already recorded, ${before - jobs.length} of them in this plan`);
}
const sessionsPlanned = jobs.reduce((a, j) => a + 1 + (!j.task.long && LEARNING_ARMS.has(j.arm) ? j.task.teach.length : 0), 0);
const thisBlock = jobs.slice(0, Math.min(jobs.length, MAX_JOBS));
const sessionsThisBlock = thisBlock.reduce((a, j) => a + 1 + (!j.task.long && LEARNING_ARMS.has(j.arm) ? j.task.teach.length : 0), 0);
console.error(`${jobs.length} jobs, ${sessionsPlanned} sessions left${MAX_JOBS !== Infinity ? ` (this block: ${thisBlock.length} jobs, ${sessionsThisBlock} sessions)` : ""}, ${CONCURRENCY} at a time; ${CLAUDE_VERSION}; model ${MODEL}; jevmem ${COMMIT}; transcripts in ${TRANSCRIPTS}`);

let next = 0;
let count = 0;
async function worker() {
  while (next < jobs.length && next < MAX_JOBS) {
    const job = jobs[next++];
    let { records, stray } = await runJob(job, 1);
    let strays = [];
    let excluded = false;
    if (stray.length) {
      console.error(`   stray (${stray.join("; ")}), rerunning ${keyOf(job)}`);
      strays = records;
      ({ records, stray } = await runJob(job, 2));
      if (stray.length) {
        excluded = true;
        console.error(`   stray again (${stray.join("; ")}): slot ${keyOf(job)} left out`);
      }
    }
    for (const x of records) x.excluded = excluded;
    const line = { key: keyOf(job), records, strays };
    done.push(line);
    fs.appendFileSync(partial, JSON.stringify(line) + "\n");
    count++;
    const t = records.find((x) => x.kind === "task");
    const c = t.check ?? {};
    const teach = records.filter((x) => x.kind === "teach");
    const savedNote = teach.length ? ` saved=${["auto", "jevmem"].filter((k) => t.saved?.[k] !== null).map((k) => `${k}:${t.saved?.[k]}`).join(",")}` : t.seeded ? " seeded" : "";
    console.error(`[${count}/${thisBlock.length}${MAX_JOBS !== Infinity ? ` of ${jobs.length} left` : ""}] ${t.task} ${t.arm} run ${t.run}: followed=${c.followed} done=${c.done}${c.stale !== undefined ? ` stale=${c.stale}` : ""}${c.repeated !== undefined ? ` repeated=${c.repeated}` : ""}${c.attempted !== undefined ? ` attempted=${c.attempted} landed=${c.landed}` : ""}${savedNote}${t.memoryAtStart.lineInLoadedIndex !== undefined ? ` loaded=${t.memoryAtStart.lineInLoadedIndex}` : ""}${t.lineInPromptContext !== null ? ` injected=${t.lineInPromptContext || t.lineInStartContext}` : ""}${t.guard.length ? ` guard=${t.guard.map((g) => g.decision).join(",")}` : ""} (${Math.round(t.ms / 1000)} s, ${t.turns} turns, ${teach.length} teach${t.model !== MODEL ? `, MODEL ${t.model}` : ""}${c.error ? `, CHECK ERROR ${c.error.split("\n")[0]}` : ""}) ${c.note ?? ""}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const records = done.flatMap((d) => d.records).sort((a, b) => a.task.localeCompare(b.task) || a.arm.localeCompare(b.arm) || a.run - b.run || a.kind.localeCompare(b.kind) || (a.step ?? 0) - (b.step ?? 0));
const strays = done.flatMap((d) => d.strays);
const out = {
  kind: "ab-automem",
  date: today,
  claude_code: CLAUDE_VERSION,
  model_requested: MODEL,
  models_served: [...new Set(records.map((r) => r.model).filter(Boolean))],
  versions_served: [...new Set(records.map((r) => r.claudeCode).filter(Boolean))],
  jevmem_commit: COMMIT,
  jevmem_version: PKG_VERSION,
  tasks_file: path.relative(ROOT, TASKS_FILE),
  arms: ARMS,
  runs: RUNS,
  permission_mode: "acceptEdits",
  max_turns: MAX_TURNS,
  teach_turns: TEACH_TURNS,
  jobs: done.length,
  jobs_left: jobs.length - thisBlock.length,
  sessions: records.length,
  stray_sessions: strays.length,
  excluded_slots: [...new Set(records.filter((r) => r.excluded).map((r) => `${r.task}|${r.arm}|${r.run}`))],
  method: "See scripts/ab-automem.mjs, eval/ab/tasks-automem.mjs and eval/ab/automem-long.mjs.",
  records,
  strays,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.error(`wrote ${OUT}`);
