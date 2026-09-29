#!/usr/bin/env node
// Dead ends (docs/dead-ends.md) on eval/dead-ends-dev.jsonl, eval/dead-ends-dev-v2.jsonl and
// eval/dead-ends-dev-v3.jsonl (tuning), or eval/dead-ends-heldout.jsonl (held-out v1, run once in part 2),
// eval/dead-ends-heldout-v2.jsonl (held-out v2, run once at the end of part 2b) and eval/dead-ends-heldout-v3.jsonl
// (held-out v3, run once at the end of part 2c).
//
//   node scripts/eval-dead-ends.mjs [path/to/dist/index.js] [--set dev|dev2|dev3|heldout|heldout2|heldout3] [--mode auto|fast|full] [--out results/…json]
//   node scripts/eval-dead-ends.mjs --writer-only [--set …] [--writer none|openai|anthropic] [--model <id>] [--out …]
//
// Pipeline (the default): every turn goes through the hook's path with the real Jev: `decide` (warm in-process client,
// no cache), then `writeMemory` with the local writer (given the client, as the hook gives it: from v0.6 part 3c it asks
// Jev which sentences the line is made from) into a scratch JEVMEM.md that holds the turn's existing lines, so
// supersedes and the no-reason refusal happen as in the hook. Reported: dead-end precision and recall (a turn counts as
// saved as a dead end when a [dead-end] line was written), per tag; on the dead-end lines written, whether the line
// keeps what was tried and why (the labelled keys, case-insensitive); the supersede cases (the dead end that now works,
// the dead end that reverses a listed line, and near misses); ordinary turns against their labels; latency, tokens and
// cost per decision (input tokens × $0.042/M). Supersedes are scored three ways: correct (the labelled line), missed (a
// labelled line not superseded, or another one instead), false (a line superseded where none should be, or the wrong
// one), with the cases where a dead end now works (told by the user, or made to work by Claude) and the ones that must
// never supersede (a dead end that keeps a listed line, near misses, Claude's reply contradicting a listed line, a
// question with no content) counted on their own.
// The v3 sets (part 2c) add: saved when it should be (every row labelled save, as a kind it accepts) and skipped when it
// should be; plain statements whose reply adds nothing (saved as their kind, and why the others were skipped);
// questions and proposals (saved, superseded: both must be 0); dead ends that reverse a listed line (saved as a dead end
// and superseding it); retests of a listed dead end (the same reason: skipped; a new reason: one dead-end line with both
// reasons, superseding the old one); duplicates (a retest with the same reason saved as any line, or a retest with a new
// reason saved as a dead end next to the old line). A retest that fails again is a real dead end, so a second copy
// counts as a duplicate, not as a false positive of dead-end precision.
// --writer-only: no Jev. Every labelled dead end is written with kind dead-end from the text the hook would give the
// writer (the user message, the assistant reply, or both, per the label), with the local writer (none) or an LLM
// writer. An LLM writer needs OPENAI_API_KEY / ANTHROPIC_API_KEY; with OPENROUTER_API_KEY and --writer openai it goes
// through OpenRouter's OpenAI-compatible API (the same code path, callOpenAI, with OPENAI_BASE_URL set), and the request
// is the one jevmem sends there. Before part 2b jevmem sent reasoning_effort "minimal" only to api.openai.com; the part 2
// runs added it on this route (--add-effort does that again, for a build from before part 2b). Every response's content
// length, finish reason and reasoning tokens are recorded, so empty lines are counted.
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
const FILE = { dev: "eval/dead-ends-dev.jsonl", heldout: "eval/dead-ends-heldout.jsonl", dev2: "eval/dead-ends-dev-v2.jsonl", heldout2: "eval/dead-ends-heldout-v2.jsonl", dev3: "eval/dead-ends-dev-v3.jsonl", heldout3: "eval/dead-ends-heldout-v3.jsonl" }[SET];
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
  // --add-effort (a build from before part 2b): add what that build sent api.openai.com for a reasoning model.
  const viaOpenRouter = env.OPENAI_BASE_URL === "https://openrouter.ai/api/v1";
  const reasoning = args.includes("--add-effort") && viaOpenRouter && /^openai\/(gpt-5|o\d)/.test(MODEL ?? "");
  if (reasoning) via += ', with reasoning_effort "minimal" added by the script (as that build sent it to api.openai.com only)';
  else if (WRITER === "openai") via += ", the request exactly as this build sends it";
  // Each request's HTTP status, and up to two retries of a failed request (network error, 429, 5xx), so a line that fell
  // back to the local writer says whether the provider failed or the LLM's line gave no reason.
  let calls = [];
  let replies = [];
  const fetchImpl = WRITER === "none" ? undefined : async (url, init) => {
    const body = reasoning ? JSON.stringify({ ...JSON.parse(init.body), reasoning_effort: "minimal" }) : init.body;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { ...init, body });
        calls.push(res.status);
        if (res.status === 200) {
          try {
            const j = await res.clone().json();
            const content = j.choices?.[0]?.message?.content ?? j.content?.filter?.((c) => c.type === "text").map((c) => c.text).join("") ?? "";
            replies.push({ sentEffort: JSON.parse(body).reasoning_effort ?? null, contentChars: String(content).trim().length, finishReason: j.choices?.[0]?.finish_reason ?? j.stop_reason ?? null, reasoningTokens: j.usage?.completion_tokens_details?.reasoning_tokens ?? null });
          } catch {
            replies.push({ sentEffort: null, contentChars: null, finishReason: "unreadable", reasoningTokens: null });
          }
        }
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
    replies = [];
    const { line, writerUsed, note } = await lib.composeLine(input, "dead-end", { writer, env, fetchImpl });
    const http = calls.slice();
    const fellBack = WRITER !== "none" && writerUsed === "fallback" ? (http.at(-1) === 200 ? "the LLM's line gave no reason (or was empty)" : `the provider failed (${http.join(", ") || "no request"})`) : null;
    out.push({ id: r.id, tag: r.tag, source: r.deadEnd.source, input, line, writerUsed, ...(WRITER === "none" ? {} : { http, fellBack, replies: replies.slice(), emptyLine: replies.length > 0 && replies.at(-1).contentChars === 0, note: note ?? null }), ms: Math.round(performance.now() - t0), chars: line.length, triedKept: keeps(line, r.deadEnd.triedKeys), reasonKept: keeps(line, r.deadEnd.whyKeys), workedKept: r.deadEnd.worked ? keeps(line, r.deadEnd.workedKeys) : null, hasReason: lib.deadEndHasReason ? lib.deadEndHasReason(line) : null });
  }
  const n = out.length;
  const summary = {
    writer: WRITER, model: MODEL ?? null, via, deadEnds: n,
    reasonKept: out.filter((o) => o.reasonKept).length, reasonKeptRate: pct(out.filter((o) => o.reasonKept).length, n),
    triedKept: out.filter((o) => o.triedKept).length, triedKeptRate: pct(out.filter((o) => o.triedKept).length, n),
    bothKept: out.filter((o) => o.reasonKept && o.triedKept).length, bothKeptRate: pct(out.filter((o) => o.reasonKept && o.triedKept).length, n),
    workedKept: `${out.filter((o) => o.workedKept).length}/${out.filter((o) => o.workedKept !== null).length}`,
    // The word check of part 2 (removed in part 2b): counted only for a build that still has it.
    passesReasonCheck: lib.deadEndHasReason ? out.filter((o) => o.hasReason).length : null,
    fellBackToLocal: WRITER === "none" ? 0 : out.filter((o) => o.writerUsed === "fallback").length,
    fellBackProviderFailed: WRITER === "none" ? 0 : out.filter((o) => o.fellBack && o.fellBack.startsWith("the provider")).length,
    fellBackNoReason: WRITER === "none" ? 0 : out.filter((o) => o.fellBack && !o.fellBack.startsWith("the provider")).length,
    // Lines the endpoint returned empty (HTTP 200, no content): the part 2 finding for gpt-5-mini on OpenRouter.
    emptyLines: WRITER === "none" ? 0 : out.filter((o) => o.emptyLine).length,
    endsInEllipsis: out.filter((o) => o.line.endsWith("…")).length,
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
    let lineTokens = 0;
    if (d.save) {
      // The hook's writer: given the client, a build from v0.6 part 3c on asks Jev which sentences the line is made from.
      const at = jev.log.length;
      const w = await lib.writeMemory(store, d.sourceText || lib.mergeTurn(r.user, r.assistant), d, { writer: { provider: "none", maxChars: MAX, timeoutMs: 1000 }, env: {}, jev });
      lineTokens = jev.log.slice(at).filter((e) => !e.event).reduce((a, e) => a + (e.inputTokens ?? 0), 0);
      got = w.saved ? { save: true, kind: w.saved.kind, line: w.line, superseded: w.superseded?.id ?? null, refused: null, pick: w.pick?.chosen ?? null } : { save: false, kind: "none", line: w.line, superseded: null, refused: w.refused };
    }
    const deadEnd = r.deadEnd && got.kind === "dead-end" ? { triedKept: keeps(got.line, r.deadEnd.triedKeys), reasonKept: keeps(got.line, r.deadEnd.whyKeys), workedKept: r.deadEnd.worked ? keeps(got.line, r.deadEnd.workedKeys) : null } : null;
    const retest = r.retest ? { of: r.retest.of, same: r.retest.same, oldReasonKept: r.retest.oldWhyKeys && got.line ? keeps(got.line, r.retest.oldWhyKeys) : null, newReasonKept: r.retest.newWhyKeys && got.line ? keeps(got.line, r.retest.newWhyKeys) : null } : null;
    const want = r.accept.includes("skip") && !r.label.save ? "skip" : r.label.kind;
    out.push({
      id: r.id, tag: r.tag, subtype: r.subtype, user: r.user.slice(0, 100),
      want: { ...r.label, contradicts: r.contradicts ?? null, accept: r.accept },
      got, deadEnd, retest,
      ok: r.accept.includes(got.save ? got.kind : "skip") && (r.contradicts ? got.superseded === r.contradicts : !got.superseded),
      ms, inputTokens: d.usage.inputTokens, outputTokens: d.usage.outputTokens, lineInputTokens: lineTokens, escalated: Boolean(d.escalated), assistantIncluded: d.assistantIncluded, source: d.source,
      reason: d.reason,
      deadEndNoul: { tier1: d.tier1?.nouls?.contains_dead_end ?? null, tier2: d.tier2?.nouls?.tried_an_approach_that_failed_or_was_dropped ?? null },
      worksNow: d.worksNow ?? null,
      retestAnswer: d.retest ?? null,
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
  // A row without a labelled dead end whose accept list still takes one counts neither way; a retest that failed again for
  // the same reason (v3) is a real dead end, so saving it again counts as a duplicate (below), not here.
  const fp = out.filter((o) => isDE(o) && !rows.find((r) => r.id === o.id).deadEnd && !o.want.accept.includes("dead-end") && o.tag !== "retest-same").length;
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
  // Every supersede, scored once: correct, missed (not superseded, or another line instead), false (superseded where
  // nothing should be, or the wrong line).
  const supersedeScore = {
    labelled: allContra.length,
    correct: allContra.filter((o) => o.got.superseded === o.want.contradicts).length,
    missed: allContra.filter((o) => o.got.superseded !== o.want.contradicts).length,
    false: out.filter((o) => o.got.superseded && o.got.superseded !== o.want.contradicts).length,
    falseByTag: out.filter((o) => o.got.superseded && o.got.superseded !== o.want.contradicts).reduce((a, o) => ((a[o.tag] = (a[o.tag] ?? 0) + 1), a), {}),
  };
  const never = (tag) => ({ cases: out.filter((o) => o.tag === tag).length, superseded: out.filter((o) => o.tag === tag && o.got.superseded).length, saved: out.filter((o) => o.tag === tag && o.got.save).length });
  const ordinary = out.filter((o) => o.tag === "ordinary");
  const lat = out.map((o) => o.ms).sort((a, b) => a - b);
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))];
  const avgIn = out.reduce((a, o) => a + o.inputTokens, 0) / out.length;
  const negativeTags = ["transient", "test-first", "options-not-tried", "taste-change", "no-reason"];
  // v3 (part 2c).
  const kinds = (xs) => xs.reduce((a, o) => ((a[o.got.save ? o.got.kind : "skip"] = (a[o.got.save ? o.got.kind : "skip"] ?? 0) + 1), a), {});
  const tagged = (t) => out.filter((o) => o.tag === t);
  const v3 = out.some((o) => ["plain-statement", "question-proposal", "retest-same", "retest-new"].includes(o.tag))
    ? (() => {
        const shouldSave = out.filter((o) => o.want.save);
        const shouldSkip = out.filter((o) => !o.want.save);
        const plain = tagged("plain-statement");
        const qs = tagged("question-proposal");
        const rev = tagged("dead-end-reversal");
        const same = tagged("retest-same");
        const fresh = tagged("retest-new");
        const but = out.filter((o) => o.tag === "dead-end" && o.subtype === "but");
        const dupSame = same.filter((o) => o.got.save);
        const dupNew = fresh.filter((o) => isDE(o) && o.got.superseded !== o.want.contradicts);
        return {
          savedWhenShould: `${shouldSave.filter((o) => o.got.save && o.want.accept.includes(o.got.kind)).length}/${shouldSave.length}`,
          savedAnyKindWhenShould: `${shouldSave.filter((o) => o.got.save).length}/${shouldSave.length}`,
          skippedWhenShould: `${shouldSkip.filter((o) => !o.got.save).length}/${shouldSkip.length}`,
          plainStatements: { cases: plain.length, savedAsAccepted: plain.filter((o) => o.got.save && o.want.accept.includes(o.got.kind)).length, saved: plain.filter((o) => o.got.save).length, skipped: plain.filter((o) => !o.got.save).length, skippedSourceNone: plain.filter((o) => !o.got.save && o.source === "none").length, kinds: kinds(plain) },
          questionsAndProposals: { cases: qs.length, saved: qs.filter((o) => o.got.save).length, superseded: qs.filter((o) => o.got.superseded).length, kinds: kinds(qs) },
          reversals: { cases: rev.length, savedAsDeadEnd: rev.filter(isDE).length, superseded: rev.filter((o) => o.got.superseded === o.want.contradicts).length, savedAsDeadEndAndSuperseded: rev.filter((o) => isDE(o) && o.got.superseded === o.want.contradicts).length, kinds: kinds(rev) },
          retestSame: { cases: same.length, skipped: same.filter((o) => !o.got.save).length, saved: dupSame.length, superseded: same.filter((o) => o.got.superseded).length, kinds: kinds(same) },
          retestNew: { cases: fresh.length, savedAsDeadEnd: fresh.filter(isDE).length, supersededOld: fresh.filter((o) => o.got.superseded === o.want.contradicts).length, bothReasonsKept: fresh.filter((o) => isDE(o) && o.retest?.oldReasonKept && o.retest?.newReasonKept).length, newReasonKept: fresh.filter((o) => isDE(o) && o.retest?.newReasonKept).length, oldReasonKept: fresh.filter((o) => isDE(o) && o.retest?.oldReasonKept).length, kinds: kinds(fresh) },
          duplicates: dupSame.length + dupNew.length,
          duplicateIds: [...dupSame, ...dupNew].map((o) => o.id),
          reasonAfterBut: { cases: but.length, savedAsDeadEnd: but.filter(isDE).length, reasonKept: but.filter((o) => o.deadEnd?.reasonKept).length },
        };
      })()
    : null;
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
    supersedeByReply: { ...sup("supersede-by-reply"), savedAsDeadEnd: out.filter((o) => o.tag === "supersede-by-reply" && isDE(o)).length },
    worksNowSavedAsDeadEnd: `${out.filter((o) => ["supersede", "supersede-by-reply"].includes(o.tag) && isDE(o)).length}/${out.filter((o) => ["supersede", "supersede-by-reply"].includes(o.tag)).length}`,
    supersedeScore,
    mustNotSupersede: { deadEndAgrees: never("dead-end-agrees"), nearMisses: never("supersede-near-miss"), replyChatter: never("reply-chatter"), questionNoContent: never("question-no-content") },
    contradictionsFound: `${allContra.filter((o) => o.got.superseded === o.want.contradicts).length}/${allContra.length}`,
    falseSupersedes,
    ordinaryCorrect: `${ordinary.filter((o) => o.ok).length}/${ordinary.length}`, ordinaryAccuracy: pct(ordinary.filter((o) => o.ok).length, ordinary.length),
    allCorrect: `${out.filter((o) => o.ok).length}/${out.length}`,
    byTag,
    p50ms: p(0.5), p95ms: p(0.95), avgInputTokens: Math.round(avgIn), costPerDecision: (avgIn / 1e6) * USD_PER_M_INPUT,
    costPerDecisionWithLine: ((avgIn + out.reduce((a, o) => a + (o.lineInputTokens ?? 0), 0) / out.length) / 1e6) * USD_PER_M_INPUT,
    escalationRate: MODE === "auto" ? out.filter((o) => o.escalated).length / out.length : null,
    assistantIncludedRate: out.filter((o) => o.assistantIncluded).length / out.length,
    ...(v3 ? { v3 } : {}),
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
  if (WRITER !== "none") console.log(`empty lines from the endpoint: ${s.emptyLines}/${s.deadEnds}`);
  console.log(`reason kept ${s.reasonKept}/${s.deadEnds}, tried kept ${s.triedKept}/${s.deadEnds}, both ${s.bothKept}/${s.deadEnds}, worked kept ${s.workedKept}, ${s.passesReasonCheck === null ? "" : `passes the reason check ${s.passesReasonCheck}/${s.deadEnds}, `}fell back ${s.fellBackToLocal} (provider failed ${s.fellBackProviderFailed}, no reason ${s.fellBackNoReason}), mean ${s.meanChars} chars`);
  for (const r of report.rows) console.log(`  ${r.reasonKept ? "✓" : "✗"}${r.triedKept ? "✓" : "✗"} ${r.id.padEnd(22)} ${r.line}`);
} else {
  const f = (x) => (x === null ? "–" : (x * 100).toFixed(1) + "%");
  console.log(`${FILE} (n=${rows.length}), mode ${MODE}, ${meta.dist}${commit ? `, commit ${commit}` : ""}`);
  console.log(`dead ends: precision ${f(s.precision)} (${s.truePositives}/${s.truePositives + s.falsePositives}), recall ${f(s.recall)} (${s.deadEndsFound}); reason kept ${s.reasonKept}, tried kept ${s.triedKept}, worked kept ${s.workedKept}; refused for no reason ${s.refusedNoReason}`);
  console.log(`negatives saved as dead end ${s.negativesSavedAsDeadEnd}; A-failed-B-worked ${JSON.stringify(s.aFailedBWorked.kinds)}`);
  console.log(`supersede (dead end now works) ${s.supersede.found}/${s.supersede.cases} (wrong id ${s.supersede.wrongId}), near misses superseded ${s.supersede.nearMissFalseSupersedes}/${s.supersede.nearMisses}; dead ends reversing a line ${s.deadEndReversals.found}/${s.deadEndReversals.cases}; all contradictions ${s.contradictionsFound}, false supersedes ${s.falseSupersedes}`);
  if (s.supersedeByReply.cases) console.log(`Claude made a dead end work: superseded ${s.supersedeByReply.found}/${s.supersedeByReply.cases} (wrong id ${s.supersedeByReply.wrongId}), saved as a second dead end ${s.supersedeByReply.savedAsDeadEnd}; works-now turns saved as a dead end ${s.worksNowSavedAsDeadEnd}`);
  const ss = s.supersedeScore;
  console.log(`supersedes: correct ${ss.correct}/${ss.labelled}, missed ${ss.missed}, false ${ss.false} ${JSON.stringify(ss.falseByTag)}; must not supersede: ${Object.entries(s.mustNotSupersede).map(([k, v]) => `${k} ${v.superseded}/${v.cases}${k === "questionNoContent" ? ` (saved ${v.saved})` : ""}`).join(", ")}`);
  console.log(`ordinary ${s.ordinaryCorrect}; all rows ${s.allCorrect}; p50 ${s.p50ms} ms, p95 ${s.p95ms} ms, ${s.avgInputTokens} input tokens, $${s.costPerDecision.toFixed(7)}/decision, escalated ${f(s.escalationRate)}, reply in state ${f(s.assistantIncludedRate)}`);
  if (s.v3) {
    const v = s.v3;
    console.log(`saved when it should be ${v.savedWhenShould} (any kind ${v.savedAnyKindWhenShould}), skipped when it should be ${v.skippedWhenShould}; duplicates ${v.duplicates}${v.duplicates ? ` (${v.duplicateIds.join(", ")})` : ""}`);
    console.log(`plain statements saved ${v.plainStatements.savedAsAccepted}/${v.plainStatements.cases} (skipped ${v.plainStatements.skipped}, source none ${v.plainStatements.skippedSourceNone}); questions and proposals saved ${v.questionsAndProposals.saved}/${v.questionsAndProposals.cases}, superseding ${v.questionsAndProposals.superseded}`);
    console.log(`reversals: saved as dead end ${v.reversals.savedAsDeadEnd}/${v.reversals.cases}, superseded ${v.reversals.superseded}/${v.reversals.cases}, both ${v.reversals.savedAsDeadEndAndSuperseded} ${JSON.stringify(v.reversals.kinds)}`);
    console.log(`retests, same reason: skipped ${v.retestSame.skipped}/${v.retestSame.cases} ${JSON.stringify(v.retestSame.kinds)}; new reason: dead end ${v.retestNew.savedAsDeadEnd}/${v.retestNew.cases}, old superseded ${v.retestNew.supersededOld}, both reasons kept ${v.retestNew.bothReasonsKept} (new ${v.retestNew.newReasonKept}, old ${v.retestNew.oldReasonKept}); reason after "but" kept ${v.reasonAfterBut.reasonKept}/${v.reasonAfterBut.cases}`);
  }
  for (const [t, v] of Object.entries(s.byTag)) console.log(`  ${t.padEnd(20)} n=${String(v.n).padStart(2)}  saved as dead end ${v.savedAsDeadEnd}  ok ${v.ok}`);
  for (const o of report.rows.filter((x) => !x.ok || (x.deadEnd && !x.deadEnd.reasonKept) || (x.retest && !x.retest.same && x.got.kind === "dead-end" && !(x.retest.oldReasonKept && x.retest.newReasonKept)))) {
    console.log(`  ✗ ${o.id.padEnd(22)} ${o.tag.padEnd(18)} want ${o.want.accept.join("|")}${o.want.contradicts ? ` ⊃${o.want.contradicts}` : ""} got ${o.got.save ? o.got.kind : "skip"}${o.got.superseded ? ` ⊃${o.got.superseded}` : ""}  de1=${o.deadEndNoul.tier1?.toFixed(2) ?? "-"} de2=${o.deadEndNoul.tier2?.toFixed(2) ?? "-"} ${o.reason}`);
    if (o.got.line) console.log(`      line: ${o.got.line}${o.deadEnd ? `  [tried ${o.deadEnd.triedKept ? "✓" : "✗"} why ${o.deadEnd.reasonKept ? "✓" : "✗"}]` : ""}${o.retest && !o.retest.same ? `  [old reason ${o.retest.oldReasonKept ? "✓" : "✗"} new ${o.retest.newReasonKept ? "✓" : "✗"}]` : ""}${o.got.refused ? `  (refused: ${o.got.refused})` : ""}`);
  }
}
if (OUT) console.log(`\nwritten ${OUT}`);
