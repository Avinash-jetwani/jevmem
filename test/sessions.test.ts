/**
 * `jevmem import --from sessions` (0.7.1): the project's past Claude Code sessions, read with the Stop hook's reader,
 * counted before anything is sent, decided oldest first, written only with --apply. Session files are made up here in
 * the shapes Claude Code 2.1.2xx writes (test/fixtures/sessions/); the real format is covered by the captured sets.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { init } from "../src/init.js";
import { readProvenance, isVerified } from "../src/provenance.js";
import { findSessionFiles, formatSessionImport, importSessions, parseSince, readSessionFile, sessionsDir } from "../src/sessions.js";
import { MemoryStore } from "../src/store.js";
import { CHIT_CHAT, CONTRADICTS, mockJev, SAVE_DECISION } from "./helpers.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-sessions-")));
const entry = (type: "user" | "assistant", text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type, uuid: `${type}-${Math.random().toString(36).slice(2, 8)}`, isSidechain: false, timestamp: "2026-10-01T10:00:00.000Z", version: "2.1.296", message: { role: type, content: type === "user" ? text : [{ type: "text", text }] }, ...extra });
const toolResult = () => JSON.stringify({ type: "user", uuid: "tr", isSidechain: false, timestamp: "2026-10-01T10:00:01.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
const notification = () => JSON.stringify({ type: "user", uuid: "n1", isSidechain: false, promptSource: "system", origin: { kind: "task-notification" }, timestamp: "2026-10-01T10:00:02.000Z", message: { role: "user", content: "<task-notification>done</task-notification>" } });

/** A project with a home whose session folder holds the given files. */
function project(files: Record<string, string[]>) {
  const root = tmp();
  const home = tmp();
  init({ root, hooks: false });
  const dir = sessionsDir(root, { home, env: {} });
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), lines.join("\n") + "\n");
  return { root, home, dir };
}

describe("reading session files", () => {
  it("finds the project's folder under the config dir, reads turns and skips what is not a turn", () => {
    const { root, home } = project({
      "a.jsonl": [entry("user", "Decision: SQLite, one file."), toolResult(), entry("assistant", "Done: added a line to the README."), notification(), entry("user", "thanks"), entry("assistant", "You're welcome.")],
      "b.jsonl": ['{"type":"attachment","attachment":{}}', "not json", JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: "sidechain prompt" } })],
    });
    const found = findSessionFiles(root, { home, env: {} });
    expect(found.files.map((f) => f.session)).toEqual(["a"]);
    expect(found.files[0]!.turns.map((t) => t.user)).toEqual(["Decision: SQLite, one file.", "thanks"]);
    expect(found.files[0]!.turns[0]!.assistant).toBe("Done: added a line to the README.");
    expect(found.skipped).toEqual(["1 file(s) with no turn to decide", "1 line(s) that were not JSON"]);
    expect(found.suspect).toBeNull();
    expect(found.entryTypes.user).toBe(5);
    expect(found.versions).toEqual(["2.1.296"]);
  });

  it("says the format may have changed when no file gives a turn, and nothing when there is no folder", () => {
    const { root, home } = project({ "a.jsonl": ['{"type":"attachment"}', '{"type":"mode"}'] });
    const found = findSessionFiles(root, { home, env: {} });
    expect(found.files).toHaveLength(0);
    expect(found.suspect).toMatch(/format may have changed/);
    const bare = tmp();
    init({ root: bare, hooks: false });
    expect(findSessionFiles(bare, { home: tmp(), env: {} }).skipped[0]).toMatch(/no session folder/);
  });

  it("orders sessions oldest first and filters with --since", () => {
    const { root, home, dir } = project({});
    const at = (ts: string, text: string) => JSON.stringify({ type: "user", uuid: ts, isSidechain: false, timestamp: ts, message: { role: "user", content: text } });
    fs.writeFileSync(path.join(dir, "new.jsonl"), at("2026-10-10T10:00:00.000Z", "We use Postgres from now on.") + "\n");
    fs.writeFileSync(path.join(dir, "old.jsonl"), at("2026-09-01T10:00:00.000Z", "We use SQLite.") + "\n");
    expect(findSessionFiles(root, { home, env: {} }).files.map((f) => f.session)).toEqual(["old", "new"]);
    const since = parseSince("2026-10-01");
    expect(since?.toISOString().slice(0, 10)).toBe("2026-10-01");
    const recent = findSessionFiles(root, { home, env: {}, since });
    expect(recent.files.map((f) => f.session)).toEqual(["new"]);
    expect(recent.skipped).toContain("1 session(s) from before --since");
    expect(parseSince("30d", new Date("2026-10-13T00:00:00Z"))?.toISOString().slice(0, 10)).toBe("2026-09-13");
    expect(parseSince("12h", new Date("2026-10-13T12:00:00Z"))?.toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(parseSince("2w", new Date("2026-10-15T00:00:00Z"))?.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(parseSince("soon")).toBeNull();
  });

  it("reads an unreadable or missing file as empty", () => {
    const f = readSessionFile(path.join(tmp(), "missing.jsonl"));
    expect(f.turns).toEqual([]);
    expect(f.entries["(unreadable)"]).toBe(1);
  });
});

describe("importing sessions", () => {
  const jevFor = () =>
    mockJev((q, state: any) => {
      if (Object.keys(q).some((k) => k.startsWith("inj_"))) return Object.fromEntries(state.memories.map((m: any) => [`inj_${m.id}`, 0.03]));
      const msg: string = state.user_message;
      if (/thanks/i.test(msg)) return CHIT_CHAT;
      if (/Postgres/.test(msg) && state.existing_memories.length) return CONTRADICTS(state.existing_memories[0].id);
      if (/SQLite|Postgres|pino/.test(msg)) return SAVE_DECISION;
      return CHIT_CHAT;
    });

  it("decides turns oldest first, a reversal supersedes the earlier line, and nothing is written without apply", async () => {
    const { root, home } = project({
      "s1.jsonl": [entry("user", "Decision: SQLite, one file."), entry("assistant", "Noted."), entry("user", "thanks"), entry("assistant", "Sure.")],
      "s2.jsonl": [JSON.stringify({ type: "user", uuid: "u2", isSidechain: false, timestamp: "2026-10-02T10:00:00.000Z", message: { role: "user", content: "Change of plan: Postgres after all." } })],
    });
    const store = new MemoryStore(root);
    const cfg = loadConfig(root);
    const found = findSessionFiles(root, { home, env: {} });
    const dry = await importSessions(jevFor(), store, cfg, found.files, { apply: false });
    expect(dry.map((r) => r.outcome)).toEqual(["add", "skip", "add"]);
    expect(dry[2]!.supersedes).toBe("row0");
    expect(store.list()).toHaveLength(0);
    const text = formatSessionImport(dry, { apply: false, files: found.files });
    expect(text).toMatch(/dry run/);
    expect(text).toMatch(/Would add 2 line/);
    const rows = await importSessions(jevFor(), store, cfg, found.files, { apply: true });
    const lines = store.list();
    expect(lines).toHaveLength(2);
    expect(lines[0]!.kind).toBe("superseded");
    expect(lines[0]!.supersededBy).toBe(lines[1]!.id);
    expect(rows.filter((r) => r.savedId)).toHaveLength(2);
    const prov = readProvenance(root);
    for (const m of lines) expect(isVerified(prov, m)).toBe(true);
    expect(fs.readFileSync(path.join(root, ".jevmem", "decisions.jsonl"), "utf8")).toMatch(/"via":"import-sessions"/);
  });
});
