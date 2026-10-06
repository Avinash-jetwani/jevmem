---
path: /whats-new/
description: jevmem 0.6.0 (2026-09-30) added the guard, dead ends and better recall. 0.6.1 to 0.6.5 fixed the guard, jevmem doctor and the dead-end line, and 0.6.6 (2026-10-06) saves a failed attempt as a dead end instead of the request.
order: 13
---
# What changed in each version of jevmem?

jevmem 0.6.0 (2026-09-30) added the guard, dead ends, better recall and saving that waits for background subagents; 0.6.1 to 0.6.3 brought a guard fix for `if [ … ]` in a command and a clearer `jevmem doctor`; 0.6.4 (2026-10-01) changed the docs only; 0.6.5 (2026-10-05) keeps a dead end's reason when Claude's reply gives the verdict first and the cause last; and 0.6.6 (2026-10-06), the current release, saves a failed attempt as a dead end instead of as the request: when you ask Claude to try or change something and its reply says that failed and why, jevmem reads the reply and saves the dead end. On 40 written held-out failed attempts, 0.6.5 saved 12 as dead ends and the request itself as a decision or a to-do in 21; 0.6.6 saves 37 and 2 (one run on each, 2026-10-06: [0.6.5](../../results/attempts-heldout-2026-10-06-v065.json), [0.6.6](../../results/attempts-heldout-2026-10-06-v066.json)); on 47 captured from real Claude Code sessions, 28 and 15 against 37 and 3. For that it sends Claude's reply on more turns ([privacy](privacy.md)).

The guard, the largest addition in 0.6, caught 66 of 68 rule breaks with 3–4 false asks in 206 fine calls on a held-out set of 274 tool calls (run once on 0.6.0 and once on 0.6.1, on 2026-09-30: [0.6.0](../../results/guard-heldout-v2-2026-09-30.json), [0.6.1](../../results/guard-heldout-v2-2026-09-30-v061.json)). To upgrade: `npm install -g jevmem@latest` ([every install path](install.md#upgrading)).

The rest of this page is the repository's [docs/whats-new.md](https://github.com/Avinash-jetwani/jevmem/blob/main/docs/whats-new.md), then every version in the [CHANGELOG](../../CHANGELOG.md).

{{include docs/whats-new.md}}

## Every version

{{versions}}
