/**
 * A key saved or replaced while jevmem runs is used from the next prompt:
 * - the warm daemon keeps the Jev client it started with. Each hook request carries a fingerprint of the key it would
 *   use (a hash, never the key); a daemon holding another key answers `key-changed` and exits, the hook does the work
 *   inline with the new key and starts a new daemon. Before this, a daemon kept serving the old key for as long as
 *   prompts kept it busy (found checking `/plugin configure` by hand: the new key was saved, the old one was sent);
 * - the MCP server reads `<project>/.jevmem/.env` and `~/.jevmem/env` on each call, like the hooks. Before this it never
 *   read them, so a key saved with `jevmem key` reached the hooks but not the MCP tools.
 * Jev here is a local stand-in that records the key each request carries.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { daemonRequest, jevFingerprint } from "../src/daemon.js";
import { init } from "../src/init.js";
import { MemoryStore } from "../src/store.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";
import { relevance, type AnswerOverrides } from "./helpers.js";

const CLI = path.resolve("dist/cli.js");
const tmp = (p = "jevmem-keychange-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
beforeAll(() => {
  if (!fs.existsSync(CLI)) spawnSync("pnpm", ["build"], { stdio: "ignore" });
}, 60_000);
let fake: FakeJev | null = null;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await daemonRequest(root, { type: "stop" }, { connectMs: 200, responseMs: 1000 });
  await fake?.close();
  fake = null;
});
async function waitFor(cond: () => boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return cond();
}
/** Recall picks the first memory and calls every line relevant; everything else is a quiet no. */
const answers = (q: Record<string, any>): AnswerOverrides => (q.most_relevant ? { most_relevant: Object.keys(q.most_relevant.criteria).find((k) => k !== "none")!, ...relevance(q) } : {});
/** The keys of the requests the stand-in saw from `from` on (the daemon's warm-up call left out). */
const keysSince = (from: number) => fake!.requests.slice(from).filter((r) => r.state !== "ready").map((r) => String(r.headers.authorization ?? "").replace(/^Bearer /, ""));

function hook(root: string, env: Record<string, string>): Promise<{ stdout: string; via: string }> {
  return new Promise((resolve) => {
    // TMPDIR as this process has it: a long project path puts the daemon's socket there, and afterEach must find it.
    const p = spawn(process.execPath, [CLI, "hook"], { cwd: root, env: { PATH: "/usr/bin:/bin", TMPDIR: os.tmpdir(), CLAUDE_PROJECT_DIR: root, JEVMEM_VERBOSE: "1", JEVMEM_CACHE: "0", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout!.on("data", (d) => (stdout += d));
    p.stderr!.on("data", (d) => (stderr += d));
    p.on("close", () => resolve({ stdout, via: /via (inline|daemon)/.exec(stderr)?.[1] ?? `?(${stderr.trim()})` }));
    p.stdin!.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: root, prompt: "which database do we use?" }));
  });
}
function project(): string {
  const root = tmp();
  init({ root, hooks: false });
  new MemoryStore(root).add({ kind: "decision", text: "We use Postgres 16 for the primary store." });
  roots.push(root);
  return root;
}
const daemonPid = (root: string): number | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".jevmem", "daemon.json"), "utf8")).pid;
  } catch {
    return null;
  }
};

describe.skipIf(process.platform === "win32")("a key replaced while the warm daemon runs", () => {
  for (const source of ["~/.jevmem/env (jevmem key)", "the plugin setting"] as const) {
    it(`is used from the next prompt: ${source}`, async () => {
      fake = await startFakeJev(answers);
      const root = project();
      const home = tmp();
      fs.mkdirSync(path.join(home, ".jevmem"));
      fs.writeFileSync(path.join(root, ".jevmem", ".env"), `TYPESAFE_BASE_URL=${fake.url}\n`);
      const setKey = (key: string): Record<string, string> => {
        if (source === "the plugin setting") return { HOME: home, CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY: key };
        fs.writeFileSync(path.join(home, ".jevmem", "env"), `TYPESAFE_API_KEY=${key}\n`, { mode: 0o600 });
        return { HOME: home };
      };
      let env = setKey("typesafe-test-key-old1");
      // The first prompt runs inline and starts the daemon; the next is served by it, with the old key.
      let n = fake.requests.length;
      expect((await hook(root, env)).via).toBe("inline");
      expect(await waitFor(() => daemonPid(root) !== null)).toBe(true);
      const first = daemonPid(root);
      expect((await hook(root, env)).via).toBe("daemon");
      expect(keysSince(n)).toEqual(["typesafe-test-key-old1", "typesafe-test-key-old1"]);

      // The key is replaced: the daemon steps aside, the prompt is answered inline with the new key, and a new daemon
      // (with the new key) serves the one after.
      env = setKey("typesafe-test-key-new2");
      n = fake.requests.length;
      const changed = await hook(root, env);
      expect(changed.via).toBe("inline");
      expect(JSON.parse(changed.stdout).hookSpecificOutput.additionalContext).toContain("Postgres 16");
      expect(await waitFor(() => daemonPid(root) !== null && daemonPid(root) !== first)).toBe(true);
      expect((await hook(root, env)).via).toBe("daemon");
      expect(keysSince(n)).toEqual(["typesafe-test-key-new2", "typesafe-test-key-new2"]);
    });
  }

  it("the fingerprint is a hash of the key and base URL, never the key", () => {
    const a = jevFingerprint({ TYPESAFE_API_KEY: "<old test key>" });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(jevFingerprint({ TYPESAFE_API_KEY: "<new test key>" }));
    expect(a).not.toBe(jevFingerprint({ TYPESAFE_API_KEY: "<old test key>", TYPESAFE_BASE_URL: "http://127.0.0.1:9" }));
    expect(a).toBe(jevFingerprint({ TYPESAFE_API_KEY: " <old test key> " }));
  });
});

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
      expect(before.content[0].text).toBe("TYPESAFE_API_KEY is not set; search, add and audit need Jev. Run jevmem key in a terminal and paste your key.");
      // What `jevmem key` writes.
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
