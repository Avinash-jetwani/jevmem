// Held-out sessions for Cursor's automatic saving (0.7.4): captured the same way as eval/cursor/dev.cases.mjs, in
// other projects (shelfscan and waterlog from eval/stops/projects, kelpline and sundial from eval/ab/projects), before
// any Cursor code, and not looked at while building. Run once on the build that ships: the pairing measure and
// decide's save/skip and kind on each turn against these labels. The label conventions are the dev file's.
export const SET = "cursor-heldout";

export const CASES = [
  // shelfscan
  {
    id: "ch-ss-hyphens",
    project: "shelfscan",
    prompts: ["Decision: shelfscan accepts ISBNs written with hyphens or spaces and strips them before checking. Make src/isbn.mjs do that and add a test.", "How is the ISBN-13 check digit computed?"],
    labels: [{ save: true, kind: "decision", has: ["hyphen", "space"] }, { save: false }],
  },
  {
    id: "ch-ss-stderr-regex",
    project: "shelfscan",
    prompts: [
      "Run npm test and summarise the result in one line.",
      "Rule: the CLI prints nothing but the result on stdout; every message meant for a person goes to stderr. Check src/cli.mjs against that.",
      "We tried validating with a regex alone and dropped it: it accepted 978-0-306-40615-8 with a wrong check digit. The checksum stays. Nothing to do.",
    ],
    labels: [{ save: false }, { save: true, kind: "constraint", has: ["stderr"] }, { save: true, kind: "dead-end", has: ["regex"] }],
  },
  {
    id: "ch-ss-to10-todo",
    project: "shelfscan",
    prompts: ["Todo for later: a to10 command for the ISBN-13 to ISBN-10 direction. Don't start it now.", "Add a short usage line for the check command to the README.", "thanks!"],
    labels: [{ save: true, kind: "todo", has: ["to10"] }, { save: false }, { save: false }],
  },
  // waterlog
  {
    id: "ch-wl-email-rule",
    project: "waterlog",
    prompts: ["Decision: the by field on a watering must be a work email ending in @example.org; src/server.mjs rejects anything else with a 400. Implement it.", "Which file holds the data?"],
    labels: [{ save: true, kind: "decision", has: ["example.org", "400"] }, { save: false }],
  },
  {
    id: "ch-wl-same-second",
    project: "waterlog",
    prompts: ["Two POST /plants/fern/water calls in the same second keep only one record. Find the cause in src/store.mjs and fix it.", "I prefer the data file written with two-space indentation so diffs stay readable. Change the writer."],
    // Run 1 was cut by the capture's 600 s limit (exit 130, no result event; a structural fact, its text not read):
    // an interrupted turn, which jevmem must not decide. The bug label it was written with is kept in `was`.
    labels: [{ save: false, interrupted: true, was: { save: true, kind: "bug", has: ["second", "timestamp", "key", "overwrit"] } }, { save: true, kind: "preference", has: ["indent", "two-space", "2-space"] }],
  },
  {
    id: "ch-wl-port-reverse",
    project: "waterlog",
    prompts: ["Rule: the server listens on 8080, not 3000. Update src/server.mjs and the README.", "Run the tests.", "Change of plan: back to 3000, the proxy config already points there. Revert the port in both places."],
    labels: [{ save: true, kind: "constraint", has: ["8080"] }, { save: false }, { save: true, kind: "constraint", has: ["3000"], supersedes: 0 }],
  },
  // kelpline
  {
    id: "ch-kl-notify-cooldown",
    project: "kelpline",
    prompts: [
      "We tried sending alert emails straight from the poller and backed it out: one NOAA outage sent an email per station per minute. Alerts go through src/notify.ts with a cooldown now. No change needed.",
      "Decision: every new route gets its entry in api/openapi.yaml in the same commit, and the contract test enforces it. Check that test/contract.test.ts still covers every route.",
    ],
    labels: [{ save: true, kind: "dead-end", has: ["outage", "cooldown", "poller"] }, { save: true, kind: "decision", has: ["openapi"] }],
  },
  {
    id: "ch-kl-config-only",
    project: "kelpline",
    prompts: ["Where does the poll interval come from?", "Rule: settings are read in src/config.ts only, never from process.env anywhere else. Grep src/ and name any offender."],
    labels: [{ save: false }, { save: true, kind: "constraint", has: ["config.ts", "process.env"] }],
  },
  // sundial
  {
    id: "ch-sd-capacity",
    project: "sundial",
    prompts: ["Decision: a booking can't exceed the room's capacity; the check lives in sundial/routes/bookings.py and answers with the en.json message. Add it.", "thanks, that's it for today"],
    labels: [{ save: true, kind: "decision", has: ["capacity"] }, { save: false }],
  },
  {
    id: "ch-sd-reminders",
    project: "sundial",
    prompts: [
      "Todo: fr.json is three keys behind en.json; the vendor sync owns that file, so leave it until the next sync.",
      "I'd rather reminders went out at 18:00 local time than 09:00. Change the default in config/defaults.toml.",
      "What does t() do when a key is missing?",
    ],
    labels: [{ save: true, kind: "todo", has: ["fr.json"] }, { save: true, kind: "preference", has: ["18:00", "18"] }, { save: false }],
  },
];
