import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS, COMMAND_HELP, main } from "../src/cli-main.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-cli-"));

function run(argv: string[], cwd: string) {
  let out = "";
  let err = "";
  return main(argv, { out: (s) => void (out += s), err: (s) => void (err += s), cwd }).then((code) => ({ code, out, err }));
}

describe("built CLI (default io)", () => {
  it.skipIf(!fs.existsSync(path.resolve("dist/cli.js")))("prints help and version through the real stdout without recursing", async () => {
    const { execFileSync } = await import("node:child_process");
    const cwd = tmp();
    expect(execFileSync(process.execPath, [path.resolve("dist/cli.js"), "init", "--help"], { cwd, encoding: "utf8" })).toBe(COMMAND_HELP.init);
    expect(execFileSync(process.execPath, [path.resolve("dist/cli.js"), "--version"], { cwd, encoding: "utf8" })).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });
});

describe("per-command --help", () => {
  for (const cmd of COMMANDS) {
    for (const flag of ["--help", "-h"]) {
      it(`${cmd} ${flag} prints help, exits 0, and has no side effects`, async () => {
        const cwd = tmp();
        const before = fs.readdirSync(cwd);
        const r = await run([cmd, flag], cwd);
        expect(r.code).toBe(0);
        expect(r.err).toBe("");
        expect(r.out).toBe(COMMAND_HELP[cmd]);
        expect(r.out.startsWith(`jevmem ${cmd}`)).toBe(true);
        expect(fs.readdirSync(cwd)).toEqual(before);
      });
    }
  }
  it("init --help does not create JEVMEM.md or config, and add --help does not add a line", async () => {
    const cwd = tmp();
    await run(["init", "--help", "--tool", "all"], cwd);
    expect(fs.existsSync(path.join(cwd, "JEVMEM.md"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, "jevmem.config.json"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, ".claude"))).toBe(false);
    await run(["add", "decision", "--help", "use pnpm"], cwd);
    expect(fs.existsSync(path.join(cwd, "JEVMEM.md"))).toBe(false);
  });
  it("top-level help and version still work", async () => {
    const cwd = tmp();
    expect((await run(["--help"], cwd)).out).toContain("Usage: jevmem <command>");
    expect((await run([], cwd)).code).toBe(0);
    expect((await run(["--version"], cwd)).out).toMatch(/^\d+\.\d+\.\d+\n$/);
    const bad = await run(["nope"], cwd);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("unknown command: nope");
  });
});

describe("init with no --tool", () => {
  it("sets up Claude Code hooks and leaves ~/.codex alone on a machine that has Codex installed", async () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, ".git"));
    const home = tmp();
    fs.mkdirSync(path.join(home, ".codex"));
    const toml = 'model = "x"\n';
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), toml);
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const r = await run(["init", "--command", "node /x/cli.js hook"], cwd);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Tools: claude (detected");
      const local = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.local.json"), "utf8"));
      expect(local.hooks.Stop[0].hooks[0].command).toBe("node /x/cli.js hook");
      expect(fs.existsSync(path.join(cwd, "AGENTS.md"))).toBe(false);
      expect(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toBe(toml);
      expect(fs.readdirSync(path.join(home, ".codex"))).toEqual(["config.toml"]);
      expect(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8")).toBe(".jevmem/\n.claude/settings.local.json\n");
    } finally {
      process.env.HOME = prev;
    }
  });

  it("initializes Pi memory without registering Claude Code hooks", async () => {
    const cwd = tmp();
    const r = await run(["init", "--tool", "pi"], cwd);
    expect(r.code).toBe(0);
    expect(r.out).toContain("pi install npm:jevmem");
    expect(fs.existsSync(path.join(cwd, "JEVMEM.md"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, ".pi", "settings.json"))).toBe(false);
  });

  it("edits ~/.codex/config.toml only when --tool codex is passed explicitly", async () => {
    const cwd = tmp();
    const home = tmp();
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "x"\n');
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const r = await run(["init", "--tool", "codex"], cwd);
      expect(r.code).toBe(0);
      expect(r.out).toContain("About to append to");
      expect(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.jevmem]");
      expect(fs.existsSync(path.join(cwd, ".claude"))).toBe(false);
    } finally {
      process.env.HOME = prev;
    }
  });
});

describe("jevmem add", () => {
  it("scrubs secrets from a hand-typed line before writing the committed file", async () => {
    const cwd = tmp();
    await run(["init", "--no-hooks", "--tool", "claude"], cwd);
    const r = await run(["add", "constraint", "Staging uses DB_PASSWORD=hunter2; never reuse it in prod"], cwd);
    expect(r.code).toBe(0);
    const file = fs.readFileSync(path.join(cwd, "JEVMEM.md"), "utf8");
    expect(file).not.toContain("hunter2");
    expect(file).toContain("DB_PASSWORD=[REDACTED]");
  });
});
