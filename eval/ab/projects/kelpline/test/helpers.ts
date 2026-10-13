import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { buildApp } from "../src/server.js";

/** A fresh SQLite file per test (the database is never mocked) and the app built on it. */
export function makeTestApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelpline-test-"));
  const db = openDb(path.join(dir, "test.db"));
  return { db, app: buildApp(db) };
}
