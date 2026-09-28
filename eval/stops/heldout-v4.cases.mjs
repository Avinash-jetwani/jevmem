// Decide held-out v4 (v0.6 part 3b): the sessions whose Stop hooks make eval/stops-heldout-v4.jsonl, written before
// any change to how the Stop hook reads a turn. Captured with scripts/capture-stops.mjs, scored with
// scripts/eval-stops.mjs. Projects: eval/stops/projects/shelfscan and waterlog (used by no other set).
//
// `mode`: background (fork mode: every subagent in the background, as in an interactive session), foreground (every
// subagent in the foreground), none (no subagent asked for). `labels`: one per prompt, what that whole turn should save:
// { save: false } or { save: true, kind }. Labels follow the 66-turn benchmark's conventions (eval/heldout.jsonl): a
// decision, rule, preference or to-do the user states is saved with that kind; a bug with its cause found in the turn
// is a bug; a question about the code, a routine task or thanks is not saved.
export const SET = "heldout-v4";

export const CASES = [
  // Background subagents: the main agent stops while the subagent works, and its report comes back as a notification.
  { id: "h4-bg-exports", project: "shelfscan", mode: "background", prompts: ["Have a subagent go through src/ and list every exported function with a one-line description of what it does."], labels: [{ save: false }] },
  { id: "h4-bg-esm", project: "shelfscan", mode: "background", prompts: ["We've decided this package is ESM-only from now on. Ask a subagent to check that nothing in the repo still uses require() or module.exports, and report back."], labels: [{ save: true, kind: "decision" }] },
  { id: "h4-bg-isbnx", project: "shelfscan", mode: "background", prompts: ["ISBN-10s that end in X are reported as invalid, for example 0-8044-2957-X. Have a subagent find the cause and fix it."], labels: [{ save: true, kind: "bug" }] },
  { id: "h4-bg-nothrow", project: "shelfscan", mode: "background", prompts: ["Rule for this repo: parseIsbn must never throw on bad input, it returns null instead. Get a subagent to make isbn.mjs and the CLI follow that."], labels: [{ save: true, kind: "constraint" }] },
  { id: "h4-bg-tests", project: "shelfscan", mode: "background", prompts: ["Ask a subagent to count the tests in test/ and say what each one checks."], labels: [{ save: false }] },
  { id: "h4-bg-testfiles", project: "shelfscan", mode: "background", prompts: ["I like each test file to cover exactly one source file and to be named after it. Have a subagent tell me whether test/ already works that way."], labels: [{ save: true, kind: "preference" }] },
  { id: "h4-bg-quote", project: "waterlog", mode: "background", prompts: ["Watering a plant whose name has a double quote in it, like Big \"Bertha\" fern, gives a 500. Send a subagent to find out why and fix it."], labels: [{ save: true, kind: "bug" }] },
  { id: "h4-bg-emails", project: "waterlog", mode: "background", prompts: ["Plant owners' email addresses must never show up in the server logs. Have a subagent check src/ and remove any logging that prints them."], labels: [{ save: true, kind: "constraint" }] },
  { id: "h4-bg-port", project: "waterlog", mode: "background", prompts: ["Have a subagent find where the HTTP port is set and tell me how to change it."], labels: [{ save: false }] },
  { id: "h4-bg-jsonfile", project: "waterlog", mode: "background", prompts: ["We'll keep the data in data/waterings.json and not move to SQLite; that's settled. Ask a subagent to make sure store.mjs only ever writes to that one file."], labels: [{ save: true, kind: "decision" }] },
  { id: "h4-bg-routes", project: "waterlog", mode: "background", prompts: ["Get a subagent to write a short summary of what each route in src/server.mjs does."], labels: [{ save: false }] },
  { id: "h4-bg-two-throw", project: "waterlog", mode: "background", prompts: ["Use two subagents in parallel: one reads src/server.mjs, the other src/store.mjs, and each lists anything that could throw. When both have reported, give me one combined list."], labels: [{ save: false }] },
  { id: "h4-bg-two-later", project: "shelfscan", mode: "background", prompts: ["Two subagents in parallel please: one checks the README examples against src/cli.mjs, the other checks the scripts in package.json. Report what both found. Converting ISBN-13 back to ISBN-10 is something we'll add later, not now."], labels: [{ save: true, kind: "todo" }] },
  { id: "h4-bg-then-decide", project: "shelfscan", mode: "background", prompts: ["Have a subagent check which functions in src/isbn.mjs have no test.", "We'll stay on node:test and plain assert, no jest. Add the missing tests that way."], labels: [{ save: false }, { save: true, kind: "decision" }] },

  // Foreground subagents: the main agent waits for the subagent's answer inside the turn.
  { id: "h4-fg-untested", project: "shelfscan", mode: "foreground", prompts: ["Use a subagent to read test/isbn.test.mjs and tell me which functions have no test."], labels: [{ save: false }] },
  { id: "h4-fg-localhost", project: "waterlog", mode: "foreground", prompts: ["The server must only accept connections over loopback, never from other machines. Have a subagent check src/server.mjs and fix it if needed."], labels: [{ save: true, kind: "constraint" }] },
  { id: "h4-fg-exitcodes", project: "shelfscan", mode: "foreground", prompts: ["From now on the CLI exits with code 3 for a bad ISBN and 2 for a usage error. Get a subagent to make src/cli.mjs do that."], labels: [{ save: true, kind: "decision" }] },
  { id: "h4-fg-files", project: "waterlog", mode: "foreground", prompts: ["Have a subagent list the files in the repo and say which ones the tests touch."], labels: [{ save: false }] },

  // Ordinary turns: no subagent.
  { id: "h4-or-hyphens", project: "shelfscan", mode: "none", prompts: ["What does toIsbn13 do with an ISBN-10 that has hyphens in it?"], labels: [{ save: false }] },
  { id: "h4-or-json", project: "shelfscan", mode: "none", prompts: ["Going forward, the CLI's check command prints JSON, one object per ISBN. Change src/cli.mjs to do that."], labels: [{ save: true, kind: "decision" }] },
  { id: "h4-or-cwd", project: "waterlog", mode: "none", prompts: ["When I start the server from the parent folder with node waterlog/src/server.mjs, the waterings end up in a data folder outside the repo. Why, and can you fix it?"], labels: [{ save: true, kind: "bug" }] },
  { id: "h4-or-jsdoc", project: "shelfscan", mode: "none", prompts: ["Add a JSDoc comment to normalise() saying what it strips."], labels: [{ save: false }] },
  { id: "h4-or-nohttpfw", project: "waterlog", mode: "none", prompts: ["In this repo I want plain node:http, no Express or any other framework, even as routes grow. Please add a GET /plants/<name> route that returns one plant; there is no need to run it."], labels: [{ save: true, kind: "preference" }] },
  { id: "h4-or-979", project: "shelfscan", mode: "none", prompts: ["We still need to handle ISBN-13s that start with 979, which have no ISBN-10. Don't implement it yet, just keep it in mind for later."], labels: [{ save: true, kind: "todo" }] },
  { id: "h4-or-runtests", project: "waterlog", mode: "none", prompts: ["Run the tests and tell me whether they pass."], labels: [{ save: false }] },
  { id: "h4-or-zerodeps", project: "shelfscan", mode: "none", prompts: ["shelfscan has to stay free of runtime dependencies, always. Is there anything in package.json we should take out?"], labels: [{ save: true, kind: "constraint" }] },
  { id: "h4-or-explain", project: "waterlog", mode: "none", prompts: ["Explain step by step what recordWatering does."], labels: [{ save: false }] },
  { id: "h4-or-x-cli", project: "shelfscan", mode: "none", prompts: ["node src/cli.mjs to13 0-8044-2957-X says it's not a valid ISBN-10, but it is one. What's going on?"], labels: [{ save: true, kind: "bug" }] },
  { id: "h4-or-case", project: "waterlog", mode: "none", prompts: ["We've decided plant names are case-insensitive: Fern and fern are the same plant. Make the store work that way.", "Thanks, that's all for now."], labels: [{ save: true, kind: "decision" }, { save: false }] },
  { id: "h4-or-alltested", project: "shelfscan", mode: "none", prompts: ["Which function would I call to check a barcode that could be either length?", "OK. From now on every exported function needs a test in test/. Add the ones that are missing."], labels: [{ save: false }, { save: true, kind: "constraint" }] },
];
