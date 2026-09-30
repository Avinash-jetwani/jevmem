/**
 * What a `git add`, `git stage` or `git commit` in a command line would put into the next commit, so the guard can
 * match path rules against files the command itself never names (docs/guardrails.md).
 *
 * `git add .`, `git add -A` and `git commit -a` name no file, so the prefilter alone cannot see that they would commit
 * an untracked `.env`. For each of these commands in a command line, one `git status` in the command's repository lists
 * the working tree, and the files the command would take are worked out from it the way git does:
 * - `git add <pathspec>…`, and `git add -A` or `-u` with none: untracked files that are not ignored, and changed
 *   tracked files, under the pathspecs. `-u`: changed tracked files only. `-f`: ignored files too. `-n` takes nothing.
 * - `git commit`: what is already staged. `-a` adds changed tracked files, never untracked ones. Pathspecs commit the
 *   changed tracked files they name (with `-i`, what is staged too).
 * Deletions are left out: they put no content into the commit.
 *
 * Local and read-only: `git --no-optional-locks status` never takes the index lock, so it cannot get in the way of a
 * git command running at the same time. It runs only inside a git repository, and within a time budget. A timeout, an
 * error, no git, or a command it cannot follow (`cd "$DIR"`, `--git-dir`, `--pathspec-from-file`, an alias) gives no
 * files, with a note: the call is matched on what it names, as before (fail open).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readCommandLine, withDirs } from "./shell.js";

export type StagedState = "untracked" | "ignored" | "changed" | "staged";

export interface StagedFile {
  /** Relative to the project root (forward slashes), or absolute when outside it. A folder ends in `/`. */
  path: string;
  /** untracked or ignored: new to git; changed: a tracked file with changes; staged: already in the index. */
  state: StagedState;
}

/** One `git add`, `git stage` or `git commit` in a command line. */
export interface GitStaging {
  /** The simple command, as written. */
  command: string;
  kind: "add" | "commit";
  /** The directory it runs in, or null when the guard cannot tell. */
  cwd: string | null;
  /** add: -A; commit: -a. */
  all: boolean;
  /** add: -u (and -p, -i, -e, which pick from tracked files). */
  update: boolean;
  /** add: -f. */
  force: boolean;
  /** commit: -i. */
  include: boolean;
  /** As git receives them, after the shell's own globbing. */
  pathspecs: string[];
  /** --literal-pathspecs or --noglob-pathspecs: wildcards in pathspecs are plain characters. */
  literal: boolean;
  /** Why the guard does not work out this command's files, or null. */
  skip: string | null;
}

export interface GitExpansion {
  /** What the command's git commands would stage or commit. */
  files: StagedFile[];
  /** The git commands found, as written. */
  commands: string[];
  /** Time spent, git included. */
  ms: number;
  /** Why files may be missing: a timeout, no repository, a command the guard cannot follow. */
  notes: string[];
}

export interface ExpandOptions {
  /** The directory the command starts in (the PreToolUse payload's cwd). */
  cwd: string;
  /** The project root: paths are made relative to it. */
  root: string;
  /** For everything here, git included; nothing is run once it is spent. */
  budgetMs: number;
  /** For `cd` and `cd ~/…`. */
  home?: string;
  /** The git binary (tests). */
  git?: string;
  env?: NodeJS.ProcessEnv;
  /** Most bytes of `git status` output read (default 4 MB); past it, what was read is used. */
  maxBytes?: number;
}

// ---------------------------------------------------------------------------------------------
// Parsing

/** Words in front of a command that only change how it runs. */
const PREFIX = new Set(["sudo", "env", "command", "exec", "nice", "nohup", "time", "caffeinate", "stdbuf", "timeout"]);
/** Variables that point git at another repository, index or work tree: not followed. */
const GIT_ENV = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_CEILING_DIRECTORIES)=/;

/** A directory after `cd` or `git -C`, or null when the guard cannot tell what it is. */
function resolveDir(cur: string | null, arg: string | undefined, home: string | undefined): string | null {
  if (cur === null) return null;
  if (arg === undefined) return home ?? null;
  if (arg === "-" || /[$`*?[]/.test(arg)) return null;
  if (arg === "~" || arg.startsWith("~/")) return home ? path.join(home, arg.slice(1)) : null;
  if (arg.startsWith("~")) return null;
  return path.resolve(cur, arg);
}

/** The shell's globbing of one unquoted word with no `/` in it (no dotglob, no nullglob): null when nothing matches. */
function shellGlob(pattern: string, cwd: string | null): string[] | null {
  if (!cwd || pattern.includes("/")) return null;
  const re = new RegExp(`^${globBody(pattern, false)}$`);
  let names: string[];
  try {
    names = fs.readdirSync(cwd);
  } catch {
    return null;
  }
  const hits = names.filter((n) => (pattern.startsWith(".") || !n.startsWith(".")) && re.test(n)).sort();
  return hits.length ? hits : null;
}

/** A glob as a regular expression body. `crossSlash`: `*` and `?` match `/` too (git pathspecs); else not (the shell). */
function globBody(glob: string, crossSlash: boolean): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") re += crossSlash ? ".*" : "[^/]*";
    else if (c === "?") re += crossSlash ? "." : "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        const body = glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
        re += `[${body}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  return re;
}

/** Short options of `git commit` that take a value: the rest of the word, or the next word. */
const COMMIT_VALUE_SHORT = new Set(["m", "F", "C", "c", "t"]);
/** Short options of `git commit` whose value, if any, is the rest of the word. */
const COMMIT_OPTIONAL_SHORT = new Set(["S", "u"]);
/** Long options of `git commit` that take a value (as `--opt=value` or `--opt value`). */
const COMMIT_VALUE_LONG = new Set(["--message", "--file", "--reuse-message", "--reedit-message", "--fixup", "--squash", "--author", "--date", "--template", "--cleanup", "--trailer"]);

/**
 * The `git add`, `git stage` and `git commit` commands of a command line (the commands inside `bash -c`, a heredoc fed
 * to a shell, `eval` and a script written and then run included; src/shell.ts), with the directory each runs in
 * (following `cd`, `pushd`, `popd` and `git -C`) and what it would take. No git, no file system beyond the shell's
 * globbing of a `git add *`.
 */
export function parseGitStaging(command: string, cwd: string, home?: string): GitStaging[] {
  const out: GitStaging[] = [];
  for (const c of withDirs(readCommandLine(command), cwd, home, undefined, (base, p) => path.resolve(base, p))) {
    const { words, globs } = c;
    const dir: string | null = c.cwd ?? null;
    let i = 0;
    let envSkip = false;
    for (;;) {
      const w = words[i];
      if (w === undefined) break;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
        if (GIT_ENV.test(w)) envSkip = true;
        i++;
      } else if (PREFIX.has(w)) {
        i++;
        while (words[i]?.startsWith("-") || (/^\d/.test(words[i] ?? "") && ["timeout", "-n"].includes(words[i - 1] ?? ""))) i++;
      } else break;
    }
    const first = words[i];
    if (first === undefined) continue;
    if ((first.split("/").pop() ?? first) !== "git") continue;
    // git's own options, before the subcommand.
    let j = i + 1;
    let at: string | null = dir;
    let literal = false;
    let skip: string | null = envSkip ? "GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE is set" : null;
    while (j < words.length && words[j]!.startsWith("-")) {
      const w = words[j]!;
      if (w === "-C") {
        at = resolveDir(at, words[j + 1], home);
        j += 2;
        continue;
      }
      if (w === "-c" || w === "--namespace" || w === "--config-env") {
        j += 2;
        continue;
      }
      if (/^--(?:git-dir|work-tree)(?:=|$)/.test(w)) {
        skip = "--git-dir or --work-tree";
        j += w.includes("=") ? 1 : 2;
        continue;
      }
      if (w === "--literal-pathspecs" || w === "--noglob-pathspecs") literal = true;
      j++;
    }
    const sub = words[j];
    if (sub !== "add" && sub !== "stage" && sub !== "commit") continue;
    const s: GitStaging = { command: c.text, kind: sub === "commit" ? "commit" : "add", cwd: at, all: false, update: false, force: false, include: false, pathspecs: [], literal, skip };
    let ended = false;
    for (let k = j + 1; k < words.length; k++) {
      const w = words[k]!;
      if (!ended && w === "--") {
        ended = true;
        continue;
      }
      if (!ended && w.startsWith("--")) {
        const name = w.split("=")[0]!;
        const hasValue = w.includes("=");
        if (s.kind === "add") {
          if (name === "--all" || name === "--no-ignore-removal") s.all = true;
          else if (name === "--update" || name === "--patch" || name === "--interactive" || name === "--edit") s.update = true;
          else if (name === "--force") s.force = true;
          else if (name === "--dry-run") s.skip ??= "a dry run stages nothing";
          else if (name === "--refresh") s.skip ??= "--refresh stages no content";
          else if (name === "--pathspec-from-file") {
            s.skip ??= "the pathspecs are read from a file";
            if (!hasValue) k++;
          } else if (name === "--chmod" && !hasValue) k++;
        } else {
          if (name === "--all" || name === "--patch" || name === "--interactive") s.all = true;
          else if (name === "--include") s.include = true;
          else if (name === "--dry-run") s.skip ??= "a dry run commits nothing";
          else if (name === "--pathspec-from-file") {
            s.skip ??= "the pathspecs are read from a file";
            if (!hasValue) k++;
          } else if (COMMIT_VALUE_LONG.has(name) && !hasValue) k++;
        }
        continue;
      }
      if (!ended && w.startsWith("-") && w.length > 1) {
        const flags = w.slice(1);
        for (let f = 0; f < flags.length; f++) {
          const ch = flags[f]!;
          if (s.kind === "add") {
            if (ch === "A") s.all = true;
            else if (ch === "u" || ch === "p" || ch === "i" || ch === "e") s.update = true;
            else if (ch === "f") s.force = true;
            else if (ch === "n") s.skip ??= "a dry run stages nothing";
          } else {
            if (COMMIT_VALUE_SHORT.has(ch)) {
              if (f === flags.length - 1) k++; // the value is the next word
              break;
            }
            if (COMMIT_OPTIONAL_SHORT.has(ch)) break;
            if (ch === "a" || ch === "p") s.all = true;
            else if (ch === "i") s.include = true;
          }
        }
        continue;
      }
      // A pathspec. An unquoted wildcard is the shell's to expand first.
      const expanded = globs?.[k] ? shellGlob(w, s.cwd) : null;
      s.pathspecs.push(...(expanded ?? [w]));
    }
    if (s.kind === "add" && !s.pathspecs.length && !s.all && !s.update) s.skip ??= "no pathspec: it stages nothing";
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The working tree

/** The top of the git work tree `dir` is in (the first folder upwards with a `.git`), or null. */
export function gitTop(dir: string): string | null {
  let d = path.resolve(dir);
  for (;;) {
    try {
      fs.statSync(path.join(d, ".git"));
      return d;
    } catch {
      /* keep looking */
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

interface Entry {
  /** Index against HEAD. */
  x: string;
  /** Work tree against the index. */
  y: string;
  /** Relative to the top of the work tree; a folder ends in `/`. */
  p: string;
}

/** `git status` of a work tree: its entries, or why there are none (or not all). */
function gitStatus(top: string, ignored: boolean, timeoutMs: number, opts: ExpandOptions): { entries: Entry[]; note: string | null } {
  const args = ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=all", ...(ignored ? ["--ignored=matching"] : [])];
  const r = spawnSync(opts.git ?? "git", args, {
    cwd: top,
    encoding: "utf8",
    timeout: Math.max(1, Math.floor(timeoutMs)),
    killSignal: "SIGKILL",
    maxBuffer: opts.maxBytes ?? 4 << 20,
    env: { ...(opts.env ?? process.env), GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  let note: string | null = null;
  if (code === "ETIMEDOUT") return { entries: [], note: `git status took longer than ${Math.round(timeoutMs)} ms` };
  if (code === "ENOBUFS") note = `git status printed more than ${opts.maxBytes ?? 4 << 20} bytes; only what came first was read`;
  else if (r.error) return { entries: [], note: `git status could not run (${code ?? r.error.message})` };
  else if (r.status !== 0) return { entries: [], note: `git status failed (exit ${r.status ?? r.signal})` };
  const chunks = (r.stdout ?? "").split("\0");
  chunks.pop(); // "" after the last NUL, or an entry cut short
  const entries: Entry[] = [];
  for (const c of chunks) if (c.length > 3) entries.push({ x: c[0]!, y: c[1]!, p: c.slice(3) });
  return { entries, note };
}

// ---------------------------------------------------------------------------------------------
// What each command takes

/** A pathspec as a test on paths relative to the top of the work tree, or null for magic the guard does not know. */
function pathspecTest(spec: string, cwd: string, top: string, literal: boolean): { exclude: boolean; test: (p: string) => boolean } | null {
  let s = spec;
  let exclude = false;
  let fromTop = false;
  let glob = !literal;
  let icase = false;
  if (s.startsWith(":(")) {
    const end = s.indexOf(")");
    if (end < 0) return null;
    for (const m of s.slice(2, end).split(",").map((x) => x.trim())) {
      if (m === "top") fromTop = true;
      else if (m === "exclude") exclude = true;
      else if (m === "literal") glob = false;
      else if (m === "icase") icase = true;
      else if (m === "glob") glob = true;
      else return null;
    }
    s = s.slice(end + 1);
  } else if (s.startsWith(":")) {
    let k = 1;
    for (; k < s.length && "/!^".includes(s[k]!); k++) {
      if (s[k] === "/") fromTop = true;
      else exclude = true;
    }
    if (s[k] === ":") k++;
    s = s.slice(k);
  }
  const rel = path.relative(top, path.resolve(fromTop ? top : cwd, s || ".")).split(path.sep).join("/");
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return { exclude, test: () => false };
  const flags = icase ? "i" : "";
  if (glob && /[*?[]/.test(rel)) {
    const re = new RegExp(`^${globBody(rel, true)}(?:/.*)?$`, flags);
    return { exclude, test: (p) => re.test(p.replace(/\/$/, "")) };
  }
  const norm = icase ? (x: string) => x.toLowerCase() : (x: string) => x;
  const r = norm(rel);
  return {
    exclude,
    test: (raw) => {
      const p = norm(raw.replace(/\/$/, ""));
      // A folder entry (an untracked or ignored folder shown whole) matches a pathspec inside it too.
      return r === "" || p === r || p.startsWith(`${r}/`) || (raw.endsWith("/") && r.startsWith(`${p}/`));
    },
  };
}

const changedInTree = (y: string) => y === "M" || y === "T" || y === "U" || y === "A";
const stagedInIndex = (x: string, y: string) => x === "M" || x === "T" || x === "A" || x === "U" || (x === "D" && y === "U");

/** The files one staging command takes from the work tree's entries. */
function filesFor(s: GitStaging, top: string, entries: Entry[]): { files: { p: string; state: StagedState }[]; note: string | null } {
  const specs = s.pathspecs.map((p) => pathspecTest(p, s.cwd!, top, s.literal));
  if (specs.some((x) => x === null)) return { files: [], note: `${s.command}: not expanded (a pathspec with magic the guard does not read)` };
  const inc = specs.filter((x) => !x!.exclude);
  const exc = specs.filter((x) => x!.exclude);
  const all = s.kind === "add" ? !inc.length : false;
  const named = (p: string) => (all || inc.some((x) => x!.test(p))) && !exc.some((x) => x!.test(p));
  const files: { p: string; state: StagedState }[] = [];
  for (const e of entries) {
    const tracked = e.x !== "?" && e.x !== "!";
    if (s.kind === "add") {
      if (!named(e.p)) continue;
      if (e.x === "?") {
        if (!s.update) files.push({ p: e.p, state: "untracked" });
      } else if (e.x === "!") {
        if (s.force && !s.update) files.push({ p: e.p, state: "ignored" });
      } else if (changedInTree(e.y)) files.push({ p: e.p, state: "changed" });
      continue;
    }
    if (!tracked) continue; // a commit never takes an untracked file
    const staged = stagedInIndex(e.x, e.y);
    const changed = changedInTree(e.y);
    if (s.pathspecs.length) {
      if (named(e.p) && (staged || changed)) files.push({ p: e.p, state: changed ? "changed" : "staged" });
      else if (s.include && staged) files.push({ p: e.p, state: "staged" });
    } else if (staged) files.push({ p: e.p, state: "staged" });
    else if (s.all && changed) files.push({ p: e.p, state: "changed" });
  }
  return { files, note: null };
}

function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** A path under `top` as the guard reports it: relative to the project root when inside it. */
function fromRoot(root: string, top: string, p: string): string {
  const abs = path.join(top, p);
  const rel = path.relative(root, abs);
  const out = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs;
  return out.split(path.sep).join("/") + (p.endsWith("/") && !out.endsWith("/") ? "/" : "");
}

const RANK: Record<StagedState, number> = { untracked: 0, ignored: 1, changed: 2, staged: 3 };

/**
 * The files the `git add`, `git stage` and `git commit` commands of `command` would put into the next commit, from one
 * `git status` per repository. Never throws; with a note and no files when it cannot tell.
 */
export function expandGitStaging(command: string, opts: ExpandOptions): GitExpansion {
  const t0 = performance.now();
  const out: GitExpansion = { files: [], commands: [], ms: 0, notes: [] };
  const done = () => {
    out.ms = Math.round(performance.now() - t0);
    return out;
  };
  if (!/\bgit\b/.test(command)) return done();
  let stagings: GitStaging[];
  try {
    stagings = parseGitStaging(command, opts.cwd, opts.home);
  } catch (err) {
    out.notes.push(`git commands not read: ${err instanceof Error ? err.message : String(err)}`);
    return done();
  }
  const byTop = new Map<string, GitStaging[]>();
  for (const s of stagings) {
    out.commands.push(s.command);
    if (s.skip) out.notes.push(`${s.command}: not expanded (${s.skip})`);
    else if (!s.cwd) out.notes.push(`${s.command}: not expanded (it runs in a folder the guard cannot tell)`);
    else {
      const top = gitTop(s.cwd);
      if (!top) out.notes.push(`${s.command}: not in a git repository`);
      else byTop.set(top, [...(byTop.get(top) ?? []), s]);
    }
  }
  const found = new Map<string, StagedState>();
  const root = real(opts.root);
  for (const [top, list] of byTop) {
    const left = opts.budgetMs - (performance.now() - t0);
    if (left < 5) {
      out.notes.push(`no time left for git status (budget ${opts.budgetMs} ms)`);
      break;
    }
    const status = gitStatus(top, list.some((s) => s.force), left, opts);
    if (status.note) out.notes.push(status.note);
    const realTop = real(top);
    for (const s of list) {
      const r = filesFor(s, top, status.entries);
      if (r.note) out.notes.push(r.note);
      for (const f of r.files) {
        const p = fromRoot(root, realTop, f.p);
        const had = found.get(p);
        if (had === undefined || RANK[f.state] < RANK[had]) found.set(p, f.state);
      }
    }
  }
  out.files = [...found].map(([p, state]) => ({ path: p, state }));
  return done();
}
