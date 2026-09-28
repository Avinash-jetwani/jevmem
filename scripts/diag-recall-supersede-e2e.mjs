#!/usr/bin/env node
// Why recall missed the line that superseded a dead end (v0.6 part 3), on the 9 real cases from the part 2b and 2c e2e
// runs (results/e2e-2026-09-27-part2b.txt, runs 1-6; results/e2e-2026-09-27-part2c.txt, runs 1-3): session 3 asked "Can I
// run src/app.ts directly with node now, without tsc?" with three live lines, the tsc decision, a preference and the
// line that superseded the dead end, written by the local writer from Claude's reply. Each case is asked the old recall
// questions (a choice whose options carry the text) and the new ones (bare ids, one relevance noul per line), without and
// with the superseded dead end as the new line's `replaces` context. A diagnostic, not an eval: nothing was tuned on it.
//
//   node scripts/diag-recall-supersede-e2e.mjs [path/to/dist/index.js] [--reps 2]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { choice } from "@typesafe-ai/sdk";

const args = process.argv.slice(2);
const dist = args[0] && !args[0].startsWith("--") ? args[0] : "dist/index.js";
const REPS = Number(args.includes("--reps") ? args[args.indexOf("--reps") + 1] : 2);
const lib = await import(pathToFileURL(path.resolve(dist)).href);
const TSC = "The CLI is compiled with tsc into dist/ and started with node dist/app.js";
const PREF = "Durations are printed with one decimal place";
const Q = "Can I run src/app.ts directly with node now, without tsc? Answer in one sentence, without running anything.";
// [source, kind, the new line, the dead end it superseded], as the e2e results print them.
const CASES = [
  ["part2b run 1", "bug", "`node --experimental-strip-types src/app.ts` now runs directly and prints `2.1 min`. I replaced the TypeScript `enum Unit`", "I tried `node --experimental-strip-types src/app.ts`, but it failed because `src/app.ts` uses a TypeScript `enum` (`Unit`), which Node's strip-only type stripping doesn't support"],
  ["part2b run 2", "bug", "Node's `--experimental-strip-types` only strips type syntax — it can't handle real TypeScript `enum`, which emits actual JS. It runs and prints `2.1 min`. I replaced the real TypeScript `enum Unit`", "I tried it once — `node --experimental-strip-types src/app.ts` fails because `src/app.ts` uses a real TypeScript `enum` (`Unit`), which Node's strip-only mode can't handle"],
  ["part2b run 3", "bug", "I replaced the TypeScript `enum Unit` (which Node's type-stripping mode can't erase) with a `const Unit = {...} as const` object plus a derived `type Unit` alias", "I tried `node --experimental-strip-types src/app.ts`, but it failed: `src/app.ts` uses a real TypeScript `enum` (`Unit`), and Node's strip-only mode can't handle enums"],
  ["part2b run 4", "bug", "It runs correctly now. I replaced the TypeScript `enum Unit` with a `const Unit` object plus a derived `type Unit` union", "I tried it once: `node --experimental-strip-types src/app.ts` fails because `src/app.ts` uses a TypeScript `enum`, which strip-only mode can't handle"],
  ["part2b run 5", "bug", "`node --experimental-strip-types src/app.ts` now runs directly and prints `2.1 min`. I replaced the TypeScript `enum Unit` with a `const Unit` object plus a derived union type", "I ran `node --experimental-strip-types src/app.ts`, but it failed: `src/app.ts` uses a TypeScript `enum` (`Unit`), which is a runtime construct that Node's strip-only-types mode can't erase"],
  ["part2b run 6", "decision", "I replaced the TypeScript `enum Unit` in `src/app.ts` with a `const Unit = {...} as const` object plus a derived `type Unit`", "I tried `node --experimental-strip-types src/app.ts`, but it failed because `src/app.ts:1` uses a TypeScript `enum`, which Node's strip-only mode doesn't support"],
  ["part2c run 1", "decision", "I replaced the TypeScript `enum Unit` with a `const Unit` object (`as const`) plus a derived `type Unit` union, since real enums emit runtime code that `--experimental-strip-types` can't strip", "I tried `node --experimental-strip-types src/app.ts`, but it failed because `src/app.ts` uses a TypeScript `enum`, which strip-only mode doesn't support"],
  ["part2c run 2", "bug", "I replaced the real TypeScript `enum` (which `--experimental-strip-types` can't erase) with a `const` object plus a derived union type, since only type-only syntax is stripped, not runtime enum code.", "I ran it once. It fails: `src/app.ts` uses a real TypeScript `enum`, which Node's `--experimental-strip-types` only strips type syntax (erasable), not enums"],
  ["part2c run 3", "decision", "`node --experimental-strip-types src/app.ts` now runs directly and prints `2.1 min`.", "I ran `node --experimental-strip-types src/app.ts` once. It failed because `src/app.ts:1` uses a TypeScript `enum`, which Node's strip-only type stripping doesn't support"],
];
const NONE = { what: "No listed memory is relevant to the query.", examples: ["The query is about a topic none of the memories mention."] };
const jev = lib.createJev({ noLogFile: true, cache: false });
const out = [];
for (const [source, kind, text, deadEnd] of CASES) {
  const mems = [{ id: "tscdec", kind: "decision", text: TSC }, { id: "prefdp", kind: "preference", text: PREF }, { id: "newlin", kind, text }];
  const rec = { source, line: text, old: [], new: [], newWithReplaces: [] };
  for (let rep = 0; rep < REPS; rep++) {
    // The old questions: the choice alone, options carrying the text (0.5.9 and main before part 3).
    const crit = Object.fromEntries(mems.map((m) => [m.id, `[${m.kind}] ${m.text}`]));
    crit.none = NONE;
    const a = (await jev.call({ query: Q, memories: mems }, { most_relevant: choice("Which memory is most relevant to the query?", crit) }, { label: "diag" })).answers;
    rec.old.push({ newLine: a.most_relevant.probabilities.newlin, tsc: a.most_relevant.probabilities.tscdec });
    // The new questions, without and with the dead end as `replaces`.
    for (const [key, state] of [["new", mems], ["newWithReplaces", mems.map((m) => (m.id === "newlin" ? { ...m, replaces: [deadEnd] } : m))]]) {
      const bare = Object.fromEntries(mems.map((m) => [m.id, null]));
      bare.none = NONE;
      const q = { most_relevant: choice("Which memory is most relevant to the query?", bare) };
      for (const m of mems) q[`rel_${m.id}`] = lib.relevanceNoul(m.id);
      const b = (await jev.call({ query: Q, memories: state }, q, { label: "diag" })).answers;
      rec[key].push({ newLine: b.most_relevant.probabilities.newlin, tsc: b.most_relevant.probabilities.tscdec, relNewLine: b.rel_newlin.noul, relTsc: b.rel_tscdec.noul, relPref: b.rel_prefdp.noul });
    }
  }
  const injectedOld = rec.old.every((x) => x.newLine >= 0.05);
  const picks = (x) => x.relNewLine >= lib.RELEVANCE_SURE || (x.relNewLine >= 0.8 && x.newLine >= 0.05);
  rec.injected = { old: injectedOld, new: rec.new.every(picks), newWithReplaces: rec.newWithReplaces.every(picks) };
  out.push(rec);
  console.log(`${source}: new line injected: old ${rec.injected.old}, new ${rec.injected.new}, new with replaces ${rec.injected.newWithReplaces} | ${text.slice(0, 70)}`);
}
const count = (k) => `${out.filter((r) => r.injected[k]).length}/${out.length}`;
const summary = { old_questions: count("old"), new_questions: count("new"), new_questions_with_replaces: count("newWithReplaces") };
const file = `results/diag-recall-supersede-e2e-${new Date().toISOString().slice(0, 10)}.json`;
fs.writeFileSync(file, JSON.stringify({ kind: "diag-recall-supersede-e2e", date: new Date().toISOString().slice(0, 10), reps: REPS, query: Q, method: "Each case's three live lines sent as recall would, in process, cache off, repeated `reps` times; a case counts as injected when every repeat injects the new line: old = the 0.5.9 rule (choice ≥ 0.05), new = relevance ≥ 0.97, or ≥ 0.8 with the choice ≥ 0.05.", summary, cases: out }, null, 2) + "\n");
console.log(summary, "→", file);
