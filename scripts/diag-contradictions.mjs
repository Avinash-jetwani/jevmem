#!/usr/bin/env node
// Contradiction diagnostics on eval/contradictions-dev.jsonl (the dev set; the held-out set is not used here).
//
//   node scripts/diag-contradictions.mjs [--modes fast,auto,full] [--out results/contradictions-dev-….json] [--label before]
//
// Per mode: contradictions found (right id), wrong id picked, missed (and why: not saved / saved without a
// supersede), false supersedes (a near-miss treated as a contradiction), p50 latency of turns that save.
// Every row keeps each tier's contradiction signals and the raw touches_memory_id distribution.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const modes = opt("--modes", "fast,auto,full").split(",");
const OUT = opt("--out", null);
const LABEL = opt("--label", "");
const lib = await import(pathToFileURL(path.resolve("dist/index.js")).href);
const cases = fs.readFileSync("eval/contradictions-dev.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** Wrap a JevCaller to keep the raw answers of every call made for the current case. */
function recording(jev) {
  const calls = [];
  return {
    calls,
    log: jev.log,
    async call(state, questions, o) {
      const res = await jev.call(state, questions, o);
      calls.push({ label: o.label, tier: o.tier, answers: res.answers });
      return res;
    },
  };
}
const top = (dist) => Object.entries(dist ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v.toFixed(2)}`);

async function runMode(mode) {
  const base = lib.createJev({ noLogFile: true, cache: false });
  try { await lib.decide(base, { userMessage: "warm-up", existingMemories: [] }, { tiers: { mode } }); } catch {}
  const rows = [];
  for (const t of cases) {
    const jev = recording(base);
    const t0 = performance.now();
    const d = await lib.decide(jev, { userMessage: t.user, assistantReply: t.assistant, existingMemories: t.existing }, { tiers: { mode } });
    const ms = Math.round(performance.now() - t0);
    const byTier = Object.fromEntries(jev.calls.filter((c) => c.label !== "supersede").map((c) => [`tier${c.tier}`, c.answers]));
    const sup = jev.calls.find((c) => c.label === "supersede");
    rows.push({
      tag: t.tag,
      subtype: t.subtype,
      user: t.user,
      want: t.contradicts,
      got: d.contradiction ? d.touchesMemoryId : null,
      save: d.save,
      ms,
      calls: jev.calls.length,
      reason: d.reason,
      escalationReasons: d.escalationReasons,
      tier1: byTier.tier1 ? { contradicts_existing_memory: byTier.tier1.contradicts_existing_memory?.noul, touches: top(byTier.tier1.touches_memory_id?.probabilities) } : null,
      tier2: byTier.tier2 ? { contradiction_family: d.tier2?.families.contradiction, reverses: byTier.tier2.reverses_or_replaces_a_listed_memory?.noul, change_vocab: byTier.tier2.uses_change_of_plan_instead_or_actually?.noul, same_topic: byTier.tier2.is_about_the_same_topic_as_a_listed_memory?.noul, content: d.tier2 ? Math.max(...["decision", "constraint", "preference", "bug", "architecture", "todo"].map((k) => d.tier2.families[k])) : null, injection_family: d.tier2?.families.injection, injection_nouls: Object.fromEntries(["tells_an_ai_to_ignore_or_replace_instructions", "claims_system_or_admin_authority_over_the_ai", "asks_the_ai_to_store_or_alter_memory_or_rules", "quotes_text_from_a_file_or_page_addressed_to_an_ai"].map((n) => [n, byTier.tier2[n]?.noul])), touches: top(byTier.tier2.touches_memory_id?.probabilities) } : null,
      supersedeCheck: sup ? { replaces: top(sup.answers.replaces_memory_id?.probabilities) } : null,
    });
  }
  const contra = rows.filter((r) => r.want);
  const near = rows.filter((r) => !r.want);
  const found = contra.filter((r) => r.got === r.want).length;
  const wrongId = contra.filter((r) => r.got && r.got !== r.want).length;
  const missedNotSaved = contra.filter((r) => !r.got && !r.save).length;
  const missedSaved = contra.filter((r) => !r.got && r.save).length;
  const falseSup = near.filter((r) => r.got).length;
  const saveLat = rows.filter((r) => r.save).map((r) => r.ms).sort((a, b) => a - b);
  const allLat = rows.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null);
  return {
    mode,
    contradictions: contra.length,
    near_misses: near.length,
    found,
    found_rate: found / contra.length,
    wrong_id: wrongId,
    missed_not_saved: missedNotSaved,
    missed_saved_without_supersede: missedSaved,
    false_supersedes: falseSup,
    near_misses_saved: near.filter((r) => r.save).length,
    p50_ms_saving_turns: pct(saveLat, 0.5),
    p95_ms_saving_turns: pct(saveLat, 0.95),
    p50_ms_all: pct(allLat, 0.5),
    rows,
  };
}

let commit = null;
try { commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src", { encoding: "utf8" }).trim() ? "+dirty" : ""); } catch {}
const startedAt = new Date().toISOString();
const results = [];
for (const m of modes) results.push(await runMode(m));
const report = { kind: "contradictions-dev", label: LABEL, started_at: startedAt, finished_at: new Date().toISOString(), commit, eval_set: "eval/contradictions-dev.jsonl", cases: cases.length, jevmem_version: JSON.parse(fs.readFileSync("package.json", "utf8")).version, results };
if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
}
console.log(`contradictions-dev (${cases.length} cases)${LABEL ? ` [${LABEL}]` : ""}, commit ${commit}`);
console.log("mode   found        wrong id  missed(skip)  missed(saved)  false supersedes  p50 saving  p95 saving");
for (const r of results) console.log(`${r.mode.padEnd(6)} ${`${r.found}/${r.contradictions}`.padEnd(12)} ${String(r.wrong_id).padEnd(9)} ${String(r.missed_not_saved).padEnd(13)} ${String(r.missed_saved_without_supersede).padEnd(14)} ${`${r.false_supersedes}/${r.near_misses}`.padEnd(17)} ${String(r.p50_ms_saving_turns).padStart(4)} ms    ${String(r.p95_ms_saving_turns).padStart(4)} ms`);
if (OUT) console.log(`written ${OUT}`);
