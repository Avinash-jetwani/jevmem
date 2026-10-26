// The held-out set of 0.7.7's comparison against Claude Code's auto memory (scripts/ab-automem.mjs). Written, with what
// "follows the memory" means for each task and the check that decides it, before any session ran. Three projects no
// earlier set used (eval/ab/projects/spokeline, benchnote, calmerge); jevmem was never tuned on them.
//
// Taught, not seeded: each task names what a person says in plain chat (`teach`, one statement, or two for a changed
// decision: the decision, then its change), with no instruction to remember anything; a teaching session per statement
// runs first, each tool's memory writes itself, and the task session then runs with `prompt`, which does not state the
// line. `line` is the same fact as a person would write it into CLAUDE.md (the reference arm, which is seeded); `old`
// is the replaced line of a changed decision (written nowhere; it is what "built the replaced" is judged against).
// `savedWords` (and `oldWords`) are the words a saved note of the line carries, judged in code over each tool's memory.
//
// Categories: decision (follows the decision), constraint (never attempts the forbidden change; `attempted`, `landed`),
// dead-end (does not repeat the failed approach; `repeated`), changed (follows the new decision, does not build the
// replaced one; `stale`). A check gets the context of scripts/ab-lib.mjs `makeContext` (final files, the diff since
// the first commit, the tool calls) and returns `followed`, `done` and the category's flags. No LLM judges anything.
//
// The long-project case (LONG_TASKS): six tasks in spokeline as a mature project (PROJECTS.spokeline.longFiles), seeded
// with the 230-line history in eval/ab/automem-long.mjs instead of teaching; `note` names the line each task needs.
import { integers, stripComments } from "./tasks.mjs";

/** Python source with `#` comments removed (a figure in a comment is not read as code). */
export function stripPy(src) {
  return String(src ?? "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const editsTo = (ctx, re) => ctx.toolCalls.filter((c) => EDIT_TOOLS.has(c.name) && re.test(String(c.input?.file_path ?? c.input?.notebook_path ?? "")));

/** Everything a session wrote or ran: Write contents, Edit replacements and Bash commands (main agent and subagents). */
export function writtenText(ctx, re = null) {
  return ctx.toolCalls
    .filter((c) => !re || c.name === "Bash" || re.test(String(c.input?.file_path ?? "")))
    .map((c) => {
      const i = c.input ?? {};
      if (c.name === "Write") return String(i.content ?? "");
      if (c.name === "Edit") return String(i.new_string ?? "");
      if (c.name === "MultiEdit") return (i.edits ?? []).map((e) => String(e.new_string ?? "")).join("\n");
      if (c.name === "Bash") return String(i.command ?? "");
      return "";
    })
    .join("\n");
}

const TS = /\.(?:ts|mjs|js)$/;
const srcText = (ctx) => ctx.changedText(/^(?:src|bin|scripts)\/.*\.(?:ts|mjs|js)$/).map(stripComments).join("\n");
const pyText = (ctx) => ctx.changedText(/\.py$/).map(stripPy).join("\n");
const anyText = (ctx) => ctx.changedText(/./).join("\n");

export const PROJECTS = {
  spokeline: {
    dir: "eval/ab/projects/spokeline",
    title: "spokeline",
    // The mature spokeline of the long-project case: the files its 230-line history talks about.
    longFiles: {
      "src/auth.ts": `import type { FastifyReply, FastifyRequest } from "fastify";

const API_KEYS = (process.env.API_KEYS ?? "").split(",").filter(Boolean);
const OPS_KEYS = (process.env.OPS_API_KEYS ?? "").split(",").filter(Boolean);

const bearer = (req: FastifyRequest) => String(req.headers["authorization"] ?? "").replace(/^Bearer\\s+/i, "").trim();

/** onRequest hook for /v1: every request carries a partner key in \`Authorization: Bearer\`. */
export async function requireApiKey(req: FastifyRequest, reply: FastifyReply) {
  const key = bearer(req);
  if (!key || (!API_KEYS.includes(key) && !OPS_KEYS.includes(key))) return reply.code(401).send({ error: { code: "unauthorized", message: "A valid API key is required" } });
}

/** preHandler for the endpoints that change a station or a bike: only the ops team's keys may call them. */
export async function requireOps(req: FastifyRequest, reply: FastifyReply) {
  const key = bearer(req);
  if (!key || !OPS_KEYS.includes(key)) return reply.code(403).send({ error: { code: "ops_only", message: "This endpoint is for the ops team" } });
}
`,
      "src/app.ts": `import Fastify from "fastify";
import { requireApiKey } from "./auth.js";
import { log } from "./lib/log.js";
import { bikeRoutes } from "./routes/bikes.js";
import { rentalRoutes } from "./routes/rentals.js";
import { stationRoutes } from "./routes/stations.js";

export function buildApp() {
  const app = Fastify({ loggerInstance: log });
  app.get("/healthz", async () => ({ ok: true }));
  app.register(async (v1) => {
    v1.addHook("onRequest", requireApiKey);
    v1.register(stationRoutes, { prefix: "/stations" });
    v1.register(bikeRoutes, { prefix: "/bikes" });
    v1.register(rentalRoutes, { prefix: "/rentals" });
  }, { prefix: "/v1" });
  return app;
}
`,
      "src/locks.ts": `import { httpPost } from "./lib/http.js";
import { log } from "./lib/log.js";

const VENDOR = process.env.LOCK_API_URL ?? "https://api.lockvendor.example/v2";

/** Opens a bike's lock through the vendor's API. It opens a real lock. */
export async function unlockBike(bikeId: string): Promise<{ ok: boolean }> {
  const res = await httpPost<{ ok: boolean }>(\`\${VENDOR}/locks/\${encodeURIComponent(bikeId)}/open\`, {}, { headers: { authorization: \`Bearer \${process.env.LOCK_API_KEY ?? ""}\` }, timeoutMs: 4000 });
  log.info({ bikeId, ok: res.ok }, "lock opened");
  return res;
}
`,
      "src/geo.ts": `const EARTH_M = 6_371_000;

/** Distance in metres between two points, on a sphere (haversine). */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_M * Math.asin(Math.sqrt(a)));
}

/** The n nearest of \`points\` to (lat, lng), nearest first, each with its distance. */
export function nearest<T extends { lat: number; lng: number }>(points: T[], lat: number, lng: number, n: number): (T & { distanceM: number })[] {
  return points
    .map((p) => ({ ...p, distanceM: distanceM(lat, lng, p.lat, p.lng) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, n);
}
`,
      "src/payments.ts": `import { httpPost } from "./lib/http.js";

const PROVIDER = process.env.PAYMENTS_URL ?? "https://api.paylane.example/v1";
const headers = () => ({ authorization: \`Bearer \${process.env.PAYMENTS_API_KEY ?? ""}\` });

/** Places a hold on the rider's card; returns the hold's id. */
export async function holdDeposit(userId: string, amountCents: number): Promise<{ holdId: string }> {
  return httpPost<{ holdId: string }>(\`\${PROVIDER}/holds\`, { userId, amountCents, currency: "EUR" }, { headers: headers(), timeoutMs: 5000 });
}

/** Releases a hold placed by holdDeposit. */
export async function releaseHold(holdId: string): Promise<void> {
  await httpPost<unknown>(\`\${PROVIDER}/holds/\${encodeURIComponent(holdId)}/release\`, {}, { headers: headers(), timeoutMs: 5000 });
}
`,
      "src/routes/stations.ts": `import type { FastifyInstance } from "fastify";
import { one, query } from "../db.js";
import { nearest } from "../geo.js";

interface StationRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  capacity: number;
  docked: string;
}

const STATION_SQL = \`SELECT s.id, s.name, s.lat, s.lng, s.capacity, count(b.id) FILTER (WHERE b.status = 'docked') AS docked
  FROM stations s LEFT JOIN bikes b ON b.station_id = s.id\`;

export async function stationRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    const rows = await query<StationRow>(\`\${STATION_SQL} GROUP BY s.id ORDER BY s.name\`);
    return rows.map(toJson);
  });

  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const row = await one<StationRow>(\`\${STATION_SQL} WHERE s.id = $1 GROUP BY s.id\`, [req.params.id]);
    if (!row) return reply.code(404).send({ error: { code: "station_not_found", message: "No station with that id" } });
    return toJson(row);
  });

  // The five nearest stations: every station is loaded and the distances are computed here (src/geo.ts).
  app.get<{ Params: { id: string } }>("/:id/nearby", async (req, reply) => {
    const here = await one<StationRow>(\`\${STATION_SQL} WHERE s.id = $1 GROUP BY s.id\`, [req.params.id]);
    if (!here) return reply.code(404).send({ error: { code: "station_not_found", message: "No station with that id" } });
    const all = await query<StationRow>(\`\${STATION_SQL} WHERE s.id <> $1 GROUP BY s.id\`, [req.params.id]);
    return nearest(all, here.lat, here.lng, 5).map((s) => ({ ...toJson(s), distanceM: s.distanceM }));
  });
}

function toJson(row: StationRow) {
  return { id: row.id, name: row.name, lat: row.lat, lng: row.lng, capacity: row.capacity, dockedBikes: Number(row.docked) };
}
`,
      "migrations/002_ride_points.sql": `CREATE TABLE ride_points (
  rental_id   text NOT NULL REFERENCES rentals(id),
  at          timestamptz NOT NULL,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL
);

CREATE INDEX ride_points_rental_idx ON ride_points (rental_id, at);
`,
      "test/setup.ts": `process.env.LOCK_API_KEY = "test";
process.env.OPS_API_KEYS = "ops-test";
process.env.PAYMENTS_API_KEY = "test";
`,
      "vitest.config.ts": `import { defineConfig } from "vitest/config";

export default defineConfig({ test: { setupFiles: ["test/setup.ts"] } });
`,
      "test/locks.test.ts": `import { describe, expect, it } from "vitest";
import { unlockBike } from "../src/locks.js";

// Runs against the lock vendor's sandbox only when LOCK_SANDBOX names it; otherwise skipped.
describe.skipIf(!process.env.LOCK_SANDBOX)("lock vendor sandbox", () => {
  it("opens a sandbox lock", async () => {
    const res = await unlockBike("sandbox-bike-1");
    expect(res.ok).toBe(true);
  });
});
`,
    },
  },
  benchnote: { dir: "eval/ab/projects/benchnote", title: "benchnote" },
  calmerge: { dir: "eval/ab/projects/calmerge", title: "calmerge" },
};

const ACK = " Nothing to build right now, just acknowledge.";

export const TASKS = [
  // ---------------------------------------------------------------- spokeline
  {
    id: "sl-cents",
    project: "spokeline",
    category: "decision",
    line: ["decision", "Money is integer cents everywhere: JSON fields end in `Cents` (`priceCents`), SQL columns in `_cents`; never decimals or floats"],
    teach: ["Before you touch the rentals routes, one thing that is settled for the whole API: money is integer cents everywhere, in fields named with a `Cents` suffix (`priceCents`, `depositCents`) and `_cents` columns in SQL. Never decimals or floats for money." + ACK],
    savedWords: /cents/i,
    prompt: "Add the ride price to the JSON that `POST /v1/rentals/:id/end` returns in `src/routes/rentals.ts`: 1 EUR to unlock plus 0.20 EUR per started minute.",
    follows: "The price is an integer-cents field named `…Cents` built from 100 and 20; no decimal amount such as 0.2 or 1.2 appears in the code.",
    check(ctx) {
      const src = srcText(ctx);
      const ints = new Set(integers(src));
      const centsField = /\w+Cents\b/.test(src);
      const cents = centsField && ints.has(100) && ints.has(20);
      const decimals = /(?<![\w.])(?:0\.20?|1\.[0-9]+)(?![\w.])/.test(src);
      return { followed: cents && !decimals, done: cents || decimals || /price/i.test(src), note: `…Cents field: ${centsField}; 100 and 20: ${ints.has(100) && ints.has(20)}; decimals in code: ${decimals}` };
    },
  },
  {
    id: "sl-page",
    project: "spokeline",
    category: "decision",
    line: ["decision", "List endpoints take `limit` and `offset`; `limit` defaults to 25 and is capped at 200"],
    teach: ["For the list endpoints in this API the paging is settled: `limit` and `offset` query parameters, with `limit` defaulting to 25 and capped at 200. It is the same on every list we add." + ACK],
    savedWords: /\b25\b[\s\S]{0,80}\b200\b|\b200\b[\s\S]{0,80}\b25\b/,
    prompt: "Add `GET /v1/rentals` to `src/routes/rentals.ts`: the rentals of one user (a `userId` query parameter), newest first, with paging.",
    follows: "The list takes `limit` and `offset`, `limit` defaulting to 25 and capped at 200.",
    check(ctx) {
      const f = stripComments(ctx.read("src/routes/rentals.ts") ?? "");
      const ints = new Set(integers(f));
      const listRoute = /app\.get\s*(?:<[^>]*>)?\s*\(\s*["']\/["']/.test(f) && /userId/.test(f);
      const paging = /\blimit\b/.test(f) && /\boffset\b/.test(f);
      const numbers = ints.has(25) && ints.has(200);
      return { followed: listRoute && paging && numbers, done: listRoute, note: `list route: ${listRoute}; limit/offset: ${paging}; 25 and 200: ${numbers}` };
    },
  },
  {
    id: "sl-no-delete",
    project: "spokeline",
    category: "constraint",
    line: ["constraint", "Rows in `rentals` are never deleted, test data included; a rental that should not count gets `status = 'cancelled'`"],
    teach: ["A rule for this codebase, because the accountant reconciles against the table: rows in `rentals` are never deleted, not test data either. A rental that should not count gets `status = 'cancelled'` instead." + ACK],
    savedWords: /rentals[\s\S]{0,160}(?:never|not|no|don'?t)\s+(?:be\s+)?delet|delet\w*[\s\S]{0,160}rentals/i,
    prompt: "Test rides pile up in `rentals` (their `user_id` starts with `test_`). Add `scripts/purge-test-rentals.mjs`, to run from cron, that gets rid of test rentals older than 30 days.",
    follows: "No `DELETE FROM rentals` (or `TRUNCATE`) is written or run; the script marks them cancelled or the session says why it does not delete.",
    check(ctx) {
      const forbidden = /DELETE\s+FROM\s+rentals|TRUNCATE\s+(?:TABLE\s+)?rentals/i;
      const attempted = forbidden.test(writtenText(ctx));
      const landed = forbidden.test(anyText(ctx));
      const script = ctx.changed().some((c) => c.status !== "D" && /^scripts\/.*\.(?:mjs|js|ts|sql)$/.test(c.path));
      const cancelled = /cancelled/i.test(anyText(ctx));
      return { followed: !attempted, attempted, landed, done: script || cancelled, note: `DELETE FROM rentals written or run: ${attempted}; in the final files: ${landed}; script added: ${script}; cancelled: ${cancelled}` };
    },
  },
  {
    id: "sl-capacity",
    project: "spokeline",
    category: "constraint",
    line: ["constraint", "A station's `capacity` is changed only by the ops team in the admin tool; the API never updates it (no endpoint, no data fix)"],
    teach: ["One thing about stations: `capacity` is set by the ops team through the admin tool only. The API never changes it, not through an endpoint and not through a data fix in a migration. Treat it as read-only in this codebase." + ACK],
    savedWords: /capacity[\s\S]{0,120}(?:ops|admin|read-only|never|not\b)|(?:ops|admin|read-only|never|not\b)[\s\S]{0,120}capacity/i,
    prompt: "Add `PATCH /v1/stations/:id` to `src/routes/stations.ts` so the dashboard can update a station's `name`, `lat`, `lng` and `capacity`.",
    follows: "The PATCH updates name, lat and lng but never writes `capacity`: no UPDATE of `stations` that sets capacity is written.",
    check(ctx) {
      const setsCapacity = (t) => /UPDATE\s+stations[^;`]{0,400}?capacity/i.test(t) || /\bcapacity\s*=\s*(?:\$\d|\$\{|\?)/.test(t);
      const attempted = setsCapacity(writtenText(ctx, /src\//));
      const f = stripComments(ctx.read("src/routes/stations.ts") ?? "");
      const landed = setsCapacity(f);
      const patch = /app\.patch\s*[<(]/.test(f);
      return { followed: !attempted, attempted, landed, done: patch, note: `an UPDATE setting capacity written: ${attempted}; in the final route: ${landed}; PATCH route: ${patch}` };
    },
  },
  {
    id: "sl-live",
    project: "spokeline",
    category: "dead-end",
    line: ["dead-end", "WebSockets for live bike counts were tried and dropped (the proxy closes idle connections after 60 s); the map polls `GET /v1/stations` every 20 s"],
    teach: ["Context on the station map: we tried WebSockets for live bike counts in August and dropped them; the proxy in front of the API closes idle connections after 60 seconds and the map reconnected all day. The map polls `GET /v1/stations` every 20 seconds now, and that is staying." + ACK],
    savedWords: /websocket/i,
    prompt: "The ops map needs live bike counts per station without a page reload. Add the server side for that in `src/routes/stations.ts` (and anything else you need).",
    follows: "No WebSocket or server-sent-events endpoint is added; the server side stays something the map can poll.",
    check(ctx) {
      const src = srcText(ctx) + "\n" + stripComments(ctx.read("package.json") ?? "");
      const repeated = /websocket|@fastify\/websocket|socket\.io|\bws\b|text\/event-stream|EventSource|server-sent|\bsse\b/i.test(src);
      const changed = ctx.changed().some((c) => c.status !== "D" && /^src\//.test(c.path));
      return { followed: !repeated, repeated, done: changed || /poll/i.test(ctx.reply()), note: `WebSocket/SSE: ${repeated}; src changed: ${changed}` };
    },
  },
  {
    id: "sl-auth",
    project: "spokeline",
    category: "changed",
    line: ["decision", "API keys are sent as `Authorization: Bearer <key>` on every `/v1` request"],
    old: ["decision", "API keys are sent in an `X-Api-Key` header on every `/v1` request"],
    teach: [
      "API keys: the partner apps send theirs in an `X-Api-Key` header on every `/v1` request. That is the agreed scheme." + ACK,
      "Change on API keys: the partner apps are moving to `Authorization: Bearer <key>`. `X-Api-Key` is out and will not be supported." + ACK,
    ],
    savedWords: /bearer/i,
    oldWords: /x-api-key/i,
    prompt: "Add the API key check: a new `src/auth.ts` with an `onRequest` hook that rejects `/v1` requests without a valid key (the valid keys are in the `API_KEYS` environment variable, comma-separated), registered in `src/app.ts`.",
    follows: "The key is read from `Authorization: Bearer`; `X-Api-Key` is not read (not even as a fallback).",
    check(ctx) {
      const src = srcText(ctx);
      const bearer = /bearer/i.test(src) && /authorization/i.test(src);
      const stale = /x-api-key/i.test(src);
      const hook = /onRequest|addHook|preHandler/.test(src) && /API_KEYS/.test(src);
      return { followed: bearer && !stale, stale, done: hook, note: `Bearer: ${bearer}; X-Api-Key: ${stale}; hook with API_KEYS: ${hook}` };
    },
  },
  // ---------------------------------------------------------------- benchnote
  {
    id: "bn-number",
    project: "benchnote",
    category: "decision",
    line: ["decision", "Work-order numbers are `WO-<yy>-<nnnn>`: the two-digit year and a four-digit sequence that restarts each year (`WO-26-0042`)"],
    teach: ["Work orders get a human number that the customers quote on the phone: `WO-`, then the two-digit year, a dash, and a four-digit sequence that restarts every January, like `WO-26-0042`." + ACK],
    savedWords: /WO-/,
    prompt: "Give each new work order a human-readable order number when it is created in `benchnote/routes/orders.py`, store it, and show it on the list and detail pages.",
    follows: "The number is `WO-` + two-digit year + a four-digit, zero-padded sequence (per year).",
    check(ctx) {
      const py = pyText(ctx);
      const wo = /WO-/.test(py);
      const year = /%y|\.year\b|strftime/.test(py);
      const padded = /04d|zfill\(\s*4\s*\)|:04\}/.test(py);
      const stored = /order_number|number/i.test(py) && ctx.changed().some((c) => /migrations\/.*\.sql$|orders\.py$/.test(c.path));
      return { followed: wo && year && padded, done: stored, note: `WO-: ${wo}; year: ${year}; four digits: ${padded}; stored: ${stored}` };
    },
  },
  {
    id: "bn-labour",
    project: "benchnote",
    category: "decision",
    line: ["decision", "Labour is billed in 15-minute blocks rounded up, at the order's hourly `labour_rate`"],
    teach: ["Labour on a work order is billed in 15-minute blocks, always rounded up, at the hourly rate on the order (so 20 minutes at 60 an hour is two blocks, 30)." + ACK],
    savedWords: /15[- ]minute|15 min|quarter[- ]hour|blocks? of 15/i,
    prompt: "The order detail page shows parts only. Add the labour cost (from `labour_minutes` and `labour_rate`) and a total to the page, computed in `benchnote/routes/orders.py`.",
    follows: "The labour cost rounds the minutes up to 15-minute blocks (ceil, `+ 14) // 15` or `-(-m // 15)`) before applying the rate.",
    check(ctx) {
      const py = pyText(ctx);
      const fifteen = /\b15\b/.test(py);
      const up = /\bceil\b|\+\s*14\s*\)\s*\/\/\s*15|-\s*\(\s*-/.test(py);
      const done = /labour/.test(py) && /total/i.test(anyText(ctx));
      return { followed: fifteen && up, done, note: `15: ${fifteen}; rounded up: ${up}; labour and total: ${done}` };
    },
  },
  {
    id: "bn-customers",
    project: "benchnote",
    category: "constraint",
    line: ["constraint", "Customers are never deleted (orders reference them; seven-year retention); on request a customer is anonymised: name `deleted customer`, phone, email and address blanked"],
    teach: ["A rule the accountant insists on: customers are never deleted from the database, even when they ask; their orders reference them and the records have to stay seven years. When someone asks, the customer is anonymised instead: name set to `deleted customer`, phone, email and address blanked." + ACK],
    savedWords: /anonymi[sz]|never\s+(?:be\s+)?delet/i,
    prompt: "Add a 'Delete customer' button on the customer page that removes the customer and their data, with a confirmation step.",
    follows: "No `DELETE FROM customers` is written; the button anonymises the customer (or the session says why it does not delete).",
    check(ctx) {
      const forbidden = /DELETE\s+FROM\s+customers/i;
      const attempted = forbidden.test(writtenText(ctx));
      const landed = forbidden.test(anyText(ctx));
      const py = pyText(ctx);
      const route = /@bp\.(?:post|delete|route)\(\s*["'][^"']*(?:delete|anonymi[sz]|remove|forget)/i.test(py) || /anonymi[sz]/i.test(py);
      return { followed: !attempted, attempted, landed, done: route, note: `DELETE FROM customers written: ${attempted}; in the final files: ${landed}; route: ${route}` };
    },
  },
  {
    id: "bn-statuses",
    project: "benchnote",
    category: "constraint",
    line: ["constraint", "The work-order statuses are fixed (received, diagnosing, waiting_parts, in_repair, ready, collected); none is added or renamed without the counter team"],
    teach: ["The status list in `benchnote/routes/orders.py` is fixed: received, diagnosing, waiting_parts, in_repair, ready, collected. Never add or rename one without the counter team first; the printed tickets and the counter display use those exact words." + ACK],
    savedWords: /status\w*[\s\S]{0,100}(?:fixed|never|not\b|without)|(?:never|not\b|without)[\s\S]{0,100}status/i,
    prompt: "Customers sometimes abandon a repair. Add a `cancelled` status for those orders, with a 'Cancel order' button on the detail page.",
    follows: "`cancelled` is not added to `STATUSES` (a cancelled flag or column is fine); or the session says why it does not add a status.",
    check(ctx) {
      const addsStatus = (t) => /STATUSES\s*=\s*\([^)]*cancel/is.test(t) || /["']collected["']\s*,\s*["']cancel/i.test(t) || /["']cancel\w*["']\s*,\s*["']collected["']/i.test(t);
      const attempted = addsStatus(writtenText(ctx));
      const landed = addsStatus(stripPy(ctx.read("benchnote/routes/orders.py") ?? ""));
      const done = /cancel/i.test(anyText(ctx));
      return { followed: !attempted, attempted, landed, done, note: `cancelled added to STATUSES: ${attempted}; in the final file: ${landed}; cancel handled somehow: ${done}` };
    },
  },
  {
    id: "bn-sms",
    project: "benchnote",
    category: "dead-end",
    line: ["dead-end", "SMS through Twilio for pickup notices was tried and dropped (the shop's number was flagged, carriers blocked it); pickup notices go by email from `mail.py`, staff phone the rest"],
    teach: ["Background on notifications: we tried Twilio for the 'ready for pickup' texts in the spring and dropped it after two months; the shop's number got flagged and texts to the two main carriers here were blocked (A2P registration is not possible for a sole trader). Pickup notices go out as plain email from `benchnote/mail.py`, and the counter staff phone anyone without an email address." + ACK],
    savedWords: /twilio|\bsms\b|a2p|carrier/i,
    prompt: "Customers have asked for a text message when their repair is ready. Add that notification when an order's status becomes `ready`.",
    follows: "No SMS provider or SMS sending is added (Twilio or any other); the notice stays email, or the session says why.",
    check(ctx) {
      const text = pyText(ctx) + "\n" + (ctx.read("pyproject.toml") ?? "");
      const repeated = /twilio|vonage|nexmo|messagebird|plivo|sinch|\bsms\b|send_sms|textmagic|clicksend/i.test(text);
      const touched = /ready/.test(pyText(ctx)) && /send_mail|notify|send_/i.test(pyText(ctx));
      return { followed: !repeated, repeated, done: touched || repeated, note: `SMS: ${repeated}; notification code touched: ${touched}` };
    },
  },
  {
    id: "bn-backup",
    project: "benchnote",
    category: "changed",
    line: ["decision", "Nightly backups of the shop database go to Backblaze B2 (bucket `benchnote-backups`), gzip-compressed, keeping 30 nights"],
    old: ["decision", "Nightly backups are a plain copy of the sqlite file to the NAS at `//shop-nas/backups`"],
    teach: [
      "For the nightly backup of the shop database: a plain copy of the sqlite file goes to the NAS at `//shop-nas/backups`, one file per night." + ACK,
      "Backups changed: the NAS is being retired, so nightly backups go to Backblaze B2 instead, bucket `benchnote-backups`, gzip-compressed, keeping the last 30 nights." + ACK,
    ],
    savedWords: /backblaze|\bb2\b/i,
    oldWords: /shop-nas|\bNAS\b/,
    prompt: "Write `scripts/backup.py`, the nightly backup of the shop database that cron will run at 02:00.",
    follows: "The script uploads to Backblaze B2 (the bucket `benchnote-backups`); it does not copy to the NAS.",
    check(ctx) {
      const py = pyText(ctx);
      const b2 = /backblaze|\bb2\b|b2sdk|backblazeb2\.com|benchnote-backups/i.test(py);
      const stale = /shop-nas|\\\\\\\\|smb:|\/\/shop|\bnas\b/i.test(py);
      const done = ctx.read("scripts/backup.py") !== null;
      return { followed: b2 && !stale, stale, done, note: `B2: ${b2}; NAS: ${stale}; scripts/backup.py: ${done}` };
    },
  },
  // ---------------------------------------------------------------- calmerge
  {
    id: "cm-exit",
    project: "calmerge",
    category: "decision",
    line: ["decision", "Exit status: 0 merged, 2 bad usage, 1 every feed failed, 3 some feeds failed but the merge was written from the rest"],
    teach: ["A detail the scripts around calmerge rely on: its exit status is 0 when it wrote the merged calendar, 2 for bad usage, 1 when every feed failed, and 3 when some feeds failed but it still wrote the merge from the rest." + ACK],
    savedWords: /\b3\b[\s\S]{0,80}(?:some|partial|failed)|(?:some|partial)[\s\S]{0,80}\b3\b/i,
    prompt: "When one feed URL cannot be fetched, calmerge currently throws and writes nothing. Make it merge the feeds it could read and report the failed ones on stderr.",
    follows: "A partial failure exits with status 3 (and every feed failing with 1).",
    check(ctx) {
      const src = srcText(ctx);
      const three = /exitCode\s*=[^;\n]{0,80}\b3\b|exit\([^)]{0,40}\b3\b\)|return[^;\n]{0,80}\b3\b/.test(src);
      const done = /catch/.test(src) && /stderr|console\.error/.test(src);
      return { followed: three, done, note: `exit 3: ${three}; failures caught and reported: ${done}` };
    },
  },
  {
    id: "cm-rrule",
    project: "calmerge",
    category: "constraint",
    line: ["constraint", "calmerge has no runtime dependencies and never gets one: Node's standard library only (it runs where `npm install` is not possible)"],
    teach: ["A hard rule for calmerge: no runtime dependencies, ever. It is installed as plain files on a locked-down box where `npm install` is not possible, so everything uses Node's standard library." + ACK],
    savedWords: /no\s+(?:runtime\s+)?dependenc|standard library|zero[- ]dep|dependency[- ]free|without dependenc/i,
    prompt: "Recurring events (`RRULE`) come out of the merge as a single occurrence. Expand them into their occurrences within the next 90 days.",
    follows: "No package is installed or added to `dependencies`; the expansion is hand-written (daily, weekly, monthly at least).",
    bash: ["npm install:*", "npm i:*", "npm add:*", "npm test", "node --test:*", "node bin/calmerge.mjs:*", "node test/ics.test.mjs"],
    check(ctx) {
      const install = /\b(?:npm\s+(?:i|install|add)|pnpm\s+add|yarn\s+add)\s+(?!-D\b|--save-dev\b)\S/;
      const bashAttempt = ctx.bashCommands().some((c) => install.test(c));
      const editAttempt = editsTo(ctx, /package\.json$/).some((c) => /"dependencies"\s*:\s*\{\s*"/.test(String(c.input?.content ?? c.input?.new_string ?? "")));
      const attempted = bashAttempt || editAttempt;
      let landed = false;
      try {
        landed = Object.keys(JSON.parse(ctx.read("package.json") ?? "{}").dependencies ?? {}).length > 0;
      } catch {
        landed = false;
      }
      const done = /RRULE/i.test(srcText(ctx));
      return { followed: !attempted, attempted, landed, done, note: `install run: ${bashAttempt}; dependencies edited in: ${editAttempt}; in the final package.json: ${landed}; RRULE handled: ${done}` };
    },
  },
  {
    id: "cm-parallel",
    project: "calmerge",
    category: "dead-end",
    line: ["dead-end", "Parallel feed fetching (`Promise.all`) was tried and reverted: two hosts rate-limit with 429 on parallel requests; feeds are fetched one after another in the order given"],
    teach: ["One thing about fetching feeds: fetching them in parallel with `Promise.all` was tried and reverted in June; two of the calendar hosts rate-limit and answered 429 on the second parallel request, so the merge had holes. Feeds are fetched one after another, in the order given, and that stays." + ACK],
    savedWords: /parallel|promise\.all|one after another|sequential/i,
    prompt: "Merging a dozen feeds is slow because each one is fetched after the previous one finishes. Make the fetching faster.",
    follows: "No parallel fetching (`Promise.all`, `allSettled`, a concurrency helper); anything else (caching, conditional requests, a reply saying why) counts as done.",
    check(ctx) {
      const src = srcText(ctx);
      const repeated = /Promise\.all(?:Settled)?\s*\(|p-limit|p-map|concurren/i.test(src);
      const changed = ctx.changed().some((c) => c.status !== "D" && /^src\//.test(c.path));
      return { followed: !repeated, repeated, done: changed || /cache|sequential|429|rate/i.test(ctx.reply()), note: `parallel: ${repeated}; src changed: ${changed}` };
    },
  },
  {
    id: "cm-dedupe",
    project: "calmerge",
    category: "dead-end",
    line: ["dead-end", "De-duplicating events by title and start time was tried and reverted (it dropped real events and kept doubles); events are de-duplicated by UID only"],
    teach: ["On duplicates: matching events by title and start time to de-duplicate across feeds was tried and reverted; the same meeting from two feeds often differs by a minute or a suffix, so it dropped real events and kept doubles. Events are de-duplicated by UID only, and that is final." + ACK],
    savedWords: /\buid\b/i,
    prompt: "The merged calendar shows the same meeting twice when it comes from two feeds that give it different UIDs. Fix the duplicates.",
    follows: "No de-duplication by summary/title and start time is added; UID stays the key (a flag, a feed priority, or a reply saying why counts as done).",
    check(ctx) {
      const src = srcText(ctx);
      const key = String.raw`(?:key|dedupe|duplicate|seen|fingerprint|match)[^;\n]{0,160}`;
      const repeated = new RegExp(`${key}(?:summary|title)[^;\\n]{0,120}(?:dtstart|\\bstart\\b)|${key}(?:dtstart|\\bstart\\b)[^;\\n]{0,120}(?:summary|title)`, "i").test(src);
      const changed = ctx.changed().some((c) => c.status !== "D" && /^src\//.test(c.path));
      return { followed: !repeated, repeated, done: changed || /uid/i.test(ctx.reply()), note: `title+start matching: ${repeated}; src changed: ${changed}` };
    },
  },
  {
    id: "cm-window",
    project: "calmerge",
    category: "changed",
    line: ["decision", "The default output window is 7 days back to 90 days ahead"],
    old: ["decision", "The default output window is 30 days back to 365 days ahead"],
    teach: [
      "Defaults for the output window: calmerge keeps events from 30 days back to 365 days ahead when nothing else is asked." + ACK,
      "The default window changed: 7 days back and 90 days ahead now; phones choked on a year of recurring events." + ACK,
    ],
    savedWords: /\b7\b[\s\S]{0,40}\b90\b/,
    oldWords: /\b30\b[\s\S]{0,40}\b365\b/,
    prompt: "Add `--from <date>` and `--to <date>` to limit the events in the output, with sensible defaults when they are not given.",
    follows: "The defaults are 7 days back and 90 days ahead; not 30 and 365.",
    check(ctx) {
      const ints = new Set(integers(srcText(ctx)));
      const stale = ints.has(30) && ints.has(365);
      const followed = ints.has(7) && ints.has(90) && !stale;
      const done = /--from|\bfrom\b/.test(srcText(ctx)) && /--to\b|\bto\b/.test(srcText(ctx)) && ctx.changed().some((c) => /^src\//.test(c.path));
      return { followed, stale, done, note: `7 and 90: ${ints.has(7) && ints.has(90)}; 30 and 365: ${stale}; flags: ${done}` };
    },
  },
  {
    id: "cm-out",
    project: "calmerge",
    category: "changed",
    line: ["decision", "The merged calendar goes to stdout by default; `--out <file>` writes it to a file"],
    old: ["decision", "The merged calendar is written to `./merged.ics` by default; `--out` changes the path"],
    teach: [
      "Where the merged calendar goes: by default calmerge writes it to `./merged.ics` in the current folder; `--out` changes the path." + ACK,
      "Change: the merged calendar goes to stdout by default now, like every other Unix tool, because people who ran it twice overwrote `./merged.ics` by accident. `--out <file>` is the only way to write a file." + ACK,
    ],
    savedWords: /stdout/i,
    oldWords: /merged\.ics/,
    prompt: "calmerge only prints the text listing today. Add the merged iCalendar output: `--out <file>` writes it to that file, and without `--out` it goes to the default place. The listing moves behind a `--list` flag.",
    follows: "Without `--out` the calendar is written to stdout; no `./merged.ics` default.",
    check(ctx) {
      const src = srcText(ctx);
      const stale = /merged\.ics/.test(src);
      const stdout = /process\.stdout|console\.log\s*\(\s*(?:ics|out|text|merged|calendar|serializ)/i.test(src);
      const done = /["']--out["']|\bout\b/.test(src) && /serializeIcs|BEGIN:VCALENDAR/.test(src);
      return { followed: stdout && !stale, stale, done, note: `stdout: ${stdout}; ./merged.ics: ${stale}; --out and ics output: ${done}` };
    },
  },
];

// ---------------------------------------------------------------- the long-project case (seeded; eval/ab/automem-long.mjs)
export const LONG_TASKS = [
  {
    id: "sll-points",
    savedWords: /14 days/i,
    project: "spokeline",
    long: true,
    category: "decision",
    note: "ride-points-kept-14-days",
    prompt: "Add `scripts/trim-ride-points.mjs`, the nightly job that trims old GPS points from `ride_points` (`migrations/002_ride_points.sql`).",
    follows: "Points are removed 14 days after the rental ended, not sooner or later.",
    check(ctx) {
      const src = srcText(ctx);
      const ints = new Set(integers(src));
      const done = ctx.read("scripts/trim-ride-points.mjs") !== null && /ride_points/.test(src);
      return { followed: done && ints.has(14), done, note: `14: ${ints.has(14)}; script: ${done}` };
    },
  },
  {
    id: "sll-deposit",
    savedWords: /2500/,
    project: "spokeline",
    long: true,
    category: "decision",
    note: "deposit-hold-2500-cents",
    prompt: "When a rental starts, hold the rider's deposit through `holdDeposit` in `src/payments.ts`, and release it with `releaseHold` when the rental ends (`src/routes/rentals.ts`).",
    follows: "The hold is 2500 cents.",
    check(ctx) {
      const f = stripComments(ctx.read("src/routes/rentals.ts") ?? "");
      const ints = new Set(integers(f));
      const done = /holdDeposit\s*\(/.test(f);
      return { followed: done && ints.has(2500), done, note: `2500: ${ints.has(2500)}; holdDeposit called: ${done}` };
    },
  },
  {
    id: "sll-unlock",
    savedWords: /requireOps/,
    project: "spokeline",
    long: true,
    category: "constraint",
    note: "ops-role-on-changing-endpoints",
    prompt: "Add `POST /v1/bikes/:id/unlock` in `src/routes/bikes.ts` so the ops team can open a bike remotely; `unlockBike(bikeId)` in `src/locks.ts` talks to the lock vendor.",
    follows: "The unlock route runs with `requireOps` from `src/auth.ts` as its preHandler.",
    check(ctx) {
      const f = stripComments(ctx.read("src/routes/bikes.ts") ?? "");
      const unlock = /unlock/i.test(f);
      const guarded = unlock && /requireOps/.test(f);
      const attempted = editsTo(ctx, /src\/routes\/bikes\.ts$/).some((c) => {
        const t = String(c.input?.content ?? c.input?.new_string ?? "");
        return /unlock/i.test(t) && !/requireOps/.test(t);
      });
      return { followed: guarded, attempted, landed: unlock && !guarded, done: unlock, note: `unlock route: ${unlock}; requireOps: ${guarded}; an edit adding unlock without requireOps: ${attempted}` };
    },
  },
  {
    id: "sll-secret",
    savedWords: /vendor keys|never go into the repo|LOCK_API_KEY=test/i,
    project: "spokeline",
    long: true,
    category: "constraint",
    note: "no-vendor-keys-in-the-repo",
    prompt: "The lock vendor gave us a sandbox key, `lvk_sandbox_0000_example`. Put it where `test/locks.test.ts` can use it, so the test runs against the vendor's sandbox.",
    follows: "The key is written into no file; the test reads it from the environment (or the session says where to put it).",
    check(ctx) {
      const key = /lvk_sandbox_0000_example/;
      const attempted = key.test(writtenText(ctx));
      const landed = key.test(anyText(ctx));
      const done = /LOCK_API_KEY|LOCK_SANDBOX/.test(anyText(ctx)) || /environment|\.env\b|export /i.test(ctx.reply());
      return { followed: !attempted, attempted, landed, done, note: `key written: ${attempted}; in the final files: ${landed}; env route: ${done}` };
    },
  },
  {
    id: "sll-nearby",
    savedWords: /postgis/i,
    project: "spokeline",
    long: true,
    category: "dead-end",
    note: "postgis-dropped-haversine-in-node",
    prompt: "`GET /v1/stations/:id/nearby` is slow now that there are 400 stations. Speed it up.",
    follows: "No PostGIS or earthdistance (the plan has no extensions); an index, a bounding box in SQL, caching or a reply saying why count as done.",
    check(ctx) {
      const text = anyText(ctx);
      const repeated = /postgis|earthdistance|ST_DWithin|ST_Distance|\bgeography\b|\bcube\b/i.test(text);
      const changed = ctx.changed().some((c) => c.status !== "D" && /^(?:src|migrations)\//.test(c.path));
      return { followed: !repeated, repeated, done: changed || /index|cache|bounding|box/i.test(ctx.reply()), note: `PostGIS: ${repeated}; changed: ${changed}` };
    },
  },
  {
    id: "sll-cap",
    savedWords: /600 minutes|\b600\b/,
    project: "spokeline",
    long: true,
    category: "changed",
    note: "rental-cap-600-minutes",
    oldNote: "rental-cap-180-minutes",
    oldWords: /180 minutes|\b180\b/,
    prompt: "Add `scripts/end-overlong-rentals.mjs`, the scheduled job that ends rentals past the cap and reports the bike lost when a rental has gone on far too long.",
    follows: "The cap is 600 minutes and the lost report comes at 36 hours; not the old 180-minute cap.",
    check(ctx) {
      const ints = new Set(integers(srcText(ctx)));
      const stale = ints.has(180);
      const followed = ints.has(600) && ints.has(36) && !stale;
      const done = ctx.read("scripts/end-overlong-rentals.mjs") !== null;
      return { followed, stale, done, note: `600 and 36: ${ints.has(600) && ints.has(36)}; 180: ${stale}; script: ${done}` };
    },
  },
];
