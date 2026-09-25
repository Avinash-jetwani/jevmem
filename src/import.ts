/**
 * `jevmem import`: read existing instruction and memory files, split them into candidate statements, and put each one
 * through the same gate as a turn (scrub, then Jev decide, dedupe against live lines). Dry run by default; `--apply`
 * writes the accepted lines. The sources are only ever read.
 *
 * Sources: `CLAUDE.md` (or `.claude/CLAUDE.md`), `AGENTS.md`, `.cursor/rules/*` in the project; and, only when asked
 * with `--from claude-auto-memory` (it lives in the home directory), Claude Code's auto memory for this project:
 * `autoMemoryDirectory` from the settings, else `~/.claude/projects/<project>/memory/`, where `<project>` is derived
 * from the git repository root (https://code.claude.com/docs/en/memory, "Storage location").
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { loadConfig } from "./config.js";
import { decide, type Decision } from "./decide.js";
import { gateLines, hiddenTextReason } from "./guard.js";
import type { JevCaller } from "./jev.js";
import { recordDecision } from "./labels.js";
import { clampLine, stripFiller } from "./llm/index.js";
import { recordProvenance } from "./provenance.js";
import { scrubSecrets } from "./scrub.js";
import type { MemoryStore } from "./store.js";
import type { Kind, Memory } from "./types.js";

export const IMPORT_SOURCES = ["claude-md", "agents-md", "cursor-rules", "claude-auto-memory"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];
/** What `jevmem import` reads without `--from`: the project's own files, never the home directory. */
export const DEFAULT_IMPORT_SOURCES: ImportSource[] = ["claude-md", "agents-md", "cursor-rules"];

export interface Candidate {
  text: string;
  /** Display path (relative to the project, or with the home directory as `~`). */
  file: string;
  line: number;
  source: ImportSource;
}

// ---------------------------------------------------------------------------------------------
// Splitting Markdown into statements

const MIN_WORDS = 3;

function cleanInline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\s)\*([^*\s][^*]*)\*(?=\s|$|[.,;:])/g, "$1$2")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/^(Why|How to apply|Note|Rule|Important)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentences of a prose paragraph (a period, `!` or `?` followed by a capital starts a new one). */
function sentences(p: string): string[] {
  return p.split(/(?<=[.!?])\s+(?=[A-Z`"'(])/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Candidate statements from one Markdown file: every list item, and every sentence of a prose paragraph. Skipped:
 * YAML frontmatter, headings, fenced code, HTML comments, tables, `@path` imports, horizontal rules, and a section
 * headed `Jevmem project memory` (jevmem's own instructions, written by `init`). Statements under three words are
 * dropped; longer than 200 characters are clamped at a word boundary.
 */
export function splitStatements(markdown: string, maxChars = 200): { text: string; line: number }[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: { text: string; line: number }[] = [];
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    if (end > 0) i = end + 1;
  }
  let fence: string | null = null;
  let inComment = false;
  let skipLevel = 0; // inside a jevmem section: the heading level that ends it
  let para: { text: string[]; line: number } | null = null;
  const flush = () => {
    if (para) for (const s of sentences(cleanInline(para.text.join(" ")))) push(s, para.line);
    para = null;
  };
  const push = (raw: string, line: number) => {
    const t = cleanInline(raw);
    if (t.split(/\s+/).filter(Boolean).length < MIN_WORDS) return;
    out.push({ text: clampLine(t, maxChars), line });
  };
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    const t = l.trim();
    if (fence) {
      if (t.startsWith(fence)) fence = null;
      continue;
    }
    const f = /^(```+|~~~+)/.exec(t);
    if (f) {
      flush();
      fence = f[1]!;
      continue;
    }
    if (inComment) {
      if (t.includes("-->")) inComment = false;
      continue;
    }
    if (t.startsWith("<!--")) {
      flush();
      if (!t.includes("-->")) inComment = true;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      flush();
      const level = h[1]!.length;
      if (skipLevel && level <= skipLevel) skipLevel = 0;
      if (/^jevmem project memory\b/i.test(h[2]!.trim())) skipLevel = level;
      continue;
    }
    if (skipLevel) continue;
    if (t === "" || /^([-*_])\1{2,}$/.test(t) || /^\|/.test(t) || /^@\S+$/.test(t)) {
      flush();
      continue;
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(l);
    if (item) {
      flush();
      push(item[1]!, i + 1);
      continue;
    }
    if (para) para.text.push(t);
    else para = { text: [t], line: i + 1 };
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Finding the sources

export interface SourceOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Explicit auto-memory directory (`--memory-dir`). */
  memoryDir?: string;
  maxChars?: number;
}

/** The auto-memory project name: every character other than a letter or digit becomes `-` (`/a/b.c` → `-a-b-c`). */
export function projectSlug(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, "-");
}

/** The git repository root that auto memory is keyed on (the main worktree's root), or null outside git. */
export function gitRepoRoot(root: string): string | null {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return path.basename(common) === ".git" ? path.dirname(common) : execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Where Claude Code keeps auto memory for this project: `--memory-dir`; else `autoMemoryDirectory` from
 * `.claude/settings.local.json`, `.claude/settings.json` or `~/.claude/settings.json` (in that order); else
 * `<config dir>/projects/<project>/memory/`, with `<project>` from `CLAUDE_CODE_PROJECT_DIR_NAME` or the git root.
 */
export function autoMemoryDir(root: string, opts: SourceOptions = {}): string {
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const expand = (p: string) => (p.startsWith("~/") ? path.join(home, p.slice(2)) : p);
  if (opts.memoryDir) return path.resolve(root, expand(opts.memoryDir));
  const configDir = env.CLAUDE_CONFIG_DIR ? expand(env.CLAUDE_CONFIG_DIR) : path.join(home, ".claude");
  for (const f of [path.join(root, ".claude", "settings.local.json"), path.join(root, ".claude", "settings.json"), path.join(configDir, "settings.json")]) {
    const v = readJson(f)?.autoMemoryDirectory;
    if (typeof v === "string" && (v.startsWith("/") || v.startsWith("~/"))) return expand(v);
  }
  const name = env.CLAUDE_CODE_PROJECT_DIR_NAME || projectSlug(fs.realpathSync(gitRepoRoot(root) ?? root));
  return path.join(configDir, "projects", name, "memory");
}

/** Every candidate statement from the chosen sources, and which files were read. Only reads files. */
export function collectCandidates(root: string, sources: ImportSource[], opts: SourceOptions = {}): { candidates: Candidate[]; files: string[]; notFound: string[] } {
  const home = opts.home ?? os.homedir();
  const display = (f: string) => (f.startsWith(root + path.sep) ? path.relative(root, f) : f.startsWith(home + path.sep) ? "~" + f.slice(home.length) : f);
  const candidates: Candidate[] = [];
  const files: string[] = [];
  const notFound: string[] = [];
  const readFile = (file: string, source: ImportSource) => {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return false;
    }
    files.push(display(file));
    for (const s of splitStatements(text, opts.maxChars)) candidates.push({ text: s.text, file: display(file), line: s.line, source });
    return true;
  };
  for (const source of sources) {
    if (source === "claude-md") {
      const found = [path.join(root, "CLAUDE.md"), path.join(root, ".claude", "CLAUDE.md")].filter((f) => readFile(f, source));
      if (!found.length) notFound.push("CLAUDE.md");
    } else if (source === "agents-md") {
      if (!readFile(path.join(root, "AGENTS.md"), source)) notFound.push("AGENTS.md");
    } else if (source === "cursor-rules") {
      const dir = path.join(root, ".cursor", "rules");
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir).filter((n) => /\.(mdc|md)$/i.test(n)).sort();
      } catch {
        /* none */
      }
      // jevmem.mdc is jevmem's own rule (written by `init --tool cursor`), not project knowledge.
      const read = names.filter((n) => n !== "jevmem.mdc").filter((n) => readFile(path.join(dir, n), source));
      if (!read.length) notFound.push(".cursor/rules/*");
    } else {
      const dir = autoMemoryDir(root, opts);
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith(".md") && n !== "MEMORY.md").sort();
      } catch {
        /* none */
      }
      // MEMORY.md is an index of links to the topic files, which hold the memories; the topic files are read instead.
      const read = names.filter((n) => readFile(path.join(dir, n), source));
      if (!read.length) notFound.push(display(dir));
    }
  }
  return { candidates, files, notFound };
}

// ---------------------------------------------------------------------------------------------
// Gating

export interface ImportRow {
  candidate: Candidate;
  outcome: "add" | "skip" | "duplicate" | "withheld";
  kind?: Kind;
  /** The line as it would be written. */
  text: string;
  reason: string;
  supersedes?: string;
  savedId?: string;
}

/**
 * Put every candidate through the turn gate, in file order: scrub, then Jev decide against the live lines plus the
 * ones accepted earlier in this import, dedupe (case-insensitive). Candidates with hidden text are withheld in code.
 * Accepted statements then pass the memory-poisoning gate (src/guard.ts) in one batched call, because an imported
 * line becomes a verified line and these files are as open to a pull request as JEVMEM.md is. With `apply`, accepted
 * lines are written (with provenance, so they are verified), and a contradiction supersedes the old line as a turn would.
 */
export async function runImport(jev: JevCaller, store: MemoryStore, cfg: ReturnType<typeof loadConfig>, candidates: Candidate[], opts: { apply?: boolean; onProgress?: (done: number, total: number) => void } = {}): Promise<ImportRow[]> {
  const live: Pick<Memory, "id" | "kind" | "text">[] = store.active().map((m) => ({ id: m.id, kind: m.kind, text: m.text }));
  const rows: ImportRow[] = [];
  const decisions = new Map<ImportRow, Decision>();
  let n = 0;
  for (const c of candidates) {
    opts.onProgress?.(n++, candidates.length);
    const text = clampLine(stripFiller(scrubSecrets(c.text)), cfg.writer.maxChars);
    const row: ImportRow = { candidate: c, outcome: "skip", text, reason: "" };
    rows.push(row);
    const hidden = hiddenTextReason(c.text);
    if (hidden) {
      row.outcome = "withheld";
      row.reason = hidden;
      continue;
    }
    const dup = live.find((m) => m.text.toLowerCase() === text.toLowerCase());
    if (dup) {
      row.outcome = "duplicate";
      const earlier = /^imp\d+$/.test(dup.id) ? rows[Number(dup.id.slice(3)) - 1] : undefined;
      row.reason = earlier ? `duplicate of the line from ${earlier.candidate.file}:${earlier.candidate.line}` : `duplicate of ${dup.id}`;
      continue;
    }
    const d = await decide(jev, { userMessage: text, existingMemories: live }, { thresholds: cfg.thresholds, weights: cfg.weights, tiers: cfg.tiers, maxIds: cfg.jev.maxIdsPerCall });
    decisions.set(row, d);
    if (!d.save || d.kind === "none") {
      row.reason = d.reason;
      continue;
    }
    row.outcome = "add";
    row.kind = d.kind as Kind;
    row.reason = d.reason;
    if (d.contradiction && d.touchesMemoryId) row.supersedes = d.touchesMemoryId;
    // Later candidates are decided against this one too (a pending id stands in for the line not yet written).
    const pending = { id: `imp${rows.length}`, kind: row.kind, text };
    if (row.supersedes) {
      const i = live.findIndex((m) => m.id === row.supersedes);
      if (i >= 0) live.splice(i, 1);
    }
    live.push(pending);
  }
  opts.onProgress?.(candidates.length, candidates.length);

  const accepted = rows.filter((r) => r.outcome === "add");
  if (accepted.length) {
    const ids = accepted.map((r, i) => ({ r, m: { id: `imp${i}`, kind: r.kind!, text: r.text, ts: "", conf: 1 } as Memory }));
    const { scores } = await gateLines(jev, ids.map((x) => x.m), { label: "gate" });
    for (const { r, m } of ids) {
      const p = scores.get(m.id);
      if (typeof p !== "number" || p >= cfg.thresholds.injectionMax) {
        r.outcome = "withheld";
        r.reason = typeof p === "number" ? `reads as instructions aimed at an AI (gate ${p.toFixed(2)} ≥ ${cfg.thresholds.injectionMax})` : "gate answer missing";
        r.supersedes = undefined;
      }
    }
  }
  if (!opts.apply) return rows;

  for (const r of rows) {
    if (r.outcome !== "add") continue;
    // A superseded target may be a line added earlier in this import: map the pending id to the written one.
    const saved = store.add({ kind: r.kind!, text: r.text, conf: decisions.get(r)?.confidence ?? 1 });
    r.savedId = saved.id;
    recordProvenance(store.root, saved, "import");
    const target = r.supersedes && /^imp\d+$/.test(r.supersedes) ? rows[Number(r.supersedes.slice(3)) - 1]?.savedId : r.supersedes;
    if (target) store.supersede(target, saved.id);
    const d = decisions.get(r);
    if (d) {
      const hash = crypto.createHash("sha1").update(`import\n${r.candidate.file}:${r.candidate.line}\n${r.text}`).digest("hex").slice(0, 16);
      recordDecision(store.root, { hash, memoryId: saved.id, message: `${r.candidate.file}:${r.candidate.line}: ${r.text}`, decision: d, via: "import" });
    }
  }
  return rows;
}

export function formatImport(rows: ImportRow[], opts: { apply: boolean; files: string[]; notFound: string[] }): string {
  const out: string[] = [];
  const where = (r: ImportRow) => `${r.candidate.file}:${r.candidate.line}`;
  out.push(`jevmem import${opts.apply ? "" : " (dry run)"}: ${rows.length} statement(s) from ${opts.files.join(", ") || "no files"}${opts.notFound.length ? `; not found: ${opts.notFound.join(", ")}` : ""}`);
  const adds = rows.filter((r) => r.outcome === "add");
  for (const r of adds) out.push(`  + [${r.kind}] ${r.text}  (${where(r)})${r.supersedes && !/^imp\d+$/.test(r.supersedes) ? `  supersedes ${r.supersedes}` : ""}${r.savedId ? `  id:${r.savedId}` : ""}`);
  const other = rows.filter((r) => r.outcome !== "add");
  if (other.length) {
    out.push("  not imported:");
    for (const r of other) out.push(`  ${r.outcome === "duplicate" ? "=" : r.outcome === "withheld" ? "!" : "-"} ${r.text.slice(0, 90)}  (${where(r)})  ${r.reason}`);
  }
  out.push("");
  out.push(opts.apply ? `Added ${adds.length} line(s) to JEVMEM.md; the source files were not changed.` : `Would add ${adds.length} line(s). Run with --apply to write them; the source files are never changed.`);
  return out.join("\n");
}
