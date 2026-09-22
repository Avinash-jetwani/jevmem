#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { applyAudit, auditMemories, formatAuditTable } from "./audit.js";
import { loadConfig } from "./config.js";
import { DAEMON_VERSION, daemonEnabled, daemonRequest, pidFile, serveDaemon, spawnDaemon } from "./daemon.js";
import { readStdinJson, runHook } from "./hook.js";
import { init } from "./init.js";
import { createJev, hasJevKey, readLog, summarizeLog } from "./jev.js";
import { serveMcp } from "./mcp.js";
import { rankMemories } from "./recall.js";
import { MemoryStore } from "./store.js";
import { NEW_KINDS, type Kind } from "./types.js";

const HELP = `jevmem — Jev decides. The LLM writes one line. Your project never forgets.

Usage: jevmem <command> [options]

  init [--no-hooks] [--command "<cmd>"]   Create JEVMEM.md, jevmem.config.json, .jevmem/ and register Claude Code hooks
  hook                                    Claude Code hook entrypoint (reads the hook JSON from stdin)
  daemon [status|stop]                    Warm Jev client for the hook (auto-started by the hook; exits when idle)
  mcp                                     Start the stdio MCP server (search_memory, add_memory, list_memory, audit_memory)
  audit [--dry-run]                       Re-score every memory against the repo and flag [stale?] lines
  search <query> [--limit N]              Rank memories by relevance to a query (one Jev call)
  list [--all]                            Print memories (live by default)
  add <kind> <text>                       Append a memory line by hand (kinds: ${NEW_KINDS.join(", ")})
  log                                     Summarise .jevmem/log.jsonl (Jev latency and cost)

Env: TYPESAFE_API_KEY (required for Jev), OPENAI_API_KEY / ANTHROPIC_API_KEY (optional writer),
     JEVMEM_WRITER=openai|anthropic|none, JEVMEM_WRITER_MODEL, JEVMEM_VERBOSE=1, JEVMEM_DAEMON=0|1
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

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const cmd = args.shift();
  const root = process.cwd();

  switch (cmd) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return 0;
    case "-v":
    case "--version":
    case "version": {
      const pj = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      process.stdout.write(pj.version + "\n");
      return 0;
    }
    case "init": {
      const noHooks = flag(args, "--no-hooks");
      const command = opt(args, "--command");
      const r = init({ root, hooks: !noHooks, command, cliPath: process.argv[1] });
      for (const c of r.created) process.stdout.write(`  created  ${c}\n`);
      for (const s of r.skipped) process.stdout.write(`  kept     ${s}\n`);
      process.stdout.write(`\nHook command: ${r.command}\n`);
      if (!hasJevKey()) process.stdout.write(`\n! TYPESAFE_API_KEY is not set. The hook will no-op until it is. Get a key at https://typesafe.ai\n`);
      process.stdout.write(`\nNext: keep working in Claude Code. JEVMEM.md fills itself. Try \`jevmem list\`, \`jevmem search "<query>"\`, \`jevmem audit\`.\n`);
      return 0;
    }
    case "hook": {
      const input = await readStdinJson();
      const hookRoot = input.cwd && fs.existsSync(input.cwd) ? input.cwd : root;
      const cfg = loadConfig(hookRoot);
      const verbose = process.env.JEVMEM_VERBOSE === "1" || process.env.JEVMEM_DEBUG === "1";
      let out = null as Awaited<ReturnType<typeof runHook>> | null;
      const useDaemon = daemonEnabled(cfg) && hasJevKey();
      if (useDaemon) {
        const t0 = performance.now();
        const res = await daemonRequest(hookRoot, { type: "hook", input }, { connectMs: 250, responseMs: cfg.jev.timeoutMs + cfg.writer.timeoutMs + 2000 });
        if (res && res.ok && res.type === "hook") {
          out = res.outcome;
          if (out.summary) out.summary += ` (daemon round trip ${Math.round(performance.now() - t0)} ms)`;
        }
      }
      if (!out) {
        out = await runHook(input);
        if (useDaemon && out.action !== "noop") spawnDaemon(hookRoot, process.argv[1] ?? new URL(import.meta.url).pathname);
      }
      if (out.stdout) process.stdout.write(out.stdout + "\n");
      if (verbose) {
        if (out.summary) process.stderr.write(`jevmem: ${out.summary} via ${out.via}\n`);
        process.stderr.write(`jevmem ${out.event}: ${out.action} — ${out.detail}\n`);
      }
      return 0; // never block Claude Code
    }
    case "daemon": {
      const sub = args.shift() ?? "status";
      if (sub === "--serve" || sub === "serve") {
        await serveDaemon(root, { onListening: (s) => process.stderr.write(`jevmem daemon listening on ${s}\n`) });
        return -1;
      }
      if (sub === "start") {
        const alive = await daemonRequest(root, { type: "ping" });
        if (alive) return fail("daemon already running");
        spawnDaemon(root, process.argv[1] ?? "");
        process.stdout.write("daemon starting\n");
        return 0;
      }
      if (sub === "stop") {
        const r = await daemonRequest(root, { type: "stop" });
        process.stdout.write(r ? "daemon stopping\n" : "no daemon running\n");
        return 0;
      }
      const r = await daemonRequest(root, { type: "ping" });
      if (r && r.ok && r.type === "pong") process.stdout.write(`running: pid ${r.pid}, version ${r.version}${r.version !== DAEMON_VERSION ? " (outdated; run `jevmem daemon stop`)" : ""}, up ${Math.round(r.uptimeMs / 1000)} s, served ${r.served} request(s), socket ${JSON.parse(fs.readFileSync(pidFile(root), "utf8")).socket}\n`);
      else process.stdout.write("not running\n");
      return 0;
    }
    case "mcp":
      await serveMcp(root);
      return -1; // keep running
    case "audit": {
      const dry = flag(args, "--dry-run");
      requireKey();
      const cfg = loadConfig(root);
      const store = new MemoryStore(root, cfg.memoryFile);
      const jev = createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens });
      const rows = await auditMemories(jev, store, { staleBelow: cfg.thresholds.staleBelow });
      process.stdout.write(formatAuditTable(rows) + "\n");
      if (!dry) {
        applyAudit(store, rows);
        const n = rows.filter((r) => r.stale).length;
        process.stdout.write(`\n${n} line(s) marked [stale?] in ${cfg.memoryFile}\n`);
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
      const jev = createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens });
      const ranked = await rankMemories(jev, query, store.active(), { perCandidateNouls: true, maxIds: cfg.jev.maxIdsPerCall, label: "search" });
      for (const r of ranked.slice(0, limit)) {
        process.stdout.write(`${(r.relevance ?? r.choiceProbability).toFixed(2)}  ${r.choiceProbability.toFixed(2)}  [${r.memory.kind}] ${r.memory.text}  (${r.memory.id})\n`);
      }
      if (ranked.length === 0) process.stdout.write("no memories\n");
      printJevSummary(jev.log);
      return 0;
    }
    case "list": {
      const all = flag(args, "--all");
      const cfg = loadConfig(root);
      const store = new MemoryStore(root, cfg.memoryFile);
      const mems = all ? store.list() : store.active();
      for (const m of mems) process.stdout.write(`${m.id}  [${m.kind}]${m.stale !== undefined ? " [stale?]" : ""} ${m.text}${m.supersededBy ? ` → ${m.supersededBy}` : ""}\n`);
      if (mems.length === 0) process.stdout.write("no memories\n");
      return 0;
    }
    case "add": {
      const kind = args.shift() as Kind | undefined;
      const text = args.join(" ").trim();
      if (!kind || !(NEW_KINDS as readonly string[]).includes(kind) || !text) return fail(`usage: jevmem add <${NEW_KINDS.join("|")}> <text>`);
      const cfg = loadConfig(root);
      const store = new MemoryStore(root, cfg.memoryFile);
      const m = store.add({ kind, text: text.slice(0, cfg.writer.maxChars), conf: 1 });
      process.stdout.write(`added ${m.id}: [${m.kind}] ${m.text}\n`);
      return 0;
    }
    case "log": {
      const entries = readLog(root);
      const s = summarizeLog(entries);
      const byLabel = new Map<string, typeof entries>();
      for (const e of entries) byLabel.set(e.label, [...(byLabel.get(e.label) ?? []), e]);
      process.stdout.write(`${s.calls} call(s), ${s.ok} ok, p50 ${s.p50LatencyMs} ms, avg ${s.avgLatencyMs} ms, ${s.totalTokens} tokens, $${s.totalCostUsd.toFixed(6)} total\n`);
      for (const [label, es] of byLabel) {
        const ls = summarizeLog(es);
        process.stdout.write(`  ${label.padEnd(8)} ${String(ls.calls).padStart(4)} calls  p50 ${String(ls.p50LatencyMs).padStart(5)} ms  ${String(ls.totalTokens).padStart(7)} tokens  $${ls.totalCostUsd.toFixed(6)}\n`);
      }
      return 0;
    }
    default:
      return fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

function fail(msg: string): number {
  process.stderr.write(msg + "\n");
  return 1;
}
function requireKey(): void {
  if (!hasJevKey()) {
    process.stderr.write("TYPESAFE_API_KEY is not set. Get one at https://typesafe.ai and export it.\n");
    process.exit(1);
  }
}
function printJevSummary(log: ReturnType<typeof readLog>): void {
  if (process.env.JEVMEM_VERBOSE !== "1") return;
  const s = summarizeLog(log);
  process.stderr.write(`jevmem: ${s.calls} jev call(s), p50 ${s.p50LatencyMs} ms, ${s.totalTokens} tokens, $${s.totalCostUsd.toFixed(6)}\n`);
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err) => {
    process.stderr.write(`jevmem: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(path.basename(process.argv[2] ?? "") === "hook" ? 0 : 1);
  },
);
