// Held-out sessions for `jevmem import --from sessions` (0.7.1), written and labelled before any import code, in the
// two projects the Stop hook's held-out set uses and no dev set does (eval/stops/projects/shelfscan and waterlog).
// Captured with scripts/capture-stops.mjs into eval/import-heldout-sessions.jsonl; run once on the build that ships.
// Nobody tunes on it. Labels as in eval/import/dev.cases.mjs: one per prompt, { save: false } or
// { save: true, kind, has: [one of these must be in the line] }, with `supersedes: <turn>` for a reversal.
export const SET = "import-heldout";

export const CASES = [
  // shelfscan
  {
    id: "ih-ss-esm",
    project: "shelfscan",
    mode: "none",
    prompts: ["This package is ESM-only from now on; nothing may use require() or module.exports. Check the repo and fix any file that does.", "What does normalise() strip from an ISBN?", "Cheers."],
    labels: [{ save: true, kind: "constraint", has: ["ESM", "require", "module.exports"] }, { save: false }, { save: false }],
  },
  {
    id: "ih-ss-exitcodes-reverse",
    project: "shelfscan",
    mode: "none",
    prompts: ["The CLI exits 3 for a bad ISBN and 2 for a usage error. Make src/cli.mjs do that.", "Scrap that: a bad ISBN exits 1, the same as a usage error; the wrapper script only checks for non-zero. Update src/cli.mjs."],
    labels: [{ save: true, kind: "decision", has: ["3", "exit"] }, { save: true, kind: "decision", has: ["1", "exit", "non-zero"], supersedes: 0 }],
  },
  {
    id: "ih-ss-bg-tests",
    project: "shelfscan",
    mode: "background",
    prompts: ["Get a subagent to count the tests in test/ and say what each one checks.", "I like each test file to cover exactly one source file and to be named after it. Tell me whether test/ already works that way."],
    labels: [{ save: false }, { save: true, kind: "preference", has: ["test file", "named after", "one source file"] }],
  },
  {
    id: "ih-ss-isbnx",
    project: "shelfscan",
    mode: "none",
    prompts: ["ISBN-10s that end in X come back invalid, for example 0-8044-2957-X. Find the cause and fix it.", "Converting an ISBN-13 back to ISBN-10 is for later, not now."],
    labels: [{ save: true, kind: "bug", has: ["X", "check digit"] }, { save: true, kind: "todo", has: ["ISBN-10", "later"] }],
  },
  {
    id: "ih-ss-deadend",
    project: "shelfscan",
    mode: "none",
    prompts: ["We tried validating ISBNs with the isbn3 package and dropped it: it pulled in 40 dependencies and misread hyphenated ISBN-10s. The hand-written check stays.", "Add a JSDoc comment to toIsbn13."],
    labels: [{ save: true, kind: "dead-end", has: ["isbn3", "dependencies", "hyphen"] }, { save: false }],
  },
  {
    id: "ih-ss-json",
    project: "shelfscan",
    mode: "foreground",
    prompts: ["Going forward the check command prints JSON, one object per ISBN. Use a subagent to change src/cli.mjs.", "Which flags does the CLI take?"],
    labels: [{ save: true, kind: "decision", has: ["JSON"] }, { save: false }],
  },
  // waterlog
  {
    id: "ih-wl-emails",
    project: "waterlog",
    mode: "none",
    prompts: ["Plant owners' email addresses must never appear in the server logs. Check src/ and remove any logging that prints them.", "How does the server find a plant by name?"],
    labels: [{ save: true, kind: "constraint", has: ["email", "log"] }, { save: false }],
  },
  {
    id: "ih-wl-storage-reverse",
    project: "waterlog",
    mode: "none",
    prompts: [
      "We'll keep the data in data/waterings.json; no SQLite. Make sure store.mjs only ever writes that one file.",
      "Add a GET /plants/<name> route that returns one plant.",
      "New decision: the data moves to SQLite with better-sqlite3; the JSON file got corrupted twice last week. Change store.mjs to use it.",
    ],
    labels: [{ save: true, kind: "decision", has: ["json", "waterings"] }, { save: false }, { save: true, kind: "decision", has: ["SQLite", "sqlite"], supersedes: 0 }],
  },
  {
    id: "ih-wl-bg-quote",
    project: "waterlog",
    mode: "background",
    prompts: ["Watering a plant whose name has a double quote in it gives a 500. Send a subagent to find out why and fix it.", "Thanks. Also: the server must only listen on loopback, never on all interfaces."],
    labels: [{ save: true, kind: "bug", has: ["quote", "JSON", "escap", "encod"] }, { save: true, kind: "constraint", has: ["loopback", "127.0.0.1", "localhost", "interfaces"] }],
  },
  {
    id: "ih-wl-pref",
    project: "waterlog",
    mode: "none",
    prompts: ["In this repo I want plain node:http, no Express or any other framework, even as the routes grow.", "Where is the HTTP port set?", "Reminder for later: a DELETE /plants/<name> route once we have auth."],
    labels: [{ save: true, kind: "preference", has: ["node:http", "Express", "framework"] }, { save: false }, { save: true, kind: "todo", has: ["DELETE", "auth"] }],
  },
  {
    id: "ih-wl-deadend",
    project: "waterlog",
    mode: "none",
    prompts: ["We tried keeping the waterings in memory and flushing them to the file every minute; a crash lost a day of entries, so every watering is written to the file at once now.", "Rename the data folder to store/ and update the paths."],
    labels: [{ save: true, kind: "dead-end", has: ["memory", "flush", "crash"] }, { save: false }],
  },
  {
    id: "ih-wl-dates",
    project: "waterlog",
    mode: "foreground",
    prompts: ["Use a subagent to list the files the tests touch.", "Decision: dates in the API are ISO 8601 UTC strings, never epoch numbers. Make server.mjs follow it."],
    labels: [{ save: false }, { save: true, kind: "decision", has: ["ISO", "UTC"] }],
  },
];
