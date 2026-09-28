#!/usr/bin/env node
// Tables for the outcome A/B (scripts/ab.mjs): per arm and category, how often the session followed the saved line,
// acted on a stale or wrong line, repeated a dead end, and, on constraint tasks, what the guard added on top of recall.
//
//   node scripts/ab-report.mjs results/ab-<date>.json [--json]   (adds a `summary` block to the file with --write)
import fs from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const recs = data.records.filter((r) => r.kind === "task");
const ARMS = ["none", "jevmem", "guard", "claudemd"].filter((a) => recs.some((r) => r.arm === a));
const CATS = ["convention", "decision", "constraint", "dead-end", "superseded"];

const frac = (rs, f) => `${rs.filter(f).length}/${rs.length}`;
const rate = (rs, f) => (rs.length ? rs.filter(f).length / rs.length : null);

function armSummary(arm) {
  const rs = recs.filter((r) => r.arm === arm);
  const ok = rs.filter((r) => !r.check?.error && r.exit === 0);
  const out = {
    sessions: rs.length,
    failed_sessions: rs.length - ok.length,
    followed: frac(ok, (r) => r.check.followed === true),
    followed_rate: rate(ok, (r) => r.check.followed === true),
    done: frac(ok, (r) => r.check.done === true),
    by_category: {},
  };
  for (const c of CATS) {
    const cr = ok.filter((r) => r.category === c);
    if (!cr.length) continue;
    out.by_category[c] = { followed: frac(cr, (r) => r.check.followed === true), followed_rate: rate(cr, (r) => r.check.followed === true) };
  }
  const sup = ok.filter((r) => r.category === "superseded");
  if (sup.length) out.superseded_tasks = { stale: frac(sup, (r) => r.check.stale === true), stale_rate: rate(sup, (r) => r.check.stale === true) };
  const wrong = ok.filter((r) => "wrong" in (r.check ?? {}));
  if (wrong.length) out.wrong_line = { acted_on_a_look_alike_line: frac(wrong, (r) => r.check.wrong === true) };
  const de = ok.filter((r) => r.category === "dead-end");
  if (de.length) out.dead_end_tasks = { repeated: frac(de, (r) => r.check.repeated === true), repeated_rate: rate(de, (r) => r.check.repeated === true) };
  const con = ok.filter((r) => r.category === "constraint");
  if (con.length) {
    out.constraint_tasks = {
      attempted: frac(con, (r) => r.check.attempted === true),
      landed: frac(con, (r) => r.check.landed === true),
      kept_in_the_end: frac(con, (r) => r.check.landed !== true),
      kept_in_the_end_rate: rate(con, (r) => r.check.landed !== true),
      guard_asks: con.reduce((a, r) => a + r.guard.filter((g) => g.decision === "ask").length, 0),
      guard_denials: con.reduce((a, r) => a + r.guard.filter((g) => g.decision === "deny").length, 0),
    };
  }
  if (arm === "jevmem" || arm === "guard") {
    out.line_injected = frac(ok, (r) => r.lineInjected);
    out.stale_line_injected = frac(ok.filter((r) => r.staleInjected !== null), (r) => r.staleInjected === true);
    out.recall_failed = frac(ok, (r) => (r.recall ?? []).some((x) => !x.ok));
    out.followed_when_injected = frac(ok.filter((r) => r.lineInjected), (r) => r.check.followed === true);
    out.followed_when_not_injected = frac(ok.filter((r) => !r.lineInjected), (r) => r.check.followed === true);
  }
  out.median_cost_usd = median(rs.map((r) => r.costUsd).filter((x) => typeof x === "number"));
  out.median_turns = median(rs.map((r) => r.turns).filter((x) => typeof x === "number"));
  return out;
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

// Per task: followed counts per arm (for the per-task table in docs/benchmark.md).
const tasks = [...new Set(recs.map((r) => r.task))];
const perTask = Object.fromEntries(
  tasks.map((t) => [t, Object.fromEntries(ARMS.map((a) => [a, frac(recs.filter((r) => r.task === t && r.arm === a && !r.check?.error && r.exit === 0), (r) => r.check.followed === true)]).filter(([, v]) => !v.endsWith("/0")))]),
);
const summary = { arms: Object.fromEntries(ARMS.map((a) => [a, armSummary(a)])), per_task: perTask };

if (args.includes("--write")) {
  data.summary = summary;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
if (args.includes("--json")) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`${data.sessions} sessions; ${data.claude_code}; model ${data.model}; jevmem ${data.jevmem_commit}; ${data.date}`);
  for (const a of ARMS) {
    const s = summary.arms[a];
    console.log(`\n${a}: followed ${s.followed} (${((s.followed_rate ?? 0) * 100).toFixed(0)}%), done ${s.done}, failed sessions ${s.failed_sessions}`);
    for (const [c, v] of Object.entries(s.by_category)) console.log(`   ${c.padEnd(11)} ${v.followed}`);
    if (s.superseded_tasks) console.log(`   stale (superseded tasks): ${s.superseded_tasks.stale}`);
    if (s.wrong_line) console.log(`   acted on a look-alike line: ${s.wrong_line.acted_on_a_look_alike_line}`);
    if (s.dead_end_tasks) console.log(`   repeated a dead end: ${s.dead_end_tasks.repeated}`);
    if (s.constraint_tasks) console.log(`   constraint: attempted ${s.constraint_tasks.attempted}, landed ${s.constraint_tasks.landed}, kept in the end ${s.constraint_tasks.kept_in_the_end}, guard asks ${s.constraint_tasks.guard_asks}, denials ${s.constraint_tasks.guard_denials}`);
    if (s.line_injected) console.log(`   line injected ${s.line_injected}; stale line injected ${s.stale_line_injected}; recall failed ${s.recall_failed}; followed when injected ${s.followed_when_injected}, when not ${s.followed_when_not_injected}`);
    console.log(`   median cost $${s.median_cost_usd}, median turns ${s.median_turns}`);
  }
  console.log("\nper task:");
  for (const [t, v] of Object.entries(perTask)) console.log(`   ${t.padEnd(14)} ${Object.entries(v).map(([a, f]) => `${a} ${f}`).join("  ")}`);
}
