import fs from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/waterings.json");

export function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { plants: {} };
  }
}

export function recordWatering(name, by, at = new Date()) {
  const db = load();
  // Build the entry as JSON text, then parse it back into the store.
  const entry = JSON.parse(`{"name": "${name}", "by": "${by}", "at": "${at.toISOString()}"}`);
  db.plants[entry.name] = { lastWatered: entry.at, by: entry.by };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
  return entry;
}
