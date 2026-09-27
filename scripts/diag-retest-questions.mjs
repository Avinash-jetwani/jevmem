#!/usr/bin/env node
// The retest questions of v0.6 part 2c (tried again and failed again? which listed dead end? a new reason?), asked alone
// on every dev turn that lists a live dead end, in two wordings: v1, the first, and v2, the one in src/questions.ts.
// Dev sets only. Expected: retries (dev v3's retest rows and the near misses that retry) high, the right line, the
// new-reason noul high only for a new reason; every other turn low.
//
//   node scripts/diag-retest-questions.mjs <path/to/dist/index.js> [--variant v1|v2] [--out file]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { choice, noul } from "@typesafe-ai/sdk";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const lib = await import(pathToFileURL(path.resolve(args[0])).href);
const V = opt("--variant", "v1");
const OUT = opt("--out", null);
const read = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rows = ["eval/dead-ends-dev.jsonl", "eval/dead-ends-dev-v2.jsonl", "eval/dead-ends-dev-v3.jsonl"].flatMap((f) => read(f)).filter((r) => r.existing.some((m) => m.kind === "dead-end"));
const expect = (r) => {
  if (r.tag === "retest-same" || r.subtype === "retest" || r.id === "dev-ferry-035") return { again: true, id: r.retest?.of ?? r.existing.find((m) => m.kind === "dead-end" && true)?.id, fresh: false };
  if (r.tag === "retest-new") return { again: true, id: r.retest.of, fresh: true };
  return { again: false, id: "none", fresh: null };
};

const VARIANTS = {
  v1: (deadEnds) => {
    const options = {};
    for (const m of deadEnds) options[m.id] = { what: `[dead-end] ${m.text}` };
    options.none = "No listed dead end was tried again and failed again.";
    return {
      dead_end_failed_again: noul("Does the user message or the assistant reply show that the approach in one of the listed dead-end memories was tried again and failed again?", {
        true: { what: "The approach a listed [dead-end] memory says failed was tried again in this turn, or a new attempt is reported, and it failed or was given up again.", examples: ["A dead end says the CSV export ran out of memory; the reply ran it again on a bigger worker and it still ran out of memory."] },
        false: { what: "No listed dead end was tried again and failed: it works now, it is only mentioned, planned or asked about, or the turn tried something else.", examples: ["The reply says streaming the rows fixed the export."] },
      }),
      dead_end_that_failed_again: choice("Which listed dead-end memory's approach was tried again and failed again?", options),
      dead_end_new_reason: noul("Does the turn give a reason the approach failed this time that the listed dead-end memory does not already give?", {
        true: { what: "It failed for a different reason than the memory states: a different error, limit, measurement or cost, often because the first problem was fixed and another one appeared.", examples: ["A dead end says the export ran out of memory; this time memory was fine, but it took 40 minutes, over the 10-minute limit."] },
        false: { what: "It failed for the reason the memory already gives, even with new numbers or a new version, or the turn gives no reason, or nothing was tried again.", examples: ["A dead end says the export ran out of memory; with the new version it ran out of memory again."] },
      }),
    };
  },
  v2: (deadEnds) => {
    const options = {};
    for (const m of deadEnds) options[m.id] = { what: `[dead-end] ${m.text}` };
    options.none = "No listed dead end was tried again and failed again.";
    return {
      dead_end_failed_again: noul("Does the user message or the assistant reply show that the approach in one of the listed dead-end memories was tried again and still failed, for the same reason or a new one?", {
        true: { what: "The approach a listed [dead-end] memory says failed was tried again in this turn, or a new attempt is reported, and it was given up again: the old problem came back, or it was fixed and another one stopped it.", examples: ["A dead end says the CSV export ran out of memory; the reply ran it again on a bigger worker and it still ran out of memory."] },
        false: { what: "No listed dead end was tried again and given up: it works now with nothing else in the way, it is only mentioned, planned or asked about, or the turn tried something else.", examples: ["The reply says streaming the rows fixed the export."] },
      }),
      dead_end_that_failed_again: choice("Which listed dead-end memory's approach was tried again and failed again?", options),
      dead_end_new_reason: noul("Does the turn give a reason the approach failed this time that the listed dead-end memory does not already give?", {
        true: { what: "It failed for a different reason than the memory states: a different error, limit, measurement or cost, often because the first problem was fixed and another one appeared.", examples: ["A dead end says the export ran out of memory; this time memory was fine, but it took 40 minutes, over the 10-minute limit."] },
        false: { what: "It failed for the reason the memory already gives, even with new numbers or a new version, or the turn gives no reason, or nothing was tried again.", examples: ["A dead end says the export ran out of memory; with the new version it ran out of memory again."] },
      }),
    };
  },
};

const jev = lib.createJev({ noLogFile: true, cache: false, timeoutMs: 30000 });
const out = [];
let tokens = 0;
for (const r of rows) {
  const { state, candidates } = lib.buildDecideState({ userMessage: r.user, assistantReply: r.assistant, existingMemories: r.existing });
  const deadEnds = candidates.filter((m) => m.kind === "dead-end");
  const q = VARIANTS[V](deadEnds);
  let a;
  for (let i = 0; ; i++) { try { a = await jev.call(state, q, { label: "diag", tier: 1 }); break; } catch (e) { if (i > 1) throw e; } }
  tokens += a.usage.input_tokens;
  const x = a.answers;
  const e = expect(r);
  out.push({ id: r.id, tag: r.tag, subtype: r.subtype, inState: "assistant_reply" in state, again: x.dead_end_failed_again.noul, which: x.dead_end_that_failed_again.choice, whichP: x.dead_end_that_failed_again.probabilities, fresh: x.dead_end_new_reason.noul, expect: e });
  process.stderr.write(".");
}
process.stderr.write("\n");
const f = (v) => v.toFixed(2);
for (const o of out) console.log(`${o.expect.again ? (o.expect.fresh ? "NEW " : "SAME") : "    "} ${o.id.padEnd(22)} ${o.tag.padEnd(20)} reply=${o.inState ? "y" : "n"} again=${f(o.again)} which=${o.which}${o.expect.again ? (o.which === o.expect.id ? "✓" : `✗(${o.expect.id})`) : ""} new=${f(o.fresh)}`);
const same = out.filter((o) => o.expect.again && !o.expect.fresh), fresh = out.filter((o) => o.expect.fresh), neg = out.filter((o) => !o.expect.again);
console.log(`same: again≥0.7 ${same.filter((o) => o.again >= 0.7).length}/${same.length}, id ✓ ${same.filter((o) => o.which === o.expect.id).length}, new<0.5 ${same.filter((o) => o.fresh < 0.5).length}`);
console.log(`new: again≥0.7 ${fresh.filter((o) => o.again >= 0.7).length}/${fresh.length}, id ✓ ${fresh.filter((o) => o.which === o.expect.id).length}, new≥0.5 ${fresh.filter((o) => o.fresh >= 0.5).length}`);
console.log(`not a retest: again≥0.7 ${neg.filter((o) => o.again >= 0.7).length}/${neg.length} (${neg.filter((o) => o.again >= 0.7).map((o) => o.id).join(", ")}), max ${f(Math.max(...neg.map((o) => o.again)))}`);
console.log(`tokens ${tokens}`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
