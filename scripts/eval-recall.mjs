#!/usr/bin/env node
// Retrieval eval (v0.6 part 3): does recall put the right lines in front of Claude?
//
//   node scripts/eval-recall.mjs [--pkg <package dir>] [--set dev|heldout] [--label <build>] [--tokens <openrouter model>] [--out results/…json]
//
// --pkg: a jevmem package folder with dist/cli.js and dist/index.js (default: this checkout, built). The published
// 0.5.9 is `npm install jevmem@0.5.9` into a folder, then --pkg <folder>/node_modules/jevmem.
//
// The set (eval/recall-dev.jsonl or eval/recall-heldout.jsonl) holds memory files (rows with `row: "file"`, three
// sizes) and prompts (rows with `row: "prompt"`), each prompt labelled with the lines it needs (`want`), lines that are
// fine to add (`ok`), and lines it must never get (`never`, the superseded line in a supersede case), by key.
//
// For each memory file: a scratch project (`init` without hooks), its JEVMEM.md written in jevmem's own line format
// (superseded lines tagged `[superseded] … → id:new`), every live line recorded as written by jevmem on this machine
// (provenance: verified, so the poisoning gate asks nothing, as for a solo user after the first prompt), and
// `jev.cache: false`. Then every prompt goes through the real hook: `node <pkg>/dist/cli.js hook` with the
// UserPromptSubmit payload on stdin, as Claude Code sends it, after one warm-up prompt that starts the daemon, so each
// scored prompt is served by the warm daemon, as it is in a session. The injected lines are read from the hook's
// stdout (`(id:…, p=…)`), the Jev call's latency, input tokens and cost from .jevmem/log.jsonl, and the hook's time is
// the wall time of the hook process (spawn to exit).
//
// Reported per memory size, per prompt type and overall:
//   recall     wanted lines injected / wanted lines (prompts with wanted lines); `served` = prompts that got all of them
//   precision  injected lines that are wanted or ok / injected lines
//   unrelated  prompts of type unrelated that got any line / unrelated prompts
//   leaks      superseded lines injected (any prompt): must be 0; `never` hits likewise
//   size       lines per prompt; characters and tokens of the whole injected context (tokens counted by an Anthropic
//              model's tokenizer through OpenRouter's usage when --tokens is given and OPENROUTER_API_KEY is set; else
//              not counted)
//   latency    hook process wall time p50/p95; the Jev call's own latency p50/p95
//   cost       Jev input tokens × $0.042/M per prompt (output free)
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
const PKG = path.resolve(opt("--pkg", "."));
const SET = opt("--set", "dev");
const FILE = opt("--file", null) ?? { dev: "eval/recall-dev.jsonl", heldout: "eval/recall-heldout.jsonl" }[SET];
if (!FILE) throw new Error(`unknown --set ${SET}`);
const TOKENS_MODEL = opt("--tokens", null);
const ONLY = opt("--only", null); // a file id, for quick looks while tuning
const today = new Date().toISOString().slice(0, 10);
const LABEL = opt("--label", null);
const OUT = opt("--out", `results/recall-${SET}-${today}${LABEL ? `-${LABEL}` : ""}.json`);
const USD_PER_M_INPUT = 0.042;
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");

const CLI = path.join(PKG, "dist", "cli.js");
const lib = await import(pathToFileURL(path.join(PKG, "dist", "index.js")).href);
const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8"));
let commit = null;
try {
  if (PKG === path.resolve(".")) commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() + (execFileSync("git", ["status", "--porcelain", "src"], { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {
  /* not a checkout */
}

const rows = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const files = rows.filter((r) => r.row === "file" && (!ONLY || r.id === ONLY));
const prompts = rows.filter((r) => r.row === "prompt" && (!ONLY || r.file === ONLY));

const pctl = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** A clean environment for the hook: the key, a scratch HOME, no JEVMEM_/CLAUDE_ settings from this shell. */
function hookEnv(root, home) {
  const env = { PATH: process.env.PATH, HOME: home, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, CLAUDE_PROJECT_DIR: root, JEVMEM_VERBOSE: "1" };
  if (process.env.TYPESAFE_BASE_URL) env.TYPESAFE_BASE_URL = process.env.TYPESAFE_BASE_URL;
  return env;
}

function runHookProcess(root, home, prompt) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [CLI, "hook"], { cwd: root, env: hookEnv(root, home), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err, ms: Math.round(performance.now() - t0) }));
    child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "recall-eval", cwd: root, prompt }));
  });
}

function readLogEntries(root) {
  try {
    return fs.readFileSync(path.join(root, ".jevmem", "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** The injected memory lines from the hook's stdout: `- <[kind] | Already tried:> text (id:xxx, p=0.nn)`. */
function parseInjection(stdout) {
  const out = stdout.trim();
  if (!out) return { context: "", lines: [] };
  let context = "";
  try {
    context = JSON.parse(out).hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return { context: "", lines: [], error: `not JSON: ${out.slice(0, 120)}` };
  }
  const lines = [];
  for (const l of context.split("\n")) {
    const m = /^- (?:\[([a-z-]+)\]|Already tried:) (.*) \(id:([a-z0-9]+), p=([\d.]+)\)$/.exec(l);
    if (m) lines.push({ id: m[3], kind: m[1] ?? "dead-end", p: Number(m[4]), text: m[2], chars: l.length });
  }
  return { context, lines };
}

const tokenCache = new Map();
/** Tokens of a text as an Anthropic model counts them: prompt tokens of a one-message request minus those of ".". */
async function countTokens(text) {
  if (!TOKENS_MODEL || !process.env.OPENROUTER_API_KEY || !text) return null;
  const ask = async (content) => {
    if (tokenCache.has(content)) return tokenCache.get(content);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: TOKENS_MODEL, max_tokens: 1, messages: [{ role: "user", content }] }),
        });
        const j = await res.json();
        const n = j?.usage?.prompt_tokens;
        if (typeof n === "number") {
          tokenCache.set(content, n);
          return n;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    return null;
  };
  const [a, b] = await Promise.all([ask(text), ask(".")]);
  return a === null || b === null ? null : a - b;
}

const startedAt = new Date().toISOString();
const results = [];
for (const f of files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-recall-")));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-recall-home-"));
  lib.init({ root, hooks: false });
  fs.writeFileSync(path.join(root, "jevmem.config.json"), JSON.stringify({ jev: { cache: false } }, null, 2) + "\n");
  const byKey = new Map(f.lines.map((l) => [l.key, l]));
  const byId = new Map(f.lines.map((l) => [l.id, l]));
  const memories = f.lines.map((l) => ({ id: l.id, kind: l.kind, text: l.text, ts: l.ts, conf: l.conf, ...(l.by ? { supersededBy: byKey.get(l.by).id } : {}) }));
  fs.writeFileSync(path.join(root, "JEVMEM.md"), lib.MEMORY_HEADER + memories.map((m) => lib.formatLine(m)).join("\n") + "\n");
  for (const m of memories) if (m.kind !== "superseded") lib.recordProvenance(root, m, "hook");
  // Warm up: the first prompt starts the daemon; wait for it, then one more prompt through it.
  await runHookProcess(root, home, "warm-up");
  for (let i = 0; i < 50; i++) {
    const s = execFileSync(process.execPath, [CLI, "daemon", "status"], { cwd: root, env: hookEnv(root, home), encoding: "utf8" });
    if (/^running/.test(s)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await runHookProcess(root, home, "warm-up, again");
  const parsedLive = new Set(new lib.MemoryStore(root).active().map((m) => m.id));
  for (const p of prompts.filter((x) => x.file === f.id)) {
    const n0 = readLogEntries(root).length;
    const r = await runHookProcess(root, home, p.prompt);
    const entries = readLogEntries(root).slice(n0).filter((e) => e.label === "recall" && !e.event);
    const e = entries.at(-1);
    const inj = parseInjection(r.out);
    const idOf = (k) => byKey.get(k).id;
    const want = p.want.map(idOf);
    const ok = p.ok.map(idOf);
    const never = p.never.map(idOf);
    const injected = inj.lines.map((l) => ({ ...l, key: byId.get(l.id)?.key ?? null }));
    const hit = injected.filter((l) => want.includes(l.id)).length;
    const good = injected.filter((l) => want.includes(l.id) || ok.includes(l.id)).length;
    const superseded = injected.filter((l) => byId.get(l.id)?.kind === "superseded").map((l) => l.key);
    const neverHits = injected.filter((l) => never.includes(l.id)).map((l) => l.key);
    results.push({
      id: p.id,
      file: f.id,
      size: f.size,
      type: p.type,
      prompt: p.prompt,
      want: p.want,
      ok: p.ok,
      never: p.never,
      // A wanted line the build does not read as a live memory (0.5.9 skips [dead-end] lines) cannot be recalled by it.
      wantUnparsed: p.want.filter((k) => !parsedLive.has(idOf(k))),
      injected: injected.map((l) => ({ key: l.key, kind: l.kind, p: l.p })),
      wantHit: hit,
      good,
      wrong: injected.length - good,
      missed: p.want.filter((k) => !injected.some((l) => l.id === idOf(k))),
      extra: injected.filter((l) => !want.includes(l.id) && !ok.includes(l.id)).map((l) => l.key),
      supersededInjected: superseded,
      neverInjected: neverHits,
      lines: injected.length,
      contextChars: inj.context.length,
      contextTokens: await countTokens(inj.context),
      hookMs: r.ms,
      hookExit: r.code,
      via: /via daemon/.test(r.err) ? "daemon" : /via inline/.test(r.err) ? "inline" : null,
      jevMs: e?.latencyMs ?? null,
      jevOk: e ? e.ok : null,
      inputTokens: e?.inputTokens ?? null,
      costUsd: e ? (e.inputTokens / 1e6) * USD_PER_M_INPUT : null,
      error: inj.error ?? (e && !e.ok ? e.error : undefined),
    });
    const last = results.at(-1);
    process.stderr.write(`${p.id.padEnd(22)} ${p.type.padEnd(9)} want ${last.wantHit}/${p.want.length} lines ${last.lines} wrong ${last.wrong}${last.supersededInjected.length ? " SUPERSEDED " + last.supersededInjected : ""} ${r.ms} ms ${last.via ?? "?"}\n`);
  }
  try {
    execFileSync(process.execPath, [CLI, "daemon", "stop"], { cwd: root, env: hookEnv(root, home), stdio: "ignore" });
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}

/** Aggregates over a group of prompt results. */
function summarize(rs) {
  const withWant = rs.filter((r) => r.want.length > 0);
  const wanted = withWant.reduce((a, r) => a + r.want.length, 0);
  const hits = withWant.reduce((a, r) => a + r.wantHit, 0);
  const served = withWant.filter((r) => r.wantHit === r.want.length).length;
  const injected = rs.reduce((a, r) => a + r.lines, 0);
  const good = rs.reduce((a, r) => a + r.good, 0);
  const unrelated = rs.filter((r) => r.type === "unrelated");
  const unrelatedHit = unrelated.filter((r) => r.lines > 0).length;
  const leaks = rs.filter((r) => r.supersededInjected.length > 0).length;
  const neverHits = rs.filter((r) => r.neverInjected.length > 0).length;
  const tok = rs.map((r) => r.contextTokens).filter((x) => typeof x === "number");
  const cost = rs.map((r) => r.costUsd).filter((x) => typeof x === "number");
  const inputTok = rs.map((r) => r.inputTokens).filter((x) => typeof x === "number");
  return {
    prompts: rs.length,
    recall: wanted ? hits / wanted : null,
    recall_frac: `${hits}/${wanted}`,
    served_frac: `${served}/${withWant.length}`,
    precision: injected ? good / injected : null,
    precision_frac: `${good}/${injected}`,
    unrelated_injected_frac: `${unrelatedHit}/${unrelated.length}`,
    unrelated_injected_rate: unrelated.length ? unrelatedHit / unrelated.length : null,
    superseded_leak_frac: `${leaks}/${rs.length}`,
    never_hit_frac: `${neverHits}/${rs.length}`,
    lines_per_prompt: mean(rs.map((r) => r.lines)),
    context_chars_per_prompt: mean(rs.map((r) => r.contextChars)),
    context_tokens_per_prompt: tok.length === rs.length ? mean(tok) : null,
    context_tokens_per_injecting_prompt: tok.length === rs.length && rs.some((r) => r.lines) ? mean(rs.filter((r) => r.lines).map((r) => r.contextTokens)) : null,
    hook_p50_ms: pctl(rs.map((r) => r.hookMs), 0.5),
    hook_p95_ms: pctl(rs.map((r) => r.hookMs), 0.95),
    jev_p50_ms: pctl(rs.map((r) => r.jevMs).filter((x) => x !== null), 0.5),
    jev_p95_ms: pctl(rs.map((r) => r.jevMs).filter((x) => x !== null), 0.95),
    input_tokens_per_prompt: mean(inputTok),
    cost_per_prompt_usd: mean(cost),
    jev_failures: rs.filter((r) => r.jevOk === false || r.jevOk === null).length,
    via_daemon_frac: `${rs.filter((r) => r.via === "daemon").length}/${rs.length}`,
  };
}
const group = (key) => Object.fromEntries([...new Set(results.map((r) => r[key]))].map((k) => [k, summarize(results.filter((r) => r[key] === k))]));
const bySizeType = {};
for (const s of ["small", "medium", "large"]) for (const t of ["direct", "indirect", "unrelated", "supersede", "dead-end"]) {
  const rs = results.filter((r) => r.size === s && r.type === t);
  if (rs.length) bySizeType[`${s}/${t}`] = summarize(rs);
}

const out = {
  kind: "recall",
  set: SET,
  file: FILE,
  date: today,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  jevmem_version: pkgJson.version,
  package: PKG === path.resolve(".") ? "this checkout (dist/ built from it)" : PKG.replace(os.homedir(), "~"),
  commit,
  label: LABEL,
  machine: `${process.platform} ${process.arch}, node ${process.version}`,
  thresholds: { recallTopK: lib.DEFAULT_CONFIG.thresholds.recallTopK, recallMin: lib.DEFAULT_CONFIG.thresholds.recallMin, ...(lib.DEFAULT_CONFIG.thresholds.recallRelevanceMin !== undefined ? { recallRelevanceMin: lib.DEFAULT_CONFIG.thresholds.recallRelevanceMin } : {}), maxRecallCandidates: lib.DEFAULT_CONFIG.jev.maxRecallCandidates },
  tokens_counted_with: TOKENS_MODEL && process.env.OPENROUTER_API_KEY ? `${TOKENS_MODEL} (prompt tokens of the context as one user message, minus those of ".", from OpenRouter's usage)` : null,
  cost_method: "Jev input tokens × $0.042 per million; output tokens free",
  method:
    "Each memory file is written into a scratch project in jevmem's line format (superseded lines tagged, every live line recorded as written by jevmem here, so verified), jev.cache off. Each prompt is sent through the real hook (`node <pkg>/dist/cli.js hook`, the UserPromptSubmit payload on stdin) after two warm-up prompts, so the warm daemon serves it. Injected lines are read from the hook's output; the Jev call's latency and input tokens from .jevmem/log.jsonl; hook time is the hook process's wall time. recall = wanted lines injected / wanted lines; precision = injected lines that are wanted or ok / injected lines; unrelated = unrelated prompts that got any line; leaks = prompts that got a superseded line.",
  files: files.map((f) => ({ id: f.id, size: f.size, project: f.project, lines: f.lines.length, live: f.lines.filter((l) => l.kind !== "superseded").length, superseded: f.lines.filter((l) => l.kind === "superseded").length, deadEnds: f.lines.filter((l) => l.kind === "dead-end").length })),
  overall: summarize(results),
  by_size: group("size"),
  by_type: group("type"),
  by_size_type: bySizeType,
  rows: results,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
const o = out.overall;
console.log(`${SET}: recall ${o.recall_frac} (served ${o.served_frac}), precision ${o.precision_frac}, unrelated injected ${o.unrelated_injected_frac}, superseded leaks ${o.superseded_leak_frac}, ${o.lines_per_prompt?.toFixed(2)} lines/prompt, hook p50 ${o.hook_p50_ms} ms p95 ${o.hook_p95_ms} ms, $${o.cost_per_prompt_usd?.toFixed(6)}/prompt → ${OUT}`);
for (const [k, v] of Object.entries(out.by_type)) console.log(`  ${k.padEnd(10)} recall ${v.recall_frac.padEnd(7)} served ${v.served_frac.padEnd(6)} precision ${v.precision_frac.padEnd(7)} unrelated ${v.unrelated_injected_frac}`);
for (const [k, v] of Object.entries(out.by_size)) console.log(`  ${k.padEnd(10)} recall ${v.recall_frac.padEnd(7)} served ${v.served_frac.padEnd(6)} precision ${v.precision_frac.padEnd(7)} unrelated ${v.unrelated_injected_frac}`);
