import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("recordWatering stores the plant", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waterlog-"));
  process.chdir(dir);
  const { recordWatering, load } = await import("../src/store.mjs?" + Date.now());
  recordWatering("fern", "sam@example.com", new Date("2026-03-01T10:00:00Z"));
  assert.equal(load().plants.fern.by, "sam@example.com");
});
