import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applyAudit, auditMemories, formatAuditTable } from "./audit.js";
import { loadConfig } from "./config.js";
import { gatedAdd } from "./gate.js";
import { createJev, hasJevKey, type JevCaller } from "./jev.js";
import { rankMemories } from "./recall.js";
import { MemoryStore } from "./store.js";
import { NEW_KINDS, type Kind } from "./types.js";

export function buildMcpServer(root: string, deps: { jev?: JevCaller } = {}): McpServer {
  const cfg = loadConfig(root);
  const store = new MemoryStore(root, cfg.memoryFile);
  const getJev = (): JevCaller => {
    if (deps.jev) return deps.jev;
    if (!hasJevKey()) throw new Error("TYPESAFE_API_KEY is not set; search, add and audit need Jev.");
    return createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention });
  };
  const server = new McpServer({ name: "jevmem", version: "0.4.4" });
  const text = (s: unknown) => ({ content: [{ type: "text" as const, text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });

  server.registerTool(
    "search_memory",
    {
      title: "Search project memory",
      description: "Rank JEVMEM.md memories by relevance to a query using one Jev call (choice over ids + a noul per candidate). Returns ranked results with probabilities.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ query, limit }) => {
      const memories = store.active();
      if (memories.length === 0) return text({ results: [], note: "No memories yet." });
      const ranked = await rankMemories(getJev(), query, memories, { perCandidateNouls: true, noulCap: 50, maxIds: cfg.jev.maxRecallCandidates, label: "search" });
      const results = ranked.slice(0, limit ?? 10).map((r) => ({
        id: r.memory.id,
        kind: r.memory.kind,
        text: r.memory.text,
        relevance: r.relevance,
        choice_probability: r.choiceProbability,
        ts: r.memory.ts,
      }));
      return text({ query, results });
    },
  );

  server.registerTool(
    "add_memory",
    {
      title: "Add a memory",
      description:
        "Append one memory line to JEVMEM.md. The line is scrubbed of secrets and checked by Jev first (the same gate as the Claude Code hook): lines that read as instructions aimed at an AI, small talk, or duplicates are refused with a reason. Jev may correct the kind.",
      inputSchema: { text: z.string().min(3).max(500), kind: z.enum(NEW_KINDS as unknown as [string, ...string[]]) },
    },
    async ({ text: t, kind }) => {
      let jev: JevCaller;
      try {
        jev = getJev();
      } catch (e) {
        return { ...text({ added: null, refused: (e as Error).message }), isError: true };
      }
      const r = await gatedAdd(jev, store, cfg, t, kind as Kind);
      if (!r.ok) return { ...text({ added: null, refused: r.reason }), isError: true };
      return text({
        added: r.saved,
        ...(r.kindFrom === "jev" && r.kind !== kind ? { kind_corrected: `${kind} → ${r.kind}` } : {}),
        ...(r.superseded ? { superseded: r.superseded.id } : {}),
        ...(r.redacted ? { note: "credential-shaped text was redacted before saving" } : {}),
      });
    },
  );

  server.registerTool(
    "list_memory",
    {
      title: "List memories",
      description: "List every memory in JEVMEM.md (live ones by default).",
      inputSchema: { include_superseded: z.boolean().optional() },
    },
    async ({ include_superseded }) => {
      const memories = include_superseded ? store.list() : store.active();
      return text({ count: memories.length, memories });
    },
  );

  server.registerTool(
    "audit_memory",
    {
      title: "Audit memories",
      description: "Re-score every live memory against a snapshot of the repository ('is this still true?') and flag stale ones. Set apply=true to write [stale?] flags into JEVMEM.md.",
      inputSchema: { apply: z.boolean().optional() },
    },
    async ({ apply }) => {
      const rows = await auditMemories(getJev(), store, { staleBelow: cfg.thresholds.staleBelow });
      if (apply) applyAudit(store, rows);
      return text(formatAuditTable(rows) + (apply ? "\n\n(flags written to JEVMEM.md)" : ""));
    },
  );

  return server;
}

export async function serveMcp(root: string): Promise<void> {
  const server = buildMcpServer(root);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
