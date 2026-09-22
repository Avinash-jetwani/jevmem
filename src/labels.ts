/**
 * The feedback loop: every decision is recorded, the user labels some of them (`right`, `wrong`, `missed`),
 * and `fit` refits the weights and thresholds from those labels.
 */
import fs from "node:fs";
import path from "node:path";
import { fit, type FitResult, type LabelledExample } from "./combine.js";
import { CONFIG_FILE, loadConfig } from "./config.js";
import { decide, resolveWeights, type Decision } from "./decide.js";
import type { JevCaller } from "./jev.js";
import { ATOMIC_NOULS, FAMILIES } from "./questions.js";
import { scrubSecrets } from "./scrub.js";
import { IMPORTANCE_LEVELS, type JevmemConfig, type Memory } from "./types.js";

export interface DecisionRecord {
  ts: string;
  /** Short hash of the evaluated turn. */
  hash: string;
  memoryId?: string;
  message: string;
  decision: Decision;
  via?: string;
}

export interface LabelRecord {
  ts: string;
  source: "right" | "wrong" | "missed";
  hash: string;
  memoryId?: string;
  message: string;
  label: { save: boolean; kind: string };
  /** What Jev said at the time, so `fit` can re-run the policy offline. */
  answers: { nouls: Record<string, number>; kindChoice: string; importanceScore: number; touchesMemoryId: string; families: Record<string, number> };
}

const decisionsFile = (root: string) => path.join(root, ".jevmem", "decisions.jsonl");
const labelsFile = (root: string) => path.join(root, ".jevmem", "labels.jsonl");
const fitFile = (root: string) => path.join(root, ".jevmem", "fit.json");

function readJsonl<T>(file: string): T[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

export function recordDecision(root: string, rec: Omit<DecisionRecord, "ts">): void {
  try {
    const file = decisionsFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...rec, message: scrubSecrets(rec.message).slice(0, 2000) }) + "\n");
    // Keep the file bounded: rewrite with the last 500 when it passes 1000 lines.
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > 1000) fs.writeFileSync(file, lines.slice(-500).join("\n") + "\n");
  } catch {
    /* best effort */
  }
}

export function readDecisions(root: string): DecisionRecord[] {
  return readJsonl<DecisionRecord>(decisionsFile(root));
}

/** Find by memory id, or by a prefix of the turn hash. Latest match wins. */
export function findDecision(root: string, idOrHash: string): DecisionRecord | null {
  const all = readDecisions(root);
  for (let i = all.length - 1; i >= 0; i--) {
    const r = all[i]!;
    if (r.memoryId === idOrHash || r.hash.startsWith(idOrHash)) return r;
  }
  return null;
}

export function readLabels(root: string): LabelRecord[] {
  return readJsonl<LabelRecord>(labelsFile(root));
}

export function addLabel(root: string, label: Omit<LabelRecord, "ts">): number {
  const file = labelsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...label }) + "\n");
  return readLabels(root).length;
}

function answersOf(d: Decision): LabelRecord["answers"] {
  return { nouls: d.nouls, kindChoice: d.kind, importanceScore: d.importanceScore, touchesMemoryId: d.touchesMemoryId ?? "none", families: d.families };
}

/** `jevmem right <id>`: the decision (save or skip, and the kind) was correct. */
export function labelRight(root: string, rec: DecisionRecord): number {
  return addLabel(root, { source: "right", hash: rec.hash, memoryId: rec.memoryId, message: rec.message, label: { save: rec.decision.save, kind: rec.decision.save ? rec.decision.kind : "none" }, answers: answersOf(rec.decision) });
}

/** `jevmem wrong <id> [--should-be kind|none]`: default is the opposite of what happened. */
export function labelWrong(root: string, rec: DecisionRecord, shouldBe?: string): { count: number; label: LabelRecord["label"] } {
  let label: LabelRecord["label"];
  if (shouldBe) label = { save: shouldBe !== "none", kind: shouldBe };
  else if (rec.decision.save) label = { save: false, kind: "none" };
  else label = { save: true, kind: rec.decision.kind !== "none" ? rec.decision.kind : "decision" };
  const count = addLabel(root, { source: "wrong", hash: rec.hash, memoryId: rec.memoryId, message: rec.message, label, answers: answersOf(rec.decision) });
  return { count, label };
}

/** `jevmem missed "<text>"`: a turn that should have been saved. Runs decide (so the answers are stored) and labels it save=true. */
export async function labelMissed(jev: JevCaller, root: string, cfg: JevmemConfig, text: string, kind?: string, existing: Pick<Memory, "id" | "kind" | "text">[] = []): Promise<{ count: number; decision: Decision; label: LabelRecord["label"] }> {
  const decision = await decide(jev, { message: text, existingMemories: existing }, { thresholds: cfg.thresholds, weights: cfg.weights, maxIds: cfg.jev.maxIdsPerCall });
  const label = { save: true, kind: kind ?? (decision.kind !== "none" ? decision.kind : "decision") };
  const hash = "missed-" + Date.now().toString(36);
  const count = addLabel(root, { source: "missed", hash, message: scrubSecrets(text).slice(0, 2000), label, answers: answersOf(decision) });
  return { count, decision, label };
}

export const MIN_LABELS = 40;

export interface FitInfo {
  at: string;
  n: number;
  before: FitResult["before"];
  after: FitResult["after"];
}

export function readFitInfo(root: string): FitInfo | null {
  try {
    return JSON.parse(fs.readFileSync(fitFile(root), "utf8"));
  } catch {
    return null;
  }
}

/** Refit from `.jevmem/labels.jsonl`. Writes `weights` and thresholds into `jevmem.config.json` unless `dryRun`. */
export function runFit(root: string, opts: { dryRun?: boolean; force?: boolean } = {}): { ok: true; result: FitResult; written: boolean } | { ok: false; reason: string; n: number } {
  const labels = readLabels(root);
  if (labels.length < MIN_LABELS && !opts.force) return { ok: false, reason: `need at least ${MIN_LABELS} labels to fit; have ${labels.length}. Label more with \`jevmem right|wrong|missed\`, or pass --force.`, n: labels.length };
  if (labels.length === 0) return { ok: false, reason: "no labels", n: 0 };
  const cfg = loadConfig(root);
  const examples: LabelledExample[] = labels.map((l) => ({ nouls: l.answers.nouls, kindChoice: l.answers.kindChoice, importanceScore: l.answers.importanceScore, touchesMemoryId: l.answers.touchesMemoryId, label: l.label }));
  const result = fit(examples, resolveWeights(cfg.weights), cfg.thresholds);
  let written = false;
  if (!opts.dryRun) {
    const file = path.join(root, CONFIG_FILE);
    let raw: any = {};
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      raw = {};
    }
    raw.weights = result.weights;
    raw.thresholds = { ...(raw.thresholds ?? {}), contentMin: result.thresholds.contentMin, importanceMin: result.thresholds.importanceMin, chitChatMax: result.thresholds.chitChatMax, injectionMax: result.thresholds.injectionMax };
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
    const info: FitInfo = { at: new Date().toISOString(), n: result.n, before: result.before, after: result.after };
    fs.writeFileSync(fitFile(root), JSON.stringify(info, null, 2));
    written = true;
  }
  return { ok: true, result, written };
}

/** Footer metadata for JEVMEM.md: `<!-- jevmem: 12 labels, last fit 2026-09-30 -->`. Null when nothing to say. */
export function footerMeta(root: string): { labels: number; lastFit: string | null } | null {
  const labels = readLabels(root).length;
  const fitInfo = readFitInfo(root);
  if (labels === 0 && !fitInfo) return null;
  return { labels, lastFit: fitInfo ? fitInfo.at.slice(0, 10) : null };
}

export function formatFooter(meta: { labels: number; lastFit: string | null }): string {
  return `<!-- jevmem: ${meta.labels} label${meta.labels === 1 ? "" : "s"}, last fit ${meta.lastFit ?? "never"} -->`;
}

// ---------------------------------------------------------------------------------------------
// `jevmem why`

export function formatWhy(rec: DecisionRecord): string {
  const d = rec.decision;
  const t = d.thresholds;
  const out: string[] = [];
  out.push(`${rec.memoryId ? `memory ${rec.memoryId}` : `turn ${rec.hash}`}  (${rec.ts}${rec.via ? `, via ${rec.via}` : ""})`);
  out.push(`message: ${rec.message.slice(0, 200).replace(/\s+/g, " ")}${rec.message.length > 200 ? "…" : ""}`);
  out.push("");
  out.push(`outcome: ${d.save ? "SAVED" : "SKIPPED"}  ${d.reason}`);
  out.push("");
  out.push("family scores (logistic over the atomic nouls):");
  for (const f of FAMILIES) {
    const v = d.families[f];
    let gate = "";
    if (f === "chit_chat") gate = `  max ${t.chitChatMax} ${v < t.chitChatMax ? "✓" : "✗"}`;
    if (f === "injection") gate = `  max ${t.injectionMax} ${v < t.injectionMax ? "✓" : "✗"}`;
    if (f === "contradiction") gate = `  min ${t.contradictionMin} ${v >= t.contradictionMin ? "✓" : "–"}`;
    out.push(`  ${f.padEnd(14)} ${bar(v)} ${v.toFixed(2)}${gate}`);
  }
  out.push(`  content (max kind family) ${d.content.toFixed(2)}  min ${t.contentMin} ${d.content >= t.contentMin ? "✓" : "✗"}`);
  out.push("");
  out.push("atomic nouls:");
  for (const f of FAMILIES) {
    for (const n of ATOMIC_NOULS.filter((n) => n.family === f)) {
      const v = d.nouls[n.name] ?? 0;
      out.push(`  ${bar(v)} ${v.toFixed(2)}  ${n.sign < 0 ? "−" : " "} ${n.name}`);
    }
  }
  out.push("");
  const kp = Object.entries(d.kindProbabilities).sort((a, b) => b[1] - a[1]).map(([k, p]) => `${k} ${p.toFixed(2)}`).join(", ");
  out.push(`kind choice: ${d.kind} (confidence ${d.confidence.toFixed(2)})  [${kp}]  ${d.kind !== "none" ? "✓" : "✗ kind=none"}`);
  out.push(`importance: ${d.importanceScore.toFixed(2)} → ${d.importance}  min ${t.importanceMin} ${IMPORTANCE_LEVELS.indexOf(d.importance) >= IMPORTANCE_LEVELS.indexOf(t.importanceMin) ? "✓" : "✗"}`);
  out.push(`touches memory: ${d.touchesMemoryId ?? "none"}  contradiction: ${d.contradiction ? "yes" : "no"}`);
  out.push(`tokens: ${d.usage.inputTokens + d.usage.outputTokens}${d.cacheHit ? " (cache hit)" : ""}`);
  return out.join("\n");
}

function bar(v: number): string {
  const n = Math.round(Math.max(0, Math.min(1, v)) * 10);
  return "█".repeat(n) + "░".repeat(10 - n);
}

export function formatFit(r: FitResult): string {
  const pct = (x: number) => (x * 100).toFixed(0).padStart(3) + "%";
  const out: string[] = [];
  out.push(`fit on ${r.n} labels`);
  out.push(`  before: F1 ${pct(r.before.f1)}  precision ${pct(r.before.precision)}  recall ${pct(r.before.recall)}  accuracy ${pct(r.before.accuracy)}`);
  out.push(`  after:  F1 ${pct(r.after.f1)}  precision ${pct(r.after.precision)}  recall ${pct(r.after.recall)}  accuracy ${pct(r.after.accuracy)}`);
  out.push(`  thresholds: contentMin ${r.thresholds.contentMin}, importanceMin ${r.thresholds.importanceMin}, chitChatMax ${r.thresholds.chitChatMax}, injectionMax ${r.thresholds.injectionMax}`);
  out.push("");
  out.push("reliability (content score bucket → observed save rate):");
  out.push("  bucket    n   predicted  observed");
  for (const row of r.reliability) out.push(`  ${row.bucket.padEnd(8)} ${String(row.n).padStart(3)}   ${pct(row.predicted)}       ${pct(row.observed)}`);
  return out.join("\n");
}
