import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStamp, parseWhen } from "../src/time.mjs";

test("parseWhen reads relative times", () => {
  const now = Date.parse("2026-03-01T10:00:00Z");
  assert.equal(parseWhen("2h", now).toISOString(), "2026-03-01T08:00:00.000Z");
});

test("parseStamp reads ISO timestamps", () => {
  assert.equal(parseStamp("2026-03-01T08:00:05.557Z ERROR x").toISOString(), "2026-03-01T08:00:05.557Z");
});
