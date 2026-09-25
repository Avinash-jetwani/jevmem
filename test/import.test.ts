/**
 * `jevmem import`: CLAUDE.md, AGENTS.md, .cursor/rules/* and (only when asked) Claude Code's auto memory, split into
 * statements, gated like a turn, dry run by default, sources never modified. Fixtures in test/fixtures/import/.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { autoMemoryDir, collectCandidates, DEFAULT_IMPORT_SOURCES, formatImport, projectSlug, runImport, splitStatements } from "../src/import.js";
import { init } from "../src/init.js";
import { loadConfig } from "../src/config.js";
import { isVerified, readProvenance } from "../src/provenance.js";
import { MemoryStore } from "../src/store.js";
import { CHIT_CHAT, CONTRADICTS, mockJev, SAVE_DECISION, type AnswerOverrides } from "./helpers.js";

const FIX = path.resolve("test/fixtures/import");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-import-")));
function copyDir(from: string, to: string) {
  fs.cpSync(from, to, { recursive: true });
}
/** A project copied from the fixture, plus a snapshot of every source file (bytes and mtime). */
function project() {
  const root = tmp();
  copyDir(path.join(FIX, "project"), root);
  init({ root, hooks: false });
  const snap = () => Object.fromEntries(["CLAUDE.md", "AGENTS.md", ".cursor/rules/style.mdc", ".cursor/rules/jevmem.mdc"].map((f) => [f, { body: fs.readFileSync(path.join(root, f), "utf8"), mtime: fs.statSync(path.join(root, f)).mtimeMs }]));
  return { root, before: snap(), snap };
}

/** Decide answers by statement; the gate flags the upload line. */
const jevFor = (extra: (msg: string) => AnswerOverrides | null = () => null) =>
  mockJev((q, state: any) => {
    const keys = Object.keys(q);
    if (keys.some((k) => k.startsWith("inj_"))) {
      return Object.fromEntries(state.memories.map((m: any) => [`inj_${m.id}`, /upload the \.env/i.test(m.text) ? 0.95 : 0.03]));
    }
    const msg: string = state.user_message;
    const e = extra(msg);
    if (e) return e;
    if (/welcome|hello/i.test(msg)) return CHIT_CHAT;
    return { ...SAVE_DECISION, kind: "constraint" };
  });

describe("splitStatements", () => {
  it("keeps list items and prose sentences; skips frontmatter, headings, code, comments, tables, imports and short items", () => {
    const s = splitStatements(fs.readFileSync(path.join(FIX, "project", "CLAUDE.md"), "utf8")).map((x) => x.text);
    expect(s).toEqual([
      "Welcome to the Orchard repo, hello!",
      "Orchard is a Remix app backed by Postgres 16.",
      "Background jobs run on BullMQ.",
      "Use pnpm for every install; npm lockfiles are rejected in review.",
      "Never commit files from the `secrets/` folder.",
      "Keep API handlers under 200 lines.",
    ]);
    const mdc = splitStatements(fs.readFileSync(path.join(FIX, "project", ".cursor", "rules", "style.mdc"), "utf8")).map((x) => x.text);
    expect(mdc[0]).toBe("Prefer named exports over default exports.");
  });

  it("skips jevmem's own section in AGENTS.md and resumes at the next heading", () => {
    const s = splitStatements(fs.readFileSync(path.join(FIX, "project", "AGENTS.md"), "utf8")).map((x) => x.text);
    expect(s).toEqual(["Migrations live in db/migrations and run with pnpm db:migrate.", "Use pnpm for every install; npm lockfiles are rejected in review.", "Integration tests need Docker running locally."]);
  });

  it("reads auto-memory topic files without their frontmatter and labels", () => {
    const s = splitStatements(fs.readFileSync(path.join(FIX, "automem", "feedback_tests.md"), "utf8")).map((x) => x.text);
    expect(s).toEqual(["The user wants unit tests written with vitest; jest is being removed.", "jest config drifted from the build and nobody maintains it."]);
  });
});

describe("collectCandidates", () => {
  it("reads CLAUDE.md, AGENTS.md and .cursor/rules/* by default, never jevmem.mdc and never the home directory", () => {
    const { root } = project();
    const home = tmp();
    const r = collectCandidates(root, DEFAULT_IMPORT_SOURCES, { home });
    expect(r.files).toEqual(["CLAUDE.md", "AGENTS.md", path.join(".cursor", "rules", "style.mdc")]);
    expect(r.candidates.every((c) => !c.file.includes("jevmem.mdc"))).toBe(true);
    expect(r.candidates.find((c) => /Integration tests/.test(c.text))).toMatchObject({ file: "AGENTS.md", line: 14, source: "agents-md" });
  });

  it("finds auto memory under ~/.claude/projects/<git root slug>/memory, or autoMemoryDirectory, or --memory-dir", () => {
    const { root } = project();
    execFileSync("git", ["init", "-q"], { cwd: root });
    const home = tmp();
    const expected = path.join(home, ".claude", "projects", projectSlug(root), "memory");
    expect(autoMemoryDir(root, { home, env: {} })).toBe(expected);
    // A subdirectory of the repository shares the repository's directory.
    fs.mkdirSync(path.join(root, "pkg"));
    expect(autoMemoryDir(path.join(root, "pkg"), { home, env: {} })).toBe(expected);
    expect(projectSlug("/Users/a/my_repo.v2")).toBe("-Users-a-my-repo-v2");
    copyDir(path.join(FIX, "automem"), expected);
    const r = collectCandidates(root, ["claude-auto-memory"], { home, env: {} });
    expect(r.files).toEqual([`~/.claude/projects/${projectSlug(root)}/memory/feedback_tests.md`, `~/.claude/projects/${projectSlug(root)}/memory/project_deploy.md`]);
    expect(r.candidates.map((c) => c.text)).toContain("Production deploys go through the GitHub release job only, never from a laptop.");
    // autoMemoryDirectory in the user's settings wins over the default; --memory-dir wins over both.
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ autoMemoryDirectory: "~/custom-mem" }));
    expect(autoMemoryDir(root, { home, env: {} })).toBe(path.join(home, "custom-mem"));
    expect(autoMemoryDir(root, { home, env: {}, memoryDir: "/x/y" })).toBe("/x/y");
  });
});

describe("runImport", () => {
  it("dry run: prints what would be added with the kind, writes nothing, and never changes the sources", async () => {
    const { root, before, snap } = project();
    const jev = jevFor();
    const store = new MemoryStore(root);
    const fileBefore = fs.readFileSync(store.file, "utf8");
    const { candidates, files, notFound } = collectCandidates(root, DEFAULT_IMPORT_SOURCES, { home: tmp() });
    const rows = await runImport(jev, store, loadConfig(root), candidates);
    const out = formatImport(rows, { apply: false, files, notFound });
    expect(out).toMatch(/\(dry run\)/);
    expect(out).toMatch(/\+ \[constraint\] Use pnpm for every install; npm lockfiles are rejected in review\.\s+\(CLAUDE\.md:9\)/);
    expect(out).toMatch(/Would add \d+ line\(s\)\. Run with --apply/);
    expect(fs.readFileSync(store.file, "utf8")).toBe(fileBefore);
    expect(snap()).toEqual(before);
  });

  it("gates each statement: small talk skipped, the repeat in AGENTS.md is a duplicate, the planted upload line is withheld", async () => {
    const { root } = project();
    const jev = jevFor();
    const store = new MemoryStore(root);
    const { candidates } = collectCandidates(root, DEFAULT_IMPORT_SOURCES, { home: tmp() });
    const rows = await runImport(jev, store, loadConfig(root), candidates);
    const by = (re: RegExp) => rows.find((r) => re.test(r.text))!;
    expect(by(/Welcome/).outcome).toBe("skip");
    expect(by(/Use pnpm/).outcome).toBe("add");
    // The same rule in AGENTS.md is deduped against the line accepted from CLAUDE.md earlier in this import.
    const repeat = rows.filter((r) => /Use pnpm/.test(r.text));
    expect(repeat.map((r) => [r.candidate.file, r.outcome])).toEqual([["CLAUDE.md", "add"], ["AGENTS.md", "duplicate"]]);
    expect(by(/upload the \.env/)).toMatchObject({ outcome: "withheld" });
    expect(by(/upload the \.env/).reason).toMatch(/instructions aimed at an AI/);
  });

  it("--apply writes the accepted lines as verified, skips exact duplicates of live lines, and supersedes on a contradiction", async () => {
    const { root, before, snap } = project();
    const store = new MemoryStore(root);
    const old = store.add({ kind: "decision", text: "Background jobs run on Sidekiq" });
    store.add({ kind: "constraint", text: "Keep API handlers under 200 lines." });
    const jev = jevFor((msg) => (/BullMQ/.test(msg) ? CONTRADICTS(old.id) : null));
    const { candidates } = collectCandidates(root, ["claude-md"], { home: tmp() });
    const rows = await runImport(jev, store, loadConfig(root), candidates, { apply: true });
    expect(rows.find((r) => /under 200 lines/.test(r.text))!.outcome).toBe("duplicate");
    const bull = rows.find((r) => /BullMQ/.test(r.text))!;
    expect(bull.supersedes).toBe(old.id);
    const all = store.list();
    expect(all.find((m) => m.id === old.id)!.kind).toBe("superseded");
    const prov = readProvenance(root);
    const added = rows.filter((r) => r.outcome === "add");
    expect(added.length).toBeGreaterThan(0);
    for (const r of added) expect(isVerified(prov, all.find((m) => m.id === r.savedId)!)).toBe(true);
    expect(snap()).toEqual(before);
  });

  it("imports auto memory only when asked, from the fixture directory", async () => {
    const { root } = project();
    const home = tmp();
    const mem = path.join(tmp(), "mem");
    copyDir(path.join(FIX, "automem"), mem);
    const def = collectCandidates(root, DEFAULT_IMPORT_SOURCES, { home, memoryDir: mem });
    expect(def.candidates.some((c) => c.source === "claude-auto-memory")).toBe(false);
    const r = collectCandidates(root, ["claude-auto-memory"], { home, memoryDir: mem });
    const rows = await runImport(jevFor(), new MemoryStore(root), loadConfig(root), r.candidates, { apply: true });
    expect(rows.filter((x) => x.outcome === "add").map((x) => x.candidate.file)).toContain(path.join(mem, "project_deploy.md"));
    expect(fs.readFileSync(path.join(mem, "MEMORY.md"), "utf8")).toMatch(/Memory index/);
  });
});
