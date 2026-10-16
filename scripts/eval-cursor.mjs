#!/usr/bin/env node
// Automatic saving in Cursor (0.7.4) on captured sessions: what jevmem's Cursor hooks make of each real session,
// against what each turn was labelled to give. eval/cursor-dev-sessions.jsonl (tuned on, if at all) and
// eval/cursor-heldout-sessions.jsonl (run once on the build that ships) hold sessions captured with
// scripts/capture-cursor.mjs from the cases in eval/cursor/, through Cursor's `agent` CLI; eval/cursor/<set>.pairing.json
// holds each turn's pair as the CLI itself reported it (scripts/cursor-pairing-labels.mjs).
//
//   node scripts/eval-cursor.mjs [path/to/dist/cli.js] --set dev|heldout [--only id,id] [--out results/…json]
//
// Each run of a session is replayed as Cursor's CLI ends it: the transcript as it was at that run's sessionEnd is
// written to a file, and the real sessionEnd payload (with that path) goes to the built CLI's `jevmem hook --cursor`
// in a scratch project (daemon off, so the turn is decided before the hook exits), with the real Jev (cache off) and
// jevmem's own writer; the app's stop hook reads the same transcript the same way. Two measures. Pairing: the turn the
// reader gives for that run equals the pair the CLI reported (the prompt without Cursor's wrappers; the assistant text
// of the run, its messages joined by blank lines), after whitespace is squashed; no tool output in it, no earlier turn
// merged, no turn lost. Decide: save/skip right, kind right, the line carries one of the label's words, a labelled
// reversal supersedes the line of the turn it reverses; precision and recall as the import measure counts them. A run
// whose hooks name this repository (an agent with the shell read beyond its copy) is reported but not counted for
// decide; a turn labelled interrupted expects no decision and an unfinished pair.
import { spawnSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const cliArg = args[0] && !args[0].startsWith("--") ? args[0] : path.resolve("dist/cli.js");
const SET = opt("--set", "dev");
const FILE = opt("--file", null) ?? { dev: "eval/cursor-dev-sessions.jsonl", heldout: "eval/cursor-heldout-sessions.jsonl" }[SET];
const PAIRS = opt("--pairs", null) ?? { dev: "eval/cursor/dev.pairing.json", heldout: "eval/cursor/heldout.pairing.json" }[SET];
if (!FILE) throw new Error(`unknown --set ${SET}`);
const ONLY = opt("--only", null)?.split(",") ?? null;
const OUT = opt("--out", null);
const USD_PER_M_INPUT = 0.042;
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const distDir = path.dirname(path.resolve(cliArg));
const lib = await import(pathToFileURL(path.join(distDir, "index.js")).href);
if (typeof lib.readCursorTranscript !== "function") throw new Error(`${distDir}/index.js has no readCursorTranscript (a build before 0.7.4)`);
const sessions = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((s) => !ONLY || ONLY.includes(s.id));
// The labels come from the cases file when it is there (a label can change after the capture: a run cut short is
// relabelled interrupted); the row's copy is the fallback.
const CASES_FILE = opt("--cases", null) ?? { dev: "eval/cursor/dev.cases.mjs", heldout: "eval/cursor/heldout.cases.mjs" }[SET];
if (CASES_FILE && fs.existsSync(CASES_FILE)) {
  const { CASES } = await import(pathToFileURL(path.resolve(CASES_FILE)).href);
  for (const s of sessions) {
    const c = CASES.find((x) => x.id === s.id);
    if (c) s.labels = c.labels;
  }
}
const pairs = fs.existsSync(PAIRS) ? JSON.parse(fs.readFileSync(PAIRS, "utf8")).pairs : [];
let commit = null;
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src hooks", { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {}
let version = null;
for (let d = distDir; d !== path.dirname(d); d = path.dirname(d)) {
  const p = path.join(d, "package.json");
  if (fs.existsSync(p)) {
    const pj = JSON.parse(fs.readFileSync(p, "utf8"));
    if (pj.name === "jevmem") { version = pj.version; break; }
  }
}
const meta = { kind: "cursor-sessions", set: SET, file: FILE, pairs: PAIRS, date: new Date().toISOString().slice(0, 10), commit, jevmem_version: version, cli: path.relative(process.cwd(), path.resolve(cliArg)), sessions: sessions.length, agent_cli: [...new Set(sessions.flatMap((s) => s.runs.map((r) => r.cursor_version ?? s.cursor_version)))].join(", "), model: [...new Set(sessions.flatMap((s) => s.runs.map((r) => r.model_served)))].join(", "), cost_method: `input tokens × $${USD_PER_M_INPUT}/M` };
const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const tight = (s) => String(s ?? "").replace(/\s+/g, "");
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const results = [];
for (const s of sessions) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `jevmem-cursor-eval-${s.project}-`)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-cursor-eval-home-"));
  lib.init({ root, hooks: false });
  fs.writeFileSync(path.join(root, "jevmem.config.json"), JSON.stringify({ jev: { cache: false } }, null, 2) + "\n");
  const tdir = path.join(home, "transcripts");
  fs.mkdirSync(tdir);
  const turns = [];
  let error = null;
  const t0 = performance.now();
  for (const run of s.runs) {
    const i = run.i;
    const label = s.labels[i];
    // A run whose hooks name this repository read beyond its scratch copy (an agent with the shell can): its decide
    // result is reported but not counted, since it may have seen the labels. An interrupted label expects no decision.
    const contaminated = run.hooks.some((h) => /<home>\/jevmem/.test(JSON.stringify(h.payload ?? {})));
    const interrupted = Boolean(label.interrupted);
    const pair = pairs.find((p) => p.id === s.id && p.run === i) ?? null;
    const sid = run.session_id ?? s.runs[0]?.session_id ?? s.id;
    const transcriptText = run.stop_transcript?.text ?? null;
    const tfile = path.join(tdir, `${sid}.jsonl`);
    if (transcriptText) fs.writeFileSync(tfile, transcriptText.split("<project>").join(root));
    // Pairing: what the reader gives for this run's turn.
    const read = transcriptText ? lib.readCursorTranscript(tfile) : [];
    const mine = read[i] ?? null;
    const userRight = Boolean(mine) && squash(mine.user) === squash(run.prompt);
    // The pair's assistant text: the CLI's assistant events joined, or its result text (every delta joined with nothing
    // between), whitespace aside: the result carries the reply to a follow-up Cursor submitted itself, the events may not.
    const assistantRight = Boolean(mine) && Boolean(pair) && (tight(mine.assistant) === tight(pair.assistant) || (pair.result != null && tight(mine.assistant) === tight(pair.result)));
    const ended = Boolean(mine?.ended);
    const extra = read.length - (i + 1);
    // Decide: the real sessionEnd payload for this run.
    const end = run.hooks.find((h) => h.tag === "sessionEnd")?.payload ?? { hook_event_name: "sessionEnd", reason: "completed" };
    const payload = { ...end, conversation_id: sid, session_id: sid, workspace_roots: [root], transcript_path: transcriptText ? tfile : null };
    const before = readJsonl(path.join(root, ".jevmem", "decisions.jsonl")).length;
    const t1 = performance.now();
    const r = spawnSync(process.execPath, [cliArg, "hook", "--cursor"], { cwd: root, env: { ...process.env, HOME: home, JEVMEM_DAEMON: "0", JEVMEM_WRITER: "none", JEVMEM_CACHE: "0", CLAUDE_PROJECT_DIR: root, CURSOR_PROJECT_DIR: root }, input: JSON.stringify(payload), encoding: "utf8", timeout: 120_000 });
    const ms = Math.round(performance.now() - t1);
    if (r.status !== 0) error = `run ${i}: hook exit ${r.status}: ${String(r.stderr).slice(0, 200)}`;
    const decs = readJsonl(path.join(root, ".jevmem", "decisions.jsonl")).slice(before);
    const dec = decs.at(-1) ?? null;
    const store = new lib.MemoryStore(root);
    const all = store.list();
    const saved = dec?.memoryId ? all.find((m) => m.id === dec.memoryId) ?? null : null;
    const added = Boolean(dec?.decision?.save && dec?.memoryId);
    const saveRight = interrupted ? decs.length === 0 : label.save ? added : !added;
    const kindRight = saveRight && (!label.save || (saved?.kind ?? dec?.decision?.kind) === label.kind);
    const has = label.save && added ? (label.has ?? []).some((w) => String(saved?.text ?? "").toLowerCase().includes(String(w).toLowerCase())) : null;
    let supersedesRight = null;
    if (label.supersedes !== undefined) {
      // The decision names the line it supersedes; the store then tags that line [superseded] (it leaves the live list).
      const earlier = turns[label.supersedes];
      supersedesRight = Boolean(added && earlier?.outcome === "add" && earlier.memory_id && dec?.decision?.contradiction && dec.decision.touchesMemoryId === earlier.memory_id);
    }
    const log = readJsonl(path.join(root, ".jevmem", "log.jsonl"));
    const calls = log.filter((e) => e.label && e.ok !== undefined);
    turns.push({ n: i + 1, prompt: run.prompt, label, contaminated, interrupted, transcript: Boolean(transcriptText), turns_in_transcript: read.length, read: Boolean(mine), ended, extra_turns: extra, user_right: userRight, assistant_right: assistantRight, assistant_read: mine?.assistant ?? null, assistant_expected: pair?.assistant ?? null, decided: decs.length, outcome: added ? "add" : dec ? "skip" : "(no decision)", kind: saved?.kind ?? dec?.decision?.kind ?? null, line: saved?.text ?? null, memory_id: dec?.memoryId ?? null, always: saved?.always ?? null, reason: dec ? `importance ${dec.decision.importance}${dec.decision.duplicateOf ? ", duplicate of " + dec.decision.duplicateOf : ""}${dec.decision.contradiction ? ", supersedes " + dec.decision.touchesMemoryId : ""}` : null, save_right: saveRight, kind_right: kindRight, has_word: has, supersedes_right: supersedesRight, hook_ms: ms, log_entries: log.length });
    process.stderr.write(`${s.id.padEnd(24)} turn ${i + 1}:${contaminated ? " CONTAMINATED (read this repository; not counted)" : ""}${interrupted ? " interrupted" : ""} pair ${userRight && assistantRight ? "ok" : `WRONG (user ${userRight}, assistant ${assistantRight})`}${ended ? "" : " not ended"}${extra ? ` extra ${extra}` : ""}; ${label.save ? `save ${label.kind}` : "skip"} → ${added ? `[${saved?.kind}] ${String(saved?.text).slice(0, 80)}` : turns.at(-1).outcome}${saveRight ? "" : "  (save/skip wrong)"}${has === false ? "  (line lacks the labelled words)" : ""}${supersedesRight === false ? "  (reversal did not supersede)" : ""}\n`);
  }
  const ms = Math.round(performance.now() - t0);
  const log = readJsonl(path.join(root, ".jevmem", "log.jsonl"));
  const tokens = log.reduce((a, e) => a + (e.inputTokens ?? e.tokens?.input ?? 0), 0);
  results.push({ id: s.id, project: s.project, agent_cli: [...new Set(s.runs.map((r) => r.cursor_version ?? s.cursor_version))].join(", "), model: [...new Set(s.runs.map((r) => r.model_served))].join(", "), error, turns_labelled: s.labels.length, turns, jev_input_tokens: tokens, cost_usd: (tokens / 1e6) * USD_PER_M_INPUT, ms });
  if (error) process.stderr.write(`${s.id}: ERROR ${error}\n`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
const turns = results.flatMap((r) => r.turns);
const clean = turns.filter((t) => !t.contaminated);
const saves = clean.filter((t) => t.label.save);
const added = clean.filter((t) => t.outcome === "add");
const frac = (a, b) => `${a}/${b}`;
const summary = {
  sessions: results.length,
  turns: turns.length,
  turns_with_transcript: frac(turns.filter((t) => t.transcript).length, turns.length),
  turns_paired_whole: frac(turns.filter((t) => t.user_right && t.assistant_right && (t.interrupted ? !t.ended : t.ended) && t.extra_turns === 0).length, turns.length),
  interrupted_turns: turns.filter((t) => t.interrupted).length,
  contaminated_turns: turns.filter((t) => t.contaminated).length,
  user_right: frac(turns.filter((t) => t.user_right).length, turns.length),
  assistant_right: frac(turns.filter((t) => t.assistant_right).length, turns.length),
  turns_ended: frac(turns.filter((t) => t.ended).length, turns.length),
  turns_decided_once: frac(turns.filter((t) => t.decided === 1).length, turns.length),
  save_skip_right: frac(clean.filter((t) => t.save_right).length, clean.length),
  save_kind_right: frac(clean.filter((t) => t.kind_right).length, clean.length),
  lines_with_labelled_words: frac(saves.filter((t) => t.has_word === true).length, saves.filter((t) => t.outcome === "add").length),
  reversals_superseded: frac(clean.filter((t) => t.supersedes_right === true).length, clean.filter((t) => t.label.supersedes !== undefined).length),
  precision: frac(added.filter((t) => t.label.save).length, added.length),
  recall: frac(saves.filter((t) => t.outcome === "add").length, saves.length),
  skip_turns_given_a_line: frac(clean.filter((t) => !t.label.save && t.outcome === "add").length, clean.filter((t) => !t.label.save).length),
  lines_marked_always_on: added.filter((t) => t.always).length,
  hook_ms_p50: turns.map((t) => t.hook_ms).sort((a, b) => a - b)[Math.floor(turns.length / 2)] ?? null,
  cost_per_turn_usd: turns.length ? results.reduce((a, r) => a + r.cost_usd, 0) / turns.length : null,
  errors: results.filter((r) => r.error).length,
};
console.log(`${FILE} (${version ?? "?"} ${commit}): paired whole ${summary.turns_paired_whole}, save/skip right ${summary.save_skip_right}, save+kind ${summary.save_kind_right}, lines with the labelled words ${summary.lines_with_labelled_words}, reversals superseded ${summary.reversals_superseded}, precision ${summary.precision}, recall ${summary.recall}, skip turns given a line ${summary.skip_turns_given_a_line}; hook p50 ${summary.hook_ms_p50} ms, $${summary.cost_per_turn_usd?.toFixed(6)} per turn`);
if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({ meta, summary, sessions: results }, null, 2) + "\n");
  console.log(`-> ${OUT}`);
}
