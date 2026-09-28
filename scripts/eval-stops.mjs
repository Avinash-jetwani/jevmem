#!/usr/bin/env node
// The Stop hook on real transcripts (v0.6 part 3b): what each build saves from sessions captured with
// scripts/capture-stops.mjs, and whether it decided a turn while that turn was still running.
//
//   node scripts/eval-stops.mjs --set heldout-v4|dev [--build <label>=<package dir> ...] [--only id,id] [--date YYYY-MM-DD]
//
// For each session and build: a scratch project (`init` without hooks, an empty JEVMEM.md, jev.cache off), and each
// captured Stop in order: the transcript as it was when the hook ran is written to one file (the same file for the whole
// session, as Claude Code keeps it), the Stop payload is pointed at it, and the build's real hook runs on it
// (`node <pkg>/dist/cli.js hook`, JEVMEM_DAEMON=0 so the turn is decided before the hook exits). After each Stop the
// harness reads what was decided (.jevmem/decisions.jsonl), what JEVMEM.md gained, and the Jev calls (.jevmem/log.jsonl).
//
// A turn is one prompt: every Stop before the last one of a prompt's run came while that turn was still running (in
// `claude -p` the prompt's run ends when the turn does). So, per build:
//   decided while running   Stops before the turn's last one at which the build decided something, and the lines it
//                           saved there; must be 0
//   turns                   per labelled turn: the lines saved while it ran; save/skip is right when a save label got
//                           at least one line and a skip label none; kind is right when, in addition, a saved line has the
//                           label's kind; more than one line for a turn is counted apart
//   from a notification     lines decided from a task notification read as the user's message (the turn text
//                           jevmem decided starts with "USER: <task-notification>"); must be 0
//   decide calls            Jev decide calls per turn (each Stop decided costs one or two)
// With two or more builds, every session goes to each build in turn, the order alternating, so they meet the same
// moments of the Jev API.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const all = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));
const SET = opt("--set", "dev");
const FILE = opt("--file", `eval/stops-${SET}.jsonl`);
const ONLY = opt("--only", null)?.split(",") ?? null;
const DATE = opt("--date", new Date().toISOString().slice(0, 10));
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");

const buildArgs = all("--build").map((b) => {
  const i = b.indexOf("=");
  return { label: b.slice(0, i), pkg: path.resolve(b.slice(i + 1)) };
});
if (!buildArgs.length) buildArgs.push({ label: opt("--label", "now"), pkg: path.resolve(opt("--pkg", ".")) });
const builds = [];
for (const b of buildArgs) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(b.pkg, "package.json"), "utf8"));
  let commit = null;
  try {
    if (b.pkg === path.resolve(".")) commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() + (execFileSync("git", ["status", "--porcelain", "src"], { encoding: "utf8" }).trim() ? "+dirty" : "");
  } catch {
    /* not a checkout */
  }
  builds.push({ ...b, cli: path.join(b.pkg, "dist", "cli.js"), lib: await import(pathToFileURL(path.join(b.pkg, "dist", "index.js")).href), version: pkgJson.version, commit, out: opt("--out", null) && buildArgs.length === 1 ? opt("--out") : `results/stops-${SET}-${DATE}-${b.label}.json`, results: [] });
}

const sessions = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((s) => !ONLY || ONLY.includes(s.id));

const readJsonl = (f) => {
  try {
    return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const liveLines = (b, root) => new b.lib.MemoryStore(root).list().filter((m) => m.kind !== "superseded" && !m.supersededBy);

function place(v, map) {
  if (typeof v === "string") {
    let s = v;
    for (const [from, to] of map) s = s.split(from).join(to);
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => place(x, map));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, place(x, map)]));
  return v;
}

function runHook(b, root, home, payload) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: home, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, CLAUDE_PROJECT_DIR: root, JEVMEM_DAEMON: "0", JEVMEM_VERBOSE: "1" };
    if (process.env.TYPESAFE_BASE_URL) env.TYPESAFE_BASE_URL = process.env.TYPESAFE_BASE_URL;
    const t0 = performance.now();
    const child = spawn(process.execPath, [b.cli, "hook"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err, ms: Math.round(performance.now() - t0) }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function replay(b, s) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-stops-eval-")));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-stops-eval-home-"));
  b.lib.init({ root, hooks: false });
  fs.writeFileSync(path.join(root, "jevmem.config.json"), JSON.stringify({ jev: { cache: false } }, null, 2) + "\n");
  const transcript = path.join(home, "transcripts", `${s.id}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const map = [["<project>", root]];
  const lastStopOfRun = new Map();
  s.stops.forEach((st, i) => lastStopOfRun.set(st.run, i));
  const stops = [];
  for (const [i, st] of s.stops.entries()) {
    fs.writeFileSync(transcript, place(st.transcript, map).map((e) => JSON.stringify(e)).join("\n") + "\n");
    const payload = { ...place(st.payload, map), transcript_path: transcript, cwd: root };
    const before = { decisions: readJsonl(path.join(root, ".jevmem", "decisions.jsonl")).length, log: readJsonl(path.join(root, ".jevmem", "log.jsonl")).length, lines: new Set(liveLines(b, root).map((m) => m.id)) };
    const r = await runHook(b, root, home, payload);
    const decisions = readJsonl(path.join(root, ".jevmem", "decisions.jsonl")).slice(before.decisions);
    const log = readJsonl(path.join(root, ".jevmem", "log.jsonl")).slice(before.log);
    const saved = liveLines(b, root).filter((m) => !before.lines.has(m.id));
    stops.push({
      stop: i,
      run: st.run,
      mid_turn: lastStopOfRun.get(st.run) !== i,
      background_running: (st.payload.background_tasks ?? []).filter((t) => t.status === "running").map((t) => t.type),
      decided: decisions.length,
      decisions: decisions.map((d) => ({ save: d.decision?.save ?? null, kind: d.decision?.kind ?? null, reason: String(d.decision?.reason ?? "").slice(0, 160), memoryId: d.memoryId ?? null, from_notification: /^USER:\s*<task-notification>/.test(String(d.message ?? "")) })),
      saved: saved.map((m) => ({ id: m.id, kind: m.kind, text: m.text })),
      decide_calls: log.filter((e) => e.label === "decide" && !e.event).length,
      jev_input_tokens: log.filter((e) => !e.event && e.ok).reduce((a, e) => a + (e.inputTokens ?? 0), 0),
      jev_failed: log.filter((e) => !e.event && e.ok === false).length,
      hook_ms: r.ms,
      hook_detail: (r.err.match(/jevmem: (.*)/)?.[1] ?? r.err.trim().split("\n").at(-1) ?? "").slice(0, 240),
    });
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  const turns = s.labels.map((label, run) => {
    const mine = stops.filter((x) => x.run === run);
    const lines = mine.flatMap((x) => x.saved);
    const saveRight = label.save ? lines.length > 0 : lines.length === 0;
    return {
      run,
      prompt: s.prompts[run],
      label,
      stops: mine.length,
      lines,
      save_right: saveRight,
      kind_right: saveRight && (!label.save || lines.some((l) => l.kind === label.kind)),
      extra_lines: Math.max(0, lines.length - 1),
      decided_while_running: mine.filter((x) => x.mid_turn && x.decided > 0).length,
      lines_while_running: mine.filter((x) => x.mid_turn).reduce((a, x) => a + x.saved.length, 0),
      lines_from_notification: mine.reduce((a, x) => a + x.decisions.filter((d) => d.from_notification && d.memoryId && x.saved.some((l) => l.id === d.memoryId)).length, 0),
      decide_calls: mine.reduce((a, x) => a + x.decide_calls, 0),
      jev_input_tokens: mine.reduce((a, x) => a + x.jev_input_tokens, 0),
      jev_failed: mine.reduce((a, x) => a + x.jev_failed, 0),
    };
  });
  return { id: s.id, mode: s.mode, project: s.project, stops, turns };
}

for (const [k, s] of sessions.entries()) {
  const order = builds.map((_, j) => j);
  if (k % 2) order.reverse();
  for (const j of order) {
    const r = await replay(builds[j], s);
    builds[j].results.push(r);
    for (const t of r.turns) process.stderr.write(`${(builds[j].label ?? "").padEnd(6)} ${s.id.padEnd(22)} ${s.mode.padEnd(10)} turn ${t.run}: ${t.label.save ? `save ${t.label.kind}` : "skip"} → ${t.lines.map((l) => `[${l.kind}] ${l.text.slice(0, 70)}`).join(" | ") || "nothing"}${t.decided_while_running ? `  DECIDED WHILE RUNNING ×${t.decided_while_running}` : ""}${t.save_right ? "" : "  (save/skip wrong)"}\n`);
  }
}

function summarize(rs) {
  const turns = rs.flatMap((r) => r.turns);
  const stops = rs.flatMap((r) => r.stops);
  const mid = stops.filter((x) => x.mid_turn);
  const frac = (a, b) => `${a}/${b}`;
  return {
    sessions: rs.length,
    turns: turns.length,
    mid_turn_stops: mid.length,
    decided_while_running_frac: frac(mid.filter((x) => x.decided > 0).length, mid.length),
    lines_saved_while_running: mid.reduce((a, x) => a + x.saved.length, 0),
    turns_with_a_line_saved_while_running: turns.filter((t) => t.lines_while_running > 0).length,
    lines_decided_from_a_notification: turns.reduce((a, t) => a + t.lines_from_notification, 0),
    save_skip_frac: frac(turns.filter((t) => t.save_right).length, turns.length),
    save_kind_frac: frac(turns.filter((t) => t.kind_right).length, turns.length),
    turns_with_more_than_one_line: turns.filter((t) => t.extra_lines > 0).length,
    lines_saved: turns.reduce((a, t) => a + t.lines.length, 0),
    decide_calls_per_turn: turns.length ? turns.reduce((a, t) => a + t.decide_calls, 0) / turns.length : null,
    jev_input_tokens_per_turn: turns.length ? turns.reduce((a, t) => a + t.jev_input_tokens, 0) / turns.length : null,
    cost_per_turn_usd: turns.length ? (turns.reduce((a, t) => a + t.jev_input_tokens, 0) / turns.length / 1e6) * 0.042 : null,
    jev_failed_calls: turns.reduce((a, t) => a + t.jev_failed, 0),
  };
}

for (const b of builds) {
  const by = (mode) => summarize(b.results.filter((r) => r.mode === mode));
  const out = {
    kind: "stops",
    set: SET,
    file: FILE,
    date: DATE,
    finished_at: new Date().toISOString(),
    jevmem_version: b.version,
    package: b.pkg === path.resolve(".") ? "this checkout (dist/ built from it)" : b.pkg.replace(os.homedir(), "~"),
    commit: b.commit,
    label: b.label,
    paired_with: builds.filter((x) => x !== b).map((x) => ({ label: x.label, version: x.version, commit: x.commit, file: x.out })),
    captured_with: [...new Set(sessions.map((s) => s.claude_code))].join(", "),
    method:
      "Each session captured from a real Claude Code session (scripts/capture-stops.mjs) is replayed Stop by Stop through the build's real hook (node <pkg>/dist/cli.js hook, JEVMEM_DAEMON=0) in a scratch project with an empty JEVMEM.md and jev.cache off, the transcript file holding what it held when that Stop fired. A turn is one prompt; a Stop before the last one of its prompt's run came while the turn was still running. save/skip is right when a save label got at least one line and a skip label none; kind is right when a saved line also has the label's kind.",
    overall: summarize(b.results),
    by_mode: { background: by("background"), foreground: by("foreground"), none: by("none") },
    rows: b.results,
  };
  fs.mkdirSync(path.dirname(b.out), { recursive: true });
  fs.writeFileSync(b.out, JSON.stringify(out, null, 2) + "\n");
  const o = out.overall;
  console.log(`${b.label} (${b.version}${b.commit ? ` ${b.commit}` : ""}), ${SET}: decided while running ${o.decided_while_running_frac} Stops (${o.lines_saved_while_running} lines), lines from a notification ${o.lines_decided_from_a_notification}, save/skip ${o.save_skip_frac}, save+kind ${o.save_kind_frac}, turns with more than one line ${o.turns_with_more_than_one_line}, ${o.decide_calls_per_turn?.toFixed(2)} decide calls/turn → ${b.out}`);
  for (const [m, v] of Object.entries(out.by_mode)) if (v.sessions) console.log(`  ${m.padEnd(10)} decided while running ${v.decided_while_running_frac.padEnd(6)} lines while running ${v.lines_saved_while_running}  from a notification ${v.lines_decided_from_a_notification}  save/skip ${v.save_skip_frac.padEnd(6)} save+kind ${v.save_kind_frac.padEnd(6)} >1 line ${v.turns_with_more_than_one_line}`);
}
