import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeDesktopSnippet, detectTools, setupCodex, setupCursor } from "../src/tools.js";
import { findCodexRollouts, parseRolloutLines, watchCodex } from "../src/watch.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-tools-"));

describe("tool setup", () => {
  it("detects tools from files present", () => {
    const root = tmp();
    const home = tmp();
    expect(detectTools(root, home)).toEqual([]);
    fs.mkdirSync(path.join(root, ".cursor"));
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# hi\n");
    fs.mkdirSync(path.join(root, ".claude"));
    expect(detectTools(root, home)).toEqual(["claude", "cursor", "codex"]);
  });

  it("writes the Cursor MCP entry and rule without clobbering existing servers, idempotently", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, ".cursor"));
    fs.writeFileSync(path.join(root, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const r = setupCursor(root);
    expect(r.created).toEqual([".cursor/mcp.json (jevmem server)", ".cursor/rules/jevmem.mdc"]);
    const mcp = JSON.parse(fs.readFileSync(path.join(root, ".cursor", "mcp.json"), "utf8"));
    expect(mcp.mcpServers.other.command).toBe("x");
    expect(mcp.mcpServers.jevmem.args).toEqual(["-y", "jevmem", "mcp"]);
    const rule = fs.readFileSync(path.join(root, ".cursor", "rules", "jevmem.mdc"), "utf8");
    expect(rule).toMatch(/^---\n/);
    expect(rule).toContain("search_memory");
    expect(rule).toContain("add_memory");
    expect(setupCursor(root).created).toEqual([]);
  });

  it("appends the Codex section to AGENTS.md and registers the MCP in ~/.codex/config.toml when present", () => {
    const root = tmp();
    const home = tmp();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# Project\n\nBe nice.\n");
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n');
    const r = setupCodex(root, home);
    expect(r.created).toEqual(["AGENTS.md (+ jevmem section)", "~/.codex/config.toml (+ [mcp_servers.jevmem])"]);
    const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# Project\n\nBe nice.\n")).toBe(true);
    expect(agents).toContain("## Jevmem project memory");
    const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('[mcp_servers.other]\ncommand = "y"');
    expect(toml).toContain('[mcp_servers.jevmem]\ncommand = "npx"\nargs = ["-y", "jevmem", "mcp"]');
    expect(setupCodex(root, home).created).toEqual([]);
    expect(setupCodex(tmp(), tmp()).notes.join(" ")).toContain("codex mcp add");
  });

  it("produces a Claude Desktop snippet with the project cwd", () => {
    const snip = JSON.parse(claudeDesktopSnippet("/p/x"));
    expect(snip.mcpServers.jevmem.cwd).toBe("/p/x");
    expect(snip.mcpServers.jevmem.args).toEqual(["-y", "jevmem", "mcp"]);
  });
});

describe("codex watch", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const rollout = (cwd: string) => [
    line({ type: "session_meta", payload: { cwd, id: "s1" } }),
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>x</cwd>\n</environment_context>" }] } }),
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Let's use Postgres 16 for the primary store." }] } }),
    line({ type: "response_item", payload: { type: "reasoning", summary: [] } }),
    line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Looking at db.ts first." }], phase: "commentary" } }),
    line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Switched to Postgres 16 via pg." }], phase: "final_answer" } }),
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "thanks!" }] } }),
    line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "You're welcome." }], phase: "final_answer" } }),
  ];

  it("parses completed turns (user + final_answer) and keeps two turns of context", () => {
    const pending = { user: "", assistant: "", history: [] };
    const turns = parseRolloutLines(rollout("/p"), pending, "f");
    expect(turns).toHaveLength(2);
    expect(turns[0]!.user).toBe("Let's use Postgres 16 for the primary store.");
    expect(turns[0]!.assistant).toBe("Looking at db.ts first.\nSwitched to Postgres 16 via pg.");
    expect(turns[1]!.user).toBe("thanks!");
    expect(turns[1]!.previous).toContain("Postgres 16");
  });

  it("only picks rollouts for this project and tails new content", async () => {
    const root = tmp();
    const sessions = tmp();
    const day = path.join(sessions, "2026", "09", "22");
    fs.mkdirSync(day, { recursive: true });
    const mine = path.join(day, "rollout-2026-09-22T10-00-00-aaa.jsonl");
    const other = path.join(day, "rollout-2026-09-22T10-00-00-bbb.jsonl");
    fs.writeFileSync(mine, rollout(root).slice(0, 2).join("\n") + "\n");
    fs.writeFileSync(other, rollout("/somewhere/else").join("\n") + "\n");
    expect(findCodexRollouts(root, sessions)).toEqual([mine]);
    const seen: string[] = [];
    // First pass with replay=false only records the offset; then new lines arrive.
    const first = await watchCodex(root, { sessionsDir: sessions, once: true, onTurn: (t) => void seen.push(t.user) });
    expect(first).toEqual({ files: 1, turns: 0 });
    fs.appendFileSync(mine, rollout(root).slice(2).join("\n") + "\n");
    const replayed = await watchCodex(root, { sessionsDir: sessions, once: true, replay: true, onTurn: (t) => void seen.push(t.user) });
    expect(replayed.turns).toBe(2);
    expect(seen).toEqual(["Let's use Postgres 16 for the primary store.", "thanks!"]);
  });
});
