/**
 * The guard and Claude Code's own memory folder (0.7.7): a Write or Edit under `<config dir>/projects/<slug>/memory/`
 * (or the settings' `autoMemoryDirectory`) is a note Claude keeps about the project, outside it, so the rules do not
 * apply and nothing is asked; the same content written into the project is checked as before. Found by the comparison
 * harness's small pass of 2026-10-26, where the guard asked four times on Claude updating its note after a decision
 * changed, naming the line that change had replaced.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateGuard, isAutoMemoryPath, type GuardInput } from "../src/guardrail.js";
import { init } from "../src/init.js";
import { recordProvenance } from "../src/provenance.js";
import { MemoryStore } from "../src/store.js";
import { mockJev, type MockJev } from "./helpers.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-guard-automem-")));
function project(rules: string[]) {
  const root = tmp();
  init({ root, hooks: false });
  const store = new MemoryStore(root);
  for (const text of rules) recordProvenance(root, store.add({ kind: "constraint", text }), "hook");
  return root;
}
const breaks = (p: number): MockJev => mockJev((q) => Object.fromEntries(Object.keys(q).filter((k) => k.startsWith("breaks_")).map((k) => [k, p])));
const write = (root: string, file: string, content: string): GuardInput => ({ hook_event_name: "PreToolUse", cwd: root, tool_name: "Write", tool_input: { file_path: file, content } });
const RULE = "API keys: the partner apps send theirs in an `X-Api-Key` header on every `/v1` request.";
const NOTE = "Partner apps send `Authorization: Bearer <key>` on every `/v1` request; `X-Api-Key` is retired and not supported.";

describe("the guard leaves Claude Code's own memory folder alone", () => {
  it("a note under <CLAUDE_CONFIG_DIR>/projects/<slug>/memory/ is not checked, with no Jev call; the same text in the project is", async () => {
    const root = project([RULE]);
    const config = tmp();
    const memDir = path.join(config, "projects", "-some-project-slug", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
    const jev = breaks(0.95);
    const note = await evaluateGuard(write(root, path.join(memDir, "partner-api-key-header.md"), NOTE), { jev, env });
    expect(note.route).toBe("claude-memory");
    expect(note.decision).toBe("none");
    expect(note.stdout).toBe("");
    expect(jev.calls).toHaveLength(0);
    const index = await evaluateGuard({ ...write(root, path.join(memDir, "MEMORY.md"), "- [Partner API key header](partner-api-key-header.md) — Bearer, X-Api-Key retired"), tool_name: "Edit", tool_input: { file_path: path.join(memDir, "MEMORY.md"), old_string: "X-Api-Key", new_string: "Bearer" } }, { jev, env });
    expect(index.route).toBe("claude-memory");
    expect(jev.calls).toHaveLength(0);
    const inProject = await evaluateGuard(write(root, path.join(root, "src", "auth.ts"), NOTE), { jev, env });
    expect(inProject.route).toBe("jev");
    expect(inProject.decision).toBe("ask");
    expect(jev.calls).toHaveLength(1);
    const log = fs.readFileSync(path.join(root, ".jevmem", "guard-log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(log.map((e) => e.route)).toEqual(["claude-memory", "claude-memory", "jev"]);
  });

  it("the default config dir (~/.claude), the real path of a temp config dir, and an autoMemoryDirectory from the settings", () => {
    const root = project([]);
    const home = tmp();
    expect(isAutoMemoryPath(path.join(home, ".claude", "projects", "-Users-x-repo", "memory", "note.md"), root, { HOME: home })).toBe(true);
    expect(isAutoMemoryPath(path.join(home, ".claude", "projects", "-Users-x-repo", "notes.md"), root, { HOME: home })).toBe(false);
    expect(isAutoMemoryPath(path.join(home, ".claude", "projects", "-Users-x-repo", "memory"), root, { HOME: home })).toBe(false);
    expect(isAutoMemoryPath(path.join(root, "src", "memory", "x.ts"), root, { HOME: home })).toBe(false);
    // macOS: /var/folders/… and /private/var/folders/… are the same folder.
    const config = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-cfg-"));
    const real = fs.realpathSync(config);
    fs.mkdirSync(path.join(config, "projects", "-p", "memory"), { recursive: true });
    expect(isAutoMemoryPath(path.join(real, "projects", "-p", "memory", "a.md"), root, { HOME: home, CLAUDE_CONFIG_DIR: config })).toBe(true);
    expect(isAutoMemoryPath(path.join(config, "projects", "-p", "memory", "a.md"), root, { HOME: home, CLAUDE_CONFIG_DIR: real })).toBe(true);
    // autoMemoryDirectory in the project's settings.
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ autoMemoryDirectory: "~/notes/repo-memory" }));
    expect(isAutoMemoryPath(path.join(home, "notes", "repo-memory", "MEMORY.md"), root, { HOME: home })).toBe(true);
    expect(isAutoMemoryPath(path.join(home, "notes", "other", "MEMORY.md"), root, { HOME: home })).toBe(false);
  });
});
