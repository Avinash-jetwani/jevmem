/**
 * The leading-tag strip (0.7.0). People write a memory with a tag in front of it (`[constraint] Never …`, a pasted
 * brief's `- [constraint] …`, `[rule] …`, `[note] …`), and the writer, `jevmem add`, `jevmem import` and MCP `add_memory`
 * used to keep it, so the saved line read `[constraint] [constraint] Never …`. The kind is already in the line's own
 * tag, so these words go; a bracketed token that is not a kind or a label (`[DEPRECATED] endpoints …`) is part of the
 * text and stays.
 */
import { KINDS } from "./types.js";

/** Words a person types in square brackets in front of a memory that are not part of it, beyond the kinds themselves. */
export const LABEL_TAGS = ["rule", "rules", "note", "notes", "fact", "memory", "reminder", "fyi", "fixme"] as const;
const TAG_WORDS = [...KINDS, ...LABEL_TAGS].map((w) => w.replace("-", "[- ]?"));
// One or more tags, each a bracketed kind or label word, with a list item's dash or star before them allowed.
const LEADING_TAGS = new RegExp(`^(?:[-*]\\s+)?(?:\\[\\s*(?:${TAG_WORDS.join("|")})\\s*\\]\\s*)+`, "i");

/** `text` without the kind and label tags at its front; other bracketed tokens, and a text that is only tags, stay. */
export function stripLeadingTags(text: string): string {
  const t = text.trimStart();
  const m = LEADING_TAGS.exec(t);
  if (!m) return text;
  const rest = t.slice(m[0].length);
  return rest.trim().length ? rest : text;
}
