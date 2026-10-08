/**
 * Dedupe on save (0.7.0): a line that says the same as a live one is not saved. Three checks, in this order:
 * 1. Before any request, the message against the live lines, word for word once normalised (a kind or label tag off the
 *    front, backticks and quotes gone, one space between words, lower case, no final punctuation): nothing is sent.
 * 2. Jev's question in the decide call, `restates_a_listed_memory` (src/questions.ts), read with the line
 *    `touches_memory_id` picks (src/combine.ts): at `thresholds.duplicateMin`, with a listed live line picked and no
 *    reversal, the turn is skipped as a duplicate of that line.
 * 3. After the writer, the finished line against the live lines, normalised the same way.
 * A skipped duplicate is recorded in `.jevmem/decisions.jsonl` (`jevmem why` says which line) and logged.
 */
import { stripLeadingTags } from "./tags.js";
import type { Memory } from "./types.js";

/** Text as compared for a duplicate: tags off the front, no backticks or quotes, one space between words, lower case, no final punctuation. */
export function normalizeForDupe(text: string): string {
  return stripLeadingTags(text.trim())
    .replace(/[`"'“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!;:,]+$/, "")
    .trim()
    .toLowerCase();
}

/** The live line `text` restates word for word (normalised), or null. A text under 8 characters matches nothing. */
export function findDuplicate<M extends Pick<Memory, "text">>(text: string, live: readonly M[]): M | null {
  const key = normalizeForDupe(text);
  if (key.length < 8) return null;
  return live.find((m) => normalizeForDupe(m.text) === key) ?? null;
}
