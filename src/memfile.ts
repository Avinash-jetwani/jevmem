/**
 * Reading JEVMEM.md: one memory per line, `- [kind] text  <!-- id:… ts:… conf:… -->`. Kept apart from store.ts, which
 * writes the file, so that readers on a hot path (the PreToolUse guard) load no more than the parser. A retired line
 * (0.7.0) is `- [retired] text  <!-- id:… ts:… conf:… was:<kind> retired:<ts> -->`: a reader from before 0.7.0 reads
 * `retired` as an unknown kind and keeps the line as text, as pre-0.6 readers kept `[dead-end]` lines.
 */
import { KINDS, type Kind, type Memory } from "./types.js";

export const FOOTER_RE = /^<!--\s*jevmem:.*-->\s*$/;

// A kind is lowercase words joined by hyphens (`dead-end`). Versions before dead ends read only `[a-z]+`, so to them a
// dead-end line is not a memory: they keep it in the file as it is (test/old-cli-deadend.test.ts).
const LINE_RE =
  /^- \[(?<kind>[a-z]+(?:-[a-z]+)*)\]\s+(?<text>.*?)\s*<!--\s*(?<meta>[^>]*?)\s*-->\s*$/;

export function parseLine(line: string): Memory | null {
  const m = LINE_RE.exec(line);
  if (!m?.groups) return null;
  const kind = m.groups.kind as Kind;
  if (!KINDS.includes(kind)) return null;
  const meta: Record<string, string> = {};
  for (const tok of m.groups.meta!.split(/\s+/)) {
    const i = tok.indexOf(":");
    if (i > 0) meta[tok.slice(0, i)] = tok.slice(i + 1);
  }
  if (!meta.id) return null;
  let text = m.groups.text!.trim();
  let supersededBy = meta.by;
  const arrow = /\s*→\s*id:([a-z0-9]+)\s*$/i.exec(text);
  if (arrow) {
    supersededBy = supersededBy ?? arrow[1];
    text = text.slice(0, arrow.index).trim();
  }
  let stale: number | undefined = meta.stale ? Number(meta.stale) : undefined;
  if (text.startsWith("[stale?]")) {
    text = text.slice("[stale?]".length).trim();
    stale = stale ?? 0;
  }
  const mem: Memory = {
    id: meta.id,
    kind,
    text,
    ts: meta.ts ?? new Date(0).toISOString(),
    conf: meta.conf ? Number(meta.conf) : 0,
  };
  if (supersededBy) mem.supersededBy = supersededBy;
  if (stale !== undefined && !Number.isNaN(stale)) mem.stale = stale;
  if (meta.was && KINDS.includes(meta.was as Kind)) mem.was = meta.was as Kind;
  if (meta.retired) mem.retiredAt = meta.retired;
  return mem;
}

/** Parsed JEVMEM.md: memories plus the non-memory lines (so edits keep the user's prose intact). */
export interface MemoryFile {
  header: string[]; // lines before the first memory line
  memories: Memory[];
  trailer: string[]; // non-memory lines after the first memory line (rare; preserved verbatim)
}

export function parseMemoryFile(content: string): MemoryFile {
  const lines = content.split(/\r?\n/);
  const header: string[] = [];
  const trailer: string[] = [];
  const memories: Memory[] = [];
  let seen = false;
  for (const line of lines) {
    const mem = parseLine(line);
    if (mem) {
      memories.push(mem);
      seen = true;
    } else if (!seen) {
      header.push(line);
    } else if (line.trim() !== "" && !FOOTER_RE.test(line)) {
      trailer.push(line);
    }
  }
  return { header, memories, trailer };
}
