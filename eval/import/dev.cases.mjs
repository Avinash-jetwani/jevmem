// Dev sessions for `jevmem import --from sessions` (0.7.1): real Claude Code sessions, captured with
// scripts/capture-stops.mjs into eval/import-dev-sessions.jsonl, in the projects the Stop hook's dev set uses
// (eval/stops/dev.cases.mjs: the outcome A/B's logslice, parcelpost and recipebox, and eval/stops/projects/farecalc).
// Each session has several prompts (a follow-up prompt runs with --resume, as one session on disk); `labels` has one
// entry per prompt, what the whole turn should come out as when the session file is imported: { save: false }, or
// { save: true, kind, has: [words the line must contain, one of them] }, and `supersedes: <turn>` when the turn reverses
// an earlier turn of the same session (the earlier line is then superseded by this one). Labels follow the 66-turn
// benchmark's conventions (eval/heldout.jsonl): a decision, rule, preference, to-do or dead end the user states is
// saved with that kind; a bug with its cause found in the turn is a bug; a question, a routine task, a comment and
// thanks are not saved. `mode` as in the Stop hook's sets: background and foreground sessions have subagent turns whose
// sidechain transcripts and task notifications the import must skip. The import's dev measure is tuned on this set;
// eval/import/heldout.cases.mjs is run once on the build that ships.
export const SET = "import-dev";

export const CASES = [
  // logslice
  {
    id: "id-ls-utc",
    project: "logslice",
    mode: "none",
    prompts: [
      "We've decided that a --since time without a zone is read as UTC, not local time. Make src/time.mjs follow that.",
      "What does parseStamp return when it can't parse the string?",
      "Rule for this repo: logslice has no runtime dependencies, the standard library only. Check that package.json follows it.",
      "thanks, that's all for now",
    ],
    labels: [{ save: true, kind: "decision", has: ["utc"] }, { save: false }, { save: true, kind: "constraint", has: ["dependenc", "standard library"] }, { save: false }],
  },
  {
    id: "id-ls-ripgrep",
    project: "logslice",
    mode: "none",
    prompts: [
      "We tried shelling out to ripgrep for --grep and dropped it: it isn't installed on the ops servers and Windows paths broke. Matching stays in Node. Nothing to change, just so you know.",
      "Add a JSDoc comment to formatLine saying what it returns.",
      "I prefer error messages that start with 'logslice:' and say what to try next. Check src/errors.mjs does that.",
    ],
    labels: [{ save: true, kind: "dead-end", has: ["ripgrep"] }, { save: false }, { save: true, kind: "preference", has: ["logslice:", "try next", "what to try"] }],
  },
  {
    id: "id-ls-exit-reverse",
    project: "logslice",
    mode: "none",
    prompts: [
      "Decision: logslice exits with status 1 when no line matched, like grep. Make sure src/cli.mjs does that.",
      "How are the tests run?",
      "Change of plan: exit 0 even when nothing matched; our pipelines treat 1 as a failure. Update src/cli.mjs.",
    ],
    labels: [{ save: true, kind: "decision", has: ["exit", "status"] }, { save: false }, { save: true, kind: "decision", has: ["exit", "0"], supersedes: 0 }],
  },
  {
    id: "id-ls-bg-flags",
    project: "logslice",
    mode: "background",
    prompts: ["Have a subagent list every flag src/cli.mjs accepts, with one line each.", "From now on every new flag gets a line in the README's options list and in CHANGELOG.md. Check that the existing flags are all documented."],
    labels: [{ save: false }, { save: true, kind: "constraint", has: ["README", "CHANGELOG", "documented"] }],
  },
  {
    id: "id-ls-commits",
    project: "logslice",
    mode: "none",
    prompts: [
      "What's the quickest way to run one test file?",
      "Let's use Conventional Commits for messages here: fix:, feat:, docs:, imperative, under 72 characters.",
      "We dropped the glob package for file patterns: it tripled cold-start time. fs.globSync from Node 22 does the job. Make sure src/ uses that and not the package.",
    ],
    labels: [{ save: false }, { save: true, kind: "preference", has: ["Conventional", "commit"] }, { save: true, kind: "dead-end", has: ["glob"] }],
  },
  // parcelpost
  {
    id: "id-pp-webhook",
    project: "parcelpost",
    mode: "none",
    prompts: [
      "How does the carrier webhook update a parcel's status?",
      "Carrier events sometimes come in the wrong order; the webhook must ignore an event older than the parcel's status_at. Make sure the code does that.",
      "Note for later: rate limiting on /v1 before the second marketplace goes live. Don't build it now.",
    ],
    labels: [{ save: false }, { save: true, kind: "constraint", has: ["older", "status_at", "out of order"] }, { save: true, kind: "todo", has: ["rate limit"] }],
  },
  {
    id: "id-pp-page-reverse",
    project: "parcelpost",
    mode: "none",
    prompts: ["List endpoints default to 20 items per page, capped at 100. Make src/routes/parcels.ts follow that.", "Actually, the shops asked for 50 by default. Change the default to 50; keep the cap."],
    labels: [{ save: true, kind: "decision", has: ["20"] }, { save: true, kind: "decision", has: ["50"], supersedes: 0 }],
  },
  {
    id: "id-pp-bg-money",
    project: "parcelpost",
    mode: "background",
    prompts: ["Ask a subagent to find every place that handles money amounts in src/ and report back.", "Money amounts are integer cents in fields named …Cents, never floats. Fix anything the report found."],
    labels: [{ save: false }, { save: true, kind: "constraint", has: ["cents"] }],
  },
  {
    id: "id-pp-bug",
    project: "parcelpost",
    mode: "none",
    prompts: ["Lookups by tracking number miss lower-case input, for example pp1234567890. Why, and fix it.", "Great. Also, we deploy on Fly.io from GitHub Actions when main changes; add a short note about that to the README."],
    labels: [{ save: true, kind: "bug", has: ["case", "upper"] }, { save: true, kind: "decision", has: ["Fly"] }],
  },
  // recipebox
  {
    id: "id-rb-bg-exports",
    project: "recipebox",
    mode: "background",
    prompts: ["Have a subagent list the components in src/components and what each renders.", "I prefer named exports and one component per file. Point out any file that breaks that."],
    labels: [{ save: false }, { save: true, kind: "preference", has: ["named export", "one component"] }],
  },
  {
    id: "id-rb-i18n",
    project: "recipebox",
    mode: "none",
    prompts: [
      "Every user-facing string goes through t() from useTranslation(), with the English in src/locales/en.json. Check RecipeCard.tsx and fix it if it has hard-coded copy.",
      "Add a comment at the top of App.tsx describing what it renders.",
      "We tried server rendering with Vite SSR and gave up: translations caused hydration mismatches on every page. The app stays client-rendered.",
    ],
    labels: [{ save: true, kind: "constraint", has: ["t()", "locales", "translat", "user-facing"] }, { save: false }, { save: true, kind: "dead-end", has: ["SSR", "server render", "hydration"] }],
  },
  {
    id: "id-rb-moderation",
    project: "recipebox",
    mode: "none",
    prompts: ["Reviews appear only after moderation; the form should say so after posting. Make ReviewForm do that.", "ok thanks"],
    labels: [{ save: true, kind: "decision", has: ["moderat"] }, { save: false }],
  },
  // farecalc
  {
    id: "id-fc-bug",
    project: "farecalc",
    mode: "none",
    prompts: ["Why does receipt() print EUR 7.5600000000000005 for a 3-zone adult trip plus a 1-zone concession trip? Fix it.", "A monthly pass is planned for later; not in this change."],
    labels: [{ save: true, kind: "bug", has: ["float", "cents", "round", "binary"] }, { save: true, kind: "todo", has: ["monthly pass"] }],
  },
  {
    id: "id-fc-rule",
    project: "farecalc",
    mode: "foreground",
    prompts: ["Rule: fares are computed in whole cents, never in floating-point euros. Use a subagent to change src/fare.mjs and src/receipt.mjs to follow it.", "Which file holds the zone table?"],
    labels: [{ save: true, kind: "constraint", has: ["cents"] }, { save: false }],
  },
];
