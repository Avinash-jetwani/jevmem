# Guardrails

> **Unreleased.** This is on `main` and not yet in the npm release: the `jevmem` CLI on npm does not have the guard, and the plugin's launcher runs the guard's hook only with a CLI that has it.

jevmem saves rules from your conversations as `[constraint]` lines in `JEVMEM.md` ("Never commit .env files"). The guard is a `PreToolUse` hook that checks each Bash, Edit and Write call against those rules before it runs. When Jev says a call may break one, the guard has Claude Code ask you (the default), block the call, or tell Claude the rule.

## How it works

1. **Rules.** The live `[constraint]` lines of `JEVMEM.md` that have passed the [memory-poisoning gate](../SECURITY.md#memory-poisoning): lines jevmem wrote on this machine, and other lines once the gate has a clean verdict for them. The hook never asks the gate itself. Verdicts come from recall on your next prompt, from the Stop hook (which checks new rules once the turn's queue is drained), or from `jevmem audit --security`. Until then a line is not enforced; `jevmem guard test` lists it as skipped, and the log says so once. Superseded lines are ignored. The rules and their features are indexed in `.jevmem/guard-index.json`, rebuilt when `JEVMEM.md` or the gate's state changes.
2. **Prefilter, on your machine.** Each rule and each call are reduced to paths and globs, filenames, command words (and `command subcommand` pairs such as `git push`) and keywords. A shell command line is split into its commands on `&&`, `||`, `;`, `|` and newlines, with `$( )` and backticks as commands of their own. An Edit or Write gives its path and the words of the new and replaced text. A rule that shares enough with the call is a candidate. A path, a filename, a pair, or a tool the rule names (`npm`, `psql`) does it alone; a broad directory such as `src/`, a tool nearly every session runs (git) and each keyword count for less, so one shared word is not enough. At most `guard.maxCandidates` (3) rules go further. A call with no candidate is done: no output, nothing sent.
3. **Jev.** One request, one noul per candidate rule: "Would carrying out this tool call break saved project rule `<id>`?". It carries the command, or the file path (relative to the project) and a short snippet of the change around what matched, after the secret scrubber has run, plus the candidate rules' texts. The request gets what is left of `guard.budgetMs` (1,000 ms by default); the hook entry's own timeout is 3 s. Every answer, yes or no, is cached in `.jevmem/guard-cache.json` by rule and call, so a repeated call makes no request.
4. **Decision**, by `guard.mode`:

| Mode | When Jev's score reaches `guard.askMin` (0.5) |
|---|---|
| `ask` (default) | Claude Code asks you before the call runs, showing `jevmem: this may break a saved rule: "Never commit .env files" (JEVMEM.md)`. |
| `block` | At or above `guard.blockMin` (0.9) the call does not run. Claude gets `jevmem: blocked by a saved project rule: "…" (JEVMEM.md). Tell the user about this rule instead of working around it.` Between the two thresholds it asks, as in `ask`. |
| `warn` | No permission decision. The rule reaches Claude as context, written as a fact: `Saved project rule in JEVMEM.md: "…".` Claude Code adds it next to the tool's result, so it arrives after the call has run. |
| `off` | The hook does nothing. |

The guard never answers "allow". That answer would skip your permission prompt, so a call the guard doesn't object to goes through Claude Code's normal permission flow, as if the hook weren't there.

## When nobody is there to answer "ask"

Measured with Claude Code 2.1.274 and 2.1.281 and a test hook that always answers "ask":

- **Interactive sessions**, in default, auto and bypassPermissions mode alike, show the prompt: "Hook PreToolUse:Bash requires confirmation for this command: …", with a Yes/No choice. Bypass mode does not skip it, and auto mode does not approve it on its own.
- **`claude -p`** has nobody to ask, so the call is denied, and Claude receives the reason as the tool's error. This happened in default, acceptEdits, auto, dontAsk and bypassPermissions mode. In a headless run, `ask` therefore behaves like `block`.
- **A permission host** (`--permission-prompt-tool`, or an Agent SDK `canUseTool` callback) is asked instead, and its answer stands. It receives the tool's name and input, not the guard's reason.

## The tamper check

Some calls are asked every time, whatever Jev says and even with no rules, unless the mode is `off`: the guard must not be switched off by the agent it guards. The check is local and needs no key.

- An Edit or Write to `jevmem.config.json` that changes `guard` or `enabled`, or leaves the file unreadable.
- A shell command that writes, moves or deletes `jevmem.config.json` (`cat`, `jq`, `git diff` and the like are fine).
- An Edit or Write to `JEVMEM.md` that removes or supersedes a `[constraint]` line, or a shell command that rewrites the file. Appending with `>>` is fine.
- Anything that writes to `.jevmem/`, where the verdicts and cached answers live.
- `jevmem disable`, `jevmem init --remove-hooks`, and `jevmem wrong … --should-be none` when rules exist.

## Limits

- **The prefilter sees only the call.** `git add .` in a folder with an untracked `.env` shares nothing with "Never commit .env files". So does a script or a make target that does the forbidden thing. These are missed: none of the indirect cases was caught in either eval set.
- **One shared word is not enough.** A rule that a call touches with a single keyword is not checked. The held-out misses were `pickle.load` against "Never unpickle files that users upload", `it.only` against ".only", `newCheckout: true` against "never hardcode a flag to true", and a commit message against "Conventional Commits".
- **It fails open.** A timeout, Jev being down, no key, a bad `jevmem.config.json`, an unreadable `JEVMEM.md` or any error means no decision, and the call goes through the normal permission flow. The failure is logged to `.jevmem/log.jsonl`; the hook exits 0 and prints nothing to stdout or stderr. Claude Code cuts a stalled hook at the entry's 3 s timeout, which doesn't block either.
- **Ambiguous rules get ambiguous answers.** The same near miss scored 0.77 in one dev run and 0.93 in another. In held-out, "no rebase onto it" read as covering `git rebase main`, and "never fewer than 3 replicas" covered staging. Write rules as you mean them.
- **Only Bash, Edit and Write.** NotebookEdit, PowerShell (the shell on Windows without Git Bash), MCP tools and Read are not checked. So are files a script changes when run. An Edit or Write is read up to its first 16,000 characters.

## Measured

Both eval sets are hand-written: each call is labelled with the rules it breaks, and the two sets share no text (tested). The prefilter and `guard.blockMin` were tuned on the dev set only. The held-out set was committed before any run and run once after tuning ([results/README.md](../results/README.md)).

| Held-out set: 197 calls in 5 projects | |
|---|---|
| Violations caught, `ask` mode | 27/40: direct 27/31, indirect 0/9 |
| False asks | 3/157 |
| `block` mode: denied / asked instead / false blocks | 24/40 / 3 / 2/157 |
| Calls that never reach Jev (fast path) | 134/197, everyday calls 109/127 |

The dev set, tuned on: direct violations caught 37/38, indirect 0/10, false asks 2/157, false blocks 1/157, fast path 148/205 ([results/guard-dev-2026-09-26.json](../results/guard-dev-2026-09-26.json)). Held-out: [results/guard-heldout-2026-09-26.json](../results/guard-heldout-2026-09-26.json).

Added latency per tool call: the whole hook process as Claude Code starts it, 30 runs per case on an Apple M4 ([results/guard-latency-2026-09-26.json](../results/guard-latency-2026-09-26.json)):

| Case | Plugin launcher, p50 / p95 | `init` launcher, p50 / p95 |
|---|---|---|
| Project not enabled | 7 / 10 ms | 7 / 7 ms |
| Enabled, no constraints | 38 / 39 ms | 33 / 34 ms |
| Constraints, no candidate | 38 / 39 ms | 34 / 35 ms |
| A candidate sent to Jev, from a new process | 349 / 436 ms | 347 / 389 ms |
| A candidate whose answer is cached | 40 / 41 ms | 36 / 37 ms |

## Settings

In `jevmem.config.json` (these are the defaults):

```json
"guard": { "mode": "ask", "askMin": 0.5, "blockMin": 0.9, "budgetMs": 1000, "maxCandidates": 3 }
```

An unknown mode or an out-of-range value is a bad config: the guard makes no decision and logs why.

## Commands

- `jevmem guard test "<command>"` (or `--edit <path> [--old "<text>"] [--content "<new text>"]`, or `--write <path> [--content "<text>"]`) runs the hook's evaluation on one call in this project. It prints the rules loaded and skipped, which rules the prefilter matched and why, what would be sent, Jev's score for each, the tamper check, and the exact output the hook would print. It uses and fills the hook's answer cache; `--no-cache` asks afresh.
- `jevmem doctor` shows the mode and how many rules are enforced.
- `jevmem stats` counts the guard's asks, denials, warnings and Jev checks.

## What is sent

Only for a call with a candidate rule: the command, or the file path plus a short scrubbed snippet of the change, and the candidate rules. Nothing is sent when there is no candidate, or when the guard is off ([PRIVACY.md](../PRIVACY.md)).
