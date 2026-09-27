#!/usr/bin/env node
// Wordings of the tier-1 contradiction noul (v0.6 part 2c), asked alone, on dev turns that must supersede a listed line
// (dead-end reversals, contradictions-dev positives) and dev turns that must not (dead ends that keep a listed line,
// near misses, contradictions-dev negatives, dev v3 questions and plain statements). Dev sets only. old1 is part 2b's
// wording, cur1 a first change, fail2 the wording in src/questions.ts.
//
//   node scripts/diag-contradiction-wording.mjs <path/to/dist/index.js> [--variants old1,cur1,fail1,fail2] [--out file]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { noul } from "@typesafe-ai/sdk";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const lib = await import(pathToFileURL(path.resolve(args[0])).href);
const VARS = opt("--variants", "cur1").split(",");
const OUT = opt("--out", null);
const read = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rows = [];
for (const f of ["eval/dead-ends-dev.jsonl", "eval/dead-ends-dev-v2.jsonl", "eval/dead-ends-dev-v3.jsonl"]) for (const r of read(f)) {
  if (r.tag === "dead-end-reversal") rows.push({ ...r, want: true, group: "reversal" });
  else if (["dead-end-agrees", "supersede-near-miss", "question-proposal", "question-no-content"].includes(r.tag)) rows.push({ ...r, want: false, group: r.tag });
  else if (r.tag === "plain-statement") rows.push({ ...r, want: false, group: "plain" });
  else if (r.tag === "dead-end" || r.tag === "a-failed-b-worked") rows.push({ ...r, want: Boolean(r.contradicts), group: "dead-end" });
}
for (const c of read("eval/contradictions-dev.jsonl")) rows.push({ id: c.id ?? c.user.slice(0, 20), user: c.user, assistant: c.assistant ?? "", existing: c.existing, want: Boolean(c.contradicts), group: c.contradicts ? "contra+" : "contra-" });

const T1 = {
  cur1: {
    q: "Does the user message change or conflict with one of the existing memories listed in the state?",
    yes: { what: "Replaces or reverses a listed memory, including when what a listed memory states failed and is dropped or replaced.", examples: ["Switch to Postgres (a memory says SQLite)."] },
    no: { what: "Agrees with, extends, or is unrelated to every listed memory, including an alternative to a listed memory that was tried and then undone, which leaves that memory standing.", examples: ["Also add an index on users.email (memory says Postgres)."] },
  },
  old1: {
    q: "Does the user message change or conflict with one of the existing memories listed in the state?",
    yes: { what: "Replaces or reverses a listed memory.", examples: ["Switch to Postgres (a memory says SQLite)."] },
    no: { what: "Agrees with, extends, or is unrelated to every listed memory, including a replacement that was tried and then undone, which leaves the memory standing.", examples: ["Also add an index on users.email (memory says Postgres)."] },
  },
  // The yes side says a failure report that ends a listed approach is a change, with an example of one.
  fail1: {
    q: "Does the user message change or conflict with one of the existing memories listed in the state?",
    yes: { what: "Replaces or reverses a listed memory, including a report that what a listed memory states kept failing, so it is dropped or replaced.", examples: ["The nightly export keeps timing out, so it moves to a streaming job (a memory says exports run nightly)."] },
    no: { what: "Agrees with, extends, or is unrelated to every listed memory, including an alternative to a listed memory that was tried and then undone, which leaves that memory standing.", examples: ["Also add an index on users.email (memory says Postgres)."] },
  },
  // fail1, with the question naming the case.
  fail2: {
    q: "Does the user message change, conflict with, or drop one of the existing memories listed in the state, for example because what it states failed?",
    yes: { what: "Replaces or reverses a listed memory, including a report that what a listed memory states kept failing, so it is dropped or replaced.", examples: ["The nightly export keeps timing out, so it moves to a streaming job (a memory says exports run nightly)."] },
    no: { what: "Agrees with, extends, or is unrelated to every listed memory, including an alternative to a listed memory that was tried and then undone, which leaves that memory standing.", examples: ["Also add an index on users.email (memory says Postgres)."] },
  },
};

const jev = lib.createJev({ noLogFile: true, cache: false, timeoutMs: 30000 });
const out = [];
for (const r of rows) {
  const { state } = lib.buildDecideState({ userMessage: r.user, assistantReply: r.assistant, existingMemories: r.existing });
  const q = {};
  for (const v of VARS) q[v] = noul(T1[v].q, { true: T1[v].yes, false: T1[v].no });
  let a;
  for (let i = 0; ; i++) { try { a = await jev.call(state, q, { label: "diag", tier: 1 }); break; } catch (e) { if (i > 1) throw e; } }
  out.push({ id: r.id, group: r.group, want: r.want, ...Object.fromEntries(VARS.map((v) => [v, a.answers[v].noul])) });
  process.stderr.write(".");
}
process.stderr.write("\n");
for (const v of VARS) {
  const pos = out.filter((o) => o.want), neg = out.filter((o) => !o.want);
  const byGroup = {};
  for (const o of out) { const g = (byGroup[o.group] ??= { n: 0, hi: 0 }); g.n++; if (o[v] >= 0.7) g.hi++; }
  console.log(`${v.padEnd(6)} positives ≥0.7 ${pos.filter((o) => o[v] >= 0.7).length}/${pos.length}; negatives ≥0.7 ${neg.filter((o) => o[v] >= 0.7).length}/${neg.length}  ${Object.entries(byGroup).map(([g, x]) => `${g} ${x.hi}/${x.n}`).join(", ")}`);
}
for (const o of out.filter((o) => o.group === "reversal" || (o.want && VARS.some((v) => o[v] < 0.7)) || (!o.want && VARS.some((v) => o[v] >= 0.7)))) console.log(`  ${o.want ? "+" : "-"} ${String(o.id).padEnd(24)} ${o.group.padEnd(20)} ${VARS.map((v) => `${v}=${o[v].toFixed(2)}`).join(" ")}`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
