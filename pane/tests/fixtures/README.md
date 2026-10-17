# Fixtures for the pane's tests

Real files captured on 2026-10-17 from the e2e harness's scratch projects (Claude Code 2.1.302, claude-sonnet-5-5), copied unchanged (`.reports/0.7.5-captures/` in the release clone has every version). `fixtures.ts` embeds them for the tests, since a test runs with no file system.

| File | From | What it is |
|---|---|---|
| `recall-served-2.json` | `jevmem-e2e.FewaHE.last-recall.json.045` | deadend session 2's prompt: two lines served (a dead end and a decision) |
| `recall-served-1-gated.json` | `jevmem-e2e.FewaHE.last-recall.json.039` | deadend session 1's prompt: one line served, two gated |
| `recall-served-1.json` | `jevmem-e2e.QnOldZ.last-recall.json.009` | linkguard turn 3 (the reversal): the sideload decision served |
| `recall-served-0.json` | `jevmem-e2e.QnOldZ.last-recall.json.005` | linkguard turn 2: nothing served |
| `decision-saved.json` | `jevmem-e2e.QnOldZ.last-decision.json.008` | linkguard turn 2: the sideload decision saved |
| `decision-saved-supersedes.json` | `jevmem-e2e.QnOldZ.last-decision.json.012` | linkguard turn 3: the reversal, superseding the sideload decision |
| `decision-saved-constraint.json` | `jevmem-e2e.CHdKiL.last-decision.json.026` | guard A0: the .env rule saved as a constraint |
| `decision-saved-dead-end.json` | `jevmem-e2e.FewaHE.last-decision.json.041` | deadend session 1: a dead end saved from the reply |
| `decision-skipped.json` | `jevmem-e2e.QnOldZ.last-decision.json.014` | linkguard turn 4 (thanks): skipped |
| `decision-skipped-injection.json` | `jevmem-e2e.QnOldZ.last-decision.json.016` | linkguard turn 5 (the injection): skipped |
| `guard-deny.jsonl` | `jevmem-e2e.CHdKiL.guard-log.jsonl.028` | guard A: five passed calls and the deny of git add .env (mode block) |
| `guard-ask.jsonl` | `jevmem-e2e.vwX8BJ.guard-log.jsonl.034` | guardgit A: the ask on git add -A under an unverified rule |
| `guard-none.jsonl` | `jevmem-e2e.G0zlCb.guard-log.jsonl.022` | handwrite: four Write calls, no rule |

Written by hand for shapes the captures did not produce (said so here, and in the tests):

| File | What it stands for |
|---|---|
| `decision-duplicate.json` | a turn whose line restates a saved one (`duplicate_of`), from `decision-skipped.json` |
| `decision-deferred.json` | 0.7.5's write when the Stop hook keeps a turn whose background subagents are still running |
| `decision-empty-turn.json` | 0.7.5's write when the Stop hook finds an empty turn |
| `decision-error.json` | a decision that ended in an error |
| `recall-no-lines.json` | 0.7.5's write for a prompt in a project with no memory line (`lines: 0`) |
| `recall-bad-id.json` | a served line whose id is not an id (`../x`): the pane must draw no button for it |
| `queue-retry.jsonl` | `.jevmem/queue.jsonl` with the turn waiting for a retry after a Jev failure |
| `log-failed.jsonl` | `.jevmem/log.jsonl` with a hook error for the turn |
| `settings-init.json` | a `jevmem init` project's `.claude/settings.local.json`, where the pane reads the CLI's path |
