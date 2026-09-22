import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { KINDS, type Kind, type Memory } from "./types.js";

export const MEMORY_HEADER = `# JEVMEM.md

Project memory maintained by [Jevmem](https://github.com/Avinash-jetwani/jevmem).
Jev decides what is worth keeping; one line is written per memory. Edit freely; keep one memory per line.

`;

const LINE_RE =
  /^- \[(?<kind>[a-z]+)\]\s+(?<text>.*?)\s*<!--\s*(?<meta>[^>]*?)\s*-->\s*$/;

export function newId(): string {
  return crypto.randomBytes(4).toString("base64url").replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase().padEnd(6, "x");
}

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
  return mem;
}

export function formatLine(mem: Memory): string {
  const text = mem.text.replace(/\s+/g, " ").trim();
  const staleTag = mem.stale !== undefined ? "[stale?] " : "";
  const arrow = mem.supersededBy ? ` → id:${mem.supersededBy}` : "";
  const meta = [`id:${mem.id}`, `ts:${mem.ts}`, `conf:${mem.conf.toFixed(2)}`];
  if (mem.supersededBy) meta.push(`by:${mem.supersededBy}`);
  if (mem.stale !== undefined) meta.push(`stale:${mem.stale.toFixed(2)}`);
  return `- [${mem.kind}] ${staleTag}${text}${arrow}  <!-- ${meta.join(" ")} -->`;
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
    } else if (line.trim() !== "") {
      trailer.push(line);
    }
  }
  return { header, memories, trailer };
}

export function serializeMemoryFile(file: MemoryFile): string {
  const header = file.header.length ? file.header.join("\n").replace(/\s+$/, "") + "\n\n" : MEMORY_HEADER;
  const body = file.memories.map(formatLine).join("\n");
  const trailer = file.trailer.length ? "\n\n" + file.trailer.join("\n") : "";
  return header + body + (body ? "\n" : "") + trailer;
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

  /** Memories that are still live (not superseded). */
  active(): Memory[] {
    return this.list().filter((m) => m.kind !== "superseded" && !m.supersededBy);
  }

  write(file: MemoryFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, serializeMemoryFile(file));
    this.writeIndex(file.memories);
  }

  add(input: { kind: Kind; text: string; conf?: number; ts?: string; id?: string }): Memory {
    const file = this.read();
    const ids = new Set(file.memories.map((m) => m.id));
    let id = input.id ?? newId();
    while (ids.has(id)) id = newId();
    const mem: Memory = {
      id,
      kind: input.kind,
      text: input.text.replace(/\s+/g, " ").trim(),
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
