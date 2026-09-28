/**
 * The scrubber bug fixed in 7441c57, through the paths that build Jev requests: decide (a Stop turn) and recall (a
 * prompt), each with the real createJev over HTTP to a local stand-in Jev. Every case ends a text field with a secret:
 * KEY=value, an already-redacted KEY=[REDACTED], a value followed by a newline and one more word, and a memory line that
 * ends that way. Before the fix createJev scrubbed the JSON text of the request, the pattern's closing quote ate the
 * field's, and the request failed before it was sent: the turn was dropped, the prompt got no memory. Each case checks
 * that the request is now sent, valid and scrubbed, and that the old way would have thrown on it. (On main this file
 * also covers the guard, which 0.5.x does not have.)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHook } from "../src/hook.js";
import { init } from "../src/init.js";
import { createJev, readLog } from "../src/jev.js";
import { scrubSecrets } from "../src/scrub.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";
import { SAVE_DECISION } from "./helpers.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-scrubreq-")));
let fake: FakeJev | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});
/** Decide saves a decision; recall picks the first memory. */
const answers = (q: Record<string, any>) => (q.most_relevant ? { most_relevant: Object.keys(q.most_relevant.criteria).find((k) => k !== "none")! } : SAVE_DECISION);
/** What 0.5.7's createJev did to a request's state. */
const oldScrub = (state: unknown) => JSON.parse(scrubSecrets(JSON.stringify(state)));
const SECRETS = ["hunter2", "abc123", "AIzaSyD4k9ZqQ7w2Xc8vB1nM3lK5jH6gF0dS9aP", "sk_test_abcdef1234567890"];

function project(lines: string[] = []): string {
  const root = tmp();
  init({ root, hooks: false });
  if (lines.length) fs.appendFileSync(path.join(root, "JEVMEM.md"), lines.join("\n") + "\n");
  return root;
}
const jevFor = (root: string) => createJev({ root, apiKey: "k", baseURL: fake!.url, cache: false });
function sentOnce(from: number) {
  expect(fake!.requests.length).toBeGreaterThan(from);
  const bodies = JSON.stringify(fake!.requests.slice(from).map((r) => r.state));
  for (const s of SECRETS) expect(bodies).not.toContain(s);
  return fake!.requests[from]!.state;
}

describe("decide: a Stop turn whose text or memory ends with a secret is evaluated, not dropped", () => {
  const cases: [string, string, string[], (state: any) => void][] = [
    ["KEY=value at the end of the message", "For staging, set DB_PASSWORD=hunter2", [], (s) => expect(s.user_message).toBe("For staging, set DB_PASSWORD=[REDACTED]")],
    ["an already-redacted KEY=[REDACTED] at the end", "Decision: the payments service reads STRIPE_KEY=[REDACTED]", [], (s) => expect(s.user_message).toBe("Decision: the payments service reads STRIPE_KEY=[REDACTED]")],
    ["a value, a newline and one more word", "Decision: the staging password: hunter2\nrotated", [], (s) => expect(s.user_message).toBe("Decision: the staging password=[REDACTED]\nrotated")],
    [
      "memory lines that end with a secret (hand-written, one of them unscrubbed)",
      "Decision: we use Redis for the job queue.",
      ["- [decision] Staging reads STRIPE_KEY=[REDACTED]  <!-- id:mem001 -->", "- [constraint] The CI deploy key is DEPLOY_TOKEN=abc123  <!-- id:mem002 -->"],
      (s) => expect(s.existing_memories.map((m: any) => m.text)).toEqual(["Staging reads STRIPE_KEY=[REDACTED]", "The CI deploy key is DEPLOY_TOKEN=[REDACTED]"]),
    ],
  ];
  for (const [name, message, lines, check] of cases) {
    it(name, async () => {
      fake = await startFakeJev(answers);
      const root = project(lines);
      const r = await runHook({ hook_event_name: "Stop", cwd: root, user_message: message }, { jev: jevFor(root), env: { HOME: root } });
      expect(r.action, r.detail).toBe("saved");
      const state = sentOnce(0);
      check(state);
      expect(() => oldScrub(state)).toThrow(SyntaxError);
      expect(readLog(root).some((e) => e.event === "dropped")).toBe(false);
    });
  }
});

describe("recall: a prompt or memory line that ends with a secret still gets its memories", () => {
  it("KEY=value, a newline and one more word in the prompt; memory lines ending in KEY=value and KEY=[REDACTED]", async () => {
    fake = await startFakeJev(answers);
    const root = project(["- [decision] Staging reads STRIPE_KEY=[REDACTED]  <!-- id:mem001 -->", "- [decision] The worker connects with DB_PASSWORD=hunter2  <!-- id:mem002 -->"]);
    for (const [prompt, query] of [
      ["Why does the deploy fail with API_TOKEN=abc123", "Why does the deploy fail with API_TOKEN=[REDACTED]"],
      ["Check the worker: password: hunter2\nthanks", "Check the worker: password=[REDACTED]\nthanks"],
    ]) {
      const n = fake.requests.length;
      const r = await runHook({ hook_event_name: "UserPromptSubmit", cwd: root, prompt }, { jev: jevFor(root), env: { HOME: root } });
      expect(r.action, r.detail).toBe("injected");
      const state = sentOnce(n);
      expect(state.query).toBe(query);
      expect(state.memories.map((m: any) => m.text)).toEqual(["Staging reads STRIPE_KEY=[REDACTED]", "The worker connects with DB_PASSWORD=[REDACTED]"]);
      expect(() => oldScrub(state)).toThrow(SyntaxError);
      // What Claude sees is the scrubbed line too.
      expect(JSON.parse(r.stdout!).hookSpecificOutput.additionalContext).toContain("Staging reads STRIPE_KEY=[REDACTED]");
    }
    expect(readLog(root).some((e) => e.label === "hook" && e.ok === false)).toBe(false);
  });
});
