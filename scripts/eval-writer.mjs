#!/usr/bin/env node
// The one-line writer on every save-labelled turn of eval/transcript.jsonl (the regression set, not heldout).
//
//   node scripts/eval-writer.mjs [--writer none|openai|anthropic] [--out results/writer-….json]
//
// --writer none (the default since 0.5.4) is jevmem's local extract and needs no key. openai / anthropic need
// OPENAI_API_KEY / ANTHROPIC_API_KEY and send each turn's writer input to that provider.
// Reported per writer: the existing expectLine checks (exact match; written for the local extract), lines within
// maxChars, how many lines fell back to the local extract, and every line, so two runs can be compared side by side.
// The writer input is what the hook passes (decision.sourceText): the user message, or, for bug and architecture turns
// whose user message is a question, the assistant reply (the only kinds the policy lets come from the reply). Here
// that is decided by looksLikeQuestion instead of Jev's content_source answer, so no key is needed.
// droppedSentences counts lines that leave out a later sentence of their input (a reason, a second rule).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const WRITER = opt("--writer", "none");
const today = new Date().toISOString().slice(0, 10);
const OUT = opt("--out", `results/writer-${today}-${WRITER}.json`);
const lib = await import(pathToFileURL(path.resolve("dist/index.js")).href);
const MAX = 200;
const turns = fs
  .readFileSync("eval/transcript.jsonl", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((t) => t.label.save);

const rows = [];
const sentences = (s) => s.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((x) => x.trim()).length;
for (const t of turns) {
  const fromReply = ["bug", "architecture"].includes(t.label.kind) && t.assistant && lib.looksLikeQuestion(t.user);
  const source = fromReply ? t.assistant : t.user;
  const { line, writerUsed } = await lib.composeLine(source, t.label.kind, { writer: { provider: WRITER, maxChars: MAX, timeoutMs: 15000 }, env: process.env });
  rows.push({ tag: t.tag, kind: t.label.kind, source: fromReply ? "assistant" : "user", input: source, line, writerUsed, chars: line.length, droppedSentences: sentences(line) < sentences(source), ...(t.expectLine ? { expectLine: t.expectLine, match: line === t.expectLine } : {}) });
}
const withExpect = rows.filter((r) => "expectLine" in r);
const summary = {
  writer: WRITER,
  turns: rows.length,
  expectLineChecks: withExpect.length,
  expectLineMatches: withExpect.filter((r) => r.match).length,
  withinMaxChars: rows.filter((r) => r.chars <= MAX).length,
  fellBackToLocal: WRITER === "none" ? 0 : rows.filter((r) => r.writerUsed === "fallback").length,
  droppedSentences: rows.filter((r) => r.droppedSentences).length,
  meanChars: Math.round(rows.reduce((a, r) => a + r.chars, 0) / rows.length),
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ date: today, set: "eval/transcript.jsonl (save-labelled turns)", summary, rows }, null, 2) + "\n");
console.log(JSON.stringify(summary));
console.log(`wrote ${OUT}`);
