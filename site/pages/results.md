---
path: /results/
nav: Results
description: In 72 real Claude Code sessions, Claude followed the project's saved decision in 66 with jevmem, 28 with no project memory and 67 with a hand-written CLAUDE.md. Every result, with its method and limits.
order: 10
---
# Does jevmem work?

In 72 real Claude Code sessions, Claude followed the project's saved decision in 66 with jevmem (66/72), against 28 with no project memory (28/72) and 67 with the same lines in a hand-written `CLAUDE.md` (67/72): jevmem does about as well as a hand-written `CLAUDE.md`, without you writing it.

Every test set here was written by the author, and none is an independent benchmark. Each result below says what it was measured on, links its results file in the repository, and says what it does not show. To try it yourself: [install](install.md).

## Does Claude act on the saved line?

{{include README.md#does-it-work}}

**Method.** 24 tasks in three small projects (a TypeScript API, a React front end, a plain-JavaScript CLI), each with a project memory of 34 to 42 lines. Each task's right answer depends on one saved line that the repository does not state. Every session is real Claude Code (`claude -p`, Claude Code 2.1.281, `claude-sonnet-5`) in a fresh copy of the project, three runs per task and arm. A check written and committed before any session ran decides whether the line was followed; there is no LLM judge. The no-memory and `CLAUDE.md` arms ran on 2026-09-28 ([results](../../results/ab-2026-09-28.json)), and the jevmem arm ran on 2026-09-29 on the recall code that ships in 0.6 ([results](../../results/ab-jevmem-2026-09-29-3b.json)). The full method and every row: [docs/benchmark.md](../../docs/benchmark.md#outcome-ab-does-claude-act-on-the-memory).

**Limits.** Three small projects, one model, sessions of at most 25 turns, three runs per task. `CLAUDE.md` did better on a convention nothing in the prompt points at (3 of 3 sessions against 0 of 3). The checks test whether the saved line was followed, not whether Claude's answer was better.

## Does the guard catch rule breaks?

On the guard's second held-out set, 274 tool calls in five new projects, the guard caught 66 of 68 rule breaks (66/68) and asked about 3–4 of the 206 calls that break no rule. The set was written after a day's trial of the guard in jevmem's own repository, before the fixes it measures, and was run once on the 0.6.0 build and once on the 0.6.1 build, both on 2026-09-30 ([0.6.0](../../results/guard-heldout-v2-2026-09-30.json), [0.6.1](../../results/guard-heldout-v2-2026-09-30-v061.json)). The one call that differs between the two runs breaks no rule and scored either side of the threshold.

In real Claude Code sessions on the A/B's 6 constraint tasks (18 sessions, rerun on the release build on 2026-09-30 with Claude Code 2.1.284), Claude did not attempt the forbidden change in any session (0/18; 10/18 with no memory in the 2026-09-28 run), and the guard checked all 78 of those sessions' Bash, Edit and Write calls and asked once ([results](../../results/ab-guard-2026-09-30.json)).

**Limits.** The guard looks at the words a rule and a call share. A script or a make target that already exists and does the forbidden thing is missed, and so is a call that shares a single word with its rule. It checks Bash, Edit and Write calls, not MCP tools or the files a script changes when it runs. More: [the guard's limits](guard.md#limits).

## Is deciding what to save fast, cheap and right?

{{include README.md#fast-and-cheap}}

## Does the right line come back?

On the second retrieval held-out set (90 prompts over three new projects of 20, 80 and 250 lines, run once on 2026-09-28), jevmem 0.6's recall found 75/78 of the lines the prompts needed, and 0.5.9 found 55/78. Of those 78 lines, 18 are dead ends, which 0.5.9 cannot read; on the other 60, 0.6 found 57 and 0.5.9 found 55. Of the lines 0.6 put in front of Claude, 96/97 were wanted or fine, and 1/18 unrelated prompts got a line ([0.6](../../results/recall-heldout2-2026-09-28-now.json), [0.5.9](../../results/recall-heldout2-2026-09-28-v059.json)).

**Limits.** Prompts that need two lines got both in 3 of 6. With more than 250 live lines, only the 250 that share the most words with the prompt are asked about (on a 500-line dev file, recall was 37/46). That the right lines reach Claude is tested; whether its answers get better is not.

## Dead ends, background subagents and planted lines

- **Dead ends.** On decide's third held-out set (100 turns in five new projects, run on the release build on 2026-09-30), jevmem saved 25 of 25 dead ends, each with its reason ([results](../../results/dead-ends-heldout-v3-2026-09-30-v060.json)).
- **Background subagents.** On 30 real Claude Code 2.1.281 sessions, 14 of them with a background subagent, replayed through the 0.6.0 build on 2026-09-30, turns were saved or skipped right in 32 of 33 (0.5.9: 27 of 33) ([results](../../results/stops-heldout-v4-2026-09-30-v060.json)).
- **Planted lines.** On a 44-line test set (2026-09-25), the check on lines jevmem did not write blocked 20 of 22 planted lines, with 0 false blocks on 22 legitimate rules; the 2 it missed were instructions disguised as normal process ([results](../../results/memory-injection-2026-09-25-run1.json)).

## Can a local model do Jev's job?

Not well enough to offer, in the one test so far. On 2026-10-02, jevmem 0.6.4 was pointed at a local model server, Ollaya 0.9.0, on an Apple M4 with 16 GB, next to a Jev run of the same set the same afternoon. On the 66 held-out turns, in jevmem's default mode, Jev was right on save or skip for 65/66 turns at a median of 0.23 s a turn; `winnow:e4b` for 60/66 at 28.5 s; `laya:typed-decisions` for 19/66.

The results files: [Jev](../../results/local-model-2026-10-02-jev.json), [winnow:e4b](../../results/local-model-2026-10-02-winnow-e4b.json), [laya:typed-decisions](../../results/local-model-2026-10-02-laya-typed-decisions.json). The commands as run: [scripts/local-model-jev.sh](../../scripts/local-model-jev.sh), [scripts/local-model-ollaya.sh](../../scripts/local-model-ollaya.sh).

**Limits.** One run each, on one Mac, with two models. The set was written for Jev's behaviour. Both local models needed the client's timeout raised from 10 s to 180 s. `winnow:e4b` was measured on these 66 turns only, not on recall or the guard.

## What these results do not show

{{include docs/limits.md#honest-limits}}
