#!/usr/bin/env node
// Tables for the comparison against Claude Code's auto memory (scripts/ab-automem.mjs): per arm, how often the task
// session followed the taught line, what each tool saved after teaching, how much memory text sat in context, and
// the long-project case apart.
//
//   node scripts/ab-automem-report.mjs results/ab-automem-<date>.json [--json] [--md] [--write]
import fs from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const ARMS = ["none", "auto", "jevmem", "both", "claudemd"].filter((a) => data.records.some((r) => r.arm === a));
const CATS = ["decision", "constraint", "dead-end", "changed"];
const frac = (rs, f) => `${rs.filter(f).length}/${rs.length}`;
const rate = (rs, f) => (rs.length ? rs.filter(f).length / rs.length : null);
const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const atTurnLimit = (r) => r.exit === 1 && (r.end === "error_max_turns" || (r.turns ?? 0) >= (data.max_turns ?? 25));
const judged = (r) => !r.excluded && !r.check?.error && (r.exit === 0 || atTurnLimit(r));

function armSummary(arm, long) {
  const tasks = data.records.filter((r) => r.kind === "task" && r.arm === arm && Boolean(r.long) === long);
  const ok = tasks.filter(judged);
  const teach = data.records.filter((r) => r.kind === "teach" && r.arm === arm && Boolean(r.long) === long);
  const lastTeach = teach.filter((r) => !teach.some((o) => o.task === r.task && o.run === r.run && o.step > r.step));
  const out = {
    sessions: tasks.length,
    teaching_sessions: teach.length,
    excluded_slots: tasks.filter((r) => r.excluded).length,
    failed_sessions: tasks.filter((r) => !r.excluded && !judged(r)).length,
    failed_sessions_list: tasks.filter((r) => !r.excluded && !judged(r)).map((r) => `${r.task} run ${r.run}: exit ${r.exit}${r.signal ? ` ${r.signal}` : ""}${r.check?.error ? " check error" : ""}`),
    at_turn_limit: frac(tasks, atTurnLimit),
    followed: frac(ok, (r) => r.check.followed === true),
    followed_rate: rate(ok, (r) => r.check.followed === true),
    done: frac(ok, (r) => r.check.done === true),
    followed_and_done: frac(ok, (r) => r.check.followed === true && r.check.done === true),
    by_category: {},
  };
  for (const c of CATS) {
    const cr = ok.filter((r) => r.category === c);
    if (!cr.length) continue;
    const row = { followed: frac(cr, (r) => r.check.followed === true), followed_and_done: frac(cr, (r) => r.check.followed === true && r.check.done === true) };
    if (c === "constraint") Object.assign(row, { attempted: frac(cr, (r) => r.check.attempted === true), landed: frac(cr, (r) => r.check.landed === true), kept_in_the_end: frac(cr, (r) => r.check.landed !== true) });
    if (c === "dead-end") row.repeated = frac(cr, (r) => r.check.repeated === true);
    if (c === "changed") row.built_the_replaced = frac(cr, (r) => r.check.stale === true);
    out.by_category[c] = row;
  }
  // What the arm saved after teaching (the last teaching session of each task and run).
  if (lastTeach.length) {
    const changed = lastTeach.filter((r) => r.saved?.oldInAutoIndex !== undefined || r.saved?.oldInJevmemLive !== undefined);
    out.saved = {};
    if (arm === "auto" || arm === "both") {
      out.saved.auto_memory_saved_the_line = frac(lastTeach, (r) => r.saved?.auto === true);
      out.saved.auto_memory_index_carries_the_line = frac(lastTeach, (r) => r.saved?.autoIndex === true);
      if (changed.length) out.saved.auto_memory_old_line_gone_from_index = frac(changed, (r) => r.saved?.oldInAutoIndex === false);
      if (changed.length) out.saved.auto_memory_old_line_gone_from_files = frac(changed, (r) => r.saved?.oldInAutoFiles === false);
      out.saved.auto_memory_files_after_teaching = median(lastTeach.map((r) => r.saved?.autoFiles?.length));
      out.saved.auto_memory_bytes_after_teaching = median(lastTeach.map((r) => (r.saved?.autoFiles ?? []).reduce((a, f) => a + f.bytes, 0)));
    }
    if (arm === "jevmem" || arm === "both") {
      out.saved.jevmem_saved_the_line = frac(lastTeach, (r) => r.saved?.jevmem === true);
      if (changed.length) out.saved.jevmem_old_line_superseded = frac(changed, (r) => r.saved?.oldInJevmemLive === false);
      out.saved.jevmem_lines_after_teaching = median(lastTeach.map((r) => r.saved?.jevmemLines?.length));
    }
    out.saved.teaching_wrote_into_the_repo = frac(teach, (r) => (r.wroteIntoRepo ?? []).length > 0);
    out.saved.median_teaching_cost_usd = median(teach.map((r) => r.costUsd));
    out.saved.median_teaching_turns = median(teach.map((r) => r.turns));
  }
  // Memory text in context at the task session's start and per prompt.
  const ctx = {};
  if (arm === "auto" || arm === "both") {
    ctx.index_bytes_at_start = median(ok.map((r) => r.memoryAtStart?.indexBytes));
    ctx.index_lines_at_start = median(ok.map((r) => r.memoryAtStart?.indexLines));
    ctx.index_bytes_loaded = median(ok.map((r) => r.memoryAtStart?.loadedBytes));
    ctx.line_in_loaded_index = frac(ok, (r) => r.memoryAtStart?.lineInLoadedIndex === true);
    ctx.line_in_index = frac(ok, (r) => r.memoryAtStart?.lineInIndex === true);
    ctx.memory_files_read_during_task = frac(ok, (r) => (r.memoryReads ?? []).length > 0);
    ctx.memory_bytes_read_during_task = median(ok.map((r) => r.memoryReadBytes));
    ctx.memory_written_during_task = frac(ok, (r) => (r.memoryWrites ?? []).length > 0 || r.memoryAfter?.changed === true);
    ctx.followed_when_line_loaded = frac(ok.filter((r) => r.memoryAtStart?.lineInLoadedIndex === true), (r) => r.check.followed === true);
    ctx.followed_when_line_not_loaded = frac(ok.filter((r) => r.memoryAtStart?.lineInLoadedIndex !== true), (r) => r.check.followed === true);
    ctx.followed_when_memory_read = frac(ok.filter((r) => (r.memoryReads ?? []).length > 0), (r) => r.check.followed === true);
  }
  if (arm === "jevmem" || arm === "both") {
    ctx.start_context_chars = median(ok.map((r) => r.startContextChars));
    ctx.start_context_lines = median(ok.map((r) => r.startContextLines));
    ctx.prompt_context_chars = median(ok.map((r) => r.promptContextChars));
    ctx.line_in_prompt_context = frac(ok, (r) => r.lineInPromptContext === true);
    ctx.line_in_start_context = frac(ok, (r) => r.lineInStartContext === true);
    ctx.line_in_context = frac(ok, (r) => r.lineInPromptContext === true || r.lineInStartContext === true);
    const changed = ok.filter((r) => r.oldInPromptContext !== null);
    if (changed.length) ctx.old_line_in_prompt_context = frac(changed, (r) => r.oldInPromptContext === true);
    ctx.followed_when_line_in_context = frac(ok.filter((r) => r.lineInPromptContext || r.lineInStartContext), (r) => r.check.followed === true);
    ctx.followed_when_line_not_in_context = frac(ok.filter((r) => !(r.lineInPromptContext || r.lineInStartContext)), (r) => r.check.followed === true);
    ctx.recall_failed = frac(ok, (r) => (r.recall ?? []).some((x) => !x.ok));
    ctx.recall_median_ms = median(ok.flatMap((r) => (r.recall ?? []).map((x) => x.ms)));
    ctx.guard_asks = ok.reduce((a, r) => a + r.guard.filter((g) => g.decision === "ask").length, 0);
    ctx.guard_denials = ok.reduce((a, r) => a + r.guard.filter((g) => g.decision === "deny").length, 0);
    ctx.sessions_with_a_guard_ask = frac(ok, (r) => r.guard.some((g) => g.decision === "ask" || g.decision === "deny"));
    ctx.opened_jevmem_md = frac(ok, (r) => r.openedJevmemMd === true);
    ctx.jevmem_lines_at_start = median(ok.map((r) => r.memoryAtStart?.jevmemLines));
  }
  if (arm === "claudemd") {
    ctx.claude_md_bytes = median(ok.map((r) => r.memoryAtStart?.claudeMdBytes));
    ctx.claude_md_lines = median(ok.map((r) => r.memoryAtStart?.claudeMdLines));
  }
  out.context = ctx;
  out.median_cost_usd = median(tasks.map((r) => r.costUsd));
  out.median_turns = median(tasks.map((r) => r.turns));
  out.median_ms = median(tasks.map((r) => r.ms));
  out.agent_used = frac(ok, (r) => r.agentUsed === true);
  out.models_served = [...new Set(tasks.map((r) => r.model).filter(Boolean))];
  out.versions_served = [...new Set(tasks.map((r) => r.claudeCode).filter(Boolean))];
  return out;
}

const tasksOf = (long) => [...new Set(data.records.filter((r) => r.kind === "task" && Boolean(r.long) === long).map((r) => r.task))];
const perTask = (long) =>
  Object.fromEntries(
    tasksOf(long).map((t) => [
      t,
      Object.fromEntries(ARMS.map((a) => [a, frac(data.records.filter((r) => r.kind === "task" && r.task === t && r.arm === a && judged(r)), (r) => r.check.followed === true)]).filter(([, v]) => !v.endsWith("/0"))),
    ]),
  );
const summary = {
  taught: { arms: Object.fromEntries(ARMS.map((a) => [a, armSummary(a, false)])), per_task: perTask(false) },
  long: data.records.some((r) => r.long) ? { arms: Object.fromEntries(ARMS.map((a) => [a, armSummary(a, true)])), per_task: perTask(true) } : null,
  stray_sessions: data.stray_sessions,
  excluded_slots: data.excluded_slots,
  models_served: data.models_served,
  versions_served: data.versions_served,
};

if (args.includes("--write")) {
  data.summary = summary;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
if (args.includes("--json")) console.log(JSON.stringify(summary, null, 2));
else if (args.includes("--md")) {
  const pct = (f) => {
    const [a, b] = f.split("/").map(Number);
    return b ? `${a} of ${b}` : "–";
  };
  const block = (title, part) => {
    if (!part) return;
    console.log(`\n**${title}**\n`);
    console.log(`| | ${ARMS.join(" | ")} |`);
    console.log(`|---|${ARMS.map(() => "---").join("|")}|`);
    const row = (label, f) => console.log(`| ${label} | ${ARMS.map((a) => f(part.arms[a]) ?? "–").join(" | ")} |`);
    row("Followed the saved line (all tasks)", (s) => pct(s.followed));
    row("Followed, and did the task", (s) => pct(s.followed_and_done));
    row("Followed an earlier decision", (s) => (s.by_category.decision ? pct(s.by_category.decision.followed) : "–"));
    row("Tried a change a rule forbids", (s) => (s.by_category.constraint ? pct(s.by_category.constraint.attempted) : "–"));
    row("… and left it in", (s) => (s.by_category.constraint ? pct(s.by_category.constraint.landed) : "–"));
    row("Repeated an approach that already failed", (s) => (s.by_category["dead-end"] ? pct(s.by_category["dead-end"].repeated) : "–"));
    row("Built what a changed decision replaced", (s) => (s.by_category.changed ? pct(s.by_category.changed.built_the_replaced) : "–"));
    row("Saved the taught line (auto memory)", (s) => (s.saved?.auto_memory_saved_the_line ? pct(s.saved.auto_memory_saved_the_line) : "–"));
    row("Saved the taught line (jevmem)", (s) => (s.saved?.jevmem_saved_the_line ? pct(s.saved.jevmem_saved_the_line) : "–"));
    row("Old line gone after a change (auto memory index)", (s) => (s.saved?.auto_memory_old_line_gone_from_index ? pct(s.saved.auto_memory_old_line_gone_from_index) : "–"));
    row("Old line superseded after a change (jevmem)", (s) => (s.saved?.jevmem_old_line_superseded ? pct(s.saved.jevmem_old_line_superseded) : "–"));
    row("Memory text at session start (median bytes)", (s) => s.context.index_bytes_loaded ?? s.context.start_context_chars ?? s.context.claude_md_bytes ?? (s.sessions ? "0" : null));
    row("Memory text per prompt (median chars)", (s) => s.context.prompt_context_chars ?? (s.context.memory_bytes_read_during_task !== undefined ? `${s.context.memory_bytes_read_during_task} read` : s.sessions ? "0" : null));
    row("Guard asks (sessions with one)", (s) => (s.context.sessions_with_a_guard_ask ? pct(s.context.sessions_with_a_guard_ask) : "–"));
    row("Median cost per task session", (s) => (s.median_cost_usd !== null ? `$${s.median_cost_usd.toFixed(2)}` : null));
    row("Task sessions", (s) => String(s.sessions));
  };
  console.log(`${data.sessions} sessions (${data.jobs} jobs); ${data.claude_code}; model requested ${data.model_requested}, served ${data.models_served.join(", ")}; jevmem ${data.jevmem_commit}; ${data.date}; permission mode ${data.permission_mode}; strays ${data.stray_sessions}; excluded slots ${data.excluded_slots.length}`);
  block("Taught (18 tasks, 3 runs)", summary.taught);
  block("Long project (seeded, 6 tasks, 3 runs)", summary.long);
} else {
  console.log(`${data.sessions} sessions (${data.jobs} jobs); ${data.claude_code}; model requested ${data.model_requested}, served ${data.models_served.join(", ")}; versions ${data.versions_served.join(", ")}; jevmem ${data.jevmem_commit}; ${data.date}; strays ${data.stray_sessions}; excluded slots ${data.excluded_slots.length}`);
  const show = (title, part) => {
    if (!part) return;
    console.log(`\n== ${title}`);
    for (const a of ARMS) {
      const s = part.arms[a];
      if (!s.sessions) continue;
      console.log(`\n${a}: followed ${s.followed} (${((s.followed_rate ?? 0) * 100).toFixed(0)}%), done ${s.done}, followed and done ${s.followed_and_done}, failed ${s.failed_sessions}, excluded ${s.excluded_slots}, at the turn limit ${s.at_turn_limit}; median cost $${s.median_cost_usd}, turns ${s.median_turns}, ${Math.round((s.median_ms ?? 0) / 1000)} s; models ${s.models_served.join(",")}`);
      for (const [c, v] of Object.entries(s.by_category)) console.log(`   ${c.padEnd(11)} ${v.followed.padEnd(6)} (and done ${v.followed_and_done})${v.attempted ? `; attempted ${v.attempted}, landed ${v.landed}, kept ${v.kept_in_the_end}` : ""}${v.repeated ? `; repeated ${v.repeated}` : ""}${v.built_the_replaced ? `; built the replaced ${v.built_the_replaced}` : ""}`);
      if (s.saved) console.log(`   saved: ${Object.entries(s.saved).map(([k, v]) => `${k} ${v}`).join("; ")}`);
      if (Object.keys(s.context).length) console.log(`   context: ${Object.entries(s.context).map(([k, v]) => `${k} ${v}`).join("; ")}`);
      if (s.failed_sessions_list.length) console.log(`   failed: ${s.failed_sessions_list.join("; ")}`);
    }
    console.log("\nper task:");
    for (const [t, v] of Object.entries(part.per_task)) console.log(`   ${t.padEnd(14)} ${Object.entries(v).map(([a, f]) => `${a} ${f}`).join("  ")}`);
  };
  show("taught", summary.taught);
  show("long project (seeded)", summary.long);
}
