import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "../src/decide.js";
import { MemoryStore } from "../src/store.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { composeLine, writeMemory } from "../src/write.js";
import { mockJev, SAVE_DECISION } from "./helpers.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-contra-"));
const writerNone = { writer: { ...DEFAULT_CONFIG.writer, provider: "none" as const }, env: {} as NodeJS.ProcessEnv };

describe("contradiction handling", () => {
  it("appends the new line and tags the old one [superseded] → id:new", async () => {
    const root = tmp();
    const store = new MemoryStore(root);
    const old = store.add({ kind: "decision", text: "Use SQLite for the primary store", conf: 0.8 });
    const jev = mockJev(() => ({ ...SAVE_DECISION, contradicts_existing_memory: 0.92, touches_memory_id: old.id }));
    const message = "USER: Actually, switch the primary store to Postgres. SQLite can't handle the concurrency.";
    const d = await decide(jev, { message, existingMemories: store.active() });
    expect(d.contradiction).toBe(true);
    expect(d.touchesMemoryId).toBe(old.id);
    const r = await writeMemory(store, message, d, writerNone);
    expect(r.superseded?.id).toBe(old.id);
    const raw = fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8");
    expect(raw).toContain(`- [superseded] Use SQLite for the primary store → id:${r.saved.id}`);
    expect(raw).toContain(`- [decision] ${r.line}`);
    expect(store.active()).toHaveLength(1);
    expect(store.active()[0]!.id).toBe(r.saved.id);
  });

  it("does not supersede when the noul is high but no memory id was chosen", async () => {
    const store = new MemoryStore(tmp());
    const old = store.add({ kind: "decision", text: "Use SQLite", conf: 0.8 });
    const jev = mockJev(() => ({ ...SAVE_DECISION, contradicts_existing_memory: 0.95, touches_memory_id: "none" }));
    const d = await decide(jev, { message: "USER: Use Postgres now.", existingMemories: store.active() });
    const r = await writeMemory(store, "USER: Use Postgres now.", d, writerNone);
    expect(r.superseded).toBeNull();
    expect(store.active().map((m) => m.id).sort()).toEqual([old.id, r.saved.id].sort());
  });

  it("refuses to write a non-save decision", async () => {
    const store = new MemoryStore(tmp());
    const jev = mockJev(() => ({ kind: "none" }));
    const d = await decide(jev, { message: "USER: hi", existingMemories: [] });
    await expect(writeMemory(store, "USER: hi", d, writerNone)).rejects.toThrow(/non-save/);
  });
});

describe("writer", () => {
  it("falls back to the first sentence, trimmed to maxChars, when no LLM key is present", async () => {
    const msg = "USER: We'll go with Postgres 16 because SQLite locks under load. Also, unrelated: lunch was great.";
    const { line, writerUsed } = await composeLine(msg, "decision", { writer: { ...DEFAULT_CONFIG.writer, provider: "auto" }, env: {} as any });
    expect(writerUsed).toBe("fallback");
    expect(line).toBe("We'll go with Postgres 16 because SQLite locks under load.");
    const long = await composeLine("A".repeat(300) + " tail", "todo", { writer: { ...DEFAULT_CONFIG.writer, provider: "none" }, env: {} as any });
    expect(long.line.length).toBeLessThanOrEqual(140);
  });

  it("prefers the assistant's root-cause sentence over the user's question for bug findings", async () => {
    const msg = "USER: why is the login test flaky?\n\nASSISTANT: Found it: the flaky login test was caused by two tests sharing a temp dir. I gave each its own tmpdir.";
    const { line } = await composeLine(msg, "bug", { writer: { ...DEFAULT_CONFIG.writer, provider: "none" }, env: {} as any });
    expect(line).toBe("Found it: the flaky login test was caused by two tests sharing a temp dir.");
  });

  it("uses an OpenAI-compatible endpoint when configured and clamps to one line", async () => {
    const seen: any[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "  Use Postgres 16 as the primary store; SQLite locked under load.\nextra line" } }] }), { status: 200 });
    };
    const env = { OPENAI_API_KEY: "test", JEVMEM_WRITER: "openai" } as any;
    const { line, writerUsed } = await composeLine("USER: switch to Postgres 16. Key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789", "decision", { writer: DEFAULT_CONFIG.writer, env, fetchImpl });
    expect(writerUsed).toBe("openai");
    expect(line).toBe("Use Postgres 16 as the primary store; SQLite locked under load.");
    expect(seen[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(seen[0].body.model).toBe("gpt-5-mini");
    expect(JSON.stringify(seen[0].body)).not.toContain("sk-proj-abcdefghijklmnop");
  });

  it("uses Anthropic when only that key is present, and falls back on HTTP errors", async () => {
    const ok: typeof fetch = async () => new Response(JSON.stringify({ content: [{ type: "text", text: "Ship the cron job as a queue worker before launch." }] }), { status: 200 });
    const env = { ANTHROPIC_API_KEY: "test" } as any;
    const a = await composeLine("USER: move the cron job to a queue before launch", "todo", { writer: DEFAULT_CONFIG.writer, env, fetchImpl: ok });
    expect(a.writerUsed).toBe("anthropic");
    const bad: typeof fetch = async () => new Response("nope", { status: 500 });
    const b = await composeLine("USER: move the cron job to a queue before launch", "todo", { writer: DEFAULT_CONFIG.writer, env, fetchImpl: bad });
    expect(b.writerUsed).toBe("fallback");
  });
});
