import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { footerMeta, formatFooter } from "./labels.js";
import { FOOTER_RE, parseMemoryFile, type MemoryFile } from "./memfile.js";
import { stripLeadingTags } from "./tags.js";
import type { Kind, Memory } from "./types.js";

export { parseLine, parseMemoryFile, type MemoryFile } from "./memfile.js";

export const MEMORY_HEADER = `# JEVMEM.md

Project memory, maintained automatically by jevmem (https://github.com/Avinash-jetwani/jevmem).
AI assistants: do not add, edit or remove lines in this file. jevmem records decisions, constraints and bugs from the conversation on its own.
People: edit freely, one memory per line.

`;

/**
 * Headers that earlier versions of `init` wrote, verbatim. `init` replaces one of these with MEMORY_HEADER; any
 * other header is the user's and is never touched. (The v0.4.3 header said "Edit freely" without addressing AI
 * assistants, and assistants read it as an invitation to write lines by hand.)
 */
export const LEGACY_HEADERS: readonly string[] = [
  `# JEVMEM.md

Project memory maintained by [Jevmem](https://github.com/Avinash-jetwani/jevmem).
Jev decides what is worth keeping; one line is written per memory. Edit freely; keep one memory per line.

`,
];

const normHeader = (h: string) => h.replace(/\r\n/g, "\n").replace(/\s+$/, "");

/** Replace the header with MEMORY_HEADER when it is exactly a legacy default (footer lines ignored). Returns true if it did. */
export function upgradeLegacyHeader(file: MemoryFile): boolean {
  const text = normHeader(file.header.filter((l) => !FOOTER_RE.test(l)).join("\n"));
  if (!LEGACY_HEADERS.some((h) => normHeader(h) === text)) return false;
  file.header = normHeader(MEMORY_HEADER).split("\n");
  return true;
}

export function newId(): string {
  return crypto.randomBytes(4).toString("base64url").replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase().padEnd(6, "x");
}

export function formatLine(mem: Memory): string {
  const text = mem.text.replace(/\s+/g, " ").trim();
  const staleTag = mem.stale !== undefined ? "[stale?] " : "";
  const arrow = mem.supersededBy ? ` → id:${mem.supersededBy}` : "";
  const meta = [`id:${mem.id}`, `ts:${mem.ts}`, `conf:${mem.conf.toFixed(2)}`];
  if (mem.supersededBy) meta.push(`by:${mem.supersededBy}`);
  if (mem.stale !== undefined) meta.push(`stale:${mem.stale.toFixed(2)}`);
  if (mem.kind === "retired") {
    if (mem.was) meta.push(`was:${mem.was}`);
    if (mem.retiredAt) meta.push(`retired:${mem.retiredAt}`);
  }
  return `- [${mem.kind}] ${staleTag}${text}${arrow}  <!-- ${meta.join(" ")} -->`;
}

/** A line that is live: not superseded and not retired. The lines recall serves, the guard enforces, decide lists and `jevmem list` prints. */
export const isLive = (m: Pick<Memory, "kind" | "supersededBy">): boolean => m.kind !== "superseded" && m.kind !== "retired" && !m.supersededBy;

export function serializeMemoryFile(file: MemoryFile, footer?: string | null): string {
  const header = file.header.length ? file.header.join("\n").replace(/\s+$/, "") + "\n\n" : MEMORY_HEADER;
  const body = file.memories.map(formatLine).join("\n");
  const trailer = file.trailer.filter((l) => !FOOTER_RE.test(l));
  const tail = trailer.length ? "\n\n" + trailer.join("\n") : "";
  const foot = footer ? "\n" + footer + "\n" : "";
  return header + body + (body ? "\n" : "") + tail + foot;
}

export class MemoryStore {
  readonly file: string;
  readonly dir: string;
  constructor(readonly root: string, memoryFile = "JEVMEM.md") {
    this.file = path.join(root, memoryFile);
    this.dir = path.join(root, ".jevmem");
  }

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  read(): MemoryFile {
    if (!fs.existsSync(this.file)) return { header: [], memories: [], trailer: [] };
    return parseMemoryFile(fs.readFileSync(this.file, "utf8"));
  }

  list(): Memory[] {
    return this.read().memories;
  }

  /** Memories that are still live (not superseded, not retired). */
  active(): Memory[] {
    return this.list().filter(isLive);
  }

  write(file: MemoryFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const meta = footerMeta(this.root);
    fs.writeFileSync(this.file, serializeMemoryFile(file, meta ? formatFooter(meta) : null));
    this.writeIndex(file.memories);
  }

  /** `init` on an existing file: replace a legacy default header, keep everything else. */
  upgradeHeader(): boolean {
    if (!this.exists()) return false;
    const file = this.read();
    if (!upgradeLegacyHeader(file)) return false;
    this.write(file);
    return true;
  }

  /** Rewrite the file unchanged except for the footer (used after labelling/fitting). */
  touchFooter(): void {
    this.write(this.read());
  }

  add(input: { kind: Kind; text: string; conf?: number; ts?: string; id?: string }): Memory {
    const file = this.read();
    const ids = new Set(file.memories.map((m) => m.id));
    let id = input.id ?? newId();
    while (ids.has(id)) id = newId();
    const mem: Memory = {
      id,
      kind: input.kind,
      // A kind or label tag typed in front of the text is not part of it (src/tags.ts): the line's own tag names the kind.
      text: stripLeadingTags(input.text).replace(/\s+/g, " ").trim(),
      ts: input.ts ?? new Date().toISOString(),
      conf: input.conf ?? 1,
    };
    file.memories.push(mem);
    this.write(file);
    return mem;
  }

  /** Mark `oldId` as superseded by `newId` (tags the old line `[superseded]` and appends `→ id:new`). */
  supersede(oldId: string, newId: string): Memory | null {
    const file = this.read();
    const old = file.memories.find((m) => m.id === oldId);
    if (!old) return null;
    old.kind = "superseded";
    old.supersededBy = newId;
    this.write(file);
    return old;
  }

  /**
   * Retire a line (0.7.0, `jevmem forget`): it stays in the file as `[retired]`, its text unchanged, with the kind it had
   * in `was:` and the time in `retired:`. Null when there is no such line or it is retired already.
   */
  retire(id: string): Memory | null {
    const file = this.read();
    const mem = file.memories.find((m) => m.id === id);
    if (!mem || mem.kind === "retired") return null;
    mem.was = mem.kind;
    mem.kind = "retired";
    mem.retiredAt = new Date().toISOString();
    this.write(file);
    return mem;
  }

  update(id: string, patch: Partial<Memory>): Memory | null {
    const file = this.read();
    const mem = file.memories.find((m) => m.id === id);
    if (!mem) return null;
    Object.assign(mem, patch);
    this.write(file);
    return mem;
  }

  remove(id: string): boolean {
    const file = this.read();
    const before = file.memories.length;
    file.memories = file.memories.filter((m) => m.id !== id);
    if (file.memories.length === before) return false;
    this.write(file);
    return true;
  }

  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const gi = path.join(this.dir, ".gitignore");
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n");
  }

  /** `.jevmem/index.json`: a machine-friendly mirror of JEVMEM.md (ids, kinds, texts, timestamps). */
  private writeIndex(memories: Memory[]): void {
    try {
      this.ensureDir();
      fs.writeFileSync(
        path.join(this.dir, "index.json"),
        JSON.stringify({ updatedAt: new Date().toISOString(), count: memories.length, memories }, null, 2),
      );
    } catch {
      /* index is a cache; never fail the write over it */
    }
  }
}
