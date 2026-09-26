/**
 * PRIVACY.md and SECURITY.md say jevmem's only network calls are the TypeSafe SDK client (Jev) and, when the
 * project's config chooses one, the OpenAI or Anthropic writer. This checks the source for any other way out: no
 * HTTP, socket or fetch library, `node:net` only for the daemon's local socket, the global `fetch` only in the
 * writer, the MCP server on stdio only, and a TypeSafe SDK that names one host.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
});
