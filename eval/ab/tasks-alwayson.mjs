// The always-on A/B (0.7.1): does a rule every task must follow reach Claude when nothing in the prompt points at it,
// and does an always-on rule get in the way of a task it has nothing to do with? Written, with what "follows the
// memory" means for each task and the check that decides it, before any session ran (scripts/ab.mjs runs them with
// --tasks-file eval/ab/tasks-alwayson.mjs). Held out: no earlier set uses these two projects, and nothing was tuned
// on these tasks.
//
// Two small projects (eval/ab/projects/sundial, a Flask app with Jinja templates; eval/ab/projects/kelpline, a Fastify
// API in TypeScript), each with a project memory of 36 lines written as jevmem writes them. A line's fifth element,
// { always: true }, labels it as a rule or convention that applies whatever a task is about (logging, errors, i18n,
// ids, units, tests, generated files, branch policy); the other lines are facts and decisions about one part of the
// system. The label is the harness's: a build that marks always-on lines gets them marked; a build without the idea
// gets the same lines unmarked. Two kinds of task:
//   convention  the right answer depends on one always-on line (`line`) that the repository itself does not state, and
//               the prompt does not point at it (`points: false`; two tasks point at it, `points: true`, for comparison)
//   control     the right answer depends on a decision or dead end (`line`) while the project's always-on rules have
//               nothing to do with the task; an always-on rule that got in the way shows as a task not done, or a
//               session that stopped to ask (scripts/ab-report.mjs: asked_instead)
// Arms as in eval/ab/tasks.mjs: none, jevmem (recall only, the guard off), claudemd. Checks read files and tool calls
// only; no LLM judges anything.

import { integers, stripComments } from "./tasks.mjs";

/** Python with comments and docstrings removed, so a figure or a word in a comment is not read as code. */
export function stripPy(src) {
  return String(src ?? "")
    .replace(/"""[\s\S]*?"""/g, "")
    .replace(/'''[\s\S]*?'''/g, "")
    .replace(/(^|[^"'])#.*$/gm, "$1");
}

const A = { always: true };

export const PROJECTS = {
  sundial: {
    dir: "eval/ab/projects/sundial",
    title: "sundial",
    memory: [
      ["sd_stack", "architecture", "The app is Flask 3 with Jinja templates; each resource has a blueprint in `sundial/routes/` and its templates in `sundial/templates/<resource>/`"],
      ["sd_sqlite", "decision", "Data lives in SQLite through `q()` in `sundial/db.py`; no ORM"],
      ["sd_sql", "constraint", "SQL goes through `q()` with `?` placeholders and a params tuple; a value is never formatted into the SQL text", null, A],
      ["sd_i18n", "preference", "Every string shown to people, in a template or a `flash()`, goes through `t()` from `sundial/i18n.py`, with the English text in `sundial/locales/en.json`; no English copy in templates or views", null, A],
      ["sd_locales", "constraint", "Only `sundial/locales/en.json` is edited by hand; `de.json` and `fr.json` come from the translation vendor's sync, and edits there are overwritten", null, A],
      ["sd_dates", "decision", "Dates and times shown to people go through `fmt_date()` and `fmt_time()` from `sundial/dates.py` (the studio's local time); `strftime` is never called in a template or a view", null, A],
      ["sd_settings", "decision", "Tunable values (limits, windows, batch sizes) come from `settings.get('name')` with their default in `config/defaults.toml`; no such literal in Python", null, A],
      ["sd_tests", "preference", "Every route change comes with a pytest test in `tests/` that goes through the `client` fixture", null, A],
      ["sd_migrations", "constraint", "A migration file that has run anywhere is never edited; every schema change is a new numbered file in `migrations/`", null, A],
      ["sd_main", "constraint", "Nothing is committed straight to `main`; work goes on a branch and through a pull request", null, A],
      ["sd_pii_log", "preference", "Log lines may carry booking ids but never a member's name or email address", null, A],
      ["sd_commits", "preference", "Commit subjects are one short imperative sentence", null, A],
      ["sd_de_celery", "dead-end", "Tried Celery with Redis for the confirmation and reminder emails, but the ops box has no Redis and the worker died on every deploy; emails are queued in the `outbox` table with `mail.enqueue()` and sent by `flask send-outbox` from cron"],
      ["sd_page_old", "superseded", "The bookings list shows 50 bookings per page", "sd_page"],
      ["sd_page", "decision", "List pages show 25 rows per page (`page_size` in `config/defaults.toml`), with `?page=` starting at 1"],
      ["sd_bug_tz", "bug", "Bookings made after 11 pm landed on the next day because times were compared in UTC; bookings are stored and compared in the studio's local time"],
      ["sd_prices", "decision", "Prices are integer cents (`price_cents`); never floats"],
      ["sd_de_fullcalendar", "dead-end", "Tried FullCalendar for the week view, but the bundle tripled and it fought the server-rendered pages; the week view is a plain Jinja table"],
      ["sd_capacity", "decision", "A room's capacity is a column on `rooms`; a booking that would exceed it is refused with a 409"],
      ["sd_todo_waitlist", "todo", "A waiting list for full classes is planned after the autumn term"],
      ["sd_auth", "decision", "Staff log in with the session cookie set by `/login`; there is no API token"],
      ["sd_bug_double", "bug", "Double-clicking Book created two bookings; the create route ignores an identical booking made in the last few seconds (`duplicate_window_seconds`)"],
      ["sd_csv", "decision", "The bookings export is CSV, read from the database `export_batch_rows` at a time"],
      ["sd_sms_old", "superseded", "Reminders go out by SMS the evening before", "sd_reminders"],
      ["sd_reminders", "decision", "Reminders go out by email the evening before, through the outbox; SMS stopped when the provider's prices doubled"],
      ["sd_de_sqlalchemy", "dead-end", "Moving the queries to SQLAlchemy was abandoned after two days: the generated SQL missed the `(room_id, starts_at)` index and the list page took 4 s; the hand-written SQL through `q()` stays"],
      ["sd_cancel_window", "decision", "A booking can be cancelled up to `cancel_window_minutes` before it starts; a later cancellation is kept and marked late"],
      ["sd_room_names", "constraint", "Room names are unique and never renamed; a renamed room gets a new row"],
      ["sd_todo_ical", "todo", "An iCal feed per member is planned once members can log in"],
      ["sd_errors", "preference", "Form errors are shown with `flash(t('key'), 'error')` above the form, never as inline text next to a field"],
      ["sd_timezone", "decision", "The studio's timezone is `Europe/Berlin`, set once as `studio_tz` in `config/defaults.toml`"],
      ["sd_bug_capacity", "bug", "Capacity checks counted cancelled bookings; the count excludes rows with `cancelled_at` set"],
      ["sd_de_otp", "dead-end", "Tried one-time codes by email for staff login, but the codes arrived minutes late through the outbox cron and staff were locked out; the password login stays"],
      ["sd_deploy", "decision", "Deploys are a `git pull` and `systemctl restart sundial` on the one host, by hand"],
      ["sd_assets", "architecture", "Static files are served by Flask from `sundial/static/`; there is no bundler"],
      ["sd_outbox", "architecture", "Outgoing email is a row in the `outbox` table (`mail.enqueue()`); `flask send-outbox` sends what is queued"],
    ],
  },
  kelpline: {
    dir: "eval/ab/projects/kelpline",
    title: "kelpline",
    memory: [
      ["kl_stack", "architecture", "The API is Fastify 5 in TypeScript (`src/server.ts` builds the app); each resource has a route file in `src/routes/`"],
      ["kl_sqlite", "decision", "Readings and alerts are stored in SQLite through `better-sqlite3` with hand-written SQL in `src/db.ts`; no ORM"],
      ["kl_openapi", "constraint", "Every HTTP route is also declared in `api/openapi.yaml` (path, parameters, responses); `test/contract.test.ts` fails on a route the file does not list", null, A],
      ["kl_errors", "preference", "API errors are thrown as `new ApiError(code)` from `src/errors.ts`, with the code added to `ERROR_CODES` there; a route never builds its own `{ message }` with `reply.code(4xx)`", null, A],
      ["kl_ids", "architecture", "Public ids are 20-character strings from `newId()` in `src/lib/ids.ts`; `crypto.randomUUID()` and the uuid package are not used", null, A],
      ["kl_units", "decision", "Water heights are integer millimetres everywhere: `height_mm` in SQL, fields ending in `Mm` in JSON; never metres or floats", null, A],
      ["kl_env", "constraint", "Settings are read from `process.env` in `src/config.ts` only; the rest of `src/` reads `config`", null, A],
      ["kl_tests", "preference", "Every route has a test in `test/routes/` that calls it with `app.inject`", null, A],
      ["kl_log", "preference", "Failures are logged with `log` from `src/lib/log.ts` with structured fields, as in `log.warn({ stationId, err }, \"noaa fetch failed\")`; `console.*` is never used in `src/`", null, A],
      ["kl_main", "constraint", "`main` is protected; changes go through a pull request with one review", null, A],
      ["kl_http", "decision", "Outbound HTTP goes through `httpGet` in `src/lib/http.ts` (5 s timeout, one retry); `fetch` is never called directly", null, A],
      ["kl_commits", "preference", "Commit subjects are short imperative sentences without ticket numbers", null, A],
      ["kl_page_old", "superseded", "List endpoints return 20 items by default", "kl_page"],
      ["kl_page", "decision", "List endpoints take `limit` and `offset`; `limit` defaults to 100 and is capped at 500"],
      ["kl_de_ws", "dead-end", "Tried WebSockets for live readings, but the proxy closed idle sockets after 60 s and every dashboard reconnected at once; dashboards poll `GET /v1/stations/:id/readings?since=` every 30 s"],
      ["kl_de_cache_map", "dead-end", "Tried caching NOAA answers in a module-level `Map`, but memory grew with every station and the process was OOM-killed; upstream answers are cached with `cached()` in `src/lib/cache.ts` (Redis)"],
      ["kl_cache", "architecture", "`cached(key, ttlSeconds, fn)` in `src/lib/cache.ts` keeps upstream answers in Redis"],
      ["kl_noaa", "architecture", "Readings come from NOAA CO-OPS (`src/upstream/noaa.ts`), polled by `src/poller.ts` inside the API process"],
      ["kl_bug_metres", "bug", "Alerts fired on every reading because NOAA's metres were compared with thresholds in millimetres; `noaa.ts` converts at the boundary"],
      ["kl_bug_dst", "bug", "Readings around the autumn clock change were stored twice because `at` was local time; `at` is an ISO 8601 UTC string"],
      ["kl_time", "decision", "Timestamps in SQL and JSON are ISO 8601 strings in UTC"],
      ["kl_alerts", "decision", "An alert fires once when a reading crosses its threshold and arms again only after the height falls below it"],
      ["kl_email", "decision", "Alert emails go out through Postmark from `src/notify.ts`"],
      ["kl_de_prisma", "dead-end", "Prisma was tried for the readings table, but its generated client added 180 MB to the image and cold start doubled; `better-sqlite3` with hand-written SQL stays"],
      ["kl_retention", "constraint", "Readings older than 90 days (`readingsRetentionDays`) are deleted by the nightly job; nothing reads them after that"],
      ["kl_todo_pg", "todo", "Move from SQLite to Postgres once there are more than 50 stations"],
      ["kl_todo_sms", "todo", "SMS alerts wait until the Postmark contract covers them"],
      ["kl_station_ids", "decision", "Station ids are NOAA's 7-digit station numbers, kept as strings, never numbers"],
      ["kl_bug_limit", "bug", "`GET /v1/stations` ignored a `limit` above the cap silently; it answers 400 `limit_too_large`"],
      ["kl_deploy", "decision", "Deploys are a Docker image built by GitHub Actions on `main` and pulled by the one VM"],
      ["kl_poll_old", "superseded", "The poller runs every 5 minutes", "kl_poll"],
      ["kl_poll", "decision", "The poller runs every minute; NOAA publishes a reading every 6 minutes, so a run with nothing new is normal"],
      ["kl_de_cron", "dead-end", "Running the poller as a cron job was dropped: overlapping runs double-inserted readings; it is a loop inside the API process"],
      ["kl_rounding", "decision", "Heights are rounded half up to the millimetre at the NOAA boundary and never rounded again"],
      ["kl_cors", "constraint", "CORS allows the dashboard origin only (`config.dashboardOrigin`); never `*`"],
      ["kl_tests_db", "preference", "Tests run against a fresh SQLite file per test (`makeTestApp()` in `test/helpers.ts`); the database is never mocked"],
    ],
  },
};

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const editsTo = (ctx, re) => ctx.toolCalls.filter((c) => EDIT_TOOLS.has(c.name) && re.test(String(c.input?.file_path ?? c.input?.notebook_path ?? "")));
const json = (text) => {
  try {
    return JSON.parse(text ?? "{}");
  } catch {
    return {};
  }
};
/** Keys of `file` whose value matches `re` and that the base version of the file does not have. */
const newKeys = (ctx, file, re) => {
  const now = json(ctx.read(file));
  const base = json(ctx.readBase(file));
  return Object.entries(now).filter(([k, v]) => !(k in base) && re.test(String(v))).map(([k]) => k);
};

export const TASKS = [
  // ------------------------------------------------------------------ sundial: conventions
  {
    id: "sd-i18n",
    project: "sundial",
    category: "convention",
    points: false,
    line: "sd_i18n",
    prompt: "Add a Cancel button to each row of the bookings list in `sundial/templates/bookings/list.html` that posts to `/bookings/<id>/cancel`.",
    follows: "The button's label (and any flash message added with it) comes from `t()` with a new key in `sundial/locales/en.json`; no English text is hard-coded in the template or the view.",
    check(ctx) {
      const tpl = ctx.addedLines(/^sundial\/templates\//).join("\n");
      const py = stripPy(ctx.addedLines(/^sundial\/routes\//).join("\n"));
      const button = /cancel/i.test(tpl) && /<form|<button|formaction|url_for\(/.test(tpl);
      const hardcoded = />\s*Cancel(?:\s+booking)?\s*</i.test(tpl) || /value\s*=\s*["']Cancel/i.test(tpl) || /flash\(\s*["']/.test(py) || /["']Cancel(?:\s+booking)?["']/.test(py);
      const usesT = /t\(\s*['"][\w.-]*cancel[\w.-]*['"]/i.test(tpl + "\n" + py);
      const key = newKeys(ctx, "sundial/locales/en.json", /cancel/i).length > 0;
      return { followed: button && usesT && key && !hardcoded, done: button, note: `button: ${button}; t() with a cancel key: ${usesT}; new en.json key: ${key}; hard-coded English: ${hardcoded}` };
    },
  },
  {
    id: "sd-dates",
    project: "sundial",
    category: "convention",
    points: false,
    line: "sd_dates",
    prompt: "Show on the rooms page when each room was last cleaned. The column is `rooms.last_cleaned_at`.",
    follows: "The value is shown through `fmt_date()` or `fmt_time()`, not printed raw and not formatted with `strftime` or a Jinja date filter in the template or the view.",
    check(ctx) {
      const tpl = ctx.addedLines(/^sundial\/templates\/rooms\//).join("\n");
      const py = stripPy(ctx.addedLines(/^sundial\/routes\/rooms\.py$/).join("\n"));
      const shown = /last_cleaned/.test(tpl + py);
      const helper = /fmt_(?:date|time)\s*\(/.test(tpl + py);
      const raw = /\{\{\s*(?:room|r)\.last_cleaned_at\s*\}\}/.test(tpl) || /\|\s*(?:date|datetime|strftime)\b/.test(tpl) || /strftime|isoformat\(/.test(tpl + py);
      return { followed: shown && helper && !raw, done: shown, note: `shown: ${shown}; fmt_date/fmt_time: ${helper}; raw value or strftime: ${raw}` };
    },
  },
  {
    id: "sd-sql",
    project: "sundial",
    category: "convention",
    points: false,
    line: "sd_sql",
    prompt: "Let the bookings list be filtered by room: `/bookings?room=<room id>` shows that room's bookings only.",
    follows: "The room id goes into the query as a `?` parameter through `q()`; it is never formatted into the SQL text (no f-string, `%`, `.format()` or `+`).",
    check(ctx) {
      const py = stripPy(ctx.addedLines(/^sundial\/routes\/bookings\.py$/).join("\n"));
      const filters = /args\.get\(\s*["']room["']/.test(py) || /request\.args\[["']room["']\]/.test(py);
      const placeholder = /room_id\s*=\s*\?/.test(py) || /q\([\s\S]*?\?[\s\S]*?room/.test(py);
      const interpolated = /f["'][^"'\n]*(?:WHERE|AND|SELECT|FROM)[^"'\n]*\{/i.test(py) || /(?:WHERE|AND)[^"'\n]*["']\s*\+/i.test(py) || /%\s*\(?\s*room/.test(py) || /(?:WHERE|AND)[^\n]*\.format\(/i.test(py) || /\+\s*str\(\s*room/.test(py);
      return { followed: filters && placeholder && !interpolated, done: filters, note: `room read from the query: ${filters}; ? placeholder: ${placeholder}; value formatted into SQL: ${interpolated}` };
    },
  },
  {
    id: "sd-settings",
    project: "sundial",
    category: "convention",
    points: false,
    line: "sd_settings",
    prompt: "Bookings more than 60 days ahead should be refused with a 400 in the create route.",
    follows: "The 60 is a setting: read with `settings.get(...)` and given its default in `config/defaults.toml`, not written as a literal in the Python.",
    check(ctx) {
      const py = stripPy(ctx.addedLines(/^sundial\/routes\/bookings\.py$/).join("\n"));
      const rejects = /400/.test(py) && /days|ahead|timedelta|too far/i.test(py);
      const setting = /settings\.get\(\s*["'][\w_]+["']/.test(py);
      const base = ctx.readBase("config/defaults.toml") ?? "";
      const tomlKey = (ctx.read("config/defaults.toml") ?? "").split("\n").some((l) => !base.includes(l) && /=\s*60\b/.test(l));
      const literal = integers(py).includes(60);
      return { followed: rejects && setting && tomlKey && !literal, done: rejects, note: `refuses with 400: ${rejects}; settings.get: ${setting}; defaults.toml key = 60: ${tomlKey}; literal 60 in the Python: ${literal}` };
    },
  },
  {
    id: "sd-tests",
    project: "sundial",
    category: "convention",
    points: false,
    line: "sd_tests",
    prompt: "Add a `GET /healthz` route that answers `{\"ok\": true}`.",
    follows: "A pytest test in `tests/` calls the new route through the `client` fixture.",
    check(ctx) {
      const route = ctx.changedText(/^sundial\/.*\.py$/).some((t) => /healthz/.test(t));
      const test = ctx.changed().some((c) => /^tests\/.*\.py$/.test(c.path) && /healthz/.test(ctx.read(c.path) ?? "") && /\bclient\b/.test(ctx.read(c.path) ?? ""));
      return { followed: route && test, done: route, note: `route: ${route}; test through client: ${test}` };
    },
  },
  {
    id: "sd-locales",
    project: "sundial",
    category: "convention",
    points: true,
    line: "sd_locales",
    prompt: "The Book button on the new-booking form should say 'Book now' in English, German and French.",
    follows: "Only `sundial/locales/en.json` changes; `de.json` and `fr.json` are left to the vendor's sync.",
    check(ctx) {
      const re = /sundial\/locales\/(?:de|fr)\.json$/;
      const attempted = editsTo(ctx, re).length > 0;
      const landed = ctx.changed().some((c) => re.test(c.path));
      const done = /book now/i.test(String(json(ctx.read("sundial/locales/en.json"))["bookings.submit"] ?? ""));
      return { followed: !attempted, attempted, landed, done, note: `edit calls on de/fr: ${editsTo(ctx, re).length}; de/fr changed in the end: ${landed}; en.json says Book now: ${done}` };
    },
  },
  {
    id: "sd-migrations",
    project: "sundial",
    category: "convention",
    points: true,
    line: "sd_migrations",
    prompt: "Rooms need a `floor` integer column, 0 by default. Update the schema in `migrations/`.",
    follows: "`001_init.sql` and `002_add_capacity.sql` are not changed; a new numbered migration adds the column.",
    check(ctx) {
      const old = /migrations\/00[12]_[^/]*\.sql$/;
      const attempted = editsTo(ctx, old).length > 0;
      const landed = ctx.changed().some((c) => old.test(c.path));
      const added = ctx.changed().filter((c) => /^migrations\/.+\.sql$/.test(c.path) && !old.test(c.path));
      const done = added.some((c) => /\bfloor\b/i.test(ctx.read(c.path) ?? ""));
      return { followed: !attempted, attempted, landed, done, note: `edits to 001/002: ${editsTo(ctx, old).length}; changed in the end: ${landed}; new migration with floor: ${done}` };
    },
  },
  // ------------------------------------------------------------------ sundial: controls
  {
    id: "sd-ctl-outbox",
    project: "sundial",
    category: "control",
    kind: "dead-end",
    line: "sd_de_celery",
    prompt: "Sending the confirmation email makes the create route slow. Make the response not wait for the email.",
    follows: "The email is queued with `mail.enqueue()` (the outbox) instead of sent in the request; no Celery, RQ, Redis or other queue is added (tried: the box has no Redis).",
    check(ctx) {
      const added = ctx.addedLines(/^(?:sundial\/|pyproject\.toml)/).join("\n");
      const route = stripPy(ctx.read("sundial/routes/bookings.py") ?? "");
      const repeated = /celery|\brq\b|redis|dramatiq|huey/i.test(added);
      const outbox = /enqueue\(/.test(route) && !/\bmail\.send\(/.test(route);
      const thread = /threading|Thread\(|concurrent\.futures|ThreadPool/.test(added);
      return { followed: outbox && !repeated, repeated, done: outbox || repeated || thread, note: `outbox (enqueue, no mail.send): ${outbox}; queue library: ${repeated}; a thread instead: ${thread}` };
    },
  },
  {
    id: "sd-ctl-page",
    project: "sundial",
    category: "control",
    kind: "superseded",
    line: "sd_page",
    stale: "sd_page_old",
    prompt: "Add paging to the bookings list with a `page` query parameter.",
    follows: "Pages hold 25 rows (`page_size`), not 50 (the superseded line).",
    check(ctx) {
      const py = stripPy(ctx.addedLines(/^sundial\//).join("\n"));
      const ints = new Set(integers(py));
      const size = ints.has(25) || /settings\.get\(\s*["']page_size["']/.test(py);
      const done = /args\.get\(\s*["']page["']/.test(py) || /request\.args\[["']page["']\]/.test(py);
      return { followed: size && !ints.has(50) && done, stale: ints.has(50), done, note: `page read from the query: ${done}; 25 or page_size: ${size}; 50 in the added code: ${ints.has(50)}` };
    },
  },
  {
    id: "sd-ctl-reminders",
    project: "sundial",
    category: "control",
    kind: "superseded",
    line: "sd_reminders",
    stale: "sd_sms_old",
    prompt: "Add a `remind` CLI command that sends the reminders for tomorrow's bookings.",
    follows: "Reminders go by email through the outbox (`mail.enqueue()`), not by SMS (the superseded line).",
    check(ctx) {
      const py = stripPy(ctx.changedText(/^sundial\/.*\.py$/).join("\n"));
      const added = stripPy(ctx.addedLines(/^sundial\//).join("\n"));
      const command = /cli\.command\(\s*["']remind["']/.test(py) || /def remind\b/.test(py);
      const stale = /sms|twilio|vonage|nexmo/i.test(added);
      const email = /enqueue\(|mail\.send\(/.test(added);
      return { followed: command && email && !stale, stale, done: command, note: `remind command: ${command}; email through mail: ${email}; SMS: ${stale}` };
    },
  },
  // ------------------------------------------------------------------ kelpline: conventions
  {
    id: "kl-openapi",
    project: "kelpline",
    category: "convention",
    points: false,
    line: "kl_openapi",
    prompt: "Add `GET /v1/stations/:id/latest` that returns the station's most recent reading.",
    follows: "The route is declared in `api/openapi.yaml` too (`/v1/stations/{id}/latest`).",
    check(ctx) {
      const route = ctx.changedText(/^src\/routes\//).some((t) => /\/v1\/stations\/:id\/latest|\/latest["'`]/.test(stripComments(t)));
      const spec = /\/v1\/stations\/\{\w+\}\/latest\s*:/.test(ctx.read("api/openapi.yaml") ?? "");
      return { followed: route && spec, done: route, note: `route: ${route}; in openapi.yaml: ${spec}` };
    },
  },
  {
    id: "kl-errors",
    project: "kelpline",
    category: "convention",
    points: false,
    line: "kl_errors",
    prompt: "A `POST /v1/alerts` whose `thresholdMm` is negative should be refused.",
    follows: "The refusal is a `new ApiError(code)` with a new code in `ERROR_CODES` (`src/errors.ts`), not an inline `reply.code(400).send({ … })`.",
    check(ctx) {
      const src = ctx.addedLines(/^src\//).map(stripComments).join("\n");
      const refuses = /thresholdMm\s*<\s*0|<\s*0\b|negative|Number\.isInteger|isFinite/.test(src);
      const apiError = /new ApiError\(/.test(src);
      const codes = (f) => [...(f ?? "").matchAll(/^\s+(\w+):\s*\d{3}/gm)].map((m) => m[1]);
      const newCode = codes(ctx.read("src/errors.ts")).some((c) => !codes(ctx.readBase("src/errors.ts")).includes(c));
      const inline = /reply\s*\.\s*(?:code|status)\(\s*4\d\d\s*\)\s*\.send\(/.test(src);
      return { followed: refuses && apiError && newCode && !inline, done: refuses, note: `refuses negatives: ${refuses}; new ApiError: ${apiError}; new code in ERROR_CODES: ${newCode}; inline reply.code(4xx).send: ${inline}` };
    },
  },
  {
    id: "kl-ids",
    project: "kelpline",
    category: "convention",
    points: false,
    line: "kl_ids",
    prompt: "Add `POST /v1/subscriptions` that stores an email address and a station id and returns the new subscription.",
    follows: "The subscription's id comes from `newId()` (`src/lib/ids.ts`), not `crypto.randomUUID()`, uuid or nanoid.",
    check(ctx) {
      const src = ctx.changedText(/^src\//).map(stripComments).join("\n");
      const added = ctx.addedLines(/^src\//).map(stripComments).join("\n");
      const route = /\/v1\/subscriptions/.test(src);
      const newIdUsed = /\bnewId\(\)/.test(added);
      const other = /randomUUID|from\s+["']uuid["']|require\(["']uuid["']\)|nanoid|ulid/i.test(added + "\n" + (ctx.read("package.json") ?? ""));
      return { followed: route && newIdUsed && !other, done: route, note: `route: ${route}; newId(): ${newIdUsed}; randomUUID/uuid/nanoid: ${other}` };
    },
  },
  {
    id: "kl-units",
    project: "kelpline",
    category: "convention",
    points: false,
    line: "kl_units",
    prompt: "Add the highest reading of the last 24 hours to each station's JSON.",
    follows: "The new field is integer millimetres with a name ending in `Mm`; nothing divides by 1000 or formats a float.",
    check(ctx) {
      const added = ctx.addedLines(/^src\//).map(stripComments).join("\n");
      const field = /\b[a-z][A-Za-z]*Mm\s*[:=]/.test(added) || /\b[a-z][A-Za-z]*Mm\b/.test(added);
      const metres = /\/\s*1000\b|\/\s*1_000\b|toFixed\(|\b[a-z][A-Za-z]*(?:Metres|Meters|M)\s*:/.test(added);
      const done = /24|MAX\(|Math\.max|highest|peak/i.test(added) && ctx.changed().some((c) => /^src\//.test(c.path));
      return { followed: done && field && !metres, done, note: `field ending in Mm: ${field}; metres or a float: ${metres}` };
    },
  },
  {
    id: "kl-env",
    project: "kelpline",
    category: "convention",
    points: false,
    line: "kl_env",
    prompt: "Let a staging deploy point the service at a different NOAA host.",
    follows: "The host is a setting read from `process.env` in `src/config.ts`; no other file in `src/` reads `process.env`.",
    check(ctx) {
      const cfg = ctx.addedLines(/^src\/config\.ts$/).map(stripComments).join("\n");
      const elsewhere = ctx.changed().filter((c) => /^src\//.test(c.path) && c.path !== "src/config.ts").some((c) => /process\.env/.test(stripComments(ctx.read(c.path) ?? "")) && !/process\.env/.test(stripComments(ctx.readBase(c.path) ?? "")));
      const setting = /process\.env\.\w*(?:NOAA|UPSTREAM|TIDES)\w*/i.test(cfg);
      const done = setting || ctx.changed().some((c) => /^src\/upstream\/noaa\.ts$/.test(c.path));
      return { followed: setting && !elsewhere, done, note: `NOAA host from process.env in config.ts: ${setting}; process.env added elsewhere in src/: ${elsewhere}` };
    },
  },
  {
    id: "kl-tests",
    project: "kelpline",
    category: "convention",
    points: false,
    line: "kl_tests",
    prompt: "Add `GET /v1/healthz` that answers `{ \"ok\": true }`.",
    follows: "A test in `test/routes/` calls the route with `app.inject`.",
    check(ctx) {
      const route = ctx.changedText(/^src\//).some((t) => /healthz/.test(t));
      const test = ctx.changed().some((c) => /^test\/routes\/.*\.test\.ts$/.test(c.path) && /healthz/.test(ctx.read(c.path) ?? "") && /inject\(/.test(ctx.read(c.path) ?? ""));
      return { followed: route && test, done: route, note: `route: ${route}; test with app.inject: ${test}` };
    },
  },
  {
    id: "kl-log",
    project: "kelpline",
    category: "convention",
    points: false,
    line: "kl_log",
    prompt: "When the NOAA fetch fails for one station, the poller in `src/poller.ts` should carry on with the next station instead of stopping.",
    follows: "The failure is logged with `log.warn` or `log.error` from `src/lib/log.ts` with fields; no `console.*` call is added in `src/`.",
    check(ctx) {
      const added = ctx.addedLines(/^src\//).map(stripComments).join("\n");
      const handled = /try\s*\{|\.catch\(|catch\s*\(/.test(added);
      const logged = /\blog\.(?:warn|error|info)\(\s*\{/.test(added);
      const console_ = /\bconsole\.\w+\(/.test(added);
      return { followed: handled && logged && !console_, done: handled, note: `failure handled: ${handled}; log.* with fields: ${logged}; console.*: ${console_}` };
    },
  },
  // ------------------------------------------------------------------ kelpline: controls
  {
    id: "kl-ctl-ws",
    project: "kelpline",
    category: "control",
    kind: "dead-end",
    line: "kl_de_ws",
    prompt: "Dashboards want new readings to appear without reloading the page. Make that possible.",
    follows: "No WebSocket, socket.io or server-sent events (tried: the proxy closed idle sockets); the dashboards poll the readings endpoint with `since`.",
    check(ctx) {
      const text = ctx.changedText(/^(?:src\/|api\/|README)/).map(stripComments).join("\n") + "\n" + (ctx.read("package.json") ?? "");
      const repeated = /websocket|socket\.io|["']ws["']|@fastify\/websocket|EventSource|text\/event-stream|sse\b/i.test(text);
      // The right answer here is that polling with `since` already exists and nothing needs building (0.7.2: until
      // then only a changed file counted as done, so that answer scored 0 of 3 in every arm of the 2026-10-13 runs).
      const reply = ctx.reply?.() ?? "";
      const saidExists = /\bsince\b/i.test(reply) && /already|exists|in place|nothing to (?:build|add|do)/i.test(reply);
      const changed = ctx.changed().some((c) => /^(?:src\/|api\/|README)/.test(c.path));
      const done = changed || saidExists;
      return { followed: done && !repeated, repeated, done, note: `websocket or SSE: ${repeated}; said polling exists: ${saidExists}` };
    },
  },
  {
    id: "kl-ctl-page",
    project: "kelpline",
    category: "control",
    kind: "superseded",
    line: "kl_page",
    stale: "kl_page_old",
    prompt: "Add `GET /v1/alerts` listing the alerts, with `limit` and `offset`.",
    follows: "`limit` defaults to 100 and is capped at 500 (the live line), not 20 (the superseded line).",
    check(ctx) {
      const added = ctx.addedLines(/^src\//).map(stripComments).join("\n");
      const ints = new Set(integers(added));
      const reuses = /pageOf\(/.test(added) || /DEFAULT_LIMIT|MAX_LIMIT/.test(added);
      const followed = (reuses || (ints.has(100) && ints.has(500))) && !ints.has(20);
      return { followed, stale: ints.has(20), done: /\/v1\/alerts["'`]/.test(added) && /\.get\b/.test(added), note: `numbers in the added code: ${[...ints].filter((n) => n > 1).sort((a, b) => a - b).join(", ") || "none"}; reuses pageOf: ${reuses}` };
    },
  },
  {
    id: "kl-ctl-cache",
    project: "kelpline",
    category: "control",
    kind: "dead-end",
    line: "kl_de_cache_map",
    prompt: "NOAA is asked about the same station many times a minute. Cache `fetchLatest` in `src/upstream/noaa.ts`.",
    follows: "No in-process cache (a module-level `Map`, object or LRU package); the answer goes through `cached()` from `src/lib/cache.ts` (Redis).",
    check(ctx) {
      const src = ctx.changedText(/^src\//).map(stripComments).join("\n") + "\n" + (ctx.read("package.json") ?? "");
      const repeated = /new\s+Map\s*[<(]|\blru-cache\b|\bquick-lru\b|\bnode-cache\b|\bmemoizee?\b|\b(?:const|let)\s+\w*[cC]ache\w*\s*(?::[^=]+)?=\s*\{\s*\}/.test(src);
      const f = stripComments(ctx.read("src/upstream/noaa.ts") ?? "");
      const redis = /\bcached\s*[<(]/.test(f) && /from\s*["']\.\.\/lib\/cache(?:\.js)?["']/.test(f);
      return { followed: redis && !repeated, repeated, done: redis || repeated, note: `cached() from lib/cache: ${redis}; in-process cache: ${repeated}` };
    },
  },
];
