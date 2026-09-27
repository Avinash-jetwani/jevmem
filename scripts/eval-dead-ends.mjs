#!/usr/bin/env node
// Dead ends (docs/dead-ends.md) on eval/dead-ends-dev.jsonl (tuning) or eval/dead-ends-heldout.jsonl (run once).
//
//   node scripts/eval-dead-ends.mjs [path/to/dist/index.js] [--set dev|heldout] [--mode auto|fast|full] [--out results/…json]
//   node scripts/eval-dead-ends.mjs --writer-only [--set dev|heldout] [--writer none|openai|anthropic] [--model <id>] [--out …]
//
// Pipeline (the default): every turn goes through the hook's path with the real Jev: `decide` (warm in-process client,
// no cache), then `writeMemory` with the local writer into a scratch JEVMEM.md that holds the turn's existing lines, so
// supersedes and the no-reason refusal happen as in the hook. Reported: dead-end precision and recall (a turn counts as
// saved as a dead end when a [dead-end] line was written), per tag; on the dead-end lines written, whether the line
// keeps what was tried and why (the labelled keys, case-insensitive); the supersede cases (the dead end that now works,
// the dead end that reverses a listed line, and near misses); ordinary turns against their labels; latency, tokens and
// cost per decision (input tokens × $0.042/M).
// --writer-only: no Jev. Every labelled dead end is written with kind dead-end from the text the hook would give the
// writer (the user message, the assistant reply, or both, per the label), with the local writer (none) or an LLM
// writer. An LLM writer needs OPENAI_API_KEY / ANTHROPIC_API_KEY; with OPENROUTER_API_KEY and --writer openai it goes
// through OpenRouter's OpenAI-compatible API (the same code path, callOpenAI, with OPENAI_BASE_URL set). jevmem sends
// reasoning_effort "minimal" for gpt-5 and o-series models only to api.openai.com, so on this route the script adds it to
// the request body for those models: the request is then the one api.openai.com would get.
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
const FILE = { dev: "eval/dead-ends-dev.jsonl", heldout: "eval/dead-ends-heldout.jsonl" }[SET];
if (!FILE) throw new Error(`unknown --set ${SET}`);
const MODE = opt("--mode", "auto");
const WRITER_ONLY = args.includes("--writer-only");
const WRITER = opt("--writer", "none");
const MODEL = opt("--model", undefined);
const OUT = opt("--out", null);
const USD_PER_M_INPUT = 0.042;
const MAX = 200;
const lib = await import(pathToFileURL(path.resolve(distArg)).href);
const rows = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const lower = (s) => String(s ?? "").toLowerCase();
const keeps = (line, keys) => (keys ?? []).some((k) => lower(line).includes(lower(k)));
const pct = (a, b) => (b ? a / b : null);
let commit = null;
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src", { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {}
const meta = { date: new Date().toISOString().slice(0, 10), commit, dist: path.relative(process.cwd(), path.resolve(distArg)), set: FILE, turns: rows.length, machine: `${process.platform} ${process.arch}, node ${process.version}, ${os.cpus()[0]?.model ?? "cpu"}` };

/** What the hook gives the writer when Jev reads the content source as labelled. */
const writerInput = (r) => (r.deadEnd.source === "user" ? r.user : r.deadEnd.source === "assistant" ? r.assistant : lib.mergeTurn(r.user, r.assistant));

async function writerOnly() {
  const env = { ...process.env };
  let via = WRITER === "none" ? "local writer (writer.provider none)" : `${WRITER} writer`;
  if (WRITER === "openai" && !env.OPENAI_API_KEY && env.OPENROUTER_API_KEY) {
    env.OPENAI_API_KEY = env.OPENROUTER_API_KEY;
    env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
    via = `openai writer (callOpenAI) through OpenRouter's OpenAI-compatible API, model ${MODEL}`;
    if (!MODEL) throw new Error("--model is required through OpenRouter (for example openai/gpt-5-mini)");
  }
  const writer = { provider: WRITER, model: MODEL, maxChars: MAX, timeoutMs: 30000 };
  // Through OpenRouter: add what callOpenAI sends api.openai.com for a reasoning model (isOpenAIReasoningModel).
  const viaOpenRouter = env.OPENAI_BASE_URL === "https://openrouter.ai/api/v1";
  const reasoning = viaOpenRouter && /^openai\/(gpt-5|o\d)/.test(MODEL ?? "");
  if (reasoning) via += ', with reasoning_effort "minimal" added (as jevmem sends it to api.openai.com)';
  // Each request's HTTP status, and up to two retries of a failed request (network error, 429, 5xx), so a line that fell
  // back to the local writer says whether the provider failed or the LLM's line gave no reason.
  let calls = [];
  const fetchImpl = WRITER === "none" ? undefined : async (url, init) => {
    const body = reasoning ? JSON.stringify({ ...JSON.parse(init.body), reasoning_effort: "minimal" }) : init.body;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { ...init, body });
        calls.push(res.status);
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        return res;
      } catch (err) {
        calls.push(`error: ${err?.name ?? err}`);
        if (attempt >= 2 || init.signal?.aborted) throw err;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };
  const out = [];
  for (const r of rows.filter((x) => x.deadEnd)) {
    const input = writerInput(r);
    const t0 = performance.now();
    calls = [];
    const { line, writerUsed } = await lib.composeLine(input, "dead-end", { writer, env, fetchImpl });
    const http = calls.slice();
    const fellBack = WRITER !== "none" && writerUsed === "fallback" ? (http.at(-1) === 200 ? "the LLM's line gave no reason (or was empty)" : `the provider failed (${http.join(", ") || "no request"})`) : null;
    out.push({ id: r.id, tag: r.tag, source: r.deadEnd.source, input, line, writerUsed, ...(WRITER === "none" ? {} : { http, fellBack }), ms: Math.round(performance.now() - t0), chars: line.length, triedKept: keeps(line, r.deadEnd.triedKeys), reasonKept: keeps(line, r.deadEnd.whyKeys), workedKept: r.deadEnd.worked ? keeps(line, r.deadEnd.workedKeys) : null, hasReason: lib.deadEndHasReason ? lib.deadEndHasReason(line) : null });
  }
  const n = out.length;
  const summary = {
    writer: WRITER, model: MODEL ?? null, via, deadEnds: n,
    reasonKept: out.filter((o) => o.reasonKept).length, reasonKeptRate: pct(out.filter((o) => o.reasonKept).length, n),
    triedKept: out.filter((o) => o.triedKept).length, triedKeptRate: pct(out.filter((o) => o.triedKept).length, n),
    bothKept: out.filter((o) => o.reasonKept && o.triedKept).length, bothKeptRate: pct(out.filter((o) => o.reasonKept && o.triedKept).length, n),
    workedKept: `${out.filter((o) => o.workedKept).length}/${out.filter((o) => o.workedKept !== null).length}`,
    passesReasonCheck: out.filter((o) => o.hasReason).length,
    fellBackToLocal: WRITER === "none" ? 0 : out.filter((o) => o.writerUsed === "fallback").length,
    fellBackProviderFailed: WRITER === "none" ? 0 : out.filter((o) => o.fellBack && o.fellBack.startsWith("the provider")).length,
    fellBackNoReason: WRITER === "none" ? 0 : out.filter((o) => o.fellBack && !o.fellBack.startsWith("the provider")).length,
    withinMaxChars: out.filter((o) => o.chars <= MAX).length,
    meanChars: Math.round(out.reduce((a, o) => a + o.chars, 0) / Math.max(1, n)),
  };
  return { kind: "dead-ends-writer", ...meta, summary, rows: out };
}

async function pipeline() {
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
  const jev = lib.createJev({ noLogFile: true, cache: false });
  // Warm the connection once, as the daemon keeps it.
  try {
    await lib.decide(jev, { userMessage: "warm-up", existingMemories: [] }, { tiers: { mode: MODE } });
  } catch {}
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-deadends-"));
  const out = [];
  const startedAt = new Date().toISOString();
  for (const r of rows) {
    const root = fs.mkdtempSync(path.join(tmp, "p-"));
    const store = new lib.MemoryStore(root);
    for (const m of r.existing) store.add({ id: m.id, kind: m.kind, text: m.text, conf: 0.9, ts: "2026-09-01T00:00:00.000Z" });
    const t0 = performance.now();
    const d = await lib.decide(jev, { userMessage: r.user, assistantReply: r.assistant, recentContext: r.previous, existingMemories: store.active() }, { tiers: { mode: MODE } });
    const ms = Math.round(performance.now() - t0);
    let got = { save: false, kind: "none", line: null, superseded: null, refused: null };
    if (d.save) {
      const w = await lib.writeMemory(store, d.sourceText || lib.mergeTurn(r.user, r.assistant), d, { writer: { provider: "none", maxChars: MAX, timeoutMs: 1000 }, env: {} });
      got = w.saved ? { save: true, kind: w.saved.kind, line: w.line, superseded: w.superseded?.id ?? null, refused: null } : { save: false, kind: "none", line: w.line, superseded: null, refused: w.refused };
    }
    const deadEnd = r.deadEnd && got.kind === "dead-end" ? { triedKept: keeps(got.line, r.deadEnd.triedKeys), reasonKept: keeps(got.line, r.deadEnd.whyKeys), workedKept: r.deadEnd.worked ? keeps(got.line, r.deadEnd.workedKeys) : null } : null;
    const want = r.accept.includes("skip") && !r.label.save ? "skip" : r.label.kind;
    out.push({
      id: r.id, tag: r.tag, subtype: r.subtype, user: r.user.slice(0, 100),
      want: { ...r.label, contradicts: r.contradicts ?? null, accept: r.accept },
      got, deadEnd,
      ok: r.accept.includes(got.save ? got.kind : "skip") && (r.contradicts ? got.superseded === r.contradicts : !got.superseded),
      ms, inputTokens: d.usage.inputTokens, outputTokens: d.usage.outputTokens, escalated: Boolean(d.escalated), assistantIncluded: d.assistantIncluded, source: d.source,
      reason: d.reason,
      deadEndNoul: { tier1: d.tier1?.nouls?.contains_dead_end ?? null, tier2: d.tier2?.nouls?.tried_an_approach_that_failed_or_was_dropped ?? null },
      kindChoice: d.kind, kindProbabilities: d.kindProbabilities,
      touches: d.touchesMemoryId, contradictionFamily: d.families?.contradiction ?? null,
      _want: want,
    });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  const finishedAt = new Date().toISOString();
  // Dead-end detection.
  const isDE = (o) => o.got.kind === "dead-end";
  const labelled = out.filter((o) => rows.find((r) => r.id === o.id).deadEnd);
  const tp = labelled.filter(isDE).length;
  const fp = out.filter((o) => isDE(o) && !rows.find((r) => r.id === o.id).deadEnd).length;
  const fn = labelled.length - tp;
  const saved = out.filter((o) => o.deadEnd);
  const byTag = {};
  for (const o of out) {
    const t = (byTag[o.tag] ??= { n: 0, savedAsDeadEnd: 0, ok: 0 });
    t.n++;
    if (isDE(o)) t.savedAsDeadEnd++;
    if (o.ok) t.ok++;
  }
  const sup = (tag) => {
    const xs = out.filter((o) => o.tag === tag);
    return { cases: xs.length, found: xs.filter((o) => o.got.superseded === o.want.contradicts).length, wrongId: xs.filter((o) => o.got.superseded && o.got.superseded !== o.want.contradicts).length, missed: xs.filter((o) => !o.got.superseded).length };
  };
  const nearMisses = out.filter((o) => o.tag === "supersede-near-miss");
  const allContra = out.filter((o) => o.want.contradicts);
  const falseSupersedes = out.filter((o) => !o.want.contradicts && o.got.superseded).length;
  const ordinary = out.filter((o) => o.tag === "ordinary");
  const lat = out.map((o) => o.ms).sort((a, b) => a - b);
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))];
  const avgIn = out.reduce((a, o) => a + o.inputTokens, 0) / out.length;
  const negativeTags = ["transient", "test-first", "options-not-tried", "taste-change", "no-reason"];
  const summary = {
    mode: MODE, started_at: startedAt, finished_at: finishedAt,
    deadEnds: labelled.length, savedAsDeadEnd: out.filter(isDE).length, truePositives: tp, falsePositives: fp, falseNegatives: fn,
    precision: pct(tp, tp + fp), recall: pct(tp, tp + fn),
    deadEndsFound: `${tp}/${labelled.length}`,
    reasonKept: `${saved.filter((o) => o.deadEnd.reasonKept).length}/${saved.length}`, reasonKeptRate: pct(saved.filter((o) => o.deadEnd.reasonKept).length, saved.length),
    triedKept: `${saved.filter((o) => o.deadEnd.triedKept).length}/${saved.length}`, triedKeptRate: pct(saved.filter((o) => o.deadEnd.triedKept).length, saved.length),
    workedKept: `${saved.filter((o) => o.deadEnd.workedKept).length}/${saved.filter((o) => o.deadEnd.workedKept !== null).length}`,
    refusedNoReason: out.filter((o) => o.got.refused).length,
    negativesSavedAsDeadEnd: `${out.filter((o) => negativeTags.includes(o.tag) && isDE(o)).length}/${out.filter((o) => negativeTags.includes(o.tag)).length}`,
    aFailedBWorked: { cases: byTag["a-failed-b-worked"]?.n ?? 0, savedAsDeadEnd: byTag["a-failed-b-worked"]?.savedAsDeadEnd ?? 0, kinds: Object.fromEntries(Object.entries(out.filter((o) => o.tag === "a-failed-b-worked").reduce((a, o) => ((a[o.got.save ? o.got.kind : "skip"] = (a[o.got.save ? o.got.kind : "skip"] ?? 0) + 1), a), {}))) },
    supersede: { ...sup("supersede"), nearMisses: nearMisses.length, nearMissFalseSupersedes: nearMisses.filter((o) => o.got.superseded).length },
    deadEndReversals: sup("dead-end-reversal"),
    contradictionsFound: `${allContra.filter((o) => o.got.superseded === o.want.contradicts).length}/${allContra.length}`,
    falseSupersedes,
    ordinaryCorrect: `${ordinary.filter((o) => o.ok).length}/${ordinary.length}`, ordinaryAccuracy: pct(ordinary.filter((o) => o.ok).length, ordinary.length),
    allCorrect: `${out.filter((o) => o.ok).length}/${out.length}`,
    byTag,
    p50ms: p(0.5), p95ms: p(0.95), avgInputTokens: Math.round(avgIn), costPerDecision: (avgIn / 1e6) * USD_PER_M_INPUT,
    escalationRate: MODE === "auto" ? out.filter((o) => o.escalated).length / out.length : null,
    assistantIncludedRate: out.filter((o) => o.assistantIncluded).length / out.length,
  };
  for (const o of out) delete o._want;
  return { kind: "dead-ends", ...meta, network_path: `direct HTTPS to ${process.env.TYPESAFE_BASE_URL ?? "the TypeSafe API default base URL"}, warm in-process client, cache off`, cost_method: "input tokens × $0.042 per million; output tokens free", summary, rows: out };
}

const report = WRITER_ONLY ? await writerOnly() : await pipeline();
if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
}
const s = report.summary;
if (WRITER_ONLY) {
  console.log(`${FILE}: ${s.via}`);
  console.log(`reason kept ${s.reasonKept}/${s.deadEnds}, tried kept ${s.triedKept}/${s.deadEnds}, both ${s.bothKept}/${s.deadEnds}, worked kept ${s.workedKept}, passes the reason check ${s.passesReasonCheck}/${s.deadEnds}, fell back ${s.fellBackToLocal} (provider failed ${s.fellBackProviderFailed}, no reason ${s.fellBackNoReason}), mean ${s.meanChars} chars`);
  for (const r of report.rows) console.log(`  ${r.reasonKept ? "✓" : "✗"}${r.triedKept ? "✓" : "✗"} ${r.id.padEnd(22)} ${r.line}`);
} else {
  const f = (x) => (x === null ? "–" : (x * 100).toFixed(1) + "%");
  console.log(`${FILE} (n=${rows.length}), mode ${MODE}, ${meta.dist}${commit ? `, commit ${commit}` : ""}`);
  console.log(`dead ends: precision ${f(s.precision)} (${s.truePositives}/${s.truePositives + s.falsePositives}), recall ${f(s.recall)} (${s.deadEndsFound}); reason kept ${s.reasonKept}, tried kept ${s.triedKept}, worked kept ${s.workedKept}; refused for no reason ${s.refusedNoReason}`);
  console.log(`negatives saved as dead end ${s.negativesSavedAsDeadEnd}; A-failed-B-worked ${JSON.stringify(s.aFailedBWorked.kinds)}`);
  console.log(`supersede (dead end now works) ${s.supersede.found}/${s.supersede.cases} (wrong id ${s.supersede.wrongId}), near misses superseded ${s.supersede.nearMissFalseSupersedes}/${s.supersede.nearMisses}; dead ends reversing a line ${s.deadEndReversals.found}/${s.deadEndReversals.cases}; all contradictions ${s.contradictionsFound}, false supersedes ${s.falseSupersedes}`);
  console.log(`ordinary ${s.ordinaryCorrect}; all rows ${s.allCorrect}; p50 ${s.p50ms} ms, p95 ${s.p95ms} ms, ${s.avgInputTokens} input tokens, $${s.costPerDecision.toFixed(7)}/decision, escalated ${f(s.escalationRate)}, reply in state ${f(s.assistantIncludedRate)}`);
  for (const [t, v] of Object.entries(s.byTag)) console.log(`  ${t.padEnd(20)} n=${String(v.n).padStart(2)}  saved as dead end ${v.savedAsDeadEnd}  ok ${v.ok}`);
  for (const o of report.rows.filter((x) => !x.ok || (x.deadEnd && !x.deadEnd.reasonKept))) {
    console.log(`  ✗ ${o.id.padEnd(22)} ${o.tag.padEnd(18)} want ${o.want.accept.join("|")}${o.want.contradicts ? ` ⊃${o.want.contradicts}` : ""} got ${o.got.save ? o.got.kind : "skip"}${o.got.superseded ? ` ⊃${o.got.superseded}` : ""}  de1=${o.deadEndNoul.tier1?.toFixed(2) ?? "-"} de2=${o.deadEndNoul.tier2?.toFixed(2) ?? "-"} ${o.reason}`);
    if (o.got.line) console.log(`      line: ${o.got.line}${o.deadEnd ? `  [tried ${o.deadEnd.triedKept ? "✓" : "✗"} why ${o.deadEnd.reasonKept ? "✓" : "✗"}]` : ""}${o.got.refused ? `  (refused: ${o.got.refused})` : ""}`);
  }
}
if (OUT) console.log(`\nwritten ${OUT}`);
