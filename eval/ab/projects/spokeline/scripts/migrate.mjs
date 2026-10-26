// Applies migrations/*.sql in name order against DATABASE_URL, recording each in schema_migrations.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const dir = path.resolve("migrations");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  if (done.has(f)) continue;
  await client.query("BEGIN");
  await client.query(fs.readFileSync(path.join(dir, f), "utf8"));
  await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
  await client.query("COMMIT");
  console.log(`applied ${f}`);
}
await client.end();
