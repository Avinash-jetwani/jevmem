#!/usr/bin/env node
// False supersedes (0.6 prep): plain statements and questions next to a related saved line they do not contradict
// (added details, restatements, compatible additions, questions about the line), with real reversals as controls.
// eval/supersede-dev.jsonl is for tuning; eval/supersede-heldout.jsonl was written before any change and is run once on
// main before the change and once after it. Any row of the dead-end sets' shape works with --file (a row without
// `contradicts` must not supersede anything), so eval/dead-ends-dev-v3.jsonl can be checked the same way.
//
//   node scripts/eval-supersede.mjs [path/to/dist/index.js] [--set dev|heldout | --file eval/….jsonl] [--mode auto|fast|full] [--out results/…json]
//
// Every turn goes through the hook's path with the real Jev, as scripts/eval-dead-ends.mjs does: `decide` (warm
// in-process client, no cache), then `writeMemory` with the local writer into a scratch JEVMEM.md holding the turn's
// existing lines, so a supersede happens as in the hook. Reported: false supersedes among the rows that must not
// supersede (by subtype), and reversals superseded (found, wrong id, missed); per row, the contradiction family, both
// tiers' contradiction nouls and the line Jev said the turn touches. Cost per decision is input tokens × $0.042/M.
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
const FILE = opt("--file", null) ?? { dev: "eval/supersede-dev.jsonl", heldout: "eval/supersede-heldout.jsonl" }[SET];
if (!FILE) throw new Error(`unknown --set ${SET}`);
const MODE = opt("--mode", "auto");
const OUT = opt("--out", null);
const USD_PER_M_INPUT = 0.042;
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const lib = await import(pathToFileURL(path.resolve(distArg)).href);
const rows = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
let commit = null;
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src", { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {}
const meta = { kind: "supersede", date: new Date().toISOString().slice(0, 10), commit, dist: path.relative(process.cwd(), path.resolve(distArg)), set: FILE, mode: MODE, turns: rows.length, machine: `${process.platform} ${process.arch}, node ${process.version}, ${os.cpus()[0]?.model ?? "cpu"}`, cost_method: `input tokens × $${USD_PER_M_INPUT}/M (decide and the line's request)` };

const jev = lib.createJev({ noLogFile: true, cache: false });
try {
  await lib.decide(jev, { userMessage: "warm-up", existingMemories: [] }, { tiers: { mode: MODE } });
} catch {}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-supersede-"));
const out = [];
const startedAt = new Date().toISOString();
for (const r of rows) {
  const root = fs.mkdtempSync(path.join(tmp, "p-"));
  const store = new lib.MemoryStore(root);
  for (const m of r.existing) store.add({ id: m.id, kind: m.kind, text: m.text, conf: 0.9, ts: "2026-09-01T00:00:00.000Z" });
  const t0 = performance.now();
  const d = await lib.decide(jev, { userMessage: r.user, assistantReply: r.assistant, recentContext: r.previous, existingMemories: store.active() }, { tiers: { mode: MODE } });
  const ms = Math.round(performance.now() - t0);
  let got = { save: false, kind: "none", line: null, superseded: null };
  let lineTokens = 0;
  if (d.save) {
    const at = jev.log.length;
    const w = await lib.writeMemory(store, d.sourceText || lib.mergeTurn(r.user, r.assistant), d, { writer: { provider: "none", maxChars: 200, timeoutMs: 1000 }, env: {}, jev });
    lineTokens = jev.log.slice(at).filter((e) => !e.event).reduce((a, e) => a + (e.inputTokens ?? 0), 0);
    got = w.saved ? { save: true, kind: w.saved.kind, line: w.line, superseded: w.superseded?.id ?? null } : { save: false, kind: "none", line: w.line, superseded: null };
  }
  const want = r.contradicts ?? null;
  out.push({
    id: r.id, tag: r.tag, subtype: r.subtype, user: r.user,
    want: { contradicts: want, accept: r.accept },
    got,
    ok: want ? got.superseded === want : !got.superseded,
    kindOk: r.accept.includes(got.save ? got.kind : "skip"),
    ms, inputTokens: d.usage.inputTokens + lineTokens, escalated: Boolean(d.escalated), source: d.source ?? null,
    reason: d.reason,
    touches: d.touchesMemoryId, contradictionFamily: d.families?.contradiction ?? null,
    tier1Contradicts: d.tier1?.nouls?.contradicts_existing_memory ?? null,
    tier2Reverses: d.tier2?.nouls?.reverses_or_replaces_a_listed_memory ?? null,
  });
  process.stderr.write(out.at(-1).ok ? "." : "x");
}
process.stderr.write("\n");
fs.rmSync(tmp, { recursive: true, force: true });
const must = out.filter((o) => !o.want.contradicts);
const revs = out.filter((o) => o.want.contradicts);
const bySubtype = {};
for (const o of must) {
  const t = (bySubtype[o.subtype ?? o.tag] ??= { cases: 0, superseded: 0 });
  t.cases++;
  if (o.got.superseded) t.superseded++;
}
const tokens = out.reduce((a, o) => a + o.inputTokens, 0);
const summary = {
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  falseSupersedes: `${must.filter((o) => o.got.superseded).length}/${must.length}`,
  falseBySubtype: bySubtype,
  reversals: { cases: revs.length, found: revs.filter((o) => o.got.superseded === o.want.contradicts).length, wrongId: revs.filter((o) => o.got.superseded && o.got.superseded !== o.want.contradicts).length, missed: revs.filter((o) => !o.got.superseded).length },
  reversalsFound: `${revs.filter((o) => o.got.superseded === o.want.contradicts).length}/${revs.length}`,
  kindAsLabelled: `${out.filter((o) => o.kindOk).length}/${out.length}`,
  p50ms: [...out.map((o) => o.ms)].sort((a, b) => a - b)[Math.floor(out.length / 2)],
  costPerDecisionUsd: Number(((tokens / out.length) * USD_PER_M_INPUT / 1e6).toFixed(7)),
};
const result = { ...meta, summary, rows: out };
console.log(`${FILE} (${MODE}, ${commit}): false supersedes ${summary.falseSupersedes} ${JSON.stringify(bySubtype)}; reversals ${summary.reversalsFound} (wrong id ${summary.reversals.wrongId}, missed ${summary.reversals.missed}); kind as labelled ${summary.kindAsLabelled}; p50 ${summary.p50ms} ms; $${summary.costPerDecisionUsd}/decision`);
for (const o of out.filter((x) => !x.ok))
  console.log(`  ✗ ${o.id.padEnd(22)} ${String(o.subtype).padEnd(20)} want ${o.want.contradicts ? `⊃${o.want.contradicts}` : "no supersede"} got ${o.got.save ? o.got.kind : "skip"}${o.got.superseded ? ` ⊃${o.got.superseded}` : ""}  c=${o.contradictionFamily?.toFixed(2)} t1=${o.tier1Contradicts?.toFixed(2) ?? "-"} t2=${o.tier2Reverses?.toFixed(2) ?? "-"} ${o.reason}`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 1) + "\n");
