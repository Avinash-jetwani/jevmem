// Dev sessions for Cursor's automatic saving (0.7.4): real Cursor sessions, driven through the `agent` CLI
// (`agent -p`, one run per prompt, a follow-up prompt resumes the same chat) in scratch copies of the projects the
// Stop hook's dev sets use (logslice, parcelpost and recipebox from eval/ab/projects, farecalc from
// eval/stops/projects), with a logging-only hook on every Cursor event (scripts/capture-cursor.mjs), captured into
// eval/cursor-dev-sessions.jsonl before any Cursor code. `labels` has one entry per prompt, what the turn should come
// out as when its user message and final assistant text go through decide: { save: false }, or { save: true, kind,
// has: [words the line must contain, one of them] }, and `supersedes: <turn>` when the turn reverses an earlier turn of
// the same session. Labels follow the 66-turn benchmark's conventions (eval/heldout.jsonl): a decision, rule,
// preference, to-do or dead end the user states is saved with that kind; a bug with its cause found in the turn is a
// bug; a question, a routine task, a comment and thanks are not saved. The pairing measure (every turn paired whole:
// the prompt with the final assistant text of that run, no tool output, no two prompts merged, no turn lost) is
// checked against the CLI's own result event, recorded with each run. Tuning, if any, happens on this set only;
// eval/cursor/heldout.cases.mjs is captured in other projects and run once on the build that ships.
export const SET = "cursor-dev";

export const CASES = [
  // logslice
  {
    id: "cd-ls-json-default",
    project: "logslice",
    prompts: [
      "Decision: logslice's default output format is json from now on, not text; text stays available as --format text. Update src/cli.mjs and the README to match.",
      "How does --since handle a relative value like 30m?",
      "thanks",
    ],
    labels: [{ save: true, kind: "decision", has: ["json"] }, { save: false }, { save: false }],
  },
  {
    id: "cd-ls-grep-case",
    project: "logslice",
    prompts: [
      "We tried making --grep case-insensitive by default and backed it out: ops greps for exact level names and the noise doubled. Matching stays case-sensitive. No change needed; for the record.",
      "Put a one-line comment above the exports in src/output.mjs saying what they are for.",
      "Rule: every option logslice accepts must have a test in test/. Check which options are missing one and list them; don't write the tests yet.",
    ],
    labels: [{ save: true, kind: "dead-end", has: ["case"] }, { save: false }, { save: true, kind: "constraint", has: ["test"] }],
  },
  {
    id: "cd-ls-exit-reverse",
    project: "logslice",
    prompts: [
      "Run npm test and tell me what passes.",
      "From now on logslice exits with 2 on a bad flag and 1 on a read error; change src/cli.mjs accordingly.",
      "Change of plan: a bad flag exits 64, as sysexits says; keep 1 for read errors. Update it.",
    ],
    labels: [{ save: false }, { save: true, kind: "decision", has: ["exit"] }, { save: true, kind: "decision", has: ["64"], supersedes: 1 }],
  },
  // parcelpost
  {
    id: "cd-pp-ulid",
    project: "parcelpost",
    prompts: ["Decision for this API: parcel ids are ULIDs made in src/lib/ids.ts, never database serials. Check that src/routes/parcels.ts respects that and say what you found.", "What does the cache in src/lib/cache.ts key on?"],
    labels: [{ save: true, kind: "decision", has: ["ulid"] }, { save: false }],
  },
  {
    id: "cd-pp-redis-dropped",
    project: "parcelpost",
    prompts: [
      "I'd rather have log lines as JSON objects with a level field than the free text src/lib/log.ts writes. Switch it.",
      "We tried caching carrier lookups in Redis for an hour and dropped it: statuses went stale and shops complained. Lookups hit the carrier every time now. No code change, just for the record.",
      "Todo: the migrations folder needs a 003 that adds an index on tracking_number. Not today.",
    ],
    labels: [{ save: true, kind: "preference", has: ["json"] }, { save: true, kind: "dead-end", has: ["redis", "stale"] }, { save: true, kind: "todo", has: ["index", "tracking"] }],
  },
  {
    id: "cd-pp-space-bug",
    project: "parcelpost",
    prompts: ["A tracking number with a space in it comes back 404 from the lookup route. Find out why in src/routes/parcels.ts and fix it.", "Rule: never edit src/generated/client.ts by hand; only npm run gen writes it."],
    labels: [{ save: true, kind: "bug", has: ["space", "404", "trim", "encod"] }, { save: true, kind: "constraint", has: ["generated", "gen"] }],
  },
  // recipebox
  {
    id: "cd-rb-locales",
    project: "recipebox",
    prompts: [
      "Decision: every new string shown in the UI goes into src/locales/en.json first and is read through t(); no string literals in components. Check whether src/components/ReviewForm.tsx follows that.",
      "Why does src/legacy/importer.ts still exist?",
      "ok thanks, that's all",
    ],
    labels: [{ save: true, kind: "decision", has: ["locales", "t()", "en.json"] }, { save: false }, { save: false }],
  },
  {
    id: "cd-rb-css-context",
    project: "recipebox",
    prompts: [
      "Preference: CSS modules only in this app, no inline style props. Look at src/components/RecipeGrid.tsx and tell me if anything breaks that.",
      "We tried moving the shopping list into a React context and reverted it: every recipe card re-rendered on each tick. It stays as props. No code change.",
    ],
    labels: [{ save: true, kind: "preference", has: ["css module", "inline"] }, { save: true, kind: "dead-end", has: ["context", "re-render", "rerender"] }],
  },
  // farecalc
  {
    id: "cd-fc-rounding-reverse",
    project: "farecalc",
    prompts: [
      "Run the tests in test/fare.test.mjs and tell me the result.",
      "Decision: fares are rounded to the nearest 5 cents, half up, in src/fare.mjs. Implement it and add a test.",
      "Scrap that: round to the nearest 10 cents instead, the ticket machines can't give 5s. Update the code and the test.",
    ],
    labels: [{ save: false }, { save: true, kind: "decision", has: ["5"] }, { save: true, kind: "decision", has: ["10"], supersedes: 1 }],
  },
  {
    id: "cd-fc-receipt-format",
    project: "farecalc",
    prompts: ["What does src/receipt.mjs print for an empty list of trips?", "Rule for receipts: amounts always show two decimals and end with the currency code, like 3.40 EUR. Make src/receipt.mjs do that."],
    labels: [{ save: false }, { save: true, kind: "constraint", has: ["decimal", "eur", "currency"] }],
  },
];
