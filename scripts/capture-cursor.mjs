#!/usr/bin/env node
// Real Cursor sessions for the Cursor capture sets (0.7.4): what Cursor's hooks send, captured from real sessions
// driven through the `agent` CLI, with no jevmem code anywhere near them.
//
//   node scripts/capture-cursor.mjs --cases <cases.mjs> --out <set.jsonl> --model <name> [--only id,id] [--agent <bin>] [--timeout 600]
//
// One scratch copy of the case's project per session (eval/ab/projects/<project> or eval/stops/projects/<project>),
// committed as the first commit of a new git repository, with `.cursor/hooks.json` naming a logging-only hook on
// every agent event: the hook writes each payload (and the Cursor variables it was given) to a folder outside the
// project, copies `transcript_path` at `stop` and `sessionEnd`, answers the least a hook may answer and exits 0. Each
// prompt is one `agent -p --trust --force --output-format stream-json --model <name>` run in the scratch copy, in a
// clean environment (HOME, PATH, TERM, LANG only); a follow-up prompt resumes the first run's chat (`--resume=<id>`,
// the `session_id` of the first run's init event). The CLI's own events are kept per run: the init event (the model
// it names), every assistant event's text (one per assistant message between tool calls), the tool calls, and the
// terminal result event (its `result` text, the pairing truth for the final assistant text). Each output row is one
// session: its prompts and labels as in the cases file, the agent CLI's version at the start (it updates itself between runs, so each run also records the version
// its payloads name), the model requested and the model the payloads name, and every run with its hook payloads in order and the stop transcript (cut at --transcript-cut bytes).
// Scratch paths are replaced by <project>, <capture> and <home>. Rows are appended as each session ends.
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
const MODEL = opt("--model", null);
const ONLY = opt("--only", null)?.split(",") ?? null;
const AGENT = opt("--agent", process.env.AGENT_BIN ?? "agent");
const TIMEOUT_S = Number(opt("--timeout", "600"));
const TRANSCRIPT_CUT = Number(opt("--transcript-cut", "400000"));
if (!fs.existsSync(CASES_FILE) || !opt("--out") || !MODEL) throw new Error("usage: --cases <cases.mjs> --out <set.jsonl> --model <name>");

const { SET, CASES } = await import(pathToFileURL(CASES_FILE).href);
const AGENT_VERSION = execFileSync(AGENT, ["--version"], { encoding: "utf8" }).trim();

const projectDir = (name) => {
  for (const d of [path.join(ROOT, "eval/ab/projects", name), path.join(ROOT, "eval/stops/projects", name), path.join(ROOT, "eval/attempts/projects", name)]) if (fs.existsSync(d)) return d;
  throw new Error(`no project ${name}`);
};

// The logging hook, written once outside every scratch project. Its arguments: the event name and the capture folder.
const HOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hooks-"));
const HOOK = path.join(HOOK_DIR, "log.sh");
fs.writeFileSync(
  HOOK,
  `#!/bin/sh
# Logging-only hook: the payload, the arguments and the variables, nothing else.
tag="$1"; dir="$2"
mkdir -p "$dir"
at=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
f="$dir/$at.$$.$tag"
payload=$(cat)
[ -z "$payload" ] && payload='null'
{
  printf '{"tag":"%s","at":%s,"pid":%s,"cwd":"%s","env":{' "$tag" "$at" "$$" "$PWD"
  env | grep -E '^(CURSOR_|CLAUDE_PROJECT_DIR=|CLAUDE_CODE_REMOTE=)' | sort | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | awk -F= '{k=$1; v=substr($0, length(k)+2); printf "%s\\"%s\\":\\"%s\\"", s, k, v; s=","}'
  printf '},"payload":%s}\\n' "$payload"
} > "$f.json"
if [ "$tag" = stop ] || [ "$tag" = sessionEnd ]; then
  tp=$(printf '%s' "$payload" | tr -d '\\n' | sed -n 's/.*"transcript_path": *"\\([^"]*\\)".*/\\1/p' | head -1)
  if [ -n "$tp" ] && [ -f "$tp" ]; then cp "$tp" "$f.transcript" 2>/dev/null; fi
fi
case "$tag" in
  beforeSubmitPrompt) printf '{"continue":true}\\n' ;;
  preToolUse|beforeShellExecution|beforeMCPExecution|beforeReadFile|subagentStart) printf '{"permission":"allow"}\\n' ;;
  *) printf '{}\\n' ;;
esac
exit 0
`,
);
fs.chmodSync(HOOK, 0o755);
const EVENTS = ["sessionStart", "sessionEnd", "beforeSubmitPrompt", "afterAgentResponse", "afterAgentThought", "stop", "preToolUse", "postToolUse", "postToolUseFailure", "beforeShellExecution", "afterShellExecution", "beforeMCPExecution", "afterMCPExecution", "beforeReadFile", "afterFileEdit", "subagentStart", "subagentStop", "preCompact"];

const git = (cwd, a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Sam Rivera", GIT_AUTHOR_EMAIL: "sam@example.com", GIT_COMMITTER_NAME: "Sam Rivera", GIT_COMMITTER_EMAIL: "sam@example.com" }, stdio: ["ignore", "pipe", "pipe"] });
const cleanEnv = () => ({ HOME: os.homedir(), PATH: process.env.PATH, TERM: process.env.TERM ?? "xterm-256color", LANG: process.env.LANG ?? "en_US.UTF-8", TMPDIR: process.env.TMPDIR ?? os.tmpdir() });

function runAgent(cwd, argv) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(AGENT, argv, { cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGINT"), TIMEOUT_S * 1000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err, seconds: (Date.now() - t0) / 1000 });
    });
  });
}

function parseStream(out) {
  const events = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      events.push({ type: "unparsed", line: line.slice(0, 500) });
    }
  }
  const init = events.find((e) => e.type === "system" && e.subtype === "init") ?? null;
  const result = events.find((e) => e.type === "result") ?? null;
  const assistant = events.filter((e) => e.type === "assistant").map((e) => (e.message?.content ?? []).map((c) => c.text ?? "").join(""));
  const tools = events.filter((e) => e.type === "tool_call" && e.subtype === "started").map((e) => Object.keys(e.tool_call ?? {})[0] ?? "?");
  return { events, init, result, assistant, tools };
}

const scrub = (s, map) => {
  let t = s;
  for (const [from, to] of map) t = t.split(from).join(to);
  // The transcript path's project slug (Cursor derives it from the scratch path) and the account's email.
  t = t.replace(/private-var-folders-[A-Za-z0-9_-]*?-T-(?:ws|jevmem-cursor-[a-z0-9-]+)-[A-Za-z0-9]{6}-[a-z]+/g, "<project-slug>");
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.com");
  return t;
};

function readHooks(dir, map) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  const hooks = [];
  let transcript = null;
  for (const f of files) {
    const p = path.join(dir, f);
    if (f.endsWith(".json")) {
      let rec;
      try {
        rec = JSON.parse(scrub(fs.readFileSync(p, "utf8"), map));
      } catch (e) {
        rec = { tag: f.split(".").at(-2), unparsed: scrub(fs.readFileSync(p, "utf8"), map).slice(0, 2000), error: String(e) };
      }
      hooks.push(rec);
    } else if (f.endsWith(".transcript")) {
      const text = scrub(fs.readFileSync(p, "utf8"), map);
      transcript = { file: f, bytes: Buffer.byteLength(text), text: text.length > TRANSCRIPT_CUT ? text.slice(0, TRANSCRIPT_CUT) : text, cut: text.length > TRANSCRIPT_CUT };
    }
  }
  return { hooks, transcript };
}

const done = new Set();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, "utf8").split("\n")) if (l.trim()) done.add(JSON.parse(l).id);
const todo = CASES.filter((c) => (!ONLY || ONLY.includes(c.id)) && !done.has(c.id));
console.log(`${SET}: ${todo.length} session(s) to capture (${done.size} already in ${path.relative(ROOT, OUT)}), agent ${AGENT_VERSION}, model ${MODEL}`);

for (const c of todo) {
  // A neutral folder name: an agent given the shell will look around, and a name that says jevmem or the case id would
  // point it at this repository, its sets and its labels (one dev run found them that way and read the dev cases file).
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const proj = path.join(scratch, c.project);
  const capture = path.join(scratch, "capture");
  fs.cpSync(projectDir(c.project), proj, { recursive: true });
  fs.mkdirSync(path.join(proj, ".cursor"), { recursive: true });
  const hooks = {};
  for (const e of EVENTS) hooks[e] = [{ command: `sh "${HOOK}" ${e} "${capture}"` }];
  fs.writeFileSync(path.join(proj, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks }, null, 2) + "\n");
  git(proj, ["init", "-q"]);
  git(proj, ["add", "-A"]);
  git(proj, ["commit", "-q", "-m", "initial"]);
  // Both spellings of the temp folder (macOS gives /var/folders/…, which is /private/var/folders/… once resolved).
  const map = [proj, capture, HOOK, scratch].flatMap((p) => [[`/private${p}`, null], [p, null]]).map(([p]) => [p, p.startsWith(`/private${proj}`) || p === proj ? "<project>" : p.includes("capture") ? "<capture>" : p.includes("log.sh") ? "<hook>" : "<scratch>"]).concat([[`/private${os.tmpdir().replace(/\/$/, "")}`, "<tmp>"], [os.tmpdir().replace(/\/$/, ""), "<tmp>"], [os.homedir(), "<home>"], [os.userInfo().username, "<user>"]]);
  const row = { row: "session", set: SET, id: c.id, project: c.project, prompts: c.prompts, labels: c.labels, agent_cli: AGENT_VERSION, model_requested: MODEL, cursor_version: null, model_named: null, captured_at: new Date().toISOString(), runs: [] };
  let sid = null;
  for (let i = 0; i < c.prompts.length; i++) {
    const argv = ["-p", "--trust", "--force", "--output-format", "stream-json", "--model", MODEL, ...(sid ? [`--resume=${sid}`] : []), c.prompts[i]];
    const seen = new Set(fs.existsSync(capture) ? fs.readdirSync(capture) : []);
    const r = await runAgent(proj, argv);
    const s = parseStream(r.out);
    // Only this run's hook files.
    const runDir = path.join(scratch, `run${i}`);
    fs.mkdirSync(runDir);
    for (const f of fs.existsSync(capture) ? fs.readdirSync(capture) : []) if (!seen.has(f)) fs.renameSync(path.join(capture, f), path.join(runDir, f));
    const h = readHooks(runDir, map);
    const first = h.hooks.find((x) => x.payload && typeof x.payload === "object");
    row.cursor_version ??= first?.payload?.cursor_version ?? null;
    const cursorVersionOfRun = first?.payload?.cursor_version ?? null;
    row.model_named ??= first?.payload?.model_id ?? first?.payload?.model ?? null;
    if (!sid) sid = s.init?.session_id ?? s.result?.session_id ?? first?.payload?.conversation_id ?? null;
    const changed = (() => {
      try {
        return git(proj, ["status", "--porcelain"]).trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    })();
    row.runs.push({
      i,
      prompt: c.prompts[i],
      argv: argv.map((a) => scrub(a, map)),
      exit: r.code,
      signal: r.signal,
      seconds: Number(r.seconds.toFixed(1)),
      session_id: s.init?.session_id ?? null,
      cursor_version: cursorVersionOfRun,
      init: s.init ? JSON.parse(scrub(JSON.stringify(s.init), map)) : null,
      model_served: s.init?.model ?? null,
      assistant_texts: s.assistant.map((t) => scrub(t, map)),
      tool_calls: s.tools,
      result_text: s.result?.result != null ? scrub(String(s.result.result), map) : null,
      result: s.result ? { subtype: s.result.subtype, is_error: s.result.is_error, duration_ms: s.result.duration_ms, session_id: s.result.session_id } : null,
      stderr: scrub(r.err, map).slice(0, 4000),
      stream_events: s.events.length,
      files_changed: changed,
      hooks: h.hooks,
      stop_transcript: h.transcript,
    });
    console.log(`  ${c.id} run ${i + 1}/${c.prompts.length}: exit ${r.code}${r.signal ? " " + r.signal : ""}, ${r.seconds.toFixed(1)} s, ${h.hooks.length} hook payload(s) [${[...new Set(h.hooks.map((x) => x.tag))].join(" ")}], ${s.assistant.length} assistant event(s), ${s.tools.length} tool call(s)${s.result ? "" : ", NO RESULT EVENT"}`);
    if (i < c.prompts.length - 1) git(proj, ["add", "-A"]), git(proj, ["commit", "-q", "--allow-empty", "-m", `after prompt ${i + 1}`]);
  }
  fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
  console.log(`${c.id}: written (${row.runs.length} run(s), model named ${row.model_named}, cursor ${row.cursor_version}); scratch kept at ${scratch}`);
}
console.log("done");
