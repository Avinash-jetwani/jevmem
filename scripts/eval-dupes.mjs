#!/usr/bin/env node
// Dedupe on save (0.7.0): restatements of a live line must not be saved, restatements that add a detail must be saved,
// reversals must supersede, a restated retired line must be saved again, and unrelated turns are saved or skipped as
// today. eval/dupes-dev.jsonl is for tuning; eval/dupes-heldout.jsonl was written in other projects before any code
// and is run once on the build that ships and once on 0.6.6 from npm, for the before.
//
//   node scripts/eval-dupes.mjs [path/to/dist/index.js] [--set dev|heldout | --file eval/….jsonl] [--mode auto|fast|full] [--out results/…json]
//
// Every turn goes through the hook's own path (`evaluateTurn`: decide, the local duplicate check, the writer, the
// exact-duplicate drop) with the real Jev (warm in-process client, cache off), in a scratch project whose JEVMEM.md
// holds the row's live lines and, as `[retired]` lines, its retired ones. Reported per tag: duplicates not saved (and
// how: before any request, by Jev's question, or by the exact match after writing), details still saved, reversals
// superseded, retired lines saved again, unrelated turns as labelled; how many decide requests carried the new
// question; p50 latency and cost per message (input tokens × $0.042/M, decide and the line's request); and a sweep of
// the duplicate threshold over the recorded answers, for a build that records them (`decision.duplicate`).
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
const FILE = opt("--file", null) ?? { dev: "eval/dupes-dev.jsonl", heldout: "eval/dupes-heldout.jsonl" }[SET];
if (!FILE) throw new Error(`unknown --set ${SET}`);
const MODE = opt("--mode", "auto");
const OUT = opt("--out", null);
const USD_PER_M_INPUT = 0.042;
const SWEEP = [0.5, 0.6, 0.7, 0.8, 0.9];
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const lib = await import(pathToFileURL(path.resolve(distArg)).href);
const rows = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
let commit = null;
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src", { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {}
// The version of the build measured: the nearest package.json named jevmem above the dist file.
let version = null;
for (let d = path.dirname(path.resolve(distArg)); d !== path.dirname(d); d = path.dirname(d)) {
  const p = path.join(d, "package.json");
  if (fs.existsSync(p)) {
    const pj = JSON.parse(fs.readFileSync(p, "utf8"));
    if (pj.name === "jevmem") { version = pj.version; break; }
  }
}
const meta = { kind: "dupes", date: new Date().toISOString().slice(0, 10), commit, jevmem_version: version, dist: path.relative(process.cwd(), path.resolve(distArg)), set: FILE, mode: MODE, turns: rows.length, machine: `${process.platform} ${process.arch}, node ${process.version}, ${os.cpus()[0]?.model ?? "cpu"}`, cost_method: `input tokens × $${USD_PER_M_INPUT}/M (decide and the line's request)` };

const DUP_NOUL = "restates_a_listed_memory";
const inner = lib.createJev({ noLogFile: true, cache: false });
// Count the decide requests, and how many carried the duplicate question.
let calls = 0, asked = 0;
const jev = { ...inner, log: inner.log, call: (state, questions, o) => { if (o?.label === "decide") { calls++; if (DUP_NOUL in questions) asked++; } return inner.call(state, questions, o); } };
try {
  await lib.decide(inner, { userMessage: "warm-up", existingMemories: [] }, { tiers: { mode: MODE } });
} catch {}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-dupes-"));
const TS = "2026-09-01T00:00:00.000Z";
const out = [];
const startedAt = new Date().toISOString();
const RESTATEMENTS = new Set(["verbatim", "paraphrase", "tagged", "quoted"]);
for (const r of rows) {
  const root = fs.mkdtempSync(path.join(tmp, "p-"));
  lib.writeDefaultConfig(root);
  const cfg = lib.loadConfig(root);
  if (MODE !== "auto") cfg.tiers = { ...cfg.tiers, mode: MODE };
  const store = new lib.MemoryStore(root);
  for (const m of r.existing) store.add({ id: m.id, kind: m.kind, text: m.text, conf: 0.9, ts: TS });
  // Retired lines, as 0.7.0 writes them: the kind is `retired`, the text unchanged. A build that does not know the kind
  // keeps the line as text and never lists it.
  if (r.retired?.length) fs.appendFileSync(path.join(root, "JEVMEM.md"), r.retired.map((m) => `- [retired] ${m.text}  <!-- id:${m.id} ts:${TS} conf:0.90 was:${m.kind} retired:${TS} -->`).join("\n") + "\n");
  const message = lib.mergeTurn(r.user, r.assistant ?? "");
  const hash = `dupes-${r.id}`;
  const at = jev.log.length;
  const callsBefore = calls;
  const t0 = performance.now();
  const o = await lib.evaluateTurn(store, cfg, jev, { hash, user: r.user, assistant: r.assistant ?? "", previous: "" }, { env: {} });
  const ms = Math.round(performance.now() - t0);
  const d = o.decision ?? {};
  const after = store.read().memories;
  const superseded = after.find((m) => m.kind === "superseded" && r.existing.some((e) => e.id === m.id))?.id ?? null;
  const saved = o.action === "saved";
  const dupMatch = /duplicate of ([a-z0-9]+)/.exec(o.detail ?? "");
  const duplicateOf = dupMatch ? dupMatch[1] : null;
  const how = !duplicateOf ? null : (calls - callsBefore) === 0 ? "local" : d.duplicate?.applied ? "jev" : "exact";
  const got = { save: saved, kind: saved ? (d.kind ?? null) : "none", line: saved ? o.detail.replace(/^\[[a-z-]+\] /, "").replace(/ id:.*$/, "") : null, superseded, duplicateOf, how };
  const w = r.want;
  const ok = RESTATEMENTS.has(r.tag) ? !saved
    : r.tag === "detail" ? saved && !superseded
    : r.tag === "reversal" ? saved && superseded === w.supersedes
    : r.tag === "retired" ? saved && !duplicateOf
    : saved === Boolean(w.save);
  const inputTokens = jev.log.slice(at).filter((e) => !e.event).reduce((a, e) => a + (e.inputTokens ?? 0), 0);
  // The base decision without the duplicate rule, for the sweep: the skip reasons other than the duplicate one.
  const reasons = String(d.reason ?? "").startsWith("skip: ") ? String(d.reason).slice(6).replace(/ \[tier .*$/, "").replace(/ \[reply question.*$/, "").split(", ") : [];
  const otherSkip = reasons.filter((s) => !/^duplicate of /.test(s)).length > 0;
  const baseSave = saved || (!otherSkip && Boolean(d.duplicate?.applied));
  out.push({
    id: r.id, tag: r.tag, subtype: r.subtype ?? null, user: r.user, want: w, got, ok,
    ms, inputTokens, decideCalls: calls - callsBefore, escalated: Boolean(d.escalated), reason: d.reason ?? o.detail,
    dupNoul: d.duplicate?.noul ?? null, dupId: d.duplicate?.id ?? null, dupApplied: Boolean(d.duplicate?.applied), baseSave,
    touches: d.touchesMemoryId ?? null, contradictionFamily: d.families?.contradiction ?? null,
  });
  process.stderr.write(ok ? "." : "x");
}
process.stderr.write("\n");
fs.rmSync(tmp, { recursive: true, force: true });

const byTag = {};
for (const o of out) {
  const t = (byTag[o.tag] ??= { cases: 0, ok: 0 });
  t.cases++;
  if (o.ok) t.ok++;
}
const rest = out.filter((o) => RESTATEMENTS.has(o.tag));
const details = out.filter((o) => o.tag === "detail");
const revs = out.filter((o) => o.tag === "reversal");
const retired = out.filter((o) => o.tag === "retired");
const unrelated = out.filter((o) => o.tag === "unrelated");
const frac = (n, m) => `${n}/${m}`;
const byHow = {};
for (const o of rest.filter((o) => !o.got.save)) byHow[o.got.how ?? "skipped for another reason"] = (byHow[o.got.how ?? "skipped for another reason"] ?? 0) + 1;
const tokens = out.reduce((a, o) => a + o.inputTokens, 0);
// The sweep: for each threshold, the rows the duplicate rule would stop (base decision save, the question at or above
// the threshold, a listed live id picked, no contradiction), counted where that is right and where it is wrong.
const sweep = {};
if (out.some((o) => o.dupNoul !== null)) {
  for (const t of SWEEP) {
    const stops = (o) => o.baseSave && o.dupNoul !== null && o.dupNoul >= t && o.dupId && (o.contradictionFamily ?? 0) < 0.7;
    sweep[String(t)] = {
      duplicatesStopped: frac(rest.filter((o) => stops(o) || o.got.how === "local" || o.got.how === "exact").length, rest.length),
      detailsLost: frac(details.filter(stops).length, details.length),
      reversalsLost: frac(revs.filter(stops).length, revs.length),
      retiredLost: frac(retired.filter(stops).length, retired.length),
      unrelatedLost: frac(unrelated.filter((o) => o.want.save && stops(o)).length, unrelated.filter((o) => o.want.save).length),
    };
  }
}
const summary = {
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  duplicatesNotSaved: frac(rest.filter((o) => !o.got.save).length, rest.length),
  duplicatesByHow: byHow,
  detailsSaved: frac(details.filter((o) => o.ok).length, details.length),
  reversalsSuperseded: frac(revs.filter((o) => o.ok).length, revs.length),
  retiredSavedAgain: frac(retired.filter((o) => o.ok).length, retired.length),
  unrelatedAsLabelled: frac(unrelated.filter((o) => o.ok).length, unrelated.length),
  byTag,
  questionAsked: frac(asked, calls),
  questionAskedShare: calls ? Number((asked / calls).toFixed(3)) : 0,
  decideCalls: calls,
  p50ms: [...out.map((o) => o.ms)].sort((a, b) => a - b)[Math.floor(out.length / 2)],
  costPerMessageUsd: Number(((tokens / out.length) * USD_PER_M_INPUT / 1e6).toFixed(7)),
  sweep,
};
const result = { ...meta, summary, rows: out };
console.log(`${FILE} (${MODE}, ${version ?? "?"} ${commit}): duplicates not saved ${summary.duplicatesNotSaved} ${JSON.stringify(byHow)}; details saved ${summary.detailsSaved}; reversals superseded ${summary.reversalsSuperseded}; retired saved again ${summary.retiredSavedAgain}; unrelated as labelled ${summary.unrelatedAsLabelled}; the question in ${summary.questionAsked} decide requests; p50 ${summary.p50ms} ms; $${summary.costPerMessageUsd}/message`);
if (Object.keys(sweep).length) for (const [t, s] of Object.entries(sweep)) console.log(`  threshold ${t}: duplicates stopped ${s.duplicatesStopped}, details lost ${s.detailsLost}, reversals lost ${s.reversalsLost}, retired lost ${s.retiredLost}, unrelated saves lost ${s.unrelatedLost}`);
for (const o of out.filter((x) => !x.ok))
  console.log(`  ✗ ${o.id.padEnd(16)} ${o.tag.padEnd(10)} got ${o.got.save ? `saved ${o.got.kind}` : "not saved"}${o.got.superseded ? ` ⊃${o.got.superseded}` : ""}${o.got.duplicateOf ? ` dup ${o.got.duplicateOf} (${o.got.how})` : ""}  noul=${o.dupNoul?.toFixed(2) ?? "-"} id=${o.dupId ?? "-"} touches=${o.touches ?? "-"} c=${o.contradictionFamily?.toFixed(2) ?? "-"}  ${o.reason}`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 1) + "\n");
