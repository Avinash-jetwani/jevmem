/**
 * `jevmem import --from sessions` (0.7.1): a project's past Claude Code sessions become its memory, so memory starts
 * full on day one. The session files Claude Code keeps under `<config dir>/projects/<project>/` (one `.jsonl` per
 * session; a `<session>/subagents/` folder beside it holds the sidechains) are read with the reader the Stop hook has
 * used since 0.6.0 (src/transcript.ts): a prompt the user typed and everything the main agent wrote until the next
 * prompt. Sidechains, task notifications, tool results, commands, system reminders, meta entries, compaction summaries
 * and bookkeeping entry types are not turns. Nothing is sent before the caller has counted the turns and asked.
 *
 * The format is not documented, so the reader fails safe: a line that is not JSON is skipped and counted; an entry
 * whose `type` is unknown is ignored; a file with no turn is counted as empty or unreadable and never sent; when
 * every file in a folder that has files yields nothing, the caller is told the format may have changed.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { loadConfig } from "./config.js";
import { decide, localDuplicateDecision, type Decision } from "./decide.js";
import { findDuplicate, normalizeForDupe } from "./dupe.js";
import { gateLines, hiddenTextReason } from "./guard.js";
import { autoMemoryDir, type SourceOptions } from "./import.js";
import type { JevCaller } from "./jev.js";
import { recordDecision } from "./labels.js";
import { recordProvenance } from "./provenance.js";
import { scrubSecrets } from "./scrub.js";
import { isLive, type MemoryStore } from "./store.js";
import { mergeTurn, readTranscriptTurns, type TranscriptTurn } from "./transcript.js";
import { DEFAULT_CONFIG, type Kind, type Memory } from "./types.js";
import { composeLine } from "./write.js";

/** Where Claude Code keeps this project's session files: the folder that holds the auto-memory folder. */
export function sessionsDir(root: string, opts: SourceOptions = {}): string {
  return path.dirname(autoMemoryDir(root, opts));
}

export interface SessionTurn extends TranscriptTurn {
  /** The turn's position in its session, from 1. */
  n: number;
}

export interface SessionFile {
  path: string;
  /** The session id (the file's name). */
  session: string;
  /** When the session's first and last entries were written, ISO 8601, when the entries carry a time; else the file's mtime. */
  firstAt: string;
  lastAt: string;
  /** The Claude Code versions the entries name. */
  versions: string[];
  /** Entries by type, and lines that were not JSON, for the report. */
  entries: Record<string, number>;
  badLines: number;
  sidechainEntries: number;
  turns: SessionTurn[];
}

/** `30d`, `12h`, `2w`, `90m`, or a date (`2026-09-01`); null when it is neither. */
export function parseSince(text: string, now: Date = new Date()): Date | null {
  const m = /^(\d+)\s*([mhdw])$/i.exec(text.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2]!.toLowerCase() as "m" | "h" | "d" | "w"];
    return new Date(now.getTime() - n * unit);
  }
  const d = new Date(text.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Read one session file. Never throws: an unreadable file is a SessionFile with no turns and the problem in `entries`. */
export function readSessionFile(file: string): SessionFile {
  const session = path.basename(file).replace(/\.jsonl$/, "");
  const entries: Record<string, number> = {};
  let badLines = 0;
  let sidechainEntries = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  const versions = new Set<string>();
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        badLines++;
        continue;
      }
      const type = typeof e?.type === "string" ? e.type : "(no type)";
      entries[type] = (entries[type] ?? 0) + 1;
      if (e?.isSidechain === true) sidechainEntries++;
      if (typeof e?.version === "string") versions.add(e.version);
      if (typeof e?.timestamp === "string" && (type === "user" || type === "assistant")) {
        if (!firstAt || e.timestamp < firstAt) firstAt = e.timestamp;
        if (!lastAt || e.timestamp > lastAt) lastAt = e.timestamp;
      }
    }
  } catch {
    entries["(unreadable)"] = 1;
    return { path: file, session, firstAt: new Date(mtime).toISOString(), lastAt: new Date(mtime).toISOString(), versions: [], entries, badLines, sidechainEntries, turns: [] };
  }
  const read = readTranscriptTurns(file) ?? [];
  // A turn with nothing to decide (under 8 characters once merged, as the hook skips it) is not a turn here either.
  const turns = read.filter((t) => mergeTurn(t.user, t.assistant).trim().length >= 8).map((t, i) => ({ ...t, n: i + 1 }));
  const at = new Date(mtime).toISOString();
  return { path: file, session, firstAt: firstAt ?? at, lastAt: lastAt ?? at, versions: [...versions].sort(), entries, badLines, sidechainEntries, turns };
}

export interface FoundSessions {
  dir: string;
  /** The sessions with at least one turn, oldest first. */
  files: SessionFile[];
  /** What was left out, for the report: files with no turn, files before --since, lines that were not JSON. */
  skipped: string[];
  /** Set when the folder has files and none gave a turn: the format may have changed; the caller sends nothing. */
  suspect: string | null;
  /** Entry types seen across the files that were read, with counts. */
  entryTypes: Record<string, number>;
  versions: string[];
}

/** The project's session files with their turns, oldest first, and what was skipped. Reads files only. */
export function findSessionFiles(root: string, opts: SourceOptions & { since?: Date | null } = {}): FoundSessions {
  const dir = sessionsDir(root, opts);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return { dir, files: [], skipped: [`no session folder at ${dir}`], suspect: null, entryTypes: {}, versions: [] };
  }
  const all = names.map((n) => readSessionFile(path.join(dir, n)));
  const entryTypes: Record<string, number> = {};
  const versions = new Set<string>();
  let badLines = 0;
  for (const f of all) {
    for (const [k, v] of Object.entries(f.entries)) entryTypes[k] = (entryTypes[k] ?? 0) + v;
    for (const v of f.versions) versions.add(v);
    badLines += f.badLines;
  }
  const skipped: string[] = [];
  const empty = all.filter((f) => !f.turns.length);
  if (empty.length) skipped.push(`${empty.length} file(s) with no turn to decide`);
  if (badLines) skipped.push(`${badLines} line(s) that were not JSON`);
  let files = all.filter((f) => f.turns.length);
  if (opts.since) {
    const since = opts.since.toISOString();
    const before = files.filter((f) => f.lastAt < since).length;
    files = files.filter((f) => f.lastAt >= since);
    if (before) skipped.push(`${before} session(s) from before --since`);
  }
  files.sort((a, b) => (a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : 0));
  const suspect = all.length && !all.some((f) => f.turns.length) ? `None of the ${all.length} session file(s) gave a turn to decide. The session format may have changed since this version of jevmem was written (entry types seen: ${Object.keys(entryTypes).join(", ") || "none"}); nothing is sent.` : null;
  return { dir, files, skipped, suspect, entryTypes, versions: [...versions].sort() };
}

export interface SessionImportRow {
  session: string;
  sessionAt: string;
  turn: SessionTurn;
  outcome: "add" | "skip" | "duplicate" | "withheld";
  kind?: Kind;
  text: string;
  reason: string;
  always?: boolean;
  /** The line this one supersedes: a live id, or `row<N>` for a line accepted earlier in this import. */
  supersedes?: string;
  savedId?: string;
  decision?: Decision;
}

/**
 * Decide every turn, oldest session first and turn by turn, as the Stop hook decides a finished turn: the local
 * duplicate check, decide against the live lines plus the ones accepted earlier here, the writer's line, the dedupe of
 * the finished line, then the poisoning gate over the accepted lines in one batched call. With `apply`, accepted lines
 * are written with provenance (`import`: verified) and a decision record, and a reversal supersedes its line.
 */
export async function importSessions(jev: JevCaller, store: MemoryStore, cfg: ReturnType<typeof loadConfig>, files: readonly SessionFile[], opts: { apply?: boolean; onProgress?: (done: number, total: number) => void } = {}): Promise<SessionImportRow[]> {
  const live: Memory[] = store.list().filter(isLive);
  const rows: SessionImportRow[] = [];
  const total = files.reduce((a, f) => a + f.turns.length, 0);
  let n = 0;
  const env = process.env;
  for (const f of files) {
    for (const t of f.turns) {
      opts.onProgress?.(n++, total);
      const user = scrubSecrets(t.user);
      const assistant = scrubSecrets(t.assistant);
      const row: SessionImportRow = { session: f.session, sessionAt: f.firstAt, turn: t, outcome: "skip", text: "", reason: "" };
      rows.push(row);
      const hidden = hiddenTextReason(t.user);
      if (hidden) {
        row.outcome = "withheld";
        row.reason = hidden;
        continue;
      }
      const dup = (id: string, how: string) => {
        row.outcome = "duplicate";
        const earlier = /^row\d+$/.test(id) ? rows[Number(id.slice(3))] : undefined;
        row.reason = `duplicate of ${earlier ? `the line from turn ${earlier.turn.n} of session ${earlier.session.slice(0, 8)}` : id}${how}`;
      };
      const local = findDuplicate(user, live);
      if (local) {
        row.decision = localDuplicateDecision(local.id, { ...DEFAULT_CONFIG.thresholds, ...cfg.thresholds });
        dup(local.id, " (word for word; nothing was sent)");
        continue;
      }
      const d = await decide(jev, { userMessage: user, assistantReply: assistant, recentContext: scrubSecrets(t.previous), existingMemories: live }, { thresholds: cfg.thresholds, weights: cfg.weights, tiers: cfg.tiers, maxIds: cfg.jev.maxIdsPerCall, askAboutReply: cfg.jev.askAboutReply });
      row.decision = d;
      if (d.duplicateOf) {
        dup(d.duplicateOf, " (restates it)");
        continue;
      }
      if (!d.save || d.kind === "none") {
        row.reason = d.reason;
        continue;
      }
      const composed = await composeLine(d.sourceText || mergeTurn(user, assistant), d.kind, { writer: cfg.writer, env, jev, jevTimeoutMs: cfg.jev.timeoutMs }, { worksNow: Boolean(d.worksNow?.id), deadEnd: d.worksNow?.id ? live.find((m) => m.id === d.worksNow!.id)?.text : undefined, fromReply: d.source === "assistant_reply" });
      row.text = composed.line;
      const written = normalizeForDupe(composed.line);
      const same = live.find((m) => normalizeForDupe(m.text) === written);
      if (same && !d.contradiction) {
        dup(same.id, " (the line written for the turn is the same)");
        continue;
      }
      row.outcome = "add";
      row.kind = d.kind as Kind;
      row.reason = d.reason;
      row.always = d.always;
      if (d.contradiction && d.touchesMemoryId) row.supersedes = d.touchesMemoryId;
      // Later turns are decided against this line too; a pending id stands in for the line not yet written.
      const pending: Memory = { id: `row${rows.length - 1}`, kind: row.kind, text: row.text, ts: f.firstAt, conf: d.confidence, ...(d.always ? { always: true } : {}) };
      if (row.supersedes) {
        const i = live.findIndex((m) => m.id === row.supersedes);
        if (i >= 0) live.splice(i, 1);
      }
      live.push(pending);
    }
  }
  opts.onProgress?.(total, total);
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
  applySessionImport(store, rows);
  return rows;
}

/** Write the accepted rows of a dry run (0.7.2: `jevmem setup` shows the lines first and asks again). Returns how many were written. */
export function applySessionImport(store: MemoryStore, rows: SessionImportRow[]): number {
  let n = 0;
  for (const r of rows) {
    if (r.outcome !== "add") continue;
    n++;
    const saved = store.add({ kind: r.kind!, text: r.text, conf: r.decision?.confidence ?? 1, ...(r.always ? { always: true } : {}) });
    r.savedId = saved.id;
    recordProvenance(store.root, saved, "import");
    const target = r.supersedes && /^row\d+$/.test(r.supersedes) ? rows[Number(r.supersedes.slice(3))]?.savedId : r.supersedes;
    if (target) store.supersede(target, saved.id);
    if (r.decision) {
      const hash = crypto.createHash("sha1").update(`sessions\n${r.session}\n${r.turn.n}\n${r.text}`).digest("hex").slice(0, 16);
      recordDecision(store.root, { hash, memoryId: saved.id, message: mergeTurn(scrubSecrets(r.turn.user), scrubSecrets(r.turn.assistant)), decision: r.decision, via: "import-sessions" });
    }
  }
  return n;
}

const when = (iso: string) => iso.replace("T", " ").slice(0, 16);
const promptOf = (t: SessionTurn) => JSON.stringify(t.user.replace(/\s+/g, " ").slice(0, 60) + (t.user.length > 60 ? "…" : ""));

export function formatSessionImport(rows: SessionImportRow[], opts: { apply: boolean; files: readonly SessionFile[] }): string {
  const out: string[] = [];
  out.push(`jevmem import --from sessions${opts.apply ? "" : " (dry run)"}: ${rows.length} turn(s) from ${opts.files.length} session(s), oldest first`);
  const adds = rows.filter((r) => r.outcome === "add");
  for (const r of adds) out.push(`  + [${r.kind}] ${r.text}  (${when(r.sessionAt)}, turn ${r.turn.n}: ${promptOf(r.turn)})${r.always ? "  always-on" : ""}${r.supersedes && !/^row\d+$/.test(r.supersedes) ? `  supersedes ${r.supersedes}` : ""}${r.savedId ? `  id:${r.savedId}` : ""}`);
  const other = rows.filter((r) => r.outcome !== "add");
  if (other.length) {
    out.push("  not imported:");
    for (const r of other) out.push(`  ${r.outcome === "duplicate" ? "=" : r.outcome === "withheld" ? "!" : "-"} turn ${r.turn.n} of ${when(r.sessionAt)} ${promptOf(r.turn)}  ${r.reason.slice(0, 120)}`);
  }
  out.push("");
  out.push(opts.apply ? `Added ${adds.length} line(s) to JEVMEM.md; the session files were not changed.` : `Would add ${adds.length} line(s). Run with --apply to write them; the session files are never changed.`);
  return out.join("\n");
}
