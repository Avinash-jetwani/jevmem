/**
 * PRIVACY.md and SECURITY.md say jevmem's only network calls are the TypeSafe SDK client (Jev) and, when the
 * project's config chooses one, the OpenAI or Anthropic writer. This checks the source for any other way out: no
 * HTTP, socket or fetch library, `node:net` only for the daemon's local socket, the global `fetch` only in the
 * writer, the MCP server on stdio only, and a TypeSafe SDK that names one host.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { callPayload, evaluateGuard, SEND } from "../src/guardrail.js";
import { init } from "../src/init.js";
import { recordProvenance } from "../src/provenance.js";
import { MemoryStore } from "../src/store.js";
import { mockJev } from "./helpers.js";

function sources(dir = "src"): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith(".ts")) out.push(p.split(path.sep).join("/"));
  }
  return out.sort();
}
const read = (f: string) => fs.readFileSync(f, "utf8");
const imports = (text: string) => [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!);

describe("network calls in src/", () => {
  it("no HTTP, socket or fetch library is imported; node:net only in the daemon, for its local socket", () => {
    const NETWORK = /^(?:node:)?(?:http|https|http2|dgram|tls|net)$|^(?:undici|ws|axios|node-fetch|got|superagent)(?:\/|$)/;
    const found = sources().flatMap((f) => imports(read(f)).filter((m) => NETWORK.test(m)).map((m) => `${f}: ${m}`));
    expect(found).toEqual(["src/daemon.ts: node:net"]);
    // The daemon connects to and listens on a socket path (a Unix socket or Windows named pipe), not a host and port.
    const daemon = read("src/daemon.ts");
    expect([...daemon.matchAll(/\bnet\.([a-z]\w*)\(/g)].map((m) => m[1])).toEqual(["createConnection", "createServer"]); // calls, not the net.Server type
    expect(daemon).toContain("net.createConnection(socketPath(root))");
    expect([...daemon.matchAll(/\.listen\(([^,)]*)/g)].map((m) => m[1])).toEqual(["sockPath"]);
  });

  it("the global fetch is called only by the OpenAI and Anthropic writer, whose default hosts are api.openai.com and api.anthropic.com", () => {
    const uses = sources().filter((f) => {
      const text = read(f)
        .replace(/typeof fetch\b/g, "")
        .replace(/\bfetch\??:/g, "")
        .replace(/\.fetch\b/g, "")
        .replace(/fetch failed/g, "");
      return /\bfetch\b/.test(text);
    });
    expect(uses).toEqual(["src/llm/index.ts"]);
    const llm = read("src/llm/index.ts");
    expect(llm).toContain('env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"');
    expect(llm).toContain('env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"');
  });

  it("the MCP server uses the stdio transport only, and the TypeSafe SDK names one host, api.typesafe.ai", () => {
    const mcp = sources().flatMap((f) => imports(read(f)).filter((m) => m.startsWith("@modelcontextprotocol/sdk")));
    expect([...new Set(mcp)].sort()).toEqual(["@modelcontextprotocol/sdk/server/mcp.js", "@modelcontextprotocol/sdk/server/stdio.js"]);
    const sdkDir = path.join("node_modules", "@typesafe-ai", "sdk", "dist");
    const hosts = new Set<string>();
    for (const f of fs.readdirSync(sdkDir).filter((n) => /\.(mjs|cjs)$/.test(n))) {
      for (const m of read(path.join(sdkDir, f)).matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)) hosts.add(m[0]);
    }
    expect([...hosts]).toEqual(["https://api.typesafe.ai"]);
    expect(Object.keys(JSON.parse(read("package.json")).dependencies).sort()).toEqual(["@modelcontextprotocol/sdk", "@typesafe-ai/sdk", "zod"]);
  });

  it("every Jev request goes through the one TypeSafe client; the request sites are decide, recall, the poisoning gate, audit, the daemon's warm-up and the guard", () => {
    const sites = sources().filter((f) => /\bjev\.call\(/.test(read(f)));
    expect(sites).toEqual(["src/audit.ts", "src/daemon.ts", "src/decide.ts", "src/guard.ts", "src/guardrail.ts", "src/recall.ts"]);
    expect(sources().filter((f) => /new TypeSafeClient\(/.test(read(f)))).toEqual(["src/jev.ts"]);
  });

  it("the guard (PreToolUse) sends only the call (the command, or the file path and a short scrubbed snippet) and the candidate rules; nothing without a candidate or with the guard off", async () => {
    // The one request's state, as written in the source: the call and the rules' ids and texts.
    const src = read("src/guardrail.ts");
    expect([...src.matchAll(/\bjev\.call\(/g)]).toHaveLength(1);
    expect(src).toContain("const state = { tool_call: payload, rules: ask.map((c) => ({ id: c.rule.id, rule: scrubSecrets(c.rule.text) })) };");
    // What the call part holds, per tool.
    expect(callPayload({ tool: "Bash", command: "git add .env" }, [])).toEqual({ tool: "Bash", command: "git add .env" });
    const e = callPayload({ tool: "Edit", file: "src/a.ts", removed: "x".repeat(5000), added: "y".repeat(5000) }, []);
    expect(Object.keys(e).sort()).toEqual(["added", "file", "removed", "tool"]);
    expect(e.added!.length).toBeLessThanOrEqual(SEND.added + 2);
    expect(e.removed!.length).toBeLessThanOrEqual(SEND.removed + 2);
    const w = callPayload({ tool: "Write", file: "config/app.env", added: "DB_PASSWORD=hunter2hunter2 and more" }, []);
    expect(Object.keys(w).sort()).toEqual(["content", "file", "tool"]);
    expect(w.content).toBe("DB_PASSWORD=[REDACTED] and more");
    // No candidate, or the guard off: no request at all.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-net-")));
    init({ root, hooks: false });
    recordProvenance(root, new MemoryStore(root).add({ kind: "constraint", text: "Never commit .env files" }), "hook");
    const jev = mockJev(() => ({}));
    const pre = (command: string) => ({ hook_event_name: "PreToolUse", cwd: root, tool_name: "Bash", tool_input: { command } });
    await evaluateGuard(pre("ls -la"), { jev });
    expect(jev.calls).toHaveLength(0);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "jevmem.config.json"), "utf8"));
    fs.writeFileSync(path.join(root, "jevmem.config.json"), JSON.stringify({ ...cfg, guard: { ...cfg.guard, mode: "off" } }));
    await evaluateGuard(pre("git add .env"), { jev });
    expect(jev.calls).toHaveLength(0);
  });
});
