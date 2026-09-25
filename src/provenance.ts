/**
 * Provenance: which lines in JEVMEM.md jevmem itself wrote on this machine.
 *
 * JEVMEM.md is committed, so anyone who can change the repository can add or edit a line. A line is *verified* only
 * when `.jevmem/provenance.jsonl` (local, gitignored) records its id together with a hash of its exact text, i.e. this
 * machine's jevmem wrote that text after its own gate. Everything else is unverified: hand-written lines, lines that
 * arrived through git from other machines, `jevmem add` / `jevmem missed` lines, and a verified line whose text was
 * edited afterwards (same id, different hash). Unverified lines still work, but every path that serves them to an
 * agent sends them through the poisoning gate first (src/guard.ts).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Memory } from "./types.js";

export type ProvenanceVia = "hook" | "mcp" | "import";

export interface ProvenanceRecord {
  id: string;
  /** sha256 of the whitespace-normalised line text, first 16 hex characters. */
  sha: string;
  ts: string;
  via: ProvenanceVia;
}

export const provenanceFile = (root: string) => path.join(root, ".jevmem", "provenance.jsonl");

/** Hash of a memory's text as it is stored (whitespace collapsed, trimmed). */
export function lineSha(text: string): string {
  return crypto.createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

/** Record that jevmem wrote this line here. Best effort: a failure only makes the line unverified (gated), never lost. */
export function recordProvenance(root: string, mem: Pick<Memory, "id" | "text">, via: ProvenanceVia): void {
  try {
    const file = provenanceFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rec: ProvenanceRecord = { id: mem.id, sha: lineSha(mem.text), ts: new Date().toISOString(), via };
    fs.appendFileSync(file, JSON.stringify(rec) + "\n");
  } catch {
    /* best effort */
  }
}

/** id → set of text hashes jevmem wrote under that id on this machine. */
export function readProvenance(root: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let raw = "";
  try {
    raw = fs.readFileSync(provenanceFile(root), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as ProvenanceRecord;
      if (typeof r.id !== "string" || typeof r.sha !== "string") continue;
      let s = out.get(r.id);
      if (!s) out.set(r.id, (s = new Set()));
      s.add(r.sha);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

export function isVerified(prov: Map<string, Set<string>>, mem: Pick<Memory, "id" | "text">): boolean {
  return prov.get(mem.id)?.has(lineSha(mem.text)) ?? false;
}
