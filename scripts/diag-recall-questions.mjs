// Recall question designs on the dev set (v0.6 part 3, eval/recall-dev.jsonl only): one Jev call per prompt per variant,
// in process (not through the hook), every raw answer saved to results/diag-recall-questions/<variant>.json, so the
// selection rules can be compared offline (scripts/diag-recall-sweep.mjs). The variants are the designs compared in
// DECISIONS.md: the shipped choice over 60 keyword-prefiltered candidates (v0), per-candidate nouls, every live line with
// bare ids, a short relevance noul, and the texts each line replaced (`replaces`). Never run on the held-out set.
//
//   node scripts/diag-recall-questions.mjs --variants v0,v1,...
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { choice, noul } from "@typesafe-ai/sdk";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SET = opt("--set", "dev");
if (SET !== "dev") throw new Error("dev only");
const lib = await import(pathToFileURL(path.join(REPO, "dist/index.js")).href);
const rows = fs.readFileSync(path.join(REPO, `eval/recall-${SET}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const files = rows.filter((r) => r.row === "file");
const prompts = rows.filter((r) => r.row === "prompt");
const OUTDIR = opt("--outdir", path.join(REPO, "results", "diag-recall-questions"));
fs.mkdirSync(OUTDIR, { recursive: true });

const REL_TRUE = { what: "The memory states something the query needs: the same component, tool, rule, or decision.", examples: ["Query asks about the database; memory names the database in use.", "Query asks how to deploy; memory says deploys go through CI only."] };
const REL_FALSE = { what: "The memory is about a different part of the project.", examples: ["Query asks about CSS; memory is about the database.", "Query asks about tests; memory is a naming preference."] };

const VARIANTS = {
  // The shipped design: choice over ≤60 keyword-prefiltered candidates, options carry the text.
  v0: { cap: 60, choice: "text", noul: null },
  // + the search noul per candidate (what MCP search_memory asks), same candidates.
  v1: { cap: 60, choice: "text", noul: "search" },
  // Bare-id choice (text only in the state) + the search noul, all live lines as candidates (≤255).
  v2: { cap: 255, choice: "bare", noul: "search" },
  // Bare-id choice + a compact noul with no examples, all live lines.
  v3: { cap: 255, choice: "bare", noul: "compact" },
  // No choice, compact noul, all live lines.
  v4: { cap: 255, choice: null, noul: "compact" },
  // Search noul only, all lines, no choice.
  v5: { cap: 255, choice: null, noul: "search" },
  // With the text of the lines each candidate replaced (its superseded predecessors) in the state.
  v6: { cap: 255, choice: "bare", noul: "compact", replaces: true },
  v7: { cap: 255, choice: "bare", noul: null, replaces: true },
  v8: { cap: 255, choice: "bare", noul: "search", replaces: true },
  // Bare choice + one existence noul (Jev's line-by-line search cookbook), with replaces.
  v9: { cap: 255, choice: "bare", noul: null, replaces: true, exists: true },
};

function noulFor(kind, id) {
  if (kind === "search") return noul(`Would memory ${id} help answer or act on the query?`, { true: REL_TRUE, false: REL_FALSE });
  if (kind === "compact") return noul(`Does memory ${id} state something that bears on what the query asks or wants done?`);
  throw new Error(kind);
}

async function runVariant(name) {
  const V = VARIANTS[name];
  const jev = lib.createJev({ noLogFile: true, cache: false });
  await jev.call("warm", { ok: noul("Is the state the word warm?") }, { label: "warm" }).catch(() => {});
  const out = [];
  for (const f of files) {
    const byKey = new Map(f.lines.map((l) => [l.key, l]));
    const live = f.lines.filter((l) => l.kind !== "superseded").map((l) => ({ id: l.id, kind: l.kind, text: l.text, key: l.key }));
    // For each live line, the texts it replaced: superseded lines whose chain of `by` ends at it (newest first).
    const replaced = new Map();
    for (const l of f.lines.filter((x) => x.kind === "superseded")) {
      let at = l;
      for (let h = 0; at.kind === "superseded" && h < 5; h++) at = byKey.get(at.by);
      if (!replaced.has(at.key)) replaced.set(at.key, []);
      replaced.get(at.key).unshift(l.text);
    }
    for (const p of prompts.filter((x) => x.file === f.id)) {
      const cands = lib.prefilterByOverlap(p.prompt, live, V.cap);
      const questions = {};
      if (V.choice) {
        const crit = {};
        for (const m of cands) crit[m.id] = V.choice === "text" ? `[${m.kind}] ${m.text}` : null;
        crit.none = { what: "No listed memory is relevant to the query.", examples: ["The query is about a topic none of the memories mention."] };
        questions.most_relevant = choice("Which memory is most relevant to the query?", crit);
      }
      if (V.noul) for (const m of cands) questions[`rel_${m.id}`] = noulFor(V.noul, m.id);
      if (V.exists) questions.exists = noul("Does any listed memory state something that bears on what the query asks or wants done?", { true: "At least one memory is about the same component, tool, rule, decision or approach as the query", false: "No memory is about what the query asks; it is about something else" });
      const state = { query: p.prompt, memories: cands.map((m) => ({ id: m.id, kind: m.kind, text: m.text, ...(V.replaces && replaced.has(m.key) ? { replaces: replaced.get(m.key).slice(0, 2) } : {}) })) };
      let res, err = null;
      const t0 = performance.now();
      for (let a = 0; a < 3; a++) {
        try { res = await jev.call(state, questions, { label: "exp", timeoutMs: 15000 }); err = null; break; } catch (e) { err = String(e); await new Promise((r) => setTimeout(r, 1500)); }
      }
      const ms = Math.round(performance.now() - t0);
      const rec = { id: p.id, file: f.id, size: f.size, type: p.type, want: p.want, ok: p.ok, never: p.never, candidates: cands.map((m) => m.key), missingFromCandidates: p.want.filter((k) => !cands.some((m) => m.key === k)), ms, error: err };
      if (res) {
        rec.jevMs = jev.log.at(-1).latencyMs;
        rec.inputTokens = res.usage.input_tokens;
        rec.choice = V.choice ? Object.fromEntries(Object.entries(res.answers.most_relevant.probabilities).map(([id, pr]) => [id === "none" ? "none" : f.lines.find((l) => l.id === id)?.key ?? id, pr])) : null;
        rec.noul = V.noul ? Object.fromEntries(cands.map((m) => [m.key, res.answers[`rel_${m.id}`]?.noul ?? null])) : null;
        rec.exists = V.exists ? res.answers.exists.noul : null;
      }
      out.push(rec);
      process.stderr.write(`${name} ${p.id} ${ms} ms ${rec.inputTokens ?? "ERR"} tok\n`);
    }
  }
  fs.writeFileSync(path.join(OUTDIR, `${name}.json`), JSON.stringify({ variant: name, design: VARIANTS[name], date: new Date().toISOString().slice(0, 10), set: "eval/recall-dev.jsonl", method: "In process, warm client, cache off: one Jev call per prompt with the variant's questions over the file's live lines; raw answers per prompt (choice probabilities and nouls by line key). Latency is the Jev call as logged by the client.", rows: out }, null, 1) + "\n");
  return out;
}

for (const v of opt("--variants", "v0").split(",")) await runVariant(v);
