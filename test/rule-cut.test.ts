/**
 * 0.7.7: a line keeps its rule. A line aims at `writer.maxChars` (200), but the sentences that state the memory are kept
 * whole up to one and a half times that (300) instead of being cut at 200; past 300 the line is cut at a clause end as
 * before. Found in the 0.7.7 comparison: 9 of jevmem's misses came from lines cut before their rule (cm-exit,
 * bn-statuses, bn-sms). The statements here are the dev set's (eval/rule-cut-dev.jsonl) and new ones; the held-out set
 * (eval/rule-cut-heldout.jsonl) is run once.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clampLine, fitLine, lineCeiling, roomFor } from "../src/llm/index.js";
import { splitStatements } from "../src/import.js";
import { composeLine } from "../src/write.js";
import { mockJev, type AnswerOverrides } from "./helpers.js";

const writer = { provider: "none" as const, maxChars: 200, timeoutMs: 1000 };
const picker = (main: string, reason = "none") => mockJev((q): AnswerOverrides => ("states_the_memory" in q ? { states_the_memory: main, gives_the_reason: reason } : {}));

// The comparison's statements (eval/ab/tasks-automem.mjs), as taught.
const CM_EXIT = "A detail the scripts around calmerge rely on: its exit status is 0 when it wrote the merged calendar, 2 for bad usage, 1 when every feed failed, and 3 when some feeds failed but it still wrote the merge from the rest.";
const BN_STATUSES = "The status list in `benchnote/routes/orders.py` is fixed: received, diagnosing, waiting_parts, in_repair, ready, collected. Never add or rename one without the counter team first; the printed tickets and the counter display use those exact words.";
const BN_SMS = "Background on notifications: we tried Twilio for the 'ready for pickup' texts in the spring and dropped it after two months; the shop's number got flagged and texts to the two main carriers here were blocked (A2P registration is not possible for a sole trader).";
const ACK = " Nothing to build right now, just acknowledge.";

describe("the line's ceiling", () => {
  it("is one and a half times maxChars, and the room is the text's own length between the two", () => {
    expect(lineCeiling(200)).toBe(300);
    expect(lineCeiling(120)).toBe(180);
    expect(roomFor("short line", 200)).toBe(200);
    expect(roomFor("x".repeat(250), 200)).toBe(250);
    expect(roomFor("x".repeat(420), 200)).toBe(300);
    expect(roomFor(`  ${"word ".repeat(50)}  `, 200)).toBe(249);
  });
  it("fitLine keeps a statement up to the ceiling whole, and cuts a longer one at a clause end within it", () => {
    expect(fitLine(CM_EXIT, 200)).toBe(CM_EXIT);
    expect(clampLine(CM_EXIT, 200)).not.toContain("3 when");
    const long = `${CM_EXIT.slice(0, -1)}, while a run that is stopped by a signal exits with 130 so the wrapper can tell an interrupted merge from a failed one, and nothing else uses an exit status.`;
    expect(long.length).toBeGreaterThan(300);
    const cut = fitLine(long, 200);
    expect(cut.length).toBeLessThanOrEqual(300);
    expect(cut).toContain("3 when some feeds failed");
    expect(fitLine("Use pnpm.", 200)).toBe("Use pnpm.");
  });
});

describe("the writer keeps the sentences Jev picked whole up to 300 characters", () => {
  it("one picked sentence past 200 with its rule at the end (cm-exit): the whole sentence", async () => {
    const r = await composeLine(CM_EXIT + ACK, "constraint", { writer, jev: picker("s1") });
    expect(r.line).toBe(CM_EXIT);
  });
  it("two picked sentences past 200 together (bn-statuses): both, not the first alone", async () => {
    const r = await composeLine(BN_STATUSES + ACK, "constraint", { writer, jev: picker("s1", "s2") });
    expect(r.line).toBe(BN_STATUSES);
    expect(r.line).toContain("counter team");
  });
  it("a dead end whose picked sentence gives its reason past 200 (bn-sms): what was tried and why", async () => {
    const r = await composeLine(BN_SMS + ACK, "dead-end", { writer, jev: picker("s1") });
    expect(r.line).toContain("Twilio");
    expect(r.line).toContain("carriers");
    expect(r.line).toContain("A2P");
    expect(r.line.length).toBeLessThanOrEqual(300);
  });
  it("picked sentences past 300: cut within 300, the first sentence kept", async () => {
    const msg = "Uploads from the field app are queued on the phone, retried with backoff for a day, and sent in order of capture so the timeline on the server matches what the inspector saw on site. A queue item that is older than a day is not dropped; it waits for the next Wi-Fi connection and the inspector gets a banner asking them to open the app somewhere with signal, because an inspection that silently loses a photo has to be redone in person.";
    const r = await composeLine(msg, "constraint", { writer, jev: picker("s1", "s2") });
    expect(r.line.length).toBeLessThanOrEqual(300);
    expect(r.line).toContain("Uploads from the field app are queued on the phone");
  });
  it("a short statement is unchanged", async () => {
    const r = await composeLine("Dashboard titles are written in sentence case, never in title case.", "preference", { writer, jev: picker("s1") });
    expect(r.line).toBe("Dashboard titles are written in sentence case, never in title case.");
  });
  it("with maxChars 120 the ceiling is 180", async () => {
    const r = await composeLine(CM_EXIT, "constraint", { writer: { ...writer, maxChars: 120 }, jev: picker("s1") });
    expect(r.line.length).toBeLessThanOrEqual(180);
  });
  it("without Jev (its pick failed or no key), the one sentence the writer chooses is kept whole up to 300 too", async () => {
    const r = await composeLine(CM_EXIT, "constraint", { writer });
    expect(r.line).toBe(CM_EXIT);
  });
});

describe("a statement typed, imported or added by an agent keeps its rule up to 300 characters", () => {
  it("import keeps a 217-character statement whole and cuts one past 300 within 300", () => {
    const md = `# Notes\n\n${CM_EXIT}\n`;
    expect(splitStatements(md, 200).map((s) => s.text)).toEqual([CM_EXIT]);
    const long = `Every request to the vendor goes through the retrying client in src/vendor.ts, which waits two seconds after the first failure and doubles the wait up to a minute, logs each retry with the request id, and gives up after six tries with an error the caller must handle, never by returning an empty result, because an empty result looks like a vendor with no data and the nightly report would go out wrong.`;
    expect(long.length).toBeGreaterThan(300);
    const [s] = splitStatements(`${long}\n`, 200);
    expect(s!.text.length).toBeLessThanOrEqual(300);
  });
  it("jevmem add keeps a 217-character rule whole", async () => {
    const { main } = await import("../src/cli-main.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-rulecut-"));
    try {
      const out: string[] = [];
      const io = { out: (s: string) => void out.push(s), err: (s: string) => void out.push(s), cwd: root };
      expect(await main(["add", "constraint", CM_EXIT], io), out.join("")).toBe(0);
      expect(fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8")).toContain("and 3 when some feeds failed but it still wrote the merge from the rest");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
