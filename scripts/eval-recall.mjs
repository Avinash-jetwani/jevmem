#!/usr/bin/env node
// Retrieval eval (v0.6 part 3): does recall put the right lines in front of Claude?
//
//   node scripts/eval-recall.mjs [--set dev|heldout|heldout2] [--build <label>=<package dir> ...] [--tokens <openrouter model>] [--date YYYY-MM-DD]
//   node scripts/eval-recall.mjs --pkg <package dir> --label <label>      (one build)
//
// A build is a jevmem package folder with dist/cli.js and dist/index.js: this checkout (`.`, built), a cached build of
// an older commit, or the published 0.5.9 (`npm install jevmem@0.5.9` into a folder, then <folder>/node_modules/jevmem).
// With two or more builds, every prompt goes to each build in turn, the order alternating from prompt to prompt, so the
// builds meet the same moments of the Jev API: its latency comes in bursts, and a hook call that gets no answer within
// the 2-second budget injects nothing.
//
// The set (eval/recall-dev.jsonl or eval/recall-heldout.jsonl) holds memory files (rows with `row: "file"`, three
// sizes) and prompts (rows with `row: "prompt"`), each prompt labelled with the lines it needs (`want`), lines that are
// fine to add (`ok`), and lines it must never get (`never`, the superseded line in a supersede case), by key.
//
// For each memory file and build: a scratch project (`init` without hooks), its JEVMEM.md written in jevmem's own line
// format (superseded lines tagged `[superseded] … → id:new`), every live line recorded as written by jevmem on this
// machine (provenance: verified, so the poisoning gate asks nothing, as for a solo user), and `jev.cache: false`. Every
// prompt goes through the real hook: `node <pkg>/dist/cli.js hook` with the UserPromptSubmit payload on stdin, as
// Claude Code sends it, after two warm-up prompts that start the daemon, so each scored prompt is served by the warm
// daemon, as in a session. The injected lines are read from the hook's stdout (`(id:…, p=…)`), the Jev call's latency,
// input tokens and cost from .jevmem/log.jsonl, and the hook's time is the hook process's wall time (spawn to exit).
//
// Reported per build, per memory size, per prompt type and overall:
//   recall     wanted lines injected / wanted lines (prompts with wanted lines); `served` = prompts that got all of them
//   precision  injected lines that are wanted or ok / injected lines
//   unrelated  prompts of type unrelated that got any line / unrelated prompts
//   leaks      prompts that got a superseded line: must be 0; `never` hits likewise
//   size       lines per prompt; characters and tokens of the whole injected context (tokens counted by an Anthropic
//              model's tokenizer, from OpenRouter's usage, when --tokens is given and OPENROUTER_API_KEY is set)
//   latency    hook process wall time p50/p95; the Jev call's own latency p50/p95
//   cost       Jev input tokens × $0.042/M per prompt (output free)
//   failures   Jev calls that failed or ran past the budget (the prompt got nothing); the `answered_*` figures repeat
//              recall, precision and unrelated over the prompts whose Jev call answered
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
const FILE = opt("--file", null) ?? { dev: "eval/recall-dev.jsonl", heldout: "eval/recall-heldout.jsonl", heldout2: "eval/recall-heldout-v2.jsonl" }[SET];
if (!FILE) throw new Error(`unknown --set ${SET}`);
const TOKENS_MODEL = opt("--tokens", null);
const ONLY = opt("--only", null); // a file id, for quick looks while tuning
const DATE = opt("--date", new Date().toISOString().slice(0, 10));
const USD_PER_M_INPUT = 0.042;
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");

const buildArgs = all("--build").map((b) => {
  const i = b.indexOf("=");
  return { label: b.slice(0, i), pkg: path.resolve(b.slice(i + 1)) };
});
if (!buildArgs.length) buildArgs.push({ label: opt("--label", null), pkg: path.resolve(opt("--pkg", ".")), out: opt("--out", null) });

const builds = [];
for (const b of buildArgs) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(b.pkg, "package.json"), "utf8"));
  let commit = null;
  try {
    if (b.pkg === path.resolve(".")) commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() + (execFileSync("git", ["status", "--porcelain", "src"], { encoding: "utf8" }).trim() ? "+dirty" : "");
  } catch {
    /* not a checkout */
  }
  builds.push({
    ...b,
    cli: path.join(b.pkg, "dist", "cli.js"),
    lib: await import(pathToFileURL(path.join(b.pkg, "dist", "index.js")).href),
    version: pkgJson.version,
    commit,
    out: b.out ?? `results/recall-${SET}-${DATE}${b.label ? `-${b.label}` : ""}.json`,
    results: [],
  });
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

function runHookProcess(b, root, home, prompt) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [b.cli, "hook"], { cwd: root, env: hookEnv(root, home), stdio: ["pipe", "pipe", "pipe"] });
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
  if (!TOKENS_MODEL || !process.env.OPENROUTER_API_KEY) return null;
  if (!text) return 0;
  const ask = async (content) => {
    if (tokenCache.has(content)) return tokenCache.get(content);
    for (let attempt = 0; attempt < 5; attempt++) {
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
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    return null;
  };
  const [a, b] = await Promise.all([ask(text), ask(".")]);
  return a === null || b === null ? null : a - b;
}

async function setUp(b, f) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-recall-")));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-recall-home-"));
  b.lib.init({ root, hooks: false });
  fs.writeFileSync(path.join(root, "jevmem.config.json"), JSON.stringify({ jev: { cache: false } }, null, 2) + "\n");
  const byKey = new Map(f.lines.map((l) => [l.key, l]));
  const memories = f.lines.map((l) => ({ id: l.id, kind: l.kind, text: l.text, ts: l.ts, conf: l.conf, ...(l.by ? { supersededBy: byKey.get(l.by).id } : {}) }));
  fs.writeFileSync(path.join(root, "JEVMEM.md"), b.lib.MEMORY_HEADER + memories.map((m) => b.lib.formatLine(m)).join("\n") + "\n");
  for (const m of memories) if (m.kind !== "superseded") b.lib.recordProvenance(root, m, "hook");
  // Warm up: the first prompt starts the daemon; wait for it, then one more prompt through it.
  await runHookProcess(b, root, home, "warm-up");
  for (let i = 0; i < 50; i++) {
    const s = execFileSync(process.execPath, [b.cli, "daemon", "status"], { cwd: root, env: hookEnv(root, home), encoding: "utf8" });
    if (/^running/.test(s)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await runHookProcess(b, root, home, "warm-up, again");
  // The lines this build reads as live memories (0.5.9 and older skip [dead-end] lines).
  const parsedLive = new Set(new b.lib.MemoryStore(root).active().map((m) => m.id));
  return { root, home, parsedLive };
}

async function tearDown(b, s) {
  try {
    execFileSync(process.execPath, [b.cli, "daemon", "stop"], { cwd: s.root, env: hookEnv(s.root, s.home), stdio: "ignore" });
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(s.root, { recursive: true, force: true });
  fs.rmSync(s.home, { recursive: true, force: true });
}

async function score(b, s, f, p) {
  const byKey = new Map(f.lines.map((l) => [l.key, l]));
  const byId = new Map(f.lines.map((l) => [l.id, l]));
  const n0 = readLogEntries(s.root).length;
  const r = await runHookProcess(b, s.root, s.home, p.prompt);
  const e = readLogEntries(s.root).slice(n0).filter((x) => x.label === "recall" && !x.event).at(-1);
  const inj = parseInjection(r.out);
  const idOf = (k) => byKey.get(k).id;
  const want = p.want.map(idOf);
  const ok = p.ok.map(idOf);
  const never = p.never.map(idOf);
  const injected = inj.lines.map((l) => ({ ...l, key: byId.get(l.id)?.key ?? null }));
  const good = injected.filter((l) => want.includes(l.id) || ok.includes(l.id)).length;
  return {
    id: p.id,
    file: f.id,
    size: f.size,
    type: p.type,
    prompt: p.prompt,
    want: p.want,
    ok: p.ok,
    never: p.never,
    // A wanted line the build does not read as a live memory (0.5.9 skips [dead-end] lines) cannot be recalled by it.
    wantUnparsed: p.want.filter((k) => !s.parsedLive.has(idOf(k))),
    injected: injected.map((l) => ({ key: l.key, kind: l.kind, p: l.p })),
    wantHit: injected.filter((l) => want.includes(l.id)).length,
    good,
    wrong: injected.length - good,
    missed: p.want.filter((k) => !injected.some((l) => l.id === idOf(k))),
    extra: injected.filter((l) => !want.includes(l.id) && !ok.includes(l.id)).map((l) => l.key),
    supersededInjected: injected.filter((l) => byId.get(l.id)?.kind === "superseded").map((l) => l.key),
    neverInjected: injected.filter((l) => never.includes(l.id)).map((l) => l.key),
    lines: injected.length,
    contextChars: inj.context.length,
    contextTokens: await countTokens(inj.context),
    hookMs: r.ms,
    hookExit: r.code,
    via: /via daemon/.test(r.err) ? "daemon" : /via inline/.test(r.err) ? "inline" : null,
    jevMs: e?.latencyMs ?? null,
    jevOk: e ? e.ok : false,
    at: new Date().toISOString(),
    inputTokens: e?.inputTokens ?? null,
    costUsd: e?.ok ? (e.inputTokens / 1e6) * USD_PER_M_INPUT : null,
    error: inj.error ?? (e && !e.ok ? e.error : e ? undefined : "no recall call logged"),
  };
}

const startedAt = new Date().toISOString();
for (const f of files) {
  const setups = [];
  for (const b of builds) setups.push(await setUp(b, f));
  const fp = prompts.filter((x) => x.file === f.id);
  for (let i = 0; i < fp.length; i++) {
    const order = builds.map((_, j) => j);
    if (i % 2) order.reverse();
    for (const j of order) {
      const rec = await score(builds[j], setups[j], f, fp[i]);
      builds[j].results.push(rec);
      process.stderr.write(`${(builds[j].label ?? "").padEnd(8)} ${rec.id.padEnd(20)} ${rec.type.padEnd(9)} want ${rec.wantHit}/${rec.want.length} lines ${rec.lines} wrong ${rec.wrong}${rec.supersededInjected.length ? " SUPERSEDED " + rec.supersededInjected : ""} ${rec.hookMs} ms ${rec.jevOk ? "" : "JEV FAILED "}${rec.via ?? "?"}\n`);
    }
  }
  for (let j = 0; j < builds.length; j++) await tearDown(builds[j], setups[j]);
}

/** Aggregates over a group of prompt results. */
function summarize(rs) {
  const q = (list) => {
    const withWant = list.filter((r) => r.want.length > 0);
    const wanted = withWant.reduce((a, r) => a + r.want.length, 0);
    const hits = withWant.reduce((a, r) => a + r.wantHit, 0);
    const injected = list.reduce((a, r) => a + r.lines, 0);
    const good = list.reduce((a, r) => a + r.good, 0);
    const unrelated = list.filter((r) => r.type === "unrelated");
    const unrelatedHit = unrelated.filter((r) => r.lines > 0).length;
    return { wanted, hits, served: withWant.filter((r) => r.wantHit === r.want.length).length, withWant: withWant.length, injected, good, unrelated: unrelated.length, unrelatedHit };
  };
  const a = q(rs);
  const answered = rs.filter((r) => r.jevOk);
  const b = q(answered);
  const tok = rs.map((r) => r.contextTokens).filter((x) => typeof x === "number");
  const cost = rs.map((r) => r.costUsd).filter((x) => typeof x === "number");
  const inputTok = rs.map((r) => r.inputTokens).filter((x) => typeof x === "number");
  const injecting = rs.filter((r) => r.lines > 0 && typeof r.contextTokens === "number");
  return {
    prompts: rs.length,
    recall: a.wanted ? a.hits / a.wanted : null,
    recall_frac: `${a.hits}/${a.wanted}`,
    served_frac: `${a.served}/${a.withWant}`,
    precision: a.injected ? a.good / a.injected : null,
    precision_frac: `${a.good}/${a.injected}`,
    unrelated_injected_frac: `${a.unrelatedHit}/${a.unrelated}`,
    unrelated_injected_rate: a.unrelated ? a.unrelatedHit / a.unrelated : null,
    superseded_leak_frac: `${rs.filter((r) => r.supersededInjected.length > 0).length}/${rs.length}`,
    never_hit_frac: `${rs.filter((r) => r.neverInjected.length > 0).length}/${rs.length}`,
    jev_failures: rs.length - answered.length,
    jev_failed_frac: `${rs.length - answered.length}/${rs.length}`,
    answered_recall_frac: `${b.hits}/${b.wanted}`,
    answered_recall: b.wanted ? b.hits / b.wanted : null,
    answered_precision_frac: `${b.good}/${b.injected}`,
    answered_precision: b.injected ? b.good / b.injected : null,
    answered_unrelated_frac: `${b.unrelatedHit}/${b.unrelated}`,
    lines_per_prompt: mean(rs.map((r) => r.lines)),
    lines_per_injecting_prompt: mean(rs.filter((r) => r.lines > 0).map((r) => r.lines)),
    context_chars_per_prompt: mean(rs.map((r) => r.contextChars)),
    context_tokens_per_prompt: tok.length ? mean(tok) : null,
    context_tokens_counted_frac: `${tok.length}/${rs.length}`,
    context_tokens_per_injecting_prompt: injecting.length ? mean(injecting.map((r) => r.contextTokens)) : null,
    hook_p50_ms: pctl(rs.map((r) => r.hookMs), 0.5),
    hook_p95_ms: pctl(rs.map((r) => r.hookMs), 0.95),
    jev_p50_ms: pctl(answered.map((r) => r.jevMs), 0.5),
    jev_p95_ms: pctl(answered.map((r) => r.jevMs), 0.95),
    input_tokens_per_prompt: mean(inputTok),
    cost_per_prompt_usd: mean(cost),
    via_daemon_frac: `${rs.filter((r) => r.via === "daemon").length}/${rs.length}`,
  };
}

for (const b of builds) {
  const results = b.results;
  const group = (key) => Object.fromEntries([...new Set(results.map((r) => r[key]))].map((k) => [k, summarize(results.filter((r) => r[key] === k))]));
  const bySizeType = {};
  for (const s of ["small", "medium", "large"])
    for (const t of ["direct", "indirect", "unrelated", "supersede", "dead-end"]) {
      const rs = results.filter((r) => r.size === s && r.type === t);
      if (rs.length) bySizeType[`${s}/${t}`] = summarize(rs);
    }
  const th = b.lib.DEFAULT_CONFIG.thresholds;
  const out = {
    kind: "recall",
    set: SET,
    file: FILE,
    date: DATE,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    jevmem_version: b.version,
    package: b.pkg === path.resolve(".") ? "this checkout (dist/ built from it)" : b.pkg.replace(os.homedir(), "~"),
    commit: b.commit,
    label: b.label,
    paired_with: builds.filter((x) => x !== b).map((x) => ({ label: x.label, version: x.version, commit: x.commit, file: x.out })),
    machine: `${process.platform} ${process.arch}, node ${process.version}`,
    thresholds: { recallTopK: th.recallTopK, recallMin: th.recallMin, ...(th.recallRelevanceMin !== undefined ? { recallRelevanceMin: th.recallRelevanceMin, relevanceSure: b.lib.RELEVANCE_SURE } : {}), maxRecallCandidates: b.lib.DEFAULT_CONFIG.jev.maxRecallCandidates, ...(b.lib.DEFAULT_CONFIG.jev.maxRecallLines !== undefined ? { maxRecallLines: b.lib.DEFAULT_CONFIG.jev.maxRecallLines } : {}), hookJevTimeoutMs: b.lib.DEFAULT_CONFIG.jev.timeoutMs },
    tokens_counted_with: TOKENS_MODEL && process.env.OPENROUTER_API_KEY ? `${TOKENS_MODEL} (prompt tokens of the whole injected context sent as one user message, minus those of ".", from OpenRouter's usage)` : null,
    cost_method: "Jev input tokens × $0.042 per million; output tokens free",
    method:
      "Each memory file is written into a scratch project per build in jevmem's line format (superseded lines tagged, every live line recorded as written by jevmem here, so verified), jev.cache off. Each prompt is sent through the real hook (`node <pkg>/dist/cli.js hook`, the UserPromptSubmit payload on stdin) after two warm-up prompts, so the warm daemon serves it; with several builds, each prompt goes to each build in turn, alternating the order. Injected lines are read from the hook's output; the Jev call's latency and input tokens from .jevmem/log.jsonl; hook time is the hook process's wall time. recall = wanted lines injected / wanted lines; precision = injected lines that are wanted or ok / injected lines; unrelated = unrelated prompts that got any line; leaks = prompts that got a superseded line; a Jev call that failed or ran past the hook's 2-second budget injects nothing and counts as a miss (answered_* leaves those prompts out).",
    files: files.map((f) => ({ id: f.id, size: f.size, project: f.project, lines: f.lines.length, live: f.lines.filter((l) => l.kind !== "superseded").length, superseded: f.lines.filter((l) => l.kind === "superseded").length, deadEnds: f.lines.filter((l) => l.kind === "dead-end").length })),
    overall: summarize(results),
    by_size: group("size"),
    by_type: group("type"),
    by_size_type: bySizeType,
    rows: results,
  };
  fs.mkdirSync(path.dirname(b.out), { recursive: true });
  fs.writeFileSync(b.out, JSON.stringify(out, null, 2) + "\n");
  const o = out.overall;
  console.log(`${b.label ?? "build"} (${b.version}${b.commit ? ` ${b.commit}` : ""}), ${SET}: recall ${o.recall_frac} (served ${o.served_frac}), precision ${o.precision_frac}, unrelated injected ${o.unrelated_injected_frac}, superseded leaks ${o.superseded_leak_frac}; Jev failed ${o.jev_failed_frac} (answered: recall ${o.answered_recall_frac}, precision ${o.answered_precision_frac}, unrelated ${o.answered_unrelated_frac}); ${o.lines_per_prompt?.toFixed(2)} lines/prompt, hook p50 ${o.hook_p50_ms} ms p95 ${o.hook_p95_ms} ms, $${o.cost_per_prompt_usd?.toFixed(6)}/prompt → ${b.out}`);
  for (const [k, v] of [...Object.entries(out.by_type), ...Object.entries(out.by_size)]) console.log(`  ${k.padEnd(10)} recall ${v.recall_frac.padEnd(7)} served ${v.served_frac.padEnd(6)} precision ${v.precision_frac.padEnd(7)} unrelated ${v.unrelated_injected_frac.padEnd(5)} jev failed ${v.jev_failed_frac}`);
}
