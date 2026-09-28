import { test } from "node:test";
import assert from "node:assert/strict";
import { fare } from "../src/fare.mjs";

test("one zone, adult", () => {
  assert.equal(fare(1), 2.1);
});
