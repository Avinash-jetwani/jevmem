# Privacy

Last updated: 2026-09-28

This page describes jevmem 0.5.9, the release on npm, which has the same code as 0.5.8; parts marked "on `main`, not released yet (coming in 0.6)" describe `main`.

jevmem reads your prompts and parts of your Claude Code conversations (and, for the guard on `main`, not released yet, the shell commands and file edits Claude is about to make). It stores some of that text on your machine and sends it to the services listed below. Prompts can contain personal data, so this page says what goes where. [SECURITY.md](SECURITY.md) has the full detail.

## Who

jevmem is an open-source tool (MIT licence) by Avinash Jetwani. It runs on your machine. I run no server, and jevmem sends nothing to me. There is no telemetry: no analytics, no usage reports, no call home.

## What leaves your machine, and where

Only from a project you have enabled (`jevmem enable` or `jevmem init`, which create `jevmem.config.json`), and only when a TypeSafe API key is set. From any other project jevmem sends nothing (tested).

Before anything is sent, secrets are replaced with `[REDACTED]` by pattern matching: API keys and tokens in the shapes of OpenAI, Anthropic, GitHub, GitLab, Slack, AWS, Google, Stripe, npm and Hugging Face keys, JWTs and bearer tokens; the value after a name that ends in PASSWORD, PASSWD, PWD, SECRET, TOKEN or KEY, such as `DB_PASSWORD=`, `PGPASSWORD=`, `apiKey:` or `"authToken":`; passwords in connection strings; private keys; email addresses; and 16-digit, card-shaped numbers. The exact rules are in [SECURITY.md](SECURITY.md#what-is-scrubbed). Names such as `PGPASSWORD`, with no underscore before the word, and the `"name": "value"` form are caught since 0.5.8: 0.5.7 and earlier sent `PGPASSWORD=…` and `"password": "…"` as written, so if your chats in an enabled project had such lines, rotate those credentials ([advisory GHSA-2r3p-5hmg-46p5](https://github.com/Avinash-jetwani/jevmem/security/advisories/GHSA-2r3p-5hmg-46p5), [CHANGELOG](CHANGELOG.md#058---2026-09-28)). Because it only matches patterns, a secret written in a form it doesn't know can still get through, and people's names, phone numbers and postal addresses are not removed at all, so don't put anything in a prompt that you don't want sent.

**To TypeSafe AI**, at `https://api.typesafe.ai/v1/systemone`, or the URL in `TYPESAFE_BASE_URL` if you set one. TypeSafe's Jev model decides what to save and what to recall.

- After each turn (in Claude Code, or in Codex while `jevmem watch` runs): your message, the previous two turns (shortened) and up to 200 of your memory lines. Claude's reply is included only when a broad keyword check reads your message as a question or a bug report, or when it has no text.
- On each prompt: the prompt and up to 60 of your memory lines.
- Before a Bash, Edit or Write call, from the guard ([docs/guardrails.md](docs/guardrails.md); on `main`, not released yet, coming in 0.6): only for a call that shares a path, filename, command or enough words with one of the project's saved `[constraint]` rules. It sends the command, or the file path plus a short scrubbed snippet of the change (at most 600 characters of the new text and 300 of the replaced text), and those rules. For `git add`, `git stage` and `git commit`, the guard first runs `git status` on your machine to see which files the command would stage or commit; of those, it sends only the paths (at most 10) of the ones a rule about committing names, such as `.env (untracked)`, and keeps none of the list. Nothing is sent for a call that shares nothing with a rule, when the answer is already cached, or when `guard.mode` is `off`.
- When you or the agent use the MCP tools or `jevmem` commands: a line to add, your memory lines, statements from `CLAUDE.md`, `AGENTS.md` and Cursor rules (`jevmem import`), and for `jevmem audit` the project's file names to depth 3 (not their contents), `package.json` fields and the first 3,000 characters of the README.

**To OpenAI** (`https://api.openai.com`) **or Anthropic** (`https://api.anthropic.com`), or the URL in `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL`, only when the project's `jevmem.config.json` sets `"writer": "openai"` or `"anthropic"` and that provider's key is set. Then, for each turn Jev decides to save, the text of that turn, to condense it into one line. A key in your environment is not enough on its own (tested). By default jevmem writes the line itself and sends nothing to either.

These are the only network calls in jevmem's code (a test checks the source for others).

## Third parties

The data goes to these services under your own API key. What they do with it is governed by their own terms and privacy policies, not by jevmem:

- TypeSafe AI: [privacy policy](https://typesafe.ai/legal/privacy-policy), [terms of use](https://typesafe.ai/legal/terms)
- OpenAI: [privacy policy](https://openai.com/policies/privacy-policy/), [services agreement](https://openai.com/policies/services-agreement/)
- Anthropic: [privacy policy](https://www.anthropic.com/legal/privacy), [commercial terms](https://www.anthropic.com/legal/commercial-terms)

jevmem can ask for zero data retention on each TypeSafe request (`"jev": { "zeroDataRetention": true }` in `jevmem.config.json`). Whether it applies is TypeSafe's policy, which jevmem does not check.

## What's stored, and where

All of it on your machine:

- **`JEVMEM.md`**, in the project: the memory lines. It is meant to be committed, so everyone with access to the repository can read it.
- **`.jevmem/`**, in the project, local and gitignored: a copy of the memory lines, a log of each Jev call and of any line the poisoning check withheld, the save queue and recent decisions with the scrubbed turn text, your `right` and `wrong` labels, cached Jev answers, and hashes of the lines jevmem wrote. On `main`, not released yet (coming in 0.6), the guard also keeps its index of your rules, its cached answers (kept by hashes of the rule and the call, not the call's text) and a log, `.jevmem/guard-log.jsonl`: one line per Bash, Edit or Write call it checked, with the time, the tool and how it was decided, and for a call it asked about, denied or warned about, the rule, Jev's score and a short scrubbed summary of the command or edit. `jevmem guard log` shows it, and nothing in it is sent anywhere. With `JEVMEM_DEBUG=1`, also the raw hook input.
- **The plugin's data folder** (`~/.claude/plugins/data/…`): the paths of the jevmem CLI and Node it found and, in an enabled project without the CLI, the ids of the sessions it has shown the "CLI not found" message.
- **The system temp folder**: the `Stop` hook's input, until jevmem reads and deletes it.
- **Your TypeSafe API key**: entered in the plugin's settings (`/plugin configure jevmem`), Claude Code keeps it in your system's secure credential store, and jevmem doesn't write it to a file or a log (tested). If you put it in `~/.jevmem/env` or `<project>/.jevmem/.env` instead, it is in that file. On `main`, not released yet (coming in 0.6), `jevmem key` writes it to `~/.jevmem/env` for you: the folder and the file readable only by you, and the key never printed or logged (tested).

## How to delete it

In each project:

1. `jevmem disable` stops jevmem there. It moves `jevmem.config.json` into `.jevmem/`.
2. `jevmem daemon stop`, then delete `.jevmem/`: the logs, queue, decisions and cached answers.
3. Remove the lines you don't want from `JEVMEM.md`, or delete the file. Lines you already committed stay in your git history.
4. If you set the project up with `jevmem init`, `jevmem init --remove-hooks` removes its hooks.

Then, once:

- `claude plugin uninstall jevmem` removes the plugin. When you uninstall it from the last place it's installed, Claude Code also deletes its data folder, unless you pass `--keep-data`.
- A key you entered in the plugin's settings is held by Claude Code in the credential store, not by jevmem; remove it there. Delete `~/.jevmem/env` if you created it.
- `npm uninstall -g jevmem` removes the CLI.

Data already sent to TypeSafe, OpenAI or Anthropic is covered by their policies above.

## Contact

Questions and requests: [GitHub issues](https://github.com/Avinash-jetwani/jevmem/issues). Security problems: [private vulnerability reporting](https://github.com/Avinash-jetwani/jevmem/security/advisories/new), as [SECURITY.md](SECURITY.md#reporting-a-vulnerability) describes.
