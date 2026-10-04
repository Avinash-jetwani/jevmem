---
path: /faq/
nav: FAQ
description: jevmem needs a TypeSafe API key, costs $0.00016 per message to decide what to save, is not supported on local models, and shares its memory file with your team through git.
order: 12
---
# Does jevmem need a key, what does it cost, and what are its limits?

jevmem needs a TypeSafe API key; deciding what to save costs $0.00016 per message on that key; a local model is not a supported mode; your team gets the memory file through git; and the known limits are listed at the end of this page.

The cost is the average over 66 held-out turns with jevmem 0.6.0, one run on 2026-09-30, at TypeSafe's listed price for Jev ([results](../../results/eval-heldout-2026-09-30-v060.json)). To set jevmem up: [install](install.md).

## Do I need a key?

Yes: jevmem needs a [TypeSafe API key](https://console.typesafe.ai/keys), because Jev, the model that decides what to save, runs on TypeSafe's API. `jevmem key` saves it in `~/.jevmem/env`, readable only by you. You need no OpenAI or Anthropic key: jevmem writes each line itself unless you set `writer` in `jevmem.config.json`.

## What does it cost?

jevmem itself is free and open source (MIT). The requests it makes to Jev are billed by TypeSafe to your key.

- **Deciding what to save** costs $0.00016 per message (66 held-out turns, jevmem 0.6.0, 2026-09-30, [results](../../results/eval-heldout-2026-09-30-v060.json)).
- **Bringing lines back** costs more as the file grows: 300 prompts a day is about $0.03 with 18 live lines, $0.09 with 74 and $0.28 with 220 (the retrieval held-out set's files, run through the real hook on 2026-09-28, [results](../../results/recall-heldout-2026-09-28-now.json)).

Both are input tokens at $0.042 per million, the price in TypeSafe's launch post; check TypeSafe's own pricing for what your key is charged. Every request is logged in `.jevmem/log.jsonl`, and `jevmem stats` adds them up. The whole table: [docs/cost.md](../../docs/cost.md).

## Can jevmem run on a local model?

Not as a supported mode. It was tried once, on 2026-10-02, with a local model server, Ollaya 0.9.0, on an Apple M4 with 16 GB, next to a Jev run of the same set the same afternoon. On the 66 held-out turns, in jevmem's default mode, Jev was right on save or skip for 65/66 turns at a median of 0.23 s a turn; `winnow:e4b` for 60/66 at 28.5 s; `laya:typed-decisions` for 19/66.

The results files: [Jev](../../results/local-model-2026-10-02-jev.json), [winnow:e4b](../../results/local-model-2026-10-02-winnow-e4b.json), [laya:typed-decisions](../../results/local-model-2026-10-02-laya-typed-decisions.json). The limits of that test: one run each, on one Mac, with two models; the set was written for Jev's behaviour; and `winnow:e4b` was measured on these 66 turns only, not on recall or the guard.

## Does my team get the memory through git?

Yes: `JEVMEM.md` is a file in your repo, so your team gets the same file through git, and a change to it can be reviewed in a pull request like code. Lines a teammate or a pull request adds are checked before Claude sees them: on a 44-line test set (2026-09-25), that check blocked 20 of 22 planted lines, with 0 false blocks on 22 legitimate rules ([results](../../results/memory-injection-2026-09-25-run1.json)). The scores behind each line stay on the machine that saved it, in `.jevmem/`, which is not in git.

## Which tools does it work with?

{{include README.md#works-with}}

## What leaves my machine?

Message text is sent to TypeSafe to be scored, with common secrets scrubbed first, and only from a project you have turned on. The whole list: [What leaves my machine?](privacy.md)

## What are jevmem's limits?

{{include docs/limits.md +1}}
