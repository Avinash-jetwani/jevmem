/**
 * `jevmem forget` and the leading-tag strip (0.7.0): a retired line's format and readers, the CLI's rules for a
 * [constraint], `wrong --should-be none` retiring instead of deleting, and the tags the writer and `jevmem add` drop.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli-main.js";
import { loadRules } from "../src/guardrail.js";
import { stripFiller } from "../src/llm/index.js";
import { replacedTexts } from "../src/recall.js";
import { formatLine, isLive, MemoryStore, parseLine } from "../src/store.js";
import { stripLeadingTags } from "../src/tags.js";
import { DEFAULT_CONFIG, KINDS, NEW_KINDS } from "../src/types.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-forget-")));
function run(argv: string[], cwd: string) {
  let out = "";
  let err = "";
  return main(argv, { out: (s) => void (out += s), err: (s) => void (err += s), cwd }).then((code) => ({ code, out, err }));
}

describe("the retired kind", () => {
  it("is a kind, never a new one, and round-trips with was: and retired: in the comment", () => {
    expect(KINDS).toContain("retired");
    expect(NEW_KINDS).not.toContain("retired");
    const line = "- [retired] Add a sitemap before the spring launch  <!-- id:ab12cd ts:2026-09-22T10:00:00.000Z conf:0.91 was:todo retired:2026-10-08T12:00:00.000Z -->";
    const mem = parseLine(line)!;
    expect(mem).toMatchObject({ id: "ab12cd", kind: "retired", text: "Add a sitemap before the spring launch", was: "todo", retiredAt: "2026-10-08T12:00:00.000Z" });
    expect(formatLine(mem)).toBe(line);
    expect(isLive(mem)).toBe(false);
  });

  it("store.retire keeps the text, records the kind it had, takes the line out of active() and not of list()", () => {
    const store = new MemoryStore(tmp());
    const a = store.add({ kind: "todo", text: "Rotate the signing key before the audit" });
    const b = store.add({ kind: "decision", text: "Use Postgres 16" });
    const r = store.retire(a.id)!;
    expect(r).toMatchObject({ id: a.id, kind: "retired", was: "todo", text: "Rotate the signing key before the audit" });
    expect(r.retiredAt).toMatch(/^\d{4}-/);
    expect(store.active().map((m) => m.id)).toEqual([b.id]);
    expect(store.list().map((m) => m.id)).toEqual([a.id, b.id]);
    expect(fs.readFileSync(store.file, "utf8")).toMatch(/^- \[retired\] Rotate the signing key before the audit {2}<!-- id:\w+ ts:\S+ conf:1\.00 was:todo retired:\S+ -->$/m);
    expect(store.retire(a.id)).toBeNull();
    expect(store.retire("nosuch")).toBeNull();
  });

  it("a retired line is not a reader's live line: replacedTexts drops a chain that ends at it, and the guard lists a retired rule as skipped", () => {
    const store = new MemoryStore(tmp());
    const old = store.add({ kind: "decision", text: "Use SQLite" });
    const neu = store.add({ kind: "decision", text: "Use Postgres" });
    store.supersede(old.id, neu.id);
    expect(replacedTexts(store.list()).get(neu.id)).toEqual(["Use SQLite"]);
    store.retire(neu.id);
    expect(replacedTexts(store.list()).size).toBe(0);
    const rule = store.add({ kind: "constraint", text: "Never commit .env files" });
    store.retire(rule.id);
    const rules = loadRules(store.root, DEFAULT_CONFIG, fs.readFileSync(store.file, "utf8"));
    expect(rules.enforced).toEqual([]);
    expect(rules.skipped.find((s) => s.id === rule.id)?.reason).toMatch(/^retired on \d{4}-\d{2}-\d{2}$/);
  });
});

describe("jevmem forget", () => {
  it("retires a to-do at once, says what it retired, and leaves the file's other lines", async () => {
    const cwd = tmp();
    const store = new MemoryStore(cwd);
    const t = store.add({ kind: "todo", text: "Add a sitemap before the spring launch" });
    const d = store.add({ kind: "decision", text: "Use Postgres 16" });
    const r = await run(["forget", t.id], cwd);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`retired ${t.id}: [todo] Add a sitemap before the spring launch\n`);
    expect(store.active().map((m) => m.id)).toEqual([d.id]);
    expect(store.list().find((m) => m.id === t.id)).toMatchObject({ kind: "retired", was: "todo" });
    const log = fs.readFileSync(path.join(cwd, ".jevmem", "log.jsonl"), "utf8");
    expect(log).toContain(`"label":"forget"`);
    expect(log).toContain(`"memoryId":"${t.id}"`);
    expect((await run(["forget", t.id], cwd)).out).toBe(`${t.id} is already retired\n`);
  });

  it("refuses a rule without a terminal, with nothing changed, and exits 1 for an unknown id", async () => {
    const cwd = tmp();
    const store = new MemoryStore(cwd);
    const rule = store.add({ kind: "constraint", text: "Never commit .env files" });
    const r = await run(["forget", rule.id], cwd);
    expect(r.code).toBe(1);
    expect(r.out).toBe(`[constraint] Never commit .env files  (${rule.id})\n`);
    expect(r.err).toContain("needs a yes on a terminal");
    expect(store.active().map((m) => m.id)).toEqual([rule.id]);
    const u = await run(["forget", "nosuch"], cwd);
    expect(u.code).toBe(1);
    expect(u.err).toContain("no line with id nosuch");
    expect((await run(["forget"], cwd)).code).toBe(1);
  });

  it("wrong --should-be none retires the line instead of deleting it", async () => {
    const cwd = tmp();
    const store = new MemoryStore(cwd);
    const m = store.add({ kind: "decision", text: "Use Postgres 16" });
    const decision = { save: true, kind: "decision", importance: "useful", importanceScore: 2, contradiction: false, touchesMemoryId: null, worksNow: null, retest: null, nouls: {}, families: {}, content: 0.9, kindProbabilities: { decision: 0.9 }, confidence: 0.9, reason: "save", usage: { inputTokens: 1, outputTokens: 1 }, cacheHit: false, thresholds: DEFAULT_CONFIG.thresholds, source: "user_message", assistantIncluded: false, sourceText: "", tier: 1, mode: "auto", escalated: false, escalationReasons: [] };
    fs.mkdirSync(path.join(cwd, ".jevmem"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".jevmem", "decisions.jsonl"), JSON.stringify({ ts: "2026-10-08T00:00:00.000Z", hash: "abc123def456", memoryId: m.id, message: "USER: Use Postgres 16", decision }) + "\n");
    const r = await run(["wrong", m.id, "--should-be", "none"], cwd);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`retired ${m.id}`);
    expect(store.active()).toEqual([]);
    expect(store.list().find((x) => x.id === m.id)).toMatchObject({ kind: "retired", was: "decision", text: "Use Postgres 16" });
  });
});

describe("the leading-tag strip", () => {
  it("drops kind and label tags, doubled or not, in any case, with a list dash, and keeps other bracketed tokens", () => {
    expect(stripLeadingTags("[constraint] Never commit the key.")).toBe("Never commit the key.");
    expect(stripLeadingTags("[constraint] [constraint] Pull requests need one approval.")).toBe("Pull requests need one approval.");
    expect(stripLeadingTags("- [constraint] Never force-push to main.")).toBe("Never force-push to main.");
    expect(stripLeadingTags("[Decision] Logs go to Loki.")).toBe("Logs go to Loki.");
    expect(stripLeadingTags("[TODO] Remove the importer.")).toBe("Remove the importer.");
    expect(stripLeadingTags("[Dead end] It corrupted the fixture, so it runs serially.")).toBe("It corrupted the fixture, so it runs serially.");
    expect(stripLeadingTags("[rule] [note] Secrets come from the environment.")).toBe("Secrets come from the environment.");
    for (const keep of ["[DEPRECATED] endpoints stay for one release.", "[WIP] pages are hidden.", "[sic] is kept.", "[2026-Q4] The migration lands.", "[FEATURE] flags come from LaunchDarkly."]) expect(stripLeadingTags(keep)).toBe(keep);
    expect(stripLeadingTags("[constraint]")).toBe("[constraint]");
    expect(stripLeadingTags("plain text [constraint] inside")).toBe("plain text [constraint] inside");
  });

  it("applies in stripFiller before the label filler, and in store.add", () => {
    expect(stripFiller("[note] Decision: we use Fastify.")).toBe("We use Fastify.");
    expect(stripFiller("[constraint] [constraint] Never commit .env files")).toBe("Never commit .env files");
    expect(stripFiller("[DEPRECATED] endpoints return a Sunset header.")).toBe("[DEPRECATED] endpoints return a Sunset header.");
    const store = new MemoryStore(tmp());
    expect(store.add({ kind: "constraint", text: "[constraint] [constraint] Never print the key." }).text).toBe("Never print the key.");
    expect(store.add({ kind: "todo", text: "[DEPRECATED] routes are listed in docs/deprecations.md." }).text).toBe("[DEPRECATED] routes are listed in docs/deprecations.md.");
  });

  it("reaches jevmem add through the CLI", async () => {
    const cwd = tmp();
    const r = await run(["add", "decision", "[decision] [decision] Builds run on GitHub Actions only."], cwd);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^added \w+: \[decision\] Builds run on GitHub Actions only\.\n$/);
  });
});
