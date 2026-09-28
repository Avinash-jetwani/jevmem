/**
 * The scrubber bug fixed in 7441c57, through the paths that build Jev requests: decide (a Stop turn), recall (a prompt)
 * and the guard, each with the real createJev over HTTP to a local stand-in Jev. Every case ends a text field with a
 * secret: KEY=value, an already-redacted KEY=[REDACTED], a value followed by a newline and one more word, and a memory
 * line (or a guard rule) that ends that way. Before the fix createJev scrubbed the JSON text of the request, the
 * pattern's closing quote ate the field's, and the request failed before it was sent: the turn was dropped, the prompt
 * got no memory, the call ran unchecked. Each case checks that the request is now sent, valid and scrubbed, and that
 * the old way would have thrown on it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateGuard } from "../src/guardrail.js";
import { runHook } from "../src/hook.js";
import { init } from "../src/init.js";
import { createJev, readLog } from "../src/jev.js";
import { recordProvenance } from "../src/provenance.js";
import { MemoryStore } from "../src/store.js";
import { scrubSecrets as scrub057 } from "./fixtures/scrub-0.5.7/scrub.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";
import { relevance, SAVE_DECISION } from "./helpers.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-scrubreq-")));
let fake: FakeJev | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});
/** Decide saves a decision; recall picks the first memory and calls every line relevant; the guard says the call breaks every candidate rule. */
const answers = (q: Record<string, any>) => (q.most_relevant ? { most_relevant: Object.keys(q.most_relevant.criteria).find((k) => k !== "none")!, ...relevance(q) } : Object.keys(q).some((k) => k.startsWith("breaks_")) ? Object.fromEntries(Object.keys(q).map((k) => [k, 0.9])) : SAVE_DECISION);
/** What 0.5.7's createJev did to a request's state, with 0.5.7's scrubber. */
const oldScrub = (state: unknown) => JSON.parse(scrub057(JSON.stringify(state)));
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

describe("the guard: a call or rule that ends with a secret is still checked", () => {
  function guarded(rules: string[]): string {
    const root = project();
    const store = new MemoryStore(root);
    for (const text of rules) recordProvenance(root, store.add({ kind: "constraint", text }), "hook");
    return root;
  }
  const cases: [string, string[], Record<string, unknown>, (state: any) => void][] = [
    [
      "an Edit whose new text ends with KEY: value (the dev eval call that found the bug)",
      ["API keys never go into config/*.yaml; they are read from Vault at startup"],
      { tool_name: "Edit", file: "config/app.yaml", tool_input: { old_string: "timeout: 30s", new_string: "timeout: 30s\nmaps_api_key: AIzaSyD4k9ZqQ7w2Xc8vB1nM3lK5jH6gF0dS9aP" } },
      (s) => expect(s.tool_call.added).toBe("timeout: 30s\nmaps_api_key=[REDACTED]"),
    ],
    [
      "a Bash command that ends with KEY=value",
      ["Never commit .env files"],
      { tool_name: "Bash", tool_input: { command: 'git add .env && git commit -m "set DB_PASSWORD=hunter2"' } },
      (s) => expect(s.tool_call.command).toBe('git add .env && git commit -m "set DB_PASSWORD=[REDACTED]'),
    ],
    [
      "an Edit whose new text has a value, a newline and one more word",
      ["API keys never go into config/*.yaml; they are read from Vault at startup"],
      { tool_name: "Edit", file: "config/app.yaml", tool_input: { old_string: "timeout: 30s", new_string: "timeout: 30s\napi_key: sk_test_abcdef1234567890\nretries" } },
      (s) => expect(s.tool_call.added).toBe("timeout: 30s\napi_key=[REDACTED]\nretries"),
    ],
    [
      "a rule (a memory line) that ends with KEY=[REDACTED]",
      ["Never commit .env files or STRIPE_KEY=[REDACTED]"],
      { tool_name: "Bash", tool_input: { command: "git add .env" } },
      (s) => expect(s.rules.map((r: any) => r.rule)).toEqual(["Never commit .env files or STRIPE_KEY=[REDACTED]"]),
    ],
  ];
  for (const [name, rules, call, check] of cases) {
    it(name, async () => {
      fake = await startFakeJev(answers);
      const root = guarded(rules);
      const { file, ...rest } = call as { file?: string; tool_name: string; tool_input: Record<string, unknown> };
      const tool_input = file ? { ...rest.tool_input, file_path: path.join(root, file) } : rest.tool_input;
      const t = await evaluateGuard({ hook_event_name: "PreToolUse", cwd: root, tool_name: rest.tool_name, tool_input }, { jev: jevFor(root), root, noCache: true });
      expect(t.notes.join("; ")).not.toMatch(/Jev check failed/);
      expect(t.decision).toBe("ask");
      const state = sentOnce(0);
      check(state);
      expect(() => oldScrub(state)).toThrow(SyntaxError);
    });
  }
});
