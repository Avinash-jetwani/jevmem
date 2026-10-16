#!/usr/bin/env node
// The pairing truth for a Cursor capture set (0.7.4): for every run of every captured session, the user message and
// the turn's assistant text as the `agent` CLI itself reported them (its user event and its assistant events, one per
// assistant message between tool calls, joined with blank lines), which a reader of Cursor's transcript or hook
// payloads must reproduce: no tool output, no two prompts merged, no turn lost. Written once per set from the rows and
// checked by hand (the labels file is committed next to the cases); the measure (scripts/eval-cursor-pairing.mjs)
// compares the reader's pairs with it.
//
//   node scripts/cursor-pairing-labels.mjs --in eval/cursor-dev-sessions.jsonl --out eval/cursor/dev.pairing.json
import fs from "node:fs";
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const IN = opt("--in", "");
const OUT = opt("--out", "");
if (!IN || !OUT) throw new Error("usage: --in <sessions.jsonl> --out <pairing.json>");
const rows = fs
  .readFileSync(IN, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const turns = [];
for (const r of rows) {
  for (const run of r.runs) {
    const texts = (run.assistant_texts ?? []).map((t) => t.trim()).filter(Boolean);
    turns.push({
      id: r.id,
      run: run.i,
      project: r.project,
      prompt: run.prompt,
      assistant_messages: texts.length,
      assistant: texts.join("\n\n"),
      final: texts.at(-1) ?? "",
      tool_calls: (run.tool_calls ?? []).length,
      result_event: run.result ? run.result.subtype : null,
      cursor_version: run.cursor_version ?? r.cursor_version ?? null,
      model: run.model_served ?? null,
    });
  }
}
fs.writeFileSync(OUT, JSON.stringify({ set: rows[0]?.set ?? null, from: IN.replace(/^.*\//, ""), sessions: rows.length, turns: turns.length, pairs: turns }, null, 2) + "\n");
console.log(`${rows.length} session(s), ${turns.length} turn(s) -> ${OUT}`);
for (const t of turns) console.log(`  ${t.id} run ${t.run}: ${t.assistant_messages} assistant message(s), ${t.tool_calls} tool call(s), final ${JSON.stringify(t.final.slice(0, 70))}`);
