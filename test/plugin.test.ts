/**
 * The Claude Code plugin: its files agree with package.json, its hooks use the launcher, and a project with both the
 * plugin and `jevmem init` hooks runs jevmem once (the plugin's hooks stand down and say so once per session).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { init, projectEnablesPlugin, projectHasInitHooks, unregisterClaudeHooks } from "../src/init.js";
import { readQueue } from "../src/queue.js";

const CLI = path.resolve("dist/cli.js");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-plugin-"));
const json = (f: string) => JSON.parse(fs.readFileSync(path.resolve(f), "utf8"));
beforeAll(() => {
  if (!fs.existsSync(CLI)) execFileSync("pnpm", ["build"], { stdio: "ignore" });
}, 60_000);

describe("plugin files", () => {
  const pkg = json("package.json");
  it("plugin/ holds the plugin at the package version; the marketplace points at ./plugin; the root is no plugin", () => {
    const manifest = json("plugin/.claude-plugin/plugin.json");
    const market = json(".claude-plugin/marketplace.json");
    expect(manifest.name).toBe("jevmem");
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.mcpServers.jevmem.env.JEVMEM_PLUGIN_VERSION).toBe(pkg.version);
    expect(market.plugins.find((p: any) => p.name === "jevmem").source).toBe("./plugin");
    expect(fs.existsSync(".claude-plugin/plugin.json")).toBe(false);
    expect(fs.existsSync("hooks/hooks.json")).toBe(false);
    // The npm package no longer carries a plugin; it keeps hooks/jevmem-hook.sh for projects set up with `jevmem init`.
    expect(pkg.files).not.toContain(".claude-plugin/plugin.json");
    expect(pkg.files).toContain("hooks");
    // A plugin bin/ would go on the Bash tool's PATH and stop claude.ai/Cowork installs; no .mcp.json either.
    expect(fs.existsSync("plugin/bin")).toBe(false);
    expect(fs.existsSync("plugin/.mcp.json")).toBe(false);
  });

  it("plugin/ contains only the manifest, the hooks, one launcher, the README and the licence: no code, nothing large", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else files.push(path.relative("plugin", path.join(d, e.name)));
    }
    };
    walk("plugin");
    expect(files.sort()).toEqual([".claude-plugin/plugin.json", "LICENSE", "README.md", "hooks/hooks.json", "hooks/jevmem-hook.sh"]);
    expect(fs.readFileSync("plugin/LICENSE", "utf8")).toBe(fs.readFileSync("LICENSE", "utf8"));
    for (const f of files) expect(fs.statSync(path.join("plugin", f)).size, f).toBeLessThan(256 * 1024);
  });

  it("the API key is a sensitive userConfig option that reaches the MCP server by reference, never as a literal", () => {
    const m = json("plugin/.claude-plugin/plugin.json");
    expect(m.userConfig.typesafe_api_key).toMatchObject({ type: "string", sensitive: true });
    expect(m.mcpServers.jevmem).toMatchObject({ command: "jevmem", args: ["mcp"] });
    expect(m.mcpServers.jevmem.env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY).toBe("${user_config.typesafe_api_key}");
  });

  it("hooks.json: Stop is async and detached, UserPromptSubmit is synchronous, both through the launcher with --plugin", () => {
    const h = json("plugin/hooks/hooks.json").hooks;
    const stop = h.Stop[0].hooks[0];
    const ups = h.UserPromptSubmit[0].hooks[0];
    expect(stop).toMatchObject({ type: "command", async: true, command: '"${CLAUDE_PLUGIN_ROOT}/hooks/jevmem-hook.sh" --detach hook --plugin' });
    expect(ups.async).toBeUndefined();
    expect(ups.command).toBe('"${CLAUDE_PLUGIN_ROOT}/hooks/jevmem-hook.sh" hook --plugin');
    expect(fs.statSync("plugin/hooks/jevmem-hook.sh").mode & 0o111, "the launcher is executable").not.toBe(0);
  });

  // The directory's rule for a plugin in a subfolder: each path in a hook or MCP command is written in full from
  // "${CLAUDE_PLUGIN_ROOT}", with no other variable, command substitution, wildcard or inline program.
  it("every hook and MCP command names its paths from \"${CLAUDE_PLUGIN_ROOT}\" only", () => {
    const h = json("plugin/hooks/hooks.json").hooks;
    const commands: string[] = Object.values(h).flatMap((groups: any) => groups.flatMap((g: any) => g.hooks.map((x: any) => [x.command, ...(x.args ?? [])].join(" "))));
    const m = json("plugin/.claude-plugin/plugin.json");
    for (const s of Object.values(m.mcpServers) as any[]) commands.push([s.command, ...(s.args ?? [])].join(" "));
    expect(commands).toHaveLength(3);
    for (const c of commands) {
      const rest = c.replace(/"\$\{CLAUDE_PLUGIN_ROOT\}\/[A-Za-z0-9._/-]+"/g, "");
      expect(rest, c).toMatch(/^[A-Za-z0-9 ._-]*$/); // no other variable, $( ), backtick, wildcard, quote or -c
      expect(c, c).not.toMatch(/(^|\s)-c(\s|$)/);
    }
  });

  it("the hooks.json commands run through a shell from a plugin folder whose path has a space", () => {
    const root = path.join(tmp(), "plugin cache dir");
    fs.cpSync("plugin", root, { recursive: true });
    const project = tmp(); // not enabled: the launcher reads its input and exits 0 silently
    const h = json("plugin/hooks/hooks.json").hooks;
    for (const cmd of [h.UserPromptSubmit[0].hooks[0].command, h.Stop[0].hooks[0].command]) {
      const r = spawnSync("/bin/sh", ["-c", cmd], { cwd: project, env: { PATH: "/usr/bin:/bin", HOME: tmp(), CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: project }, input: "{}", encoding: "utf8" });
      expect([r.status, r.stdout, r.stderr], cmd).toEqual([0, "", ""]);
    }
    // And the path really is used: an enabled project with no CLI anywhere prints nothing either, but a broken path would fail.
    const bad = spawnSync("/bin/sh", ["-c", h.UserPromptSubmit[0].hooks[0].command], { cwd: project, env: { PATH: "/usr/bin:/bin", CLAUDE_PLUGIN_ROOT: root + "-missing", CLAUDE_PROJECT_DIR: project }, input: "{}", encoding: "utf8" });
    expect(bad.status).not.toBe(0);
  });
});

function hook(root: string, payload: object, extra: string[] = []) {
  return spawnSync(process.execPath, [CLI, "hook", ...extra], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: tmp(), TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "http://127.0.0.1:9", JEVMEM_DAEMON: "0", JEVMEM_WRITER: "none" }, input: JSON.stringify(payload), encoding: "utf8", timeout: 20_000 });
}

describe("plugin and init hooks in one project", () => {
  it("detects init hooks, and a plugin enabled in project settings", () => {
    const root = tmp();
    expect(projectHasInitHooks(root)).toBe(false);
    init({ root });
    expect(projectHasInitHooks(root)).toBe(true);
    expect(projectEnablesPlugin(root)).toBe(false);
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "jevmem@jevmem": true } }));
    expect(projectEnablesPlugin(root)).toBe(true);
    expect(init({ root }).warnings.join(" ")).toMatch(/plugin is also enabled/);
  });

  it("the plugin's hooks stand down when init hooks exist: nothing queued, one warning per session, one log line per day", () => {
    const root = tmp();
    init({ root });
    const s1 = hook(root, { hook_event_name: "Stop", session_id: "s1", cwd: root, user_message: "We will use Postgres 16 for the primary store." }, ["--plugin"]);
    expect(s1.status).toBe(0);
    expect(readQueue(root)).toHaveLength(0);
    const u1 = hook(root, { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: root, prompt: "add a table" }, ["--plugin"]);
    expect(JSON.parse(u1.stdout).systemMessage).toMatch(/standing down/);
    const u2 = hook(root, { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: root, prompt: "add another table" }, ["--plugin"]);
    expect(u2.stdout.trim()).toBe("");
    const u3 = hook(root, { hook_event_name: "UserPromptSubmit", session_id: "s2", cwd: root, prompt: "add a table" }, ["--plugin"]);
    expect(JSON.parse(u3.stdout).systemMessage).toMatch(/standing down/);
    const log = fs.readFileSync(path.join(root, ".jevmem", "log.jsonl"), "utf8").split("\n").filter((l) => l.includes("plugin-standdown"));
    expect(log).toHaveLength(1);
    // The init hook itself (no --plugin) still runs: the turn is queued (Jev is unreachable here, so it waits).
    hook(root, { hook_event_name: "Stop", session_id: "s1", cwd: root, user_message: "We will use Postgres 16 for the primary store." });
    expect(readQueue(root)).toHaveLength(1);
  });

  it("without init hooks the plugin's hook does the work; init --remove-hooks leaves only the plugin", () => {
    const root = tmp();
    init({ root, hooks: false });
    hook(root, { hook_event_name: "Stop", session_id: "s1", cwd: root, user_message: "Deploys go out from the CI deploy job only." }, ["--plugin"]);
    expect(readQueue(root)).toHaveLength(1);
    const root2 = tmp();
    init({ root: root2 });
    fs.writeFileSync(path.join(root2, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other" }] }] } }));
    expect(unregisterClaudeHooks(root2)).toEqual([".claude/settings.local.json"]);
    expect(projectHasInitHooks(root2)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root2, ".claude", "settings.json"), "utf8")).hooks.Stop[0].hooks[0].command).toBe("echo other");
  });

  it("enabled: false in jevmem.config.json switches the hooks off for a project", () => {
    const root = tmp();
    init({ root, hooks: false });
    fs.writeFileSync(path.join(root, "jevmem.config.json"), JSON.stringify({ enabled: false }));
    hook(root, { hook_event_name: "Stop", session_id: "s1", cwd: root, user_message: "Deploys go out from the CI deploy job only." }, ["--plugin"]);
    expect(readQueue(root)).toHaveLength(0);
  });
});
