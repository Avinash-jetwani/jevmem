// Helpers for the auto memory comparison (scripts/ab-automem.mjs, 0.7.7): Claude Code's memory directory for a project,
// the long-project history rendered in each tool's shape, snapshots of what each tool saved, the repository reset
// between a teaching session and the task session, and the part of a MEMORY.md index Claude Code loads at session
// start. Kept apart so tests can use them.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The directory name Claude Code keeps a project's auto memory under: the git root's real path with every character
 * that is not a letter or digit replaced by `-` (the same rule as src/import.ts `projectSlug`; checked against the
 * directory Claude Code 2.1.306 made in the probe of 2026-10-25).
 */
export const projectSlug = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-");

/** `<config dir>/projects/<slug>/memory` for a project root (the root must be its real path). */
export function memoryDirFor(configDir, root) {
  return path.join(configDir, "projects", projectSlug(root), "memory");
}

/** Claude Code loads the first 200 lines or 25 KB of MEMORY.md at session start (docs, "Memory", read 2026-10-24). */
export const INDEX_LINE_LIMIT = 200;
export const INDEX_BYTE_LIMIT = 25 * 1024;

/** The part of an index Claude Code loads: whole lines, up to the line and byte limits. */
export function loadedIndexText(indexText) {
  const lines = String(indexText ?? "").split("\n");
  const out = [];
  let bytes = 0;
  for (let i = 0; i < lines.length && i < INDEX_LINE_LIMIT; i++) {
    const b = Buffer.byteLength(lines[i]) + 1;
    if (bytes + b > INDEX_BYTE_LIMIT) break;
    out.push(lines[i]);
    bytes += b;
  }
  return out.join("\n");
}

/** A memory line's id in jevmem's shape (6 lowercase letters and digits), stable per key. */
export function idOf(key) {
  const h = crypto.createHash("sha1").update(`automem:${key}`).digest();
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; s.length < 6; i++) s += a[h[i] % 36];
  return /^\d+$/.test(s) ? "x" + s.slice(1) : s;
}

/**
 * The long-project notes as objects: slug, kind, title, text, always, supersededBy, a timestamp that advances from
 * `start` by `stepDays` per note (the oldest first), and `live` (not superseded).
 */
export function longNotes(NOTES, start, stepDays) {
  const t0 = Date.parse(start);
  return NOTES.map(([slug, kind, title, text, flags = {}], i) => ({
    slug,
    kind,
    title,
    text,
    always: Boolean(flags.always),
    supersededBy: flags.supersededBy ?? null,
    live: !flags.supersededBy,
    ts: new Date(t0 + i * stepDays * 86_400_000).toISOString(),
  }));
}

/** Claude's own `type` for a note: rules and conventions are `feedback`, the rest `project`. */
export const autoMemoryType = (kind) => (kind === "constraint" || kind === "preference" ? "feedback" : "project");

/**
 * The long history in auto memory's shape: the MEMORY.md index (one `- [title](slug.md) — text` line per live note,
 * oldest first) and a topic file per live note, with the frontmatter Claude Code 2.1.306 wrote in the probe (name,
 * description, metadata.type, metadata.modified), the note's text as the body.
 */
export function renderAutoMemory(notes) {
  const files = {};
  const index = [];
  for (const n of notes.filter((x) => x.live)) {
    index.push(`- [${n.title}](${n.slug}.md) — ${n.text}`);
    files[`${n.slug}.md`] = `---\nname: ${n.slug}\ndescription: ${JSON.stringify(n.text)}\nmetadata:\n  node_type: memory\n  type: ${autoMemoryType(n.kind)}\n  modified: ${n.ts}\n---\n\n${n.text}\n`;
  }
  return { index: index.join("\n") + "\n", files };
}

/** The same notes as jevmem memories (for `formatLine` and `recordProvenance` of the package under test). */
export function jevmemMemories(notes) {
  return notes.map((n) => ({
    key: n.slug,
    id: idOf(n.slug),
    kind: n.supersededBy ? "superseded" : n.kind,
    text: n.text,
    ts: n.ts,
    conf: 0.9,
    ...(n.supersededBy ? { supersededBy: idOf(n.supersededBy) } : {}),
    ...(n.always ? { always: true } : {}),
  }));
}

/** The long history as a CLAUDE.md a person keeps: the live notes as `- [kind] text` lines. */
export function renderClaudeMd(title, notes) {
  return `# ${title}: project notes\n\n${notes.filter((n) => n.live).map((n) => `- [${n.kind}] ${n.text}`).join("\n")}\n`;
}

/** A CLAUDE.md with the taught lines of one task (the reference arm). */
export function claudeMdFor(title, lines) {
  return `# ${title}: project notes\n\n${lines.map(([kind, text]) => `- [${kind}] ${text}`).join("\n")}\n`;
}

/** What is in a memory directory: every file with its size, lines and text; the index's size apart. */
export function readMemoryDir(dir) {
  const out = { dir, exists: false, files: [], indexBytes: 0, indexLines: 0, totalBytes: 0 };
  if (!fs.existsSync(dir)) return out;
  out.exists = true;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) {
        const text = fs.readFileSync(p, "utf8");
        const f = { name: r, bytes: Buffer.byteLength(text), lines: text.split("\n").filter((l) => l.trim()).length, text };
        out.files.push(f);
        out.totalBytes += f.bytes;
        if (r === "MEMORY.md") {
          out.indexBytes = f.bytes;
          out.indexLines = f.lines;
        }
      }
    }
  };
  walk(dir, "");
  out.files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

export const indexTextOf = (snap) => snap.files.find((f) => f.name === "MEMORY.md")?.text ?? "";
export const memoryTextOf = (snap) => snap.files.map((f) => f.text).join("\n");

/**
 * What became of the notes an earlier snapshot held, in a later one: index lines still present verbatim, and topic
 * files kept as they were, rewritten, or gone (how auto memory treats an old note when a decision changes).
 */
export function noteFate(before, after) {
  const lines = (snap) => new Set(indexTextOf(snap).split("\n").filter((l) => l.startsWith("- ")));
  const was = lines(before);
  const now = lines(after);
  const files = { kept: [], rewritten: [], deleted: [] };
  for (const f of before.files) {
    if (f.name === "MEMORY.md") continue;
    const cur = after.files.find((x) => x.name === f.name);
    if (!cur) files.deleted.push(f.name);
    else if (cur.text === f.text) files.kept.push(f.name);
    else files.rewritten.push(f.name);
  }
  return { indexLinesBefore: was.size, indexLinesKept: [...was].filter((l) => now.has(l)).length, files };
}

/** The `projects/*` directories under a Claude Code config directory (which project slugs got a memory directory). */
export function projectDirsOf(configDir) {
  const p = path.join(configDir, "projects");
  try {
    return fs.readdirSync(p).filter((d) => fs.statSync(path.join(p, d)).isDirectory());
  } catch {
    return [];
  }
}

/** jevmem's lines from a JEVMEM.md text, with the package's parser: live lines and superseded ones apart. */
export function jevmemLinesOf(text, lib) {
  const mems = lib.parseMemoryFile(String(text ?? ""));
  const list = Array.isArray(mems) ? mems : (mems?.memories ?? []);
  const live = list.filter((m) => m.kind !== "superseded" && m.kind !== "retired" && !m.supersededBy);
  const superseded = list.filter((m) => m.kind === "superseded" || m.supersededBy);
  return { all: list, live, superseded, liveText: live.map((m) => m.text).join("\n"), supersededText: superseded.map((m) => m.text).join("\n") };
}

const git = (cwd, a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The repository's changes: tracked files that differ from HEAD and untracked files (ignored files left out). */
export function repoStatus(root) {
  return git(root, ["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3).replace(/^"|"$/g, "") }));
}

/** The files each tool's memory lives in, kept when the repository is put back after a teaching session. */
export const KEEP_PATHS = /^(?:JEVMEM\.md|jevmem\.config\.json|CLAUDE\.md|\.jevmem\/|\.claude\/)/;

/**
 * Puts the repository back to HEAD after a teaching session, except each tool's memory: tracked changes are reverted
 * and untracked files removed, apart from KEEP_PATHS (JEVMEM.md, which jevmem's Stop hook appends to, is tracked).
 * Returns the paths it undid, so the record says what the teaching session wrote into the repository.
 */
export function resetRepo(root, keep = KEEP_PATHS) {
  const undone = [];
  for (const { status, path: p } of repoStatus(root)) {
    if (keep.test(p)) continue;
    undone.push(`${status} ${p}`);
    const abs = path.join(root, p);
    if (status === "??") fs.rmSync(abs, { recursive: true, force: true });
    else if (status.includes("D")) git(root, ["checkout", "--", p]);
    else git(root, ["checkout", "HEAD", "--", p]);
  }
  // Empty directories a removed file leaves behind are not git's concern; remove the ones under the root.
  const prune = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === ".git" || e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      prune(p);
      if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
    }
  };
  prune(root);
  return { undone };
}

/** The text the hooks injected: per prompt (UserPromptSubmit) and at session start (SessionStart). */
export function hookContextTexts(events) {
  const texts = { prompt: "", start: "" };
  for (const e of events) {
    if (e.type !== "system" || e.subtype !== "hook_response") continue;
    const ev = e.hook_event ?? e.hook_event_name;
    if (ev !== "UserPromptSubmit" && ev !== "SessionStart") continue;
    try {
      texts[ev === "SessionStart" ? "start" : "prompt"] += JSON.parse(String(e.stdout || e.output || "")).hookSpecificOutput?.additionalContext ?? "";
    } catch {
      /* no output */
    }
  }
  return texts;
}

/** The Read, Write, Edit and Bash calls that touched a directory (the memory directory), with the files' sizes. */
export function callsUnder(calls, dir, snapshot) {
  const under = (p) => typeof p === "string" && (p === dir || p.startsWith(dir + path.sep));
  const sizeOf = (p) => snapshot?.files.find((f) => path.join(dir, f.name) === p)?.bytes ?? null;
  const reads = [];
  const writes = [];
  for (const c of calls) {
    const i = c.input ?? {};
    const p = String(i.file_path ?? i.notebook_path ?? "");
    const hook = c.hooked ? { hook: c.hook } : {};
    if (c.name === "Read" && under(p)) reads.push({ name: path.relative(dir, p), bytes: sizeOf(p), error: c.error });
    else if ((c.name === "Write" || c.name === "Edit" || c.name === "MultiEdit") && under(p)) writes.push({ tool: c.name, name: path.relative(dir, p), error: c.error, ...hook });
    else if (c.name === "Bash" && String(i.command ?? "").includes(dir)) writes.push({ tool: "Bash", name: String(i.command).slice(0, 160), error: c.error, ...hook });
    else if ((c.name === "Glob" || c.name === "Grep") && under(String(i.path ?? ""))) reads.push({ name: `${c.name} ${String(i.pattern ?? "")}`.slice(0, 80), bytes: null, error: c.error });
  }
  // A write the guard asked about or denied did not run (nobody answers an ask in `claude -p`).
  return { reads, writes, readBytes: reads.reduce((a, r) => a + (r.bytes ?? 0), 0), writeAsks: writes.filter((w) => w.hook === "ask" || w.hook === "deny").length };
}

/**
 * The API errors a session met, from its stream-json events: Claude Code prints each as a synthetic assistant message
 * (`is_api_error_message`, `error`, `api_error_status`) and marks the result `is_error` with the status. Ordinary
 * messages are never read here, so a task's own words about limits or billing do not count.
 */
export function apiErrorsOf(events) {
  const out = [];
  for (const e of events) {
    if (e.type === "assistant" && (e.is_api_error_message || e.isApiErrorMessage || e.error)) out.push({ status: e.api_error_status ?? null, error: e.error ?? null, text: (e.message?.content ?? []).map((c) => c.text ?? "").join(" ").slice(0, 300) });
    else if (e.type === "result" && e.is_error && e.api_error_status) out.push({ status: e.api_error_status, error: null, text: String(e.result ?? "").slice(0, 300) });
  }
  return out;
}

const ACCOUNT_STATUS = new Set([401, 402, 403, 429]);
const ACCOUNT_ERROR = new Set(["authentication_failed", "billing_error", "rate_limit"]);
const ACCOUNT_TEXT = /credit balance|billing|spend limit|usage limit|hit your limit|limit reached|out of extra usage/i;

/**
 * The first API error that says the account cannot serve sessions now: a refused key, no credit, the spend limit, a
 * rate or plan limit Claude Code's retries did not get past. The comparison stops cleanly on one (the job is not
 * recorded, so a later block runs it again); an overloaded or failing server or a refused request stays in the record.
 */
export function accountStop(events) {
  return apiErrorsOf(events).find((e) => ACCOUNT_STATUS.has(e.status) || ACCOUNT_ERROR.has(e.error) || ACCOUNT_TEXT.test(e.text)) ?? null;
}
