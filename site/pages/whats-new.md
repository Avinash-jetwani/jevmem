---
path: /whats-new/
description: jevmem 0.7.0 (2026-10-09) adds jevmem forget, jevmem trust and dedupe on save; 0.6.0 (2026-09-30) added the guard, dead ends and better recall, and 0.6.6 saves a failed attempt as a dead end instead of the request.
order: 13
---
# What changed in each version of jevmem?

jevmem 0.7.0 (2026-10-09), the current release, is memory you can see and fix: `jevmem forget <id>` retires a line in place (it stays in `JEVMEM.md` as `[retired]`, and nothing serves or enforces it), `jevmem trust <id>` marks a line you wrote as verified so the guard can block on your own rules, a line that says the same as a live one is not saved again, and a leading `[constraint]` or `[rule]` tag is no longer part of a line. On a held-out set of 25 restatements written before the code, 0.6.6 saved 15 as new lines and 0.7.0 saves 1, with reversals, restatements that add a detail and restated retired lines unchanged (one run on each, 2026-10-08: [0.6.6](../../results/dupes-heldout-2026-10-08-v066.json), [0.7.0](../../results/dupes-heldout-2026-10-08-v070.json)); on 24 held-out texts with a tag in front, 0 of 18 tags were stripped on 0.6.6 and 18 of 18 are on 0.7.0 ([results](../../results/tagstrip-heldout-2026-10-08-v070.json)). One more question rides on each turn's request ([privacy](privacy.md)).

jevmem 0.6.0 (2026-09-30) added the guard, dead ends, better recall and saving that waits for background subagents; 0.6.1 to 0.6.3 brought a guard fix for `if [ … ]` in a command and a clearer `jevmem doctor`; 0.6.4 (2026-10-01) changed the docs only; 0.6.5 (2026-10-05) keeps a dead end's reason when Claude's reply gives the verdict first and the cause last; and 0.6.6 (2026-10-06) saves a failed attempt as a dead end instead of as the request: when you ask Claude to try or change something and its reply says that failed and why, jevmem reads the reply and saves the dead end. On 40 written held-out failed attempts, 0.6.5 saved 12 as dead ends and the request itself as a decision or a to-do in 21; 0.6.6 saves 37 and 2 (one run on each, 2026-10-06: [0.6.5](../../results/attempts-heldout-2026-10-06-v065.json), [0.6.6](../../results/attempts-heldout-2026-10-06-v066.json)); on 47 captured from real Claude Code sessions, 28 and 15 against 37 and 3. For that it sends Claude's reply on more turns ([privacy](privacy.md)).

The guard, the largest addition in 0.6, caught 66 of 68 rule breaks with 3–4 false asks in 206 fine calls on a held-out set of 274 tool calls (run once on 0.6.0 and once on 0.6.1, on 2026-09-30: [0.6.0](../../results/guard-heldout-v2-2026-09-30.json), [0.6.1](../../results/guard-heldout-v2-2026-09-30-v061.json)). To upgrade: `npm install -g jevmem@latest` ([every install path](install.md#upgrading)).

The rest of this page is the repository's [docs/whats-new.md](https://github.com/Avinash-jetwani/jevmem/blob/main/docs/whats-new.md), then every version in the [CHANGELOG](../../CHANGELOG.md).

{{include docs/whats-new.md}}

## Every version

{{versions}}
