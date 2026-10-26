import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIcs, splitLine, unfold } from "../src/ics.mjs";
import { mergeFeeds } from "../src/merge.mjs";

test("unfold joins continuation lines", () => {
  assert.equal(unfold("DESCRIPTION:one\r\n two\r\nSUMMARY:x"), "DESCRIPTION:onetwo\nSUMMARY:x");
});

test("splitLine keeps a colon inside a quoted parameter", () => {
  const p = splitLine('ATTENDEE;CN="Doe, J: Jr":mailto:j@example.test');
  assert.equal(p.name, "ATTENDEE");
  assert.equal(p.params.CN, "Doe, J: Jr");
  assert.equal(p.value, "mailto:j@example.test");
});

test("parseIcs reads events and mergeFeeds de-duplicates by UID", () => {
  const a = parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nDTSTART:20261027T080000Z\nSUMMARY:A\nEND:VEVENT\nEND:VCALENDAR\n");
  const b = parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nDTSTART:20261027T080000Z\nSUMMARY:A again\nEND:VEVENT\nBEGIN:VEVENT\nUID:2\nDTSTART:20261026T080000Z\nSUMMARY:B\nEND:VEVENT\nEND:VCALENDAR\n");
  const merged = mergeFeeds([{ source: "a", ...a }, { source: "b", ...b }]);
  assert.deepEqual(merged.map((e) => e.summary), ["B", "A"]);
});
