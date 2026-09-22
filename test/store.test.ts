import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore, formatLine, parseLine, parseMemoryFile, serializeMemoryFile } from "../src/store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-store-"));

describe("line format", () => {
  it("round-trips a memory line", () => {
    const line = "- [decision] Use Postgres for the primary store  <!-- id:ab12cd ts:2026-09-22T10:00:00.000Z conf:0.91 -->";
    const mem = parseLine(line)!;
    expect(mem).toMatchObject({ id: "ab12cd", kind: "decision", text: "Use Postgres for the primary store", conf: 0.91 });
    expect(formatLine(mem)).toBe(line);
  });

  it("parses superseded lines with the arrow and by: token", () => {
    const mem = parseLine("- [superseded] Use SQLite → id:zz9xyz  <!-- id:aaaaaa ts:2026-01-01T00:00:00.000Z conf:0.80 by:zz9xyz -->")!;
    expect(mem.kind).toBe("superseded");
    expect(mem.text).toBe("Use SQLite");
    expect(mem.supersededBy).toBe("zz9xyz");
    expect(formatLine(mem)).toContain("→ id:zz9xyz");
    expect(formatLine(mem)).toContain("by:zz9xyz");
  });

  it("parses and renders [stale?] flags", () => {
    const mem = parseLine("- [architecture] [stale?] Auth lives in packages/auth  <!-- id:bbbbbb ts:2026-01-01T00:00:00.000Z conf:0.70 stale:0.31 -->")!;
    expect(mem.stale).toBeCloseTo(0.31);
    expect(mem.text).toBe("Auth lives in packages/auth");
    expect(formatLine(mem)).toMatch(/^- \[architecture\] \[stale\?\] Auth lives/);
  });

  it("ignores non-memory lines and unknown kinds", () => {
    expect(parseLine("# JEVMEM.md")).toBeNull();
    expect(parseLine("- [banana] nope  <!-- id:x -->")).toBeNull();
    expect(parseLine("- plain bullet without metadata")).toBeNull();
  });

  it("preserves header prose across a parse/serialize round trip", () => {
    const src = "# My notes\n\nSome intro.\n\n- [todo] Add tests  <!-- id:cccccc ts:2026-01-01T00:00:00.000Z conf:1.00 -->\n";
    const file = parseMemoryFile(src);
    expect(file.header.join("\n")).toContain("Some intro.");
    expect(serializeMemoryFile(file)).toBe(src);
  });
});

describe("MemoryStore", () => {
  it("adds, lists, supersedes, and removes", () => {
    const root = tmp();
    const store = new MemoryStore(root);
    const a = store.add({ kind: "decision", text: "Use SQLite", conf: 0.8 });
    const b = store.add({ kind: "decision", text: "Use Postgres", conf: 0.9 });
    expect(store.list()).toHaveLength(2);
    expect(store.supersede(a.id, b.id)?.kind).toBe("superseded");
    expect(store.active().map((m) => m.id)).toEqual([b.id]);
    const raw = fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8");
    expect(raw).toContain(`- [superseded] Use SQLite → id:${b.id}`);
    expect(raw).toContain("- [decision] Use Postgres");
    expect(fs.existsSync(path.join(root, ".jevmem", "index.json"))).toBe(true);
    expect(fs.readFileSync(path.join(root, ".jevmem", ".gitignore"), "utf8")).toBe("*\n");
    expect(store.remove(b.id)).toBe(true);
    expect(store.list()).toHaveLength(1);
  });

  it("collapses whitespace and never generates duplicate ids", () => {
    const store = new MemoryStore(tmp());
    const a = store.add({ kind: "todo", text: "  multi\n line   text " });
    expect(a.text).toBe("multi line text");
    const b = store.add({ kind: "todo", text: "x", id: a.id });
    expect(b.id).not.toBe(a.id);
  });
});
