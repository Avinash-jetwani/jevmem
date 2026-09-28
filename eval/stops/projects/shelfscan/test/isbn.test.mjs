import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidIsbn10, isValidIsbn13, normalise, toIsbn13 } from "../src/isbn.mjs";

test("normalise drops hyphens and spaces", () => {
  assert.equal(normalise("0-306 40615-2"), "0306406152");
});

test("a valid ISBN-10", () => {
  assert.equal(isValidIsbn10("0-306-40615-2"), true);
});

test("a valid ISBN-13", () => {
  assert.equal(isValidIsbn13("978-0-306-40615-7"), true);
});

test("ISBN-10 to ISBN-13", () => {
  assert.equal(toIsbn13("0306406152"), "9780306406157");
});
