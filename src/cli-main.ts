import fs from "node:fs";
import { applyAudit, auditMemories, formatAuditTable, formatSecurityTable, securityAudit } from "./audit.js";
import { knownWithheld, planGate } from "./guard.js";
import { isVerified, readProvenance } from "./provenance.js";
import { loadConfig } from "./config.js";
import { DAEMON_VERSION, daemonEnabled, daemonRequest, pidFile, serveDaemon, spawnDaemon } from "./daemon.js";
import { hookRoot, logHookProblem, readStdinJson, runHook } from "./hook.js";
import { loadEnvFallbacks } from "./env.js";
import { init } from "./init.js";
import { findDecision, formatFit, formatWhy, labelMissed, labelRight, labelWrong, MIN_LABELS, readFitInfo, readLabels, runFit } from "./labels.js";
import { detectTools, setupClaudeDesktop, setupCodex, setupCursor, TOOLS, type Tool } from "./tools.js";
import { watchCodex } from "./watch.js";
import { mergeTurn } from "./transcript.js";
import { createJev, hasJevKey, readLog, summarizeLog } from "./jev.js";
import { serveMcp } from "./mcp.js";
import { queueStats } from "./queue.js";
import { rankGuarded } from "./recall.js";
import { scrubSecrets } from "./scrub.js";
import { MemoryStore } from "./store.js";
import { NEW_KINDS, type Kind } from "./types.js";

const HELP = `jevmem — Automatic project memory for Claude Code. Also works with Cursor and Codex.

Usage: jevmem <command> [options]

  init [--tool claude|cursor|codex|claude-desktop|all] [--no-hooks] [--command "<cmd>"]
                                          Create JEVMEM.md, jevmem.config.json, .jevmem/ and set up the tool(s) (default: detect)
  <command> --help                        Help for one command
  hook                                    Claude Code hook entrypoint (reads the hook JSON from stdin)
  daemon [status|start|stop]              Warm Jev client for the hook (auto-started by the hook; exits when idle)
  mcp [--root <dir>]                      Start the stdio MCP server (search_memory, add_memory, list_memory, audit_memory)
  audit [--dry-run]                       Re-score every memory against the repo and flag [stale?] lines
  audit --security [--ci]                 List lines that read as instructions to an AI (--ci: exit 1 if any)
  search <query> [--limit N]              Rank memories by relevance to a query (one Jev call)
  list [--all]                            Print memories (live by default; --all adds superseded lines and provenance)
  add <kind> <text>                       Append a memory line by hand (kinds: ${NEW_KINDS.join(", ")})
  watch [--replay] [--once]               Capture turns from Codex's session log for this project (Cursor: use MCP)
  why <id|hash>                           Show every Jev answer behind a memory line or a skipped turn
  right <id|hash>                         Label the decision as correct
  wrong <id|hash> [--should-be <kind|none>] Label the decision as wrong
  missed "<text>"  [--kind <kind>]        Label a turn that should have been saved
  fit [--dry-run] [--force]               Refit weights and thresholds from labels (needs ${MIN_LABELS}+ labels)
  stats                                   Latency p50/p95, cost per day, cache hit rate, escalation rate, retry queue, labels, last fit
  log                                     Summarise .jevmem/log.jsonl (Jev latency and cost)

Env: TYPESAFE_API_KEY (required for Jev), OPENAI_API_KEY / ANTHROPIC_API_KEY (optional writer),
     JEVMEM_WRITER=openai|anthropic|none, JEVMEM_WRITER_MODEL, JEVMEM_VERBOSE=1, JEVMEM_DAEMON=0|1,
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

export const COMMANDS = ["init", "hook", "daemon", "mcp", "audit", "search", "list", "add", "why", "right", "wrong", "missed", "fit", "stats", "log", "watch"] as const;

export const COMMAND_HELP: Record<(typeof COMMANDS)[number], string> = {
  init: `jevmem init [--tool claude|cursor|codex|claude-desktop|all] [--no-hooks] [--command "<cmd>"]

Create JEVMEM.md, jevmem.config.json and .jevmem/ in the current directory and set up the chosen tool(s).
  --tool <list>     Comma-separated; default: detect from .claude/, .cursor/, AGENTS.md in this project (else claude).
                    ~/.codex/config.toml is edited only with an explicit --tool codex or --tool all.
  --no-hooks        Skip the Claude Code hook registration
  --command "<cmd>" Register this hook command instead of the resolved absolute node + cli.js path
Claude Code hooks go to .claude/settings.local.json (machine-specific paths); init adds it to .gitignore.
Re-running init repairs an existing jevmem hook command and moves one found in .claude/settings.json.
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

Latency p50/p95, cost per day, cache hit rate, tier-1/tier-2 counts and escalation rate, labels and last fit.
Retry queue: turns queued after a Jev failure (timeout, 5xx, 529), retries, turns saved from the queue, turns dropped
(older than 24 h or past 200 entries), and turns pending in .jevmem/queue.jsonl.
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
  const args = [...argv];
  const cmd = args.shift();
  const root = io.cwd ?? process.cwd();
  // `<cmd> --help` / `-h`: print that command's help and stop before anything runs.
  if (cmd && (COMMANDS as readonly string[]).includes(cmd) && wantsHelp(args)) {
    io.out(COMMAND_HELP[cmd as (typeof COMMANDS)[number]]);
    return 0;
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
    case "init": {
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
      if (tools.includes("claude")) io.out(`Claude Code hook command: ${r.command}\n`);
      for (const n of notes) io.out(`\n${n}\n`);
      if (!hasJevKey()) io.out(`\n! TYPESAFE_API_KEY is not set. Jevmem no-ops until it is. Get a key at https://typesafe.ai\n`);
      io.out(`\nNext: keep working. JEVMEM.md fills itself. Try \`jevmem list\`, \`jevmem search "<query>"\`, \`jevmem why <id>\`, \`jevmem stats\`.\n`);
      return 0;
    }
    case "hook": {
      // Everything in here is wrapped so the hook exits 0 on any failure; problems go to .jevmem/log.jsonl.
      let projectRoot = root;
      let event = "hook";
      try {
        const input = await readStdinJson();
        projectRoot = hookRoot(input);
        event = input.hook_event_name ?? event;
        loadEnvFallbacks(projectRoot); // desktop-app hooks get no shell profile
        const cfg = loadConfig(projectRoot);
        const verbose = process.env.JEVMEM_VERBOSE === "1" || process.env.JEVMEM_DEBUG === "1";
        let out = null as Awaited<ReturnType<typeof runHook>> | null;
        const useDaemon = daemonEnabled(cfg) && hasJevKey();
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
          if (useDaemon && out.action !== "noop") spawnDaemon(projectRoot, fs.realpathSync(process.argv[1] ?? new URL(import.meta.url).pathname));
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
      const mcpRoot = opt(args, "--root") ?? process.env.JEVMEM_ROOT ?? root;
      if (!fs.existsSync(mcpRoot)) return fail(`--root ${mcpRoot} does not exist`);
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
        const q = queueStats(root, allEntries);
        io.out(`retry queue: ${q.queued} queued after a Jev failure, ${q.retried} retries, ${q.savedFromQueue} saved from the queue (${q.skippedFromQueue} skipped by Jev), ${q.dropped} dropped, ${q.pending} pending\n`);
        const withheld = allEntries.filter((e) => e.event === "withheld").length;
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

function fail(msg: string): number {
  io.err(msg + "\n");
  return 1;
}
class MissingKey extends Error {}
function requireKey(): void {
  if (!hasJevKey()) loadEnvFallbacks(io.cwd ?? process.cwd());
  if (!hasJevKey()) throw new MissingKey("TYPESAFE_API_KEY is not set. Get one at https://typesafe.ai and export it.");
}
function printJevSummary(log: ReturnType<typeof readLog>): void {
  if (process.env.JEVMEM_VERBOSE !== "1") return;
  const s = summarizeLog(log);
  io.err(`jevmem: ${s.calls} jev call(s), p50 ${s.p50LatencyMs} ms, ${s.totalTokens} tokens, $${s.totalCostUsd.toFixed(6)}\n`);
}

