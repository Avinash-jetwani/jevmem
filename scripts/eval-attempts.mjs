#!/usr/bin/env node
// A failed attempt is not saved as a decision (0.6.6): what a build saves from turns where the developer asks Claude to
// try or change something and Claude's reply says how it went.
//
//   node scripts/eval-attempts.mjs [path/to/dist/index.js] [--set dev|heldout|heldout-captured|<file.jsonl>] [--mode auto|fast|full] [--label now] [--baseline results/….json] [--out results/….json]
//   node scripts/eval-attempts.mjs [path/to/dist/index.js] --sent-only eval/heldout.jsonl [--out results/….json]
//
// Sets: eval/attempts-dev.jsonl (tuning: replies captured from real Claude Code sessions in three scratch projects, each
// row with the model that served it), eval/attempts-heldout-captured.jsonl (the captured sessions of two other scratch
// projects, whose replies nobody who tuned the change read) and eval/attempts-heldout.jsonl (written in four more
// projects before any code changed). The held-out sets run once on the build that ships and once on the release before
// it. Every row is one turn with the project's memory lines. Tags:
//   attempt-failed    the request is to try or change something, and the reply says it failed and why: the turn should
//                     be saved as a dead end with its reason, and the request itself should not be saved
//   attempt-open      (dev only) the reply neither keeps the change nor reports a clear failed attempt: Claude declined
//                     to try, or hit a blocker and asked what to do. A dead end or nothing may be saved; the request
//                     itself should not be
//   attempt-worked    the same kind of request, and it worked: saved as before (not as a dead end)
//   decision-request  a real decision, rule or preference given as an instruction: saved as that
//   ordinary          questions, bug reports, thanks, to-dos: saved or skipped as labelled
//
// Each row goes through the hook's path with the real Jev (a warm in-process client, cache off), in a scratch project
// that holds the row's lines: `decide`, then, when it saves, `writeMemory` with jevmem's own writer, given the client.
// A captured row also carries `final`, the turn's last message alone (the Stop payload's `last_assistant_message`),
// which decide gets as `assistantFinal`; a build that does not know the field ignores it.
// That is the line a user gets. Judged in code, with no LLM: a dead-end line keeps the reason when it contains one of
// the row's `reasonKeys`, says what was tried when it contains one of its `factKeys`, and is the request when it
// contains one of its `requestKeys` (words of the request that the reply does not use). A row whose `accept` lists
// "skip" is also right when nothing is saved.
//
// What is sent: the script wraps the client and reads, from each request's state, whether Claude's reply is in it and
// how long it is. So "the reply was sent" comes from the request itself, not from a field the build reports.
// Cost = input tokens × $0.042/M (Jev bills input tokens only); latency is wall time around decide.
//
// --sent-only FILE runs decide alone over any set of turns ({user, assistant, existing, previous}) and records only
// what was sent, the tokens and the time. It reads no label and writes no outcome, so a set can be used to count how
// often the reply would be sent without being used to choose between designs (the 66-turn benchmark set, in 0.6.6).
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
const SENT_ONLY = opt("--sent-only", null);
const SET = opt("--set", "dev");
const FILE = SENT_ONLY ?? { dev: "eval/attempts-dev.jsonl", heldout: "eval/attempts-heldout.jsonl", "heldout-captured": "eval/attempts-heldout-captured.jsonl" }[SET] ?? (SET.endsWith(".jsonl") ? SET : undefined);
if (!FILE) throw new Error(`unknown --set ${SET}`);
const MODE = opt("--mode", "auto");
const LABEL = opt("--label", null);
const OUT = opt("--out", null);
const BASELINE = opt("--baseline", null);
const USD_PER_M_INPUT = 0.042;
const MAX = 200;
const lib = await import(pathToFileURL(path.resolve(distArg)).href);
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const rows = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const baseline = BASELINE ? new Map(JSON.parse(fs.readFileSync(BASELINE, "utf8")).rows.map((r) => [r.id, r])) : null;

let commit = null;
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src", { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {}
const measuredVersion = (from) => {
  for (let d = path.dirname(from); ; d = path.dirname(d)) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8"));
      if (p.name === "jevmem" && typeof p.version === "string") return p.version;
    } catch {}
    if (path.dirname(d) === d) return null;
  }
};
const version = measuredVersion(path.resolve(distArg));

/** Tags of turns whose request was not carried out, so the request itself must not be saved. */
const ATTEMPT_NOT_KEPT = ["attempt-failed", "attempt-open"];
const lower = (s) => String(s ?? "").toLowerCase();
const hasKey = (line, keys) => (keys ?? []).some((k) => lower(line).includes(lower(k)));

async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
}

const jev = lib.createJev({ noLogFile: true, cache: false });
// Every request's state, as sent: is Claude's reply in it, and how long. The reply is any text of the state other than
// the user's message, the previous turns and the memory lines (`assistant_reply` in every build so far).
const requests = [];
const realCall = jev.call.bind(jev);
jev.call = (state, questions, o) => {
  const replyChars = Object.entries(state ?? {}).reduce((a, [k, v]) => (typeof v === "string" && !["user_message", "previous_turns"].includes(k) ? a + v.length : a), 0);
  requests.push({ label: o?.label ?? null, tier: o?.tier ?? null, replyChars, userChars: typeof state?.user_message === "string" ? state.user_message.length : 0 });
  return realCall(state, questions, o);
};
try {
  await lib.decide(jev, { userMessage: "warm-up", existingMemories: [] }, { tiers: { mode: MODE } });
} catch {}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-attempts-"));
const writer = { provider: "none", maxChars: MAX, timeoutMs: 1000 };
const out = [];
const startedAt = new Date().toISOString();
for (const [i, r] of rows.entries()) {
  const existing = r.existing ?? [];
  const row = SENT_ONLY ? { n: i } : { id: r.id, project: r.project, tag: r.tag, subtype: r.subtype ?? null, model: r.model ?? null, want: { ...r.label, accept: r.accept, source: r.source } };
  try {
    const root = fs.mkdtempSync(path.join(tmp, "p-"));
    const store = new lib.MemoryStore(root);
    for (const m of existing) store.add({ id: m.id, kind: m.kind, text: m.text, conf: 0.9, ts: "2026-09-01T00:00:00.000Z" });
    const reqAt = requests.length;
    const logAt = jev.log.length;
    const t0 = performance.now();
    const d = await withRetry(() => lib.decide(jev, { userMessage: r.user, assistantReply: r.assistant, ...(r.final ? { assistantFinal: r.final } : {}), recentContext: r.previous, existingMemories: store.active() }, { tiers: { mode: MODE } }));
    const ms = Math.round(performance.now() - t0);
    const decideRequests = requests.slice(reqAt);
    const decideEntries = jev.log.slice(logAt).filter((e) => !e.event);
    row.sent = { replySent: decideRequests.some((q) => q.replyChars > 0), replyChars: Math.max(0, ...decideRequests.map((q) => q.replyChars)), replyCharsInTurn: (r.assistant ?? "").length, decideCalls: decideRequests.length };
    row.ms = ms;
    row.inputTokens = decideEntries.reduce((a, e) => a + (e.inputTokens ?? 0), 0);
    if (SENT_ONLY) {
      out.push(row);
      process.stderr.write(`${String(i + 1).padStart(3)} reply ${row.sent.replySent ? `sent (${row.sent.replyChars} chars)` : "not sent"}, ${row.sent.decideCalls} call(s), ${row.inputTokens} tokens, ${ms} ms\n`);
      continue;
    }
    row.decide = { save: d.save, kind: d.save ? d.kind : "none", source: d.source, assistantIncluded: d.assistantIncluded, reason: d.reason, tier: d.tier, escalated: Boolean(d.escalated), deadEndNoul: d.tier2?.nouls?.tried_an_approach_that_failed_or_was_dropped ?? d.tier1?.nouls?.contains_dead_end ?? null, kindProbabilities: d.kindProbabilities };
    row.got = { save: false, kind: "none", line: null };
    row.lineInputTokens = 0;
    if (d.save) {
      const at = jev.log.length;
      const w = await lib.writeMemory(store, d.sourceText || lib.mergeTurn(r.user, r.assistant), d, { writer, env: {}, jev });
      row.lineInputTokens = jev.log.slice(at).filter((e) => !e.event).reduce((a, e) => a + (e.inputTokens ?? 0), 0);
      row.got = w.saved ? { save: true, kind: w.saved.kind, line: w.line, pick: w.pick?.chosen ?? null } : { save: false, kind: "none", line: w.line ?? null, refused: w.refused ?? null };
    }
    const g = row.got;
    const line = g.save ? g.line : null;
    row.judged = {
      deadEnd: g.save && g.kind === "dead-end",
      keepsReason: line && r.reasonKeys?.length ? hasKey(line, r.reasonKeys) : null,
      saysWhatWasTried: line && r.tag === "attempt-failed" ? hasKey(line, r.factKeys) : null,
      statesFact: line && r.tag !== "attempt-failed" && r.factKeys?.length ? hasKey(line, r.factKeys) : null,
      lineIsRequest: line && r.requestKeys?.length ? hasKey(line, r.requestKeys) : null,
      // The request itself kept as a memory: saved, not as a dead end, from the user's side of the turn.
      requestSaved: ATTEMPT_NOT_KEPT.includes(r.tag) && g.save && g.kind !== "dead-end" && (d.source === "user_message" || hasKey(line, r.requestKeys)),
      acceptedKind: g.save ? (r.accept ?? []).includes(g.kind) : !r.label.save || (r.accept ?? []).includes("skip"),
      saveRight: g.save === r.label.save || (!g.save && (r.accept ?? []).includes("skip")),
    };
    if (baseline?.has(r.id)) {
      const b = baseline.get(r.id).got;
      row.baseline = { save: b.save, kind: b.kind, line: b.line ?? null };
      row.judged.sameAsBaseline = b.save === g.save && b.kind === g.kind;
      row.judged.sameLineAsBaseline = (b.line ?? null) === (g.line ?? null);
    }
  } catch (err) {
    row.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  out.push(row);
  if (!SENT_ONLY) process.stderr.write(`${r.id.padEnd(26)} ${r.tag.padEnd(17)} ${row.error ? `ERROR ${row.error}` : `${row.sent.replySent ? "reply" : "     "} ${row.got.save ? `[${row.got.kind}] ${row.got.line}` : `skip  ${row.decide.reason}`}`}\n`);
}
fs.rmSync(tmp, { recursive: true, force: true });
const finishedAt = new Date().toISOString();

const pctl = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const frac = (xs, f) => `${xs.filter(f).length}/${xs.length}`;
const usd = (tokens) => (tokens / 1e6) * USD_PER_M_INPUT;
const ok = out.filter((o) => !o.error);

const sentOf = (xs) => ({
  turns: xs.length,
  replySent: frac(xs, (o) => o.sent.replySent),
  replySentShare: xs.length ? xs.filter((o) => o.sent.replySent).length / xs.length : null,
  meanReplyCharsWhenSent: Math.round(mean(xs.filter((o) => o.sent.replySent).map((o) => o.sent.replyChars)) ?? 0),
  maxReplyCharsSent: Math.max(0, ...xs.map((o) => o.sent.replyChars)),
  meanReplyCharsPerTurn: Math.round(mean(xs.map((o) => o.sent.replyChars)) ?? 0),
  decideCallsPerTurn: mean(xs.map((o) => o.sent.decideCalls)),
});
const costOf = (xs) => ({
  turns: xs.length,
  decideP50ms: pctl(xs.map((o) => o.ms), 0.5),
  decideP95ms: pctl(xs.map((o) => o.ms), 0.95),
  meanInputTokens: Math.round(mean(xs.map((o) => o.inputTokens)) ?? 0),
  costPerTurnUsd: usd(mean(xs.map((o) => o.inputTokens)) ?? 0),
  ...(SENT_ONLY ? {} : { costPerTurnWithLineUsd: usd(mean(xs.map((o) => o.inputTokens + (o.lineInputTokens ?? 0))) ?? 0) }),
});

const summary = { mode: MODE, started_at: startedAt, finished_at: finishedAt, errors: out.length - ok.length, sent: sentOf(ok), perTurn: costOf(ok) };
if (!SENT_ONLY) {
  const tag = (t) => ok.filter((o) => o.tag === t);
  const failed = tag("attempt-failed");
  const deadEnds = failed.filter((o) => o.judged.deadEnd);
  const requestSaved = failed.filter((o) => o.judged.requestSaved);
  const kinds = (xs) => Object.fromEntries([...new Set(xs.map((o) => o.got.kind))].sort().map((k) => [k, xs.filter((o) => o.got.kind === k).length]));
  const failedSummary = (xs) => {
    const de = xs.filter((o) => o.judged.deadEnd);
    return {
      turns: xs.length,
      replyRead: frac(xs, (o) => o.sent.replySent),
      savedAsDeadEnd: frac(xs, (o) => o.judged.deadEnd),
      deadEndKeepsReason: frac(de, (o) => o.judged.keepsReason),
      deadEndSaysWhatWasTried: frac(de, (o) => o.judged.saysWhatWasTried),
      deadEndWithReason: frac(xs, (o) => o.judged.deadEnd && o.judged.keepsReason),
      requestSaved: frac(xs, (o) => o.judged.requestSaved),
      requestSavedAsDecisionOrTodo: frac(xs, (o) => o.judged.requestSaved && ["decision", "todo"].includes(o.got.kind)),
      savedAsAnotherKindFromTheReply: frac(xs, (o) => o.got.save && !o.judged.deadEnd && !o.judged.requestSaved),
      nothingSaved: frac(xs, (o) => !o.got.save),
    };
  };
  const controlSummary = (xs) => ({
    turns: xs.length,
    replyRead: frac(xs, (o) => o.sent.replySent),
    saveSkipRight: frac(xs, (o) => o.judged.saveRight),
    savedAsAccepted: frac(xs, (o) => o.judged.saveRight && o.judged.acceptedKind),
    savedAsDeadEnd: frac(xs, (o) => o.judged.deadEnd),
    statesFact: frac(xs.filter((o) => o.judged.statesFact !== null), (o) => o.judged.statesFact),
    ...(baseline ? { sameSaveAndKindAsBaseline: frac(xs.filter((o) => o.baseline), (o) => o.judged.sameAsBaseline), sameLineAsBaseline: frac(xs.filter((o) => o.baseline), (o) => o.judged.sameLineAsBaseline) } : {}),
    gotKinds: kinds(xs),
  });
  const open = tag("attempt-open");
  const controls = ok.filter((o) => !ATTEMPT_NOT_KEPT.includes(o.tag));
  Object.assign(summary, {
    attemptFailed: { ...failedSummary(failed), requestSavedKinds: kinds(requestSaved), byModel: Object.fromEntries([...new Set(failed.map((o) => o.model).filter(Boolean))].sort().map((m) => [m, failedSummary(failed.filter((o) => o.model === m))])) },
    attemptOpen: { turns: open.length, replyRead: frac(open, (o) => o.sent.replySent), savedAsDeadEnd: frac(open, (o) => o.judged.deadEnd), requestSaved: frac(open, (o) => o.judged.requestSaved), requestSavedAsDecisionOrTodo: frac(open, (o) => o.judged.requestSaved && ["decision", "todo"].includes(o.got.kind)), savedAsAnotherKindFromTheReply: frac(open, (o) => o.got.save && !o.judged.deadEnd && !o.judged.requestSaved), nothingSaved: frac(open, (o) => !o.got.save) },
    attemptWorked: controlSummary(tag("attempt-worked")),
    decisionRequest: controlSummary(tag("decision-request")),
    ordinary: controlSummary(tag("ordinary")),
    otherTags: Object.fromEntries([...new Set(ok.map((o) => o.tag))].filter((t) => !["attempt-failed", "attempt-open", "attempt-worked", "decision-request", "ordinary"].includes(t)).map((t) => [t, controlSummary(tag(t))])),
    allControls: controlSummary(controls),
    deadEndLines: deadEnds.length,
  });
}

const report = {
  kind: SENT_ONLY ? "attempts-sent-only" : "attempts",
  set: FILE,
  label: LABEL,
  date: new Date().toISOString().slice(0, 10),
  jevmem_version: version,
  commit,
  dist: path.relative(process.cwd(), path.resolve(distArg)),
  baseline: BASELINE,
  turns: rows.length,
  machine: `${process.platform} ${process.arch}, node ${process.version}, ${os.cpus()[0]?.model ?? "cpu"}`,
  network_path: `direct HTTPS to ${process.env.TYPESAFE_BASE_URL ?? "the TypeSafe API default base URL"}, warm in-process client, cache off`,
  cost_method: "input tokens × $0.042 per million; output tokens free",
  judge: SENT_ONLY ? "none: only what each request's state holds, the tokens and the time are recorded; no label is read and no outcome is written" : "in code: reasonKeys / factKeys / requestKeys substring checks (case-insensitive), no LLM",
  summary,
  rows: out,
};
if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
}
const s = summary;
console.log(`${FILE} (n=${rows.length}), mode ${MODE}, ${report.dist}${version ? ` (${version})` : ""}${commit ? `, commit ${commit}` : ""}${s.errors ? `, ${s.errors} errors` : ""}`);
if (!SENT_ONLY) {
  const f = s.attemptFailed;
  console.log(`failed attempts (${f.turns}): reply read ${f.replyRead}; saved as a dead end ${f.savedAsDeadEnd}, with the reason ${f.deadEndWithReason} (of the dead-end lines: reason ${f.deadEndKeepsReason}, what was tried ${f.deadEndSaysWhatWasTried}); the request saved ${f.requestSaved} (as a decision or a to-do ${f.requestSavedAsDecisionOrTodo}); another kind from the reply ${f.savedAsAnotherKindFromTheReply}; nothing saved ${f.nothingSaved}`);
  for (const [m, v] of Object.entries(f.byModel)) console.log(`  ${m.padEnd(28)} dead end ${v.savedAsDeadEnd.padEnd(6)} with reason ${v.deadEndWithReason.padEnd(6)} request saved ${v.requestSaved.padEnd(6)} nothing ${v.nothingSaved}`);
  const o = s.attemptOpen;
  if (o.turns) console.log(`attempts left open (${o.turns}): reply read ${o.replyRead}; saved as a dead end ${o.savedAsDeadEnd}; the request saved ${o.requestSaved} (as a decision or a to-do ${o.requestSavedAsDecisionOrTodo}); another kind from the reply ${o.savedAsAnotherKindFromTheReply}; nothing saved ${o.nothingSaved}`);
  const c = (name, v) => console.log(`${name} (${v.turns}): reply read ${v.replyRead}; save/skip right ${v.saveSkipRight}, accepted kind ${v.savedAsAccepted}, saved as a dead end ${v.savedAsDeadEnd}${v.sameSaveAndKindAsBaseline ? `; same save and kind as the baseline ${v.sameSaveAndKindAsBaseline}, same line ${v.sameLineAsBaseline}` : ""}`);
  c("attempts that worked", s.attemptWorked);
  c("decisions given as a request", s.decisionRequest);
  c("ordinary turns", s.ordinary);
  for (const [t, v] of Object.entries(s.otherTags)) c(t, v);
}
console.log(`reply sent in ${s.sent.replySent} turns (${((s.sent.replySentShare ?? 0) * 100).toFixed(1)}%), ${s.sent.meanReplyCharsWhenSent} characters of it on average when sent (most ${s.sent.maxReplyCharsSent}); ${s.sent.decideCallsPerTurn?.toFixed(2)} decide calls per turn`);
console.log(`per turn: decide p50 ${s.perTurn.decideP50ms} ms, p95 ${s.perTurn.decideP95ms} ms, ${s.perTurn.meanInputTokens} input tokens, $${s.perTurn.costPerTurnUsd.toFixed(7)}${s.perTurn.costPerTurnWithLineUsd !== undefined ? ` ($${s.perTurn.costPerTurnWithLineUsd.toFixed(7)} with the line's request)` : ""}`);
if (OUT) console.log(`\nwritten ${OUT}`);
