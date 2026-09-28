#!/usr/bin/env node
// The selection rules compared on the dev set's saved answers (scripts/diag-recall-questions.mjs), offline: no Jev call.
// Writes results/diag-recall-questions-summary-<date>.json, the table behind the recall design in DECISIONS.md.
//
//   node scripts/diag-recall-sweep.mjs [--date YYYY-MM-DD]
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const DATE = args.includes("--date") ? args[args.indexOf("--date") + 1] : new Date().toISOString().slice(0, 10);
const DIR = "results/diag-recall-questions";
const load = (v) => JSON.parse(fs.readFileSync(path.join(DIR, `${v}.json`), "utf8"));

/** Lines a rule picks for one prompt: [key, score] sorted by score, top 5. Missing values (stored compactly) count as 0. */
const rules = {
  "choice ≥ 0.05": (r) => Object.entries(r.choice ?? {}).filter(([k, p]) => k !== "none" && p >= 0.05).map(([k, p]) => [k, p]),
  "noul ≥ 0.8": (r) => Object.entries(r.noul ?? {}).filter(([, p]) => (p ?? 0) >= 0.8),
  "noul ≥ 0.9": (r) => Object.entries(r.noul ?? {}).filter(([, p]) => (p ?? 0) >= 0.9),
  "noul ≥ 0.8 and choice ≥ 0.05": (r) => Object.entries(r.noul ?? {}).filter(([k, p]) => (p ?? 0) >= 0.8 && (r.choice?.[k] ?? 0) >= 0.05),
  "noul ≥ 0.97, or noul ≥ 0.8 and choice ≥ 0.05 (shipped)": (r) => Object.entries(r.noul ?? {}).filter(([k, p]) => (p ?? 0) >= 0.97 || ((p ?? 0) >= 0.8 && (r.choice?.[k] ?? 0) >= 0.05)),
  "exists ≥ 0.5, then choice ≥ 0.05": (r) => ((r.exists ?? 0) >= 0.5 ? Object.entries(r.choice ?? {}).filter(([k, p]) => k !== "none" && p >= 0.05) : []),
};
const applies = {
  "choice ≥ 0.05": (d) => d.design.choice,
  "noul ≥ 0.8": (d) => d.design.noul,
  "noul ≥ 0.9": (d) => d.design.noul,
  "noul ≥ 0.8 and choice ≥ 0.05": (d) => d.design.noul && d.design.choice,
  "noul ≥ 0.97, or noul ≥ 0.8 and choice ≥ 0.05 (shipped)": (d) => d.design.noul === "compact" && d.design.choice,
  "exists ≥ 0.5, then choice ≥ 0.05": (d) => d.design.exists,
};

function score(rows, rule) {
  let want = 0, hit = 0, inj = 0, good = 0, withWant = 0, served = 0, unrelated = 0, unrelatedHit = 0;
  for (const r of rows) {
    const got = rule(r).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
    inj += got.length;
    good += got.filter((k) => r.want.includes(k) || r.ok.includes(k)).length;
    if (r.want.length) {
      withWant++;
      want += r.want.length;
      const h = r.want.filter((k) => got.includes(k)).length;
      hit += h;
      if (h === r.want.length) served++;
    }
    if (r.type === "unrelated") {
      unrelated++;
      if (got.length) unrelatedHit++;
    }
  }
  return { recall: `${hit}/${want}`, served: `${served}/${withWant}`, precision: `${good}/${inj}`, unrelated: `${unrelatedHit}/${unrelated}`, lines_per_prompt: Math.round((inj / rows.length) * 100) / 100 };
}

const variants = fs.readdirSync(DIR).filter((f) => /^v\d+\.json$/.test(f)).map((f) => f.slice(0, -5)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const out = { kind: "diag-recall-questions", date: DATE, set: "eval/recall-dev.jsonl", source: DIR, method: "Offline, over the answers each variant's Jev calls gave on the dev set (one call per prompt, in process); top 5 by the rule's score. recall = wanted lines picked / wanted lines; precision = picked lines that are wanted or ok / picked lines; unrelated = unrelated prompts that got any line.", variants: {} };
for (const v of variants) {
  const d = load(v);
  const rows = d.rows.filter((r) => !r.error);
  const lat = rows.map((r) => r.jevMs).sort((a, b) => a - b);
  out.variants[v] = {
    design: d.design,
    run: d.run,
    prompts: rows.length,
    input_tokens_per_prompt: Math.round(rows.reduce((a, r) => a + r.inputTokens, 0) / rows.length),
    jev_p50_ms: lat[Math.floor(lat.length / 2)],
    wanted_lines_not_sent: rows.reduce((a, r) => a + r.missingFromCandidates.length, 0),
    rules: Object.fromEntries(Object.entries(rules).filter(([name]) => applies[name](d)).map(([name, rule]) => [name, score(rows, rule)])),
  };
}
const file = `results/diag-recall-questions-summary-${DATE}.json`;
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
for (const [v, s] of Object.entries(out.variants)) {
  console.log(`${v} ${JSON.stringify(s.design)} tokens ${s.input_tokens_per_prompt} jev p50 ${s.jev_p50_ms} ms, wanted lines not sent ${s.wanted_lines_not_sent}`);
  for (const [name, m] of Object.entries(s.rules)) console.log(`   ${name.padEnd(56)} recall ${m.recall.padEnd(6)} served ${m.served.padEnd(6)} precision ${m.precision.padEnd(8)} unrelated ${m.unrelated} lines ${m.lines_per_prompt}`);
}
console.log(`→ ${file}`);
