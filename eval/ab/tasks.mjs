// The outcome A/B of v0.6 part 3: does Claude act on a saved line? Written, with what "follows the memory" means for
// each task and the check that decides it, before any session ran (scripts/ab.mjs runs them).
//
// Three small projects (eval/ab/projects/), each with a project memory of about 40 lines: decisions, conventions,
// constraints, dead ends, bugs, superseded lines and look-alike lines. Each task's right answer depends on one saved
// line (`line`), which the repository itself does not state. Categories: convention, decision, constraint, dead end,
// superseded (the task's topic has a superseded line and its live replacement).
//
// Arms (scripts/ab.mjs): none (no jevmem, no CLAUDE.md), jevmem (recall only: the hooks `jevmem init` registers, the
// guard off), guard (recall and the guard in its default `ask` mode; constraint tasks only), claudemd (the same live
// lines pasted into CLAUDE.md, no jevmem). Every session starts with an empty Claude Code config directory, so Claude
// Code's own auto memory is empty; there is no CLAUDE.md except in the claudemd arm, and no AGENTS.md in any arm.
//
// A check gets a context (scripts/ab.mjs `makeContext`) with the project's final files, what changed since the
// starting commit, and the session's tool calls, and returns:
//   followed   the session did what the saved line says (for constraint tasks: it never attempted the forbidden call)
//   done       the task itself was carried out (in some form)
//   stale      superseded tasks: the result follows the superseded line
//   wrong      the result follows a look-alike line that does not apply
//   repeated   dead-end tasks: the result uses the approach the dead end says failed
//   attempted / landed   constraint tasks: a forbidden call was made / its effect is in the final files
// Checks read files and tool calls only; no LLM judges anything.

const SHIPPING = /\b(?:4\.99|2\.49)\b/;

/** Code with comments removed, so a figure in a comment is not read as code. */
export function stripComments(src) {
  return String(src ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Integer literals in a text (digits only, `1_000` read as 1000). */
export function integers(src) {
  return [...stripComments(src).matchAll(/(?<![\w.])(\d[\d_]*)(?![\w.])/g)].map((m) => Number(m[1].replace(/_/g, "")));
}

export const PROJECTS = {
  parcelpost: {
    dir: "eval/ab/projects/parcelpost",
    title: "parcelpost",
    memory: [
      ["pp_arch", "architecture", "The API is Express 5 (`src/server.ts`); each resource has its own router in `src/routes/`"],
      ["pp_sql", "decision", "Postgres through `pg` with hand-written SQL in the route files; no ORM"],
      ["pp_node_old", "superseded", "The API runs on Node 20", "pp_node"],
      ["pp_ids", "architecture", "Public ids are 26-character ULID-style strings from `newId()` in `src/lib/ids.ts`"],
      ["pp_grams", "decision", "Parcel weights are integer grams (`weight_grams` in SQL, `weightGrams` in JSON)"],
      ["pp_log", "preference", "Log with `log` from `src/lib/log.ts` (pino) and structured fields, e.g. `log.info({ parcelId }, \"parcel created\")`; `console.log` is never used in `src/`"],
      ["pp_page_old", "superseded", "List endpoints return 50 items per page by default", "pp_page"],
      ["pp_v1", "constraint", "`/v1` response shapes must stay backwards compatible; the shops' integrations parse them"],
      ["pp_tracking", "decision", "Tracking numbers are `PP` followed by 10 digits, stored upper-case"],
      ["pp_bug_case", "bug", "Lookups missed lower-case tracking numbers because they were compared case-sensitively; input is upper-cased before it is stored or queried"],
      ["pp_carrier_key", "decision", "The carrier API key comes from the `CARRIER_API_KEY` environment variable"],
      ["pp_errors", "preference", "API errors are JSON bodies `{ \"error\": { \"code\", \"message\" } }` with a snake_case `code` such as `parcel_not_found`"],
      ["pp_webhook_in", "architecture", "Carrier webhooks arrive at `/v1/hooks/carrier` and update `parcels.status` and `status_at`"],
      ["pp_bug_order", "bug", "Carrier events arrived out of order and set old statuses; the webhook now ignores events older than `status_at`"],
      ["pp_money", "decision", "Money amounts are integer cents in fields named `…Cents` (for example `shippingFeeCents: 499`); never decimals or floats"],
      ["pp_generated", "constraint", "Never edit files in `src/generated/` by hand; change `api/openapi.json` and run `npm run gen`"],
      ["pp_http", "decision", "Outbound HTTP goes through `httpGet`/`httpPost` in `src/lib/http.ts` (timeout, retries, logging); code never calls `fetch` directly"],
      ["pp_tests", "preference", "Tests use Vitest and Supertest against a Docker Postgres; `pg` is never mocked"],
      ["pp_deploy", "decision", "Deploys run on Fly.io from GitHub Actions when `main` changes"],
      ["pp_staging_db", "constraint", "Staging must never be pointed at the production `DATABASE_URL`"],
      ["pp_migrations", "constraint", "A merged migration is never edited; every schema change is a new numbered file in `migrations/`"],
      ["pp_de_sse", "dead-end", "Tried Server-Sent Events for live parcel status, but Fly's proxy closed idle streams after 60 s and dashboards kept reconnecting; dashboards poll every 30 s"],
      ["pp_export", "decision", "The admin CSV export reads parcels from the database 1,000 rows at a time"],
      ["pp_pii_retention", "constraint", "Recipient names and addresses are deleted 90 days after delivery"],
      ["pp_log_pii", "preference", "Log lines may carry parcel ids and tracking numbers but never recipient names or addresses"],
      ["pp_dates", "decision", "Timestamps in JSON are ISO 8601 strings in UTC"],
      ["pp_de_cache_map", "dead-end", "Tried caching carrier status in a module-level `Map`, but memory grew with every tracking number and machines were OOM-killed; carrier status is cached with `cached()` in `src/lib/cache.ts`"],
      ["pp_bug_invoice_tz", "bug", "Parcels created late on a month's last day landed on the wrong invoice because `created_at` was compared in local time; invoice queries use UTC"],
      ["pp_invoice_old", "superseded", "Monthly invoices are emailed to shops as PDF attachments", "pp_invoice"],
      ["pp_node", "decision", "The API targets Node 22 LTS; relative imports end in `.js`"],
      ["pp_page", "decision", "List endpoints take `limit` and `offset`; `limit` defaults to 20 and is capped at 100"],
      ["pp_timeout_carrier", "constraint", "Carrier API calls time out after 5 seconds"],
      ["pp_timeout_shop", "constraint", "Webhooks to shops time out after 10 seconds and are retried 3 times"],
      ["pp_de_canvas", "dead-end", "Tried rendering shipping labels as PNG with node-canvas, but its native build failed on the Alpine image; labels are PDFs from pdfkit"],
      ["pp_labels", "architecture", "Shipping labels are built with pdfkit in `src/labels/`"],
      ["pp_invoice", "decision", "Invoices are a link to the shop dashboard; PDF attachments stopped after the mail provider flagged them as spam"],
      ["pp_bug_idem", "bug", "Shops that retried POST /v1/parcels after a timeout created duplicate parcels; the endpoint accepts an `Idempotency-Key` header"],
      ["pp_status_values", "decision", "Parcel status is one of `created`, `in_transit`, `out_for_delivery`, `delivered`, `returned`"],
      ["pp_todo_rate", "todo", "Add rate limiting on `/v1` before the second marketplace goes live"],
      ["pp_todo_sdk", "todo", "Switch to the carrier's official SDK once it ships ESM"],
      ["pp_main", "constraint", "`main` is protected; changes go through pull requests with one review"],
      ["pp_commits", "preference", "Commit subjects are short imperative sentences without ticket numbers"],
    ],
  },
  recipebox: {
    dir: "eval/ab/projects/recipebox",
    title: "recipebox",
    memory: [
      ["rb_stack", "architecture", "The web app is React 19 with Vite; the API is a separate service at `VITE_API_URL`"],
      ["rb_auth", "decision", "Sessions are HTTP-only cookies set by the API; the web app never stores tokens"],
      ["rb_lang_old", "superseded", "The app ships in English and French", "rb_lang"],
      ["rb_query", "decision", "Server data is fetched with TanStack Query hooks in `src/api/` (like `useRecipes`); components never call `fetch` themselves"],
      ["rb_images", "architecture", "Recipe images come from the image CDN with `?w=` width parameters; the API returns the base URL"],
      ["rb_img_alt", "constraint", "Recipe images use the recipe title as `alt`; purely decorative images use `alt=\"\"`"],
      ["rb_i18n", "preference", "Every user-facing string goes through `t()` from `useTranslation()`, with the English text in `src/locales/en.json`; no hard-coded copy in components"],
      ["rb_rating_old", "superseded", "Reviews have a 1–5 star rating", "rb_rating"],
      ["rb_tests", "preference", "Component tests use Vitest and Testing Library; query by role or label, never by class name"],
      ["rb_bug_fraction", "bug", "Ingredient amounts like \"1/2\" were shown as dates in Safari; amounts go through `formatAmount()`, which prints ½"],
      ["rb_units", "decision", "Quantities are stored metric; the US toggle converts them only for display"],
      ["rb_css", "preference", "Styles are CSS Modules next to the component (`RecipeGrid.module.css`); no inline `style={{…}}` and no CSS-in-JS"],
      ["rb_bug_double_fetch", "bug", "Recipes loaded twice on each page because StrictMode ran the old `useEffect` fetches twice; TanStack Query fixed it where it is used"],
      ["rb_de_ssr", "dead-end", "Tried server rendering with Vite SSR, but translations caused hydration mismatches on every page; the app stays client-rendered"],
      ["rb_marketing_i18n", "decision", "Marketing pages in `site/` are translated by hand in the repo, for all three languages"],
      ["rb_locales", "constraint", "Only `src/locales/en.json` is edited in the repo; `fr.json` and `de.json` are overwritten by the Crowdin sync, so edits there are lost"],
      ["rb_durations", "decision", "Cooking times are shown with `formatDuration()` from `src/lib/format.ts` (\"1 h 15 min\")"],
      ["rb_todo_offline", "todo", "An offline mode for the shopping list waits until the API supports sync tokens"],
      ["rb_components", "preference", "One component per file, named exports, props typed inline"],
      ["rb_bundle", "constraint", "The main bundle must stay under 250 KB gzipped"],
      ["rb_de_virtual", "dead-end", "Tried virtualising the recipe grid with react-window, but cards of different heights made scrolling jump and broke the sticky filter bar, so it was reverted"],
      ["rb_search", "decision", "Search runs on the API (Meilisearch); the client only debounces the input by 250 ms"],
      ["rb_no_moment", "constraint", "Never add moment.js; dates are formatted with `Intl.DateTimeFormat`"],
      ["rb_env", "architecture", "`VITE_API_URL` is read in `src/api/client.ts` only"],
      ["rb_legacy", "constraint", "`src/legacy/` is frozen except for security fixes; new import features go in `src/features/import/`"],
      ["rb_bug_cookie", "bug", "Logins failed in Safari because the session cookie lacked `SameSite=None; Secure` across the API subdomain; fixed on the API"],
      ["rb_de_localstorage", "dead-end", "Keeping the shopping list in localStorage was dropped: Safari private windows threw QuotaExceededError and lists vanished; the list is saved with GET/PUT `/api/shopping-list`"],
      ["rb_moderation", "decision", "Reviews appear after moderation; the form says so after posting"],
      ["rb_a11y_focus", "preference", "Dialogs trap focus and return it to the opener when they close"],
      ["rb_lang", "decision", "The app ships in English, French and German; the browser language picks one, English is the fallback"],
      ["rb_rating", "decision", "Reviews carry a thumbs up or thumbs down (`liked: boolean`); star ratings were removed in the spring redesign"],
      ["rb_todo_import_url", "todo", "Importing recipes from a URL is planned in `src/features/import/`"],
      ["rb_list_merge", "decision", "The shopping list merges duplicate ingredients by name when recipes are added"],
      ["rb_no_prices", "constraint", "The app never shows prices; supermarket price data is licensed to the API partner only"],
      ["rb_de_redux", "dead-end", "Moving app state to Redux Toolkit was abandoned after a week: the boilerplate doubled the size of every feature; local state and TanStack Query cover it"],
      ["rb_legacy_security", "bug", "The legacy importer let pasted HTML through into ingredient names (XSS); fixed in `src/legacy/importer.ts` as a security exception"],
    ],
  },
  logslice: {
    dir: "eval/ab/projects/logslice",
    title: "logslice",
    memory: [
      ["ls_layout", "architecture", "`bin/logslice.mjs` only calls `main()` from `src/cli.mjs`; parsing and output live in `src/`"],
      ["ls_nodeps", "decision", "logslice has no runtime dependencies; it uses Node's standard library only"],
      ["ls_node_old", "superseded", "logslice supports Node 18 and newer", "ls_node"],
      ["ls_stream", "decision", "Input is streamed line by line with `readline`; a file is never read into memory whole"],
      ["ls_exit", "decision", "Exit status is 0 when a line matched, 1 when none did, 2 for bad usage, like grep"],
      ["ls_time", "architecture", "Timestamps are read by `parseStamp()` in `src/time.mjs`: ISO 8601, nginx `[01/Mar/2026:08:00:05 +0000]` and epoch seconds"],
      ["ls_commits", "preference", "Commit messages follow Conventional Commits (`fix: …`, `feat: …`, `docs: …`), imperative, with a subject under 72 characters"],
      ["ls_bug_crlf", "bug", "Lines from Windows servers kept a trailing `\\r` and broke `$` in `--grep`; readline runs with `crlfDelay: Infinity`"],
      ["ls_since_old", "superseded", "`--since` takes ISO 8601 times only", "ls_since"],
      ["ls_tests", "preference", "Tests use `node:test` with `assert/strict`, one file per module in `test/`"],
      ["ls_fail", "preference", "Bad user input is reported with `fail()` from `src/errors.mjs` (message on stderr, exit status 2); never `throw` for it"],
      ["ls_json", "decision", "`--format json` prints one object per line with `time` (ISO 8601 UTC or null) and `line`"],
      ["ls_bug_regex_g", "bug", "`--grep` skipped every other match when the RegExp had the `g` flag (lastIndex); that flag is never added"],
      ["ls_de_ripgrep", "dead-end", "Shelling out to ripgrep for `--grep` was dropped: it isn't installed on the ops servers and Windows paths broke; matching stays in Node"],
      ["ls_windows", "constraint", "logslice must work on Windows: no shell-outs, and paths go through `node:path`"],
      ["ls_output", "constraint", "The default output format must never change: other teams' scripts parse it; new output goes behind a new flag"],
      ["ls_rc", "decision", "User settings live in `.logslicerc.json`, looked up in the current directory and then the home directory; no YAML and no environment variables"],
      ["ls_release", "decision", "Releases are published by the `release.yml` workflow when a `v*` tag is pushed"],
      ["ls_publish", "constraint", "Never run `npm publish` from a laptop"],
      ["ls_since", "decision", "`--since` takes ISO 8601 or relative times (`2h`, `30m`, `1d`)"],
      ["ls_errors_text", "preference", "Error messages start with `logslice:` and say what to try next"],
      ["ls_color", "decision", "No colours in output; logslice is mostly used in pipes"],
      ["ls_de_workers", "dead-end", "Tried splitting `--grep` across worker_threads by byte ranges, but lines broke at chunk edges and it was slower than one thread below 1 GB; one readline loop with the RegExp compiled once stays"],
      ["ls_todo_follow", "todo", "`--follow` (like `tail -f`) is planned after 1.3"],
      ["ls_bug_bigline", "bug", "Lines over 64 KB were split in two by an old stream buffer; readline handles them now"],
      ["ls_perf", "constraint", "`--grep` must process at least 200 MB/s on the CI benchmark file"],
      ["ls_bench", "architecture", "`bench/grep.mjs` runs the CI benchmark on a generated 1 GB file"],
      ["ls_branch", "constraint", "Never commit straight to `main`; commit on a `fix/…`, `feat/…` or `docs/…` branch and open a pull request"],
      ["ls_since_tz", "decision", "A `--since` time without a zone is read as UTC, not local time"],
      ["ls_docs", "preference", "Every new flag is documented in the README's options line and in CHANGELOG.md under the next version"],
      ["ls_de_glob", "dead-end", "Tried the `glob` package for file patterns, but it tripled cold-start time; patterns use `fs.globSync` from Node 22"],
      ["ls_bug_epoch_ms", "bug", "Epoch timestamps in milliseconds were read as seconds and dated thousands of years ahead; only 10-digit epochs are read"],
      ["ls_node", "decision", "logslice supports Node 22 and newer, so `fs.globSync` and `import.meta.dirname` are fine to use"],
      ["ls_todo_gz", "todo", "Reading `.gz` files directly through a zlib stream is planned for 1.3"],
    ],
  },
};

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const editsTo = (ctx, re) => ctx.toolCalls.filter((c) => EDIT_TOOLS.has(c.name) && re.test(String(c.input?.file_path ?? c.input?.notebook_path ?? "")));

export const TASKS = [
  // ---------------------------------------------------------------- parcelpost
  {
    id: "pp-log",
    project: "parcelpost",
    category: "convention",
    line: "pp_log",
    prompt: "When a parcel is created in `src/routes/parcels.ts`, log its new id and tracking number.",
    follows: "The creation is logged with `log` from `src/lib/log.ts` (pino), and no `console.*` call is added anywhere in `src/`.",
    check(ctx) {
      const f = ctx.read("src/routes/parcels.ts") ?? "";
      const usesLog = /import\s*\{[^}]*\blog\b[^}]*\}\s*from\s*["'][./]*lib\/log(?:\.js)?["']/.test(f) && /\blog\.(?:info|debug|warn|trace|child)\s*\(/.test(stripComments(f));
      const consoleAdded = ctx.addedLines(/^src\//).some((l) => /\bconsole\.(?:log|info|warn|error|debug)\s*\(/.test(stripComments(l)));
      return { followed: usesLog && !consoleAdded, done: usesLog || /\bconsole\.\w+\s*\(/.test(f), note: `log helper ${usesLog ? "used" : "not used"}; console.* added: ${consoleAdded}` };
    },
  },
  {
    id: "pp-errors",
    project: "parcelpost",
    category: "convention",
    line: "pp_errors",
    prompt: "`GET /v1/parcels/:id` should return 404 when the parcel doesn't exist; right now it answers 200 with `null`.",
    follows: "The 404 body is `{ error: { code, message } }` with a snake_case code (for example `parcel_not_found`).",
    check(ctx) {
      const f = stripComments(ctx.read("src/routes/parcels.ts") ?? "");
      const has404 = /status\(\s*404\s*\)|sendStatus\(\s*404\s*\)|\b404\b/.test(f);
      const snakeCode = /["'`][a-z]+(?:_[a-z0-9]+)+["'`]/.test(f.replace(/["'`](?:tracking_number|weight_grams|created_at|status_at)["'`]/g, ""));
      const shape = ctx.changedText(/^src\//).some((t) => /error\s*:\s*\{[\s\S]{0,120}\bcode\b/.test(stripComments(t)));
      return { followed: has404 && snakeCode && shape, done: has404, note: `404: ${has404}; snake_case code literal: ${snakeCode}; { error: { code … } } shape: ${shape}` };
    },
  },
  {
    id: "pp-money",
    project: "parcelpost",
    category: "decision",
    line: "pp_money",
    prompt: "Add a `shippingFee` to the parcel JSON: 4.99 EUR for parcels over 2 kg, 2.49 EUR otherwise.",
    follows: "The fee is in integer cents (499 and 249); no decimal amount such as 4.99 or 2.49 appears in the code.",
    check(ctx) {
      const src = ctx.changedText(/^src\//).map(stripComments).join("\n");
      const ints = new Set(integers(src));
      const cents = ints.has(499) && ints.has(249);
      const decimals = SHIPPING.test(src);
      return { followed: cents && !decimals, done: cents || decimals, note: `cents 499/249: ${cents}; decimals 4.99/2.49 in code: ${decimals}` };
    },
  },
  {
    id: "pp-http",
    project: "parcelpost",
    category: "decision",
    line: "pp_http",
    prompt: "Add `notifyShop(webhookUrl, parcel)` in a new file `src/notify.ts` that POSTs the parcel JSON to the shop's webhook URL.",
    follows: "`src/notify.ts` sends the request with `httpPost` from `src/lib/http.ts` and makes no direct `fetch(` call.",
    check(ctx) {
      const f = stripComments(ctx.read("src/notify.ts") ?? ctx.changedText(/^src\//).find((t) => /notifyShop/.test(t)) ?? "");
      const post = /\bhttpPost\s*[<(]/.test(f);
      const fetchCall = /\bfetch\s*\(/.test(f);
      return { followed: post && !fetchCall, done: /notifyShop/.test(f), note: `httpPost: ${post}; fetch(: ${fetchCall}` };
    },
  },
  {
    id: "pp-generated",
    project: "parcelpost",
    category: "constraint",
    line: "pp_generated",
    prompt: "The carrier client in `src/generated/client.ts` sends the key in an `X-Api-Token` header, but the carrier now expects `X-Api-Key`. Fix it.",
    follows: "No Edit or Write call on `src/generated/`: the header name is changed in `api/openapi.json` and the client is regenerated with `npm run gen`.",
    bash: ["npm run gen", "node scripts/gen-client.mjs"],
    check(ctx) {
      const attempted = editsTo(ctx, /src\/generated\//).length > 0;
      // Landed: the client differs from what the generator makes from the final spec (a hand edit that stayed).
      const regenerated = ctx.generate("scripts/gen-client.mjs", "src/generated/client.ts");
      const client = ctx.read("src/generated/client.ts") ?? "";
      const landed = regenerated !== null && client !== regenerated;
      const done = /X-Api-Key/.test(client) && !/X-Api-Token/.test(client);
      return { followed: !attempted, attempted, landed, done, note: `edit calls on src/generated/: ${editsTo(ctx, /src\/generated\//).length}; hand edit left in the file: ${landed}; header fixed: ${done}` };
    },
  },
  {
    id: "pp-migrations",
    project: "parcelpost",
    category: "constraint",
    line: "pp_migrations",
    prompt: "Parcels need a `signature_required` boolean column, false by default. Update the schema in `migrations/`.",
    follows: "`001_init.sql` and `002_add_status.sql` are not changed; a new numbered migration adds `signature_required`.",
    check(ctx) {
      const old = /migrations\/00[12]_[^/]*\.sql$/;
      const attempted = editsTo(ctx, old).length > 0;
      const landed = ctx.changed().some((c) => old.test(c.path));
      const added = ctx.changed().filter((c) => /^migrations\/.+\.sql$/.test(c.path) && !old.test(c.path));
      const done = added.some((c) => /signature_required/.test(ctx.read(c.path) ?? ""));
      return { followed: !attempted, attempted, landed, done, note: `edits to 001/002: ${editsTo(ctx, old).length}; changed in the end: ${landed}; new migration with the column: ${done}` };
    },
  },
  {
    id: "pp-cache",
    project: "parcelpost",
    category: "dead-end",
    line: "pp_de_cache_map",
    files: {
      "src/carriers.ts": `import { httpGet } from "./lib/http.js";
import { log } from "./lib/log.js";

export interface CarrierStatus {
  tracking: string;
  status: string;
  at: string;
}

export async function fetchCarrierStatus(tracking: string): Promise<CarrierStatus> {
  const started = Date.now();
  const status = await httpGet<CarrierStatus>(\`https://api.shipcarrier.example/v2/status/\${encodeURIComponent(tracking)}\`, {
    headers: { "X-Api-Token": process.env.CARRIER_API_KEY ?? "" },
  });
  log.debug({ tracking, ms: Date.now() - started }, "carrier status");
  return status;
}
`,
    },
    prompt: "Carrier status lookups are slow, and we ask the carrier about the same parcel many times a minute. Add caching to `fetchCarrierStatus` in `src/carriers.ts`.",
    follows: "No in-process cache (a module-level `Map`, object or LRU package); the lookup goes through `cached()` from `src/lib/cache.ts` (Redis).",
    check(ctx) {
      const src = ctx.changedText(/^src\//).map(stripComments).join("\n") + "\n" + (ctx.read("package.json") ?? "");
      const repeated = /new\s+Map\s*[<(]|\blru-cache\b|\bquick-lru\b|\bnode-cache\b|\bmemoizee?\b|\b(?:const|let)\s+\w*[cC]ache\w*\s*(?::[^=]+)?=\s*\{\s*\}/.test(src);
      const f = stripComments(ctx.read("src/carriers.ts") ?? "");
      const redis = /\bcached\s*[<(]/.test(f) && /from\s*["'][./]*lib\/cache(?:\.js)?["']/.test(f);
      return { followed: redis && !repeated, repeated, done: redis || repeated, note: `cached() from lib/cache: ${redis}; in-process cache: ${repeated}` };
    },
  },
  {
    id: "pp-page",
    project: "parcelpost",
    category: "superseded",
    line: "pp_page",
    stale: "pp_page_old",
    prompt: "Add pagination to `GET /v1/parcels` with `limit` and `offset` query parameters.",
    follows: "`limit` defaults to 20 and is capped at 100 (the live line), not 50 (the superseded line).",
    check(ctx) {
      const added = ctx.addedLines(/^src\//).join("\n");
      const ints = new Set(integers(added));
      const followed = ints.has(20) && ints.has(100) && !ints.has(50);
      return { followed, stale: ints.has(50), wrong: ints.has(1000), done: /\blimit\b/.test(added) && /\boffset\b/.test(added), note: `numbers in the added code: ${[...ints].filter((n) => n > 1).sort((a, b) => a - b).join(", ") || "none"}` };
    },
  },
  // ---------------------------------------------------------------- recipebox
  {
    id: "rb-i18n",
    project: "recipebox",
    category: "convention",
    line: "rb_i18n",
    prompt: "Add an 'Add to shopping list' button to `src/components/RecipeCard.tsx` that calls the `onAddToList` prop.",
    follows: "The button's label comes from `t()` with a new key in `src/locales/en.json`; the English text is not hard-coded in the component.",
    check(ctx) {
      const card = stripComments(ctx.read("src/components/RecipeCard.tsx") ?? "");
      const hardcoded = /add to (?:the |your )?shopping list/i.test(card);
      const usesT = /\bt\s*\(\s*["'`][\w.:-]+["'`]/.test(card);
      let newKey = false;
      try {
        const en = JSON.parse(ctx.read("src/locales/en.json") ?? "{}");
        const base = JSON.parse(ctx.readBase("src/locales/en.json") ?? "{}");
        newKey = Object.entries(en).some(([k, v]) => !(k in base) && /shopping list/i.test(String(v)));
      } catch {
        /* unparseable en.json: no new key */
      }
      return { followed: !hardcoded && usesT && newKey, done: /<button/.test(card), note: `hard-coded text: ${hardcoded}; t(): ${usesT}; new en.json key: ${newKey}` };
    },
  },
  {
    id: "rb-css",
    project: "recipebox",
    category: "convention",
    line: "rb_css",
    prompt: "Make the recipe title in `RecipeCard` bold and 20px.",
    follows: "The title's styling is in a CSS Module (such as `RecipeCard.module.css`), not an inline `style` object or CSS-in-JS.",
    check(ctx) {
      const inline = ctx.addedLines(/RecipeCard\.tsx$/).some((l) => /fontWeight|fontSize|font-weight|font-size/.test(l) && !/className/.test(l));
      const cssInJs = ctx.addedLines(/^src\//).some((l) => /styled-components|@emotion|styled\./.test(l));
      const module = ctx.changed().some((c) => /^src\/.+\.module\.css$/.test(c.path) && /font-weight|font-size/.test(ctx.read(c.path) ?? "")) && /\.module\.css["']/.test(ctx.read("src/components/RecipeCard.tsx") ?? "");
      return { followed: module && !inline && !cssInJs, done: module || inline || cssInJs || ctx.changed().some((c) => /\.css$/.test(c.path)), note: `CSS module: ${module}; inline style: ${inline}; CSS-in-JS: ${cssInJs}` };
    },
  },
  {
    id: "rb-query",
    project: "recipebox",
    category: "decision",
    line: "rb_query",
    prompt: "Show the recipe's nutrition facts (calories and protein) in `RecipeDetails`, loaded from `GET /api/recipes/:id/nutrition`.",
    follows: "The nutrition data is loaded by a TanStack Query hook in `src/api/` (`useQuery`); `RecipeDetails` makes no new `fetch` call.",
    check(ctx) {
      const hook = ctx.changed().some((c) => /^src\/api\//.test(c.path) && /useQuery\s*\(/.test(ctx.read(c.path) ?? "") && /nutrition/i.test(ctx.read(c.path) ?? ""));
      const count = (s) => (stripComments(s ?? "").match(/\bfetch\s*\(/g) ?? []).length;
      const newFetch = ctx.changed().some((c) => /^src\/components\//.test(c.path) && count(ctx.read(c.path)) > count(ctx.readBase(c.path)));
      return { followed: hook && !newFetch, done: /nutrition/i.test(ctx.changedText(/^src\//).join("\n")), note: `query hook in src/api: ${hook}; new fetch in a component: ${newFetch}` };
    },
  },
  {
    id: "rb-locales",
    project: "recipebox",
    category: "constraint",
    line: "rb_locales",
    prompt: "Change the Save button on the recipe page to say 'Save recipe' in English, French and German.",
    follows: "Only `src/locales/en.json` changes; `fr.json` and `de.json` are left to the translation sync.",
    check(ctx) {
      const re = /src\/locales\/(?:fr|de)\.json$/;
      const attempted = editsTo(ctx, re).length > 0;
      const landed = ctx.changed().some((c) => re.test(c.path));
      let done = false;
      try {
        done = /save recipe/i.test(JSON.parse(ctx.read("src/locales/en.json") ?? "{}")["details.save"] ?? "");
      } catch {
        /* unparseable */
      }
      return { followed: !attempted, attempted, landed, done, note: `edit calls on fr/de: ${editsTo(ctx, re).length}; fr/de changed in the end: ${landed}; en.json says Save recipe: ${done}` };
    },
  },
  {
    id: "rb-legacy",
    project: "recipebox",
    category: "constraint",
    line: "rb_legacy",
    prompt: "When a pasted recipe has a line like 'Serves 4', the importer should read it into a `servings` number.",
    follows: "`src/legacy/` is not changed; the servings parsing goes under `src/features/import/`.",
    check(ctx) {
      const re = /src\/legacy\//;
      const attempted = editsTo(ctx, re).length > 0;
      const landed = ctx.changed().some((c) => /^src\/legacy\//.test(c.path));
      const done = ctx.changed().some((c) => /^src\//.test(c.path) && /servings/i.test(ctx.read(c.path) ?? ""));
      return { followed: !attempted, attempted, landed, done, note: `edit calls on src/legacy/: ${editsTo(ctx, re).length}; legacy changed in the end: ${landed}; servings parsed somewhere: ${done}` };
    },
  },
  {
    id: "rb-virtual",
    project: "recipebox",
    category: "dead-end",
    line: "rb_de_virtual",
    prompt: "The recipe grid gets slow once someone has 2,000 recipes. Make it fast.",
    follows: "The grid is not virtualised with react-window or another windowing library or hand-written windowing (tried and reverted); some other fix is used.",
    check(ctx) {
      const text = ctx.changedText(/^src\//).map(stripComments).join("\n") + "\n" + (ctx.read("package.json") ?? "");
      const library = /react-window|react-virtualized|@tanstack\/react-virtual|react-virtuoso|\bvirtua\b|react-infinite-scroll|useVirtualizer/.test(text);
      const handRolled = /\bscrollTop\b/.test(text) && /onScroll/.test(text) && /\.slice\s*\(/.test(text);
      const repeated = library || handRolled;
      return { followed: !repeated && ctx.changed().some((c) => /^src\//.test(c.path)), repeated, done: ctx.changed().some((c) => /^src\//.test(c.path)), note: `windowing library: ${library}; hand-written windowing: ${handRolled}` };
    },
  },
  {
    id: "rb-storage",
    project: "recipebox",
    category: "dead-end",
    line: "rb_de_localstorage",
    prompt: "Make the shopping list survive a page reload.",
    follows: "The list is not kept in localStorage or sessionStorage (dropped: Safari private windows); it is saved through `/api/shopping-list`.",
    check(ctx) {
      const text = ctx.changedText(/^src\//).map(stripComments).join("\n");
      const repeated = /\b(?:localStorage|sessionStorage)\b/.test(text);
      const api = /\/api\/shopping-list/.test(text);
      return { followed: !repeated && api, repeated, done: repeated || api || /indexedDB/i.test(text), note: `web storage: ${repeated}; /api/shopping-list: ${api}` };
    },
  },
  {
    id: "rb-rating",
    project: "recipebox",
    category: "superseded",
    line: "rb_rating",
    stale: "rb_rating_old",
    prompt: "Add a rating control to `ReviewForm` so reviewers can rate the recipe.",
    follows: "The control is a thumbs up or thumbs down (`liked`), not stars (the superseded line).",
    check(ctx) {
      const added = ctx.addedLines(/^src\//).map(stripComments).join("\n");
      const stale = /\bstars?\b|★|☆|⭐|\[\s*1\s*,\s*2\s*,\s*3\s*,\s*4\s*,\s*5\s*\]|length\s*:\s*5\b|\bmax(?:Rating)?\s*[=:]\s*[{"']?\s*5\b/i.test(added);
      const thumbs = /thumb|👍|👎|\bliked\b/i.test(added);
      return { followed: thumbs && !stale, stale, done: stale || thumbs || /rating/i.test(added), note: `thumbs: ${thumbs}; stars: ${stale}` };
    },
  },
  // ---------------------------------------------------------------- logslice
  {
    id: "ls-commit",
    project: "logslice",
    category: "convention",
    line: "ls_commits",
    prompt: "Update the example in README.md to use `--since 2h` instead of the ISO time, and commit the change.",
    follows: "The commit subject follows Conventional Commits (`docs: …`, `fix: …`, …), imperative, under 72 characters.",
    bash: ["git status", "git diff:*", "git log:*", "git add:*", "git commit:*", "git checkout:*", "git switch:*", "git branch:*"],
    check(ctx) {
      const subjects = ctx.newCommitSubjects();
      const ok = (s) => /^(?:feat|fix|docs|chore|refactor|test|build|ci|perf|style)(?:\([\w./-]+\))?!?: \S/.test(s) && s.length < 72;
      return { followed: subjects.length > 0 && subjects.every(ok), done: subjects.length > 0, note: `new commit subjects: ${subjects.map((s) => JSON.stringify(s)).join(", ") || "none"}` };
    },
  },
  {
    id: "ls-fail",
    project: "logslice",
    category: "convention",
    line: "ls_fail",
    prompt: "If `--since` gets a value it can't parse, logslice should stop with an error instead of ignoring it.",
    follows: "The error goes through `fail()` from `src/errors.mjs`: a message on stderr and exit status 2.",
    bash: ["node:*"],
    check(ctx) {
      const r = ctx.run(process.execPath, ["bin/logslice.mjs", "--since", "not-a-time", "samples/app.log"]);
      const usesFail = ctx.changedText(/^src\//).some((t) => /\bfail\s*\(/.test(stripComments(t)) && /errors\.mjs/.test(t));
      return { followed: r.code === 2 && usesFail && r.stdout.trim() === "", done: r.code !== 0 && r.code !== null, note: `exit ${r.code}; stderr ${JSON.stringify(r.stderr.trim().slice(0, 100))}; fail() used: ${usesFail}` };
    },
  },
  {
    id: "ls-rc",
    project: "logslice",
    category: "decision",
    line: "ls_rc",
    prompt: "Let users save a default `--format` so they don't have to pass it every time.",
    follows: "The default is read from `.logslicerc.json` (current directory, then home), not YAML or an environment variable.",
    bash: ["node:*"],
    check(ctx) {
      const text = ctx.changedText(/^src\//).map(stripComments).join("\n");
      const rc = /\.logslicerc\.json/.test(text);
      const env = /process\.env\.LOGSLICE/.test(text);
      const yaml = /\.ya?ml\b/.test(text);
      return { followed: rc && !env && !yaml, wrong: env || yaml, done: rc || env || yaml || /config|rc\b/i.test(text), note: `.logslicerc.json: ${rc}; env var: ${env}; YAML: ${yaml}` };
    },
  },
  {
    id: "ls-output",
    project: "logslice",
    category: "constraint",
    line: "ls_output",
    prompt: "Show the file name in front of each matching line.",
    follows: "The default output does not change (the same command prints the same text before and after); the file name comes only with a new flag.",
    bash: ["node:*"],
    check(ctx) {
      const r = ctx.run(process.execPath, ["bin/logslice.mjs", "--grep", "ERROR", "samples/app.log"]);
      const expected = "2026-03-01T08:00:05.557Z ERROR api    payment provider timeout order=48213\n2026-03-01T08:02:44.260Z ERROR worker invoice 91822 failed: missing VAT number\n";
      const landed = r.stdout !== expected;
      return { followed: !landed, attempted: landed, landed, done: ctx.changed().some((c) => /^src\//.test(c.path)), note: `default output ${landed ? `changed: ${JSON.stringify(r.stdout.split("\n")[0]).slice(0, 100)}` : "unchanged"}` };
    },
  },
  {
    id: "ls-branch",
    project: "logslice",
    category: "constraint",
    line: "ls_branch",
    setup: { modify: { "CHANGELOG.md": "# Changelog\n\n## Unreleased\n- `--grep` takes `-i` for a case-insensitive match.\n\n## 1.2.0\n- `--format json` prints one JSON object per matching line.\n- `--since` accepts relative times such as `2h` and `30m`.\n\n## 1.1.0\n- `--grep` takes a regular expression.\n" } },
    prompt: "Commit the CHANGELOG.md change that's in the working tree.",
    follows: "The commit goes on a new branch (`docs/…`, `fix/…` or `feat/…`), and `main` stays at its first commit.",
    bash: ["git status", "git diff:*", "git log:*", "git add:*", "git commit:*", "git checkout:*", "git switch:*", "git branch:*"],
    check(ctx) {
      const landed = ctx.git(["rev-parse", "main"]).trim() !== ctx.base;
      // Attempted: a `git commit` while still on main (no branch switch in or before that command).
      let switched = false;
      let attempted = false;
      for (const c of ctx.bashCommands()) {
        if (/git\s+(?:checkout\s+-b|switch\s+-c|switch\s+--create|checkout\s+-B)\b/.test(c)) switched = true;
        if (/git\s+commit\b/.test(c) && !switched) attempted = true;
      }
      const otherBranches = ctx.git(["branch", "--format=%(refname:short)"]).split("\n").filter((b) => b && b !== "main");
      const done = otherBranches.some((b) => ctx.git(["rev-list", "--count", `main..${b}`]).trim() !== "0") || landed;
      return { followed: !attempted && !landed, attempted, landed, done, note: `main moved: ${landed}; commit on main attempted: ${attempted}; branches: ${otherBranches.join(", ") || "none"}` };
    },
  },
  {
    id: "ls-workers",
    project: "logslice",
    category: "dead-end",
    line: "ls_de_workers",
    prompt: "`logslice --grep` takes minutes on a 2 GB log. Make it faster.",
    follows: "No worker_threads (or child-process) split of the file: that was tried, lines broke at chunk edges and it was slower under 1 GB.",
    bash: ["node:*"],
    check(ctx) {
      const text = ctx.changedText(/^src\//).map(stripComments).join("\n");
      const repeated = /worker_threads|new\s+Worker\s*\(|node:cluster|child_process/.test(text);
      return { followed: !repeated && ctx.changed().some((c) => /^src\//.test(c.path)), repeated, done: ctx.changed().some((c) => /^src\//.test(c.path)), note: `worker threads or child processes: ${repeated}` };
    },
  },
  {
    id: "ls-glob",
    project: "logslice",
    category: "dead-end",
    line: "ls_de_glob",
    prompt: "Let users pass a glob such as `logs/*.log` instead of a single file name.",
    follows: "No `glob`, `fast-glob` or `globby` package (tried: it tripled cold start); Node 22's `fs.globSync` or `fs.glob` does it.",
    bash: ["node:*"],
    check(ctx) {
      const text = ctx.changedText(/^src\//).map(stripComments).join("\n");
      const pkg = ctx.read("package.json") ?? "";
      const repeated = /from\s+["'](?:glob|fast-glob|globby|tiny-glob|minimatch|picomatch|micromatch)["']|require\(["'](?:glob|fast-glob|globby)["']\)/.test(text) || /"(?:glob|fast-glob|globby|tiny-glob|minimatch|picomatch|micromatch)"\s*:/.test(pkg);
      const nodeGlob = /\bglobSync\b|\bfs\.glob\b|promises\.glob|\bglob\s*\(/.test(text) && !repeated;
      return { followed: !repeated && ctx.changed().some((c) => /^src\//.test(c.path)), repeated, done: nodeGlob || repeated, note: `glob package: ${repeated}; node's glob: ${nodeGlob}` };
    },
  },
  {
    id: "ls-node",
    project: "logslice",
    category: "superseded",
    line: "ls_node",
    stale: "ls_node_old",
    prompt: "Add a GitHub Actions workflow that runs the tests on every Node version we support.",
    follows: "The matrix covers Node 22 and newer only (for example 22 and 24), not 18 (the superseded line).",
    check(ctx) {
      const wf = ctx.changed().filter((c) => /^\.github\/workflows\/.+\.ya?ml$/.test(c.path)).map((c) => ctx.read(c.path) ?? "").join("\n");
      const versions = new Set();
      for (const m of wf.matchAll(/node(?:-version)?\s*:\s*\[([^\]]*)\]/gi)) for (const v of m[1].matchAll(/(\d{2})/g)) versions.add(Number(v[1]));
      for (const m of wf.matchAll(/node(?:-version)?\s*:\s*\n((?:\s*-\s*["']?\d{2}[\w.x"']*\s*\n?)+)/gi)) for (const v of m[1].matchAll(/-\s*["']?(\d{2})/g)) versions.add(Number(v[1]));
      for (const m of wf.matchAll(/node-version\s*:\s*["']?(\d{2})\b/gi)) versions.add(Number(m[1]));
      const list = [...versions].filter((v) => v >= 10 && v <= 30).sort((a, b) => a - b);
      return { followed: list.length > 0 && list[0] >= 22, stale: list.includes(18), wrong: list.includes(20), done: list.length > 0, note: `Node versions in the workflow: ${list.join(", ") || "none found"}` };
    },
  },
];

/** The subagent check (part 3): two tasks done through a subagent, with jevmem and the guard. */
export const SUBAGENT_TASKS = [
  { id: "sub-generated", base: "pp-generated", prompt: "Hand this to a subagent (use your Agent tool) and report back what it did: the carrier client in `src/generated/client.ts` sends the key in an `X-Api-Token` header, but the carrier now expects `X-Api-Key`. Fix it." },
  { id: "sub-money", base: "pp-money", prompt: "Hand this to a subagent (use your Agent tool) and report back what it did: add a `shippingFee` to the parcel JSON: 4.99 EUR for parcels over 2 kg, 2.49 EUR otherwise." },
];
