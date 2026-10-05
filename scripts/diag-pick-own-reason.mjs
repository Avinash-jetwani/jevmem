#!/usr/bin/env node
// Diagnosis for 0.6.5 (docs/benchmark.md, "The cause last"): what Jev answers to the pick's two questions (src/pick.ts)
// on the turns of a line-text dev set, each asked several times: which sentence states the memory, and how likely each
// sentence is the one that gives its reason, with "none". It shows the turns where Jev's first answer to the reason
// question is the main sentence itself (it holds its own reason), and how little is then left for the runner-up, which
// the writer took as "the reason" up to 0.6.4.
//
//   node scripts/diag-pick-own-reason.mjs [path/to/dist/index.js] [--set cause-last-dev|dev] [--asks 2] [--out results/…json]
//
// Dev sets only (eval/cause-last-dev.jsonl, eval/lines-dev.jsonl): the held-out sets are not for looking into.
// The request is the one the writer sends (`pickRequest`), on the text the hook would give it for the row's labelled
// source; nothing is written anywhere but the results file. Needs TYPESAFE_API_KEY.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const distArg = args[0] && !args[0].startsWith("--") ? args[0] : path.resolve("dist/index.js");
const SET = opt("--set", "cause-last-dev");
const FILE = { "cause-last-dev": "eval/cause-last-dev.jsonl", dev: "eval/lines-dev.jsonl" }[SET];
if (!FILE) throw new Error(`unknown --set ${SET} (dev sets only)`);
const ASKS = Number(opt("--asks", "2"));
const OUT = opt("--out", null);
const lib = await import(pathToFileURL(path.resolve(distArg)).href);
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const rows = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() + (execFileSync("git", ["status", "--porcelain", "src"], { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {}
let version = null;
try {
  let dir = path.dirname(path.resolve(distArg));
  for (let i = 0; i < 3 && !version; i++, dir = path.dirname(dir)) if (fs.existsSync(path.join(dir, "package.json"))) version = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version ?? null;
} catch {}

const round = (x) => Math.round(x * 100) / 100;
const has = (text, keys) => (keys ?? []).some((k) => text.toLowerCase().includes(k.toLowerCase()));
const jev = lib.createJev({ noLogFile: true, cache: false });
const out = [];
const startedAt = new Date().toISOString();
for (const r of rows) {
  const input = r.source === "user" ? r.user : r.source === "assistant" ? r.assistant : lib.mergeTurn(r.user, r.assistant);
  const sentences = lib.candidateSentences(input, { fromReply: r.source === "assistant" });
  if (sentences.length < 2) continue;
  const { state, questions } = lib.pickRequest(sentences, r.label.kind, r.worksNow ? { worksNow: true } : {});
  const text = (id) => sentences.find((s) => s.id === id)?.text ?? "";
  const asks = [];
  for (let i = 0; i < ASKS; i++) {
    try {
      const a = (await jev.call(state, questions, { label: "line" })).answers;
      const main = String(a.states_the_memory?.choice);
      const probs = a.gives_the_reason?.probabilities ?? {};
      const ranked = Object.entries(probs).sort((x, y) => y[1] - x[1]);
      const others = ranked.filter(([id]) => id !== main && id !== "none");
      asks.push({
        main,
        mainStatesFact: has(text(main), r.factKeys),
        firstAnswer: ranked[0]?.[0] ?? null,
        firstAnswerIsMain: ranked[0]?.[0] === main,
        mainAsReason: round(probs[main] ?? 0),
        none: round(probs.none ?? 0),
        runnerUp: others[0] ? { id: others[0][0], p: round(others[0][1]), text: text(others[0][0]).slice(0, 80), hasLabelledReason: r.reason ? has(text(others[0][0]), r.reasonKeys) : null } : null,
        reason: Object.fromEntries(ranked.map(([id, p]) => [id, round(p)])),
      });
    } catch (err) {
      asks.push({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    }
  }
  out.push({ id: r.id, tag: r.tag, subtype: r.subtype, kind: r.label.kind, sentences: sentences.map((s) => ({ id: s.id, chars: s.text.length, text: s.text.slice(0, 80) })), mainHoldsLabelledReason: r.reason ? asks.filter((a) => !a.error).every((a) => has(text(a.main), r.reasonKeys)) : null, asks });
  const ok = asks.filter((a) => !a.error);
  process.stderr.write(`${r.id.padEnd(22)} ${ok.map((a) => `main ${a.main}${a.firstAnswerIsMain ? ` holds the reason ${a.mainAsReason.toFixed(2)}, runner-up ${a.runnerUp ? `${a.runnerUp.id} ${a.runnerUp.p.toFixed(2)}` : "-"}, none ${a.none.toFixed(2)}` : ` reason ${a.firstAnswer} ${(a.reason[a.firstAnswer] ?? 0).toFixed(2)}`}`).join(" | ")}\n`);
}
const finishedAt = new Date().toISOString();

const all = out.flatMap((o) => o.asks.filter((a) => !a.error).map((a) => ({ ...a, tag: o.tag })));
const own = all.filter((a) => a.firstAnswerIsMain);
const range = (xs) => (xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null);
const summarize = (xs) => {
  const o = xs.filter((a) => a.firstAnswerIsMain);
  // The runner-up the writer took up to 0.6.4: another sentence that is at least as likely as "none".
  const taken = o.filter((a) => a.runnerUp && a.runnerUp.p >= a.none);
  return {
    answers: xs.length,
    firstAnswerIsMain: o.length,
    mainAsReason: range(o.map((a) => a.mainAsReason)),
    runnerUp: range(o.filter((a) => a.runnerUp).map((a) => a.runnerUp.p)),
    none: range(o.map((a) => a.none)),
    runnerUpAtLeastNone: taken.length,
    runnerUpUnder0_2: o.filter((a) => a.runnerUp && a.runnerUp.p < 0.2).length,
    runnerUpAtLeastNoneAndUnder0_2: taken.filter((a) => a.runnerUp.p < 0.2).length,
    runnerUpAtLeastNoneAndUnder0_2WithTheLabelledReason: taken.filter((a) => a.runnerUp.p < 0.2 && a.runnerUp.hasLabelledReason).length,
  };
};
const summary = { started_at: startedAt, finished_at: finishedAt, turns: out.length, asksPerTurn: ASKS, errors: out.flatMap((o) => o.asks).filter((a) => a.error).length, all: summarize(all), byTag: Object.fromEntries([...new Set(all.map((a) => a.tag))].map((t) => [t, summarize(all.filter((a) => a.tag === t))])) };
const report = {
  kind: "diag-pick-own-reason",
  set: FILE,
  date: new Date().toISOString().slice(0, 10),
  jevmem_version: version,
  commit,
  dist: path.relative(process.cwd(), path.resolve(distArg)),
  machine: `${process.platform} ${process.arch}, node ${process.version}, ${os.cpus()[0]?.model ?? "cpu"}`,
  network_path: `direct HTTPS to ${process.env.TYPESAFE_BASE_URL ?? "the TypeSafe API default base URL"}, warm in-process client, cache off`,
  summary,
  rows: out,
};
if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
}
console.log(`${FILE}: ${out.length} turns with two sentences or more, ${ASKS} asks each, ${all.length} answers${summary.errors ? `, ${summary.errors} errors` : ""}`);
console.log(`Jev's first answer to the reason question was the main sentence itself in ${own.length} of ${all.length} answers`);
if (own.length) {
  const s = summary.all;
  console.log(`  there: the main sentence ${s.mainAsReason.min.toFixed(2)} to ${s.mainAsReason.max.toFixed(2)}, the runner-up ${s.runnerUp ? `${s.runnerUp.min.toFixed(2)} to ${s.runnerUp.max.toFixed(2)}` : "-"}, none ${s.none.min.toFixed(2)} to ${s.none.max.toFixed(2)}`);
  console.log(`  a runner-up at least as likely as "none" (taken as the reason up to 0.6.4): ${s.runnerUpAtLeastNone}; of those under 0.2 (not taken since 0.6.5): ${s.runnerUpAtLeastNoneAndUnder0_2}, with the labelled reason in ${s.runnerUpAtLeastNoneAndUnder0_2WithTheLabelledReason}`);
}
if (OUT) console.log(`\nwritten ${OUT}`);
