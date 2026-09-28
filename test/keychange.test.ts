/**
 * A key saved while the MCP server runs is used from the next call: the MCP server reads `<project>/.jevmem/.env` and
 * `~/.jevmem/env` on each call, like the hooks. Before this it never read them, so a key in `~/.jevmem/env` reached the
 * hooks but not the MCP tools. Jev here is a local stand-in that records the key each request carries.
 * (On main this file also covers a key replaced while the warm daemon runs, a change 0.5.x does not have.)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { init } from "../src/init.js";
import { MemoryStore } from "../src/store.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";
import type { AnswerOverrides } from "./helpers.js";

const CLI = path.resolve("dist/cli.js");
const tmp = (p = "jevmem-keychange-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
beforeAll(() => {
  if (!fs.existsSync(CLI)) spawnSync("pnpm", ["build"], { stdio: "ignore" });
}, 60_000);
let fake: FakeJev | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});
/** Recall picks the first memory; everything else is a quiet no. */
const answers = (q: Record<string, any>): AnswerOverrides => (q.most_relevant ? { most_relevant: Object.keys(q.most_relevant.criteria).find((k) => k !== "none")! } : {});
/** The keys of the requests the stand-in saw from `from` on (a daemon's warm-up call left out). */
const keysSince = (from: number) => fake!.requests.slice(from).filter((r) => r.state !== "ready").map((r) => String(r.headers.authorization ?? "").replace(/^Bearer /, ""));

function project(): string {
  const root = tmp();
  init({ root, hooks: false });
  new MemoryStore(root).add({ kind: "decision", text: "We use Postgres 16 for the primary store." });
  return root;
}

describe.skipIf(process.platform === "win32")("the MCP server", () => {
  it("finds a key saved in ~/.jevmem/env while it runs, with no restart", async () => {
    fake = await startFakeJev(answers);
    const root = project();
    const home = tmp();
    fs.writeFileSync(path.join(root, ".jevmem", ".env"), `TYPESAFE_BASE_URL=${fake.url}\n`);
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd: root, env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_PROJECT_DIR: root, JEVMEM_CACHE: "0" }, stderr: "ignore" });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      const before: any = await client.callTool({ name: "search_memory", arguments: { query: "database" } });
      expect(before.isError).toBe(true);
      expect(before.content[0].text).toBe("TYPESAFE_API_KEY is not set; search, add and audit need Jev.");
      // A key saved to ~/.jevmem/env while the server runs.
      fs.mkdirSync(path.join(home, ".jevmem"), { mode: 0o700 });
      fs.writeFileSync(path.join(home, ".jevmem", "env"), "TYPESAFE_API_KEY=typesafe-test-key-mcp1\n", { mode: 0o600 });
      const n = fake.requests.length;
      const after: any = await client.callTool({ name: "search_memory", arguments: { query: "database" } });
      expect(after.isError, JSON.stringify(after)).toBeFalsy();
      expect(after.content[0].text).toContain("Postgres 16");
      expect(keysSince(n)).toEqual(["typesafe-test-key-mcp1"]);
    } finally {
      await client.close();
    }
  });
});
