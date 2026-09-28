#!/usr/bin/env node
// Tables for the outcome A/B (scripts/ab.mjs): per arm and category, how often the session followed the saved line,
// acted on a stale or wrong line, repeated a dead end, and, on constraint tasks, what the guard added on top of recall.
//
//   node scripts/ab-report.mjs results/ab-<date>.json [--json] [--transcripts <dir>]
//   (--write adds a `summary` block to the file, and with --transcripts the re-read turns and end states)
import fs from "node:fs";
import path from "node:path";
import { readEvents, toolCallsOf } from "./ab-lib.mjs";

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--transcripts");
const data = JSON.parse(fs.readFileSync(file, "utf8"));
// --transcripts <dir>: take each session's turns, end state and final text from the last result event of its
// transcript. scripts/ab.mjs read the first one until the subagent check of 2026-09-28; with a background subagent there
// are two, and the first stops early (its cost is already the session's total).
if (args.includes("--transcripts")) {
  const dir = args[args.indexOf("--transcripts") + 1];
  let changed = 0;
  let hooks = 0;
  for (const r of data.records) {
    const f = path.join(dir, r.transcript ?? "");
    if (!r.transcript || !fs.existsSync(f)) continue;
    const results = fs.readFileSync(f, "utf8").split("\n").filter((l) => l.includes('"type":"result"')).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
    const last = results.at(-1);
    if (!last) continue;
    if (r.turns !== (last.num_turns ?? null)) changed++;
    Object.assign(r, { turns: last.num_turns ?? null, end: last.subtype ?? null, resultText: String(last.result ?? "").slice(0, 600), result_events: results.length });
    // Which calls a PreToolUse hook ran on, paired again with scripts/ab-lib.mjs (the record keeps the calls in order).
    const calls = toolCallsOf(readEvents(f));
    if (calls.length === r.toolCalls.length)
      r.toolCalls.forEach((c, i) => {
        if (calls[i].hooked) {
          if (c.hook !== calls[i].hook) hooks++;
          c.hook = calls[i].hook;
        } else delete c.hook;
      });
  }
  data.reread = `turns, end and resultText from the last result event of each session's transcript (turns changed in ${changed} records, the ones with two result events), and the PreToolUse hook paired again with each call (${hooks} calls changed)`;
}
const recs = data.records.filter((r) => r.kind === "task");
const ARMS = ["none", "jevmem", "guard", "claudemd"].filter((a) => recs.some((r) => r.arm === a));
const CATS = ["convention", "decision", "constraint", "dead-end", "superseded"];

const frac = (rs, f) => `${rs.filter(f).length}/${rs.length}`;
const rate = (rs, f) => (rs.length ? rs.filter(f).length / rs.length : null);

/** A session that ran out of turns (`claude -p` exits 1 with error_max_turns) is judged on its final files like any other. */
const atTurnLimit = (r) => r.exit === 1 && (r.end === "error_max_turns" || (r.turns ?? 0) >= (data.max_turns ?? 25));
const judged = (r) => !r.check?.error && (r.exit === 0 || atTurnLimit(r));

function armSummary(arm) {
  const rs = recs.filter((r) => r.arm === arm);
  const ok = rs.filter(judged);
  const out = {
    sessions: rs.length,
    failed_sessions: rs.length - ok.length,
    failed_sessions_list: rs.filter((r) => !judged(r)).map((r) => `${r.id} run ${r.run}: exit ${r.exit}${r.signal ? ` ${r.signal}` : ""}${r.check?.error ? " check error" : ""}`),
    at_turn_limit: frac(rs, atTurnLimit),
    followed: frac(ok, (r) => r.check.followed === true),
    followed_rate: rate(ok, (r) => r.check.followed === true),
    done: frac(ok, (r) => r.check.done === true),
    // A constraint task's line is "followed" when the forbidden change is absent, so a session that changed nothing
    // follows it; this counts only the sessions that also did the task.
    followed_and_done: frac(ok, (r) => r.check.followed === true && r.check.done === true),
    followed_and_done_rate: rate(ok, (r) => r.check.followed === true && r.check.done === true),
    by_category: {},
  };
  for (const c of CATS) {
    const cr = ok.filter((r) => r.category === c);
    if (!cr.length) continue;
    out.by_category[c] = { followed: frac(cr, (r) => r.check.followed === true), followed_rate: rate(cr, (r) => r.check.followed === true), followed_and_done: frac(cr, (r) => r.check.followed === true && r.check.done === true) };
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
    // JEVMEM.md is in the project, as in real use, so Claude can open it; how often it did says how much of this
    // arm is recall and how much is the file.
    const openedFile = (r) => r.toolCalls.some((c) => !c.error && /JEVMEM\.md/.test(c.arg ?? ""));
    out.opened_jevmem_md = frac(ok, openedFile);
    out.followed_when_opened_jevmem_md = frac(ok.filter(openedFile), (r) => r.check.followed === true);
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
  tasks.map((t) => [t, Object.fromEntries(ARMS.map((a) => [a, frac(recs.filter((r) => r.task === t && r.arm === a && judged(r)), (r) => r.check.followed === true)]).filter(([, v]) => !v.endsWith("/0")))]),
);
// The subagent check: did the main agent delegate, did its delegation message carry the saved line, did the subagent
// follow it, and did the guard's PreToolUse hook run on the subagent's own Bash, Edit and Write calls (the stream shows
// each hook run; scripts/ab-lib.mjs pairs it with its call) and what it answered.
const RULE_WORDS = { "sub-generated": /openapi|npm run gen|gen-client|regenerat|never edit|by hand/i, "sub-money": /cents?\b|499|249|integer/i };
const GUARDED = ["Bash", "Edit", "Write", "MultiEdit"];
const subs = data.records.filter((r) => r.kind === "subagent");
const subagentSummary = subs.length
  ? Object.fromEntries(
      [...new Set(subs.map((r) => `${r.id}|${r.arm}`))].map((k) => {
        const [id, arm] = k.split("|");
        const rs = subs.filter((r) => r.id === id && r.arm === arm);
        const delegations = (r) => r.toolCalls.filter((c) => (c.name === "Agent" || c.name === "Task") && !c.parent);
        const subGuarded = (r) => r.toolCalls.filter((c) => c.parent && GUARDED.includes(c.name));
        const mainGuarded = (r) => r.toolCalls.filter((c) => !c.parent && GUARDED.includes(c.name));
        const count = (f) => rs.reduce((a, r) => a + f(r), 0);
        return [
          k,
          {
            sessions: rs.length,
            delegated: frac(rs, (r) => delegations(r).length > 0),
            delegation_carried_the_line: frac(rs.filter((r) => delegations(r).length > 0), (r) => delegations(r).some((c) => RULE_WORDS[id]?.test(c.prompt ?? ""))),
            line_injected: frac(rs, (r) => r.lineInjected),
            followed: frac(rs, (r) => r.check?.followed === true),
            subagent_tool_calls: count((r) => r.subagentCalls),
            subagent_edits: count((r) => subGuarded(r).filter((c) => c.name !== "Bash").length),
            hook_ran_on_subagent_calls: `${count((r) => subGuarded(r).filter((c) => c.hook !== undefined).length)}/${count((r) => subGuarded(r).length)}`,
            hook_ran_on_main_calls: `${count((r) => mainGuarded(r).filter((c) => c.hook !== undefined).length)}/${count((r) => mainGuarded(r).length)}`,
            guard_asks_or_denials_on_subagent_calls: count((r) => subGuarded(r).filter((c) => c.hook === "ask" || c.hook === "deny").length),
            guard_asks_or_denials: count((r) => r.guardLog.filter((g) => g.decision === "ask" || g.decision === "deny").length),
            guard_log_entries: count((r) => r.guardLog.length),
            attempted: frac(rs, (r) => r.check?.attempted === true),
            landed: frac(rs, (r) => r.check?.landed === true),
          },
        ];
      }),
    )
  : null;
const summary = { arms: Object.fromEntries(ARMS.map((a) => [a, armSummary(a)])), per_task: perTask, ...(subagentSummary ? { subagent: subagentSummary } : {}) };

if (args.includes("--write")) {
  data.summary = summary;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
if (args.includes("--json")) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`${data.sessions} sessions; ${data.claude_code}; model ${data.model}; jevmem ${data.jevmem_commit}; ${data.date}`);
  for (const a of ARMS) {
    const s = summary.arms[a];
    console.log(`\n${a}: followed ${s.followed} (${((s.followed_rate ?? 0) * 100).toFixed(0)}%), done ${s.done}, followed and done ${s.followed_and_done}, failed sessions ${s.failed_sessions}, at the turn limit ${s.at_turn_limit}`);
    for (const [c, v] of Object.entries(s.by_category)) console.log(`   ${c.padEnd(11)} ${v.followed.padEnd(6)} (and done ${v.followed_and_done})`);
    if (s.superseded_tasks) console.log(`   stale (superseded tasks): ${s.superseded_tasks.stale}`);
    if (s.wrong_line) console.log(`   acted on a look-alike line: ${s.wrong_line.acted_on_a_look_alike_line}`);
    if (s.dead_end_tasks) console.log(`   repeated a dead end: ${s.dead_end_tasks.repeated}`);
    if (s.constraint_tasks) console.log(`   constraint: attempted ${s.constraint_tasks.attempted}, landed ${s.constraint_tasks.landed}, kept in the end ${s.constraint_tasks.kept_in_the_end}, guard asks ${s.constraint_tasks.guard_asks}, denials ${s.constraint_tasks.guard_denials}`);
    if (s.line_injected) console.log(`   line injected ${s.line_injected}; stale line injected ${s.stale_line_injected}; recall failed ${s.recall_failed}; followed when injected ${s.followed_when_injected}, when not ${s.followed_when_not_injected}; opened JEVMEM.md ${s.opened_jevmem_md} (followed ${s.followed_when_opened_jevmem_md})`);
    console.log(`   median cost $${s.median_cost_usd}, median turns ${s.median_turns}`);
  }
  if (summary.subagent) {
    console.log("\nsubagent check:");
    for (const [k, v] of Object.entries(summary.subagent)) console.log(`   ${k.padEnd(24)} ${JSON.stringify(v)}`);
  }
  console.log("\nper task:");
  for (const [t, v] of Object.entries(perTask)) console.log(`   ${t.padEnd(14)} ${Object.entries(v).map(([a, f]) => `${a} ${f}`).join("  ")}`);
}
