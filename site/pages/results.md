---
path: /results/
nav: Results
description: In 72 real Claude Code sessions, Claude followed the project's saved decision in 66 with jevmem, 28 with no project memory and 67 with a hand-written CLAUDE.md. Every result, with its method and limits.
order: 11
---
# Does jevmem work?

In 72 real Claude Code sessions, Claude followed the project's saved decision in 66 with jevmem (66/72), against 28 with no project memory (28/72) and 67 with the same lines in a hand-written `CLAUDE.md` (67/72): jevmem does about as well as a hand-written `CLAUDE.md`, without you writing it.

Every test set here was written by the author, and none is an independent benchmark. Each result below says what it was measured on, links its results file in the repository, and says what it does not show. To try it yourself: [install](install.md).

## Does Claude act on the saved line?

{{include README.md#does-it-work}}

**Method.** 24 tasks in three small projects (a TypeScript API, a React front end, a plain-JavaScript CLI), each with a project memory of 34 to 42 lines. Each task's right answer depends on one saved line that the repository does not state. Every session is real Claude Code (`claude -p`, Claude Code 2.1.281, `claude-sonnet-5`) in a fresh copy of the project, three runs per task and arm. A check written and committed before any session ran decides whether the line was followed; there is no LLM judge. The no-memory and `CLAUDE.md` arms ran on 2026-09-28 ([results](../../results/ab-2026-09-28.json)), and the jevmem arm ran on 2026-09-29 on the recall code that ships in 0.6 ([results](../../results/ab-jevmem-2026-09-29-3b.json)). The full method and every row: [docs/benchmark.md](../../docs/benchmark.md#outcome-ab-does-claude-act-on-the-memory).

**Limits.** Three small projects, one model, sessions of at most 25 turns, three runs per task. `CLAUDE.md` did better on a convention nothing in the prompt points at (3 of 3 sessions against 0 of 3), which 0.7.1's always-on rules address (next). The checks test whether the saved line was followed, not whether Claude's answer was better.

## Do rules every change must follow reach Claude?

Since 0.7.1, when the line is marked always-on. In the sessions above, a convention nothing in the prompt points at was followed in 0 of 3 sessions with jevmem and 3 of 3 with `CLAUDE.md`, because jevmem brought a line back only for a prompt it bears on. 0.7.1 marks such a rule always-on (Jev reads it as a standing rule for how any work in the project is done; `jevmem always <id>` marks by hand) and sends it at the start of every session. On six held-out tasks in two new projects whose files were written before their conventions, Claude followed the convention in 10 of 18 sessions with no memory, 14 of 18 with 0.7.0 and 18 of 18 with 0.7.1, as with the same lines in a hand-kept `CLAUDE.md` (3 runs per task, real Claude Code 2.1.296 with `claude-sonnet-5`, one run per arm, 2026-10-13: [no memory, 0.7.0 and CLAUDE.md](../../results/ab-alwayson-v2-2026-10-13-v070.json), [0.7.1](../../results/ab-alwayson-v2-2026-10-13-v071.json)). On the first held-out set, 20 tasks in the same projects where the code around each task already shows its convention, 0.7.1 followed the saved line in 49 of 60 sessions, against 53 with 0.7.0, 52 with `CLAUDE.md` and 46 with no memory ([no memory, 0.7.0 and CLAUDE.md](../../results/ab-alwayson-2026-10-13-v070.json), [0.7.1](../../results/ab-alwayson-2026-10-13-v071.json)).

**Limits.** The trade-off: a rule that reads as a process ("nothing is committed straight to `main`") in every session's context made Claude stop and ask for a branch on a task that commits nothing, in 4 of 60 sessions on the first set (the same lines in `CLAUDE.md`: 2 of 60; 0.7.0, which brought the line back only when the prompt pointed at it: 0). The mark is Jev's reading or yours: on the held-out projects' 68 lines, the marking question found 17 of the 20 rules labelled always-on by hand and marked 5 unlabelled lines ([results](../../results/alwayson-marking-heldout-2026-10-13-v071.json)); rules stated as facts about one thing need `jevmem always <id>`. Two small projects, one model, one run per arm. The method and every row: [docs/benchmark.md](../../docs/benchmark.md#always-on-rules-071).

## Does the guard catch rule breaks?

On the guard's second held-out set, 274 tool calls in five new projects, the guard caught 66 of 68 rule breaks (66/68) and asked about 3–4 of the 206 calls that break no rule. The set was written after a day's trial of the guard in jevmem's own repository, before the fixes it measures, and was run once on the 0.6.0 build and once on the 0.6.1 build, both on 2026-09-30 ([0.6.0](../../results/guard-heldout-v2-2026-09-30.json), [0.6.1](../../results/guard-heldout-v2-2026-09-30-v061.json)). The one call that differs between the two runs breaks no rule and scored either side of the threshold.

In real Claude Code sessions on the A/B's 6 constraint tasks (18 sessions, rerun on the release build on 2026-09-30 with Claude Code 2.1.284), Claude did not attempt the forbidden change in any session (0/18; 10/18 with no memory in the 2026-09-28 run), and the guard checked all 78 of those sessions' Bash, Edit and Write calls and asked once ([results](../../results/ab-guard-2026-09-30.json)).

**Limits.** The guard looks at the words a rule and a call share. A script or a make target that already exists and does the forbidden thing is missed, and so is a call that shares a single word with its rule. It checks Bash, Edit and Write calls, not MCP tools or the files a script changes when it runs. More: [the guard's limits](guard.md#limits).

## Is deciding what to save fast, cheap and right?

{{include README.md#fast-and-cheap}}

## Does the right line come back?

On the second retrieval held-out set (90 prompts over three new projects of 20, 80 and 250 lines, run once on 2026-09-28), jevmem 0.6's recall found 75/78 of the lines the prompts needed, and 0.5.9 found 55/78; 0.7.1 finds the same 75/78 (one run, 2026-10-13, [results](../../results/recall-heldout2-2026-10-13-v071.json)). Of those 78 lines, 18 are dead ends, which 0.5.9 cannot read; on the other 60, 0.6 found 57 and 0.5.9 found 55. Of the lines 0.6 put in front of Claude, 96/97 were wanted or fine, and 1/18 unrelated prompts got a line ([0.6](../../results/recall-heldout2-2026-09-28-now.json), [0.5.9](../../results/recall-heldout2-2026-09-28-v059.json)).

**Limits.** Prompts that need two lines got both in 3 of 6. With more than 250 live lines, only the 250 that share the most words with the prompt are asked about (on a 500-line dev file, recall was 37/46). That the right lines reach Claude is tested; whether its answers get better is not.

## Is a line saved twice?

Not when it says the same as a live line (0.7.0). On a held-out set of 50 turns in five new projects, written before the code: of 25 restatements (word for word, paraphrased, with a tag in front, quoted), 0.6.6 saved 15 as new lines and 0.7.0 saved 1; restatements that add a detail were saved 4 of 5, reversals superseded 5 of 5, retired lines said again saved anew 4 of 5, and unrelated turns came out as labelled 9 of 10, the same on both builds (one run each, 2026-10-08: [0.6.6](../../results/dupes-heldout-2026-10-08-v066.json), [0.7.0](../../results/dupes-heldout-2026-10-08-v070.json); 0.7.1 gives the same counts, one run on 2026-10-13, [results](../../results/dupes-heldout-2026-10-13-v071.json)). A tag pasted in front of a line (`[constraint] Never …`) is no longer part of it: on 24 held-out texts, 0 of 18 tags were stripped on 0.6.6 and 18 of 18 on 0.7.0, with the six bracketed tokens that must stay kept on both ([0.6.6](../../results/tagstrip-heldout-2026-10-08-v066.json), [0.7.0](../../results/tagstrip-heldout-2026-10-08-v070.json)).

**Limits.** The one restatement 0.7.0 saved was a quoted rule that the restatement question scored 0.97 but the id choice answered none for; dedupe needs both. Only a word-for-word restatement is stopped before any request; a paraphrase goes to Jev. The method and every row: [docs/benchmark.md](../../docs/benchmark.md#memory-you-can-see-and-fix-070).

## Can memory start from past sessions?

Yes, since 0.7.1: `jevmem import --from sessions` reads a project's past Claude Code sessions and proposes the lines the hooks would have saved, after counting the sessions and turns, estimating the cost and asking. On 12 real held-out sessions with 27 turns, captured before the code in two new projects, it read every turn (27 of 27), proposed a line for every turn labelled to give one (17 of 17) with the labelled words in each, superseded both reversals (2 of 2), and gave 4 lines for turns labelled skip: precision 17 of 21 (one run on the build, 2026-10-13, [results](../../results/import-heldout-2026-10-13-v071.json)).

**Limits.** The kind was wrong in 5 of the 27 turns, as decide reads them. Two prompts with nothing from Claude between them are one turn to the reader. The session format is undocumented: the reader counts what it skips and stops when no file gives a turn. More: [docs/limits.md](../../docs/limits.md#known-limits); the method: [docs/benchmark.md](../../docs/benchmark.md#memory-from-past-sessions-071).

## Dead ends, background subagents and planted lines

- **Dead ends.** On decide's third held-out set (100 turns in five new projects), jevmem saved 25 of 25 dead ends, each with its reason, on every build run on it since 0.6.0, last 0.7.1 on 2026-10-13 ([results](../../results/dead-ends-heldout-v3-2026-10-13-v071.json); [0.6.5, 2026-10-05](../../results/dead-ends-heldout-v3-2026-10-05-v065.json)). When Claude's reply gives the verdict first and the cause last, 0.6.5 keeps the cause: on 13 held-out dead ends written in that style (2026-10-05), 12 lines kept the reason with the reply given to the writer, against 2 in 0.6.4 ([0.6.5](../../results/cause-last-heldout-2026-10-05-v065.json), [0.6.4](../../results/cause-last-heldout-2026-10-05-v064.json)). With deciding in front, 6 of the 13 were saved as dead ends, each with its reason; in the other 7 jevmem did not read Claude's reply, as in 0.6.4.
- **Background subagents.** On 30 real Claude Code 2.1.281 sessions, 14 of them with a background subagent, replayed through each build: no line was saved while a turn was still running (0.5.9 saved 11), and turns were saved or skipped right in 30 of 33 on 0.7.1 (one run, 2026-10-13, [results](../../results/stops-heldout-v4-2026-10-13-v071.json)), in 32 of 33 on the 0.6.0 build (2026-09-30, [results](../../results/stops-heldout-v4-2026-09-30-v060.json)) and in 27 of 33 on 0.5.9. The two turns that moved since 0.6.0 moved with 0.6.6's reply question, which gives the same 30 of 33 ([0.6.6, 2026-10-08](../../results/stops-heldout-v4-2026-10-08-v066.json)).
- **Planted lines.** On a 44-line test set (2026-09-25), the check on lines jevmem did not write blocked 20 of 22 planted lines, with 0 false blocks on 22 legitimate rules; the 2 it missed were instructions disguised as normal process ([results](../../results/memory-injection-2026-09-25-run1.json)).

## Can a local model do Jev's job?

Not well enough to offer, in the one test so far. On 2026-10-02, jevmem 0.6.4 was pointed at a local model server, Ollaya 0.9.0, on an Apple M4 with 16 GB, next to a Jev run of the same set the same afternoon. On the 66 held-out turns, in jevmem's default mode, Jev was right on save or skip for 65/66 turns at a median of 0.23 s a turn; `winnow:e4b` for 60/66 at 28.5 s; `laya:typed-decisions` for 19/66.

The results files: [Jev](../../results/local-model-2026-10-02-jev.json), [winnow:e4b](../../results/local-model-2026-10-02-winnow-e4b.json), [laya:typed-decisions](../../results/local-model-2026-10-02-laya-typed-decisions.json). The commands as run: [scripts/local-model-jev.sh](../../scripts/local-model-jev.sh), [scripts/local-model-ollaya.sh](../../scripts/local-model-ollaya.sh).

**Limits.** One run each, on one Mac, with two models. The set was written for Jev's behaviour. Both local models needed the client's timeout raised from 10 s to 180 s. `winnow:e4b` was measured on these 66 turns only, not on recall or the guard.

## What these results do not show

{{include docs/limits.md#honest-limits}}
