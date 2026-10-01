/**
 * The Dockerfile at the repository root exists for MCP directories that inspect the server in a sandbox (Glama): it
 * installs the jevmem CLI from npm and starts `jevmem mcp --root /project` on an empty folder, with no TypeSafe key.
 * The first test runs that command with this checkout's build and checks that initialize and tools/list answer; it
 * also holds the Dockerfile to package.json's version. The second builds the image itself and asks it the same; it
 * needs Docker and the pinned version on npm, so it runs only with JEVMEM_DOCKER=1 (CI sets it on Linux).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const CLI = path.resolve("dist/cli.js");
const TOOLS = ["add_memory", "audit_memory", "list_memory", "search_memory"];
const dockerfile = fs.readFileSync("Dockerfile", "utf8");
const pinned = /^RUN npm install -g jevmem@(\S+)/m.exec(dockerfile)?.[1];

beforeAll(() => {
  if (!fs.existsSync(CLI)) execFileSync("pnpm", ["build"], { stdio: "ignore" });
});

/** Start a stdio MCP server, send initialize and tools/list, return both results and what it wrote to stderr. */
async function introspect(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<{ init: any; tools: any[]; stderr: string }> {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let stderr = "";
  const waiting = new Map<number, { resolve: (result: any) => void; reject: (e: Error) => void }>();
  const failAll = (why: string) => {
    for (const w of waiting.values()) w.reject(new Error(`${why}; stderr: ${stderr}`));
    waiting.clear();
  };
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => {
    out += d;
    for (let i = out.indexOf("\n"); i >= 0; i = out.indexOf("\n")) {
      const line = out.slice(0, i).trim();
      out = out.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      const w = waiting.get(m.id);
      if (!w) continue;
      waiting.delete(m.id);
      if (m.error) w.reject(new Error(JSON.stringify(m.error)));
      else w.resolve(m.result);
    }
  });
  child.on("error", (e) => failAll(`could not start ${command}: ${e.message}`));
  child.on("exit", (code) => failAll(`the server exited (${code}) before answering`));
  const timer = setTimeout(() => failAll(`no answer in ${timeoutMs} ms`), timeoutMs);
  const ask = (id: number, method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    const init = await ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dockerfile-test", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const { tools } = await ask(2, "tools/list", {});
    return { init, tools, stderr };
  } finally {
    clearTimeout(timer);
    child.removeAllListeners("exit");
    child.stdin.end();
    child.kill();
  }
}

function expectTools(tools: any[]): void {
  expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
  for (const t of tools) {
    expect(t.description.length).toBeGreaterThan(40);
    expect(t.inputSchema.type).toBe("object");
  }
}

describe("the Dockerfile for MCP directories", () => {
  it("pins this version and starts `jevmem mcp` on an empty project, which answers initialize and tools/list with no key", async () => {
    expect(dockerfile).toMatch(/^FROM node:22-slim$/m);
    expect(pinned).toBe(JSON.parse(fs.readFileSync("package.json", "utf8")).version);
    const entrypoint = JSON.parse(/^ENTRYPOINT (\[.*\])$/m.exec(dockerfile)![1]!) as string[];
    expect(entrypoint).toEqual(["jevmem", "mcp", "--root", "/project"]);

    // The same command on an empty folder, with a bare environment: no key, no jevmem.config.json, an empty HOME.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-dockerfile-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-dockerfile-home-"));
    const { init, tools, stderr } = await introspect(process.execPath, [CLI, ...entrypoint.slice(1, 3), root], { PATH: process.env.PATH, HOME: home });
    expect(init.serverInfo.name).toBe("jevmem");
    expect(init.capabilities.tools).toBeDefined();
    expectTools(tools);
    expect(stderr).toBe("");
    expect(fs.readdirSync(root)).toEqual([]); // listing the tools writes nothing
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it.skipIf(process.env.JEVMEM_DOCKER !== "1")("builds, and the image answers tools/list (JEVMEM_DOCKER=1)", async (ctx) => {
    // The image installs the pinned version from npm, so there is nothing to build between a release's bump and its publish.
    if (spawnSync("npm", ["view", `jevmem@${pinned}`, "version"], { encoding: "utf8" }).stdout.trim() !== pinned) return ctx.skip();
    const tag = `jevmem-introspect:test-${process.pid}`;
    const build = spawnSync("docker", ["build", "-q", "-t", tag, "."], { encoding: "utf8", timeout: 240_000 });
    expect(build.status, build.stderr).toBe(0);
    try {
      const { init, tools } = await introspect("docker", ["run", "-i", "--rm", "--network", "none", tag], process.env, 60_000);
      expect(init.serverInfo).toEqual({ name: "jevmem", version: pinned });
      expectTools(tools);
    } finally {
      spawnSync("docker", ["rmi", "-f", tag], { timeout: 60_000 });
    }
  }, 320_000);
});
