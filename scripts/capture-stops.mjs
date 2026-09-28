#!/usr/bin/env node
// Real transcripts for the Stop hook's eval sets (v0.6 part 3b): what jevmem's Stop hook sees, captured from real
// Claude Code sessions.
//
//   node scripts/capture-stops.mjs --cases <cases.mjs> --out <set.jsonl> [--concurrency 4] [--only id,id] [--claude-version 2.1.281]
//
// One `claude -p` session per case (a follow-up prompt runs with --resume in the same session), in a scratch copy of the
// case's project (eval/stops/projects/<project>, or an outcome A/B project), committed as the first commit of a new git
// repository, with a new, empty CLAUDE_CONFIG_DIR and a temporary HOME, as scripts/ab.mjs runs its sessions. jevmem is not
// installed: a capture hook on Stop, SubagentStop and UserPromptSubmit saves each hook's payload and a copy of the session
// transcript at that moment. Modes:
//   background  CLAUDE_CODE_FORK_SUBAGENT=1: fork mode, as in an interactive session, so every subagent runs in the
//               background and its report comes back as a task notification in a later turn
//   foreground  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1: every subagent runs in the foreground
//   none        neither; the prompt asks for no subagent
// Each output row is one session: its prompts, its label (what the whole turn should save: nothing, or a line of a
// kind), and every Stop with its payload and the transcript as it was when the hook ran. Transcripts are trimmed before
// they are written: `attachment` entries (Claude Code's environment, system prompt and tool listings) and a few
// bookkeeping entry types are dropped, thinking blocks are emptied, tool results and tool inputs are cut to 2,000
// characters, and the scratch paths are replaced by <project>, <config>, <tmp> and <home>. The user and assistant
// entries, their order, and the fields that mark a prompt's origin and an async launch are kept as written.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const CASES_FILE = path.resolve(opt("--cases", ""));
const OUT = path.resolve(opt("--out", ""));
const CONCURRENCY = Number(opt("--concurrency", "4"));
const ONLY = opt("--only", null)?.split(",") ?? null;
const VERSION = opt("--claude-version", "2.1.281");
const MODEL = opt("--model", "claude-sonnet-5");
const MAX_TURNS = Number(opt("--max-turns", "25"));
if (!fs.existsSync(CASES_FILE) || !opt("--out")) throw new Error("usage: --cases <cases.mjs> --out <set.jsonl>");

const { SET, CASES } = await import(pathToFileURL(CASES_FILE).href);
const CLAUDE = process.env.CLAUDE_BIN ?? path.join(os.homedir(), `Library/Application Support/Claude/claude-code/${VERSION}/claude.app/Contents/MacOS/claude`);
let TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null;
const tokenFile = process.env.E2E_TOKEN_FILE ?? path.join(os.homedir(), ".jevmem/e2e-oauth-token");
if (!TOKEN && fs.existsSync(tokenFile)) TOKEN = fs.readFileSync(tokenFile, "utf8").trim();
if (!TOKEN && !process.env.ANTHROPIC_API_KEY) throw new Error("set CLAUDE_CODE_OAUTH_TOKEN or put it in ~/.jevmem/e2e-oauth-token");
const CLAUDE_VERSION = execFileSync(CLAUDE, ["--version"], { encoding: "utf8", env: { ...process.env, DISABLE_AUTOUPDATER: "1" } }).trim();

const projectDir = (name) => {
  for (const d of [path.join(ROOT, "eval/stops/projects", name), path.join(ROOT, "eval/ab/projects", name)]) if (fs.existsSync(d)) return d;
  throw new Error(`no project ${name}`);
};

// The capture hook: saves the payload and a copy of the transcript. Written once, outside every scratch project.
const HOOK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-capture-hook-")), "capture.mjs");
fs.writeFileSync(
  HOOK,
  `import fs from "node:fs";
import path from "node:path";
const out = process.env.JEVMEM_CAPTURE_DIR;
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let p = {};
try { p = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
fs.mkdirSync(out, { recursive: true });
const n = fs.readdirSync(out).filter((f) => f.endsWith(".payload.json")).length + 1;
const tag = String(n).padStart(3, "0");
fs.writeFileSync(path.join(out, tag + ".payload.json"), JSON.stringify({ ...p, captured_at: new Date().toISOString() }));
if (p.transcript_path && fs.existsSync(p.transcript_path)) fs.copyFileSync(p.transcript_path, path.join(out, tag + ".transcript.jsonl"));
`,
);

const git = (cwd, a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Sam Rivera", GIT_AUTHOR_EMAIL: "sam@example.com", GIT_COMMITTER_NAME: "Sam Rivera", GIT_COMMITTER_EMAIL: "sam@example.com" }, stdio: ["ignore", "pipe", "pipe"] });

function allowedTools(c) {
  const bash = ["git status", "git diff:*", "git log:*", "ls:*", "node --test:*", "npm test", ...(c.bash ?? [])];
  return ["Read", "Edit", "Write", "Glob", "Grep", "Agent", "Task", ...bash.map((b) => `Bash(${b})`)];
}

function runClaude({ root, home, config, capture, prompt, resume, c }) {
  return new Promise((resolve) => {
    const env = { HOME: home, USER: process.env.USER ?? "user", PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, TERM: "dumb", CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: "1", JEVMEM_CAPTURE_DIR: capture };
    if (TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
    else env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (c.mode === "background") env.CLAUDE_CODE_FORK_SUBAGENT = "1";
    if (c.mode === "foreground") env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
    const a = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-hook-events", "--permission-mode", "acceptEdits", "--max-turns", String(MAX_TURNS), "--model", MODEL, "--allowedTools", ...allowedTools(c)];
    if (resume) a.unshift("--resume", resume);
    const child = spawn(CLAUDE, a, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const events = out.split("\n").flatMap((l) => {
        try {
          return l.trim() ? [JSON.parse(l)] : [];
        } catch {
          return [];
        }
      });
      resolve({ code, events, stderr: err.slice(-1500) });
    });
  });
}

const cut = (s, n = 2000) => (typeof s === "string" && s.length > n ? s.slice(0, n) + ` [… ${s.length - n} characters cut]` : s);

/** A transcript entry as it is kept: the fields that say what it is and where it came from, its message, trimmed. */
function trimEntry(e) {
  const keep = ["type", "subtype", "uuid", "parentUuid", "isSidechain", "isMeta", "isCompactSummary", "isVisibleInTranscriptOnly", "promptId", "origin", "promptSource", "turnOrigin", "timestamp", "sourceToolAssistantUUID", "operation", "content", "level", "toolUseID"];
  const o = {};
  for (const k of keep) if (e[k] !== undefined) o[k] = k === "content" ? cut(e[k], 3000) : e[k];
  if (e.toolUseResult && typeof e.toolUseResult === "object") {
    o.toolUseResult = Object.fromEntries(Object.entries(e.toolUseResult).filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v)).map(([k, v]) => [k, cut(v, 300)]));
  }
  if (e.message) {
    const m = { role: e.message.role };
    const c = e.message.content;
    if (typeof c === "string") m.content = cut(c, 4000);
    else if (Array.isArray(c))
      m.content = c.map((b) => {
        if (b?.type === "thinking" || b?.type === "redacted_thinking") return { type: b.type, thinking: "" };
        if (b?.type === "text") return { type: "text", text: cut(b.text, 4000) };
        if (b?.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: Object.fromEntries(Object.entries(b.input ?? {}).map(([k, v]) => [k, typeof v === "string" ? cut(v) : v])) };
        if (b?.type === "tool_result") return { type: "tool_result", tool_use_id: b.tool_use_id, is_error: b.is_error, content: typeof b.content === "string" ? cut(b.content) : Array.isArray(b.content) ? b.content.map((x) => (x?.type === "text" ? { type: "text", text: cut(x.text) } : { type: x?.type })) : b.content };
        return { type: b?.type };
      });
    o.message = m;
  }
  return o;
}

const KEPT_TYPES = new Set(["user", "assistant", "system", "queue-operation"]);

function normaliser(pairs) {
  const list = pairs.filter(([from]) => from).sort((a, b) => b[0].length - a[0].length);
  const walk = (v) => {
    if (typeof v === "string") {
      let s = v;
      for (const [from, to] of list) s = s.split(from).join(to);
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk;
}

async function session(c) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `jevmem-stops-${c.project}-`)));
  fs.cpSync(projectDir(c.project), root, { recursive: true });
  const capture = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-stops-capture-"));
  const cmd = `"${process.execPath}" "${HOOK}"`;
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/settings.json"), JSON.stringify({ hooks: Object.fromEntries(["Stop", "SubagentStop", "UserPromptSubmit"].map((e) => [e, [{ hooks: [{ type: "command", command: cmd }] }]])) }, null, 2) + "\n");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "initial import"]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-stops-home-"));
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-stops-config-"));
  const t0 = Date.now();
  const runs = [];
  let sessionId = null;
  const hooksBefore = [];
  for (const [i, prompt] of c.prompts.entries()) {
    hooksBefore.push(fs.readdirSync(capture).filter((f) => f.endsWith(".payload.json")).length);
    const r = await runClaude({ root, home, config, capture, prompt, resume: i > 0 ? sessionId : null, c });
    sessionId = r.events.find((e) => e.type === "system" && e.subtype === "init")?.session_id ?? sessionId;
    const results = r.events.filter((e) => e.type === "result");
    runs.push({ exit: r.code, results: results.map((x) => ({ subtype: x.subtype, turns: x.num_turns, cost: x.total_cost_usd })), model: r.events.find((e) => e.type === "system" && e.subtype === "init")?.model ?? null, backgrounded: r.events.filter((e) => e.type === "system" && e.subtype === "task_started").map((e) => ({ type: e.task_type, backgrounded: e.is_backgrounded })), stderr: r.code === 0 ? undefined : r.stderr });
  }
  const tmpReal = fs.realpathSync(os.tmpdir());
  const norm = normaliser([
    [root, "<project>"],
    [root.replace(/^\/private/, ""), "<project>"],
    [fs.realpathSync(config), "<config>"],
    [config, "<config>"],
    [config.replace(/^\/private/, ""), "<config>"],
    [home, "<home>"],
    [fs.realpathSync(home), "<home>"],
    ["/private/tmp/claude-" + (process.getuid?.() ?? ""), "<tmp>/claude"],
    [tmpReal, "<tmpdir>"],
    [os.homedir(), "<user-home>"],
  ]);
  const files = fs.readdirSync(capture).filter((f) => f.endsWith(".payload.json")).sort();
  const hooks = [];
  const stops = [];
  const dropped = {};
  for (const [n, f] of files.entries()) {
    const tag = f.slice(0, 3);
    const payload = JSON.parse(fs.readFileSync(path.join(capture, f), "utf8"));
    // Which prompt (run) the hook fired in: the last run that had started before it.
    let run = 0;
    for (let i = 0; i < hooksBefore.length; i++) if (n >= hooksBefore[i]) run = i;
    hooks.push({ event: payload.hook_event_name, at: payload.captured_at, run });
    if (payload.hook_event_name !== "Stop") continue;
    let transcript = [];
    const tf = path.join(capture, `${tag}.transcript.jsonl`);
    if (fs.existsSync(tf)) {
      for (const line of fs.readFileSync(tf, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (!KEPT_TYPES.has(e.type)) {
          dropped[e.type] = (dropped[e.type] ?? 0) + 1;
          continue;
        }
        transcript.push(trimEntry(e));
      }
    }
    const keepPayload = ["hook_event_name", "session_id", "transcript_path", "cwd", "prompt_id", "permission_mode", "stop_hook_active", "last_assistant_message", "background_tasks", "session_crons", "effort"];
    stops.push({ run, payload: norm(Object.fromEntries(keepPayload.filter((k) => payload[k] !== undefined).map((k) => [k, payload[k]]))), transcript: norm(transcript), captured_at: payload.captured_at });
  }
  const changed = git(root, ["status", "--porcelain"]).trim().split("\n").filter(Boolean).filter((l) => !/\.claude\//.test(l));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(config, { recursive: true, force: true });
  fs.rmSync(capture, { recursive: true, force: true });
  return {
    row: "session",
    set: SET,
    id: c.id,
    project: c.project,
    mode: c.mode,
    prompts: c.prompts,
    labels: c.labels,
    note: c.note ?? null,
    claude_code: CLAUDE_VERSION,
    model: runs[0]?.model ?? null,
    captured_at: new Date(t0).toISOString(),
    ms: Date.now() - t0,
    runs,
    hooks,
    files_changed: changed,
    dropped_entry_types: dropped,
    stops,
  };
}

const cases = CASES.filter((c) => !ONLY || ONLY.includes(c.id));
const rows = [];
let next = 0;
const partial = OUT.replace(/\.jsonl$/, ".partial.jsonl");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
console.error(`${cases.length} sessions, ${CONCURRENCY} at a time; ${CLAUDE_VERSION}, ${MODEL}`);
async function worker() {
  while (next < cases.length) {
    const c = cases[next++];
    const row = await session(c);
    rows.push(row);
    fs.appendFileSync(partial, JSON.stringify(row) + "\n");
    const running = row.stops.filter((s) => (s.payload.background_tasks ?? []).some((t) => t.status === "running")).length;
    console.error(`${row.id} (${row.mode}): ${row.stops.length} Stop(s), ${running} with a background task running; ${row.runs.map((r) => r.backgrounded.map((b) => `${b.type}${b.backgrounded ? " bg" : " fg"}`).join(",") || "no task").join(" | ")}; exit ${row.runs.map((r) => r.exit).join(",")}; ${Math.round(row.ms / 1000)} s`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const order = new Map(CASES.map((c, i) => [c.id, i]));
rows.sort((a, b) => order.get(a.id) - order.get(b.id));
fs.writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
fs.rmSync(partial, { force: true });
fs.rmSync(path.dirname(HOOK), { recursive: true, force: true });
console.error(`wrote ${OUT}`);
