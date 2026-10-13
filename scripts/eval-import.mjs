#!/usr/bin/env node
// `jevmem import --from sessions` (0.7.1) on captured sessions: what the import proposes from each real Claude Code
// session, against what each turn was labelled to give. eval/import-dev-sessions.jsonl (tuned on) and
// eval/import-heldout-sessions.jsonl (run once on the build that ships) hold sessions captured with
// scripts/capture-stops.mjs from the cases in eval/import/.
//
//   node scripts/eval-import.mjs [path/to/dist/index.js] --set dev|heldout [--only id,id] [--out results/…json]
//
// Each session is written to disk as Claude Code keeps it: the transcript as it was at the session's last Stop (the
// capture keeps every user and assistant entry with the fields that mark a prompt's origin), plus the main agent's
// final text as one more assistant entry (Claude Code writes it after the Stop hook; the capture holds it in the
// payload's last_assistant_message), under <home>/.claude/projects/<slug>/<session>.jsonl for a scratch project at
// <slug>. The build's own reader and import then run on it (findSessionFiles, importSessions with apply), with the real
// Jev (cache off) and jevmem's own writer. Scored per labelled turn: the turn was read (one turn per prompt, so the
// sidechains, notifications and tool results were skipped); save/skip right; kind right; the line carries one of the
// label's words; a labelled reversal supersedes the line of the turn it reverses. Precision: lines added from turns
// labelled save, over lines added. Recall: turns labelled save with a line added, over turns labelled save.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const distArg = args[0] && !args[0].startsWith("--") ? args[0] : path.resolve("dist/index.js");
const SET = opt("--set", "dev");
const FILE = opt("--file", null) ?? { dev: "eval/import-dev-sessions.jsonl", heldout: "eval/import-heldout-sessions.jsonl" }[SET];
if (!FILE) throw new Error(`unknown --set ${SET}`);
const ONLY = opt("--only", null)?.split(",") ?? null;
const OUT = opt("--out", null);
const USD_PER_M_INPUT = 0.042;
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const lib = await import(pathToFileURL(path.resolve(distArg)).href);
if (typeof lib.importSessions !== "function") throw new Error(`${distArg} has no importSessions (a build before 0.7.1)`);
const sessions = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((s) => !ONLY || ONLY.includes(s.id));
let commit = null;
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src", { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {}
let version = null;
for (let d = path.dirname(path.resolve(distArg)); d !== path.dirname(d); d = path.dirname(d)) {
  const p = path.join(d, "package.json");
  if (fs.existsSync(p)) {
    const pj = JSON.parse(fs.readFileSync(p, "utf8"));
    if (pj.name === "jevmem") { version = pj.version; break; }
  }
}
const meta = { kind: "import-sessions", set: SET, file: FILE, date: new Date().toISOString().slice(0, 10), commit, jevmem_version: version, dist: path.relative(process.cwd(), path.resolve(distArg)), sessions: sessions.length, claude_code: [...new Set(sessions.map((s) => s.claude_code))].join(", "), served_by: [...new Set(sessions.flatMap((s) => s.served_by))].join(", "), cost_method: `input tokens × $${USD_PER_M_INPUT}/M` };

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
const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** The session file as Claude Code leaves it: the last Stop's transcript, then the final assistant text as an entry. */
function sessionLines(s, root) {
  const last = s.stops.at(-1);
  const entries = place(last.transcript, [["<project>", root]]);
  const finalText = last.payload.last_assistant_message;
  const lastAssistant = [...entries].reverse().find((e) => e.type === "assistant" && !e.isSidechain);
  const lastText = Array.isArray(lastAssistant?.message?.content) ? lastAssistant.message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "";
  if (finalText && squash(lastText) !== squash(finalText)) entries.push({ type: "assistant", uuid: `final-${s.id}`, parentUuid: lastAssistant?.uuid ?? null, isSidechain: false, timestamp: last.captured_at, message: { role: "assistant", content: [{ type: "text", text: finalText }] } });
  return entries.map((e) => JSON.stringify(e));
}

const results = [];
const jev = lib.createJev({ noLogFile: true, cache: false });
for (const s of sessions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-import-eval-home-"));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `jevmem-import-eval-${s.project}-`)));
  lib.init({ root, hooks: false });
  fs.writeFileSync(path.join(root, "jevmem.config.json"), JSON.stringify({ jev: { cache: false } }, null, 2) + "\n");
  const slug = lib.projectSlug(root);
  const dir = path.join(home, ".claude", "projects", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${s.id}.jsonl`), sessionLines(s, root).join("\n") + "\n");
  const store = new lib.MemoryStore(root);
  const cfg = lib.loadConfig(root);
  const found = lib.findSessionFiles(root, { home, env: {} });
  const file = found.files[0];
  const at = jev.log.length;
  const t0 = performance.now();
  let rows = [];
  let error = null;
  try {
    rows = file ? await lib.importSessions(jev, store, cfg, found.files, { apply: true }) : [];
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  const ms = Math.round(performance.now() - t0);
  const calls = jev.log.slice(at);
  const tokens = calls.filter((e) => e.ok).reduce((a, e) => a + (e.inputTokens ?? 0), 0);
  const turns = s.labels.map((label, i) => {
    const t = file?.turns[i] ?? null;
    const row = rows.find((r) => r.turn?.n === i + 1) ?? null;
    const added = row?.outcome === "add";
    const saveRight = label.save ? added : !added;
    const kindRight = saveRight && (!label.save || row.kind === label.kind);
    const has = label.save && added ? (label.has ?? []).some((w) => row.text.toLowerCase().includes(String(w).toLowerCase())) : null;
    let supersedesRight = null;
    if (label.supersedes !== undefined) {
      const earlier = rows.find((r) => r.turn?.n === label.supersedes + 1);
      supersedesRight = Boolean(added && earlier?.outcome === "add" && row.supersedes && (row.supersedes === earlier.savedId || row.supersedes === `row${rows.indexOf(earlier)}`));
    }
    return { n: i + 1, prompt: s.prompts[i], label, read: Boolean(t), user_chars: t?.user.length ?? 0, assistant_chars: t?.assistant.length ?? 0, outcome: row?.outcome ?? "(no row)", kind: row?.kind ?? null, line: row?.text ?? null, always: row?.always ?? null, supersedes: row?.supersedes ?? null, reason: String(row?.reason ?? "").slice(0, 160), save_right: saveRight, kind_right: kindRight, has_word: has, supersedes_right: supersedesRight };
  });
  const r = { id: s.id, project: s.project, mode: s.mode, served_by: s.served_by, error, file: file ? { turns: file.turns.length, entries: file.entries, sidechain_entries: file.sidechainEntries, bad_lines: file.badLines, versions: file.versions } : null, skipped: found.skipped, suspect: found.suspect, turns_read: file?.turns.length ?? 0, turns_labelled: s.labels.length, rows: rows.length, lines_added: rows.filter((x) => x.outcome === "add").length, jev_calls: calls.length, jev_input_tokens: tokens, cost_usd: (tokens / 1e6) * USD_PER_M_INPUT, ms, turns };
  results.push(r);
  for (const t of turns) process.stderr.write(`${s.id.padEnd(24)} ${s.mode.padEnd(10)} turn ${t.n}: ${t.label.save ? `save ${t.label.kind}` : "skip"} → ${t.outcome === "add" ? `[${t.kind}] ${String(t.line).slice(0, 80)}` : t.outcome}${t.save_right ? "" : "  (save/skip wrong)"}${t.has_word === false ? "  (line lacks the labelled words)" : ""}${t.supersedes_right === false ? "  (reversal did not supersede)" : ""}\n`);
  if (error) process.stderr.write(`${s.id}: ERROR ${error}\n`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
const turns = results.flatMap((r) => r.turns);
const saves = turns.filter((t) => t.label.save);
const added = turns.filter((t) => t.outcome === "add");
const frac = (a, b) => `${a}/${b}`;
const summary = {
  sessions: results.length,
  sessions_read_whole: frac(results.filter((r) => r.turns_read === r.turns_labelled).length, results.length),
  turns: turns.length,
  turns_read: frac(turns.filter((t) => t.read).length, turns.length),
  save_skip_right: frac(turns.filter((t) => t.save_right).length, turns.length),
  save_kind_right: frac(turns.filter((t) => t.kind_right).length, turns.length),
  lines_with_labelled_words: frac(saves.filter((t) => t.has_word === true).length, saves.filter((t) => t.outcome === "add").length),
  reversals_superseded: frac(turns.filter((t) => t.supersedes_right === true).length, turns.filter((t) => t.label.supersedes !== undefined).length),
  precision: frac(added.filter((t) => t.label.save).length, added.length),
  recall: frac(saves.filter((t) => t.outcome === "add").length, saves.length),
  skip_turns_given_a_line: frac(turns.filter((t) => !t.label.save && t.outcome === "add").length, turns.filter((t) => !t.label.save).length),
  lines_marked_always_on: added.filter((t) => t.always).length,
  by_mode: Object.fromEntries(["none", "background", "foreground"].map((m) => [m, { sessions: results.filter((r) => r.mode === m).length, turns_read: frac(results.filter((r) => r.mode === m).reduce((a, r) => a + r.turns_read, 0), results.filter((r) => r.mode === m).reduce((a, r) => a + r.turns_labelled, 0)), save_skip_right: frac(results.filter((r) => r.mode === m).flatMap((r) => r.turns).filter((t) => t.save_right).length, results.filter((r) => r.mode === m).flatMap((r) => r.turns).length) }])),
  sidechain_entries_skipped: results.reduce((a, r) => a + (r.file?.sidechain_entries ?? 0), 0),
  entry_types_seen: results.reduce((acc, r) => { for (const [k, v] of Object.entries(r.file?.entries ?? {})) acc[k] = (acc[k] ?? 0) + v; return acc; }, {}),
  jev_calls_per_turn: turns.length ? results.reduce((a, r) => a + r.jev_calls, 0) / turns.length : null,
  cost_per_turn_usd: turns.length ? results.reduce((a, r) => a + r.cost_usd, 0) / turns.length : null,
  ms_per_turn: turns.length ? results.reduce((a, r) => a + r.ms, 0) / turns.length : null,
  errors: results.filter((r) => r.error).length,
};
console.log(`${FILE} (${version ?? "?"} ${commit}): turns read ${summary.turns_read}, save/skip right ${summary.save_skip_right}, save+kind ${summary.save_kind_right}, lines with the labelled words ${summary.lines_with_labelled_words}, reversals superseded ${summary.reversals_superseded}, precision ${summary.precision}, recall ${summary.recall}, skip turns given a line ${summary.skip_turns_given_a_line}, always-on marks ${summary.lines_marked_always_on}; ${summary.jev_calls_per_turn?.toFixed(2)} calls, $${summary.cost_per_turn_usd?.toFixed(6)}, ${Math.round(summary.ms_per_turn)} ms per turn`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ ...meta, summary, results }, null, 1) + "\n");
