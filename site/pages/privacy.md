---
path: /privacy/
description: From a project you have turned on, jevmem sends message text to TypeSafe to be scored, with common secrets scrubbed first. From other projects it sends nothing, and it has no telemetry.
order: 11
---
# What leaves my machine?

From a project you have turned on, jevmem sends message text to TypeSafe to be scored, with common secrets scrubbed first: your message, the previous two turns and your memory lines, and, for the guard, the command or the file being changed. From a project you have not turned on it sends nothing; it has no telemetry; and it sends nothing to OpenAI or Anthropic unless you set `writer` in `jevmem.config.json`.

Memory lines that a teammate or a pull request adds are checked before Claude sees them: on a 44-line test set (2026-09-25), that check blocked 20 of 22 planted lines, with 0 false blocks on 22 legitimate rules ([results](../../results/memory-injection-2026-09-25-run1.json)). The scrubber matches patterns, so a secret written in a form it does not know can get through, and names, phone numbers and addresses are not removed.

The rest of this page is the repository's [PRIVACY.md](https://github.com/Avinash-jetwani/jevmem/blob/main/PRIVACY.md), as it stands. To set jevmem up: [install](install.md).

{{include PRIVACY.md}}
