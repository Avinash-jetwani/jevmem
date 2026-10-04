---
path: /jev/
description: jevmem uses Jev, a model by TypeSafe AI, to decide what in a Claude Code chat is worth saving, which saved lines a prompt needs, and whether a command may break a saved rule.
order: 4
---
# What is Jev used for in coding agents, and how does jevmem use it?

In jevmem, Jev (a model by TypeSafe AI) is what decides: it scores each message of a Claude Code chat so that jevmem can tell whether it holds a decision, a rule or a failed approach worth saving, it picks the saved lines that bear on your next prompt, and it judges whether a command or a file edit may break a saved rule.

Deciding what to save takes 0.28 s and costs $0.00016 per message, and was right on save or skip for 98.5% of 66 held-out turns (jevmem 0.6.0, one run on 2026-09-30, [results](../../results/eval-heldout-2026-09-30-v060.json)). This page covers only what jevmem does with Jev. What Jev itself is: [TypeSafe's docs](https://docs.typesafe.ai) and [their launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev).

## How jevmem asks Jev

{{include README.md#how-it-decides}}

## The three places jevmem calls Jev

- **After each turn, to decide what to save.** One request of small typed questions; a second, larger set only when the first is unsure. Thresholds in `jevmem.config.json` turn the probabilities into save or skip ([how it works](../../docs/how-it-works.md#the-decider-two-tiers-srcdecidets-srcquestionsts-srccombinets)).
- **On each prompt, to pick the lines to bring back.** Each live line, up to 250 of them, is asked about on its own, and at most five go to Claude ([the read side](../../docs/how-it-works.md#the-read-side-one-call-per-prompt-srcrecallts)).
- **Before a Bash, Edit or Write call, to check it against your rules.** Only for a call that shares a path, a command or enough words with a saved rule ([the guard](guard.md)).

Jev also checks lines that jevmem did not write on your machine, such as a teammate's or a pull request's, before they reach Claude ([what leaves your machine](privacy.md)).

## Why Jev and not an LLM

{{include docs/benchmark.md#why-jev-and-not-an-llm}}

## Fast and cheap, measured

{{include README.md#fast-and-cheap}}

## A local model in Jev's place

jevmem was tried once against a local model server, Ollaya 0.9.0, on an Apple M4 with 16 GB, on 2026-10-02, next to a Jev run of the same set the same afternoon. On the 66 held-out turns, in jevmem's default mode, Jev was right on save or skip for 65/66 at a median of 0.23 s a turn; `winnow:e4b` for 60/66 at 28.5 s; `laya:typed-decisions` for 19/66. This was one run each on one Mac, with two models, on a set written for Jev's behaviour ([Jev](../../results/local-model-2026-10-02-jev.json), [winnow:e4b](../../results/local-model-2026-10-02-winnow-e4b.json), [laya:typed-decisions](../../results/local-model-2026-10-02-laya-typed-decisions.json)). A local model is not a supported mode ([FAQ](faq.md#can-jevmem-run-on-a-local-model)).

## Set it up

Jev needs a TypeSafe API key, and jevmem sends message text to TypeSafe to be scored, with common secrets scrubbed first. The four steps: [install](install.md).
