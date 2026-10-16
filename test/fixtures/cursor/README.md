# Cursor hook payloads, captured

Real payloads from Cursor's hooks, written by a logging-only hook (`.cursor/hooks/log.sh <event>`: the payload, the
hook's arguments and Cursor's variables, nothing else) in a scratch copy of eval/stops/projects/farecalc, on
2026-10-16. Paths are replaced by `<project>`, `<project-slug>` and `<home>`, the account's email by `user@example.com`.

- `app-r6/`: the Cursor app 3.24.18 (model `grok-4.7-xhigh`, `model_params` context 500k), two turns in one chat:
  "Say the word ready, then list the files with the shell tool, then say the word done." and "Say the word again,
  then stop." Every event the app fired, in order (the file names sort by time): `sessionStart`, `beforeSubmitPrompt`,
  `afterAgentThought`, `preToolUse`, `beforeShellExecution`, `afterShellExecution`, `postToolUse`, `afterAgentResponse`
  (once per turn, the final text), `stop` (`status: completed`); and the same payloads passed to Claude Code-format hooks
  in `.claude/settings.json` (`cc-SessionStart`, `cc-UserPromptSubmit`, `cc-Stop`), which Cursor runs with its own event
  names. `*.transcript` is the copy of `transcript_path` taken when that hook ran.
- `cli-r1/`: the `agent` CLI 2026.08.11 headless (`agent -p --trust --force --output-format stream-json`), the first
  prompt: `sessionStart`, the tool hooks, `afterAgentThought`, `sessionEnd` (`reason: completed`); no
  `beforeSubmitPrompt`, `afterAgentResponse` or `stop`, and no Claude-format hook.

The probe that produced them is described in `.reports/release-0.7.4.md` (Part 1).
