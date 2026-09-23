#!/usr/bin/env node
// Every measured number in the public docs must come from a committed results file.
//
//   node scripts/check-claims.mjs [--verbose]
//
// Docs checked: README.md, DEMO.md, SECURITY.md, the newest CHANGELOG.md entry, package.json `description`, and
// the CLI help text in src/cli-main.ts. A "measured number" is one with a unit: %, ms, s, $, tokens, or an N/M
// count ("4/4"). Each must round-match (at the precision it is written with) a value in a results file listed in
// results/CURRENT.json, or be in scripts/claims-allow.json (prices, config defaults), which says why for each.
// JSON results: every aggregate numeric leaf counts (per-row data does not), with unit conversions (fraction → %,
// ms → s, cost ×300 → per 300 turns).
// Text results (.txt, e.g. captured CLI output): numbers must appear in the file with the same unit.
import fs from "node:fs";
import path from "node:path";

const verbose = process.argv.includes("--verbose");
const manifest = JSON.parse(fs.readFileSync("results/CURRENT.json", "utf8"));
const allow = JSON.parse(fs.readFileSync("scripts/claims-allow.json", "utf8"));

// ------------------------------------------------------------------ what the results files hold
/** unit → array of numbers. */
const pool = { "%": [], ms: [], s: [], $: [], tokens: [], frac: new Set(), "%txt": [] };

function walk(v, key, parentTurns) {
  if (v === null || v === undefined) return;
  if (Array.isArray(v)) return v.forEach((x) => walk(x, key, parentTurns));
  if (typeof v === "object") {
    // Per-row data (every single turn's latency, tokens, cost) is not a claim anyone can cite; only aggregates count.
    if (key === "rows" || key === "warm_up") return;
    const turns = typeof v.turns === "number" ? v.turns : typeof v.n === "number" ? v.n : parentTurns;
    // Contradiction diagnostics (scripts/diag-contradictions.mjs) store counts, not "N/M" strings.
    if (typeof v.found === "number" && typeof v.contradictions === "number") pool.frac.add(`${v.found}/${v.contradictions}`);
    if (typeof v.false_supersedes === "number" && typeof v.near_misses === "number") pool.frac.add(`${v.false_supersedes}/${v.near_misses}`);
    for (const [k, x] of Object.entries(v)) walk(x, k, turns);
    return;
  }
  const k = String(key ?? "").toLowerCase();
  if (typeof v === "string") {
    if (/^\d+\/\d+$/.test(v)) pool.frac.add(v);
    return;
  }
  if (typeof v !== "number") return;
  if (/usd|cost/.test(k)) {
    pool.$.push(v, v * 300); // per decision, and per 300 turns
    return;
  }
  if (/(^|_)ms($|_)|ms$|latency/.test(k)) {
    pool.ms.push(v);
    pool.s.push(v / 1000);
    return;
  }
  if (/tokens/.test(k)) {
    pool.tokens.push(v);
    return;
  }
  if (/rate|accuracy|^f1$|precision|recall/.test(k) && v >= 0 && v <= 1) {
    pool["%"].push(v * 100);
    return;
  }
  if (/correct|malformed|contradictions|^n$|^turns$|served|memories/.test(k) && Number.isInteger(v)) {
    if (parentTurns && /correct|malformed/.test(k)) pool.frac.add(`${v}/${parentTurns}`);
  }
}

const TXT_RE = /(\d[\d,]*(?:\.\d+)?)\s?(%|ms\b|s\b|tokens\b)|\$(\d+(?:\.\d+)?)/g;
for (const f of manifest.files) {
  const p = path.join("results", f);
  if (!fs.existsSync(p)) throw new Error(`results/CURRENT.json lists ${f}, which does not exist`);
  if (f.endsWith(".json")) walk(JSON.parse(fs.readFileSync(p, "utf8")));
  else {
    const text = fs.readFileSync(p, "utf8");
    for (const m of text.matchAll(TXT_RE)) {
      if (m[3]) pool.$.push(Number(m[3]));
      else {
        const n = Number(m[1].replace(/,/g, ""));
        const unit = m[2].trim();
        if (unit === "%") pool["%"].push(n);
        else if (unit === "ms") pool.ms.push(n), pool.s.push(n / 1000);
        else if (unit === "s") pool.s.push(n);
        else pool.tokens.push(n);
      }
    }
    for (const m of text.matchAll(/\b(\d+)\/(\d+)\b/g)) pool.frac.add(`${m[1]}/${m[2]}`);
  }
}
for (const [unit, vals] of Object.entries(allow.values)) for (const v of vals) (unit === "frac" ? pool.frac.add(String(v.value)) : pool[unit].push(v.value));

// ------------------------------------------------------------------ what the docs claim
function docs() {
  const out = [];
  const add = (file, text, lineOffset = 0) => text.split("\n").forEach((l, i) => out.push({ file, line: i + 1 + lineOffset, text: l }));
  for (const f of ["README.md", "DEMO.md", "SECURITY.md"]) add(f, fs.readFileSync(f, "utf8"));
  const cl = fs.readFileSync("CHANGELOG.md", "utf8").split("\n");
  const first = cl.findIndex((l) => /^## /.test(l));
  const next = cl.findIndex((l, i) => i > first && /^## /.test(l));
  add("CHANGELOG.md", cl.slice(first, next < 0 ? undefined : next).join("\n"), first);
  add("package.json (description)", JSON.parse(fs.readFileSync("package.json", "utf8")).description);
  add("src/cli-main.ts", fs.readFileSync("src/cli-main.ts", "utf8").split("\nfunction wantsHelp")[0]);
  return out;
}

/** Decimal places and trailing zeros as written, to derive the rounding tolerance. */
function tolerance(raw) {
  const s = raw.replace(/,/g, "");
  if (s.includes(".")) return 0.5 * 10 ** -s.split(".")[1].length;
  const tz = s.match(/0*$/)[0].length;
  // "270" may be a rounded 266–274; "2,450" a rounded 2,445–2,454; a written integer without trailing zeros is exact to ±0.5.
  return tz > 0 && s.length > tz ? 0.5 * 10 ** tz : 0.5;
}
const within = (vals, n, tol) => vals.some((v) => Math.abs(v - n) <= tol + 1e-12);

const CLAIM_RE = [
  { unit: "%", re: /(?<![\w.])(\d+(?:\.\d+)?)\s?(?:[–-]\s?(\d+(?:\.\d+)?)\s?)?%/g },
  { unit: "ms", re: /(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s?(?:[–-]\s?(\d[\d,]*(?:\.\d+)?)\s?)?ms\b/g },
  { unit: "s", re: /(?<![\w.$])(\d+(?:\.\d+)?)(?:\s?[–-]\s?(\d+(?:\.\d+)?))?\s?s\b(?![\w'])/g },
  { unit: "$", re: /\$(\d+(?:\.\d+)?)(?:\s?[–-]\s?\$?(\d+(?:\.\d+)?))?/g },
  { unit: "tokens", re: /(?<![\w.])(\d[\d,]*)\s+(?:input\s+|output\s+)?tokens\b/g },
  { unit: "frac", re: /(?<![\w./-])(\d+)\/(\d+)(?![\w./-])/g },
];

const failures = [];
let checked = 0;
for (const d of docs()) {
  for (const { unit, re } of CLAIM_RE) {
    for (const m of d.text.matchAll(re)) {
      const nums = unit === "frac" ? [`${m[1]}/${m[2]}`] : [m[1], m[2]].filter(Boolean);
      for (const raw of nums) {
        checked++;
        let ok;
        if (unit === "frac") ok = pool.frac.has(raw);
        else {
          const n = Number(raw.replace(/,/g, ""));
          ok = within(pool[unit], n, tolerance(raw));
        }
        if (verbose) console.log(`${ok ? "ok  " : "FAIL"} ${d.file}:${d.line} ${unit} ${raw}`);
        if (!ok) failures.push(`${d.file}:${d.line}: ${unit === "$" ? "$" + raw : unit === "frac" ? raw : raw + " " + unit} is not in any results file listed in results/CURRENT.json\n    ${d.text.trim().slice(0, 160)}`);
      }
    }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`\ncheck-claims: ${failures.length} of ${checked} numbers have no source (${manifest.files.length} results files, allow-list scripts/claims-allow.json)`);
  process.exit(1);
}
console.log(`check-claims: all ${checked} numbers in the docs trace to results/ (${manifest.files.join(", ")}) or the allow-list`);
