// The always-on A/B, held-out v2 (0.7.1): six convention tasks in the same two projects (eval/ab/tasks-alwayson.mjs),
// written after the first held-out set's before-run showed that a file which already follows the convention teaches
// it on its own (with no memory, Claude followed 14 of 18 conventions nothing in the prompt pointed at, by copying the
// code around it), and before any always-on code. Each task edits a file written "before" the convention, which the
// task carries in `files` (so the project folders are unchanged): a weekly report with hard-coded headings and raw
// dates, a CSV export that formats values into its SQL, a nightly job with console.log and process.env, a webhook
// route with crypto.randomUUID(). The prompt names the task in words the line does not use. Same arms and checks as
// the first set; no controls here (the first set has six).
import { PROJECTS, stripPy } from "./tasks-alwayson.mjs";
import { integers, stripComments } from "./tasks.mjs";

export { PROJECTS };

const json = (text) => {
  try {
    return JSON.parse(text ?? "{}");
  } catch {
    return {};
  }
};
const newKeys = (ctx, file, re) => {
  const now = json(ctx.read(file));
  const base = json(ctx.readBase(file));
  return Object.entries(now).filter(([k, v]) => !(k in base) && re.test(String(v))).map(([k]) => k);
};

const WEEKLY_HTML = `{% extends "base.html" %}
{% block content %}
<h1>Weekly report</h1>
<p>Bookings per room for the week that starts {{ week_start }}.</p>
<table>
  <thead>
    <tr>
      <th>Room</th>
      <th>Bookings</th>
      <th>Last booked</th>
    </tr>
  </thead>
  <tbody>
  {% for row in rows %}
    <tr>
      <td>{{ row.room }}</td>
      <td>{{ row.bookings }}</td>
      <td>{{ row.last_booked }}</td>
    </tr>
  {% else %}
    <tr><td colspan="3">No bookings this week.</td></tr>
  {% endfor %}
  </tbody>
</table>
{% endblock %}
`;
const REPORTS_PY = `from datetime import date, timedelta

from flask import Blueprint, render_template

from ..db import q

# The weekly report, from the first version of the app.
bp = Blueprint("reports", __name__)


@bp.get("/reports/weekly")
def weekly():
    week_start = date.today() - timedelta(days=date.today().weekday())
    rows = q(
        "SELECT r.name AS room, COUNT(b.id) AS bookings, MAX(b.starts_at) AS last_booked "
        "FROM rooms r LEFT JOIN bookings b ON b.room_id = r.id AND b.starts_at >= ? AND b.cancelled_at IS NULL "
        "GROUP BY r.id ORDER BY r.name",
        (week_start.isoformat(),),
    ).fetchall()
    return render_template("reports/weekly.html", rows=rows, week_start=week_start.isoformat())
`;
const EXPORT_PY = `import csv
import io

from flask import Blueprint, Response, request

from ..db import q

# The CSV export, from the first version of the app.
bp = Blueprint("export", __name__)


@bp.get("/export.csv")
def export_csv():
    since = request.args.get("since", "1970-01-01")
    sql = f"SELECT b.id, r.name, b.member_name, b.starts_at, b.cancelled_at FROM bookings b JOIN rooms r ON r.id = b.room_id WHERE b.starts_at >= '{since}' ORDER BY b.starts_at"
    rows = q(sql).fetchall()
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["id", "room", "member", "starts_at", "cancelled_at"])
    for row in rows:
        writer.writerow([row["id"], row["name"], row["member_name"], row["starts_at"], row["cancelled_at"]])
    return Response(out.getvalue(), mimetype="text/csv")
`;
const RETENTION_TS = `import { type Db } from "../db.js";

// The nightly job, from the first version of the service.
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 90);

export function runRetention(db: Db): number {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  const r = db.prepare("DELETE FROM readings WHERE at < ?").run(cutoff);
  console.log("retention: deleted " + r.changes + " readings older than " + cutoff);
  return r.changes;
}
`;
const WEBHOOKS_TS = `import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { type Db } from "../db.js";
import { ApiError } from "../errors.js";

// Webhook registrations, from the first version of the service.
interface WebhookRow {
  id: string;
  station_id: string;
  url: string;
  created_at: string;
}

export function webhookRoutes(app: FastifyInstance, db: Db) {
  db.exec("CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, station_id TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, status INTEGER NOT NULL, at TEXT NOT NULL)");

  app.post<{ Body: { stationId: string; url: string } }>("/v1/webhooks", async (req, reply) => {
    if (!db.prepare("SELECT id FROM stations WHERE id = ?").get(req.body?.stationId)) throw new ApiError("station_not_found");
    const row: WebhookRow = { id: crypto.randomUUID(), station_id: req.body.stationId, url: req.body.url, created_at: new Date().toISOString() };
    db.prepare("INSERT INTO webhooks (id, station_id, url, created_at) VALUES (?, ?, ?, ?)").run(row.id, row.station_id, row.url, row.created_at);
    reply.code(201);
    return { id: row.id, stationId: row.station_id, url: row.url, createdAt: row.created_at };
  });

  app.get<{ Params: { id: string } }>("/v1/webhooks/:id", async (req) => {
    const row = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(req.params.id) as WebhookRow | undefined;
    if (!row) throw new ApiError("alert_not_found", "no such webhook");
    return { id: row.id, stationId: row.station_id, url: row.url, createdAt: row.created_at };
  });
}
`;

export const TASKS = [
  {
    id: "sd2-report-i18n",
    project: "sundial",
    category: "convention",
    points: false,
    line: "sd_i18n",
    files: { "sundial/templates/reports/weekly.html": WEEKLY_HTML, "sundial/routes/reports.py": REPORTS_PY },
    prompt: "The weekly report page should also show the number of cancellations per room.",
    follows: "The new column's heading comes from `t()` with a new key in `sundial/locales/en.json`, not hard-coded English like the headings around it.",
    check(ctx) {
      const tpl = ctx.addedLines(/^sundial\/templates\/reports\//).join("\n");
      const column = /cancel/i.test(tpl);
      const usesT = /t\(\s*['"][\w.-]*cancel[\w.-]*['"]/i.test(tpl);
      const hardcoded = />\s*Cancell?ations?\s*</i.test(tpl);
      const key = newKeys(ctx, "sundial/locales/en.json", /cancel/i).length > 0;
      return { followed: column && usesT && key && !hardcoded, done: column, note: `cancellations column: ${column}; heading through t(): ${usesT}; new en.json key: ${key}; hard-coded heading: ${hardcoded}` };
    },
  },
  {
    id: "sd2-report-dates",
    project: "sundial",
    category: "convention",
    points: false,
    line: "sd_dates",
    files: { "sundial/templates/reports/weekly.html": WEEKLY_HTML, "sundial/routes/reports.py": REPORTS_PY },
    prompt: "On the weekly report, the Last booked column shows the raw database value. Make it readable.",
    follows: "The value goes through `fmt_date()` or `fmt_time()` (`sundial/dates.py`), not `strftime`, a Jinja filter or string slicing in the template or the view.",
    check(ctx) {
      const tpl = ctx.addedLines(/^sundial\/templates\/reports\//).join("\n");
      const py = stripPy(ctx.addedLines(/^sundial\/routes\/reports\.py$/).join("\n"));
      const changed = ctx.changed().some((c) => /^sundial\/(templates\/reports|routes\/reports)/.test(c.path));
      const helper = /fmt_(?:date|time)\s*\(/.test(tpl + py);
      const other = /strftime|\|\s*(?:date|datetime|truncate|replace)\b|\[\s*:\s*1\d\s*\]|fromisoformat/.test(tpl + py);
      return { followed: changed && helper && !other, done: changed, note: `fmt_date/fmt_time: ${helper}; strftime, a filter or slicing: ${other}` };
    },
  },
  {
    id: "sd2-export-sql",
    project: "sundial",
    category: "convention",
    points: false,
    line: "sd_sql",
    files: { "sundial/routes/export.py": EXPORT_PY },
    prompt: "Let the CSV export be limited to one room: `/export.csv?room=<room id>`.",
    follows: "The room id goes into the query as a `?` parameter through `q()`, not formatted into the SQL text as the route's `since` already is.",
    check(ctx) {
      const py = stripPy(ctx.addedLines(/^sundial\/routes\/export\.py$/).join("\n"));
      const filters = /args\.get\(\s*["']room["']/.test(py) || /request\.args\[["']room["']\]/.test(py);
      const placeholder = /room_id\s*=\s*\?/.test(py) || /q\([^)]*\?[^)]*room/.test(py) || /params\.append\(\s*room/.test(py) || /\(\s*room\s*,?\s*\)/.test(py);
      const interpolated = /\{room/.test(py) || /%\s*\(?\s*room/.test(py) || /\.format\([^)]*room/.test(py) || /\+\s*(?:str\()?\s*room/.test(py);
      return { followed: filters && placeholder && !interpolated, done: filters, note: `room read from the query: ${filters}; ? placeholder: ${placeholder}; value formatted into SQL: ${interpolated}` };
    },
  },
  {
    id: "kl2-retention-log",
    project: "kelpline",
    category: "convention",
    points: false,
    line: "kl_log",
    files: { "src/jobs/retention.ts": RETENTION_TS },
    prompt: "The nightly job in `src/jobs/retention.ts` should also remove alerts whose station no longer exists, and say how many it removed.",
    follows: "The count is reported with `log` from `src/lib/log.ts` with fields, not with another `console.log` like the one already in the file.",
    check(ctx) {
      const added = ctx.addedLines(/^src\//).map(stripComments).join("\n");
      const removes = /DELETE FROM alerts/i.test(added) && /station/i.test(added);
      const logged = /\blog\.(?:info|warn|debug)\(\s*\{/.test(added);
      const console_ = /\bconsole\.\w+\(/.test(added);
      return { followed: removes && logged && !console_, done: removes, note: `removes orphaned alerts: ${removes}; log.* with fields: ${logged}; console.*: ${console_}` };
    },
  },
  {
    id: "kl2-retention-env",
    project: "kelpline",
    category: "convention",
    points: false,
    line: "kl_env",
    files: { "src/jobs/retention.ts": RETENTION_TS },
    prompt: "The nightly job in `src/jobs/retention.ts` keeps readings for a fixed number of days. Make the number adjustable per deployment.",
    follows: "The number is read in `src/config.ts` (`config.readingsRetentionDays` is already there) and the job reads `config`; no `process.env` stays in the job.",
    check(ctx) {
      const job = stripComments(ctx.read("src/jobs/retention.ts") ?? "");
      const viaConfig = /\bconfig\.\w*[Rr]etention\w*/.test(job) && /from\s+["']\.\.\/config(?:\.js)?["']/.test(job);
      const envInJob = /process\.env/.test(job);
      const envElsewhere = ctx.changed().filter((c) => /^src\//.test(c.path) && c.path !== "src/config.ts" && c.path !== "src/jobs/retention.ts").some((c) => /process\.env/.test(stripComments(ctx.read(c.path) ?? "")) && !/process\.env/.test(stripComments(ctx.readBase(c.path) ?? "")));
      const done = ctx.changed().some((c) => c.path === "src/jobs/retention.ts" || c.path === "src/config.ts");
      return { followed: done && viaConfig && !envInJob && !envElsewhere, done, note: `job reads config: ${viaConfig}; process.env left in the job: ${envInJob}; process.env added elsewhere: ${envElsewhere}` };
    },
  },
  {
    id: "kl2-webhook-ids",
    project: "kelpline",
    category: "convention",
    points: false,
    line: "kl_ids",
    files: { "src/routes/webhooks.ts": WEBHOOKS_TS },
    prompt: "Add `POST /v1/webhooks/:id/test` to `src/routes/webhooks.ts` that records a test delivery for the webhook and returns it.",
    follows: "The delivery's id comes from `newId()` (`src/lib/ids.ts`), not `crypto.randomUUID()` like the registration route above it.",
    check(ctx) {
      const added = ctx.addedLines(/^src\//).map(stripComments).join("\n");
      const route = /\/v1\/webhooks\/:id\/test/.test(added);
      const newIdUsed = /\bnewId\(\)/.test(added);
      const other = /randomUUID|from\s+["']uuid["']|nanoid|ulid/i.test(added);
      return { followed: route && newIdUsed && !other, done: route, note: `route: ${route}; newId(): ${newIdUsed}; randomUUID or a package: ${other}` };
    },
  },
];
