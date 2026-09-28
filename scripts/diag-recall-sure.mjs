#!/usr/bin/env node
// Where should the prompt hook's "sure" level sit (v0.6 part 3b)? Dev only.
//
//   node scripts/diag-recall-sure.mjs [--set-file eval/recall-dev.jsonl] [--out results/diag-recall-sure-dev-<date>.json]
//
// Two of the three direct prompts main missed on the part 3 held-out set were a second wanted line with a relevance of
// 0.95 or 0.96 that the choice gave 0.02 or 0.03: under RELEVANCE_SURE (0.97) and under recallMin (0.05), so pruned,
// while the first line took the choice. This asks Jev once per dev prompt with the hook's own questions (every live
// line, bare-id choice, one relevance noul per line, `replaces` context; in process, cache off), keeps every line's
// relevance and choice, and scores the selection rule offline for other sure levels and floors: recall, precision,
// unrelated prompts that got a line, and prompts needing two lines that got both. Superseded lines are never
// candidates.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const SET_FILE = opt("--set-file", "eval/recall-dev.jsonl");
const OUT = opt("--out", `results/diag-recall-sure-dev-${new Date().toISOString().slice(0, 10)}.json`);
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const lib = await import(pathToFileURL(path.resolve("dist/index.js")).href);
const rows = fs.readFileSync(SET_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const files = new Map(rows.filter((r) => r.row === "file").map((f) => [f.id, f]));
const jev = lib.createJev({ noLogFile: true, cache: false, timeoutMs: 15000 });

const answers = [];
for (const p of rows.filter((r) => r.row === "prompt")) {
  const f = files.get(p.file);
  const byKey = new Map(f.lines.map((l) => [l.key, l]));
  const mems = f.lines.map((l) => ({ id: l.id, kind: l.kind, text: l.text, ts: l.ts, conf: l.conf, ...(l.by ? { supersededBy: byKey.get(l.by).id } : {}) }));
  const live = mems.filter((m) => m.kind !== "superseded" && !m.supersededBy);
  const keyOf = new Map(f.lines.map((l) => [l.id, l.key]));
  let ranked = null;
  let error = null;
  for (let attempt = 0; attempt < 3 && !ranked; attempt++) {
    try {
      ranked = await lib.rankMemories(jev, p.prompt, live, { forPrompt: true, replaced: lib.replacedTexts(mems), timeoutMs: 15000 });
    } catch (err) {
      error = String(err?.message ?? err);
    }
  }
  answers.push({ id: p.id, file: p.file, type: p.type, want: p.want, ok: p.ok, error: ranked ? null : error, lines: ranked ? Object.fromEntries(ranked.filter((r) => (r.relevance ?? 0) >= 0.5 || r.choiceProbability >= 0.01).map((r) => [keyOf.get(r.memory.id), [r.relevance, r.choiceProbability]])) : null });
  process.stderr.write(`${p.id} ${ranked ? "" : "FAILED " + error}\n`);
}

function score(sure, min, relMin = 0.8) {
  let wanted = 0, hits = 0, injected = 0, good = 0, unrel = 0, unrelHit = 0, two = 0, twoBoth = 0;
  const wrong = [];
  for (const a of answers.filter((x) => x.lines)) {
    const picked = Object.entries(a.lines)
      .filter(([, [rel, ch]]) => rel !== null && rel >= relMin && (rel >= sure || ch >= min))
      .sort((x, y) => y[1][0] - x[1][0] || y[1][1] - x[1][1])
      .slice(0, 5)
      .map(([k]) => k);
    wanted += a.want.length;
    hits += a.want.filter((k) => picked.includes(k)).length;
    injected += picked.length;
    good += picked.filter((k) => a.want.includes(k) || a.ok.includes(k)).length;
    for (const k of picked) if (!a.want.includes(k) && !a.ok.includes(k)) wrong.push(`${a.id}:${k}`);
    if (a.type === "unrelated") {
      unrel++;
      if (picked.length) unrelHit++;
    }
    if (a.want.length > 1) {
      two++;
      if (a.want.every((k) => picked.includes(k))) twoBoth++;
    }
  }
  return { sure, min, recall: `${hits}/${wanted}`, precision: `${good}/${injected}`, unrelated: `${unrelHit}/${unrel}`, two_line_both: `${twoBoth}/${two}`, wrong };
}
const rules = [];
for (const sure of [0.97, 0.96, 0.95, 0.94, 0.93, 0.9]) for (const min of [0.05, 0.03, 0.02]) rules.push(score(sure, min));
const out = { kind: "diag-recall-sure", set: SET_FILE, date: new Date().toISOString().slice(0, 10), prompts: answers.length, failed: answers.filter((a) => !a.lines).length, method: "One in-process Jev call per prompt with the prompt hook's questions (every live line, bare-id choice, one relevance noul per line, replaces context), cache off; the rule scored offline: a line is picked when relevance ≥ 0.8 and (relevance ≥ sure or choice ≥ min), top 5 by relevance. Lines with relevance under 0.5 and choice under 0.01 are left out of `answers` (no rule here can pick them).", rules, answers };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
for (const r of rules) console.log(`sure ${r.sure} min ${r.min}: recall ${r.recall}, precision ${r.precision}, unrelated ${r.unrelated}, two-line prompts with both ${r.two_line_both}; not wanted or fine: ${r.wrong.join(" ")}`);
console.log(`→ ${OUT}`);
