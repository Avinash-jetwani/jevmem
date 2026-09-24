import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { init } from "../src/init.js";
import { formatInjection, JEVMEM_HANDS_OFF } from "../src/recall.js";
import { LEGACY_HEADERS, MEMORY_HEADER, MemoryStore } from "../src/store.js";
import { AGENTS_SECTION, CURSOR_RULE, LEGACY_AGENTS_SECTIONS, LEGACY_CURSOR_RULES, setupCodex, setupCursor } from "../src/tools.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-header-"));
const OLD = LEGACY_HEADERS[0]!;
const memLine = "- [decision] Use Postgres 16 for the main database  <!-- id:abc123 ts:2026-09-24T10:00:00.000Z conf:0.91 -->";

describe("JEVMEM.md header", () => {
  it("tells AI assistants not to write the file, and people that they may", () => {
    expect(MEMORY_HEADER).toContain("AI assistants: do not add, edit or remove lines in this file.");
    expect(MEMORY_HEADER).toContain("People: edit freely, one memory per line.");
    const root = tmp();
    init({ root, hooks: false });
    expect(fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8")).toBe(MEMORY_HEADER);
  });

  it("init replaces the old default header, keeping every memory line", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "JEVMEM.md"), OLD + memLine + "\n");
    const r = init({ root, hooks: false });
    expect(r.created.join()).toMatch(/JEVMEM\.md \(header updated/);
    const text = fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8");
    expect(text.startsWith(MEMORY_HEADER)).toBe(true);
    expect(text).not.toContain("Jev decides what is worth keeping");
    expect(new MemoryStore(root).active().map((m) => m.id)).toEqual(["abc123"]);
  });

  it("init replaces the old default header on an empty file too (trailing whitespace ignored)", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "JEVMEM.md"), OLD.replace(/\n+$/, "\n\n\n"));
    init({ root, hooks: false });
    expect(fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8").startsWith(MEMORY_HEADER.trimEnd())).toBe(true);
  });

  it("never touches a header the user edited", () => {
    const root = tmp();
    const edited = OLD.replace("Edit freely; keep one memory per line.", "Edit freely; keep one memory per line. Owned by the platform team.") + memLine + "\n";
    fs.writeFileSync(path.join(root, "JEVMEM.md"), edited);
    const r = init({ root, hooks: false });
    expect(r.skipped).toContain("JEVMEM.md");
    expect(fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8")).toBe(edited);
    const custom = "# Our memory\n\nWritten by hand, curated weekly.\n\n" + memLine + "\n";
    fs.writeFileSync(path.join(root, "JEVMEM.md"), custom);
    init({ root, hooks: false });
    expect(fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8")).toBe(custom);
  });
});

describe("injected context", () => {
  it("tells the assistant not to write JEVMEM.md whenever memories are injected, and injects nothing without memories", () => {
    const ranked = [{ memory: { id: "abc123", kind: "decision", text: "Use Postgres 16", ts: "", conf: 1 }, choiceProbability: 0.9 }] as any;
    const out = formatInjection(ranked);
    expect(out).toContain(JEVMEM_HANDS_OFF);
    expect(JEVMEM_HANDS_OFF).toBe("jevmem saves memories automatically; don't write to JEVMEM.md yourself.");
    expect(formatInjection([])).toBe("");
  });
});

describe("agent instructions", () => {
  it("the Cursor rule and AGENTS.md section say: add_memory only, never edit JEVMEM.md directly", () => {
    for (const t of [CURSOR_RULE, AGENTS_SECTION]) expect(t).toMatch(/Never add, edit or remove lines in `JEVMEM\.md` directly/);
  });

  it("init upgrades an unmodified old Cursor rule and AGENTS.md section, and leaves edited ones alone", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, ".cursor", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, ".cursor", "rules", "jevmem.mdc"), LEGACY_CURSOR_RULES[0]!);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# AGENTS.md\n" + LEGACY_AGENTS_SECTIONS[0]!);
    setupCursor(root);
    setupCodex(root, tmp());
    expect(fs.readFileSync(path.join(root, ".cursor", "rules", "jevmem.mdc"), "utf8")).toBe(CURSOR_RULE);
    const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain(AGENTS_SECTION.trim());
    expect(agents.match(/## Jevmem project memory/g)).toHaveLength(1);

    const edited = tmp();
    fs.mkdirSync(path.join(edited, ".cursor", "rules"), { recursive: true });
    const myRule = LEGACY_CURSOR_RULES[0]! + "- Also mention the ticket number.\n";
    fs.writeFileSync(path.join(edited, ".cursor", "rules", "jevmem.mdc"), myRule);
    setupCursor(edited);
    expect(fs.readFileSync(path.join(edited, ".cursor", "rules", "jevmem.mdc"), "utf8")).toBe(myRule);
  });
});

describe("AGENTS.md upgrade is exact and idempotent", () => {
  it("does not re-upgrade the new section, and leaves a section with extra user bullets alone", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# AGENTS.md\n" + LEGACY_AGENTS_SECTIONS[0]! + "\n## Other\n\nKeep this.\n");
    setupCodex(root, tmp());
    const once = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(once).toContain(AGENTS_SECTION.trim());
    expect(once).toContain("## Other\n\nKeep this.");
    expect(setupCodex(root, tmp()).created).toEqual([]);
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe(once);

    const mine = tmp();
    const withExtra = "# AGENTS.md\n" + LEGACY_AGENTS_SECTIONS[0]!.trimEnd() + "\n- Also link the ticket.\n";
    fs.writeFileSync(path.join(mine, "AGENTS.md"), withExtra);
    setupCodex(mine, tmp());
    expect(fs.readFileSync(path.join(mine, "AGENTS.md"), "utf8")).toBe(withExtra);
  });
});
