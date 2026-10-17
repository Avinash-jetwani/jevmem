/**
 * 0.7.5 (fix c): a line that begins with a label naming its kind ("Decision for this project:", "Rule:", "Note:")
 * loses the label when the rest is a whole sentence; a label whose rest is a fragment stays, and words that only look
 * like a label stay. The forms here are the dev set's (eval/label-prefix-dev.jsonl); the held-out set is run once.
 */
import { describe, expect, it } from "vitest";
import { stripFiller } from "../src/llm/index.js";
import { composeLine } from "../src/write.js";

describe("the writer drops a leading kind label", () => {
  it("drops a label with a scope, a bare rule or note label, and a convention label, when a whole sentence follows", () => {
    expect(stripFiller("Decision for this project: we use pnpm, not npm, for every install and script.")).toBe("We use pnpm, not npm, for every install and script.");
    expect(stripFiller("Rule: never log a request body, even at debug level.")).toBe("Never log a request body, even at debug level.");
    expect(stripFiller("Note: the release binaries are signed with the team key before upload.")).toBe("The release binaries are signed with the team key before upload.");
    expect(stripFiller("Project rule: every migration must be reversible.")).toBe("Every migration must be reversible.");
    expect(stripFiller("Rule for this repo: pull requests need one approval before merge.")).toBe("Pull requests need one approval before merge.");
    expect(stripFiller("Team convention: components live under src/components, one folder each.")).toBe("Components live under src/components, one folder each.");
    expect(stripFiller("Constraint for this codebase: handlers return within 200 ms or stream.")).toBe("Handlers return within 200 ms or stream.");
    expect(stripFiller("Reminder: the config file path can be overridden with QUILL_CONFIG.")).toBe("The config file path can be overridden with QUILL_CONFIG.");
  });
  it("keeps a label whose rest is a fragment, and words that only look like a label", () => {
    expect(stripFiller("Rule: pnpm")).toBe("Rule: pnpm");
    expect(stripFiller("Rule for this repo: pnpm only")).toBe("Rule for this repo: pnpm only");
    expect(stripFiller("Rules engine decisions are cached for 5 minutes.")).toBe("Rules engine decisions are cached for 5 minutes.");
    expect(stripFiller("Decision support tables: see docs/tables.md for the schema.")).toBe("Decision support tables: see docs/tables.md for the schema.");
    expect(stripFiller("Note-taking happens in Obsidian, synced nightly.")).toBe("Note-taking happens in Obsidian, synced nightly.");
  });
  it("the local writer's line for a labelled turn starts at the fact", async () => {
    const opts = { writer: { provider: "none" as const, maxChars: 200, timeoutMs: 1000 }, env: {} as NodeJS.ProcessEnv };
    const r = await composeLine("USER: Decision for this project: we use pnpm, not npm, for every install and script.\nASSISTANT: Noted: pnpm for every install and script.", "decision", opts);
    expect(r.line).toBe("We use pnpm, not npm, for every install and script.");
    const rule = await composeLine("USER: Rule for this repo: pull requests need one approval before merge.\nASSISTANT: Understood.", "constraint", opts);
    expect(rule.line).toBe("Pull requests need one approval before merge.");
  });
});
