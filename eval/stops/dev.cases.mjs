// Dev cases for the Stop hook (v0.6 part 3b), where the change to how a turn is read was built and tuned; the held-out
// set is eval/stops/heldout-v4.cases.mjs. Captured with scripts/capture-stops.mjs into eval/stops-dev.jsonl. Projects:
// the outcome A/B's logslice, parcelpost and recipebox, and eval/stops/projects/farecalc (dev only).
// Modes and labels as in the held-out file.
export const SET = "dev";

export const CASES = [
  { id: "d-bg-flags", project: "logslice", mode: "background", prompts: ["Get a subagent to go over the command-line flags logslice accepts and explain each."], labels: [{ save: false }] },
  { id: "d-bg-utc", project: "logslice", mode: "background", prompts: ["We've decided logslice treats timestamps without an offset as UTC. Put a subagent on confirming src/time.mjs behaves that way, then summarise."], labels: [{ save: true, kind: "decision" }] },
  { id: "d-bg-stream", project: "logslice", mode: "background", prompts: ["logslice must never read a whole file into memory; it always streams line by line. Get a subagent to confirm the code sticks to that."], labels: [{ save: true, kind: "constraint" }] },
  { id: "d-bg-float", project: "farecalc", mode: "background", prompts: ["A receipt for a 3-zone trip plus a 1-zone concession trip shows EUR 7.5600000000000005. Get a subagent to track down the cause and correct it."], labels: [{ save: true, kind: "bug" }] },
  { id: "d-bg-cssmod", project: "recipebox", mode: "background", prompts: ["I prefer CSS modules over inline styles in this app. Get a subagent to point out the components that still use inline styles."], labels: [{ save: true, kind: "preference" }] },
  { id: "d-bg-routes", project: "parcelpost", mode: "background", prompts: ["Have a subagent summarise what each file under src/routes does."], labels: [{ save: false }] },
  { id: "d-bg-cents", project: "parcelpost", mode: "background", prompts: ["Decision: every money amount in the API is integer cents. Ask a subagent to find any field that still uses decimals and report back."], labels: [{ save: true, kind: "decision" }] },
  { id: "d-bg-count", project: "recipebox", mode: "background", prompts: ["Send a subagent to list the components in src/components and say what each renders."], labels: [{ save: false }] },
  { id: "d-bg-two-long", project: "logslice", mode: "background", prompts: ["Run two parallel subagents, the first on src/cli.mjs and the second on src/output.mjs, each looking for what could break with very long lines; merge what they report."], labels: [{ save: false }] },
  { id: "d-bg-then-rule", project: "parcelpost", mode: "background", prompts: ["Send a subagent to locate the code that creates parcels.", "Every parcel must get its tracking number when it is created, never later. Make sure the code does that."], labels: [{ save: false }, { save: true, kind: "constraint" }] },
  { id: "d-bg-halfstars", project: "recipebox", mode: "background", prompts: ["Have a subagent check how the rating in ReviewForm works. We'll add half-star ratings later, not in this change."], labels: [{ save: true, kind: "todo" }] },
  { id: "d-bg-fare-rule", project: "farecalc", mode: "background", prompts: ["Rule: fares are always computed in whole cents, never in floating-point euros. Get a subagent to change src/fare.mjs and src/receipt.mjs to follow it."], labels: [{ save: true, kind: "constraint" }] },

  { id: "d-fg-untested", project: "logslice", mode: "foreground", prompts: ["Get a subagent to compare test/ with src/ and list the functions nobody tests."], labels: [{ save: false }] },
  { id: "d-fg-migrations", project: "parcelpost", mode: "foreground", prompts: ["Migrations must never drop a column in the same release that stops using it. Have a subagent check migrations/ against that."], labels: [{ save: true, kind: "constraint" }] },
  { id: "d-fg-query", project: "recipebox", mode: "foreground", prompts: ["We're using React Query for all server state from now on. Get a subagent to name the components that fetch data some other way."], labels: [{ save: true, kind: "decision" }] },
  { id: "d-fg-since", project: "logslice", mode: "foreground", prompts: ["Have a subagent explain how the --since option is parsed."], labels: [{ save: false }] },

  { id: "d-or-empty", project: "logslice", mode: "none", prompts: ["What does formatLine do with an empty line?"], labels: [{ save: false }] },
  { id: "d-or-order", project: "logslice", mode: "none", prompts: ["From now on logslice prints matches in file order, never sorted. Check src/cli.mjs does that."], labels: [{ save: true, kind: "decision" }] },
  { id: "d-or-apikey", project: "parcelpost", mode: "none", prompts: ["Never log the carrier API key, not even part of it. Check src/ for anything that might."], labels: [{ save: true, kind: "constraint" }] },
  { id: "d-or-comment", project: "recipebox", mode: "none", prompts: ["Add a comment at the top of App.tsx describing what it renders."], labels: [{ save: false }] },
  { id: "d-or-early", project: "parcelpost", mode: "none", prompts: ["I like route handlers to validate their input at the top and return early. Look at src/routes/parcels.ts and tell me whether it does."], labels: [{ save: true, kind: "preference" }] },
  { id: "d-or-jsonlater", project: "logslice", mode: "none", prompts: ["We'll need a --json-lines output mode eventually; don't build it now."], labels: [{ save: true, kind: "todo" }] },
  { id: "d-or-float", project: "farecalc", mode: "none", prompts: ["Why does receipt() print EUR 7.5600000000000005 for a 3-zone adult trip and a 1-zone concession trip? Fix it."], labels: [{ save: true, kind: "bug" }] },
  { id: "d-or-webhooks", project: "parcelpost", mode: "none", prompts: ["How does the API find a parcel by its tracking number?", "OK. Tracking-number lookups must be case-insensitive; check the code does that."], labels: [{ save: false }, { save: true, kind: "constraint" }] },
];
