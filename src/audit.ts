import fs from "node:fs";
import path from "node:path";
import { noul, type JsonValue, type Questions } from "@typesafe-ai/sdk";
import type { JevCaller } from "./jev.js";
import type { MemoryStore } from "./store.js";
import type { Memory } from "./types.js";

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage", ".jevmem", ".cache", "target", "out"]);

/** A lightweight snapshot: file tree (depth-limited), package.json, and the top of README. */
export function snapshotRepo(root: string, opts: { maxDepth?: number; maxEntries?: number; readmeChars?: number } = {}): { tree: string[]; packageJson: JsonValue; readme: string } {
  const maxDepth = opts.maxDepth ?? 3;
  const maxEntries = opts.maxEntries ?? 400;
  const tree: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || tree.length >= maxEntries) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (tree.length >= maxEntries) return;
      if (e.name.startsWith(".") && e.name !== ".claude") continue;
      if (IGNORE_DIRS.has(e.name)) continue;
      const rel = path.relative(root, path.join(dir, e.name));
      if (e.isDirectory()) {
        tree.push(rel + "/");
        walk(path.join(dir, e.name), depth + 1);
      } else {
        tree.push(rel);
      }
    }
  };
  walk(root, 0);
  let packageJson: JsonValue = null;
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    packageJson = JSON.parse(JSON.stringify({ name: pj.name, version: pj.version, scripts: pj.scripts, dependencies: pj.dependencies, devDependencies: pj.devDependencies, engines: pj.engines, packageManager: pj.packageManager }));
  } catch {
    /* not a node project */
  }
  let readme = "";
  for (const name of ["README.md", "readme.md", "README", "README.txt"]) {
    try {
      readme = fs.readFileSync(path.join(root, name), "utf8").slice(0, opts.readmeChars ?? 3000);
      break;
    } catch {
      /* try next */
    }
  }
  return { tree, packageJson, readme };
}

export interface AuditRow {
  memory: Memory;
  stillTrue: number;
  stale: boolean;
}

/** Re-score every live memory with one noul each ("is this still true?"), batched up to `batch` per call. */
export async function auditMemories(jev: JevCaller, store: MemoryStore, opts: { staleBelow: number; batch?: number; snapshot?: ReturnType<typeof snapshotRepo>; timeoutMs?: number }): Promise<AuditRow[]> {
  const memories = store.active();
  if (memories.length === 0) return [];
  const snapshot = opts.snapshot ?? snapshotRepo(store.root);
  const batch = opts.batch ?? 60;
  const rows: AuditRow[] = [];
  for (let i = 0; i < memories.length; i += batch) {
    const chunk = memories.slice(i, i + batch);
    const questions: Questions = {};
    for (const m of chunk) {
      questions[`true_${m.id}`] = noul(`Is memory ${m.id} still true for this repository, given the snapshot?`, {
        true: "The snapshot is consistent with the memory, or the snapshot gives no evidence against it.",
        false: "The snapshot shows the memory is no longer accurate: the file, dependency, or approach it names is gone or replaced.",
      });
    }
    const state = {
      repository_snapshot: snapshot,
      memories: chunk.map((m) => ({ id: m.id, kind: m.kind, text: m.text, recorded_at: m.ts })),
    };
    const res = await jev.call(state, questions, { label: "audit", timeoutMs: opts.timeoutMs });
    for (const m of chunk) {
      const a = res.answers[`true_${m.id}`];
      const p = a && a.type === "noul" ? a.noul : 1;
      rows.push({ memory: m, stillTrue: p, stale: p < opts.staleBelow });
    }
  }
  return rows;
}

/** Persist audit results: `[stale?]` on stale lines, clear the flag on lines that now pass. */
export function applyAudit(store: MemoryStore, rows: AuditRow[]): void {
  const file = store.read();
  const byId = new Map(rows.map((r) => [r.memory.id, r]));
  for (const m of file.memories) {
    const r = byId.get(m.id);
    if (!r) continue;
    if (r.stale) m.stale = r.stillTrue;
    else delete m.stale;
  }
  store.write(file);
}

export function formatAuditTable(rows: AuditRow[]): string {
  if (rows.length === 0) return "No live memories to audit.";
  const idW = Math.max(2, ...rows.map((r) => r.memory.id.length));
  const kindW = Math.max(4, ...rows.map((r) => r.memory.kind.length));
  const head = `${"id".padEnd(idW)}  ${"kind".padEnd(kindW)}  true   flag    text`;
  const lines = rows.map((r) => `${r.memory.id.padEnd(idW)}  ${r.memory.kind.padEnd(kindW)}  ${r.stillTrue.toFixed(2)}   ${r.stale ? "stale?" : "ok    "}  ${r.memory.text.slice(0, 80)}`);
  return [head, "-".repeat(head.length + 40), ...lines].join("\n");
}
