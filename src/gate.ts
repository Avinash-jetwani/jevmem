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
import { clampLine } from "./llm/index.js";
import { scrubSecrets } from "./scrub.js";
import type { MemoryStore } from "./store.js";
import type { Kind, Memory } from "./types.js";

export type GatedAddResult =
  | { ok: true; saved: Memory; superseded: Memory | null; kind: Kind; kindFrom: "jev" | "caller"; redacted: boolean; decision: Decision }
  | { ok: false; reason: string; decision?: Decision };

/**
 * Scrub the line, ask Jev about it, and write it unless it is refused:
 * - refused when the injection family is at or above `thresholds.injectionMax`,
 * - refused when the chit-chat family is at or above `thresholds.chitChatMax`,
 * - refused when it duplicates a live memory.
 * The kind is Jev's when Jev names one, else the caller's. A contradiction supersedes the old line, as in the hook.
 * Importance is not a gate here: the agent was asked (by the rule or the user) to record this line.
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
  const kindFrom = decision.kind !== "none" ? "jev" : "caller";
  const kind = (decision.kind !== "none" ? decision.kind : callerKind) as Kind;
  const saved = store.add({ kind, text: clean, conf: decision.confidence });
  recordProvenance(store.root, saved, "mcp");
  const superseded = decision.contradiction && decision.touchesMemoryId ? store.supersede(decision.touchesMemoryId, saved.id) : null;
  recordDecision(store.root, { hash, memoryId: saved.id, message: clean, decision: { ...decision, save: true, kind } });
  return { ok: true, saved, superseded, kind, kindFrom, redacted: clean !== clampLine(text.replace(/\s+/g, " ").trim(), cfg.writer.maxChars), decision };
}
