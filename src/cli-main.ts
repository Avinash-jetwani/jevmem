import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { applyAudit, auditMemories, formatAuditTable, formatSecurityTable, securityAudit } from "./audit.js";
import { knownWithheld, planGate } from "./guard.js";
import { formatFailures, isNoKey, recentFailures } from "./failures.js";
import { formatGuardLog, formatGuardStats, guardLogStats, readGuardLog } from "./guardlog.js";
import { checkCli, initHookClis, pluginLauncherCli } from "./hookcli.js";
import { isVerified, readProvenance, verifiedVia } from "./provenance.js";
import { gateForAlways, trustLines } from "./trust.js";
import { configuredWriter, isEnabled, loadConfig, NOT_ENABLED_MESSAGE } from "./config.js";
import { PACKAGE_VERSION } from "./version.js";
import { DAEMON_VERSION, daemonEnabled, daemonRequest, jevFingerprint, pidFile, serveDaemon, spawnDaemon } from "./daemon.js";
import { deferredTurns } from "./turns.js";
import { captureTurns, drainTurns, recallPathStats, hookEvent, hookRoot, logHookProblem, parseHookInput, readStdinJson, runHook, sessionStartOutcome, wasServed, type HookInput, type HookOutcome } from "./hook.js";
import { applySessionImport, findSessionFiles, formatSessionImport, importSessions, parseSince } from "./sessions.js";
import { checkJevKey, markSetupDone, SETUP_NEEDS_TERMINAL } from "./setup.js";
import { ALWAYS_KINDS, decide } from "./decide.js";
import { defaultMakeJev, evaluateGuard, formatGuardTrace, loadRules, projectHasInitGuardHook, readGuardConfig, runGuardHook, type GuardInput } from "./guardrail.js";
import { applyPluginOption, cleanPastedKey, hasSavedJevKey, loadEnvFallbacks, missingKeyHelp, PLUGIN_CONFIGURE_HINT, resolveJevKey, saveJevKey } from "./env.js";
import { canConfigure, describeInstall, hasActivePlugin, pluginInstalls, runningPlugin } from "./install.js";
import { clampLine, isReasoningModel, resolveWriter } from "./llm/index.js";
import { firstLineNotice, keyFound, missingKeyNotice, writerOptInNotice } from "./notice.js";
import { collectCandidates, DEFAULT_IMPORT_SOURCES, formatImport, IMPORT_SOURCES, runImport, type ImportSource } from "./import.js";
import { disableProject, enableProject, init, projectHasInitHooks, unregisterClaudeHooks } from "./init.js";
import { findDecision, formatFit, formatWhy, labelMissed, labelRight, labelWrong, MIN_LABELS, readFitInfo, readLabels, runFit } from "./labels.js";
import { TOOLS, detectTools, setupClaudeDesktop, setupCodex, setupCursor, type Tool, unregisterCursorFiles } from "./tools.js";
import { CURSOR_HOOK_EVENTS, cursorHooksStatus, cursorTurnFromInput, dropStash, isCursorPayload, readCursorPluginMarker, stashPrompt, stashResponse, unregisterCursorHooks } from "./cursor.js";
import { markDecided } from "./turns.js";
import { watchCodex } from "./watch.js";
import { mergeTurn } from "./transcript.js";
import { appendLog, createJev, hasJevKey, readLog, summarizeLog } from "./jev.js";
import { serveMcp } from "./mcp.js";
import { enqueueTurn, queueStats } from "./queue.js";
import { alwaysOnServed, rankGuarded } from "./recall.js";
import { scrubSecrets } from "./scrub.js";
import { MemoryStore } from "./store.js";
import { DEFAULT_CONFIG, NEW_KINDS, type Kind } from "./types.js";

const HELP = `jevmem — Automatic project memory for Claude Code and Cursor. Also works with Codex and Claude Desktop over MCP.

Usage: jevmem <command> [options]

  init [--tool claude|cursor|codex|claude-desktop|all] [--no-hooks] [--files] [--command "<cmd>"]
                                          Create JEVMEM.md, jevmem.config.json, .jevmem/ and set up the tool(s) (default: detect)
  init --remove-hooks                     Remove jevmem's Claude Code hooks and Cursor hooks from this project (e.g. when using the plugin)
  enable                                  Opt this project in (plugin users): jevmem.config.json, JEVMEM.md, .jevmem/
  setup                                   Finish the setup here: the CLI and the plugin, your TypeSafe key (asked for, not shown), jevmem turned on in this folder, doctor; terminal only
  disable                                 Opt this project out: jevmem does nothing here (JEVMEM.md is kept)
  <command> --help                        Help for one command
  hook                                    Claude Code hook entrypoint (reads the hook JSON from stdin)
  daemon [status|start|stop]              Warm Jev client for the hook (auto-started by the hook; exits when idle)
  mcp [--root <dir>]                      Start the stdio MCP server (search_memory, add_memory, list_memory, audit_memory)
  audit [--dry-run]                       Re-score every memory against the repo and flag [stale?] lines
  audit --security [--ci]                 List lines that read as instructions to an AI (--ci: exit 1 if any)
  guard test "<command>" | --edit <path>  Dry run of the PreToolUse guard on a call: rules, prefilter, Jev's answer, hook output
  guard log [-n 20]                       The guard's recent asks and denials in this project, with the rule and score
  search <query> [--limit N]              Rank memories by relevance to a query (one Jev call)
  list [--all]                            Print memories (live by default; --all adds superseded lines and provenance)
  add [--trust] [--always] <kind> <text>  Append a memory line by hand (kinds: ${NEW_KINDS.join(", ")}); --trust marks it verified (asks on a terminal); --always sends it to Claude in every session
  always [--off] <id> [<id>…]             Mark a line always-on (sent to Claude at the start of every session), or take the mark off
  always --suggest [--apply]              Ask Jev which live lines are rules for every change and propose the marks (--apply sets them)
  trust <id> [<id>…]                      Mark a line you wrote as verified, after the poisoning gate (asks on a terminal); the guard can then block on it
  import [--from <sources>] [--apply]     Import CLAUDE.md, AGENTS.md, .cursor/rules/* (dry run unless --apply); --from sessions reads this project's past Claude Code sessions (asks before anything is sent)
  watch [--replay] [--once]               Capture turns from Codex's session log for this project (Cursor saves through its hooks since 0.7.4)
  why <id|hash>                           Show every Jev answer behind a memory line or a skipped turn
  right <id|hash>                         Label the decision as correct
  wrong <id|hash> [--should-be <kind|none>] Label the decision as wrong (--should-be none retires the line)
  forget <id> [<id>…]                     Retire a line: it stays in JEVMEM.md as [retired]; a rule asks for a yes on a terminal
  missed "<text>"  [--kind <kind>]        Label a turn that should have been saved
  fit [--dry-run] [--force]               Refit weights and thresholds from labels (needs ${MIN_LABELS}+ labels)
  stats                                   Writer, latency p50/p95, cost per day, cache hit rate, escalation rate, retry queue, labels, last fit
  doctor                                  Is this project enabled, where the TypeSafe key comes from, which writer is active and why
  key                                     Save your TypeSafe API key to ~/.jevmem/env (asks for it without showing it)
  log                                     Summarise .jevmem/log.jsonl (Jev latency and cost)

Env: TYPESAFE_API_KEY (required for Jev; or put it in ~/.jevmem/env), OPENAI_API_KEY / ANTHROPIC_API_KEY (used only
     when jevmem.config.json sets "writer": "openai" or "anthropic"), JEVMEM_WRITER=none (turns the LLM writer off),
     JEVMEM_WRITER_MODEL, JEVMEM_VERBOSE=1, JEVMEM_DAEMON=0|1,
     JEVMEM_CACHE=0, JEVMEM_DEBUG=1, TYPESAFE_BASE_URL, JEVMEM_ROOT (MCP project root)
`;

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}
function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  cwd?: string;
}
const stdoutWrite = (s: string) => void process.stdout.write(s);
const stderrWrite = (s: string) => void process.stderr.write(s);
const defaultIo: CliIo = { out: stdoutWrite, err: stderrWrite };
let io: CliIo = defaultIo;

export const COMMANDS = ["enable", "setup", "disable", "init", "hook", "daemon", "mcp", "audit", "guard", "search", "list", "add", "always", "import", "why", "right", "wrong", "forget", "trust", "missed", "fit", "stats", "doctor", "key", "log", "watch"] as const;

export const COMMAND_HELP: Record<(typeof COMMANDS)[number], string> = {
  enable: `jevmem enable

Opt this project in. jevmem (the Claude Code plugin's hooks and MCP server, or any jevmem hook) does nothing in a
project without jevmem.config.json: no network calls, no files. enable creates jevmem.config.json, JEVMEM.md and
.jevmem/, and adds .jevmem/ to .gitignore, like init, but registers no hooks. Commit jevmem.config.json and JEVMEM.md.
`,
  setup: `jevmem setup

Finish the setup in this folder, in one go, on a terminal (it asks for your key): says which jevmem and which Claude Code
plugin it found; asks for your TypeSafe API key without showing it and saves it to ~/.jevmem/env as jevmem key does (a
key already in place is kept); turns jevmem on here as jevmem enable does; checks the key with one request to TypeSafe
(the fixed words "jevmem setup: key check", nothing from the project; PRIVACY.md); runs jevmem doctor; says what is
next; and, when this project has past Claude Code sessions, offers jevmem import --from sessions: the count and the
cost first, the lines before anything is written, each after a yes. It also ends the plugin's one-time setup message
on this machine (~/.jevmem/setup-notice). Without a terminal it prints the steps by hand and exits 1.
`,
  disable: `jevmem disable

Opt this project out: moves jevmem.config.json to .jevmem/jevmem.config.json.disabled (jevmem enable restores it) and
stops the daemon. From then on jevmem's hooks and MCP server do nothing here. JEVMEM.md is left untouched.
`,
  init: `jevmem init [--tool claude|cursor|codex|claude-desktop|all] [--no-hooks] [--files] [--command "<cmd>"]

Create JEVMEM.md, jevmem.config.json and .jevmem/ in the current directory and set up the chosen tool(s).
  --tool <list>     Comma-separated; default: detect from .claude/, .cursor/, AGENTS.md in this project (else claude).
                    ~/.codex/config.toml is edited only with an explicit --tool codex or --tool all.
  --no-hooks        Skip the Claude Code hook registration
  --command "<cmd>" Register this hook command instead of the resolved absolute node + cli.js path
Claude Code hooks go to .claude/settings.local.json (machine-specific paths); init adds it to .gitignore.
Re-running init repairs an existing jevmem hook command and moves one found in .claude/settings.json.
  --remove-hooks    Only remove jevmem's hooks from .claude/settings.local.json and .claude/settings.json (for
                    projects that use the jevmem Claude Code plugin instead) and from .cursor/hooks.json, with its
                    launcher .cursor/hooks/jevmem-hook.sh; with the jevmem plugin for Cursor on this computer
                    (0.7.6), also jevmem's unchanged rule file and its MCP entry, which the plugin carries. Nothing
                    else is touched.
Cursor (--tool cursor, since 0.7.4): .cursor/hooks.json gets jevmem's hooks with relative commands and .cursor/hooks/
jevmem-hook.sh the launcher they run (no path of this machine, so both can be committed), beside .cursor/mcp.json and
the rule; each finished agent turn is then saved as in Claude Code, and the agent reads memory over MCP. With the
jevmem plugin for Cursor installed on this computer (0.7.6), init only turns the project on and writes no Cursor file,
since the plugin saves each turn, serves memory and carries the rule in every window; --files writes them anyway (a
teammate without the plugin), and the plugin stands down beside them.
With the Claude Code plugin installed you do not need init: the plugin's hooks and MCP server work in every project.
If a project has both, the plugin's hooks stand down and say so once per session.
`,
  hook: `jevmem hook

Claude Code hook entrypoint. Reads the hook event JSON (Stop, UserPromptSubmit or PreToolUse) from stdin and exits 0 on
any failure; other events do nothing. Registered by \`jevmem init\`; not meant to be run by hand. JEVMEM_VERBOSE=1 prints
a summary for Stop and UserPromptSubmit, JEVMEM_DEBUG=1 logs payloads. PreToolUse (the guard) prints nothing but its
decision.
`,
  guard: `jevmem guard test "<command>"
jevmem guard test --edit <path> [--old "<text>"] [--content "<new text>"]
jevmem guard test --write <path> [--content "<text>"]
jevmem guard log [-n 20]

test  Dry run of the PreToolUse guard on one Bash, Edit or Write call: the rules it enforces (live [constraint] lines
      that passed the poisoning gate) and the ones it skips (superseded, or no gate verdict yet), which rules the
      prefilter matched and why, Jev's answer and score for each, the tamper check, and the exact output the hook would
      print. Uses and fills the hook's answer cache (.jevmem/guard-cache.json); --no-cache asks Jev without reading or
      writing it. Nothing is logged.
log   The hook's most recent asks, denials and warnings in this project, newest first (default 20): the time, the
      tool, a short scrubbed summary of the command or edit, and each rule with Jev's score, or the tamper check's
      reason. Read from .jevmem/guard-log.jsonl, which stays on this machine; \`jevmem stats\` counts it.
The mode and thresholds come from "guard" in jevmem.config.json (docs/guardrails.md).
`,
  daemon: `jevmem daemon [status|start|stop]

Warm Jev client used by the hook. Auto-started by the first hook call; exits after 30 minutes of inactivity (daemon.idleMinutes).
  status   Show pid, uptime and requests served (default)
  start    Start it detached
  stop     Ask it to exit
`,
  mcp: `jevmem mcp [--root <dir>]

Start the stdio MCP server exposing search_memory, add_memory, list_memory and audit_memory for the current directory,
or for --root <dir> (or JEVMEM_ROOT) when the client has no project working directory (Claude Desktop).
add_memory scrubs secrets and asks Jev first; it refuses injection, small talk and duplicates with a reason.
`,
  audit: `jevmem audit [--dry-run]
jevmem audit --security [--ci]

Re-score every live memory against a snapshot of the repository ("is this still true?") and flag lines under
thresholds.staleBelow as [stale?]. --dry-run prints the table without writing. Also lists lines the poisoning gate
has withheld from recall.
  --security  Ask the poisoning gate about every live line, verified or not: does it contain instructions aimed at an
              AI assistant or automated system? Lines at or above thresholds.injectionMax, or with hidden text, are
              listed as SUSPICIOUS. Writes nothing to JEVMEM.md.
  --ci        With --security: exit 1 when any line is suspicious, 2 when the check cannot run (no key). For CI.
`,
  search: `jevmem search <query> [--limit N]

Rank memories by relevance to the query with one Jev call (choice over ids + a noul per candidate). Default limit 10.
`,
  list: `jevmem list [--all]

Print live memories (id, kind, text). --all includes superseded and retired lines and shows each line's provenance:
verified (jevmem wrote this exact text on this machine) or unverified (hand-written, from git, or jevmem add),
and whether the poisoning gate withheld it.
`,
  add: `jevmem add [--trust] <kind> <text>

Append one memory line by hand. kind: decision | constraint | preference | bug | architecture | todo | dead-end.
Secrets are scrubbed, a leading [kind] or [rule] tag is dropped, and a line longer than the limit loses its trailing
clauses. There is no Jev call and no key is needed, for any kind (you typed it). For a dead end, say what was tried and
why it failed or was dropped (docs/dead-ends.md). Like a hand edit, the line is unverified: the poisoning gate checks it
before it is served, and the guard asks about a rule from it but never blocks. --trust (0.7.0) then runs jevmem trust on
the new line: it needs a terminal, shows the line, asks, and marks it verified once the gate has passed it.
`,
  trust: `jevmem trust <memory id> [<memory id>…]

Mark a line you wrote as verified, as if jevmem had written it here: recall serves it without the poisoning gate's
question, and in block mode the guard can block on a [constraint] from it instead of only asking (docs/guardrails.md).
It needs a terminal, with no flag to skip that: it prints the line and asks "Trust this line? [y/N]", then asks the
poisoning gate about the line (one Jev call) and refuses one that reads as instructions aimed at an AI, with the reason.
The record is local (.jevmem/provenance.jsonl, not in git), so a clone trusts nothing by it; a line whose text changes
afterwards is unverified again. The guard's tamper check asks about an agent running this command.
`,
  always: `jevmem always [--off] <memory id> [<memory id>…]
jevmem always --suggest [--apply]

Mark a line always-on: it goes into Claude's context at the start of every session in this project (a SessionStart
hook, read from JEVMEM.md with no request; with a session's first prompt when that hook did not run), so a change that
nothing in the prompt connects to the rule still follows it. For rules and conventions every change must follow (how
code is logged, tested, named, committed; a helper every call goes through; a file never edited by hand), not for
facts about one part of the system, which recall brings back when a task touches them. jevmem marks such lines on its
own when it saves them (thresholds.alwaysMin); this is the hand switch. --off takes the mark off. The line's text and
kind do not change. --suggest asks Jev the same question about every live constraint, preference, decision and
architecture line not yet marked (one request per line, the line's text sent as recall sends it) and prints the ones
at the threshold; --apply marks them. For a file from before 0.7.1.
`,
  import: `jevmem import [--from claude-md,agents-md,cursor-rules,claude-auto-memory,sessions] [--since 30d] [--apply] [--memory-dir <dir>]

Read existing instruction and memory files, split them into statements (list items and prose sentences; headings,
code, tables and jevmem's own sections are skipped), and put each through the same gate as a turn: scrub, Jev decide,
dedupe against live lines. Accepted statements also pass the memory-poisoning gate. Prints what would be added, with
the kind; nothing is written without --apply. The source files are only read, never changed.
  --from <list>       Default: claude-md,agents-md,cursor-rules (CLAUDE.md or .claude/CLAUDE.md, AGENTS.md, .cursor/rules/*).
                      claude-auto-memory reads Claude Code's auto memory for this project, which lives in your home
                      directory, so it is only read when named: autoMemoryDirectory from the settings, else
                      ~/.claude/projects/<project>/memory/ (<project> from the git repository root).
  --memory-dir <dir>  Read auto memory from this directory instead.
  --apply             Write the accepted lines (verified: jevmem wrote them here).
Costs one Jev call per statement (two on borderline ones), plus one gate call per 60 accepted statements.

--from sessions (0.7.1) reads this project's past Claude Code sessions, so memory starts full: the session files Claude
Code keeps under ~/.claude/projects/<project>/ (CLAUDE_CONFIG_DIR when set), read with the same reader the Stop hook uses
(a prompt you typed and the main agent's reply; subagent transcripts, task notifications, tool results and commands are
skipped), oldest first, so a later change supersedes an earlier line. It needs a terminal: first it counts the sessions
and turns and estimates the cost, with nothing sent, and asks [y/N]; only then is each turn decided as a finished turn
is. --since 30d (or 12h, 2w, or a date) reads only sessions written since then.
`,
  why: `jevmem why <memory id | turn hash>

Show every Jev answer behind a saved line or a skipped turn: tier 1 nouls, tier 2 nouls and family scores if it ran,
the kind distribution, importance, content source, and which thresholds were cleared.
`,
  right: `jevmem right <memory id | turn hash>

Label the decision as correct. Appends to .jevmem/labels.jsonl for \`jevmem fit\`.
`,
  wrong: `jevmem wrong <memory id | turn hash> [--should-be <kind|none>]

Label the decision as wrong. Default: the opposite of what happened. --should-be none retires the saved line, as
\`jevmem forget\` does (since 0.7.0; up to 0.6.6 it deleted the line).
`,
  forget: `jevmem forget <memory id> [<memory id>…]

Retire a line: a done to-do, a fixed bug, an obsolete rule, a wrong or hand-added line. The line stays in JEVMEM.md as
[retired] with its text unchanged (and the kind it had in the comment), so git history and \`jevmem list --all\` keep the
record; recall no longer serves it, the guard no longer enforces it, search, the MCP tools and decide no longer see it.
A [constraint] line is printed first and retired only after a yes on a terminal; there is no flag to skip that. A line
said again later is saved anew. No Jev call and no key needed. Older jevmem versions keep a [retired] line as text.
`,
  missed: `jevmem missed "<text>" [--kind <kind>]

Label a turn that should have been saved but wasn't; runs decide on it, records the answers, and adds the line.
`,
  fit: `jevmem fit [--dry-run] [--force]

Refit family weights and thresholds from .jevmem/labels.jsonl (needs 40+ labels; --force to run with fewer).
Writes to jevmem.config.json and prints a reliability table. --dry-run only prints.
`,
  stats: `jevmem stats

The active one-line writer and why, latency p50/p95, cost per day, cache hit rate, tier-1/tier-2 counts and escalation rate, labels and last fit.
Retry queue: turns queued after a Jev failure (timeout, 5xx, 529), retries, turns saved from the queue, turns dropped
(older than 24 h or past 200 entries), and turns pending in .jevmem/queue.jsonl.
Guard (from .jevmem/guard-log.jsonl): Bash, Edit and Write calls the PreToolUse hook checked, how many took the fast
path (no candidate rule, nothing sent), were answered from the cache or were sent to Jev, and how many were asked
(tamper asks among them), denied or warned.
Failures in the last 7 days (from .jevmem/log.jsonl, no network): turns dropped without being evaluated, recall
requests that failed (the prompt got no project memory), and guard checks that failed or timed out (the call ran
unchecked), each with its reasons.
`,
  doctor: `jevmem doctor

Checks this project's setup and prints it. Never prints a key.
  project   enabled (jevmem.config.json present) or not
  key       where the TypeSafe key comes from: the plugin setting, the environment, <project>/.jevmem/.env or
            ~/.jevmem/env, and where to put it when none is found
  writer    which one-line writer is active and why. The LLM writer runs only when jevmem.config.json sets
            "writer": "openai" or "anthropic" and that provider's key is set; otherwise jevmem writes the line itself
  hooks     the jevmem plugin: synced from claude.ai (added in the Claude app, jevmem@synced) or installed from a
            marketplace and enabled in the project or user settings; and hooks registered by \`jevmem init\`
  guard     the PreToolUse guard's mode and how many [constraint] rules it enforces (docs/guardrails.md)
  cli       the jevmem each hook runs (the path \`jevmem init\` registered, or the \`jevmem\` the plugin finds with this
            PATH), its version, whether it has the guard (asked \`guard --help\` from /, as the plugin does), and
            whether the jevmem and Node a hook names still exist. A jevmem too old for the guard makes the plugin skip
            its PreToolUse hook, and under a PreToolUse hook from \`jevmem init\` it would read every Bash, Edit and
            Write call as a finished turn
  failures  from .jevmem/log.jsonl, the last 7 days: turns dropped without being evaluated, recall requests that
            failed, and guard checks that failed or timed out, each with its reasons (the same as \`jevmem stats\`)
`,
  key: `jevmem key

Save your TypeSafe API key to ~/.jevmem/env, where jevmem's hooks, MCP server and commands look when their environment
has no key. It asks for the key without showing it, or reads it from stdin (jevmem key < file). When the file already
has a key, it asks before replacing it, which needs a terminal; other lines are kept. The folder is readable only by
you (700) and so is the file (600). The key is never printed or logged. This works for every install: the plugin added
in the Claude app (jevmem@synced), one installed from a marketplace, and the hooks \`jevmem init\` registers.
`,
  log: `jevmem log

Per-label summary of .jevmem/log.jsonl (calls, latency, tokens, cost).
`,
  watch: `jevmem watch [--replay] [--once] [--tool codex]

Tail Codex's session rollouts for this project and run decide → write on every completed turn.
  --replay   Also process what is already on disk from the last 24 h
  --once     One pass, then exit
`,
};

function wantsHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/** A terminal stand-in for tests: answers the prompts `readLine` would put to the user (the key, a yes or no). */
export interface TerminalIo {
  ask: (prompt: string, opts: { hidden?: boolean }) => Promise<string>;
}
let termIo: TerminalIo | null = null;

export async function main(argv: string[], ioArg: CliIo = defaultIo, opts: { stdin?: string; terminal?: TerminalIo } = {}): Promise<number> {
  io = ioArg;
  termIo = opts.terminal ?? null;
  applyPluginOption(); // the Claude Code plugin's typesafe_api_key option comes first
  const args = [...argv];
  const cmd = args.shift();
  const root = io.cwd ?? process.cwd();
  // `<cmd> --help` / `-h`: print that command's help and stop before anything runs.
  if (cmd && (COMMANDS as readonly string[]).includes(cmd) && wantsHelp(args)) {
    io.out(COMMAND_HELP[cmd as (typeof COMMANDS)[number]]);
    // The plugin's key setting, only where it exists: a jevmem plugin installed from a marketplace (src/install.ts).
    if (cmd === "key" && canConfigure(pluginInstalls(root))) io.out(PLUGIN_CONFIGURE_HINT + "\n");
    return 0;
  }

  // Projects set up before 0.5.4 may have relied on the LLM writer turning itself on: say once that it is opt-in now.
  if (cmd && !["hook", "mcp", "daemon", "help", "version", "--version", "-v", "--help", "-h"].includes(cmd) && isEnabled(root)) {
    const env = { ...process.env }; // a copy: `doctor` reports where each key really came from
    loadEnvFallbacks(root, env);
    const notice = writerOptInNotice(root, env);
    if (notice) io.err(notice + "\n");
  }

  switch (cmd) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      io.out(HELP);
      return 0;
    case "-v":
    case "--version":
    case "version": {
      const pj = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      io.out(pj.version + "\n");
      return 0;
    }
    case "enable": {
      const r = enableProject(root);
      for (const c of r.created) io.out(`  created  ${c}\n`);
      for (const u of r.updated) io.out(`  updated  ${u}\n`);
      for (const k of r.skipped) io.out(`  kept     ${k}\n`);
      io.out(`\njevmem is enabled in this project.\n${enableNextStep(root)}\n`);
      return 0;
    }
    case "setup": {
      // 0.7.2: finish the setup in this folder, on a terminal only (it asks for the key).
      if (!isTerminal(opts)) return fail(SETUP_NEEDS_TERMINAL);
      let self = process.argv[1] ?? "jevmem";
      try {
        self = fs.realpathSync(self);
      } catch {
        /* as given */
      }
      io.out(`jevmem ${PACKAGE_VERSION} (${self})\n`);
      const installs = pluginInstalls(root);
      if (installs.length) for (const i of installs) io.out(`Claude Code plugin: ${describeInstall(i)}\n`);
      else io.out("Claude Code plugin: none found (checked the plugins synced from claude.ai and the user and project settings). Add it in the Claude app (Plugins → Discover → jevmem → Add), or run jevmem init --tool claude for hooks without the plugin.\n");
      for (const i of installs) if (i.version && isOlder(PACKAGE_VERSION, i.version)) io.out(`The plugin is ${i.version} and this CLI ${PACKAGE_VERSION}: npm install -g jevmem@latest\n`);
      // The key: found, or asked for without showing it and saved as `jevmem key` saves it.
      const source = resolveJevKey(root);
      if (source) io.out(`TypeSafe API key: found (${source})\n`);
      else {
        io.out("TypeSafe API key: none found. Get one at https://console.typesafe.ai/keys\n");
        const raw = await readLine("TypeSafe API key (input hidden): ", { hidden: true });
        const key = cleanPastedKey(raw);
        if (!key) return fail("jevmem setup: no usable key read, so nothing was changed. Paste your TypeSafe API key (from https://console.typesafe.ai/keys) and press Enter; a key with spaces, quotes, #, $ or a backslash can't go in ~/.jevmem/env this way. Run jevmem setup again.");
        const file = saveJevKey(key);
        process.env.TYPESAFE_API_KEY = key;
        io.out(`Saved your TypeSafe API key to ${file.replace(os.homedir(), "~")} (readable only by you).\n`);
      }
      // Turn this folder on, as `jevmem enable` does.
      const r = enableProject(root);
      for (const c of r.created) io.out(`  created  ${c}\n`);
      for (const u of r.updated) io.out(`  updated  ${u}\n`);
      for (const k of r.skipped) io.out(`  kept     ${k}\n`);
      io.out(r.created.length || r.restored ? "jevmem is turned on in this project.\n" : "jevmem was already turned on in this project.\n");
      if (projectHasInitHooks(root) && hasActivePlugin(installs)) io.out("This project also has the hooks jevmem init registered, so the plugin's hooks stand down here; jevmem init --remove-hooks keeps only the plugin.\n");
      // The key check: one request with fixed words and nothing from the project (PRIVACY.md), logged under `setup`.
      const cfg = loadConfig(root);
      const jev = createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, cache: false, zeroDataRetention: cfg.jev.zeroDataRetention });
      const check = await checkJevKey(jev);
      if (check.ok) io.out(`TypeSafe accepted the key (${check.ms} ms).\n`);
      else if (check.rejected) io.out(`TypeSafe rejected the key${check.status ? ` (${check.status})` : ""}. Run jevmem key to replace it.\n`);
      else io.out(`Could not reach TypeSafe (${check.error.slice(0, 120)}): the key is saved; jevmem retries on its own.\n`);
      // Doctor, indented.
      io.out("\njevmem doctor:\n");
      const outer = io;
      await main(["doctor"], { out: (s) => outer.out(s.replace(/^(?=.)/gm, "  ")), err: outer.err, cwd: outer.cwd }, opts);
      io = outer;
      // What is next, and the marker that ends the plugin's one-time message on this machine.
      io.out("\nNext: start Claude Code in this folder (or run /reload-plugins in a session that is open), signed in with the same Claude account as the app. After each message jevmem decides what is worth keeping and saves it as one line in JEVMEM.md; on each prompt the relevant lines come back. jevmem doctor checks the setup any time.\n");
      markSetupDone();
      // Past sessions, offered: the count and the cost first, the lines before anything is written, each after a yes.
      const found = findSessionFiles(root);
      const turns = found.files.reduce((a, f) => a + f.turns.length, 0);
      if (turns) {
        const store = new MemoryStore(root, cfg.memoryFile);
        const chars = found.files.reduce((a, f) => a + f.turns.reduce((b, x) => b + Math.min(6000, x.user.length) + Math.min(2000, x.assistant.length), 0), 0);
        const est = { usd: turns * 0.00017, s: turns * 0.3 };
        const n = found.files.length;
        io.out(`\nFound ${n} past Claude Code session${n === 1 ? "" : "s"} with ${turns} turn${turns === 1 ? "" : "s"} in this project (${found.dir}). jevmem import --from sessions can read them for decisions, rules and dead ends: each turn is sent to TypeSafe (scrubbed), about ${chars.toLocaleString("en-US")} characters, an estimated ${est.usd.toFixed(3)} and ${Math.round(est.s)} s; you see the lines before anything is written.\n`);
        const yes = await confirmOnTerminal(`Send ${turns} turn${turns === 1 ? "" : "s"} from ${n} session${n === 1 ? "" : "s"} to TypeSafe? [y/N] `);
        if (!yes) io.out("Skipped. Later: jevmem import --from sessions shows what it would add, and --apply writes it.\n");
        else {
          const rows = await importSessions(jev, store, cfg, found.files, { apply: false, onProgress: (d, total) => io.err(`\rjevmem import: ${d}/${total} turns decided`) });
          io.err("\n");
          const adds = rows.filter((x) => x.outcome === "add");
          const report = formatSessionImport(rows, { apply: false, files: found.files }).split("\n");
          io.out(report.slice(0, -2).join("\n") + "\n"); // without the dry run's closing "Would add …" line
          if (!adds.length) io.out("Nothing to write.\n");
          else {
            const write = await confirmOnTerminal(`Write these ${adds.length} line${adds.length === 1 ? "" : "s"} to JEVMEM.md? [y/N] `);
            if (write) io.out(`Added ${applySessionImport(store, rows)} line(s) to JEVMEM.md; the session files were not changed. jevmem forget <id> retires a line.\n`);
            else io.out("Nothing written.\n");
          }
          printJevSummary(jev.log);
        }
      }
      return 0;
    }
    case "disable": {
      const r = disableProject(root);
      if (!r.disabled) {
        io.out("jevmem is not enabled in this project (no jevmem.config.json); nothing to do.\n");
        return 0;
      }
      await daemonRequest(root, { type: "stop" }, { connectMs: 250, responseMs: 1000 });
      io.out(`jevmem is disabled in this project: jevmem.config.json moved to ${r.backup} (\`jevmem enable\` restores it). JEVMEM.md is untouched.\n`);
      if (r.initHooks) io.out("The hooks `jevmem init` registered stay in .claude/settings.local.json but do nothing now; `jevmem init --remove-hooks` removes them.\n");
      return 0;
    }
    case "init": {
      if (flag(args, "--remove-hooks")) {
        // 0.7.6: with the Cursor plugin on this computer, jevmem's unchanged rule file and default MCP entry go too: the plugin carries both.
        const plugin = readCursorPluginMarker();
        const removed = [...unregisterClaudeHooks(root), ...unregisterCursorHooks(root), ...(plugin ? unregisterCursorFiles(root) : [])];
        io.out(removed.length ? `removed jevmem's entries from ${removed.join(", ")}\n` : "no jevmem hooks in .claude/settings.local.json, .claude/settings.json or .cursor/hooks.json\n");
        if (plugin && removed.some((f) => f === ".cursor/rules/jevmem.mdc" || f === ".cursor/mcp.json")) io.out(`The jevmem plugin for Cursor (${plugin.version}) is installed on this computer and carries the rule and the MCP server, so jevmem's rule file and MCP entry went with the hooks. Reload the Cursor window once.\n`);
        return 0;
      }
      const noHooks = flag(args, "--no-hooks");
      const cursorFiles = flag(args, "--files");
      const command = opt(args, "--command");
      const toolArg = opt(args, "--tool");
      let tools: Tool[];
      if (toolArg === "all") tools = [...TOOLS];
      else if (toolArg) {
        tools = toolArg.split(",").map((t) => t.trim()) as Tool[];
        const bad = tools.filter((t) => !(TOOLS as readonly string[]).includes(t));
        if (bad.length) return fail(`unknown tool(s): ${bad.join(", ")}. Choose from ${TOOLS.join(", ")}, all`);
      } else {
        tools = detectTools(root);
        if (tools.length === 0) tools = ["claude"];
      }
      const r = init({ root, hooks: !noHooks && tools.includes("claude"), command, cliPath: process.argv[1] });
      for (const c of r.created) io.out(`  created  ${c}\n`);
      for (const u of r.updated) io.out(`  updated  ${u}\n`);
      for (const k of r.skipped) io.out(`  kept     ${k}\n`);
      const notes: string[] = [];
      for (const t of tools) {
        const res =
          t === "cursor"
            ? setupCursor(root, { files: cursorFiles })
            : t === "codex"
              ? setupCodex(root, undefined, ({ file, backup, lines }) => io.out(`\nAbout to append to ${file} (outside this project)\n  backup: ${backup}\n  lines:\n${lines.split("\n").filter(Boolean).map((l) => "    " + l).join("\n")}\n`), Boolean(toolArg))
              : t === "claude-desktop"
                ? setupClaudeDesktop(root)
                : null;
        if (!res) continue;
        for (const c of res.created) io.out(`  created  ${c}\n`);
        for (const k of res.skipped) io.out(`  kept     ${k}\n`);
        notes.push(...res.notes);
      }
      io.out(`\nTools: ${tools.join(", ")}${toolArg ? "" : " (detected; use --tool to choose)"}\n`);
      if (tools.includes("claude") && !noHooks) io.out(`Claude Code hooks:\n  UserPromptSubmit  ${r.command}\n  Stop (async)      ${r.stopCommand}\n  PreToolUse        ${r.guardCommand}  (matcher ${r.guardMatcher})\n  SessionStart      ${r.command}\n`);
      for (const n of notes) io.out(`\n${n}\n`);
      for (const w of r.warnings) io.out(`\n! ${w}\n`);
      // `jevmem init`'s hooks have no plugin setting, so the one fix alone.
      if (!resolveJevKey(root)) io.out(`\n! ${missingKeyHelp().replace(/\n/g, "\n  ")}\n`);
      io.out(`\nNext: keep working. JEVMEM.md fills itself. Try \`jevmem list\`, \`jevmem search "<query>"\`, \`jevmem why <id>\`, \`jevmem stats\`.\n`);
      return 0;
    }
    case "hook": {
      // Everything in here is wrapped so the hook exits 0 on any failure; problems go to .jevmem/log.jsonl.
      let projectRoot = root;
      let event = "hook";
      try {
        // --stdin-file: the launcher (hooks/jevmem-hook.sh --detach) saved the hook JSON to a temp file and detached us.
        const stdinFile = opt(args, "--stdin-file");
        const viaPlugin = flag(args, "--plugin");
        const input = stdinFile ? readInputFile(stdinFile) : opts.stdin !== undefined ? parseHookInput(opts.stdin) : await readStdinJson();
        projectRoot = hookRoot(input);
        event = hookEvent(input);
        // 0.7.4: Cursor's hooks (`.cursor/hooks.json`, the launcher runs `hook --cursor`). Without the flag, a Cursor
        // payload (Cursor also runs a project's Claude Code hooks with its own event names) is ignored, as before.
        if (flag(args, "--cursor")) return await cursorHook(projectRoot, input, io, viaPlugin); // viaPlugin: flag() took --plugin out of args above
        // Opt-in per project: without jevmem.config.json, do nothing at all (no key lookup, no log, no network).
        if (!isEnabled(projectRoot)) return 0;
        // The guard (src/cli.ts sends PreToolUse there directly; this is the path for a saved input file).
        if (event === "PreToolUse") {
          const out = await runGuardHook(JSON.stringify(input), { viaPlugin });
          if (out) io.out(out + "\n");
          return 0;
        }
        // Only Stop, UserPromptSubmit and (0.7.1) SessionStart do anything; any other event a hook entry sends is ignored.
        if (event !== "Stop" && event !== "UserPromptSubmit" && event !== "SessionStart") return 0;
        // Plugin and `jevmem init` hooks in the same project would both fire on every event: the plugin's stand down.
        if (viaPlugin && projectHasInitHooks(projectRoot)) {
          const warning = standDown(projectRoot, input, event);
          if (warning) io.out(JSON.stringify({ systemMessage: warning }) + "\n");
          return 0;
        }
        loadEnvFallbacks(projectRoot); // desktop-app hooks get no shell environment: .jevmem/.env, ~/.jevmem/env
        const cfg = loadConfig(projectRoot);
        if (cfg.enabled === false) return 0; // switched off for this project in jevmem.config.json
        // SessionStart (0.7.1): the always-on lines from the file, no key and no daemon needed.
        if (event === "SessionStart") {
          const ss = sessionStartOutcome(new MemoryStore(projectRoot, cfg.memoryFile), cfg, input.session_id);
          if (ss.stdout) io.out(ss.stdout + "\n");
          if (process.env.JEVMEM_VERBOSE === "1" || process.env.JEVMEM_DEBUG === "1") io.err(`jevmem: ${ss.event}: ${ss.action}: ${ss.detail}\n`);
          return 0;
        }
        // No key: the hooks do nothing, so say so, once per project until a key is found. Notices are shown to the user
        // on a prompt only (the Stop hook's output is not shown).
        if (hasJevKey()) keyFound(projectRoot);
        // The plugin's words depend on how it was installed: only one from a marketplace has a key setting.
        const keyNotice = !hasJevKey() && event === "UserPromptSubmit" ? missingKeyNotice(projectRoot, viaPlugin ? (runningPlugin(process.env, projectRoot) ?? "plugin") : "init") : null;
        const writerNotice = event === "UserPromptSubmit" ? writerOptInNotice(projectRoot) : null;
        // jevmem's first line in this project, once, so it is not mistaken for Claude Code's own memory.
        const firstNotice = event === "UserPromptSubmit" ? firstLineNotice(projectRoot, cfg.memoryFile) : null;
        const notice = [keyNotice, writerNotice, firstNotice].filter(Boolean).join("\n");
        const verbose = process.env.JEVMEM_VERBOSE === "1" || process.env.JEVMEM_DEBUG === "1";
        let out = null as Awaited<ReturnType<typeof runHook>> | null;
        const useDaemon = daemonEnabled(cfg) && hasJevKey();
        if (event !== "UserPromptSubmit" && hasJevKey()) {
          // Stop: queue the turn and hand it to the daemon; never wait for Jev here.
          out = await handOffStop(projectRoot, cfg, input, event, useDaemon);
        } else {
          if (useDaemon) {
            const t0 = performance.now();
            const res = await daemonRequest(projectRoot, { type: "hook", input, client: jevFingerprint() }, { connectMs: 250, responseMs: cfg.jev.timeoutMs + cfg.writer.timeoutMs + 2000 });
            if (res && res.ok && res.type === "hook") {
              out = res.outcome;
              if (out.summary) out.summary += ` (daemon round trip ${Math.round(performance.now() - t0)} ms)`;
            }
          }
          if (!out) {
            out = await runHook(input);
            if (useDaemon && out.action !== "noop") spawnDaemon(projectRoot, cliFile());
          }
        }
        if (notice) {
          let payload: Record<string, unknown> = {};
          try {
            payload = out.stdout ? JSON.parse(out.stdout) : {};
          } catch {
            /* not JSON: keep the notice alone */
          }
          out.stdout = JSON.stringify({ ...payload, systemMessage: notice });
        }
        if (out.stdout) io.out(out.stdout + "\n");
        if (verbose) {
          if (out.summary) io.err(`jevmem: ${out.summary} via ${out.via}\n`);
          io.err(`jevmem ${out.event}: ${out.action} — ${out.detail}\n`);
        }
      } catch (err) {
        logHookProblem(projectRoot, event, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      }
      return 0; // exit 0 on every path so Claude Code is not blocked
    }
    case "daemon": {
      const sub = args.shift() ?? "status";
      if (sub === "--serve" || sub === "serve") {
        await serveDaemon(root, { onListening: (s) => io.err(`jevmem daemon listening on ${s}\n`) });
        return -1;
      }
      if (sub === "start") {
        const alive = await daemonRequest(root, { type: "ping" });
        if (alive) return fail("daemon already running");
        spawnDaemon(root, process.argv[1] ?? "");
        io.out("daemon starting\n");
        return 0;
      }
      if (sub === "stop") {
        const r = await daemonRequest(root, { type: "stop" });
        io.out(r ? "daemon stopping\n" : "no daemon running\n");
        return 0;
      }
      const r = await daemonRequest(root, { type: "ping" });
      if (r && r.ok && r.type === "pong") io.out(`running: pid ${r.pid}, version ${r.version}${r.version !== DAEMON_VERSION ? " (outdated; run `jevmem daemon stop`)" : ""}, up ${Math.round(r.uptimeMs / 1000)} s, served ${r.served} request(s), socket ${JSON.parse(fs.readFileSync(pidFile(root), "utf8")).socket}\n`);
      else io.out("not running\n");
      return 0;
    }
    case "mcp": {
      // Clients without a project working directory (Claude Desktop) name the project with --root or JEVMEM_ROOT.
      // The Claude Code plugin's MCP server gets CLAUDE_PROJECT_DIR (set for stdio MCP servers).
      // 0.7.6: the Cursor plugin's entry passes --root "${workspaceFolder}", which the Cursor app expands per window and
      // the agent CLI leaves literal: a placeholder means the working directory.
      const rootArg = opt(args, "--root");
      const mcpRoot = (rootArg && !rootArg.startsWith("${") ? rootArg : undefined) ?? process.env.JEVMEM_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? root;
      if (!fs.existsSync(mcpRoot)) return fail(`--root ${mcpRoot} does not exist`);
      const pluginVersion = process.env.JEVMEM_PLUGIN_VERSION;
      if (pluginVersion && isOlder(PACKAGE_VERSION, pluginVersion)) io.err(`jevmem: the installed CLI is ${PACKAGE_VERSION}, older than the plugin (${pluginVersion}); run: npm install -g jevmem\n`);
      await serveMcp(mcpRoot);
      return -1; // keep running
    }
    case "audit": {
      const dry = flag(args, "--dry-run");
      const ci = flag(args, "--ci");
      const security = flag(args, "--security") || ci;
      const cfg = loadConfig(root);
      const store = new MemoryStore(root, cfg.memoryFile);
      if (security) {
        if (!hasJevKey()) loadEnvFallbacks(root);
        if (!hasJevKey()) {
          io.err("jevmem audit --security: TYPESAFE_API_KEY is not set, so the lines cannot be checked.\n");
          return ci ? 2 : 1;
        }
        const jev = createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention });
        let rows;
        try {
          rows = await securityAudit(jev, store, { injectionMax: cfg.thresholds.injectionMax });
        } catch (err) {
          io.err(`jevmem audit --security: the check failed: ${err instanceof Error ? err.message : String(err)}\n`);
          return ci ? 2 : 1;
        }
        io.out(formatSecurityTable(rows) + "\n");
        printJevSummary(jev.log);
        return ci && rows.some((r) => r.flagged) ? 1 : 0;
      }
      requireKey();
      const jev = createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention });
      const rows = await auditMemories(jev, store, { staleBelow: cfg.thresholds.staleBelow });
      io.out(formatAuditTable(rows) + "\n");
      if (!dry) {
        applyAudit(store, rows);
        const n = rows.filter((r) => r.stale).length;
        io.out(`\n${n} line(s) marked [stale?] in ${cfg.memoryFile}\n`);
      }
      const held = knownWithheld(root, store.active(), cfg.thresholds.injectionMax);
      if (held.length) {
        io.out(`\nWithheld from recall by the poisoning gate (${held.length}); run \`jevmem audit --security\` to re-check:\n`);
        for (const w of held) io.out(`  ${w.memory.id}  ${w.reason}  ${w.memory.text.slice(0, 80)}\n`);
      }
      printJevSummary(jev.log);
      return 0;
    }
    case "guard": {
      const sub = args.shift();
      const usage = 'usage: jevmem guard test "<command>" | --edit <path> [--old "<text>"] [--content "<new text>"] | --write <path> [--content "<text>"] [--no-cache]\n       jevmem guard log [-n 20]';
      if (sub !== "test" && sub !== "log") return fail(usage);
      if (!isEnabled(root)) return fail(NOT_ENABLED_MESSAGE);
      if (sub === "log") {
        const n = Number(opt(args, "-n") ?? 20);
        if (!Number.isInteger(n) || n < 1 || args.length) return fail(usage);
        io.out(formatGuardLog(readGuardLog(root), n) + "\n");
        return 0;
      }
      const edit = opt(args, "--edit");
      const write = opt(args, "--write");
      const content = opt(args, "--content") ?? "";
      const old = opt(args, "--old") ?? "";
      const noCache = flag(args, "--no-cache");
      const command = args.join(" ").trim();
      let input: GuardInput;
      if (edit) input = { hook_event_name: "PreToolUse", cwd: root, tool_name: "Edit", tool_input: { file_path: path.resolve(root, edit), old_string: old, new_string: content } };
      else if (write) input = { hook_event_name: "PreToolUse", cwd: root, tool_name: "Write", tool_input: { file_path: path.resolve(root, write), content } };
      else if (command) input = { hook_event_name: "PreToolUse", cwd: root, tool_name: "Bash", tool_input: { command } };
      else return fail(usage);
      // The same evaluation as the hook, in this project; the decision is shown, not logged.
      const trace = await evaluateGuard(input, { root, makeJev: defaultMakeJev, noCache, log: false });
      io.out(formatGuardTrace(trace) + "\n");
      return 0;
    }
    case "search": {
      const limit = Number(opt(args, "--limit") ?? 10);
      const query = args.join(" ").trim();
      if (!query) return fail("usage: jevmem search <query>");
      requireKey();
      const cfg = loadConfig(root);
      const store = new MemoryStore(root, cfg.memoryFile);
      const jev = createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention });
      const { ranked, withheld } = await rankGuarded(jev, root, query, store.active(), { perCandidateNouls: true, maxIds: cfg.jev.maxRecallCandidates, label: "search", injectionMax: cfg.thresholds.injectionMax, source: "jevmem search" });
      for (const r of ranked.slice(0, limit)) {
        io.out(`${(r.relevance ?? r.choiceProbability).toFixed(2)}  ${r.choiceProbability.toFixed(2)}  [${r.memory.kind}] ${r.memory.text}  (${r.memory.id})\n`);
      }
      if (ranked.length === 0) io.out("no memories\n");
      for (const w of withheld) io.out(`withheld  ${w.memory.id}  ${w.reason}\n`);
      printJevSummary(jev.log);
      return 0;
    }
    case "list": {
      const all = flag(args, "--all");
      const cfg = loadConfig(root);
      const store = new MemoryStore(root, cfg.memoryFile);
      const mems = all ? store.list() : store.active();
      const prov = all ? readProvenance(root) : null;
      const held = all ? new Map(planGate(root, mems, cfg.thresholds.injectionMax).withheld.map((w) => [w.memory.id, w])) : null;
      for (const m of mems) {
        // A line trusted by hand (0.7.0) is verified; both listings say so.
        const trusted = verifiedVia(root, m) === "trust";
        const status = prov ? `${(trusted ? "trusted" : isVerified(prov, m) ? "verified" : "unverified").padEnd(10)}${held!.has(m.id) ? " WITHHELD" : ""}  ` : trusted ? "trusted  " : "";
        io.out(`${m.id}  ${status}[${m.kind}]${m.always ? " always-on" : ""}${m.stale !== undefined ? " [stale?]" : ""} ${m.text}${m.supersededBy ? ` → ${m.supersededBy}` : ""}${m.kind === "retired" ? ` (was ${m.was ?? "?"}${m.retiredAt ? `, retired ${m.retiredAt.slice(0, 10)}` : ""})` : ""}\n`);
      }
      if (mems.length === 0) io.out("no memories\n");
      if (all && mems.length) io.out(`\nverified: jevmem wrote this exact text on this machine; trusted: you marked it verified with jevmem trust. unverified lines go through the poisoning gate before any agent sees them.\n`);
      return 0;
    }
    case "always": {
      const off = flag(args, "--off");
      const suggest = flag(args, "--suggest");
      const apply = flag(args, "--apply");
      const ids = args.filter((a) => !a.startsWith("--"));
      const cfg = loadConfig(root);
      const store = new MemoryStore(root, cfg.memoryFile);
      if (suggest) {
        if (ids.length) return fail("usage: jevmem always --suggest [--apply]");
        requireKey();
        const candidates = store.active().filter((m) => !m.always && (ALWAYS_KINDS as readonly string[]).includes(m.kind));
        if (!candidates.length) {
          io.out("jevmem always --suggest: no live constraint, preference, decision or architecture line without the mark.\n");
          return 0;
        }
        const jev = createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention });
        const min = cfg.thresholds.alwaysMin ?? DEFAULT_CONFIG.thresholds.alwaysMin;
        const marks: { m: (typeof candidates)[number]; p: number }[] = [];
        for (const [i, m] of candidates.entries()) {
          io.err(`\rjevmem always --suggest: ${i}/${candidates.length} lines asked`);
          const d = await decide(jev, { userMessage: m.text, existingMemories: [] }, { thresholds: cfg.thresholds, tiers: { mode: "fast" }, timeoutMs: cfg.jev.timeoutMs });
          if (d.alwaysNoul >= min) marks.push({ m, p: d.alwaysNoul });
        }
        io.err(`\rjevmem always --suggest: ${candidates.length}/${candidates.length} lines asked\n`);
        io.out(`jevmem always --suggest${apply ? "" : " (dry run)"}: ${candidates.length} line(s) asked, ${marks.length} read as a rule for every change (${min} or more):\n`);
        for (const { m, p } of marks) io.out(`  + ${m.id}  [${m.kind}] ${m.text}  (${p.toFixed(2)})\n`);
        if (apply) {
          for (const { m } of marks) {
            store.setAlways(m.id, true);
            appendLog(root, { ts: new Date().toISOString(), label: "always", event: "always", ok: true, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, memoryId: m.id, detail: "marked always-on by --suggest --apply" });
          }
          io.out(`Marked ${marks.length} line(s) always-on.\n`);
        } else io.out(marks.length ? "Run with --apply to mark them, or jevmem always <id> for some of them.\n" : "Nothing to mark.\n");
        printJevSummary(jev.log);
        return 0;
      }
      if (!ids.length) return fail("usage: jevmem always [--off] <memory id> [<memory id>…] | jevmem always --suggest [--apply]");
      let code = 0;
      const makeJev = () => {
        requireKey();
        return createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention });
      };
      for (const id of ids) {
        const live = store.active().find((x) => x.id === id);
        if (!live) {
          io.err(`jevmem always: no live line with id ${id}\n`);
          code = 1;
          continue;
        }
        // 0.7.2: a line is marked only when the poisoning gate lets it through (verified, a clean cached verdict, or one
        // request with the line now, as trust makes): an always-on line reaches every session from the file alone.
        if (!off) {
          const g = await gateForAlways(root, cfg, live, makeJev, "jevmem always");
          if (!g.ok) {
            io.err(`jevmem always: not marked ${id}: ${g.reason}\n`);
            code = 1;
            continue;
          }
        }
        const m = store.setAlways(id, !off)!;
        appendLog(root, { ts: new Date().toISOString(), label: "always", event: "always", ok: true, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, memoryId: id, detail: off ? "always-on mark removed" : "marked always-on" });
        io.out(`${off ? "no longer always-on" : "always-on"} ${m.id}: [${m.kind}] ${m.text}\n`);
      }
      return code;
    }
    case "add": {
      const trust = flag(args, "--trust");
      const always = flag(args, "--always");
      const kind = args.shift() as Kind | undefined;
      const text = args.join(" ").trim();
      if (!kind || !(NEW_KINDS as readonly string[]).includes(kind) || !text) return fail(`usage: jevmem add [--trust] <${NEW_KINDS.join("|")}> <text>`);
      // --trust needs a terminal (jevmem trust asks on one): refused before anything is written, so nothing is half done.
      if (trust && !isTerminal(opts)) return fail("jevmem add --trust: not a terminal, so nothing was added. Run it in a terminal: it shows the line and asks before trusting it, or run jevmem add without --trust.");
      const cfg = loadConfig(root);
      const store = new MemoryStore(root, cfg.memoryFile);
      // Typed by a person, so no Jev call, for every kind (a dead end too, since v0.6 part 2c); secrets are still scrubbed
      // because JEVMEM.md is committed. The line is unverified, so the poisoning gate checks it before recall serves it.
      const m = store.add({ kind, text: clampLine(scrubSecrets(text), cfg.writer.maxChars), conf: 1, ...(always ? { always: true } : {}) });
      io.out(`added ${m.id}: [${m.kind}] ${m.text}${always ? " (always-on)" : ""}\n`);
      if (!trust && !always) return 0;
      requireKey();
      const jev = createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention });
      if (trust) {
        const code = await trustLines(root, cfg, store, [m.id], io, { jev, confirm: confirmOnTerminal });
        // Not trusted: the line stays, unverified, and the always-on mark goes with the verification it needed.
        if (code !== 0 && always) {
          store.setAlways(m.id, false);
          io.err(`jevmem add: ${m.id} is not marked always-on either\n`);
        }
        return code;
      }
      // 0.7.2: --always without --trust asks the poisoning gate once (one request with the line, as trust makes); a
      // line it withholds is added without the mark.
      const g = await gateForAlways(root, cfg, m, () => jev, "jevmem add --always");
      if (!g.ok) {
        store.setAlways(m.id, false);
        io.err(`jevmem add: ${m.id} is added but not marked always-on: ${g.reason}\n`);
        return 1;
      }
      return 0;
    }
    case "trust": {
      const ids = args.filter((a) => !a.startsWith("--"));
      if (!ids.length || ids.length !== args.length) return fail("usage: jevmem trust <memory id> [<memory id>…]");
      // Only a person at a terminal can trust a line: an agent's shell has no terminal, and there is no flag to answer for it.
      if (!isTerminal(opts)) return fail("jevmem trust: not a terminal, so nothing was changed. Run jevmem trust in a terminal: it shows the line and asks first.");
      requireKey();
      const cfg = loadConfig(root);
      const store = new MemoryStore(root, cfg.memoryFile);
      const jev = createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention });
      const code = await trustLines(root, cfg, store, ids, io, { jev, confirm: confirmOnTerminal });
      printJevSummary(jev.log);
      return code;
    }
    case "import": {
      const apply = flag(args, "--apply");
      const memoryDir = opt(args, "--memory-dir");
      const fromArg = opt(args, "--from");
      const sinceArg = opt(args, "--since");
      const sources: string[] = fromArg ? fromArg.split(",").map((x) => x.trim()) : [...DEFAULT_IMPORT_SOURCES];
      const bad = sources.filter((x) => !(IMPORT_SOURCES as readonly string[]).includes(x) && x !== "sessions");
      if (bad.length) return fail(`unknown source(s): ${bad.join(", ")}. Choose from ${IMPORT_SOURCES.join(", ")}, sessions`);
      requireKey();
      const cfg = loadConfig(root);
      const store = new MemoryStore(root, cfg.memoryFile);
      // --from sessions (0.7.1): past Claude Code sessions, after a yes on a terminal. On its own; the file sources stay as they are.
      if (sources.includes("sessions")) {
        if (sources.length > 1) return fail("jevmem import --from sessions runs on its own: name it alone");
        if (!isTerminal(opts)) return fail("jevmem import --from sessions: not a terminal, so nothing was read or sent. Run it in a terminal: it counts the sessions and turns first and asks before anything is sent.");
        let since: Date | null = null;
        if (sinceArg) {
          since = parseSince(sinceArg);
          if (!since) return fail(`--since: use a span such as 30d, 12h or 2w, or a date such as 2026-09-01 (got ${sinceArg})`);
        }
        const found = findSessionFiles(root, { since });
        const turns = found.files.reduce((a, f) => a + f.turns.length, 0);
        io.out(`jevmem import --from sessions: ${found.dir}\n`);
        io.out(`Found ${found.files.length} session${found.files.length === 1 ? "" : "s"} with ${turns} turn${turns === 1 ? "" : "s"}${since ? ` since ${since.toISOString().slice(0, 10)}` : ""}` + (found.skipped.length ? ` (skipped: ${found.skipped.join("; ")})` : "") + `; nothing has been sent.\n`);
        if (found.suspect) io.out(`${found.suspect}\n`);
        if (!turns) {
          io.out("Nothing to import.\n");
          return 0;
        }
        const chars = found.files.reduce((a, f) => a + f.turns.reduce((b, t) => b + Math.min(6000, t.user.length) + Math.min(2000, t.assistant.length), 0), 0);
        const est = { usd: turns * 0.00017, s: turns * 0.3 };
        io.out(`Each turn would be sent to TypeSafe (scrubbed) and decided as a finished turn is: about ${chars.toLocaleString("en-US")} characters, an estimated $${est.usd.toFixed(3)} and ${Math.round(est.s)} s${apply ? "; accepted lines are then written to JEVMEM.md" : "; nothing is written without --apply"}.\n`);
        const yes = await confirmOnTerminal(`Send ${turns} turn${turns === 1 ? "" : "s"} from ${found.files.length} session${found.files.length === 1 ? "" : "s"} to TypeSafe? [y/N] `);
        if (!yes) {
          io.out("Nothing sent.\n");
          return 0;
        }
        const jev = createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention });
        const rows = await importSessions(jev, store, cfg, found.files, { apply, onProgress: (d, t) => io.err(`\rjevmem import: ${d}/${t} turns decided`) });
        io.err("\n");
        io.out(formatSessionImport(rows, { apply, files: found.files }) + "\n");
        printJevSummary(jev.log);
        return 0;
      }
      const { candidates, files, notFound } = collectCandidates(root, sources as ImportSource[], { memoryDir, maxChars: cfg.writer.maxChars });
      if (candidates.length === 0) {
        io.out(`jevmem import: nothing to import${notFound.length ? ` (not found: ${notFound.join(", ")})` : ""}\n`);
        return 0;
      }
      const jev = createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention });
      const rows = await runImport(jev, store, cfg, candidates, { apply, onProgress: (d, t) => io.err(`\rjevmem import: ${d}/${t} statements checked`) });
      io.err("\n");
      io.out(formatImport(rows, { apply, files, notFound }) + "\n");
      printJevSummary(jev.log);
      return 0;
    }
    case "log":
    case "stats": {
      const allEntries = readLog(root);
      // Jev calls only: queue and gate events are counted below, and so are the hooks' own problem lines (no key, for
      // example), which are not calls.
      const entries = allEntries.filter((e) => !e.event && e.label !== "hook");
      const skippedNoKey = allEntries.filter((e) => e.label === "hook" && e.ok === false && !e.event && isNoKey(e.error ?? "")).length;
      const s = summarizeLog(entries);
      const byLabel = new Map<string, typeof entries>();
      for (const e of entries) byLabel.set(e.label, [...(byLabel.get(e.label) ?? []), e]);
      io.out(`${s.calls} call(s), ${s.ok} ok, ${s.cacheHits} cache hit(s) (${(s.cacheHitRate * 100).toFixed(0)}%), p50 ${s.p50LatencyMs} ms, p95 ${s.p95LatencyMs} ms, ${s.totalTokens} tokens, $${s.totalCostUsd.toFixed(6)} total${skippedNoKey ? `; ${skippedNoKey} skipped: no TypeSafe key` : ""}\n`);
      for (const [label, es] of byLabel) {
        const ls = summarizeLog(es);
        io.out(`  ${label.padEnd(8)} ${String(ls.calls).padStart(4)} calls  p50 ${String(ls.p50LatencyMs).padStart(5)} ms  p95 ${String(ls.p95LatencyMs).padStart(5)} ms  ${String(ls.totalTokens).padStart(7)} tokens  $${ls.totalCostUsd.toFixed(6)}  cache ${(ls.cacheHitRate * 100).toFixed(0)}%\n`);
      }
      if (cmd === "stats") {
        const env = { ...process.env };
        loadEnvFallbacks(root, env);
        const w = resolveWriter(loadConfig(root).writer, env);
        io.out(`writer: ${w.provider === "none" ? "jevmem (local, no LLM)" : `${w.provider} (${w.model})`}: ${w.reason}\n`);
        const q = queueStats(root, allEntries);
        io.out(`retry queue: ${q.queued} queued after a Jev failure, ${q.retried} retries, ${q.savedFromQueue} saved from the queue (${q.skippedFromQueue} skipped by Jev), ${q.dropped} dropped, ${q.pending} pending\n`);
        const rp = recallPathStats(allEntries);
        if (rp.total) io.out(`recall: ${rp.total} prompt(s): ${rp.jev} served by Jev, ${rp.wordMatch} by word match because Jev failed or ran past jev.recallTimeoutMs; ${rp.noLine} got no line\n`);
        const waiting = deferredTurns(root).length;
        if (waiting) io.out(`turns waiting for their background subagents: ${waiting} (decided once the subagents report back, a later prompt closes them, or their session goes quiet)\n`);
        for (const line of formatFailures(recentFailures(allEntries), "failures: ", "  ")) io.out(line + "\n");
        const dups = allEntries.filter((e) => e.event === "duplicate").length;
        if (dups) io.out(`duplicates: ${dups} turn(s) or line(s) not saved because a live line already says it (\`jevmem why\` names it)\n`);
        const withheld = new Set(allEntries.filter((e) => e.event === "withheld").map((e) => e.memoryId)).size;
        if (withheld) io.out(`poisoning gate: ${withheld} line(s) withheld from recall (see \`jevmem audit\`)\n`);
        const guard = formatGuardStats(guardLogStats(readGuardLog(root)));
        if (guard) io.out(guard + "\n");
        io.out(`decide tiers: ${s.decideTier1} tier-1, ${s.decideTier2} tier-2; escalation rate ${s.escalationRate === null ? "n/a (no tier-1 calls; mode=full?)" : (s.escalationRate * 100).toFixed(0) + "%"}\n`);
        const days = Object.entries(s.costPerDay).sort();
        if (days.length) {
          io.out("cost per day:\n");
          for (const [d, c] of days.slice(-14)) io.out(`  ${d}  $${c.toFixed(6)}\n`);
        }
        const labels = readLabels(root);
        const fitInfo = readFitInfo(root);
        io.out(`labels: ${labels.length} (${labels.filter((l) => l.source === "right").length} right, ${labels.filter((l) => l.source === "wrong").length} wrong, ${labels.filter((l) => l.source === "missed").length} missed)${labels.length < MIN_LABELS ? `; ${MIN_LABELS - labels.length} more before \`jevmem fit\`` : ""}\n`);
        io.out(`last fit: ${fitInfo ? `${fitInfo.at} on ${fitInfo.n} labels (F1 ${(fitInfo.before.f1 * 100).toFixed(0)}% → ${(fitInfo.after.f1 * 100).toFixed(0)}%)` : "never"}\n`);
      }
      return 0;
    }
    case "doctor": {
      const enabled = isEnabled(root);
      io.out(`jevmem ${PACKAGE_VERSION}\n`);
      io.out(`project  ${root}: ${enabled ? "enabled (jevmem.config.json)" : "not enabled: run `jevmem enable`"}\n`);
      const source = resolveJevKey(root);
      const installs = pluginInstalls(root);
      io.out(source ? `key      TypeSafe key found (${source})\n` : `key      ${missingKeyHelp({ configure: canConfigure(installs) }).replace(/\n/g, "\n         ")}\n`);
      const model = loadConfig(root).jev.model;
      io.out(`model    ${model}${model === "jev-latest" ? `: an alias TypeSafe moves to each new Jev release (jev-1.14.0 about a week after 2026-10-14); this jevmem's default is jev-1.13.0, the model its numbers were measured on. To stay on it, set "jev": {"model": "jev-1.13.0"} in jevmem.config.json` : ""}\n`);
      loadEnvFallbacks(root); // the writer keys may live in .jevmem/.env or ~/.jevmem/env even when TYPESAFE_API_KEY doesn't
      const w = resolveWriter(loadConfig(root).writer);
      io.out(`writer   ${w.provider === "none" ? "jevmem (local, no LLM)" : `${w.provider} (${w.model})`}: ${w.reason}\n`);
      const base = process.env.OPENAI_BASE_URL?.trim();
      if (w.provider === "openai" && base)
        io.out(`         endpoint ${base} (OPENAI_BASE_URL, OpenAI-compatible)${isReasoningModel(w.model) ? `: ${w.model} is asked for reasoning_effort minimal, and the request is sent again without it if the endpoint rejects it` : ""}; a line written locally instead is listed under failures\n`);
      const forced = process.env.JEVMEM_WRITER?.trim().toLowerCase();
      if (forced && forced !== "none") io.out(`         JEVMEM_WRITER=${forced} is ignored: only "writer" in jevmem.config.json turns the LLM writer on\n`);
      if (configuredWriter(root) === "auto") io.out(`         jevmem.config.json has the pre-0.5.4 "writer": {"provider": "auto"}, which now means no LLM writer\n`);
      const plugin = hasActivePlugin(installs);
      const hooks = [...installs.map(describeInstall), projectHasInitHooks(root) ? `\`jevmem init\` hooks in .claude/settings.local.json${projectHasInitGuardHook(root) ? " (with the PreToolUse guard)" : " (no PreToolUse guard: `jevmem init` with a jevmem that has the guard adds it)"}` : null].filter(Boolean);
      io.out(`hooks    ${hooks.length ? hooks.join("; ") : "no jevmem plugin found (checked the plugins synced from claude.ai and the user and project settings), and no init hooks in this project: run `jevmem init --tool claude`, or add the plugin"}\n`);
      if (fs.existsSync(path.join(root, ".cursor")) || readCursorPluginMarker()) io.out(`cursor   ${cursorDoctorLine(root)}\n`);
      if (enabled) io.out(`guard    ${guardStatus(root)}\n`);
      if (enabled) io.out(`always   ${alwaysOnStatus(root)}\n`);
      for (const line of hookCliLines(root, plugin)) io.out(line + "\n");
      for (const line of formatFailures(recentFailures(readLog(root)), "failures ", "         ")) io.out(line + "\n");
      return 0;
    }
    case "key": {
      const tty = opts.stdin === undefined && process.stdin.isTTY === true;
      // A key already saved is replaced only after a yes, which needs a terminal to ask in.
      if (hasSavedJevKey()) {
        if (!tty) return fail("jevmem key: ~/.jevmem/env already has a TypeSafe API key, so nothing was changed. To replace it, run jevmem key in a terminal: it asks first.");
        const answer = (await readLine("A TypeSafe API key is already saved in ~/.jevmem/env. Replace it? [y/N] ")).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          io.out("Kept the key already saved in ~/.jevmem/env.\n");
          return 0;
        }
      }
      const raw = opts.stdin ?? (tty ? await readLine("TypeSafe API key (input hidden): ", { hidden: true }) : await readAll());
      const key = cleanPastedKey(raw);
      if (!key) return fail("jevmem key: no usable key read, so nothing was changed. Paste your TypeSafe API key (from https://console.typesafe.ai/keys) and press Enter, or run jevmem key < file. A key with spaces, quotes, #, $ or a backslash can't go in ~/.jevmem/env this way.");
      const file = saveJevKey(key);
      io.out(`Saved your TypeSafe API key to ${file.replace(os.homedir(), "~")} (readable only by you). jevmem uses it from your next prompt, unless a key from the plugin setting, the environment or the project's .jevmem/.env comes first.\n`);
      return 0;
    }
    case "why": {
      const id = args.shift();
      if (!id) return fail("usage: jevmem why <memory id | turn hash>");
      const rec = findDecision(root, id);
      if (!rec) return fail(`no recorded decision for ${id} (decisions are recorded in .jevmem/decisions.jsonl from v0.3.0 on)`);
      io.out(formatWhy(rec) + "\n");
      return 0;
    }
    case "right":
    case "wrong": {
      const shouldBe = opt(args, "--should-be");
      const id = args.shift();
      if (!id) return fail(`usage: jevmem ${cmd} <memory id | turn hash>${cmd === "wrong" ? " [--should-be <kind|none>]" : ""}`);
      if (shouldBe && shouldBe !== "none" && !(NEW_KINDS as readonly string[]).includes(shouldBe)) return fail(`--should-be must be one of none, ${NEW_KINDS.join(", ")}`);
      const rec = findDecision(root, id);
      if (!rec) return fail(`no recorded decision for ${id}`);
      const cfg = loadConfig(root);
      // 0.7.5 (fix e): `wrong --should-be none` retires the line, and a rule is retired only after a yes on a terminal,
      // as `jevmem forget` has it since 0.7.0: an agent's shell has none, and the guard's tamper check asks first.
      if (cmd === "wrong" && shouldBe === "none" && rec.decision.save && rec.memoryId) {
        const m = new MemoryStore(root, cfg.memoryFile).list().find((x) => x.id === rec.memoryId);
        if (m && m.kind === "constraint") {
          io.out(`[constraint] ${m.text}  (${m.id})\n`);
          if (!isTerminal(opts)) return fail(`jevmem wrong: ${m.id} is a rule, and retiring a rule needs a yes on a terminal; nothing was changed. Run jevmem wrong ${m.id} --should-be none in a terminal.`);
          if (!(await confirmOnTerminal("Retire this rule? [y/N] "))) {
            io.out("nothing was changed\n");
            return 0;
          }
        }
      }
      if (cmd === "right") {
        const n = labelRight(root, rec);
        io.out(`labelled as correct (${rec.decision.save ? `saved as ${rec.decision.kind}` : "skipped"}). ${n} label(s) total.\n`);
      } else {
        const { count, label } = labelWrong(root, rec, shouldBe);
        io.out(`labelled: should ${label.save ? `have been saved as ${label.kind}` : "not have been saved"}. ${count} label(s) total.\n`);
        if (rec.decision.save && !label.save && rec.memoryId) {
          // Since 0.7.0 the line is retired, as `jevmem forget` does, not deleted: it stays in the file as [retired].
          const store = new MemoryStore(root, cfg.memoryFile);
          const r = store.retire(rec.memoryId);
          if (r) io.out(`retired ${rec.memoryId} in ${cfg.memoryFile} (it stays in the file as [retired])\n`);
        }
      }
      new MemoryStore(root, cfg.memoryFile).touchFooter();
      return 0;
    }
    case "forget": {
      const ids = args.filter((a) => !a.startsWith("--"));
      if (!ids.length || ids.length !== args.length) return fail("usage: jevmem forget <memory id> [<memory id>…]");
      const cfg = loadConfig(root);
      const store = new MemoryStore(root, cfg.memoryFile);
      const tty = opts.stdin === undefined && process.stdin.isTTY === true;
      let code = 0;
      for (const id of ids) {
        const m = store.list().find((x) => x.id === id);
        if (!m) {
          io.err(`jevmem forget: no line with id ${id} in ${cfg.memoryFile}\n`);
          code = 1;
          continue;
        }
        if (m.kind === "retired") {
          io.out(`${id} is already retired\n`);
          continue;
        }
        if (m.kind === "superseded" || m.supersededBy) {
          io.out(`${id} is superseded${m.supersededBy ? ` by ${m.supersededBy}` : ""}; nothing to retire\n`);
          continue;
        }
        if (m.kind === "constraint") {
          // A rule is retired only after a yes on a terminal: an agent's shell has none, and the guard's tamper check asks
          // about the command before it runs.
          io.out(`[constraint] ${m.text}  (${id})\n`);
          if (!tty) {
            io.err(`jevmem forget: ${id} is a rule, and retiring a rule needs a yes on a terminal; nothing was changed. Run jevmem forget ${id} in a terminal.\n`);
            code = 1;
            continue;
          }
          const answer = (await readLine("Retire this rule? [y/N] ")).trim().toLowerCase();
          if (answer !== "y" && answer !== "yes") {
            io.out(`kept ${id}\n`);
            continue;
          }
        }
        const r = store.retire(id);
        if (!r) {
          io.err(`jevmem forget: could not retire ${id}\n`);
          code = 1;
          continue;
        }
        appendLog(root, { ts: new Date().toISOString(), label: "forget", event: "retired", ok: true, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, memoryId: id, detail: `[${r.was}] ${r.text.slice(0, 160)}` });
        io.out(`retired ${id}: [${r.was}] ${r.text}\n`);
      }
      return code;
    }
    case "missed": {
      const kind = opt(args, "--kind");
      const text = args.join(" ").trim();
      if (!text) return fail('usage: jevmem missed "<text of the turn>" [--kind <kind>]');
      if (kind && !(NEW_KINDS as readonly string[]).includes(kind)) return fail(`--kind must be one of ${NEW_KINDS.join(", ")}`);
      requireKey();
      const cfg = loadConfig(root);
      const store = new MemoryStore(root, cfg.memoryFile);
      const jev = createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention });
      const { count, decision, label } = await labelMissed(jev, root, cfg, text.includes("USER:") ? text : mergeTurn(text, ""), kind, store.active());
      io.out(`labelled as missed (${label.kind}); Jev had said: ${decision.reason}. ${count} label(s) total.\n`);
      const m = store.add({ kind: label.kind as Kind, text: clampLine(scrubSecrets(text), cfg.writer.maxChars), conf: decision.confidence });
      io.out(`added ${m.id}: [${m.kind}] ${m.text}\n`);
      printJevSummary(jev.log);
      return 0;
    }
    case "fit": {
      const dry = flag(args, "--dry-run");
      const force = flag(args, "--force");
      const r = runFit(root, { dryRun: dry, force });
      if (!r.ok) return fail(`fit: ${r.reason}`);
      io.out(formatFit(r.result) + "\n");
      if (r.result.n < MIN_LABELS) io.out(`\n! only ${r.result.n} labels (< ${MIN_LABELS}); these weights are likely overfit. Label more and refit.\n`);
      if (r.written) {
        io.out(`\nwrote weights and thresholds to jevmem.config.json\n`);
        const cfg = loadConfig(root);
        new MemoryStore(root, cfg.memoryFile).touchFooter();
      } else io.out(`\n(dry run; nothing written)\n`);
      return 0;
    }
    case "watch": {
      const replay = flag(args, "--replay");
      const once = flag(args, "--once");
      const tool = opt(args, "--tool") ?? "codex";
      if (!isEnabled(root)) return fail(NOT_ENABLED_MESSAGE);
      if (tool !== "codex") return fail(`watch supports --tool codex only. Cursor saves each finished agent turn through its hooks since 0.7.4 (jevmem init --tool cursor).`);
      requireKey();
      io.err(`jevmem watch: tailing Codex sessions for ${root}${replay ? " (replaying last 24 h)" : ""}. Ctrl-C to stop.\n`);
      const r = await watchCodex(root, {
        replay,
        once,
        onInfo: (m) => io.err(`jevmem watch: ${m}\n`),
        onTurn: async (t) => {
          const out = await runHook({ hook_event_name: "Stop", cwd: root, user_message: t.user, assistant_message: t.assistant, recent_context: t.previous });
          io.err(`jevmem watch: ${out.action} — ${out.detail}${out.summary ? ` (${out.summary})` : ""}\n`);
        },
      });
      if (once) io.out(`${r.files} file(s), ${r.turns} turn(s)\n`);
      return 0;
    }
    default:
      return fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

/**
 * The plugin's hook in a project that also has `jevmem init` hooks: do nothing (the init hooks do the work), log it
 * once a day, and return a warning for the user once per session (shown on UserPromptSubmit).
 */
function standDown(root: string, input: HookInput, event: string): string | null {
  const stateFile = path.join(root, ".jevmem", "state.json");
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    /* none yet */
  }
  const today = new Date().toISOString().slice(0, 10);
  const next = { ...state };
  if (state.pluginStandDownLogged !== today) {
    appendLog(root, { ts: new Date().toISOString(), label: "hook", event: "plugin-standdown", ok: true, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, detail: "the jevmem plugin and `jevmem init` hooks are both registered; the plugin's hooks stand down" });
    next.pluginStandDownLogged = today;
  }
  let warning: string | null = null;
  const session = input.session_id ?? "unknown";
  if (event === "UserPromptSubmit" && state.pluginStandDownWarned !== session) {
    warning = "jevmem: this project has both the jevmem plugin and `jevmem init` hooks. The plugin's hooks are standing down so nothing runs twice. To keep only the plugin, run `jevmem init --remove-hooks`; to keep only the init hooks, disable the plugin.";
    next.pluginStandDownWarned = session;
  }
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(next, null, 2));
  } catch {
    /* best effort */
  }
  return warning;
}

/**
 * `jevmem enable`'s one next step: the key when none is found (the one fix for every install), the hooks when neither a
 * jevmem plugin nor `jevmem init` hooks are found, or nothing to do.
 */
function enableNextStep(root: string): string {
  if (!resolveJevKey(root)) return "Next: run jevmem key in a terminal and paste your TypeSafe API key (get one at https://console.typesafe.ai/keys).";
  if (!hasActivePlugin(pluginInstalls(root)) && !projectHasInitHooks(root)) return "Next: run jevmem init --tool claude to register the Claude Code hooks (no jevmem plugin or init hooks found).";
  return "Memory starts with your next prompt in Claude Code.";
}

/** `jevmem doctor`'s always-on line (0.7.2): the mode, the lines served at session start, the ones awaiting a gate verdict or withheld. */
function alwaysOnStatus(root: string): string {
  const cfg = loadConfig(root);
  const mode = cfg.alwaysOn?.mode ?? DEFAULT_CONFIG.alwaysOn.mode;
  if (mode === "off") return "mode off (alwaysOn.mode): nothing at session start";
  const a = alwaysOnServed(root, new MemoryStore(root, cfg.memoryFile).list(), mode, cfg.alwaysOn?.maxLines ?? DEFAULT_CONFIG.alwaysOn.maxLines, cfg.thresholds.injectionMax);
  const served = a.lines.length + a.more;
  return `mode ${mode}: ${served} line(s) at the start of every session${a.more ? ` (${a.lines.length} shown, alwaysOn.maxLines)` : ""}${a.pending.length ? `, ${a.pending.length} not yet (no gate verdict: the next prompt asks, or \`jevmem audit --security\` now)` : ""}${a.withheld.length ? `, ${a.withheld.length} withheld by the poisoning gate` : ""}`;
}

/** `jevmem doctor`'s guard line: the mode and how many [constraint] lines are enforced. */
function guardStatus(root: string): string {
  const conf = readGuardConfig(root);
  if (!conf.ok) return `makes no decision: ${conf.error}`;
  const cfg = conf.cfg;
  if (cfg.enabled === false) return 'off ("enabled": false in jevmem.config.json)';
  let text = "";
  try {
    text = fs.readFileSync(path.join(root, cfg.memoryFile), "utf8");
  } catch {
    /* no JEVMEM.md yet */
  }
  const rules = loadRules(root, cfg, text);
  const pending = rules.skipped.filter((r) => r.reason.startsWith("no gate verdict")).length;
  const held = rules.skipped.filter((r) => r.reason.startsWith("withheld")).length;
  const mode = cfg.guard.mode === "off" ? "off (the PreToolUse hook does nothing)" : cfg.guard.mode;
  const unverified = rules.enforced.filter((r) => !r.verified).length;
  const problems = conf.problems.map((p) => `; ${p}`).join("");
  return `mode ${mode} (guard.mode); ${rules.enforced.length} active [constraint] rule(s) enforced${unverified && cfg.guard.mode === "block" ? ` (${unverified} unverified: asked about, not denied)` : ""}${pending ? `, ${pending} not yet (no gate verdict: \`jevmem audit --security\` checks them now)` : ""}${held ? `, ${held} withheld by the poisoning gate` : ""}${problems}`;
}

/**
 * `jevmem doctor`'s cli lines: the jevmem each hook runs and whether it has the guard. It need not be the one running
 * doctor: `jevmem init` registered absolute paths, and the plugin runs the `jevmem` its launcher finds.
 */
function hookCliLines(root: string, plugin: boolean): string[] {
  const self = (() => {
    try {
      return fs.realpathSync(process.argv[1] ?? "");
    } catch {
      return null;
    }
  })();
  const describe = (c: ReturnType<typeof checkCli>) => {
    if (!c.real) return `${c.path}, which does not exist`;
    const name = `${c.path}${c.real !== c.path ? ` (→ ${c.real})` : ""}${c.real === self ? ", this jevmem" : ""}`;
    const version = c.version ? `jevmem ${c.version}` : "a jevmem of unknown version";
    return `${name}: ${version}, ${c.hasGuard === null ? "which failed `guard --help` for another reason, so it could not be checked" : c.hasGuard ? "with the guard" : "too old for the guard"}`;
  };
  const out: string[] = [];
  const tag = () => (out.length ? "         " : "cli      ");
  for (const h of initHookClis(root)) {
    if (!h.cli) {
      out.push(`${tag()}\`jevmem init\` hooks (${h.events.join(", ")}) run a command jevmem did not write (${h.command}): not checked`);
      continue;
    }
    const c = checkCli(h.cli, h.node);
    out.push(`${tag()}\`jevmem init\` hooks (${h.events.join(", ")}) run ${describe(c)}`);
    if (!c.real) out.push("         ! these hooks fail on every event: run `jevmem init` again to point them at a jevmem that exists");
    else if (h.direct && h.node && !fs.existsSync(h.node)) out.push(`         ! these hooks run ${h.node}, which does not exist, so they fail on every event: run \`jevmem init\` again`);
    else if (c.hasGuard === false && h.events.includes("PreToolUse"))
      out.push("         ! that jevmem reads every Bash, Edit and Write call as a finished turn: run `jevmem init --remove-hooks`, then `jevmem init` with the jevmem the hooks should run");
  }
  if (plugin) {
    // The launcher's search with this shell's PATH; the desktop app's bare PATH can find another one, or its cached path.
    const found = pluginLauncherCli();
    if (!found) out.push(`${tag()}with this PATH the plugin finds no jevmem, on PATH or in its list of directories (it may have one cached from an earlier session)`);
    else {
      const c = checkCli(found);
      out.push(`${tag()}with this PATH the plugin runs ${describe(c)}${c.hasGuard === false ? ", so it skips its PreToolUse hook: no guard in plugin sessions" : ""}`);
    }
  }
  return out;
}

/** Is version a older than b (x.y.z, numeric)? */
export function isOlder(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  return false;
}

function cliFile(): string {
  return fs.realpathSync(process.argv[1] ?? new URL(import.meta.url).pathname);
}

/** The hook JSON the launcher saved; the file is removed after reading. */
function readInputFile(file: string): HookInput {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8").trim();
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return { message: raw };
  }
}

/**
 * The Stop hook's whole job since v0.5.0: capture the turn, append it (scrubbed) to .jevmem/queue.jsonl, and ask the
 * daemon to evaluate the queue, without waiting for the answer. A daemon that is not running is started (it evaluates
 * the queue as it starts); an older one without the `drain` request is stopped and replaced. With the daemon off, the
 * queue is evaluated here (the Stop hook is async, so nobody waits for it).
 */
/** `jevmem doctor`'s line for a project with a `.cursor/` folder. */
function cursorDoctorLine(root: string): string {
  const st = cursorHooksStatus(root);
  const mcp = (() => {
    try {
      return Boolean(JSON.parse(fs.readFileSync(path.join(root, ".cursor", "mcp.json"), "utf8"))?.mcpServers?.jevmem);
    } catch {
      return false;
    }
  })();
  const rule = fs.existsSync(path.join(root, ".cursor", "rules", "jevmem.mdc"));
  const parts: string[] = [];
  // 0.7.6: the plugin, known from the marker its sessionStart hook writes on this computer.
  const plugin = readCursorPluginMarker();
  if (plugin) parts.push(`the jevmem plugin for Cursor (${plugin.version}) ran on this computer last on ${plugin.seen.slice(0, 10) || "an unknown day"}${st.events.length ? ": this project has its own jevmem hooks in .cursor/hooks.json too, so the plugin stands down here (jevmem init --remove-hooks keeps the plugin alone)" : ": it saves each finished agent turn here, serves memory over MCP in every window and carries the rule"}`);
  if (st.events.length === CURSOR_HOOK_EVENTS.length && st.launcher === "current") parts.push("hooks in .cursor/hooks.json (sessionStart, beforeSubmitPrompt, afterAgentResponse, stop, sessionEnd) with the launcher .cursor/hooks/jevmem-hook.sh: each finished agent turn is saved");
  else if (st.events.length) parts.push(`hooks in .cursor/hooks.json for ${st.events.join(", ")} only${st.launcher === "missing" ? ", and no launcher at .cursor/hooks/jevmem-hook.sh" : st.launcher === "stale" ? ", with an older launcher" : ""}: run \`jevmem init --tool cursor\` to complete them`);
  else if (!plugin) parts.push("no jevmem hooks in .cursor/hooks.json: turns are not saved in Cursor until `jevmem init --tool cursor` adds them (0.7.4), or the jevmem plugin for Cursor is installed (0.7.6)");
  // The CLI the launcher last ran (its cache), and whether it is this one: Cursor gives its hooks its own PATH.
  try {
    const [cli] = fs.readFileSync(path.join(root, ".jevmem", "cursor-launcher"), "utf8").split("\n");
    if (cli) {
      const v = spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 5000 }).stdout?.trim() ?? "";
      parts.push(`the launcher last ran ${cli.replace(os.homedir(), "~")}${v ? ` (${v}${v !== PACKAGE_VERSION ? `, not this ${PACKAGE_VERSION}` : ""})` : ""}${v && v < "0.7.4" ? ": a jevmem before 0.7.4 ignores Cursor's hooks, so turns are not saved until it is updated" : ""}`);
    }
  } catch {
    /* no cache yet */
  }
  if (mcp) parts.push(cursorMcpState(root));
  else if (!plugin) parts.push("no jevmem server in .cursor/mcp.json");
  if (rule) parts.push("the rule .cursor/rules/jevmem.mdc");
  else if (!plugin) parts.push("no rule file");
  if (projectHasInitHooks(root)) parts.push("Cursor also runs this project's Claude Code hooks (.claude/settings*.json) with its own event names, which jevmem ignores there, so nothing runs twice");
  return parts.join("; ");
}

/**
 * 0.7.5 (fix b): the Cursor app starts a project's MCP server only after its source toggle (Customize > MCPs > jevmem >
 * Configure), and until then the agent cannot read memory over MCP. The app keeps one folder per started server under
 * `~/.cursor/projects/<slug>/mcps/`, the slug being the project path with `/` as `-` (read on Cursor 3.25.9, 2026-10-17;
 * a project server's folder is `project-…-jevmem`). No project folder: the app has not opened the project.
 */
function cursorMcpState(root: string): string {
  const slugs = new Set([root, (() => { try { return fs.realpathSync(root); } catch { return root; } })()].map((p) => p.replace(/^[/\\]+/, "").replace(/[/\\:]+/g, "-")));
  const dirs = [...slugs].map((slug) => path.join(os.homedir(), ".cursor", "projects", slug)).filter((d) => fs.existsSync(d));
  if (!dirs.length) return "MCP server in .cursor/mcp.json (this project has not been opened in the Cursor app yet)";
  const started = dirs.some((d) => {
    try {
      return fs.readdirSync(path.join(d, "mcps")).some((name) => /jevmem/i.test(name));
    } catch {
      return false;
    }
  });
  return started ? "MCP server in .cursor/mcp.json, started by the Cursor app" : "the Cursor app has not started this project's MCP server yet: turn it on once (Customize > MCPs > jevmem > Configure > the source toggle for .cursor/mcp.json, then Reload); until then the agent cannot read memory over MCP";
}

/**
 * The Cursor hooks (0.7.4): what each event does is in src/cursor.ts. Every path exits 0; `beforeSubmitPrompt` always
 * answers `{"continue": true}`, since a hook answer Cursor cannot read could hold a prompt back.
 */
async function cursorHook(root: string, input: any, io: CliIo, viaPlugin = false): Promise<number> {
  const event = String(input?.hook_event_name ?? "");
  const answer = (o: Record<string, unknown> | null) => {
    if (o) io.out(JSON.stringify(o) + "\n");
  };
  const minimal = () => answer(event === "beforeSubmitPrompt" ? { continue: true } : null);
  try {
    if (!isCursorPayload(input) || !(CURSOR_HOOK_EVENTS as readonly string[]).includes(event) || !isEnabled(root)) {
      minimal();
      return 0;
    }
    loadEnvFallbacks(root);
    const cfg = loadConfig(root);
    if (cfg.enabled === false) {
      minimal();
      return 0;
    }
    // 0.7.6: the plugin's hooks beside a project's own jevmem hooks (`jevmem init --tool cursor`'s) stand down, so
    // a turn is decided once; one log line a day says so.
    if (viaPlugin && cursorHooksStatus(root).events.length) {
      cursorPluginStandDown(root);
      minimal();
      return 0;
    }
    const conversation = String(input.conversation_id ?? input.session_id ?? "");
    const generation = typeof input.generation_id === "string" ? input.generation_id : null;
    const log = (detail: string, ok = true) => appendLog(root, { ts: new Date().toISOString(), label: "cursor", ok, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, detail: `${event}: ${detail}` });
    if (event === "sessionStart") {
      // Once per conversation: Cursor fires it once per new chat, and a second firing must not add the lines twice.
      if (conversation && wasServed(root, conversation)) {
        log("already served this conversation");
        return 0;
      }
      const ss = sessionStartOutcome(new MemoryStore(root, cfg.memoryFile), cfg, conversation || null);
      let context: string | null = null;
      try {
        context = ss.stdout ? (JSON.parse(ss.stdout)?.hookSpecificOutput?.additionalContext ?? null) : null;
      } catch {
        /* no context */
      }
      if (context) answer({ additional_context: context });
      log(`${ss.action}: ${ss.detail}`);
      return 0;
    }
    if (event === "beforeSubmitPrompt") {
      if (conversation) stashPrompt(root, conversation, generation, String(input.prompt ?? ""));
      answer({ continue: true });
      return 0;
    }
    if (event === "afterAgentResponse") {
      if (conversation && typeof input.text === "string") stashResponse(root, conversation, generation, input.text);
      answer({});
      return 0;
    }
    // stop and sessionEnd: a finished turn, or nothing.
    const finished = event === "stop" ? input.status === "completed" : input.reason === "completed";
    if (!finished) {
      if (conversation) dropStash(root, conversation);
      log(`${event === "stop" ? `status ${input.status}` : `reason ${input.reason}`}: nothing decided`);
      return 0;
    }
    if (!hasJevKey()) {
      log("no TypeSafe key: the turn is not decided", false);
      return 0;
    }
    keyFound(root);
    const { turn, reason } = cursorTurnFromInput(root, input);
    if (!turn) {
      log(reason);
      return 0;
    }
    const stopInput: HookInput = { hook_event_name: "Stop", session_id: turn.session, cwd: root, user_message: turn.user, assistant_message: turn.assistant, recent_context: turn.previous, source: turn.source };
    const useDaemon = daemonEnabled(cfg) && hasJevKey();
    const out = await handOffStop(root, cfg, stopInput, "Stop", useDaemon);
    markDecided(root, turn.session, turn.turn);
    log(`${reason} (${turn.source}) → ${out.action}: ${out.detail}`);
    return 0;
  } catch (err) {
    try {
      logHookProblem(root, `cursor ${event}`, err instanceof Error ? err.message : String(err));
    } catch {
      /* nothing to do */
    }
    minimal();
    return 0;
  }
}

/** The Cursor plugin's stand-down beside project hooks (0.7.6): one log line a day, kept in .jevmem/state.json as the Claude plugin's is. */
function cursorPluginStandDown(root: string): void {
  const stateFile = path.join(root, ".jevmem", "state.json");
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    /* none yet */
  }
  const today = new Date().toISOString().slice(0, 10);
  if (state.cursorPluginStandDownLogged === today) return;
  appendLog(root, { ts: new Date().toISOString(), label: "cursor", event: "cursor-plugin-standdown", ok: true, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, detail: "the jevmem plugin for Cursor and this project's own jevmem hooks (.cursor/hooks.json) are both here; the plugin's hooks stand down, so nothing is decided twice (jevmem init --remove-hooks keeps the plugin alone)" });
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, cursorPluginStandDownLogged: today }));
  } catch {
    /* the log line is what matters */
  }
}

async function handOffStop(root: string, cfg: ReturnType<typeof loadConfig>, input: HookInput, event: string, useDaemon: boolean): Promise<HookOutcome> {
  // The turns that are over: earlier turns that waited for their background subagents, then this one unless it is still
  // running (src/turns.ts).
  const cap = captureTurns(input, root, event);
  // A turn kept while its subagents work needs a daemon to look at it if the session goes quiet (src/turns.ts).
  if (!cap.turns.length && !(useDaemon && deferredTurns(root).length)) return cap.outcome!;
  let pending = 0;
  for (const t of cap.turns) pending = enqueueTurn(root, t);
  const current = cap.turns.find((t) => t.current);
  if (!useDaemon) {
    const jev = createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, timeoutMs: cfg.jev.timeoutMs, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention });
    const r = await drainTurns(root, cfg, jev);
    const mine = current ? r.processed.find((p) => p.turn.hash === current.hash)?.outcome : undefined;
    const s = summarizeLog(jev.log);
    const summary = `${s.calls} jev call(s), p50 ${s.p50LatencyMs} ms, ${s.totalTokens} tokens, $${s.totalCostUsd.toFixed(6)}`;
    if (!current) return { ...cap.outcome!, summary, via: "inline" };
    if (mine) return { ...mine, summary, via: "inline" };
    return { event, action: "queued", detail: r.blocked ? "queued; the oldest queued turn is waiting for a retry" : "queued", summary, via: "inline" };
  }
  const res = await daemonRequest(root, { type: "drain", client: jevFingerprint() }, { connectMs: 250, responseMs: 1500 });
  if (res && res.ok && res.type === "draining") return current ? { event, action: "queued", detail: `handed to the daemon (${res.pending} turn(s) queued)`, via: "daemon" } : { ...cap.outcome!, via: "daemon" };
  if (res) {
    // A daemon started with another key (it is exiting), or an older daemon (no `drain` request): replace it.
    await daemonRequest(root, { type: "stop" }, { connectMs: 250, responseMs: 1000 });
    await new Promise((r) => setTimeout(r, 200));
  }
  spawnDaemon(root, cliFile());
  if (!current) return { ...cap.outcome!, via: "daemon" };
  return { event, action: "queued", detail: `daemon starting; it evaluates the ${pending} queued turn(s)`, via: "daemon" };
}

/** Is there a person at a terminal to answer a question? Tests pass their own stdin, which is never a terminal. */
function isTerminal(opts: { stdin?: string; terminal?: TerminalIo }): boolean {
  return opts.terminal !== undefined || (opts.stdin === undefined && process.stdin.isTTY === true);
}

/** `jevmem trust`'s question, answered on the terminal. */
async function confirmOnTerminal(prompt: string): Promise<boolean> {
  const answer = (await readLine(prompt)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/** All of stdin, as text. */
function readAll(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/**
 * One line from the terminal: Enter ends it, Backspace deletes, Ctrl-C or Ctrl-D gives "". With `hidden` nothing typed
 * is echoed (the key); otherwise each character is (a yes or no).
 */
function readLine(prompt: string, opts: { hidden?: boolean } = {}): Promise<string> {
  if (termIo) {
    const term = termIo;
    io.err(prompt);
    return term.ask(prompt, opts).then((v) => {
      io.err("\n");
      return v;
    });
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let text = "";
    const done = (value: string) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      io.err("\n");
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(text);
        if (ch === "\u0003" || ch === "\u0004") return done("");
        if (ch === "\u007f" || ch === "\b") {
          if (text && !opts.hidden) io.err("\b \b");
          text = text.slice(0, -1);
        } else if (ch >= " ") {
          text += ch;
          if (!opts.hidden) io.err(ch);
        }
      }
    };
    // Raw mode (no echo) before the prompt appears, so a key pasted as soon as it shows is not echoed.
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    io.err(prompt);
  });
}

function fail(msg: string): number {
  io.err(msg + "\n");
  return 1;
}
class MissingKey extends Error {}
function requireKey(): void {
  if (!hasJevKey()) loadEnvFallbacks(io.cwd ?? process.cwd());
  if (!hasJevKey()) throw new MissingKey(missingKeyHelp({ configure: canConfigure(pluginInstalls(io.cwd ?? process.cwd())) }));
}
function printJevSummary(log: ReturnType<typeof readLog>): void {
  if (process.env.JEVMEM_VERBOSE !== "1") return;
  const s = summarizeLog(log);
  io.err(`jevmem: ${s.calls} jev call(s), p50 ${s.p50LatencyMs} ms, ${s.totalTokens} tokens, $${s.totalCostUsd.toFixed(6)}\n`);
}

