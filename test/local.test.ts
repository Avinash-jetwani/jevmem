/**
 * The two local files 0.7.1's pane reads (0.7.0): `.jevmem/last-recall.json` after a prompt and
 * `.jevmem/last-decision.json` after a turn; and the call's `tool_use_id` in the guard's log.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateGuard } from "../src/guardrail.js";
import { evaluateTurn, LAST_DECISION_FILE, LAST_RECALL_FILE, runHook } from "../src/hook.js";
import { readGuardLog } from "../src/guardlog.js";
import { MemoryStore } from "../src/store.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { mockJev, relevance, SAVE_DECISION } from "./helpers.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-local-")));
const read = (root: string, name: string) => JSON.parse(fs.readFileSync(path.join(root, ".jevmem", name), "utf8"));

describe("the pane's local files", () => {
  it("last-recall.json holds what the prompt got, with ids, texts and scores, and stays in the gitignored folder", async () => {
    const root = tmp();
    const store = new MemoryStore(root);
    const m = store.add({ kind: "decision", text: "Invoices are archived as PDFs in S3" });
    fs.writeFileSync(path.join(root, ".jevmem", "provenance.jsonl"), JSON.stringify({ id: m.id, sha: "0", via: "hook" }) + "\n"); // not verified (wrong sha): gated in the call
    const jev = mockJev((q) => ({ ...relevance(q, 0.98), most_relevant: m.id, [`inj_${m.id}`]: 0.02 }));
    const out = await runHook({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "Where are invoices archived?" }, { jev });
    expect(out.action).toBe("injected");
    const r = read(root, LAST_RECALL_FILE);
    expect(r).toMatchObject({ path: "jev", served: [{ id: m.id, kind: "decision", text: "Invoices are archived as PDFs in S3", p: 0.98 }], withheld: [], gated: 1, deferred: 0 });
    expect(r.prompt_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof r.ms).toBe("number");
    expect(fs.readFileSync(path.join(root, ".jevmem", ".gitignore"), "utf8")).toBe("*\n");
    const none = await runHook({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "Unrelated: how does the build work?" }, { jev: mockJev((q) => ({ ...relevance(q, 0.05), most_relevant: "none" })) });
    expect(none.action).toBe("noop");
    expect(read(root, LAST_RECALL_FILE).served).toEqual([]);
  });

  it("last-decision.json holds the last turn's outcome: saved with the line and id, skipped with the reason, a duplicate with its line", async () => {
    const store = new MemoryStore(tmp());
    const jev = mockJev(() => ({ ...SAVE_DECISION }));
    const saved = await evaluateTurn(store, DEFAULT_CONFIG, jev, { hash: "h1", user: "Use Postgres 16 for the main database.", assistant: "Noted.", previous: "" });
    expect(saved.action).toBe("saved");
    const id = store.active()[0]!.id;
    expect(read(store.root, LAST_DECISION_FILE)).toMatchObject({ hash: "h1", action: "saved", kind: "decision", line: "Use Postgres 16 for the main database.", id, superseded: null, duplicate_of: null, source: "user_message", tier: 1 });
    await evaluateTurn(store, DEFAULT_CONFIG, jev, { hash: "h2", user: "[decision] Use Postgres 16 for the main database.", assistant: "Noted.", previous: "" });
    expect(read(store.root, LAST_DECISION_FILE)).toMatchObject({ hash: "h2", action: "skipped", duplicate_of: id, kind: null, id: null });
  });

  it("the guard's log carries the call's tool_use_id", async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "jevmem.config.json"), JSON.stringify(DEFAULT_CONFIG));
    fs.writeFileSync(path.join(root, "JEVMEM.md"), "- [constraint] Never commit .env files  <!-- id:cn0001 ts:2026-09-01T00:00:00.000Z conf:1.00 -->\n");
    fs.mkdirSync(path.join(root, ".jevmem"), { recursive: true });
    fs.writeFileSync(path.join(root, ".jevmem", "provenance.jsonl"), "");
    const jev = mockJev((q) => Object.fromEntries(Object.keys(q).filter((k) => k.startsWith("break_")).map((k) => [k, 0.02])));
    await evaluateGuard({ hook_event_name: "PreToolUse", cwd: root, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_01abc" }, { root, jev, log: true });
    const log = readGuardLog(root);
    expect(log.at(-1)).toMatchObject({ tool: "Bash", tool_use_id: "toolu_01abc" });
  });
});
