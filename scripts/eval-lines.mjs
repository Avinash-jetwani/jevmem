#!/usr/bin/env node
// The text of a saved line (v0.6 part 3c): what a build writes for turns that are saved, judged against labels, and
// genuine rules stated with an instruction against planted-line turns.
//
//   node scripts/eval-lines.mjs [path/to/dist/index.js] [--set dev|heldout|rules-dev|rules-heldout|cause-last-dev|cause-last-heldout] [--mode auto|fast|full] [--label now] [--out results/…json]
//
// Sets: eval/lines-dev.jsonl (tuning) and eval/lines-heldout.jsonl (run once at the end, on the final code and on 0.5.9),
// eval/rules-dev.jsonl (tuning) and eval/rules-heldout.jsonl (run once at the end). Every row is one turn with the
// project's memory lines.
// The cause-last sets (0.6.5): replies that give the verdict first and the cause, or what was changed, last.
// eval/cause-last-dev.jsonl (tuning) holds the real replies of the 0.6.5 release gate's second full run, where a
// dead-end line lost its reason; eval/cause-last-heldout.jsonl (run once on the fixed build and once on 0.6.4) holds
// turns written in that style before the writer changed. A row with `worksNow` makes a listed dead end work: its
// `fact` is the sentence that says what was changed, and the writer-on-the-label step writes it as the hook does for
// such a turn (the dead end's line given, the line asked for as what works now).
//
// Each row goes through the hook's path with the real Jev (warm in-process client, cache off), in a scratch project that
// holds the row's lines: `decide`, then, when it saves, `writeMemory` with jevmem's own writer (writer.provider none),
// given the build's Jev client (a build that asks Jev nothing when it writes ignores it). That is the line a user gets.
// For the line-text sets the same row is also written once from the labelled kind and the text the hook gives the
// writer when decide reads the content source as labelled (`source`): the line the build writes when decide agrees with
// the label, so two builds are compared on the same input.
//
// Judged in code, with no LLM: a line states the fact when it contains one of the row's `factKeys`, keeps the reason
// when it contains one of its `reasonKeys` (rows with a reason), carries a request when it contains one of its
// `junkKeys`, and is a junk line when it does not state the fact and is one of the requests, hand-offs or instructions
// the row lists (`junk`), whole or in part. A reason "fits" when the fact's sentence and the reason's sentence together
// are at most 200 characters (or the reason is in the fact's own sentence and that sentence fits). When the build
// reports which sentences Jev picked (`pick`), the pick is checked against the labelled sentences too.
// Cost = input tokens × $0.042/M (Jev bills input tokens only); latency is wall time around each step.
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
const FILE = { dev: "eval/lines-dev.jsonl", heldout: "eval/lines-heldout.jsonl", "rules-dev": "eval/rules-dev.jsonl", "rules-heldout": "eval/rules-heldout.jsonl", "cause-last-dev": "eval/cause-last-dev.jsonl", "cause-last-heldout": "eval/cause-last-heldout.jsonl" }[SET];
if (!FILE) throw new Error(`unknown --set ${SET}`);
const RULES = SET.startsWith("rules");
const MODE = opt("--mode", "auto");
const LABEL = opt("--label", null);
const OUT = opt("--out", null);
const USD_PER_M_INPUT = 0.042;
const MAX = 200;
const lib = await import(pathToFileURL(path.resolve(distArg)).href);
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const rows = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

let commit = null;
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src", { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {}
let version = null;
try {
  let dir = path.dirname(path.resolve(distArg));
  for (let i = 0; i < 3 && !version; i++, dir = path.dirname(dir)) if (fs.existsSync(path.join(dir, "package.json"))) version = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version ?? null;
} catch {}

const lower = (s) => String(s ?? "").toLowerCase();
const norm = (s) => lower(s).replace(/[^a-z0-9]+/g, " ").trim();
const hasKey = (line, keys) => (keys ?? []).some((k) => lower(line).includes(lower(k)));
const writerInput = (r) => (r.source === "user" ? r.user : r.source === "assistant" ? r.assistant : lib.mergeTurn(r.user, r.assistant));
const reasonFits = (r) => (r.reason ? (r.reasonSame ? r.fact[0].length <= MAX : r.fact[0].length + 1 + r.reason.length <= MAX) : null);
/** A line that is one of the row's requests, hand-offs or instructions, whole or in part (and states no fact). */
function isJunk(r, line) {
  if (!line || hasKey(line, r.factKeys)) return false;
  if (hasKey(line, r.junkKeys)) return true;
  const nl = norm(line);
  return (r.junk ?? []).some((j) => {
    const nj = norm(j);
    return nj.length > 0 && (nj.includes(nl) || nl.includes(nj) || nl.startsWith(nj.slice(0, 24)));
  });
}
function judge(r, line) {
  if (!line) return { line: null, statesFact: false, keepsReason: r.reason ? false : null, carriesRequest: false, junk: false };
  return { line, chars: line.length, statesFact: hasKey(line, r.factKeys), keepsReason: r.reason ? hasKey(line, r.reasonKeys) : null, carriesRequest: hasKey(line, r.junkKeys), junk: isJunk(r, line), endsInEllipsis: line.endsWith("…") };
}
/** Did Jev's pick (when the build reports one) choose a sentence the labels say states the memory? */
function judgePick(r, pick) {
  if (!pick || !Array.isArray(pick.chosen)) return null;
  const text = (id) => pick.sentences?.find((s) => s.id === id)?.text ?? "";
  const statesIt = (t) => hasKey(t, r.factKeys) || r.fact.some((f) => norm(f).includes(norm(t)) || norm(t).includes(norm(f)));
  const main = pick.main ? text(pick.main) : "";
  return {
    asked: Boolean(pick.asked),
    candidates: pick.sentences?.length ?? 0,
    main: pick.main ?? null,
    second: pick.second ?? null,
    mainStatesFact: pick.main ? statesIt(main) : null,
    mainIsJunk: pick.main ? (r.junk ?? []).some((j) => norm(j) === norm(main) || norm(main).includes(norm(j))) && !statesIt(main) : null,
    secondIsReason: r.reason && pick.second ? hasKey(text(pick.second), r.reasonKeys) : null,
    error: pick.error ?? null,
  };
}

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
try {
  await lib.decide(jev, { userMessage: "warm-up", existingMemories: [] }, { tiers: { mode: MODE } });
} catch {}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-lines-"));
const writer = { provider: "none", maxChars: MAX, timeoutMs: 1000 };
const out = [];
const startedAt = new Date().toISOString();
for (const r of rows) {
  const root = fs.mkdtempSync(path.join(tmp, "p-"));
  const store = new lib.MemoryStore(root);
  for (const m of r.existing) store.add({ id: m.id, kind: m.kind, text: m.text, conf: 0.9, ts: "2026-09-01T00:00:00.000Z" });
  const row = { id: r.id, tag: r.tag, subtype: r.subtype, want: { ...r.label, accept: r.accept, source: r.source } };
  try {
    const t0 = performance.now();
    const logAt = jev.log.length;
    const d = await withRetry(() => lib.decide(jev, { userMessage: r.user, assistantReply: r.assistant, existingMemories: store.active() }, { tiers: { mode: MODE } }));
    const decideMs = Math.round(performance.now() - t0);
    const decideTokens = d.usage.inputTokens;
    const decideCalls = jev.log.slice(logAt).filter((e) => e.ok && !e.event).length;
    row.decide = { save: d.save, kind: d.save ? d.kind : "none", source: d.source, assistantIncluded: d.assistantIncluded, reason: d.reason, ms: decideMs, inputTokens: decideTokens, calls: decideCalls, injection: d.families?.injection ?? null, injectionNouls: Object.fromEntries(Object.entries(d.nouls ?? {}).filter(([k]) => /instruction|authority|store_or_alter|addressed_to_an_ai|automated_system/.test(k))), tier: d.tier, escalated: Boolean(d.escalated) };
    if (d.save) {
      const w0 = performance.now();
      const at = jev.log.length;
      const w = await lib.writeMemory(store, d.sourceText || lib.mergeTurn(r.user, r.assistant), d, { writer, env: {}, jev });
      const entries = jev.log.slice(at).filter((e) => !e.event);
      row.pipeline = { ...judge(r, w.line), kind: w.saved?.kind ?? d.kind, writerUsed: w.writerUsed, writerNote: w.writerNote ?? null, pick: w.pick ?? null, pickJudged: judgePick(r, w.pick), writeMs: Math.round(performance.now() - w0), writeCalls: entries.length, writeInputTokens: entries.reduce((a, e) => a + (e.inputTokens ?? 0), 0), writeFailedCalls: entries.filter((e) => !e.ok).length };
    } else row.pipeline = null;
    if (!RULES) {
      const w0 = performance.now();
      const at = jev.log.length;
      // As writeMemory calls it: a text from the reply alone is cut where decide cuts the reply (an older build ignores it).
      const deadEnd = r.worksNow ? r.existing.find((m) => m.id === r.worksNow)?.text : undefined;
      const c = await lib.composeLine(writerInput(r), r.label.kind, { writer, env: {}, jev }, { fromReply: r.source === "assistant", ...(r.worksNow ? { worksNow: true, deadEnd } : {}) });
      const entries = jev.log.slice(at).filter((e) => !e.event);
      row.writer = { ...judge(r, c.line), pick: c.pick ?? null, pickJudged: judgePick(r, c.pick), note: c.note ?? null, ms: Math.round(performance.now() - w0), calls: entries.length, inputTokens: entries.reduce((a, e) => a + (e.inputTokens ?? 0), 0), failedCalls: entries.filter((e) => !e.ok).length };
    }
  } catch (err) {
    row.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  row.reasonFits = reasonFits(r);
  out.push(row);
  const p = row.pipeline;
  process.stderr.write(`${r.id.padEnd(24)} ${row.error ? `ERROR ${row.error}` : row.decide.save ? `${row.decide.kind.padEnd(12)} ${p.statesFact ? "fact" : "----"} ${r.reason ? (p.keepsReason ? "why " : "--- ") : "    "}${p.junk ? "JUNK " : ""}${p.line}` : `skip  ${row.decide.reason}`}\n`);
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

function lineSummary(items, get) {
  const withLine = items.filter((o) => get(o)?.line);
  const reasons = items.filter((o) => rows.find((r) => r.id === o.id).reason);
  const fits = reasons.filter((o) => o.reasonFits);
  const deadEnds = items.filter((o) => o.tag === "dead-end-but");
  const picks = items.map((o) => get(o)?.pickJudged).filter((p) => p && p.asked);
  return {
    turns: items.length,
    withLine: withLine.length,
    statesFact: frac(items, (o) => get(o)?.statesFact),
    keepsReason: frac(reasons, (o) => get(o)?.keepsReason),
    keepsReasonWhereItFits: frac(fits, (o) => get(o)?.keepsReason),
    deadEndsKeepReason: frac(deadEnds, (o) => get(o)?.keepsReason),
    junk: frac(items, (o) => get(o)?.junk),
    carriesRequest: frac(items, (o) => get(o)?.carriesRequest),
    endsInEllipsis: frac(withLine, (o) => get(o)?.endsInEllipsis),
    meanChars: Math.round(mean(withLine.map((o) => get(o).chars)) ?? 0),
    ...(picks.length ? { jevPicked: picks.length, pickMainStatesFact: `${picks.filter((p) => p.mainStatesFact).length}/${picks.length}`, pickMainIsJunk: `${picks.filter((p) => p.mainIsJunk).length}/${picks.length}`, pickFailed: picks.filter((p) => p.error).length } : {}),
  };
}
const byTag = (items, get) => Object.fromEntries([...new Set(items.map((o) => o.tag))].map((t) => [t, lineSummary(items.filter((o) => o.tag === t), get)]));

const ok = out.filter((o) => !o.error);
const saved = ok.filter((o) => o.decide.save);
const summary = { mode: MODE, started_at: startedAt, finished_at: finishedAt, errors: out.length - ok.length };
if (RULES) {
  const genuine = ok.filter((o) => o.tag === "genuine-rule");
  const planted = ok.filter((o) => o.tag === "planted");
  const inj = (o) => o.decide.injection ?? 0;
  Object.assign(summary, {
    genuineSaved: frac(genuine, (o) => o.decide.save),
    genuineSavedAsAccepted: frac(genuine, (o) => o.decide.save && o.want.accept.includes(o.decide.kind)),
    genuineSkippedForInjection: frac(genuine, (o) => !o.decide.save && /injection=/.test(o.decide.reason)),
    plantedSkipped: frac(planted, (o) => !o.decide.save),
    plantedSkippedForInjection: frac(planted, (o) => !o.decide.save && /injection=/.test(o.decide.reason)),
    genuineInjection: { mean: mean(genuine.map(inj)), max: Math.max(...genuine.map(inj)) },
    plantedInjection: { mean: mean(planted.map(inj)), min: Math.min(...planted.map(inj)) },
    genuineLines: lineSummary(genuine, (o) => o.pipeline),
  });
} else {
  Object.assign(summary, {
    saved: frac(ok, (o) => o.decide.save),
    savedAsAccepted: frac(ok, (o) => o.decide.save && o.want.accept.includes(o.pipeline?.kind)),
    pipeline: { savedTurns: lineSummary(saved, (o) => o.pipeline), allTurns: lineSummary(ok, (o) => o.pipeline), byTag: byTag(saved, (o) => o.pipeline) },
    writer: { ...lineSummary(ok, (o) => o.writer), byTag: byTag(ok, (o) => o.writer) },
  });
}
// Latency and cost per saved turn: decide, the write step (Jev's pick, when the build asks), and both.
const perSaved = saved.map((o) => ({ decideMs: o.decide.ms, writeMs: o.pipeline.writeMs, decideTokens: o.decide.inputTokens, writeTokens: o.pipeline.writeInputTokens, writeCalls: o.pipeline.writeCalls }));
summary.perSavedTurn = {
  savedTurns: perSaved.length,
  writeCallsPerSavedTurn: mean(perSaved.map((x) => x.writeCalls)),
  decideP50ms: pctl(perSaved.map((x) => x.decideMs), 0.5), decideP95ms: pctl(perSaved.map((x) => x.decideMs), 0.95),
  writeP50ms: pctl(perSaved.map((x) => x.writeMs), 0.5), writeP95ms: pctl(perSaved.map((x) => x.writeMs), 0.95),
  totalP50ms: pctl(perSaved.map((x) => x.decideMs + x.writeMs), 0.5), totalP95ms: pctl(perSaved.map((x) => x.decideMs + x.writeMs), 0.95),
  decideCostUsd: usd(mean(perSaved.map((x) => x.decideTokens)) ?? 0), writeCostUsd: usd(mean(perSaved.map((x) => x.writeTokens)) ?? 0), totalCostUsd: usd(mean(perSaved.map((x) => x.decideTokens + x.writeTokens)) ?? 0),
};
summary.perTurn = { turns: ok.length, costUsd: usd(mean(ok.map((o) => o.decide.inputTokens + (o.pipeline?.writeInputTokens ?? 0))) ?? 0), decideCostUsd: usd(mean(ok.map((o) => o.decide.inputTokens)) ?? 0) };

const report = {
  kind: RULES ? "rules" : "lines",
  set: FILE,
  label: LABEL,
  date: new Date().toISOString().slice(0, 10),
  jevmem_version: version,
  commit,
  dist: path.relative(process.cwd(), path.resolve(distArg)),
  turns: rows.length,
  machine: `${process.platform} ${process.arch}, node ${process.version}, ${os.cpus()[0]?.model ?? "cpu"}`,
  network_path: `direct HTTPS to ${process.env.TYPESAFE_BASE_URL ?? "the TypeSafe API default base URL"}, warm in-process client, cache off`,
  cost_method: "input tokens × $0.042 per million; output tokens free",
  judge: "in code: factKeys / reasonKeys / junkKeys substring checks (case-insensitive), no LLM",
  summary,
  rows: out,
};
if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
}
const s = summary;
console.log(`${FILE} (n=${rows.length}), mode ${MODE}, ${report.dist}${version ? ` (${version})` : ""}${commit ? `, commit ${commit}` : ""}${s.errors ? `, ${s.errors} errors` : ""}`);
if (RULES) {
  console.log(`genuine rules saved ${s.genuineSaved} (as an accepted kind ${s.genuineSavedAsAccepted}), skipped for injection ${s.genuineSkippedForInjection}; planted skipped ${s.plantedSkipped} (for injection ${s.plantedSkippedForInjection})`);
  console.log(`injection family: genuine mean ${s.genuineInjection.mean?.toFixed(2)} max ${s.genuineInjection.max?.toFixed(2)}; planted mean ${s.plantedInjection.mean?.toFixed(2)} min ${s.plantedInjection.min?.toFixed(2)}`);
  console.log(`genuine lines: states the rule ${s.genuineLines.statesFact}, junk ${s.genuineLines.junk}, carries the instruction ${s.genuineLines.carriesRequest}`);
} else {
  const pl = s.pipeline.savedTurns;
  const w = s.writer;
  console.log(`pipeline: saved ${s.saved} (accepted kind ${s.savedAsAccepted}); of saved turns: states the fact ${pl.statesFact}, keeps the reason ${pl.keepsReason} (where it fits ${pl.keepsReasonWhereItFits}; dead ends ${pl.deadEndsKeepReason}), junk ${pl.junk}, carries a request ${pl.carriesRequest}, ends in … ${pl.endsInEllipsis}${pl.jevPicked ? `; Jev picked ${pl.jevPicked}, main states the fact ${pl.pickMainStatesFact}, main is junk ${pl.pickMainIsJunk}, failed ${pl.pickFailed}` : ""}`);
  console.log(`writer on the labelled kind and source: states the fact ${w.statesFact}, keeps the reason ${w.keepsReason} (where it fits ${w.keepsReasonWhereItFits}; dead ends ${w.deadEndsKeepReason}), junk ${w.junk}, carries a request ${w.carriesRequest}, ends in … ${w.endsInEllipsis}, mean ${w.meanChars} chars${w.jevPicked ? `; Jev picked ${w.jevPicked}, main states the fact ${w.pickMainStatesFact}, main is junk ${w.pickMainIsJunk}, failed ${w.pickFailed}` : ""}`);
  for (const [t, v] of Object.entries(w.byTag)) console.log(`  writer ${t.padEnd(13)} fact ${v.statesFact.padEnd(6)} reason ${v.keepsReason.padEnd(6)} junk ${v.junk.padEnd(6)} request ${v.carriesRequest}`);
}
const ps = s.perSavedTurn;
console.log(`per saved turn (${ps.savedTurns}): decide p50 ${ps.decideP50ms} ms, write p50 ${ps.writeP50ms} ms (p95 ${ps.writeP95ms}), ${ps.writeCallsPerSavedTurn?.toFixed(2)} write calls; cost decide $${ps.decideCostUsd.toFixed(7)} + write $${ps.writeCostUsd.toFixed(7)} = $${ps.totalCostUsd.toFixed(7)}; per turn $${s.perTurn.costUsd.toFixed(7)} (decide alone $${s.perTurn.decideCostUsd.toFixed(7)})`);
if (!RULES) for (const o of ok.filter((x) => x.writer && (!x.writer.statesFact || x.writer.junk || (x.writer.keepsReason === false && x.reasonFits)))) console.log(`  ✗ ${o.id.padEnd(24)} ${o.tag.padEnd(13)} writer: ${o.writer.line}${o.writer.pick?.chosen ? `  [picked ${o.writer.pick.chosen.join("+")}]` : ""}`);
if (OUT) console.log(`\nwritten ${OUT}`);
