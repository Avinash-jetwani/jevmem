---
path: /whats-new/
description: jevmem 0.6.0 (2026-09-30) added the guard, dead ends and better recall. 0.6.1 to 0.6.3 fixed the guard and jevmem doctor, and 0.6.4 (2026-10-01) changed the docs only.
order: 13
---
# What changed in each version of jevmem?

jevmem 0.6.0 (2026-09-30) added the guard, dead ends, better recall and saving that waits for background subagents; 0.6.1 to 0.6.3 brought a guard fix for `if [ … ]` in a command and a clearer `jevmem doctor`; and 0.6.4 (2026-10-01), the current release, changed the docs only.

The guard, the largest addition in 0.6, caught 66 of 68 rule breaks with 3–4 false asks in 206 fine calls on a held-out set of 274 tool calls (run once on 0.6.0 and once on 0.6.1, on 2026-09-30: [0.6.0](../../results/guard-heldout-v2-2026-09-30.json), [0.6.1](../../results/guard-heldout-v2-2026-09-30-v061.json)). To upgrade: `npm install -g jevmem@latest` ([every install path](install.md#upgrading)).

The rest of this page is the repository's [docs/whats-new.md](https://github.com/Avinash-jetwani/jevmem/blob/main/docs/whats-new.md), then every version in the [CHANGELOG](../../CHANGELOG.md).

{{include docs/whats-new.md}}

## Every version

{{versions}}
