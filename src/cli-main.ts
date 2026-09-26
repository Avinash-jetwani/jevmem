import fs from "node:fs";
import path from "node:path";
import { applyAudit, auditMemories, formatAuditTable, formatSecurityTable, securityAudit } from "./audit.js";
import { knownWithheld, planGate } from "./guard.js";
import { isVerified, readProvenance } from "./provenance.js";
import { configuredWriter, isEnabled, loadConfig, NOT_ENABLED_MESSAGE } from "./config.js";
import { PACKAGE_VERSION } from "./version.js";
import { DAEMON_VERSION, daemonEnabled, daemonRequest, pidFile, serveDaemon, spawnDaemon } from "./daemon.js";
import { captureTurn, drainTurns, hookEvent, hookRoot, logHookProblem, readStdinJson, runHook, type HookInput, type HookOutcome } from "./hook.js";
import { applyPluginOption, loadEnvFallbacks, MISSING_KEY_HELP, resolveJevKey } from "./env.js";
import { resolveWriter } from "./llm/index.js";
import { writerOptInNotice } from "./notice.js";
import { collectCandidates, DEFAULT_IMPORT_SOURCES, formatImport, IMPORT_SOURCES, runImport, type ImportSource } from "./import.js";
import { disableProject, enableProject, init, projectEnablesPlugin, projectHasInitHooks, unregisterClaudeHooks } from "./init.js";
import { findDecision, formatFit, formatWhy, labelMissed, labelRight, labelWrong, MIN_LABELS, readFitInfo, readLabels, runFit } from "./labels.js";
import { detectTools, setupClaudeDesktop, setupCodex, setupCursor, TOOLS, type Tool } from "./tools.js";
import { watchCodex } from "./watch.js";
import { mergeTurn } from "./transcript.js";
import { appendLog, createJev, hasJevKey, readLog, summarizeLog } from "./jev.js";
import { serveMcp } from "./mcp.js";
import { enqueueTurn, queueStats } from "./queue.js";
import { rankGuarded } from "./recall.js";
import { scrubSecrets } from "./scrub.js";
import { MemoryStore } from "./store.js";
import { NEW_KINDS, type Kind } from "./types.js";

const HELP = `jevmem — Automatic project memory for Claude Code. Also works with Cursor and Codex.

Usage: jevmem <command> [options]

  init [--tool claude|cursor|codex|claude-desktop|all] [--no-hooks] [--command "<cmd>"]
                                          Create JEVMEM.md, jevmem.config.json, .jevmem/ and set up the tool(s) (default: detect)
  init --remove-hooks                     Remove jevmem's Claude Code hooks from this project (e.g. when using the plugin)
  enable                                  Opt this project in (plugin users): jevmem.config.json, JEVMEM.md, .jevmem/
  disable                                 Opt this project out: jevmem does nothing here (JEVMEM.md is kept)
  <command> --help                        Help for one command
  hook                                    Claude Code hook entrypoint (reads the hook JSON from stdin)
  daemon [status|start|stop]              Warm Jev client for the hook (auto-started by the hook; exits when idle)
  mcp [--root <dir>]                      Start the stdio MCP server (search_memory, add_memory, list_memory, audit_memory)
  audit [--dry-run]                       Re-score every memory against the repo and flag [stale?] lines
  audit --security [--ci]                 List lines that read as instructions to an AI (--ci: exit 1 if any)
  search <query> [--limit N]              Rank memories by relevance to a query (one Jev call)
  list [--all]                            Print memories (live by default; --all adds superseded lines and provenance)
  add <kind> <text>                       Append a memory line by hand (kinds: ${NEW_KINDS.join(", ")})
  import [--from <sources>] [--apply]     Import CLAUDE.md, AGENTS.md, .cursor/rules/* (dry run unless --apply)
  watch [--replay] [--once]               Capture turns from Codex's session log for this project (Cursor: use MCP)
  why <id|hash>                           Show every Jev answer behind a memory line or a skipped turn
  right <id|hash>                         Label the decision as correct
  wrong <id|hash> [--should-be <kind|none>] Label the decision as wrong
  missed "<text>"  [--kind <kind>]        Label a turn that should have been saved
  fit [--dry-run] [--force]               Refit weights and thresholds from labels (needs ${MIN_LABELS}+ labels)
  stats                                   Writer, latency p50/p95, cost per day, cache hit rate, escalation rate, retry queue, labels, last fit
  doctor                                  Is this project enabled, where the TypeSafe key comes from, which writer is active and why
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

export const COMMANDS = ["enable", "disable", "init", "hook", "daemon", "mcp", "audit", "search", "list", "add", "import", "why", "right", "wrong", "missed", "fit", "stats", "doctor", "log", "watch"] as const;

export const COMMAND_HELP: Record<(typeof COMMANDS)[number], string> = {
  enable: `jevmem enable

Opt this project in. jevmem (the Claude Code plugin's hooks and MCP server, or any jevmem hook) does nothing in a
project without jevmem.config.json: no network calls, no files. enable creates jevmem.config.json, JEVMEM.md and
.jevmem/, and adds .jevmem/ to .gitignore, like init, but registers no hooks. Commit jevmem.config.json and JEVMEM.md.
`,
  disable: `jevmem disable

Opt this project out: moves jevmem.config.json to .jevmem/jevmem.config.json.disabled (jevmem enable restores it) and
stops the daemon. From then on jevmem's hooks and MCP server do nothing here. JEVMEM.md is left untouched.
`,
  init: `jevmem init [--tool claude|cursor|codex|claude-desktop|all] [--no-hooks] [--command "<cmd>"]

Create JEVMEM.md, jevmem.config.json and .jevmem/ in the current directory and set up the chosen tool(s).
  --tool <list>     Comma-separated; default: detect from .claude/, .cursor/, AGENTS.md in this project (else claude).
                    ~/.codex/config.toml is edited only with an explicit --tool codex or --tool all.
  --no-hooks        Skip the Claude Code hook registration
  --command "<cmd>" Register this hook command instead of the resolved absolute node + cli.js path
Claude Code hooks go to .claude/settings.local.json (machine-specific paths); init adds it to .gitignore.
Re-running init repairs an existing jevmem hook command and moves one found in .claude/settings.json.
  --remove-hooks    Only remove jevmem's hooks from .claude/settings.local.json and .claude/settings.json (for
                    projects that use the jevmem Claude Code plugin instead). Nothing else is touched.
With the Claude Code plugin installed you do not need init: the plugin's hooks and MCP server work in every project.
If a project has both, the plugin's hooks stand down and say so once per session.
`,
  hook: `jevmem hook

Claude Code hook entrypoint. Reads the hook event JSON (Stop or UserPromptSubmit) from stdin and exits 0 on any failure.
Registered by \`jevmem init\`; not meant to be run by hand. JEVMEM_VERBOSE=1 prints a summary, JEVMEM_DEBUG=1 logs payloads.
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

Print live memories (id, kind, text). --all includes superseded lines and shows each line's provenance:
verified (jevmem wrote this exact text on this machine) or unverified (hand-written, from git, or jevmem add),
and whether the poisoning gate withheld it.
`,
  add: `jevmem add <kind> <text>

Append one memory line by hand. kind: decision | constraint | preference | bug | architecture | todo.
Secrets are scrubbed; there is no Jev check (you typed it).
`,
  import: `jevmem import [--from claude-md,agents-md,cursor-rules,claude-auto-memory] [--apply] [--memory-dir <dir>]

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
`,
  why: `jevmem why <memory id | turn hash>

Show every Jev answer behind a saved line or a skipped turn: tier 1 nouls, tier 2 nouls and family scores if it ran,
the kind distribution, importance, content source, and which thresholds were cleared.
`,
  right: `jevmem right <memory id | turn hash>

Label the decision as correct. Appends to .jevmem/labels.jsonl for \`jevmem fit\`.
`,
  wrong: `jevmem wrong <memory id | turn hash> [--should-be <kind|none>]

Label the decision as wrong. Default: the opposite of what happened. --should-be none removes the saved line.
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
`,
  doctor: `jevmem doctor

Checks this project's setup and prints it. Never prints a key.
  project   enabled (jevmem.config.json present) or not
  key       where the TypeSafe key comes from: the plugin setting, the environment, <project>/.jevmem/.env or
            ~/.jevmem/env, and where to put it when none is found
  writer    which one-line writer is active and why. The LLM writer runs only when jevmem.config.json sets
            "writer": "openai" or "anthropic" and that provider's key is set; otherwise jevmem writes the line itself
  hooks     the Claude Code plugin enabled in project settings, and hooks registered by \`jevmem init\`
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

export async function main(argv: string[], ioArg: CliIo = defaultIo): Promise<number> {
  io = ioArg;
  applyPluginOption(); // the Claude Code plugin's typesafe_api_key option comes first
  const args = [...argv];
  const cmd = args.shift();
  const root = io.cwd ?? process.cwd();
  // `<cmd> --help` / `-h`: print that command's help and stop before anything runs.
  if (cmd && (COMMANDS as readonly string[]).includes(cmd) && wantsHelp(args)) {
    io.out(COMMAND_HELP[cmd as (typeof COMMANDS)[number]]);
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
      for (const k of r.skipped) io.out(`  kept     ${k}\n`);
      io.out(`\njevmem is enabled in this project. With the Claude Code plugin installed, it starts with your next prompt; without it, run \`jevmem init\` to register the hooks.\n`);
      if (!resolveJevKey(root)) io.out(`\n! ${MISSING_KEY_HELP.replace(/\n/g, "\n  ")}\n`);
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
        const removed = unregisterClaudeHooks(root);
        io.out(removed.length ? `removed jevmem's hooks from ${removed.join(", ")}\n` : "no jevmem hooks in .claude/settings.local.json or .claude/settings.json\n");
        return 0;
      }
      const noHooks = flag(args, "--no-hooks");
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
      for (const k of r.skipped) io.out(`  kept     ${k}\n`);
      const notes: string[] = [];
      for (const t of tools) {
        const res =
          t === "cursor"
            ? setupCursor(root)
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
      if (tools.includes("claude") && !noHooks) io.out(`Claude Code hooks:\n  UserPromptSubmit  ${r.command}\n  Stop (async)      ${r.stopCommand}\n`);
      for (const n of notes) io.out(`\n${n}\n`);
      for (const w of r.warnings) io.out(`\n! ${w}\n`);
      if (!resolveJevKey(root)) io.out(`\n! ${MISSING_KEY_HELP.replace(/\n/g, "\n  ")}\n`);
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
        const input = stdinFile ? readInputFile(stdinFile) : await readStdinJson();
        projectRoot = hookRoot(input);
        event = hookEvent(input);
        // Opt-in per project: without jevmem.config.json, do nothing at all (no key lookup, no log, no network).
        if (!isEnabled(projectRoot)) return 0;
        // Plugin and `jevmem init` hooks in the same project would both fire on every event: the plugin's stand down.
        if (viaPlugin && projectHasInitHooks(projectRoot)) {
          const warning = standDown(projectRoot, input, event);
          if (warning) io.out(JSON.stringify({ systemMessage: warning }) + "\n");
          return 0;
        }
        loadEnvFallbacks(projectRoot); // desktop-app hooks get no shell environment: .jevmem/.env, ~/.jevmem/env
        const cfg = loadConfig(projectRoot);
        if (cfg.enabled === false) return 0; // switched off for this project in jevmem.config.json
        // Shown to the user on the first prompt after the upgrade (the Stop hook's output is not shown).
        const notice = event === "UserPromptSubmit" ? writerOptInNotice(projectRoot) : null;
        const verbose = process.env.JEVMEM_VERBOSE === "1" || process.env.JEVMEM_DEBUG === "1";
        let out = null as Awaited<ReturnType<typeof runHook>> | null;
        const useDaemon = daemonEnabled(cfg) && hasJevKey();
        if (event !== "UserPromptSubmit" && hasJevKey()) {
          // Stop: queue the turn and hand it to the daemon; never wait for Jev here.
          out = await handOffStop(projectRoot, cfg, input, event, useDaemon);
        } else {
          if (useDaemon) {
            const t0 = performance.now();
            const res = await daemonRequest(projectRoot, { type: "hook", input }, { connectMs: 250, responseMs: cfg.jev.timeoutMs + cfg.writer.timeoutMs + 2000 });
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
      const mcpRoot = opt(args, "--root") ?? process.env.JEVMEM_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? root;
      if (!fs.existsSync(mcpRoot)) return fail(`--root ${mcpRoot} does not exist`);
      const pluginVersion = process.env.JEVMEM_PLUGIN_VERSION;
      if (pluginVersion && isOlder(PACKAGE_VERSION, pluginVersion)) io.err(`jevmem: the installed CLI is ${PACKAGE_VERSION}, older than the Claude Code plugin (${pluginVersion}); run: npm install -g jevmem\n`);
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
        const status = prov ? `${(isVerified(prov, m) ? "verified" : "unverified").padEnd(10)}${held!.has(m.id) ? " WITHHELD" : ""}  ` : "";
        io.out(`${m.id}  ${status}[${m.kind}]${m.stale !== undefined ? " [stale?]" : ""} ${m.text}${m.supersededBy ? ` → ${m.supersededBy}` : ""}\n`);
      }
      if (mems.length === 0) io.out("no memories\n");
      if (all && mems.length) io.out(`\nverified: jevmem wrote this exact text on this machine. unverified lines go through the poisoning gate before any agent sees them.\n`);
      return 0;
    }
    case "add": {
      const kind = args.shift() as Kind | undefined;
      const text = args.join(" ").trim();
      if (!kind || !(NEW_KINDS as readonly string[]).includes(kind) || !text) return fail(`usage: jevmem add <${NEW_KINDS.join("|")}> <text>`);
      const cfg = loadConfig(root);
      const store = new MemoryStore(root, cfg.memoryFile);
      // Typed by a person, so no Jev check; secrets are still scrubbed because JEVMEM.md is committed.
      const m = store.add({ kind, text: scrubSecrets(text).slice(0, cfg.writer.maxChars), conf: 1 });
      io.out(`added ${m.id}: [${m.kind}] ${m.text}\n`);
      return 0;
    }
    case "import": {
      const apply = flag(args, "--apply");
      const memoryDir = opt(args, "--memory-dir");
      const fromArg = opt(args, "--from");
      const sources = (fromArg ? fromArg.split(",").map((x) => x.trim()) : DEFAULT_IMPORT_SOURCES) as ImportSource[];
      const bad = sources.filter((x) => !(IMPORT_SOURCES as readonly string[]).includes(x));
      if (bad.length) return fail(`unknown source(s): ${bad.join(", ")}. Choose from ${IMPORT_SOURCES.join(", ")}`);
      requireKey();
      const cfg = loadConfig(root);
      const store = new MemoryStore(root, cfg.memoryFile);
      const { candidates, files, notFound } = collectCandidates(root, sources, { memoryDir, maxChars: cfg.writer.maxChars });
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
      const entries = allEntries.filter((e) => !e.event); // Jev calls only; queue and gate events are counted below
      const s = summarizeLog(entries);
      const byLabel = new Map<string, typeof entries>();
      for (const e of entries) byLabel.set(e.label, [...(byLabel.get(e.label) ?? []), e]);
      io.out(`${s.calls} call(s), ${s.ok} ok, ${s.cacheHits} cache hit(s) (${(s.cacheHitRate * 100).toFixed(0)}%), p50 ${s.p50LatencyMs} ms, p95 ${s.p95LatencyMs} ms, ${s.totalTokens} tokens, $${s.totalCostUsd.toFixed(6)} total\n`);
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
        const withheld = new Set(allEntries.filter((e) => e.event === "withheld").map((e) => e.memoryId)).size;
        if (withheld) io.out(`poisoning gate: ${withheld} line(s) withheld from recall (see \`jevmem audit\`)\n`);
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
      io.out(source ? `key      TypeSafe key found (${source})\n` : `key      ${MISSING_KEY_HELP.replace(/\n/g, "\n         ")}\n`);
      loadEnvFallbacks(root); // the writer keys may live in .jevmem/.env or ~/.jevmem/env even when TYPESAFE_API_KEY doesn't
      const w = resolveWriter(loadConfig(root).writer);
      io.out(`writer   ${w.provider === "none" ? "jevmem (local, no LLM)" : `${w.provider} (${w.model})`}: ${w.reason}\n`);
      const forced = process.env.JEVMEM_WRITER?.trim().toLowerCase();
      if (forced && forced !== "none") io.out(`         JEVMEM_WRITER=${forced} is ignored: only "writer" in jevmem.config.json turns the LLM writer on\n`);
      if (configuredWriter(root) === "auto") io.out(`         jevmem.config.json has the pre-0.5.4 "writer": {"provider": "auto"}, which now means no LLM writer\n`);
      const hooks = [projectEnablesPlugin(root) ? "plugin enabled in project settings" : null, projectHasInitHooks(root) ? "`jevmem init` hooks in .claude/settings.local.json" : null].filter(Boolean);
      io.out(`hooks    ${hooks.length ? hooks.join("; ") : "no plugin setting or init hooks in this project (a plugin installed at user scope is not visible here)"}\n`);
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
      if (cmd === "right") {
        const n = labelRight(root, rec);
        io.out(`labelled as correct (${rec.decision.save ? `saved as ${rec.decision.kind}` : "skipped"}). ${n} label(s) total.\n`);
      } else {
        const { count, label } = labelWrong(root, rec, shouldBe);
        io.out(`labelled: should ${label.save ? `have been saved as ${label.kind}` : "not have been saved"}. ${count} label(s) total.\n`);
        if (rec.decision.save && !label.save && rec.memoryId) {
          const store = new MemoryStore(root, cfg.memoryFile);
          if (store.remove(rec.memoryId)) io.out(`removed ${rec.memoryId} from ${cfg.memoryFile}\n`);
        }
      }
      new MemoryStore(root, cfg.memoryFile).touchFooter();
      return 0;
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
      const m = store.add({ kind: label.kind as Kind, text: scrubSecrets(text).slice(0, cfg.writer.maxChars), conf: decision.confidence });
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
      if (tool !== "codex") return fail(`watch supports --tool codex only. Cursor keeps chats in a SQLite database (state.vscdb) with no text log; use the MCP add_memory path (jevmem init --tool cursor).`);
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
async function handOffStop(root: string, cfg: ReturnType<typeof loadConfig>, input: HookInput, event: string, useDaemon: boolean): Promise<HookOutcome> {
  const cap = captureTurn(input, root, event);
  if ("outcome" in cap) return cap.outcome;
  const pending = enqueueTurn(root, cap.turn);
  if (!useDaemon) {
    const jev = createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, timeoutMs: cfg.jev.timeoutMs, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention });
    const r = await drainTurns(root, cfg, jev);
    const mine = r.processed.find((p) => p.turn.hash === cap.turn.hash)?.outcome;
    const s = summarizeLog(jev.log);
    const summary = `${s.calls} jev call(s), p50 ${s.p50LatencyMs} ms, ${s.totalTokens} tokens, $${s.totalCostUsd.toFixed(6)}`;
    if (mine) return { ...mine, summary, via: "inline" };
    return { event, action: "queued", detail: r.blocked ? "queued; the oldest queued turn is waiting for a retry" : "queued", summary, via: "inline" };
  }
  const res = await daemonRequest(root, { type: "drain" }, { connectMs: 250, responseMs: 1500 });
  if (res && res.ok && res.type === "draining") return { event, action: "queued", detail: `handed to the daemon (${res.pending} turn(s) queued)`, via: "daemon" };
  if (res) {
    // An older daemon (no `drain` request): replace it.
    await daemonRequest(root, { type: "stop" }, { connectMs: 250, responseMs: 1000 });
    await new Promise((r) => setTimeout(r, 200));
  }
  spawnDaemon(root, cliFile());
  return { event, action: "queued", detail: `daemon starting; it evaluates the ${pending} queued turn(s)`, via: "daemon" };
}

function fail(msg: string): number {
  io.err(msg + "\n");
  return 1;
}
class MissingKey extends Error {}
function requireKey(): void {
  if (!hasJevKey()) loadEnvFallbacks(io.cwd ?? process.cwd());
  if (!hasJevKey()) throw new MissingKey(MISSING_KEY_HELP);
}
function printJevSummary(log: ReturnType<typeof readLog>): void {
  if (process.env.JEVMEM_VERBOSE !== "1") return;
  const s = summarizeLog(log);
  io.err(`jevmem: ${s.calls} jev call(s), p50 ${s.p50LatencyMs} ms, ${s.totalTokens} tokens, $${s.totalCostUsd.toFixed(6)}\n`);
}

