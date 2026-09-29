/**
 * How the jevmem plugin is installed, and what jevmem tells a user for each install: the plugin added in the Claude app
 * (`jevmem@synced`, which has no key setting), one installed from a marketplace (`/plugin configure jevmem` works), and
 * no plugin. Every case runs in a temporary HOME holding a fake Claude Code config, laid out as Claude Code 2.1.284
 * keeps it; the user's own ~/.claude is never read. Keys here are fake.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";
import { PLUGIN_CONFIGURE_HINT } from "../src/env.js";
import { init } from "../src/init.js";
import { canConfigure, describeInstall, hasActivePlugin, pluginInstalls, runningPlugin } from "../src/install.js";
import { MCP_NO_KEY } from "../src/mcp.js";
import { MemoryStore } from "../src/store.js";
import { firstLineMessage, firstLineNotice, MISSING_KEY_NOTICE_MARKETPLACE, MISSING_KEY_NOTICE_PLUGIN, MISSING_KEY_NOTICE_SYNCED, noteFirstLine } from "../src/notice.js";

const CLI = path.resolve("dist/cli.js");
const tmp = (p = "jevmem-install-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
beforeAll(() => {
  if (!fs.existsSync(CLI)) spawnSync("pnpm", ["build"], { stdio: "ignore" });
}, 60_000);

/** A plugin added in the Claude app, where Claude Code 2.1.284 keeps it: <config>/plugins/synced/<bucket>/<id>/. */
function fakeSynced(home: string, version = "0.5.7", name = "jevmem"): string {
  const dir = path.join(home, ".claude", "plugins", "synced", "a8f4c5eb-bucket", `7d57870a-${name}`);
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version }));
  fs.writeFileSync(path.join(dir, "..", `7d57870a-${name}.meta.json`), JSON.stringify({ marketplace_name: "anthropic-plugin-directory" }));
  return dir;
}
/** A plugin installed from a marketplace: enabled in the user's settings, its version in installed_plugins.json. */
function fakeMarketplace(home: string, id = "jevmem@jevmem", version = "0.5.7") {
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  const settings = path.join(home, ".claude", "settings.json");
  const s = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, "utf8")) : {};
  fs.writeFileSync(settings, JSON.stringify({ ...s, enabledPlugins: { ...s.enabledPlugins, [id]: true } }));
  fs.writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [id]: [{ scope: "user", version, installPath: path.join(home, ".claude", "plugins", "cache", "jevmem", "jevmem", version) }] } }));
}
const saveFakeKey = (home: string) => {
  fs.mkdirSync(path.join(home, ".jevmem"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".jevmem", "env"), "TYPESAFE_API_KEY=typesafe-test-key-0001\n", { mode: 0o600 });
};
const jevmem = (cwd: string, home: string, args: string[], extra: Record<string, string> = {}, input?: string) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, env: { PATH: "/usr/bin:/bin", HOME: home, JEVMEM_DAEMON: "0", ...extra }, encoding: "utf8", input });
const enabled = () => {
  const root = tmp("jevmem-install-proj-");
  init({ root, hooks: false });
  return root;
};

describe("pluginInstalls: where Claude Code records the jevmem plugin", () => {
  it("finds the plugin synced from claude.ai, with its version, and no other synced plugin", () => {
    const home = tmp();
    fakeSynced(home);
    fakeSynced(home, "1.2.0", "engineering");
    const found = pluginInstalls(tmp(), { HOME: home }, home);
    expect(found).toEqual([expect.objectContaining({ kind: "synced", version: "0.5.7", enabled: true })]);
    expect(describeInstall(found[0]!)).toBe("jevmem plugin, synced from claude.ai (0.5.7)");
    expect(hasActivePlugin(found)).toBe(true);
    // It has no key setting: /plugin configure is not offered for it.
    expect(canConfigure(found)).toBe(false);
  });

  it("a synced plugin turned off in the user's settings is found, but not active", () => {
    const home = tmp();
    fakeSynced(home);
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "jevmem@synced": false } }));
    const found = pluginInstalls(tmp(), { HOME: home }, home);
    expect(found).toEqual([expect.objectContaining({ kind: "synced", enabled: false })]);
    expect(hasActivePlugin(found)).toBe(false);
    expect(describeInstall(found[0]!)).toContain("turned off");
  });

  it("finds a marketplace install in the user's or the project's settings; /plugin configure applies to it", () => {
    const home = tmp();
    fakeMarketplace(home, "jevmem@jevmem", "0.5.7");
    const root = tmp();
    const found = pluginInstalls(root, { HOME: home }, home);
    expect(found).toEqual([{ kind: "marketplace", id: "jevmem@jevmem", version: "0.5.7", where: "~/.claude/settings.json" }]);
    expect(describeInstall(found[0]!)).toBe("jevmem plugin jevmem@jevmem, installed from a marketplace (0.5.7), enabled in ~/.claude/settings.json");
    expect(canConfigure(found)).toBe(true);
    const other = tmp();
    fs.mkdirSync(path.join(other, ".claude"));
    fs.writeFileSync(path.join(other, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "jevmem@team": true, "other@x": true } }));
    expect(pluginInstalls(other, { HOME: tmp() }, tmp())).toEqual([expect.objectContaining({ kind: "marketplace", id: "jevmem@team", version: null, where: path.join(other, ".claude", "settings.json") })]);
  });

  it("reads CLAUDE_CONFIG_DIR instead of ~/.claude when it is set, and finds nothing in an empty config", () => {
    const home = tmp();
    const config = path.join(tmp(), "cfg");
    fakeSynced(home);
    fs.renameSync(path.join(home, ".claude"), config);
    expect(pluginInstalls(tmp(), { HOME: home }, home)).toEqual([]);
    expect(pluginInstalls(tmp(), { HOME: home, CLAUDE_CONFIG_DIR: config }, home)).toEqual([expect.objectContaining({ kind: "synced" })]);
  });

  it("runningPlugin tells the install a hook runs from by CLAUDE_PLUGIN_ROOT", () => {
    expect(runningPlugin({ CLAUDE_PLUGIN_ROOT: "/Users/u/.claude/plugins/synced/a8f4_34a5/7d57870a" })).toBe("synced");
    expect(runningPlugin({ CLAUDE_PLUGIN_ROOT: "/Users/u/.claude/plugins/cache/jevmem/jevmem/0.5.7" })).toBe("marketplace");
    expect(runningPlugin({ CLAUDE_PLUGIN_ROOT: "/Users/u/src/jevmem/plugin" })).toBeNull();
    expect(runningPlugin({})).toBeNull();
    // A local marketplace's plugin loads in place, from its own folder: the settings tell it apart from --plugin-dir.
    const home = tmp();
    fakeMarketplace(home, "jevmem@local-market");
    expect(runningPlugin({ CLAUDE_PLUGIN_ROOT: "/u/src/market/plugin", HOME: home }, tmp())).toBe("marketplace");
    expect(runningPlugin({ CLAUDE_PLUGIN_ROOT: "/u/src/market/plugin", HOME: tmp() }, tmp())).toBeNull();
    expect(runningPlugin({ HOME: home }, tmp())).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("jevmem doctor, enable and key --help, by install", () => {
  it("doctor reports the synced plugin, and without a key offers jevmem key only", () => {
    const home = tmp();
    fakeSynced(home);
    const out = jevmem(enabled(), home, ["doctor"]).stdout;
    expect(out).toMatch(/^hooks {4}jevmem plugin, synced from claude\.ai \(0\.5\.7\)$/m);
    expect(out).toContain("run jevmem key in a terminal and paste your key");
    expect(out).not.toContain("/plugin configure");
    // The plugin is seen, so doctor also says which jevmem its hooks would run.
    expect(out).toMatch(/^cli {6}with this PATH the plugin/m);
  });

  it("doctor with a marketplace install offers /plugin configure after jevmem key; with no plugin it says what it checked", () => {
    const home = tmp();
    fakeMarketplace(home);
    const out = jevmem(enabled(), home, ["doctor"]).stdout;
    expect(out).toMatch(/^hooks {4}jevmem plugin jevmem@jevmem, installed from a marketplace \(0\.5\.7\), enabled in ~\/\.claude\/settings\.json$/m);
    expect(out.indexOf("run jevmem key")).toBeLessThan(out.indexOf(PLUGIN_CONFIGURE_HINT));
    const none = jevmem(enabled(), tmp(), ["doctor"]).stdout;
    expect(none).toMatch(/^hooks {4}no jevmem plugin found \(checked the plugins synced from claude\.ai and the user and project settings\), and no init hooks in this project: run `jevmem init --tool claude`, or add the plugin$/m);
    expect(none).not.toContain("/plugin configure");
  });

  it("enable gives one next step: the key, else the hooks, else nothing to do", () => {
    const next = (home: string, root = tmp("jevmem-install-proj-")) => {
      const r = jevmem(root, home, ["enable"]);
      expect(r.status).toBe(0);
      return r.stdout.slice(r.stdout.indexOf("jevmem is enabled"));
    };
    const noKey = tmp();
    fakeSynced(noKey);
    expect(next(noKey)).toBe("jevmem is enabled in this project.\nNext: run jevmem key in a terminal and paste your TypeSafe API key (get one at https://console.typesafe.ai/keys).\n");
    const noHooks = tmp();
    saveFakeKey(noHooks);
    expect(next(noHooks)).toBe("jevmem is enabled in this project.\nNext: run jevmem init --tool claude to register the Claude Code hooks (no jevmem plugin or init hooks found).\n");
    const synced = tmp();
    saveFakeKey(synced);
    fakeSynced(synced);
    expect(next(synced)).toBe("jevmem is enabled in this project.\nMemory starts with your next prompt in Claude Code.\n");
    const withInit = tmp("jevmem-install-proj-");
    init({ root: withInit, hooks: true, cliPath: CLI });
    expect(next(noHooks, withInit)).toBe("jevmem is enabled in this project.\nMemory starts with your next prompt in Claude Code.\n");
  });

  it("key --help offers /plugin configure only with a marketplace install", () => {
    const synced = tmp();
    fakeSynced(synced);
    const a = jevmem(tmp(), synced, ["key", "--help"]).stdout;
    expect(a).toContain("works for every install");
    expect(a).not.toContain("/plugin configure");
    const market = tmp();
    fakeMarketplace(market);
    expect(jevmem(tmp(), market, ["key", "--help"]).stdout).toContain(PLUGIN_CONFIGURE_HINT);
  });
});

describe.skipIf(process.platform === "win32")("the hooks' missing-key message, by the plugin they run from", () => {
  const ups = (root: string) => JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: root, prompt: "which database do we use?" });
  it.each([
    ["synced from claude.ai", "/u/.claude/plugins/synced/a8f4/7d57870a", MISSING_KEY_NOTICE_SYNCED],
    ["installed from a marketplace", "/u/.claude/plugins/cache/jevmem/jevmem/0.6.0", MISSING_KEY_NOTICE_MARKETPLACE],
    ["loaded another way (--plugin-dir)", "/u/src/jevmem/plugin", MISSING_KEY_NOTICE_PLUGIN],
  ])("%s", (_name, pluginRoot, expected) => {
    const root = enabled();
    const r = jevmem(root, tmp(), ["hook", "--plugin"], { CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: root }, ups(root));
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(JSON.parse(r.stdout).systemMessage).toBe(expected);
    // jevmem key first, for every install; /plugin configure only where it works.
    expect(expected).toContain("To fix it, run jevmem key in a terminal and paste your key");
    expect(expected.includes("/plugin configure jevmem")).toBe(expected === MISSING_KEY_NOTICE_MARKETPLACE);
    expect(expected.includes("plugin setting")).toBe(expected !== MISSING_KEY_NOTICE_SYNCED);
  });
});

describe.skipIf(process.platform === "win32")("the MCP server with no key", () => {
  it.each([
    ["synced", "/u/.claude/plugins/synced/a8f4/7d57870a", MCP_NO_KEY],
    ["marketplace", "/u/.claude/plugins/cache/jevmem/jevmem/0.6.0", `${MCP_NO_KEY} Or run /plugin configure jevmem in Claude Code.`],
  ])("%s", async (_name, pluginRoot, expected) => {
    const root = enabled();
    new MemoryStore(root).add({ kind: "decision", text: "Use Postgres 16 for the primary store" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd: root, env: { PATH: "/usr/bin:/bin", HOME: tmp(), CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: pluginRoot }, stderr: "ignore" });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      const r: any = await client.callTool({ name: "search_memory", arguments: { query: "database" } });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(expected);
    } finally {
      await client.close();
    }
  });
});

describe.skipIf(process.platform === "win32")("stats and doctor with no key: why the calls did nothing", () => {
  it("a prompt and a finished turn with no key: 2 skipped, with the reason and the fix", () => {
    const root = enabled();
    const home = tmp();
    const env = { CLAUDE_PROJECT_DIR: root };
    jevmem(root, home, ["hook", "--plugin"], env, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "a", cwd: root, prompt: "hi" }));
    jevmem(root, home, ["hook", "--plugin"], env, JSON.stringify({ hook_event_name: "Stop", session_id: "a", cwd: root, user_message: "We use SQLite for the job store." }));
    const stats = jevmem(root, home, ["stats"]).stdout.split("\n");
    expect(stats[0]).toBe("0 call(s), 0 ok, 0 cache hit(s) (0%), p50 0 ms, p95 0 ms, 0 tokens, $0.000000 total; 2 skipped: no TypeSafe key");
    const reason = "in the last 7 days: 2 skipped: no TypeSafe key (1 prompt(s) got no project memory, 1 finished turn(s) not saved). To fix it, run jevmem key in a terminal and paste your key";
    expect(stats).toContain(`failures: ${reason}`);
    expect(jevmem(root, home, ["doctor"]).stdout.split("\n")).toContain(`failures ${reason}`);
  });
});

describe("the first line jevmem saves in a project", () => {
  it("is announced once, on the next prompt; a project with earlier lines is not told", () => {
    const root = tmp();
    expect(firstLineNotice(root)).toBeNull();
    noteFirstLine(root, false);
    expect(firstLineNotice(root)).toBe("jevmem saved its first line to JEVMEM.md.");
    expect(firstLineNotice(root)).toBeNull();
    noteFirstLine(root, false); // a later line: never again
    expect(firstLineNotice(root)).toBeNull();
    const upgraded = tmp();
    noteFirstLine(upgraded, true);
    expect(firstLineNotice(upgraded)).toBeNull();
    expect(firstLineMessage("docs/MEMORY.md")).toBe("jevmem saved its first line to docs/MEMORY.md.");
  });
});
