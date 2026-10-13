import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export type Db = InstanceType<typeof Database>;

/** Open the database and apply each numbered file in migrations/ once, in order. */
export function openDb(file: string = config.databaseFile): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT name FROM schema_migrations").all().map((r: any) => r.name as string));
  for (const f of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    if (applied.has(f)) continue;
    db.exec(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
  }
  return db;
}

export interface StationRow {
  id: string;
  name: string;
  lat: number;
  lon: number;
}
export interface ReadingRow {
  id: string;
  station_id: string;
  height_mm: number;
  at: string;
}
export interface AlertRow {
  id: string;
  station_id: string;
  threshold_mm: number;
  email: string;
  armed: number;
  created_at: string;
}

export const toStation = (r: StationRow) => ({ id: r.id, name: r.name, lat: r.lat, lon: r.lon });
export const toReading = (r: ReadingRow) => ({ id: r.id, stationId: r.station_id, heightMm: r.height_mm, at: r.at });
export const toAlert = (r: AlertRow) => ({ id: r.id, stationId: r.station_id, thresholdMm: r.threshold_mm, email: r.email, armed: r.armed === 1, createdAt: r.created_at });
