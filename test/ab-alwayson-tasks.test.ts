/**
 * The always-on A/B's tasks (eval/ab/tasks-alwayson.mjs, 0.7.1) and their checks, tested before any session ran: for
 * every task, a result that follows the saved line and one that does not, applied to a copy of the task's project in a
 * git repository, as scripts/ab.mjs sets it up. Each check must tell them apart (and say stale, repeated, attempted or
 * landed where the task has them). The results are made up here (no Claude Code session), and so are the tool calls.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(".");
const load = (f: string): Promise<any> => import(path.join(ROOT, f));
const { PROJECTS, TASKS } = await load("eval/ab/tasks-alwayson.mjs");
const { makeContext } = await load("scripts/ab-lib.mjs");

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" }, stdio: ["ignore", "pipe", "pipe"] });

type Outcome = {
  files?: Record<string, string | null | ((old: string) => string)>;
  calls?: { name: string; input: Record<string, unknown> }[];
  /** The reply's text (0.7.2): a check may read it, as kl-ctl-ws does. */
  reply?: string;
};

function project(task: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ab-always-${task.id}-`)));
  fs.cpSync(path.join(ROOT, PROJECTS[task.project].dir), root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "maintenance.auto", "false"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "initial import"]);
  return { root, base: git(root, ["rev-parse", "HEAD"]).trim() };
}

function judge(taskId: string, outcome: Outcome) {
  const task = TASKS.find((t: any) => t.id === taskId);
  const { root, base } = project(task);
  try {
    for (const [f, v] of Object.entries(outcome.files ?? {})) {
      const file = path.join(root, f);
      if (v === null) fs.rmSync(file);
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof v === "function" ? v(fs.readFileSync(file, "utf8")) : v);
      }
    }
    const events = (outcome.calls ?? []).map((c, i) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: c.name, input: { ...c.input, file_path: c.input.file_path ? path.join(root, String(c.input.file_path)) : undefined } }] } }));
    if (outcome.reply) events.push({ type: "result", result: outcome.reply } as any);
    return task.check(makeContext(root, base, events));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const edit = (file: string) => ({ name: "Edit", input: { file_path: file } });
const replace = (a: string | RegExp, b: string) => (old: string) => {
  const out = old.replace(a, b);
  if (out === old) throw new Error(`fixture changed: ${a}`);
  return out;
};
const append = (text: string) => (old: string) => old + text;

describe("eval/ab/tasks-alwayson.mjs", () => {
  it("has conventions the prompt does not point at and controls, each naming a line of its project with the right label", () => {
    const conventions = TASKS.filter((t: any) => t.category === "convention");
    const controls = TASKS.filter((t: any) => t.category === "control");
    expect(conventions.filter((t: any) => t.points === false).length).toBeGreaterThanOrEqual(10);
    expect(controls.length).toBeGreaterThanOrEqual(5);
    for (const [name, p] of Object.entries(PROJECTS) as [string, any][]) {
      expect(fs.existsSync(path.join(ROOT, p.dir, "README.md")), name).toBe(true);
      const keys = new Set(p.memory.map((m: any[]) => m[0]));
      expect(keys.size).toBe(p.memory.length);
      for (const m of p.memory) {
        if (m[3]) expect(keys.has(m[3]), `${m[0]} supersedes ${m[3]}`).toBe(true);
        if (m[4]?.always) expect(m[1], `${m[0]} is always-on, so live`).not.toBe("superseded");
      }
      expect(p.memory.filter((m: any[]) => m[4]?.always).length).toBeGreaterThanOrEqual(8);
    }
    for (const t of TASKS) {
      const mem = PROJECTS[t.project].memory as any[][];
      const line = mem.find((m) => m[0] === t.line);
      expect(line, t.id).toBeDefined();
      expect(line![1], `${t.id}'s line is live`).not.toBe("superseded");
      if (t.category === "convention") expect(line![4]?.always, `${t.id}'s line is always-on`).toBe(true);
      else expect(line![4]?.always, `${t.id}'s line is not always-on`).toBeFalsy();
      if (t.stale) expect(mem.find((m) => m[0] === t.stale)?.[1], `${t.id}'s stale line`).toBe("superseded");
      expect(typeof t.check).toBe("function");
      expect(t.follows.length).toBeGreaterThan(20);
    }
  });

  // ---------------------------------------------------------------- sundial
  it("sd-i18n: a t() label with a new en.json key, against hard-coded English", () => {
    const form = (label: string) => replace("<td></td>", `<td><form method="post" action="{{ url_for('bookings.cancel_booking', id=b.id) }}"><button type="submit">${label}</button></form></td>`);
    const en = (old: string) => old.replace(/\n}\s*$/, ',\n  "bookings.cancel": "Cancel"\n}\n');
    const yes = judge("sd-i18n", { files: { "sundial/templates/bookings/list.html": form("{{ t('bookings.cancel') }}"), "sundial/locales/en.json": en } });
    expect(yes).toMatchObject({ followed: true, done: true });
    const no = judge("sd-i18n", { files: { "sundial/templates/bookings/list.html": form("Cancel") } });
    expect(no).toMatchObject({ followed: false, done: true });
    const flashed = judge("sd-i18n", { files: { "sundial/templates/bookings/list.html": form("{{ t('bookings.cancel') }}"), "sundial/locales/en.json": en, "sundial/routes/bookings.py": append('\n\n@bp.post("/bookings/<int:id>/cancel")\ndef cancel_booking(id):\n    flash("Booking cancelled", "ok")\n    return redirect(url_for("bookings.list_bookings"))\n') } });
    expect(flashed.followed).toBe(false);
  });

  it("sd-dates: fmt_date against the raw value", () => {
    const cell = (v: string) => replace("<td>{{ room.capacity }}</td>", `<td>{{ room.capacity }}</td>\n      <td>${v}</td>`);
    expect(judge("sd-dates", { files: { "sundial/templates/rooms/list.html": cell("{{ fmt_date(room.last_cleaned_at) }}") } })).toMatchObject({ followed: true, done: true });
    expect(judge("sd-dates", { files: { "sundial/templates/rooms/list.html": cell("{{ room.last_cleaned_at }}") } })).toMatchObject({ followed: false, done: true });
    expect(judge("sd-dates", { files: { "sundial/routes/rooms.py": replace('return render_template("rooms/list.html", rooms=rows)', 'cleaned = {r["id"]: r["last_cleaned_at"].strftime("%d.%m.%Y") for r in rows}\n    return render_template("rooms/list.html", rooms=rows, cleaned=cleaned)') } }).followed).toBe(false);
  });

  it("sd-sql: a ? placeholder against an f-string", () => {
    const q = (sql: string, params: string) => replace(/rows = q\([\s\S]*?\)\.fetchall\(\)/, `room = request.args.get("room", type=int)\n    rows = q(${sql}, ${params}).fetchall()`);
    const yes = judge("sd-sql", { files: { "sundial/routes/bookings.py": q('"SELECT b.id, b.member_name, b.starts_at, b.cancelled_at, r.name AS room FROM bookings b JOIN rooms r ON r.id = b.room_id WHERE (? IS NULL OR b.room_id = ?) ORDER BY b.starts_at DESC LIMIT ?"', '(room, room, settings.get("page_size"))') } });
    expect(yes).toMatchObject({ followed: true, done: true });
    const no = judge("sd-sql", { files: { "sundial/routes/bookings.py": q('f"SELECT b.id, b.member_name, b.starts_at, b.cancelled_at, r.name AS room FROM bookings b JOIN rooms r ON r.id = b.room_id WHERE b.room_id = {room} ORDER BY b.starts_at DESC LIMIT ?"', '(settings.get("page_size"),)') } });
    expect(no).toMatchObject({ followed: false, done: true });
  });

  it("sd-settings: settings.get with a defaults.toml key, against a literal 60", () => {
    const route = (cond: string) => replace("    room = q(", `    from datetime import datetime, timedelta\n    if datetime.fromisoformat(starts_at) > datetime.now() + timedelta(days=${cond}):\n        abort(400)\n    room = q(`);
    const yes = judge("sd-settings", { files: { "sundial/routes/bookings.py": route('settings.get("max_days_ahead")'), "config/defaults.toml": append("max_days_ahead = 60\n") } });
    expect(yes).toMatchObject({ followed: true, done: true });
    expect(judge("sd-settings", { files: { "sundial/routes/bookings.py": route("60") } })).toMatchObject({ followed: false, done: true });
  });

  it("sd-tests: a route with a test through client, against the route alone", () => {
    const route = append('\n\n@app.get("/healthz")\ndef healthz():\n    return {"ok": True}\n');
    const init = (old: string) => old.replace("    return app\n", "    @app.get(\"/healthz\")\n    def healthz():\n        return {\"ok\": True}\n\n    return app\n");
    expect(judge("sd-tests", { files: { "sundial/__init__.py": init, "tests/test_health.py": 'def test_healthz(client):\n    assert client.get("/healthz").get_json() == {"ok": True}\n' } })).toMatchObject({ followed: true, done: true });
    expect(judge("sd-tests", { files: { "sundial/__init__.py": init } })).toMatchObject({ followed: false, done: true });
    void route;
  });

  it("sd-locales: en.json alone, against edits to de.json and fr.json", () => {
    const en = replace('"bookings.submit": "Book"', '"bookings.submit": "Book now"');
    expect(judge("sd-locales", { files: { "sundial/locales/en.json": en } })).toMatchObject({ followed: true, attempted: false, landed: false, done: true });
    const no = judge("sd-locales", { files: { "sundial/locales/en.json": en, "sundial/locales/de.json": replace('"bookings.submit": "Buchen"', '"bookings.submit": "Jetzt buchen"'), "sundial/locales/fr.json": replace('"bookings.submit": "Réserver"', '"bookings.submit": "Réserver maintenant"') }, calls: [edit("sundial/locales/de.json"), edit("sundial/locales/fr.json")] });
    expect(no).toMatchObject({ followed: false, attempted: true, landed: true, done: true });
  });

  it("sd-migrations: a new numbered file, against an edit to 001", () => {
    expect(judge("sd-migrations", { files: { "migrations/003_add_floor.sql": "ALTER TABLE rooms ADD COLUMN floor INTEGER NOT NULL DEFAULT 0;\n" } })).toMatchObject({ followed: true, attempted: false, landed: false, done: true });
    const no = judge("sd-migrations", { files: { "migrations/001_init.sql": replace("last_cleaned_at TIMESTAMP\n", "last_cleaned_at TIMESTAMP,\n  floor INTEGER NOT NULL DEFAULT 0\n") }, calls: [edit("migrations/001_init.sql")] });
    expect(no).toMatchObject({ followed: false, attempted: true, landed: true, done: false });
  });

  it("sd-ctl-outbox: enqueue, against Celery", () => {
    expect(judge("sd-ctl-outbox", { files: { "sundial/routes/bookings.py": replace("mail.send(email,", "mail.enqueue(email,") } })).toMatchObject({ followed: true, repeated: false, done: true });
    const no = judge("sd-ctl-outbox", { files: { "sundial/mail.py": append("\n\nfrom celery import shared_task\n\n\n@shared_task\ndef send_later(to, subject, body):\n    send(to, subject, body)\n"), "sundial/routes/bookings.py": replace("mail.send(email,", "mail.send_later.delay(email,") } });
    expect(no).toMatchObject({ followed: false, repeated: true, done: true });
  });

  it("sd-ctl-page: 25 or page_size, against 50", () => {
    const paged = (size: string) => replace(/rows = q\([\s\S]*?\)\.fetchall\(\)/, `page = request.args.get("page", 1, type=int)\n    size = ${size}\n    rows = q("SELECT b.id, b.member_name, b.starts_at, b.cancelled_at, r.name AS room FROM bookings b JOIN rooms r ON r.id = b.room_id ORDER BY b.starts_at DESC LIMIT ? OFFSET ?", (size, (page - 1) * size)).fetchall()`);
    expect(judge("sd-ctl-page", { files: { "sundial/routes/bookings.py": paged('settings.get("page_size")') } })).toMatchObject({ followed: true, stale: false, done: true });
    expect(judge("sd-ctl-page", { files: { "sundial/routes/bookings.py": paged("50") } })).toMatchObject({ followed: false, stale: true, done: true });
  });

  it("sd-ctl-reminders: email through the outbox, against SMS", () => {
    const cmd = (body: string) => (old: string) => old.replace("    return app\n", `    @app.cli.command("remind")\n    def remind():\n        rows = db.q("SELECT member_email, starts_at FROM bookings WHERE date(starts_at) = date('now', '+1 day') AND cancelled_at IS NULL").fetchall()\n        for row in rows:\n            ${body}\n\n    return app\n`);
    expect(judge("sd-ctl-reminders", { files: { "sundial/__init__.py": cmd('mail.enqueue(row["member_email"], t("mail.reminder_subject"), t("mail.reminder_body", when=row["starts_at"]))') } })).toMatchObject({ followed: true, stale: false, done: true });
    expect(judge("sd-ctl-reminders", { files: { "sundial/__init__.py": cmd('send_sms(row["member_phone"], t("mail.reminder_body", when=row["starts_at"]))  # via twilio') } })).toMatchObject({ followed: false, stale: true, done: true });
  });

  // ---------------------------------------------------------------- kelpline
  it("kl-openapi: the route in openapi.yaml, against the route alone", () => {
    const route = append('\n\nexport function latestRoute(app: FastifyInstance, db: Db) {\n  app.get<{ Params: { id: string } }>("/v1/stations/:id/latest", async (req) => {\n    const row = db.prepare("SELECT id, station_id, height_mm, at FROM readings WHERE station_id = ? ORDER BY at DESC LIMIT 1").get(req.params.id) as ReadingRow | undefined;\n    if (!row) throw new ApiError("station_not_found");\n    return toReading(row);\n  });\n}\n');
    const spec = replace("  /v1/alerts:\n", "  /v1/stations/{id}/latest:\n    get:\n      summary: The newest reading\n      parameters:\n        - { name: id, in: path, required: true, schema: { type: string } }\n      responses:\n        \"200\": { description: The reading }\n  /v1/alerts:\n");
    expect(judge("kl-openapi", { files: { "src/routes/stations.ts": route, "api/openapi.yaml": spec } })).toMatchObject({ followed: true, done: true });
    expect(judge("kl-openapi", { files: { "src/routes/stations.ts": route } })).toMatchObject({ followed: false, done: true });
  });

  it("kl-errors: ApiError with a new code, against an inline reply.code(400)", () => {
    const check = (body: string) => replace('    if (typeof email !== "string"', `    ${body}\n    if (typeof email !== "string"`);
    const yes = judge("kl-errors", { files: { "src/routes/alerts.ts": check('if (!Number.isInteger(thresholdMm) || thresholdMm < 0) throw new ApiError("invalid_threshold");'), "src/errors.ts": replace("  limit_too_large: 400,\n", "  limit_too_large: 400,\n  invalid_threshold: 400,\n") } });
    expect(yes).toMatchObject({ followed: true, done: true });
    expect(judge("kl-errors", { files: { "src/routes/alerts.ts": check('if (thresholdMm < 0) return reply.code(400).send({ error: { code: "invalid_threshold", message: "thresholdMm must be 0 or more" } });') } })).toMatchObject({ followed: false, done: true });
  });

  it("kl-ids: newId(), against randomUUID", () => {
    const route = (id: string) => `import type { FastifyInstance } from "fastify";\nimport type { Db } from "../db.js";\nimport { ApiError } from "../errors.js";\nimport { newId } from "../lib/ids.js";\nimport crypto from "node:crypto";\n\nexport function subscriptionRoutes(app: FastifyInstance, db: Db) {\n  app.post<{ Body: { email: string; stationId: string } }>("/v1/subscriptions", async (req, reply) => {\n    if (!db.prepare("SELECT id FROM stations WHERE id = ?").get(req.body.stationId)) throw new ApiError("station_not_found");\n    const row = { id: ${id}, email: req.body.email, stationId: req.body.stationId };\n    db.prepare("INSERT INTO subscriptions (id, email, station_id) VALUES (?, ?, ?)").run(row.id, row.email, row.stationId);\n    reply.code(201);\n    return row;\n  });\n}\n`;
    expect(judge("kl-ids", { files: { "src/routes/subscriptions.ts": route("newId()") } })).toMatchObject({ followed: true, done: true });
    expect(judge("kl-ids", { files: { "src/routes/subscriptions.ts": route("crypto.randomUUID()") } })).toMatchObject({ followed: false, done: true });
  });

  it("kl-units: a field ending in Mm, against metres", () => {
    const station = (field: string) => replace("export const toStation = (r: StationRow) => ({ id: r.id, name: r.name, lat: r.lat, lon: r.lon });", `export const toStation = (r: StationRow & { max_mm?: number }) => ({ id: r.id, name: r.name, lat: r.lat, lon: r.lon, ${field} });`);
    const query = replace('const rows = db.prepare("SELECT id, name, lat, lon FROM stations ORDER BY name LIMIT ? OFFSET ?").all(limit, offset) as StationRow[];', 'const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();\n    const rows = db.prepare("SELECT s.id, s.name, s.lat, s.lon, (SELECT MAX(height_mm) FROM readings r WHERE r.station_id = s.id AND r.at > ?) AS max_mm FROM stations s ORDER BY s.name LIMIT ? OFFSET ?").all(since, limit, offset) as (StationRow & { max_mm: number | null })[];');
    expect(judge("kl-units", { files: { "src/db.ts": station("maxHeightMm: r.max_mm ?? null"), "src/routes/stations.ts": query } })).toMatchObject({ followed: true, done: true });
    expect(judge("kl-units", { files: { "src/db.ts": station("maxHeight: r.max_mm === undefined || r.max_mm === null ? null : r.max_mm / 1000"), "src/routes/stations.ts": query } })).toMatchObject({ followed: false, done: true });
  });

  it("kl-env: process.env in config.ts, against process.env in noaa.ts", () => {
    expect(judge("kl-env", { files: { "src/config.ts": replace('noaaBaseUrl: "https://api.tidesandcurrents.noaa.gov/api/prod",', 'noaaBaseUrl: process.env.NOAA_BASE_URL ?? "https://api.tidesandcurrents.noaa.gov/api/prod",') } })).toMatchObject({ followed: true, done: true });
    expect(judge("kl-env", { files: { "src/upstream/noaa.ts": replace("const url = `${config.noaaBaseUrl}", "const url = `${process.env.NOAA_BASE_URL ?? config.noaaBaseUrl}") } })).toMatchObject({ followed: false, done: true });
  });

  it("kl-tests: a route with an inject test, against the route alone", () => {
    const route = replace("  stationRoutes(app, db);", '  app.get("/v1/healthz", async () => ({ ok: true }));\n  stationRoutes(app, db);');
    expect(judge("kl-tests", { files: { "src/server.ts": route, "test/routes/healthz.test.ts": 'import { expect, it } from "vitest";\nimport { makeTestApp } from "../helpers.js";\n\nit("answers ok", async () => {\n  const { app } = makeTestApp();\n  const r = await app.inject({ method: "GET", url: "/v1/healthz" });\n  expect(r.json()).toEqual({ ok: true });\n});\n' } })).toMatchObject({ followed: true, done: true });
    expect(judge("kl-tests", { files: { "src/server.ts": route } })).toMatchObject({ followed: false, done: true });
  });

  it("kl-log: log.warn with fields, against console.error", () => {
    const poller = (line: string) => replace("    const latest = await fetchLatest(s.id);\n    if (!latest) continue;", `    let latest;\n    try {\n      latest = await fetchLatest(s.id);\n    } catch (err) {\n      ${line}\n      continue;\n    }\n    if (!latest) continue;`);
    expect(judge("kl-log", { files: { "src/poller.ts": poller('log.warn({ stationId: s.id, err }, "noaa fetch failed");') } })).toMatchObject({ followed: true, done: true });
    expect(judge("kl-log", { files: { "src/poller.ts": poller('console.error("noaa fetch failed", s.id, err);') } })).toMatchObject({ followed: false, done: true });
  });

  it("kl-ctl-ws: polling, against a websocket", () => {
    expect(judge("kl-ctl-ws", { files: { "README.md": append("\nDashboards poll `GET /v1/stations/:id/readings?since=<last at>` every 30 s for new readings.\n") } })).toMatchObject({ followed: true, repeated: false, done: true });
    expect(judge("kl-ctl-ws", { files: { "src/routes/live.ts": 'import websocket from "@fastify/websocket";\nexport const live = websocket;\n' } })).toMatchObject({ followed: false, repeated: true, done: true });
    // The right answer (0.7.2): nothing changed, the reply says polling with `since` already exists. Until then this
    // counted as not done, so it scored 0 of 3 in every arm of the 2026-10-13 runs.
    expect(judge("kl-ctl-ws", { reply: "Dashboards already poll `GET /v1/stations/:id/readings?since=<last at>` every 30 s, so new readings appear without a reload and there is nothing to build." })).toMatchObject({ followed: true, repeated: false, done: true });
    expect(judge("kl-ctl-ws", { reply: "I can add a WebSocket endpoint for this." })).toMatchObject({ done: false });
  });

  it("kl-ctl-page: 100 and 500, against 20", () => {
    const list = (dflt: string) => replace('  app.get<{ Params: { id: string } }>("/v1/alerts/:id"', `  app.get<{ Querystring: { limit?: string; offset?: string } }>("/v1/alerts", async (req) => {\n    const limit = Math.min(Number(req.query.limit ?? ${dflt}), 500);\n    const offset = Number(req.query.offset ?? 0);\n    return (db.prepare("SELECT * FROM alerts ORDER BY created_at LIMIT ? OFFSET ?").all(limit, offset) as AlertRow[]).map(toAlert);\n  });\n\n  app.get<{ Params: { id: string } }>("/v1/alerts/:id"`);
    expect(judge("kl-ctl-page", { files: { "src/routes/alerts.ts": list("100") } })).toMatchObject({ followed: true, stale: false, done: true });
    expect(judge("kl-ctl-page", { files: { "src/routes/alerts.ts": list("20") } })).toMatchObject({ followed: false, stale: true, done: true });
  });

  it("kl-ctl-cache: cached() from lib/cache, against a Map", () => {
    const viaRedis = (old: string) => old.replace('import { httpGet } from "../lib/http.js";', 'import { cached } from "../lib/cache.js";\nimport { httpGet } from "../lib/http.js";').replace("  const answer = await httpGet<NoaaAnswer>(url);", "  const answer = await cached(`noaa:${stationId}`, 60, () => httpGet<NoaaAnswer>(url));");
    expect(judge("kl-ctl-cache", { files: { "src/upstream/noaa.ts": viaRedis } })).toMatchObject({ followed: true, repeated: false, done: true });
    const viaMap = (old: string) => old.replace("export async function fetchLatest", "const cache = new Map<string, { at: number; value: LatestReading | null }>();\n\nexport async function fetchLatest");
    expect(judge("kl-ctl-cache", { files: { "src/upstream/noaa.ts": viaMap } })).toMatchObject({ followed: false, repeated: true, done: true });
  });
});
