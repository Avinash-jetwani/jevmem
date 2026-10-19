#!/usr/bin/env node
// The context a Cursor rule costs: a rule with `alwaysApply: true` is in every chat of every project the plugin is
// installed for, so the plugin's rule (0.7.6) is as short as it can be. This measures the text itself, which is what
// Cursor puts in the context: characters, words and lines of the whole file and of its body (the part after the
// frontmatter, which is what the model sees), and a token estimate at four characters per token (no tokenizer of
// Cursor's models is available here; the exact count is the model's). Compared: the 0.7.4 rule `jevmem init --tool
// cursor` wrote (the first legacy text in src/tools.ts) and the 0.7.6 rule the plugin and `init` share.
//
//   node scripts/measure-cursor-rule.mjs [--out results/<file>.json]
import fs from "node:fs";
import { CURSOR_RULE, LEGACY_CURSOR_RULES } from "../dist/index.js";

const outFile = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
const measure = (name, text) => {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  const m = (t) => ({ chars: t.length, words: t.split(/\s+/).filter(Boolean).length, lines: t.split("\n").filter((l) => l.trim()).length, tokens_estimate: Math.round(t.length / 4) });
  return { name, file: m(text), body: m(body), body_text: body };
};
const rows = [measure("0.7.4 rule (jevmem init --tool cursor, 0.7.4 and 0.7.5)", LEGACY_CURSOR_RULES[0]), measure("0.7.6 rule (the plugin's rules/jevmem.mdc and init's file)", CURSOR_RULE)];
const result = {
  kind: "cursor-rule-cost",
  date: new Date().toISOString(),
  method: "the rule text as Cursor attaches it to a chat (alwaysApply: true): characters, words and non-empty lines of the whole file and of the body after the frontmatter; tokens estimated at 4 characters per token, since no tokenizer of Cursor's models runs here. Measured from the strings in src/tools.ts through the built dist/index.js.",
  // The aggregates check-claims reads (it skips per-row data): the body's size per rule, the numbers the docs cite.
  summary: { rule_074_body_chars: rows[0].body.chars, rule_074_body_words: rows[0].body.words, rule_074_body_tokens: rows[0].body.tokens_estimate, rule_076_body_chars: rows[1].body.chars, rule_076_body_words: rows[1].body.words, rule_076_body_tokens: rows[1].body.tokens_estimate },
  rows: rows.map(({ body_text, ...r }) => r),
  body_texts: Object.fromEntries(rows.map((r) => [r.name, r.body_text])),
};
const text = JSON.stringify(result, null, 2) + "\n";
if (outFile) fs.writeFileSync(outFile, text);
for (const r of result.rows) console.log(`${r.name}: file ${r.file.chars} chars, ${r.file.words} words; body ${r.body.chars} chars, ${r.body.words} words, ${r.body.lines} lines, about ${r.body.tokens_estimate} tokens`);
if (outFile) console.log(`written to ${outFile}`);
