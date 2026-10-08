/**
 * The guard: a PreToolUse hook that checks Bash, Edit and Write calls against the project's saved `[constraint]` lines
 * before they run (docs/guardrails.md).
 *
 * 1. Rules: the live `[constraint]` lines of JEVMEM.md that have passed the memory-poisoning gate (src/guard.ts):
 *    written here by jevmem (verified), or unverified with a clean verdict already cached by recall or the Stop drain.
 *    A line with no verdict yet is not enforced; the hook never asks the gate itself. The rules and their features are
 *    indexed once per JEVMEM.md (and gate state) in `.jevmem/guard-index.json`.
 * 2. Prefilter (src/prefilter.ts): the rules that share a path, filename, command word or keyword with the call, at
 *    most `guard.maxCandidates`. For `git add`, `git stage` and `git commit`, the files the command would stage or
 *    commit are listed first (src/gitstage.ts, one local `git status` within GIT_BUDGET_MS) and matched against the
 *    paths and filenames of rules about committing. None: the hook prints nothing and exits; nothing leaves the machine.
 * 3. Jev: one noul per (call, candidate rule), "would this call break this rule?", all in one request within what is
 *    left of `guard.budgetMs`. Only the command, or the file path and a short scrubbed snippet of the change, is sent,
 *    and for a git command the staged files a candidate rule names.
 *    Answers are cached in `.jevmem/guard-cache.json` by rule id, rule text and call, whatever the answer.
 * 4. Decision, by `guard.mode`: `ask` → permissionDecision "ask"; `block` → "deny" at or above `guard.blockMin` for a
 *    verified rule (jevmem wrote it on this machine), "ask" below it and for an unverified rule at any score, with the
 *    reason naming the unverified line; `warn` → the rule as additionalContext, no decision; `off` → nothing.
 * Separately, a call that changes the guard settings in jevmem.config.json, or removes or supersedes a `[constraint]`
 * line in JEVMEM.md, is always asked (unless the mode is `off`), so the guard cannot be switched off to get past it.
 *
 * The hook fails open: any error, a timeout, Jev down, no key, bad input or config means no decision (exit 0, no
 * output), logged to `.jevmem/log.jsonl`. It never prints "allow", which would skip the user's permission prompt.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { noul, type Questions } from "@typesafe-ai/sdk";
import { CONFIG_FILE, isJevmemHookCommand, parseConfig } from "./config.js";
import { applyPluginOption, loadEnvFallbacks } from "./env.js";
import { expandGitStaging, type GitExpansion, type StagedFile } from "./gitstage.js";
import { gateLines, planGate, settleGate } from "./guard.js";
import { actionSummary, recordGuardCall, shorten, type GuardLogEntry, type GuardRoute } from "./guardlog.js";
import { appendLog, type JevCaller } from "./jev.js";
import { actionFeatures, DEFAULT_MATCH, matchRules, ruleFeatures, ruleNamesCommittedFiles, snippetAround, type Candidate, type GuardAction, type GuardTool, type IndexedRule, type MatchOptions } from "./prefilter.js";
import { commandOf, condenseHeredocs, expandPath, readCommandLine, shellGlobRegExp, withDirs, type SimpleCommand } from "./shell.js";
import { isVerified, lineSha, readProvenance } from "./provenance.js";
import { parseMemoryFile } from "./memfile.js";
import { scrubSecrets } from "./scrub.js";
import { DEFAULT_CONFIG, GUARD_MODES, type GuardMode, type JevmemConfig, type Memory } from "./types.js";

/** Bumped when the guard's question changes, so cached answers from an older wording are asked again. */
export const GUARD_VERSION = 1;
/**
 * Bumped when the index format or the prefilter's rule features change (2: each rule says whether it is verified;
 * 3: rules about commit messages are marked).
 */
const INDEX_VERSION = 3;

export const GUARDED_TOOLS: readonly GuardTool[] = ["Bash", "Edit", "Write"];
/** What the hook registration matches (Claude Code 2.1.274 and 2.1.281 have no MultiEdit tool). */
export const GUARD_MATCHER = "Bash|Edit|Write";
/** The PreToolUse hook's timeout in seconds, set on the hook entry. The guard's own budget is `guard.budgetMs`. */
export const GUARD_HOOK_TIMEOUT_S = 3;

/**
 * Characters of a command sent to Jev (each heredoc body in it cut to `added`), of the replaced and new text of an
 * edit, of the staged files named, and of a commit message.
 */
export const SEND = { command: 2000, removed: 300, added: 600, stages: 600, message: 2000 } as const;

/**
 * At most this long (and a quarter of `guard.budgetMs`) for listing what a git command would stage or commit
 * (src/gitstage.ts). Past it the call is matched on what it names, as if git had not been asked.
 */
export const GIT_BUDGET_MS = 200;
/** Staged files named to Jev, at most. */
const STAGES_SENT = 10;

// ---------------------------------------------------------------------------------------------
// The question

export const breakKey = (id: string) => `breaks_${id}`;

/** One noul per candidate rule. The examples share no text or topic with eval/guard-*.jsonl (tested). */
export function breakNoul(id: string) {
  return noul(`Would carrying out this tool call break saved project rule ${id}?`, {
    true: {
      what: "The call itself does what the rule forbids, or leaves out what the rule requires, for the file, branch, command or content the rule names. It counts when the forbidden part is one step of a longer command line.",
      examples: ["Rule: the vendored zlib under third_party/ is never patched. Call: an Edit to third_party/zlib/inflate.c.", "Rule: the billing cron job is never run by hand. Call: a terminal command that runs the billing charge task."],
    },
    false: {
      what: "The call does not do what the rule forbids: it only reads, lists, searches or runs tests, it works on a different file, branch or command than the one the rule names, or it does what the rule asks for.",
      examples: ["Rule: the vendored zlib under third_party/ is never patched. Call: an Edit to the build script that compiles it.", "Rule: never merge straight into the release branch. Call: opens a pull request from a feature branch."],
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Input

export interface GuardInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
}

/** The project a hook event belongs to: CLAUDE_PROJECT_DIR (stable across worktrees), then the payload's cwd. */
export function guardRoot(input: GuardInput, env: NodeJS.ProcessEnv = process.env): string {
  for (const c of [env.CLAUDE_PROJECT_DIR, input.cwd]) if (c && fs.existsSync(c)) return c;
  return process.cwd();
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** A path as the guard reports and sends it: relative to the project root when it is inside it. */
export function relativePath(root: string, file: string): string {
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs.split(path.sep).join("/");
}

/** The call from a PreToolUse payload, or null for a tool the guard does not check or a malformed input. */
export function toAction(input: GuardInput, root: string): GuardAction | null {
  const tool = input.tool_name as GuardTool;
  const ti = input.tool_input;
  if (!GUARDED_TOOLS.includes(tool) || !ti || typeof ti !== "object") return null;
  if (tool === "Bash") {
    const command = str(ti.command);
    return command && command.trim() ? { tool, command } : null;
  }
  const file = str(ti.file_path);
  if (!file) return null;
  if (tool === "Edit") return { tool, file: relativePath(root, file), removed: str(ti.old_string) ?? "", added: str(ti.new_string) ?? "" };
  return { tool, file: relativePath(root, file), added: str(ti.content) ?? "" };
}

// ---------------------------------------------------------------------------------------------
// Config

/** `problems`: settings the guard did not use as written, and what it used instead (it still decides). */
export type GuardConfigResult = { ok: true; cfg: JevmemConfig; text: string; problems: string[] } | { ok: false; error: string };

/**
 * jevmem.config.json for the guard: an unreadable file, bad JSON or an unknown guard setting is an error (fail open).
 * `blockMin` below `askMin` would make `block` deny wherever it asks: the two defaults are used instead, as a problem.
 */
export function readGuardConfig(root: string): GuardConfigResult {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, CONFIG_FILE), "utf8");
  } catch (err) {
    return { ok: false, error: `jevmem.config.json unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  let cfg: JevmemConfig;
  try {
    cfg = parseConfig(text);
  } catch (err) {
    return { ok: false, error: `jevmem.config.json is not valid: ${err instanceof Error ? err.message : String(err)}` };
  }
  const g = cfg.guard;
  if (!g || typeof g !== "object") return { ok: false, error: "guard in jevmem.config.json is not an object" };
  if (!GUARD_MODES.includes(g.mode)) return { ok: false, error: `guard.mode must be one of ${GUARD_MODES.join(", ")} (got ${JSON.stringify(g.mode)})` };
  for (const k of ["askMin", "blockMin"] as const) if (typeof g[k] !== "number" || !(g[k] >= 0 && g[k] <= 1)) return { ok: false, error: `guard.${k} must be a number from 0 to 1` };
  if (typeof g.budgetMs !== "number" || !(g.budgetMs > 0)) return { ok: false, error: "guard.budgetMs must be a positive number" };
  if (typeof g.maxCandidates !== "number" || !(g.maxCandidates >= 1)) return { ok: false, error: "guard.maxCandidates must be 1 or more" };
  const problems: string[] = [];
  if (g.blockMin < g.askMin) {
    const d = DEFAULT_CONFIG.guard;
    problems.push(`guard.blockMin (${g.blockMin}) is below guard.askMin (${g.askMin}) in jevmem.config.json, so block mode would deny calls it should only ask about; the guard uses the defaults instead, askMin ${d.askMin} and blockMin ${d.blockMin}`);
    g.askMin = d.askMin;
    g.blockMin = d.blockMin;
  }
  // The hook entry's timeout is 3 s: a longer budget would only be cut off by Claude Code.
  g.budgetMs = Math.min(g.budgetMs, 2500);
  g.maxCandidates = Math.min(Math.floor(g.maxCandidates), 10);
  return { ok: true, cfg, text, problems };
}

// ---------------------------------------------------------------------------------------------
// Rules and the index

export interface SkippedRule {
  id: string;
  text: string;
  reason: string;
}

export interface LoadedRules {
  enforced: IndexedRule[];
  skipped: SkippedRule[];
  /** Served from `.jevmem/guard-index.json` (no parse, no gate files read). */
  cached: boolean;
}

const indexFile = (root: string) => path.join(root, ".jevmem", "guard-index.json");
const cacheFile = (root: string) => path.join(root, ".jevmem", "guard-cache.json");

/** Size, modification time (full precision) and inode: changes whenever the file is rewritten. */
function stamp(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${s.size}:${s.mtimeMs}:${s.ino}`;
  } catch {
    return "-";
  }
}

/** Write a JSON file through a temp file and a rename, so a concurrent reader never sees half of it. */
function writeJsonAtomic(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  } catch {
    /* a lost cache write only costs a rebuild or a Jev call */
  }
}

/**
 * The rules the guard enforces, and the ones it skips with the reason. `memoryText` is JEVMEM.md's content. The result
 * is cached by the file's hash and the state of the gate's verdict cache and provenance file.
 */
export function loadRules(root: string, cfg: JevmemConfig, memoryText: string): LoadedRules {
  if (!memoryText.includes("[constraint]") && !memoryText.includes("[superseded]")) return { enforced: [], skipped: [], cached: false };
  const key = [INDEX_VERSION, crypto.createHash("sha256").update(memoryText).digest("hex").slice(0, 24), stamp(path.join(root, ".jevmem", "gate.json")), stamp(path.join(root, ".jevmem", "provenance.jsonl")), cfg.thresholds.injectionMax].join("|");
  try {
    const idx = JSON.parse(fs.readFileSync(indexFile(root), "utf8"));
    if (idx && idx.key === key && Array.isArray(idx.enforced) && Array.isArray(idx.skipped)) return { enforced: idx.enforced, skipped: idx.skipped, cached: true };
  } catch {
    /* no index yet */
  }
  const all = parseMemoryFile(memoryText).memories;
  const constraints = all.filter((m) => m.kind === "constraint" && !m.supersededBy);
  const skipped: SkippedRule[] = all.filter((m) => m.kind === "superseded" || m.supersededBy).map((m) => ({ id: m.id, text: m.text, reason: `superseded${m.supersededBy ? ` by ${m.supersededBy}` : ""}` }));
  // A retired rule (0.7.0, `jevmem forget`) is listed as skipped, so `jevmem guard test` says why it is not enforced.
  for (const m of all) if (m.kind === "retired" && m.was === "constraint") skipped.push({ id: m.id, text: m.text, reason: `retired${m.retiredAt ? ` on ${m.retiredAt.slice(0, 10)}` : ""}` });
  const plan = planGate(root, constraints, cfg.thresholds.injectionMax);
  for (const m of plan.check) skipped.push({ id: m.id, text: m.text, reason: "no gate verdict yet (an unverified line: checked on the next prompt or Stop, or by `jevmem audit --security`)" });
  for (const w of plan.withheld) skipped.push({ id: w.memory.id, text: w.memory.text, reason: `withheld by the poisoning gate: ${w.reason}` });
  const prov = readProvenance(root);
  const enforced: IndexedRule[] = plan.serve.map((m) => ({ id: m.id, text: m.text, sha: lineSha(m.text), features: ruleFeatures(m.text), verified: isVerified(prov, m) }));
  writeJsonAtomic(indexFile(root), { key, builtAt: new Date().toISOString(), enforced, skipped });
  if (plan.check.length) appendLog(root, { ts: new Date().toISOString(), label: "guard", event: "guard", ok: true, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, detail: `not enforced until the poisoning gate has checked them: ${plan.check.map((m) => m.id).join(", ")}` });
  return { enforced, skipped, cached: false };
}

// ---------------------------------------------------------------------------------------------
// The answer cache

interface CacheEntry {
  p: number;
  ts: string;
  rule: string;
  model: string;
}

export function answerKey(rule: Pick<IndexedRule, "id" | "sha">, actionHash: string): string {
  return crypto.createHash("sha256").update(`${GUARD_VERSION}|${rule.id}|${rule.sha}|${actionHash}`).digest("hex").slice(0, 32);
}

export function readAnswers(root: string): Record<string, CacheEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(root), "utf8"));
    return raw && raw.v === GUARD_VERSION && raw.entries && typeof raw.entries === "object" ? raw.entries : {};
  } catch {
    return {};
  }
}

function writeAnswers(root: string, updates: Record<string, CacheEntry>): void {
  if (!Object.keys(updates).length) return;
  const all = { ...readAnswers(root), ...updates };
  // Bounded: the newest 2,000 answers.
  const kept = Object.entries(all).sort((a, b) => (a[1].ts < b[1].ts ? 1 : -1)).slice(0, 2000);
  writeJsonAtomic(cacheFile(root), { v: GUARD_VERSION, entries: Object.fromEntries(kept) });
}

// ---------------------------------------------------------------------------------------------
// What is sent

/** How a staged file is named to Jev: `.env (untracked)`. */
export function stagedLabel(f: StagedFile): string {
  const state = { untracked: "untracked", ignored: "ignored, added with -f", changed: "changed", staged: "already staged" }[f.state];
  return `${f.path} (${state})`;
}

/**
 * The call as Jev sees it: scrubbed, bounded, paths relative to the project. `stages`: for a git command, the files it
 * would stage or commit that a candidate rule names (`.env (untracked)`). `message`: the message a `git commit` would
 * get, when a candidate rule is about commit messages. Each heredoc body in the command is cut to `SEND.added`
 * characters around what matched, so the shape of the call stays in view.
 */
export function callPayload(action: GuardAction, terms: string[], stages: string[] = [], message?: string): Record<string, string> {
  // Scrub a slightly wider window than is kept, so a secret cut by the window's edge is still recognised whole.
  const clip = (text: string, max: number) => {
    const wide = snippetAround(text, terms, max + 400);
    return snippetAround(scrubSecrets(wide), terms, max);
  };
  if (action.tool === "Bash") {
    const command = condenseHeredocs(action.command ?? "", SEND.added, (body) => snippetAround(body, terms, SEND.added));
    const out: Record<string, string> = { tool: "Bash", command: clip(command, SEND.command) };
    if (stages.length) {
      const list = stages.slice(0, STAGES_SENT).join("; ") + (stages.length > STAGES_SENT ? `; and ${stages.length - STAGES_SENT} more` : "");
      out.stages = shorten(scrubSecrets(list), SEND.stages);
    }
    if (message !== undefined) out.message = clip(message, SEND.message);
    return out;
  }
  if (action.tool === "Edit") return { tool: "Edit", file: action.file ?? "", removed: clip(action.removed ?? "", SEND.removed), added: clip(action.added ?? "", SEND.added) };
  return { tool: "Write", file: action.file ?? "", content: clip(action.added ?? "", SEND.added) };
}

export function payloadHash(payload: Record<string, string>): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------------------------
// Tamper check (local, no Jev)

/** Commands that never write their file arguments. */
const READ_ONLY = new Set(["cat", "less", "more", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "ack", "wc", "jq", "diff", "cmp", "ls", "stat", "file", "bat", "sha1sum", "sha256sum", "shasum", "md5", "md5sum", "cksum", "view", "od", "xxd", "hexdump", "strings", "test", "[", "realpath", "readlink", "dirname", "basename", "echo", "printf", "cut", "tr", "nl", "column", "tac", "rev", "comm", "join", "paste", "fold", "source", ".", "cd", "pushd", "popd", "pwd", "type", "which", "env", "export", "set", "unset", "true", "false", "sleep", "date", "yes", "seq", "xargs", "tee"]);
/** Git subcommands that leave the working tree's files alone. */
const GIT_READ = new Set(["diff", "log", "show", "status", "blame", "add", "commit", "ls-files", "grep", "cat-file", "annotate", "shortlog", "whatchanged", "check-ignore", "rev-parse", "describe", "tag", "branch", "remote", "fetch", "push", "stash", "config", "reflog", "rev-list", "ls-remote", "merge-base", "count-objects", "var", "help", "version"]);
/** Git subcommands that write, move or delete the files they name. */
const GIT_WRITE = new Set(["checkout", "restore", "rm", "mv", "clean"]);
/** Does a redirection operator write its target: `>`, `>>`, `>|`, `>&` (before a file), `&>` and `&>>`; `<` and `<&` read. */
const writesTarget = (op: string) => op.includes(">") && !op.startsWith("<");
/** Does it only append: `>>` and `&>>`. Appending cannot remove a line from a file. */
const appends = (op: string) => op === ">>" || op === "&>>";
/** macOS and Windows file systems ignore case by default. */
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

/** The files a simple command writes, moves or deletes, as words: what its output redirections and its arguments name. */
export interface Touches {
  /** Words that name a file the command changes. */
  words: string[];
  /** Every change is an append (`>>`, `tee -a`): a line cannot be removed this way. */
  appendOnly: boolean;
  /** A folder named here is changed with everything in it (`rm -r`, `mv`, `rsync`). */
  tree: boolean;
  /** `git clean -x` or `-X`: deletes ignored files under the folders named (all of the work tree when none are). */
  cleansIgnored: boolean;
  /** The folders a `git clean` names. */
  dirs: string[];
}

/** The command word of a simple command past `npx`, `pnpx`, `bunx`, `npm exec`, `pnpm dlx` and the like. */
function effectiveCommand(c: SimpleCommand): { cmd: string; args: string[]; gitDir: string | null; sub: string | null } | null {
  const first = commandOf(c.words);
  if (!first.cmd) return null;
  let cmd = first.cmd;
  let args = first.args;
  for (;;) {
    if (["npx", "pnpx", "bunx"].includes(cmd)) {
      let i = 0;
      while (i < args.length && args[i]!.startsWith("-")) i++;
      if (i >= args.length) return null;
      cmd = (args[i]!.split("/").pop() ?? args[i]!).toLowerCase();
      args = args.slice(i + 1);
      continue;
    }
    if (["npm", "pnpm", "yarn", "bun"].includes(cmd) && ["exec", "dlx", "x"].includes(args[0] ?? "")) {
      let i = 1;
      while (i < args.length && args[i]!.startsWith("-")) i++;
      if (i >= args.length) return null;
      cmd = (args[i]!.split("/").pop() ?? args[i]!).toLowerCase();
      args = args.slice(i + 1);
      continue;
    }
    break;
  }
  let gitDir: string | null = null;
  let sub: string | null = null;
  if (cmd === "git") {
    let i = 0;
    while (i < args.length && args[i]!.startsWith("-")) {
      const w = args[i]!;
      if (w === "-C") {
        gitDir = args[i + 1] ?? null;
        i += 2;
      } else if (w === "-c" || w === "--namespace" || w === "--config-env") i += 2;
      else i++;
    }
    sub = args[i] ?? null;
    args = args.slice(i + 1);
  }
  return { cmd, args, gitDir, sub };
}

/**
 * What one simple command writes, moves or deletes, by its command word: its output redirections' targets always;
 * a known reader's arguments never; the destination of `cp`, `install`, `rsync` and `ln`; everything `mv`, `rm`,
 * `unlink`, `rmdir` and `shred` name; the files of `sed -i`, `perl -i`, `awk -i inplace`, `sort -o`, `uniq`'s second
 * file, `truncate`, `touch`, `dd of=`; the pathspecs of `git checkout`, `restore`, `rm` and `mv`; and, for a command
 * the guard does not know, every file it names.
 */
export function touchesOf(c: SimpleCommand, e: NonNullable<ReturnType<typeof effectiveCommand>>): Touches {
  const outputs = c.redirects.filter((_, k) => writesTarget(c.redirectOps[k] ?? ">"));
  const outputOps = c.redirectOps.filter((op) => writesTarget(op));
  const { cmd, args, sub } = e;
  const plain = args.filter((a) => !a.startsWith("-") || a === "-");
  const has = (...flags: string[]) => args.some((a) => flags.includes(a));
  let words: string[] = [];
  let appendOnly = outputs.length > 0 && outputOps.every(appends);
  let tree = false;
  let cleansIgnored = false;
  let dirs: string[] = [];
  const inplace = (short: RegExp) => args.some((a) => short.test(a) || a === "--in-place");
  if (cmd === "tee") {
    words = plain;
    appendOnly = has("-a", "--append") && (outputs.length === 0 || outputOps.every(appends));
  } else if (cmd === "cp" || cmd === "install" || cmd === "rsync") {
    const t = args.indexOf("-t");
    words = t >= 0 && args[t + 1] ? [args[t + 1]!] : plain.slice(-1);
    tree = cmd === "rsync" || has("-r", "-R", "-a", "--recursive");
  } else if (cmd === "ln") {
    words = plain.length > 1 ? plain.slice(-1) : [];
  } else if (cmd === "mv") {
    words = plain;
    tree = true;
  } else if (cmd === "rm" || cmd === "unlink" || cmd === "rmdir" || cmd === "shred") {
    words = plain;
    tree = cmd === "rmdir" || args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
  } else if (cmd === "sed") {
    words = inplace(/^-[a-zA-Z]*i/) ? plain : [];
  } else if (cmd === "perl") {
    words = inplace(/^-[a-zA-Z]*i/) ? plain : [];
  } else if (cmd === "awk" || cmd === "gawk") {
    const i = args.indexOf("-i");
    words = (i >= 0 && args[i + 1] === "inplace") || has("--inplace") ? plain : [];
  } else if (cmd === "sort") {
    const o = args.indexOf("-o");
    words = o >= 0 && args[o + 1] ? [args[o + 1]!] : args.filter((a) => a.startsWith("--output=")).map((a) => a.slice(9));
  } else if (cmd === "uniq") {
    words = plain.length > 1 ? [plain[1]!] : [];
  } else if (cmd === "truncate" || cmd === "touch") {
    words = plain;
  } else if (cmd === "dd") {
    words = args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
  } else if (cmd === "git") {
    if (sub === "clean") {
      // Tracked files are safe from git clean; ignored ones (.jevmem/) go with -x or -X.
      cleansIgnored = args.some((a) => /^-[a-zA-Z]*[xX]/.test(a));
      const dd = args.indexOf("--");
      dirs = dd >= 0 ? args.slice(dd + 1) : plain;
      words = [];
    } else if (sub && GIT_WRITE.has(sub)) {
      const dd = args.indexOf("--");
      words = dd >= 0 ? args.slice(dd + 1) : plain;
      tree = sub === "rm" || sub === "mv";
    } else words = sub && GIT_READ.has(sub) ? [] : plain;
  } else if (READ_ONLY.has(cmd) || cmd === "jevmem") {
    words = [];
  } else {
    // A command the guard does not know: every file it names, as before.
    words = args;
  }
  return { words: [...words, ...outputs], appendOnly: appendOnly && words.every((w) => outputs.includes(w)), tree, cleansIgnored, dirs };
}

/** Apply an Edit to a file's current text, as Claude Code would (null when old_string is not found: the edit fails). */
function applyEdit(current: string, oldString: string, newString: string, replaceAll: boolean): string | null {
  if (!oldString) return null;
  if (!current.includes(oldString)) return null;
  return replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, () => newString);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function describeGuardChange(before: JevmemConfig, after: JevmemConfig): string | null {
  if ((before.enabled !== false) !== (after.enabled !== false)) return `sets "enabled": ${after.enabled === false ? "false, which switches jevmem off" : "true"}`;
  if (sameJson(before.guard, after.guard)) return null;
  const changes: string[] = [];
  for (const k of new Set([...Object.keys(before.guard ?? {}), ...Object.keys(after.guard ?? {})])) {
    const a = (before.guard as any)?.[k];
    const b = (after.guard as any)?.[k];
    if (!sameJson(a, b)) changes.push(`guard.${k} ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  }
  return changes.join(", ") || "changes the guard settings";
}

function activeConstraints(text: string): Memory[] {
  return parseMemoryFile(text).memories.filter((m) => m.kind === "constraint" && !m.supersededBy);
}

const q = (s: string, max = 160) => {
  const one = s.replace(/\s+/g, " ").trim();
  return `"${one.length > max ? one.slice(0, max - 1) + "…" : one}"`;
};

/**
 * Does this call change the guard settings, remove or supersede a saved rule, or switch jevmem off? Returns the
 * reason to show the user, or null. `configText` and `memoryText` are the current files ("" when missing).
 */
export function tamperCheck(root: string, cfg: JevmemConfig, action: GuardAction, input: GuardInput, configText: string, memoryText: string | null, opts: { cwd?: string; home?: string } = {}): string | null {
  const memoryName = cfg.memoryFile || "JEVMEM.md";
  if (action.tool === "Edit" || action.tool === "Write") {
    const rel = action.file ?? "";
    const next = (current: string): string | null => {
      if (action.tool === "Write") return action.added ?? "";
      return applyEdit(current, action.removed ?? "", action.added ?? "", input.tool_input?.replace_all === true);
    };
    if (rel === CONFIG_FILE) {
      const after = next(configText);
      if (after === null) return null;
      let parsedAfter: JevmemConfig;
      try {
        parsedAfter = parseConfig(after);
      } catch {
        return "jevmem: this edit would leave jevmem.config.json unreadable, which switches the guard off.";
      }
      let parsedBefore: JevmemConfig;
      try {
        parsedBefore = parseConfig(configText);
      } catch {
        return null;
      }
      const change = describeGuardChange(parsedBefore, parsedAfter);
      return change ? `jevmem: this changes jevmem's guard settings in jevmem.config.json (${change}).` : null;
    }
    if (rel === memoryName && memoryText !== null) {
      const before = activeConstraints(memoryText);
      if (!before.length) return null;
      const after = next(memoryText);
      if (after === null) return null;
      const kept = new Set(activeConstraints(after).map((m) => `${m.id}\n${m.text}`));
      const gone = before.filter((m) => !kept.has(`${m.id}\n${m.text}`));
      if (!gone.length) return null;
      return `jevmem: this edit removes or supersedes ${gone.length === 1 ? "a saved rule" : `${gone.length} saved rules`} in ${memoryName}: ${gone.slice(0, 3).map((m) => q(m.text)).join("; ")}.`;
    }
    if (rel === ".jevmem" || rel.startsWith(".jevmem/")) return "jevmem: this edit changes jevmem's local state in .jevmem/ (verdicts and cached answers the guard relies on).";
    return null;
  }
  // Bash: what the command line writes, moves or deletes, with every path resolved against the folder the command
  // runs in (`cd`, `pushd`, `git -C` and `~` followed), compared with this project's files. `~/.jevmem/…` and another
  // project's `.jevmem/` are not this project's.
  const cwd = opts.cwd ?? root;
  const home = opts.home;
  const target = { config: path.resolve(root, CONFIG_FILE), memory: path.resolve(root, memoryName), state: path.resolve(root, ".jevmem") };
  const rootAbs = path.resolve(root);
  const norm = (p: string) => (CASE_INSENSITIVE ? p.toLowerCase() : p);
  const same = (a: string, b: string) => norm(a) === norm(b);
  const under = (p: string, dir: string) => norm(p).startsWith(`${norm(dir)}/`);
  const hasRules = memoryText !== null && activeConstraints(memoryText).length > 0;
  const commands = withDirs(readCommandLine(action.command ?? ""), cwd, home, root, (b, p) => path.resolve(b, p));
  for (const c of commands) {
    const e = effectiveCommand(c);
    if (!e) continue;
    const { cmd: cmdWord, args, sub } = e;
    if (cmdWord === "jevmem") {
      if (sub === "disable" || args[0] === "disable") return "jevmem: this runs `jevmem disable`, which switches jevmem and its guard off in this project.";
      if (args[0] === "init" && args.includes("--remove-hooks")) return "jevmem: this runs `jevmem init --remove-hooks`, which removes the hooks the guard runs from.";
      if (args[0] === "wrong" && hasRules && args.includes("none")) return `jevmem: this runs \`jevmem wrong … --should-be none\`, which can retire a saved rule in ${memoryName}.`;
      if (args[0] === "forget" && hasRules) return `jevmem: this runs \`jevmem forget\`, which can retire a saved rule in ${memoryName}.`;
      // `jevmem trust` marks a line as verified, which lets block mode deny on it: asked whatever the rules are.
      if (args[0] === "trust" || (args[0] === "add" && args.includes("--trust"))) return `jevmem: this runs \`jevmem ${args[0] === "trust" ? "trust" : "add --trust"}\`, which marks a line in ${memoryName} as verified, so the guard can block on it.`;
      continue;
    }
    const t = touchesOf(c, e);
    // The folder the command's paths are relative to: `git -C dir` for a git command, else where the command runs.
    let base: string | null = c.cwd ?? null;
    if (e.gitDir !== null) {
      const g = base === null ? null : expandPath(e.gitDir, base, home, root);
      base = g === null ? null : path.resolve(base!, g);
    }
    let touchesConfig = false;
    let touchesMemory = false;
    let touchesState = false;
    /** One resolved path (or a glob's folder and pattern) against the three targets. */
    const check = (abs: string, pattern: RegExp | null) => {
      if (pattern) {
        // A wildcard in the last segment: the folder is `abs`, the names it could match come from the pattern.
        if (same(abs, target.state) || under(abs, target.state)) touchesState = true;
        if (same(abs, rootAbs)) {
          if (pattern.test(CONFIG_FILE)) touchesConfig = true;
          if (pattern.test(memoryName)) touchesMemory = true;
          if (pattern.test(".jevmem")) touchesState = true;
        }
        return;
      }
      if (same(abs, target.config)) touchesConfig = true;
      if (same(abs, target.memory)) touchesMemory = true;
      if (same(abs, target.state) || under(abs, target.state)) touchesState = true;
      // `rm -r .`, `mv <project> …`: a folder that holds the project's files.
      if (t.tree && (same(abs, rootAbs) || under(rootAbs, abs))) {
        touchesConfig = true;
        touchesMemory = true;
        touchesState = true;
      }
    };
    for (const w of t.words) {
      if (/^\d+$/.test(w) || w === "-") continue;
      const expanded = expandPath(w, base, home, root);
      if (expanded === null) continue;
      const wild = /[*?[]/.test(expanded) && c.globs[c.words.indexOf(w)] !== false;
      if (wild) {
        const i = expanded.search(/[*?[]/);
        const slash = expanded.lastIndexOf("/", i);
        const dir = slash < 0 ? "" : expanded.slice(0, slash);
        const rest = expanded.slice(slash + 1);
        if (rest.includes("/")) continue; // a wildcard in a folder name: not read
        // The names it could match, as the shell expands it (no dotfiles unless the pattern starts with a dot).
        const re = shellGlobRegExp(rest, { dotfiles: false });
        const absDir = dir === "" ? base : dir.startsWith("/") ? dir : base === null ? null : path.resolve(base, dir);
        if (absDir !== null && re !== null) check(path.resolve(absDir), re);
        continue;
      }
      const abs = expanded.startsWith("/") ? path.resolve(expanded) : base === null ? null : path.resolve(base, expanded);
      if (abs !== null) check(abs, null);
    }
    // `git clean -x` or `-X` deletes ignored files, and `.jevmem/` is ignored: with no path, everything under the
    // folder it runs in; with paths, what is under them.
    if (t.cleansIgnored && base !== null) {
      const dirs = t.dirs.map((w) => {
        const x = expandPath(w, base, home, root);
        return x === null ? null : path.resolve(base!, x);
      });
      const covers = (d: string | null) => d !== null && (same(d, rootAbs) || under(rootAbs, d) || same(d, target.state) || under(target.state, d) || under(d, target.state));
      if (dirs.length ? dirs.some(covers) : same(base, rootAbs) || under(base, rootAbs) || under(rootAbs, base)) touchesState = true;
    }
    if (!touchesConfig && !(touchesMemory && hasRules) && !touchesState) continue;
    // Appending (>>) cannot remove a rule from JEVMEM.md.
    if (touchesMemory && !touchesConfig && !touchesState && t.appendOnly) continue;
    if (touchesConfig) return "jevmem: this command changes jevmem.config.json, which holds jevmem's guard settings.";
    if (touchesMemory && hasRules) return `jevmem: this command changes ${memoryName} and may remove or supersede saved rules.`;
    return "jevmem: this command changes jevmem's local state in .jevmem/ (verdicts and cached answers the guard relies on).";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Decision

export type GuardDecision = "none" | "ask" | "deny" | "warn";

export interface RuleCheck {
  id: string;
  text: string;
  /** Written by jevmem on this machine (src/provenance.ts). An unverified rule is asked about, never denied. */
  verified: boolean;
  /** Jev's probability that the call breaks the rule; null when no answer (timeout, no key, error). */
  p: number | null;
  cached: boolean;
  /** Matched on something strong (a path, a filename, a staged file, a `command subcommand` pair, a tool, a commit message), not on keywords alone. */
  strong: boolean;
}

export interface GuardTrace {
  root: string;
  mode: GuardMode | null;
  thresholds: { askMin: number; blockMin: number } | null;
  tool: string | null;
  action: GuardAction | null;
  rules: LoadedRules | null;
  candidates: Candidate[];
  payload: Record<string, string> | null;
  /** For a git command, what it would stage or commit (src/gitstage.ts); null when git was not asked. */
  staged: GitExpansion | null;
  checks: RuleCheck[];
  tamper: string | null;
  /** How the call was decided (src/guardlog.ts); null when the guard did not check it (not enabled, off, another tool). */
  route: GuardRoute | null;
  decision: GuardDecision;
  /** Exactly what the hook prints: "" (no decision) or one JSON object. */
  stdout: string;
  /** Why there was no decision, or what went wrong (timeout, no key, bad config). */
  notes: string[];
  /** The parts of the check that failed (the tamper check, the prefilter, the git expansion): each is logged, and the others still ran. */
  errors: string[];
  jevMs: number | null;
  totalMs: number;
}

export interface GuardDeps {
  /** A Jev client, or a factory called only when a call has to be asked (tests inject one; null: no key). */
  jev?: JevCaller | null;
  makeJev?: (cfg: JevmemConfig, root: string) => Promise<JevCaller | null>;
  env?: NodeJS.ProcessEnv;
  root?: string;
  /** Override the prefilter's options (the eval tunes them). */
  match?: Partial<MatchOptions>;
  /** Skip the answer cache (read and write). */
  noCache?: boolean;
  /** Log decisions and failures to `.jevmem/log.jsonl`, and each checked call to `.jevmem/guard-log.jsonl` (default true). */
  log?: boolean;
  /** The tamper check to run (tests inject one that fails, to see the other parts go on). */
  tamperCheck?: typeof tamperCheck;
}

/** The hook's JSON. `decision` is never "allow": that would skip the user's permission prompt. */
export function hookOutput(decision: GuardDecision, reason: string, context: string | null): string {
  if (decision !== "ask" && decision !== "deny" && decision !== "warn") return "";
  const out: Record<string, unknown> = { hookEventName: "PreToolUse" };
  if (decision === "ask" || decision === "deny") {
    out.permissionDecision = decision;
    out.permissionDecisionReason = reason;
  }
  if (context) out.additionalContext = context;
  if (decision === "warn" && !context) return "";
  if (out.permissionDecision !== undefined && out.permissionDecision !== "ask" && out.permissionDecision !== "deny") return "";
  return JSON.stringify({ hookSpecificOutput: out });
}

function ruleList(checks: RuleCheck[]): string {
  return checks.slice(0, 3).map((c) => q(c.text)).join("; ") + (checks.length > 3 ? `; and ${checks.length - 3} more` : "");
}

/**
 * The rules quoted, then where they come from: `(JEVMEM.md)`, or which of the quoted ones are unverified lines (jevmem
 * did not write them on this machine), with their ids. `notBlocked`: in block mode, an unverified rule that reached
 * `blockMin` is asked about instead, and the reason says so.
 */
function rulesWithSource(checks: RuleCheck[], notBlocked = false): string {
  const unverified = checks.slice(0, 3).filter((c) => !c.verified).map((c) => c.id);
  if (!unverified.length) return `${ruleList(checks)} (JEVMEM.md)`;
  const lines = unverified.length === 1 ? `unverified line ${unverified[0]}` : `unverified lines ${unverified.join(", ")}`;
  return `${ruleList(checks)} (JEVMEM.md; ${lines}${notBlocked ? ": asked, not blocked" : ""})`;
}

/**
 * Turn the answers and the tamper check into the decision and the hook's output. Only a verified rule can deny: an
 * unverified one (a hand edit, a line from git, `jevmem add`) is asked about in block mode too, since a line planted
 * as an ordinary team rule passes the poisoning gate.
 */
export function decideGuard(mode: GuardMode, askMin: number, blockMin: number, checks: RuleCheck[], tamper: string | null, opts: { unchecked?: boolean } = {}): { decision: GuardDecision; stdout: string } {
  if (mode === "off") return { decision: "none", stdout: "" };
  const hits = checks.filter((c) => c.p !== null && c.p >= askMin).sort((a, b) => b.p! - a.p!);
  // Jev failed or ran out of time: a candidate matched on something strong is asked about instead of let through, in
  // ask and block mode alike (never denied); one matched on keywords alone stays fail-open.
  const unchecked = opts.unchecked ? checks.filter((c) => c.p === null && c.strong) : [];
  const blocks = hits.filter((c) => c.p! >= blockMin && c.verified);
  const notBlocked = mode === "block" && hits.some((c) => c.p! >= blockMin && !c.verified);
  const plural = (n: number) => (n === 1 ? "a saved rule" : "saved rules");
  if (mode === "block" && blocks.length) {
    const one = blocks.length === 1;
    const reason = `jevmem: blocked by ${one ? "a saved project rule" : "saved project rules"}: ${ruleList(blocks)} (JEVMEM.md). Tell the user about ${one ? "this rule" : "these rules"} instead of working around ${one ? "it" : "them"}.`;
    return { decision: "deny", stdout: hookOutput("deny", reason, null) };
  }
  if (tamper) {
    const reason = hits.length ? `${tamper} It may also break ${plural(hits.length)}: ${rulesWithSource(hits, notBlocked)}.` : tamper;
    return { decision: "ask", stdout: hookOutput("ask", reason, null) };
  }
  if (!hits.length && unchecked.length) {
    if (mode === "warn") {
      const context = unchecked.length === 1 ? `Saved project rule in JEVMEM.md, not checked against this call in time: ${q(unchecked[0]!.text)}.` : `Saved project rules in JEVMEM.md, not checked against this call in time: ${ruleList(unchecked)}.`;
      return { decision: "warn", stdout: hookOutput("warn", "", context) };
    }
    return { decision: "ask", stdout: hookOutput("ask", `jevmem: couldn't check this call against ${unchecked.length === 1 ? "a saved rule" : "saved rules"} in time: ${rulesWithSource(unchecked)}.`, null) };
  }
  if (!hits.length) return { decision: "none", stdout: "" };
  if (mode === "warn") {
    const context = hits.length === 1 ? `Saved project rule in JEVMEM.md: ${q(hits[0]!.text)}.` : `Saved project rules in JEVMEM.md: ${ruleList(hits)}.`;
    return { decision: "warn", stdout: hookOutput("warn", "", context) };
  }
  return { decision: "ask", stdout: hookOutput("ask", `jevmem: this may break ${plural(hits.length)}: ${rulesWithSource(hits, notBlocked)}`, null) };
}

// ---------------------------------------------------------------------------------------------
// Evaluate one call

function readMemoryText(root: string, cfg: JevmemConfig): { text: string | null; error: string | null } {
  const file = path.join(root, cfg.memoryFile || "JEVMEM.md");
  try {
    return { text: fs.readFileSync(file, "utf8"), error: null };
  } catch (err: any) {
    if (err && err.code === "ENOENT") return { text: "", error: null };
    return { text: null, error: `${cfg.memoryFile || "JEVMEM.md"} unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function logGuard(root: string, enabled: boolean, entry: { ok: boolean; detail?: string; error?: string; latencyMs?: number }): void {
  if (!enabled) return;
  appendLog(root, { ts: new Date().toISOString(), label: "guard", ...(entry.ok ? { event: "guard" as const } : {}), ok: entry.ok, latencyMs: entry.latencyMs ?? 0, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, ...(entry.detail ? { detail: entry.detail } : {}), ...(entry.error ? { error: entry.error } : {}) });
}

/** Everything the hook does for one PreToolUse payload, with the reasons, for the hook and `jevmem guard test`. */
export async function evaluateGuard(input: GuardInput, deps: GuardDeps = {}): Promise<GuardTrace> {
  const t0 = performance.now();
  const env = deps.env ?? process.env;
  const root = deps.root ?? guardRoot(input, env);
  const log = deps.log !== false;
  const trace: GuardTrace = { root, mode: null, thresholds: null, tool: input.tool_name ?? null, action: null, rules: null, candidates: [], payload: null, staged: null, checks: [], tamper: null, route: null, decision: "none", stdout: "", notes: [], errors: [], jevMs: null, totalMs: 0 };
  const startedAt = new Date().toISOString();
  const guarded = GUARDED_TOOLS.includes(input.tool_name as GuardTool);
  const done = () => {
    trace.totalMs = Math.round(performance.now() - t0);
    return trace;
  };
  // A call the guard checked but could not decide on (bad config, malformed input) still counts as seen.
  const failedCall = () => {
    trace.route = "error";
    if (log && guarded) recordGuardCall(root, { ts: startedAt, tool: input.tool_name!, ...(input.tool_use_id ? { tool_use_id: input.tool_use_id } : {}), route: "error", decision: "none" });
    return done();
  };
  if (!fs.existsSync(path.join(root, CONFIG_FILE))) {
    trace.notes.push("jevmem is not enabled in this project (no jevmem.config.json)");
    return done();
  }
  const conf = readGuardConfig(root);
  if (!conf.ok) {
    trace.notes.push(conf.error);
    logGuard(root, log, { ok: false, error: conf.error });
    return failedCall();
  }
  const cfg = conf.cfg;
  for (const problem of conf.problems) {
    trace.notes.push(problem);
    if (log) appendLog(root, { ts: new Date().toISOString(), label: "guard", event: "guard-config", ok: false, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, error: problem });
  }
  trace.mode = cfg.guard.mode;
  trace.thresholds = { askMin: cfg.guard.askMin, blockMin: cfg.guard.blockMin };
  if (cfg.enabled === false) {
    trace.notes.push('jevmem is switched off here ("enabled": false)');
    return done();
  }
  if (cfg.guard.mode === "off") {
    trace.notes.push("guard.mode is off");
    return done();
  }
  const action = toAction(input, root);
  trace.action = action;
  if (!action) {
    trace.notes.push(guarded ? "the tool input has no command or file_path" : `not a checked tool (${input.tool_name ?? "none"}; the guard checks ${GUARDED_TOOLS.join(", ")})`);
    if (!guarded) return done();
    logGuard(root, log, { ok: false, error: `malformed ${input.tool_name} input` });
    return failedCall();
  }

  const mem = readMemoryText(root, cfg);
  if (mem.error) {
    trace.notes.push(mem.error);
    logGuard(root, log, { ok: false, error: mem.error });
  }
  // The folder a Bash command starts in (the PreToolUse payload's cwd), for paths it names relative to it.
  const cwd = input.cwd && fs.existsSync(input.cwd) ? input.cwd : root;
  // Each part of the check runs on its own: when one fails, the failure is logged, and the other parts still decide.
  const part = <T>(name: string, run: () => T, fallback: T): T => {
    try {
      return run();
    } catch (err) {
      const e = `${name} failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
      trace.errors.push(e);
      trace.notes.push(e);
      logGuard(root, log, { ok: false, error: e });
      return fallback;
    }
  };
  const tamper = deps.tamperCheck ?? tamperCheck;
  trace.tamper = part("the tamper check", () => tamper(root, cfg, action, input, conf.text, mem.text, { cwd, home: env.HOME }), null);

  const finish = (checks: RuleCheck[]) => {
    trace.checks = checks;
    const unchecked = trace.route === "jev-failed" || trace.route === "no-time";
    const d = decideGuard(cfg.guard.mode, cfg.guard.askMin, cfg.guard.blockMin, checks, trace.tamper, { unchecked });
    trace.decision = d.decision;
    trace.stdout = d.stdout;
    const hits = checks.filter((c) => c.p !== null && c.p >= cfg.guard.askMin).sort((a, b) => b.p! - a.p!);
    if (d.decision !== "none") logGuard(root, log, { ok: true, latencyMs: Math.round(performance.now() - t0), detail: `${d.decision} ${action.tool}${trace.tamper ? " (tamper)" : ""}${hits.length ? `: ${hits.map((c) => `${c.id} p=${c.p!.toFixed(2)}${c.cached ? " (cached)" : ""}`).join(", ")}` : ""}` });
    if (log) {
      const entry: GuardLogEntry = { ts: startedAt, tool: action.tool, ...(input.tool_use_id ? { tool_use_id: input.tool_use_id } : {}), route: trace.route ?? "error", decision: d.decision };
      if (trace.errors.length) entry.error = shorten(scrubSecrets(trace.errors.join("; ")), 200);
      if (d.decision !== "none") {
        entry.mode = cfg.guard.mode;
        if (hits.length) entry.rules = hits.map((c) => ({ id: c.id, p: Math.round(c.p! * 1000) / 1000, text: shorten(scrubSecrets(c.text), 200), ...(c.verified ? {} : { unverified: true }) }));
        else if (unchecked) entry.rules = checks.filter((c) => c.p === null && c.strong).map((c) => ({ id: c.id, text: shorten(scrubSecrets(c.text), 200), unchecked: true, ...(c.verified ? {} : { unverified: true }) }));
        if (trace.tamper) entry.tamper = scrubSecrets(trace.tamper);
        entry.action = actionSummary(action, trace.payload);
      }
      recordGuardCall(root, entry);
    }
    return done();
  };

  if (mem.text === null) {
    trace.route = "error";
    return finish([]);
  }
  let rules: LoadedRules;
  try {
    rules = loadRules(root, cfg, mem.text);
  } catch (err) {
    const e = `could not load the rules: ${err instanceof Error ? err.message : String(err)}`;
    trace.notes.push(e);
    logGuard(root, log, { ok: false, error: e });
    trace.route = "error";
    return finish([]);
  }
  trace.rules = rules;
  if (!rules.enforced.length) {
    if (!trace.tamper) trace.notes.push("no enforced rules");
    trace.route = "no-rules";
    return finish([]);
  }

  const readFile = (file: string): string | null => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  // A commit message is read from a file (`git commit -F <file>`) only when a rule about commit messages could use it.
  const features = part("the prefilter", () => actionFeatures(action, root, { cwd, home: env.HOME, ...(rules.enforced.some((r) => r.features.messageRule) ? { readFile } : {}) }), null);
  if (features === null) {
    // Nothing to match the rules against: the tamper check alone decides, and the call is logged as an error.
    trace.route = "error";
    return finish([]);
  }
  // `git add .`, `git add -A`, `git commit -a`: what they would stage or commit, when a rule about committing names a path.
  if (action.tool === "Bash" && rules.enforced.some(ruleNamesCommittedFiles)) {
    const ex = part("the git expansion", () => expandGitStaging(action.command ?? "", { cwd, root, budgetMs: Math.min(GIT_BUDGET_MS, Math.floor(cfg.guard.budgetMs / 4)), home: env.HOME }), null);
    if (ex !== null && ex.commands.length) {
      trace.staged = ex;
      for (const n of ex.notes) trace.notes.push(`git: ${n}`);
      if (ex.files.length) features.staged = ex.files.map((f) => f.path);
    }
  }
  const candidates = part("the prefilter", () => matchRules(rules.enforced, features, { ...DEFAULT_MATCH, max: cfg.guard.maxCandidates, ...deps.match }), null);
  if (candidates === null) {
    trace.route = "error";
    return finish([]);
  }
  trace.candidates = candidates;
  if (!candidates.length) {
    if (!trace.tamper) trace.notes.push("no candidate: the call shares nothing with any rule, so nothing is sent to Jev");
    trace.route = "no-candidate";
    return finish([]);
  }

  const named = new Set(candidates.flatMap((c) => c.staged ?? []));
  const stages = (trace.staged?.files ?? []).filter((f) => named.has(f.path)).map(stagedLabel);
  // The commit message goes with the call only when a candidate rule is about commit messages.
  const payload = callPayload(action, candidates.flatMap((c) => c.terms), stages, candidates.some((c) => c.rule.features.messageRule) ? features.message : undefined);
  trace.payload = payload;
  const hash = payloadHash(payload);
  const answers = deps.noCache ? {} : readAnswers(root);
  const checks: RuleCheck[] = candidates.map((c) => {
    const hit = answers[answerKey(c.rule, hash)];
    return { id: c.rule.id, text: c.rule.text, verified: c.rule.verified === true, p: hit ? hit.p : null, cached: Boolean(hit), strong: c.strong };
  });
  const ask = candidates.filter((_, i) => checks[i]!.p === null);
  if (!ask.length) {
    trace.route = "cache";
    return finish(checks);
  }

  const remaining = cfg.guard.budgetMs - (performance.now() - t0) - 40;
  if (remaining < 150) {
    const e = `no time left for Jev (${Math.round(remaining)} ms of guard.budgetMs ${cfg.guard.budgetMs})`;
    trace.notes.push(e);
    logGuard(root, log, { ok: false, error: e });
    trace.route = "no-time";
    return finish(checks);
  }
  let jev: JevCaller | null | undefined = deps.jev;
  if (jev === undefined) jev = deps.makeJev ? await deps.makeJev(cfg, root) : null;
  if (!jev) {
    const e = "no TypeSafe API key (checked the plugin setting, env, .jevmem/.env, ~/.jevmem/env): no decision";
    trace.notes.push(e);
    logGuard(root, log, { ok: false, error: e });
    trace.route = "no-key";
    return finish(checks);
  }
  const questions: Questions = {};
  for (const c of ask) questions[breakKey(c.rule.id)] = breakNoul(c.rule.id);
  const state = { tool_call: payload, rules: ask.map((c) => ({ id: c.rule.id, rule: scrubSecrets(c.rule.text) })) };
  const tj = performance.now();
  try {
    const budget = Math.max(100, Math.floor(cfg.guard.budgetMs - (performance.now() - t0) - 40));
    let timer: NodeJS.Timeout | undefined;
    const res = await Promise.race([
      jev.call(state, questions, { label: "guard", timeoutMs: budget }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${budget} ms (guard.budgetMs)`)), budget + 25);
      }),
    ]).finally(() => clearTimeout(timer));
    trace.jevMs = Math.round(performance.now() - tj);
    const updates: Record<string, CacheEntry> = {};
    const ts = new Date().toISOString();
    for (const c of ask) {
      const a = (res.answers as Record<string, any>)[breakKey(c.rule.id)];
      const p = a && a.type === "noul" && typeof a.noul === "number" ? a.noul : null;
      const i = candidates.indexOf(c);
      checks[i] = { ...checks[i]!, p, cached: false };
      if (p !== null) updates[answerKey(c.rule, hash)] = { p, ts, rule: c.rule.id, model: res.model };
    }
    if (!deps.noCache) writeAnswers(root, updates);
    trace.route = "jev";
  } catch (err) {
    trace.route = "jev-failed";
    trace.jevMs = Math.round(performance.now() - tj);
    const e = `Jev check failed, no decision: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
    trace.notes.push(e);
    logGuard(root, log, { ok: false, error: e, latencyMs: trace.jevMs });
  }
  return finish(checks);
}

// ---------------------------------------------------------------------------------------------
// The hook entry

/** The real Jev client, created only when a call has to be asked. Null when no key is found. */
export async function defaultMakeJev(cfg: JevmemConfig, root: string): Promise<JevCaller | null> {
  applyPluginOption();
  if (!process.env.TYPESAFE_API_KEY?.trim()) loadEnvFallbacks(root);
  if (!process.env.TYPESAFE_API_KEY?.trim()) return null;
  const { createJev } = await import("./jev.js");
  return createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, timeoutMs: cfg.guard.budgetMs, cache: false, zeroDataRetention: cfg.jev.zeroDataRetention });
}

/** Does this project's `.claude/settings*.json` register jevmem's own PreToolUse hook (from `jevmem init`)? */
export function projectHasInitGuardHook(root: string): boolean {
  for (const f of ["settings.local.json", "settings.json"]) {
    let s: any;
    try {
      s = JSON.parse(fs.readFileSync(path.join(root, ".claude", f), "utf8"));
    } catch {
      continue;
    }
    const list = s?.hooks?.PreToolUse;
    if (!Array.isArray(list)) continue;
    for (const g of list) for (const h of Array.isArray(g?.hooks) ? g.hooks : []) if (isJevmemHookCommand(h) && !/--plugin\b/.test(String(h.command))) return true;
  }
  return false;
}

function debugTrace(root: string, raw: string, trace: GuardTrace, env: NodeJS.ProcessEnv): void {
  if (env.JEVMEM_DEBUG !== "1") return;
  try {
    const file = path.join(root, ".jevmem", "hook-debug.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, guard: { decision: trace.decision, candidates: trace.candidates.map((c) => c.rule.id), notes: trace.notes, totalMs: trace.totalMs }, payload: raw.slice(0, 4000) }) + "\n");
  } catch {
    /* best effort */
  }
}

/**
 * The PreToolUse hook: `raw` is the hook's stdin. Returns what to print: "" or one JSON object. Never throws.
 * `viaPlugin`: run from the Claude Code plugin, which stands down when `jevmem init` registered its own guard hook.
 */
export async function runGuardHook(raw: string, opts: { viaPlugin?: boolean; env?: NodeJS.ProcessEnv; deps?: GuardDeps } = {}): Promise<string> {
  const env = opts.env ?? process.env;
  let root = env.CLAUDE_PROJECT_DIR && fs.existsSync(env.CLAUDE_PROJECT_DIR) ? env.CLAUDE_PROJECT_DIR : process.cwd();
  const enabled = () => fs.existsSync(path.join(root, CONFIG_FILE));
  let input: GuardInput | null = null;
  try {
    try {
      input = JSON.parse(raw);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("not a JSON object");
    } catch (err) {
      input = null;
      if (enabled()) logGuard(root, true, { ok: false, error: `PreToolUse input is not valid JSON (${err instanceof Error ? err.message : String(err)})` });
      return "";
    }
    root = guardRoot(input, env);
    if (!enabled()) return "";
    if (opts.viaPlugin && projectHasInitGuardHook(root)) return "";
    const trace = await evaluateGuard(input, { makeJev: defaultMakeJev, env, root, ...opts.deps });
    debugTrace(root, raw, trace, env);
    return trace.stdout;
  } catch (err) {
    // Nothing above should throw; if something does, the call ran unchecked: say so in both logs.
    try {
      if (enabled()) {
        const e = `guard: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
        logGuard(root, true, { ok: false, error: e });
        if (input && GUARDED_TOOLS.includes(input.tool_name as GuardTool)) recordGuardCall(root, { ts: new Date().toISOString(), tool: input.tool_name!, route: "error", decision: "none", error: shorten(scrubSecrets(e), 200) });
      }
    } catch {
      /* nothing left to do: stay silent */
    }
    return "";
  }
}

// ---------------------------------------------------------------------------------------------
// Off the hot path: gate verdicts for rules that have none

/**
 * Ask the poisoning gate about live `[constraint]` lines that are unverified and have no cached verdict, so the guard
 * can enforce them. Run after the Stop drain (daemon or inline), never from the PreToolUse hook. Returns how many
 * lines were checked.
 */
export async function gatePendingRules(root: string, cfg: JevmemConfig, jev: JevCaller, memories: Memory[]): Promise<number> {
  const constraints = memories.filter((m) => m.kind === "constraint" && !m.supersededBy);
  if (!constraints.length) return 0;
  const plan = planGate(root, constraints, cfg.thresholds.injectionMax);
  if (!plan.check.length) return 0;
  const { scores, model } = await gateLines(jev, plan.check, { timeoutMs: cfg.jev.timeoutMs, label: "gate" });
  settleGate(root, plan.check, scores, cfg.thresholds.injectionMax, model, "guard (after Stop)");
  return plan.check.length;
}

// ---------------------------------------------------------------------------------------------
// `jevmem guard test`

/** The trace as `jevmem guard test` prints it. */
export function formatGuardTrace(t: GuardTrace): string {
  const out: string[] = [];
  const a = t.action;
  out.push(`jevmem guard test: ${a ? (a.tool === "Bash" ? `Bash \`${a.command}\`` : `${a.tool} ${a.file}`) : (t.tool ?? "no call")}`);
  if (t.mode) out.push(`mode       ${t.mode}${t.thresholds && t.mode !== "off" ? ` (acts at p ≥ ${t.thresholds.askMin.toFixed(2)}${t.mode === "block" ? `, denies at p ≥ ${t.thresholds.blockMin.toFixed(2)} for a verified rule` : ""})` : ""}`);
  if (t.rules) {
    out.push(`rules      ${t.rules.enforced.length} loaded, ${t.rules.skipped.length} skipped`);
    for (const r of t.rules.enforced) out.push(`  loaded   ${r.id}  ${r.text}${r.verified ? "" : "  (unverified: asked about, not denied)"}`);
    for (const r of t.rules.skipped) out.push(`  skipped  ${r.id}  ${r.text}\n             ${r.reason}`);
  }
  out.push(`tamper     ${t.tamper ?? "none"}`);
  if (t.staged) {
    const files = t.staged.files;
    const list = files.slice(0, 8).map(stagedLabel).join(", ") + (files.length > 8 ? `, and ${files.length - 8} more` : "");
    out.push(`git        ${files.length ? `${files.length} file(s) it would stage or commit: ${list}` : "no file it would stage or commit found"} (${t.staged.ms} ms)`);
  }
  if (t.rules && t.rules.enforced.length) {
    out.push(`prefilter  ${t.candidates.length ? `${t.candidates.length} candidate rule(s)` : "no candidate: the call shares no path, filename, command word or keyword with any rule; nothing is sent to Jev"}`);
    for (const c of t.candidates) out.push(`  ${c.rule.id}  score ${c.score}: ${c.reasons.join("; ")}`);
  }
  if (t.payload) out.push(`sent       ${JSON.stringify(t.payload)}`);
  for (const c of t.checks) {
    const late = c.p === null && c.strong && (t.route === "jev-failed" || t.route === "no-time");
    const verdict = c.p === null ? (late ? "no answer in time; matched on more than keywords, so the call is asked about" : "no answer") : `p=${c.p.toFixed(2)} ${t.thresholds && c.p >= t.thresholds.askMin ? "≥" : "<"} ${t.thresholds?.askMin.toFixed(2)}`;
    out.push(`jev        ${c.id}  ${verdict}${c.cached ? " (cached answer)" : c.p !== null && t.jevMs !== null ? ` (asked now, ${t.jevMs} ms)` : ""}`);
  }
  for (const e of t.errors) out.push(`error      ${e} (logged; the other parts of the check still ran)`);
  for (const n of t.notes) if (!t.errors.includes(n)) out.push(`note       ${n}`);
  out.push(`decision   ${t.decision}`);
  out.push(`output     ${t.stdout || "(none: exit 0 with no output, so Claude Code's normal permission flow applies)"}`);
  return out.join("\n");
}
