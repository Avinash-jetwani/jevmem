[← README](../README.md)

# The side pane (0.7.5)

The pane sits beside your Claude Code chat and shows what jevmem did for the prompt you just sent and the turn that just ended: which memory lines it gave Claude, what its guard said about a command, and what it saved. It is a second plugin, `jevmem-pane`, from the jevmem marketplace. The jevmem plugin itself is unchanged and still ships no code of its own.

## Install

With the jevmem marketplace added (`claude plugin marketplace add Avinash-jetwani/jevmem`), in Claude Code:

```
/plugin install jevmem-pane@jevmem
```

It needs three things: the jevmem command (`npm install -g jevmem`, 0.7.5 or newer, since the pane reads files that version writes), a project that is turned on (`jevmem setup` there), and Claude Code 2.1.299 or newer. Claude Code's mod API is early access and changes between releases; the pane's tests pass on 2.1.299, 2.1.300, 2.1.301 and 2.1.302 ([results](../results/pane-tests-2026-10-17-v075.txt)). An older Claude Code ignores the pane without an error (2.1.280 and 2.1.273 run the session and never load it); 2.1.286 and 2.1.287 refuse the module because their validator did not yet follow a value handed to a function in another file of the mod, which 2.1.299 fixed.

## What it shows

The pane has three blocks, drawn again after each prompt, each guarded tool call and each turn.

**Recalled for this prompt.** Each line jevmem put in front of Claude for this prompt, in the order it was injected: the line's id, its kind in brackets and its text, with `why`, `wrong` and `forget` under it. A line the poisoning gate withheld shows as a dim row with the gate's reason. The last row counts: `2 served · 0 withheld · 0 gated · Jev 285 ms`, or `word match: Jev did not answer` when the prompt was served by shared words instead. Before your first prompt it says `no prompt yet`; when no line fit, `no line fits this prompt`; in a project with no memory line yet, `no memory lines yet`; when the file on disk is another prompt's (or missing), `nothing for this prompt`.

**The guard.** The last call the guard asked about or denied in this session: the tool and the decision (`Bash denied (block)`), whether it was the call just made (`this call`) or an earlier one (its time), then each rule the guard matched with its id, score and text (`xwsf9w 0.99 Never commit .env files`, `(unverified)` for a rule not written by jevmem on this machine), and the command or edit it looked at. `why` shows the rule's own decision, `log` the guard's recent asks and denials. When the last checked call passed, a dim row says so: `last call: Write allowed (no rule)`. Before any checked call: `no checked call yet`.

**Saved last turn.** The line the turn saved, as `id [kind] text`, with `why`, `wrong` and `forget`; `supersedes <id>` under it when the turn reversed an earlier line. A turn that saved nothing says why in plain words and, since 0.7.6, offers `missed`: after a confirm it runs `jevmem missed` with the prompt as you typed it, which labels the turn and adds the line: `Not saved: nothing worth keeping`, `Not saved: small talk`, `Not saved: already in memory as <id>`, `Not saved: it read as instructions aimed at an AI`, `Not saved: too little of a fact in it`, `Not saved: not important enough`, `Not saved: an empty turn`; a turn whose background subagents are still running says `Waiting: 1 background subagent has not reported back`; a decision that failed says `Failed:` and the error. The decision's own reason, with every score, stays behind `why`. From the moment you send a prompt until the decision lands the block says `saving…`.

## The buttons

- **why** runs `jevmem why <id>` (or `jevmem why <hash>` for a turn that saved nothing) and shows its output under the block, with a `close` button. It changes nothing.
- **forget** asks first: `Retire ab12cd? It stays in JEVMEM.md as [retired]. [n] no [y] yes`. `yes` runs `jevmem forget ab12cd` and shows what the command printed; `no` puts the buttons back and nothing ran.
- **wrong** asks the same way (`Label ab12cd as wrong and retire it?`) and runs `jevmem wrong ab12cd --should-be none`: the line is labelled wrong, which `jevmem fit` learns from, and retired.
- **A rule is retired in a terminal only.** On a `[constraint]` line the two buttons show no confirm; they say `a rule is retired in a terminal: jevmem forget ab12cd`. The CLI answers a yes on a terminal only, with no flag to skip that, as `jevmem trust` works; the pane keeps to it.
- The pane passes an id to the command only when it is one (six letters or digits, as `JEVMEM.md` has them) and came from the file it read; anything else shows `not a memory id` and nothing runs. An id the command does not know is refused by the command, and the pane shows its line.
- Every command runs by argument vector, never through a shell, in the session's folder, with a 15 s limit. The pane finds the command as the plugin's launcher does: on the session's PATH, then the usual bin folders, then the newest Node under `~/.nvm`; in a project set up with `jevmem init` it reads the Node and `cli.js` from the hook command in `.claude/settings.local.json`. With no command found, a button says so and runs nothing.

## Where it shows

- **The terminal.** Claude Code places a pane the plugin opened by itself from 144 columns (the session's start), and keeps it waiting below that. `/jevmem` opens or closes it at any width: docked beside the chat from 110 columns in the fullscreen terminal (the default since 2.1.302), above the prompt in a framed box below that. Measured on 2.1.302: placed at once at 160 columns; waiting at 120 and 100, then docked at 120 (49 columns for the pane) and inline at 100; docked at 112 after `/jevmem` ([results](../results/pane-probe-2026-10-17.json)).
- **The desktop app's Code tab.** The app attaches its surface after the mod has loaded, so the pane opens when the surface attaches (or at your first prompt, whichever comes first) and docks beside the chat; on 2026-10-17, with the app's engine 2.1.299, it docked at 51 columns.
- **Not drawn:** Claude Code for VS Code attaches no surface for panes yet, so the hooks run and nothing shows; Cursor has no pane at all; a `claude -p` run draws nowhere.

## What it reads, and when

The pane reads three files the jevmem CLI writes in the project's gitignored `.jevmem/` folder ([docs/hooks.md](hooks.md#local-files-for-the-pane)) and nothing else about your project:

- `.jevmem/last-recall.json` once the prompt has entered the session (Claude Code's `prompt.submit`, after the `UserPromptSubmit` hook ran). The file is the prompt's when its `prompt_hash` is the hash of the text you typed and, since 0.7.6, its `session_id` is this session's (two sessions in one project can send the same prompt); it is the prompt's when its `prompt_hash` is the hash of the text you typed. Measured on 2026-10-17 across five sessions: the file was there with the prompt's hash on 11 of 11 prompts in a project with a memory line, and absent on 4 of 4 first prompts in a project with none, which is why 0.7.5's CLI now writes it on every prompt with the count of lines.
- `.jevmem/guard-log.jsonl` once a Bash, Edit or Write call returned (`tool.call`), searched from the end for the call's `tool_use_id`: found on 11 of 11 guarded calls.
- `.jevmem/last-decision.json` at the end of the turn (`turn.complete`). The `Stop` hook hands the turn to a background process, so the decision was never there yet at the end of the turn (15 of 15) and landed 520 to 799 ms later; the pane polls every 250 ms for up to 15 s. The file is this turn's when its `prompt_hash` or `session_id` says so (0.7.5's fields), or by its time. After 15 s with nothing, the pane says what the queue or the log says: `queued for retry: <the Jev error> (attempt 1)` when the turn waits in `.jevmem/queue.jsonl` for a retry (a Jev outage), `failed: <the error>` when `.jevmem/log.jsonl` has a hook error for the turn, else `not decided yet`. A turn the Stop hook could not decide at once (an empty turn, or one whose background subagents are still running) is written to the file by the CLI, so the pane says so without waiting.

## What it never does

The pane sends nothing anywhere and reads no key: it reads the three files above, `jevmem.config.json` (to know the project is on) and `.claude/settings.local.json` (to find the command), and runs the jevmem command with `why`, `forget`, `wrong --should-be none` and `guard log` as you, after your yes for the two that change `JEVMEM.md`. Its view lives in Claude Code's session state, in memory, so a reload of the plugin keeps it; nothing of the pane is written to disk. `jevmem trust`, `add`, `import` and `setup` stay in the terminal.

## How it is tested

`pane/tests/pane.test.tsx` runs under `claude plugin test`, Claude Code's own kit, each case on the `terminal` and the `desktop` surface: 60 tests since 0.7.6 (the `missed` button and the session check added four; [results](../results/pane-tests-2026-10-19-v076.txt)). The files the pane reads are answered from real captures (13 files copied unchanged from e2e sessions of 2026-10-17: recall files with two, one and no lines served, the guard's deny and ask, saved, superseding and skipped decisions) and from a few hand-written shapes the captures did not produce, each named as such in `pane/tests/fixtures/README.md`. The cases: each block filled; each empty state; `forget` and `wrong` asking first, cancelled, then run once with the right arguments; a rule refused; an id that is not one refused before anything runs; `saving…` and the decision landing; the three states after the 15 s limit; the pane opening once a surface attaches or at the first prompt; `/jevmem`. `pnpm pane:check` runs `claude plugin validate --strict pane` and the tests on the Claude Code installed; CI runs them on a pinned Claude Code binary checked against its published checksum ([ci.yml](../.github/workflows/ci.yml)).

## Limits

- Claude Code only, 2.1.299 or newer; nothing in Cursor or VS Code (above).
- A project with two Claude Code sessions open at once: the decision file names its session since 0.7.5, so the pane shows only its own session's decisions; the recall file is matched by the prompt's hash, so two sessions sending the same prompt would show each other's recall.
- The pane shows what the files hold; it is as right as the hooks were. A hook that did not run (no key, the project off, a CLI older than 0.7.5) leaves the pane on its empty states.
