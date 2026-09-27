/**
 * The gate for lines that arrive already written (MCP `add_memory`): the same scrub → decide → write path the hook
 * uses, except that the agent's line is kept as the text instead of being condensed by the writer.
 */
import crypto from "node:crypto";
import type { loadConfig } from "./config.js";
import { decide, type Decision } from "./decide.js";
import type { JevCaller } from "./jev.js";
import { recordDecision } from "./labels.js";
import { recordProvenance } from "./provenance.js";
import { clampLine, combineRetest } from "./llm/index.js";
import { scrubSecrets } from "./scrub.js";
import type { MemoryStore } from "./store.js";
import type { Kind, Memory } from "./types.js";
import { DEAD_END_NO_REASON } from "./write.js";

export type GatedAddResult =
  | { ok: true; saved: Memory; superseded: Memory | null; kind: Kind; kindFrom: "jev" | "caller"; redacted: boolean; decision: Decision }
  | { ok: false; reason: string; decision?: Decision };

/**
 * Scrub the line, ask Jev about it, and write it unless it is refused:
 * - refused when the injection family is at or above `thresholds.injectionMax`,
 * - refused when the chit-chat family is at or above `thresholds.chitChatMax`,
 * - refused when it duplicates a live memory.
 * - refused when it is a retry of a live dead end that failed again for the reason that line gives (docs/dead-ends.md).
 * The kind is Jev's when Jev names one, else the caller's. A contradiction supersedes the old line, as in the hook; a retry
 * that failed for a new reason is saved as one line with both reasons (the old line's, then the agent's), which replaces
 * the old one. Importance is not a gate here: the agent was asked (by the rule or the user) to record this line.
 */
export async function gatedAdd(jev: JevCaller, store: MemoryStore, cfg: ReturnType<typeof loadConfig>, text: string, callerKind: Kind): Promise<GatedAddResult> {
  const clean = clampLine(scrubSecrets(text).replace(/\s+/g, " ").trim(), cfg.writer.maxChars);
  if (clean.length < 3) return { ok: false, reason: "empty line after scrubbing" };
  const existing = store.active();
  const decision = await decide(
    jev,
    { userMessage: clean, existingMemories: existing },
    { thresholds: cfg.thresholds, weights: cfg.weights, tiers: cfg.tiers, maxIds: cfg.jev.maxIdsPerCall, timeoutMs: cfg.jev.timeoutMs },
  );
  const hash = crypto.createHash("sha1").update(`add_memory\n${clean}`).digest("hex").slice(0, 16);
  const inj = decision.families.injection ?? 0;
  const chat = decision.families.chit_chat ?? 0;
  const refuse = (reason: string): GatedAddResult => {
    recordDecision(store.root, { hash, message: clean, decision: { ...decision, save: false, reason } });
    return { ok: false, reason, decision };
  };
  if (inj >= decision.thresholds.injectionMax) return refuse(`refused: the line reads as instructions aimed at an AI (injection ${inj.toFixed(2)} ≥ ${decision.thresholds.injectionMax})`);
  if (chat >= decision.thresholds.chitChatMax) return refuse(`refused: the line is small talk with no project content (chit-chat ${chat.toFixed(2)} ≥ ${decision.thresholds.chitChatMax})`);
  const dup = existing.find((m) => m.text.toLowerCase() === clean.toLowerCase());
  if (dup) return refuse(`refused: duplicate of ${dup.id}`);
  let kindFrom: "jev" | "caller" = decision.kind !== "none" ? "jev" : "caller";
  let kind = (decision.kind !== "none" ? decision.kind : callerKind) as Kind;
  // A dead end says why it failed or was dropped (docs/dead-ends.md), and Jev decides whether this line does: the dead-end
  // noul, asked in the same request. Jev reading a line as a dead end that gives no reason leaves the caller's kind; a
  // caller's dead end with no reason is refused.
  const why = decision.families["dead-end"] ?? 0;
  if (kind === "dead-end" && why < decision.thresholds.deadEndMin) {
    if (callerKind === "dead-end") return refuse(`refused: ${DEAD_END_NO_REASON} (dead-end ${why.toFixed(2)} < ${decision.thresholds.deadEndMin}); say what was tried and why it failed or was dropped`);
    kind = callerKind;
    kindFrom = "caller";
  }
  // A retry of a live dead end that failed again: the same reason adds nothing; a new reason is one line with both.
  const retest = decision.retest;
  if (retest?.id && retest.same && (kind === "dead-end" || kind === "bug")) return refuse(`refused: ${retest.id} already says this approach failed, for this reason (a retry that failed again adds nothing)`);
  const earlier = kind === "dead-end" && retest?.id && !retest.same ? existing.find((m) => m.id === retest.id) : undefined;
  const saved = store.add({ kind, text: earlier ? combineRetest(earlier.text, clean, cfg.writer.maxChars) : clean, conf: decision.confidence });
  recordProvenance(store.root, saved, "mcp");
  const target = earlier ? earlier.id : decision.contradiction ? decision.touchesMemoryId : null;
  const superseded = target ? store.supersede(target, saved.id) : null;
  recordDecision(store.root, { hash, memoryId: saved.id, message: clean, decision: { ...decision, save: true, kind } });
  return { ok: true, saved, superseded, kind, kindFrom, redacted: clean !== clampLine(text.replace(/\s+/g, " ").trim(), cfg.writer.maxChars), decision };
}
