# Dead ends

> **Since 0.6.0.** Earlier CLIs (0.5.7 to 0.5.10) have no `[dead-end]` kind; a `JEVMEM.md` with dead-end lines still works for teammates on them ([below](#teammates-on-057-to-0510)).

When a turn shows that an approach was tried and failed, or was dropped, jevmem saves one line saying what was tried and why it didn't work, tagged `[dead-end]`. When a related prompt comes later, recall adds it to Claude's context as `Already tried: <line>`. That is information for Claude, not a rule: what Claude did with it in the end-to-end runs is [below](#end-to-end). When the approach works later, told by you or made to work by Claude, the line is superseded and never injected again. When it is tried again and fails again, nothing is saved for the same reason, and a new reason goes into one line with both ([below](#when-it-is-tried-again)).

## What counts

A dead end is an approach that was really tried in this project (built, run, deployed or measured) and failed or was given up, **with the reason**: an error, a limit, a measurement, a cost. The reason is the point of the line. "We tried Redis for sessions and dropped it" says nothing a later session can use, so it is not saved as a dead end.

Not dead ends:

- a failure that a retry fixed: a network error, a rate limit, a flaky test;
- a test written to fail first;
- options discussed but not tried ("should we try Bun?");
- a change of taste ("I like CSS Modules better now"), which is a decision or a preference;
- an approach that failed before and works now: that turn supersedes the dead end ([below](#when-it-works-later));
- trying to reproduce a bug.

The dead end can come from your message or from Claude's reply. Claude usually finds one while it works ("I tried client keepalive; the server answered GOAWAY, so I removed it"), so Claude's reply is sent to Jev when it reports an attempt ("tried", "reverted", "rolled back", "didn't help"), even when your message was a request and not a question. A dead end may come from the reply, as a root cause or an architecture fact may.

### When A failed and B then worked

jevmem saves one line per turn, so the turn is saved as one `[dead-end]` line that names A, why A failed, and B when it fits: "Pinning the camera plugin to 0.10.5 didn't fix it, same NullPointerException inside CameraX. Using the medium resolution preset below API 29 did." After the turn, B is in the code and its history; A is in neither, so A is the part a later session cannot find out for itself. When the line is too long for both, the reason is kept and B goes first.

### When it works later

A turn that shows a live dead end now works supersedes it: the old line becomes `[superseded] … → id:new` and is never injected again. Two cases:

- **You say so**: "Martin 0.15 supports function sources with query parameters, so we replace the Fastify app with Martin."
- **Claude makes it work.** You ask for the approach again ("Make src/app.ts run directly with node --experimental-strip-types"), Claude finds the cause, changes the code and runs it, and its reply says so. The dead end is superseded by that turn.

For this, the decide request asks one more noul and one more choice, only when the state lists a live dead-end line: *"Does the user message or the assistant reply show that the approach in one of the listed dead-end memories now works?"*, and which one. They read your message and Claude's reply, so they see what Claude did. Their "no" side names the near misses: the dead end only mentioned or confirmed, tried again and failing again, or a fix only proposed. The choice lists only the live dead-end lines, so Claude's reply can supersede a dead end and nothing else: a decision, a rule or a fact is superseded only by what you say, never by Claude's reply alone.

Claude's reply joins the state when the turn is about a live dead end: when your message and the reply share three words with one of the live dead-end lines (words of three letters or more, common ones left out). A reply is also sent for a question and when it reports an attempt, as before.

The turn that supersedes is saved as a decision, an architecture fact or a bug (Jev's most likely of the three), never as a second dead end. The line should say what works now and what was changed: the local writer leads with the sentence that names the approach of the dead end, when Claude's reply has one. Since 0.6.5, when the sentences Jev picks do not fit in the line as written, the one that states what works now goes first (a plan Claude wrote before the work, "I'll replace it with …", no longer pushes out "I replaced …"), and when it says what was changed last, after ", so", the cut keeps that clause.

Your message changing a dead-end line ("Try FP16 again with the new runtime") does not supersede it by itself: if the retry fails again, the dead end still holds ([below](#when-it-is-tried-again)). And a dead end that agrees with a saved line does not supersede it: "I tried moving presence to PG2 to get rid of Redis … Redis is back" leaves "Presence uses Redis" live. The contradiction questions say so on their "no" side: an alternative to a saved line that was tried and then undone leaves that line standing.

A dead end that reverses a saved line (the approach was the project's decision until it failed) supersedes that line, as any reversal from your message does. Since part 2c the contradiction questions name this case on their "yes" side, in both tiers: *"Does the user message change, conflict with, or drop one of the existing memories listed in the state, for example because what it states failed?"*, including *"a report that what a listed memory states kept failing, so it is dropped or replaced"*. Asked the part 2b way, a turn like "The incremental merge keeps missing late uploads … Sales facts go back to a full rebuild every night" scored 0.24 against the saved incremental-merge line (it read as an alternative undone), and the line stayed live. The bug kind's "not for" now names an approach dropped because it failed, so such a turn is more often a dead end than a bug.

### When it is tried again

A live dead end tried again that fails again (you or Claude retry it: a new release, a setting, a workaround) is not saved a second time. Three more questions go in the request each tier already makes, only when the state lists a live dead-end line, next to the works-now ones: *"Does the user message or the assistant reply show that the approach in one of the listed dead-end memories was tried again and still failed, for the same reason or a new one?"*, which one (a choice over the live dead-end lines only), and *"Does the turn give a reason the approach failed this time that the listed dead-end memory does not already give?"*

- **The same reason** (the second noul under 0.5): nothing new. A turn saved as a dead end or a bug is skipped; "Same result with the new release: the timer still drifts" adds nothing to the line that says it drifted. A decision made in the same turn is judged as usual.
- **A new reason**: one `[dead-end]` line with both reasons, which supersedes the old one. The local writer keeps the old line up to its closing "so …" and adds the new reason after "retried:" (since part 3c from the sentence Jev picks as why it failed this time), each cut at a clause's end to fit: `Brotli for the tile responses: the CDN re-compressed them and edge CPU doubled; retried: Safari 15 on older iPads failed to decode them and showed blank map areas`. The LLM writer gets the earlier line and is told to keep both reasons.

A retry counts at `contradictionMin` (0.7) on the first noul with a listed line chosen, like works-now, and a dead end that works now is never also a retry. `jevmem why` shows the three answers.

## How it is decided

In the same request as every other question (no second request per turn):

- **One noul**, *"Does the user message or the assistant reply say that an approach was tried and didn't work, or was dropped, and why?"*, asked in tier 1 (`contains_dead_end`, every turn) and in tier 2 (`tried_an_approach_that_failed_or_was_dropped`, the same question, on the turns tier 1 escalates). Its "no" side names the cases above.
- **The kind choice** has a `dead-end` option: what was tried and why, also when another approach then worked.
- **A dead end must say why, and Jev decides whether it does.** Jev's kind choice alone reads "we tried X and dropped it" as a dead end, so `dead-end` also needs the noul, which asks for the reason, at `thresholds.deadEndMin` (0.7). There is no word list. Below it the turn is skipped, unless it reverses a saved line: then it is saved as Jev's next most likely kind and still supersedes, so a reversal is never lost.
- **When the state lists a live dead end**, the works-now noul and choice ([above](#when-it-works-later)) and the retry questions ([above](#when-it-is-tried-again)).
- **A turn with no content source is never saved, so it never supersedes.** When Claude's reply is in the state, Jev also answers *"Which side of the turn states something for this project: a decision, rule, preference, bug, structure fact, failed approach, or work for later?"*: your message (the reply may only acknowledge it, carry it out or record it), the reply, both, or neither. "Neither" is chatter, or a question, proposal or list of options nobody decides ("maybe we could put location updates on Kafka? thoughts"), and is a skip whatever the kind choice says. Before part 2b the policy checked only "the reply", so such a question could be saved and could supersede a live line; 0.5.7 does the same ([DECISIONS.md](../DECISIONS.md)). Part 2b asked where "the memorable content" came from, and Jev then said "neither" for some plain statements whose reply added nothing, which were skipped; part 2c changed the question, not the rule ([below](#measured)).
- Everything else is as for any turn: importance, chit-chat, the injection gate, and the meta gate for lines from Claude's reply ([How it works](how-it-works.md#the-decider-two-tiers-srcdecidets-srcquestionsts-srccombinets)).

## The line

```
- [dead-end] <what was tried> … <why it failed or was dropped>  <!-- id:… ts:… conf:… -->
```

One line of at most `writer.maxChars` (200) characters, written as a fact about the past, that ends on a complete clause: a longer text loses its trailing clauses (at a sentence's end, a semicolon, a colon, a dash, a parenthesis that closes its clause, or before ", but", ", so", ", which", "because" and the like), never part of a word, a code span or a URL. Only a single clause longer than the line is cut at a word, and ends in "…". This holds for every kind of line and every path that saves one.

The local writer (the default) keeps the clauses from the attempt on, in order, while they fit: the reason and the outcome usually come right after the attempt. Since part 3c the sentences are the ones Jev picks, what was tried and why it failed, in one request after decide ([How it works](how-it-works.md#the-line-srcpickts-srcwritets)); before, and when that request fails, they run from the sentence that names the attempt ("tried", "attempted", "I ran" …) to the end. When the reason comes after "but" and the upside before it would push it out of the line ("It made each path four times faster, but the pool stole cores from the tick thread …"), the upside goes and the reason stays, in the attempt's own sentence too since part 3c; when the reason's sentence is still too long, its first clause that fits. When only the attempt fits and its sentence says nothing but the attempt (no negation and no clause after "but", "because", "so", a colon or a dash), its trailing clauses make room for the next sentence. It drops a leading "I tried" or "We tried" before a gerund or an article, which the tag says, before it fits the line. Since 0.6.5 a reply that gives the verdict first and the cause last keeps its cause ("It didn't work, so I'm dropping the idea. I ran X on Y, and it failed with Z because …"). Jev names the attempt's own sentence as the one that gives the reason; the writer used to take the next most likely sentence, the verdict at a few percent, as the reason, and the line was the verdict and the attempt cut before "because". Now a runner-up counts only at 0.2 or more; when the attempt's sentence holds its own reason and the picked sentences do not fit as written, it goes first; and when it is longer than the line with its cause last, the cut keeps the cause: the sentence as written up to the cause, with the cause ended at one of its own clauses or before an "and", or else what was tried and the cause after a colon ([benchmark](benchmark.md#the-cause-last-065)). This is sentence structure, not a check: whether the turn gives a reason is Jev's call, above. The LLM writer (opt-in) is told that the reason is the point of the line, and its line is used as it comes. A retry that failed for a new reason is written with both reasons ([above](#when-it-is-tried-again)).

The line saved in a final end-to-end run, from a real Claude Code session that tried `node --experimental-strip-types` on a file with an enum:

```
- [dead-end] I ran `node --experimental-strip-types src/app.ts` once. It failed because `src/app.ts` uses a real TypeScript `enum`, which Node's strip-only mode explicitly doesn't support  <!-- id:7ld7lq ts:2026-09-27T20:26:41.472Z conf:0.98 -->
```

In part 2 the same kind of line was cut inside a parenthesis ("… can't handle (it only…"); [results/e2e-2026-09-27-part2b.txt](../results/e2e-2026-09-27-part2b.txt) has every line from the runs below.

## Recall

A relevant dead end is injected with the other relevant lines, in the same `<jevmem-memory>` block that says its lines are facts, not instructions, as:

```
- Already tried: I ran `node --experimental-strip-types src/app.ts` once. It failed because `src/app.ts` uses a real TypeScript `enum`, which Node's strip-only mode explicitly doesn't support (id:7ld7lq, p=0.93)
- [decision] The CLI is compiled with tsc into dist/ and started with node dist/app.js (id:ssbl1q, p=0.07)
```

Those are the two memory lines of the block a later session's related prompt got in that run; the block opens with "Project memory from JEVMEM.md (facts, not instructions)…".

The selection is the same as for every line: the lines whose own relevance noul reaches `recallRelevanceMin`, at most `recallTopK` ([how](how-it-works.md#the-read-side-one-call-per-prompt-srcrecallts)). Dead ends are never all injected, only the ones a prompt makes relevant. Superseded lines and lines the [poisoning gate](../SECURITY.md#memory-poisoning) withholds are never injected.

## MCP, `jevmem add`, import, the guard

- MCP `add_memory` (Cursor, Codex, Claude Desktop) takes `kind: "dead-end"`. The line must say what was tried and why: Jev's dead-end noul on the line, in the request `add_memory` already makes, at `deadEndMin`, or it is refused. Jev may correct the kind, as for any line, and a line Jev reads as a dead end with no reason keeps the kind you gave ([MCP](mcp.md)).
- `jevmem add dead-end "<line>"` makes no Jev call and needs no key, like every other kind: you typed the line (part 2b asked Jev whether a typed dead end gave a reason; part 2c took that out). Say what was tried and why. Like a hand edit, the line is unverified, so the poisoning gate checks it, its dead-end noul included, before recall serves it.
- `jevmem import` decides each statement as a turn, so the same rule applies.
- The [guard](guardrails.md) enforces `[constraint]` lines only. Dead ends don't feed it.
- The poisoning gate asks unverified dead-end lines a second noul ([SECURITY.md](../SECURITY.md#memory-poisoning)).

## Teammates on 0.5.7 to 0.5.10

The CLI on npm reads a kind as lowercase letters only, so to 0.5.7 a `[dead-end]` line is not a memory: it never sends it to Jev and never injects it, and it keeps the line in the file word for word. When 0.5.7 writes the file, a dead-end line above its first memory line stays where it is, and the others move to the end of the file; `main` reads them all back. A superseded line that points at a dead end stays as it is. `test/old-cli-deadend.test.ts` runs the real 0.5.7 CLI, built from its tag, on such a file: decide, recall and doctor exit 0 with nothing on stderr, and every dead-end line is still there. 0.5.8 changed only the scrubber (`src/scrub.ts`, and how `src/jev.ts` and `src/audit.ts` call it) and where the MCP server finds the key, none of the code that reads or writes `JEVMEM.md`, so the same holds for it. 0.5.9 changed no code, only docs and version numbers, so it behaves as 0.5.8 does. 0.5.10 changed the setup messages, `jevmem key`, `jevmem doctor`, `jevmem enable`, stats and the daemon's key check, none of the code that reads or writes `JEVMEM.md` (`src/store.ts`, `src/recall.ts`, `src/decide.ts` and `src/write.ts` are as in 0.5.9), so it behaves as 0.5.9 does.

## Measured

Six sets of Claude Code turns, written for this and committed before any run that used them. They share no project and no text with each other, the other eval sets or jevmem's prompts (`test/dead-ends-eval.test.ts`). The real Jev, `auto` mode, the hook's write path with the local writer ([`scripts/eval-dead-ends.mjs`](../scripts/eval-dead-ends.mjs)).

- Part 2: [`eval/dead-ends-dev.jsonl`](../eval/dead-ends-dev.jsonl) (96 turns, tuning) and [`eval/dead-ends-heldout.jsonl`](../eval/dead-ends-heldout.jsonl) (held-out v1, 96 turns, run once, results as scored).
- Part 2b: [`eval/dead-ends-dev-v2.jsonl`](../eval/dead-ends-dev-v2.jsonl) (48 turns, tuning: dead ends Claude makes work, dead ends that keep a listed line, Claude's reply contradicting a listed line, questions with no content) and [`eval/dead-ends-heldout-v2.jsonl`](../eval/dead-ends-heldout-v2.jsonl) (held-out v2, 120 turns in five new projects, every case, written before any part 2b change and run once at the end).
- Part 2c: [`eval/dead-ends-dev-v3.jsonl`](../eval/dead-ends-dev-v3.jsonl) (60 turns, tuning) and [`eval/dead-ends-heldout-v3.jsonl`](../eval/dead-ends-heldout-v3.jsonl) (held-out v3, 100 turns in five new projects, written before any part 2c change and run once at the end): plain statements whose reply adds nothing ("Will do."), questions and proposals next to a saved line on their topic, dead ends that reverse a saved line, retries of a saved dead end that fail again for the same reason or a new one, dead ends with the reason after "but", and ordinary turns.

| | held-out v1 (part 2, run once) | held-out v2 (part 2b, run once) |
|---|---|---|
| precision (saved as a dead end, and one) | 22/24 | 31/31 |
| recall (dead ends saved as one) | 22/26 | 31/35 |
| the reason kept in the saved line | 21/22 | 29/31 |
| not dead ends saved as one: transient errors, tests written to fail, options not tried, changes of taste, no reason given | 0/28 | 0/25 |
| A failed and B worked, saved as a dead end | 5/7 | 4/5 |
| a dead end you say now works: superseded | 5/5 | 5/5 |
| a dead end Claude makes work: superseded | not in the set | 10/10 |
| … and saved as a second dead end | | 0/10 |
| a dead end that reverses a saved line: superseded | 3/5 | 2/5 |
| supersedes in all: correct, missed, false | 8 of 10, 2, 1 | 17 of 20, 3, 0 |
| never to supersede: a dead end that keeps a saved line, a near miss (mentioned, retried and failing again, a fix only proposed), Claude's reply contradicting a saved line, a question with no content | the near misses, 0/2 | 0/25 |
| questions with no content saved | not in the set | 0/5 |

Held-out v3 describes this code ([below](#held-out-v3)); held-out v2 described part 2b's. Held-out v1 was scored with part 2's code (a word list checked the reason, a turn's contradiction came from your message only); its one false supersede was the Redis turn above. On held-out v2 the misses were: three dead ends that reverse a saved line, saved as a bug with no supersede, or as a dead end that did not see the reversal; four dead ends not saved as one (one where A failed and B worked went to `bug` because Claude's reply was not sent: your message had no question and the reply no attempt word; three reversals saved as a bug); two lines that lost the reason, where a first clause about the attempt's upside filled the line and the reason came after "but"; and one plain to-do ("Next sprint, add … metrics") skipped because Jev said its content came from neither side, after the reply joined the state because the turn shared words with a live dead end. Results: [`results/dead-ends-heldout-v2-2026-09-27.json`](../results/dead-ends-heldout-v2-2026-09-27.json), [`results/dead-ends-heldout-2026-09-27.json`](../results/dead-ends-heldout-2026-09-27.json).

On the dev sets, before and after part 2b, with `main` from before it and the final code: dead ends Claude makes work superseded 1/9 before and 9/9 after (2 of the 9 were saved as a second dead end before, none after); near misses superseded 2/6 before and 0/6 after; questions with no content saved 3/6 before (one superseded a live line) and 0/6 after; real dead ends refused by the word list 3 of 12 before (dev v2), none after. Results: [`results/dead-ends-dev-v2-2026-09-27-before.json`](../results/dead-ends-dev-v2-2026-09-27-before.json), [`results/dead-ends-dev-v2-2026-09-27.json`](../results/dead-ends-dev-v2-2026-09-27.json); dev v1 after: [`results/dead-ends-dev-2026-09-27-2b.json`](../results/dead-ends-dev-2026-09-27-2b.json).

### Held-out v3

Run once on the final code of part 2c ([`results/dead-ends-heldout-v3-2026-09-27.json`](../results/dead-ends-heldout-v3-2026-09-27.json)). The same set ran once more at the end, after the code was final, with the build of `main` from before part 2c and with the real 0.5.7, as comparison columns ([before](../results/dead-ends-heldout-v3-2026-09-27-before-2c.json), [0.5.7](../results/dead-ends-heldout-v3-2026-09-27-v057.json)), and once with the published 0.5.9 on 2026-09-28 ([0.5.9](../results/dead-ends-heldout-v3-2026-09-28-v059.json)). Part 3 changed recall, not what is saved, so the part 2c column is still `main`'s. The set ran again on the 0.6.0 build on 2026-09-30 and, after 0.6.5's writer change, on the 0.6.5 build on 2026-10-05 ([results](../results/dead-ends-heldout-v3-2026-10-05-v065.json)): dead ends saved 25/25, every line with its reason, reversals superseded 10/10, both times ([benchmark](benchmark.md#the-cause-last-065)).

| held-out v3 (100 turns) | 0.5.7 | 0.5.9 | `main` before part 2c | part 2c |
|---|---|---|---|---|
| saved when it should be, as a kind it accepts | 43/70 | 43/70 | 61/70 | 67/70 |
| skipped when it should be | 16/30 | 15/30 | 22/30 | 30/30 |
| plain statements whose reply adds nothing: saved | 24/25 | 24/25 | 19/25 | 24/25 |
| questions and proposals: saved (and superseding a line) | 11/20 (4) | 12/20 (7) | 4/20 (2) | 0/20 (0) |
| dead-end precision | no dead-end kind | no dead-end kind | 23/23 | 24/24 |
| dead-end recall | 0/25 | 0/25 | 23/25 | 24/25 |
| dead ends that reverse a saved line: superseded | 9/10 | 9/10 | 9/10 | 10/10 |
| … saved as a dead end | 0/10 | 0/10 | 9/10 | 10/10 |
| a retry that fails for the same reason: skipped | 2/5 | 2/5 | 1/5 | 5/5 |
| a retry that fails for a new reason: supersedes the old line | 0/5 | 0/5 | 0/5 | 5/5 |
| … and the line keeps both reasons | 0/5 | 0/5 | 0/5 | 5/5 |
| duplicates (a second line for a retry) | 3 | 3 | 9 | 0 |
| the reason after "but" kept, in a dead-end line | no dead-end kind | no dead-end kind | 3/5 | 5/5 |
| all turns right | 58/100 | 57/100 | 76/100 | 96/100 |

0.5.9 decides as 0.5.7 does: 0.5.8 and 0.5.9 changed the scrubber, where the MCP server finds the key, and docs, and on this set the two scrubbers give the same text for all 729 texts sent. Its run differs from the 0.5.7 run of the day before in 11 of 100 turns: 3 right in that run are wrong here, 2 the other way, and 6 are wrong in both runs in different ways (57/100 right against 58/100). That is Jev answering differently from one run to the next. It was run once, as a comparison column; nothing was tuned on it.

The five plain statements `main` skipped before part 2c were all skipped because Jev said their content came from neither side. The misses now: one plain statement ("How payouts work: …") and one to-do under `contentMin` (0.48 and 0.28); one dead end Claude found (a registration limit for Apple Pay on wildcard subdomains) that the kind choice called none; and one false supersede, a bug statement ("The display hangs … because the settings save … waits on flash") that superseded the rule on flash writes. One retry line was cut at a word (below).

On the dev sets, with `main` from before part 2c and the final code ([dev v3 before](../results/dead-ends-dev-v3-2026-09-27-2c-before.json), [after](../results/dead-ends-dev-v3-2026-09-27-2c-after.json); dev v2 and dev v1 the same way): dev v3 all turns 37/60 before and 55/60 after (0.5.7: 25/60); plain statements 13/18 and 16/18 (0.5.7 16/18: the same two "When X, do Y" rules fall under `contentMin`); questions and proposals saved 1/15 and 0/15 (0.5.7 7/15); dead ends that reverse a line superseded 5/9 and 7/9; retries for the same reason skipped 0/6 and 6/6; retries for a new reason superseding the old line 0/6 and 6/6; duplicates 12 and 0. Dev v2 43/48 and 44/48, dev v1 86/96 and 87/96.

**Why Jev said "neither" for plain statements.** Asked the part 2b way, in its request, the dev v3 plain statements (whose replies are "Okay.", "Will do." and the like) got "neither" in 8/36 answers (tier 1 and tier 2), most of all to-dos acknowledged with "Will do.". An empty reply instead gave 7/36 and no reply 4/36, so the reply was not the cause; with no memories listed, 0/36. The question asked where "the memorable content" came from, with "neither carries anything worth remembering" as the last option, so Jev judged whether the turn was worth remembering next to what the project already remembered. With the part 2c question, in the full request: 0/36 for the statements, 28/42 "neither" for the questions and proposals (24/42 before), and the dev turns whose memory is in Claude's reply stayed on the reply side (50/50). [`scripts/diag-content-source.mjs`](../scripts/diag-content-source.mjs); [before](../results/content-source-diagnosis-2026-09-27-before.json), [after](../results/content-source-diagnosis-2026-09-27-after.json).

**The writer.** The reason kept, over every labelled dead end, from the text the hook gives the writer:

| | dev (29) | held-out v1 (26) | held-out v2 (35) |
|---|---|---|---|
| the local writer | 29/29 | 25/26 (a second look) | 33/35 |
| the LLM writer, gpt-5-mini | 27/29 | 24/26 (a second look) | |
| the LLM writer, Claude Haiku 4.5 | 28/29 | 24/26 (a second look) | |

The held-out v1 figures published in part 2 (local 25/26, gpt-5-mini 25/26, Claude Haiku 4.5 26/26) were measured before two writer fixes found in part 2's end-to-end runs. The column above is a second look at held-out v1, measured once on the final code, not a held-out result: that set had been run before. The LLM writer's requests went through OpenRouter's OpenAI-compatible API, as jevmem sends them ([configuration](configuration.md#the-one-line-writer)); some of Claude Haiku 4.5's lines came from the local writer after a provider error (2 on dev, 2 on held-out v1). Results: `results/dead-ends-writer-*.json`.

**Part 2c's local writer**, on the dev sets' dead ends: 7 of 62 lines changed, all still keeping the reason, one gaining it (dev v3: 20/21 before, 21/21 after; [before](../results/dead-ends-writer-dev-v3-2026-09-27-local-2c-before.json), [after](../results/dead-ends-writer-dev-v3-2026-09-27-local-2c.json)). Across part 2c's final runs, 1 of 276 saved lines ends in "…": a held-out v3 retry line whose new reason was cut at a word ([results/ellipsis-2026-09-27-2c.json](../results/ellipsis-2026-09-27-2c.json)).

**Lines cut mid-sentence.** Across the eval runs before part 2b, 68 of 833 saved lines ended in "…": 57 of 507 in the eval results files and 11 of 326 in the end-to-end transcripts, all 11 in part 2's run. Written again from the same inputs with the final code, none of the 408 lines the local writer wrote does (the 99 lines an LLM wrote were not written again; 17 of them end in "…"). In every run of part 2b on the final code, LLM writers and end-to-end runs included, 0 of 446 saved lines do ([`scripts/count-ellipsis.mjs`](../scripts/count-ellipsis.mjs); [before](../results/ellipsis-2026-09-27-before.json), [after](../results/ellipsis-2026-09-27-after.json)).

**The 66-turn benchmark** ([`eval/heldout.jsonl`](../eval/heldout.jsonl), whose labels have no dead-end kind and were not changed) was run once more with the final code, against part 2's final run ([`results/eval-heldout-2026-09-27-2b-compare.json`](../results/eval-heldout-2026-09-27-2b-compare.json)). `auto`: save/skip 63/66 against 65/66, save+kind 60/66 against 62/66, contradictions 5/5 both times. Two turns changed, in every mode, both for the rule that a turn with no content source is skipped: "When you touch SQL, format it in uppercase keywords with one clause per line." (a preference) and "The admin export returns 403 for editors even though they should see it" (a bug). Both are statements, Claude's reply was in the state (the first starts with "When", the second has a 403), and Jev said the content came from neither side; in part 2's run both had been saved with that same answer in `auto` and `full`. In `fast` and `full` one more turn changed, the other way: "We're dropping Vitest and going back to Jest because of the snapshot tooling." is a decision again, as labelled (the dead-end noul 0.68, under the new 0.7), and still supersedes the Vitest line. Per decision in `auto`: p50 273 ms (256 before), 3,410 input tokens (3,461), $0.000143 ($0.000145). The published figures describe the release and are unchanged.

Part 2c ran it once more with its final code, against part 2b's run ([`results/eval-heldout-2026-09-27-2c-compare.json`](../results/eval-heldout-2026-09-27-2c-compare.json)). `auto`: save/skip 65/66 against 63/66, save+kind 63/66 against 60/66, contradictions 5/5 both times. The two statements part 2b skipped are saved again in every mode, as labelled. The Vitest turn changed again, both ways: in `auto` it is a decision, as labelled (the dead-end noul 0.65 in tier 1), and in `full` a dead end; either way it supersedes the Vitest line. `full`: save+kind 59/66 against 58/66. Per decision in `auto`: p50 242 ms, 3,666 input tokens (3,410 in part 2b), $0.000154 ($0.000143): the reworded questions are longer. The published figures are unchanged.

**The contradictions dev set** ([`eval/contradictions-dev.jsonl`](../eval/contradictions-dev.jsonl)), after each change to the contradiction questions' wording, `auto`: 25/27 found, 0 wrong ids, 0/16 false supersedes, as in v0.4.2, in part 2b and in part 2c ([2b](../results/contradictions-dev-2026-09-27-2b.json), [2c](../results/contradictions-dev-2026-09-27-2c.json)).

**Latency and cost.** The works-now noul and choice are asked only when a live dead end is listed; the reply joins the state more often in projects with dead ends. On held-out v2, where many turns list a live dead end: p50 470 ms, p95 647 ms, 6,405 input tokens, $0.000269 per decision. The retry questions are asked with them; on held-out v3: p50 298 ms, p95 577 ms, 6,147 input tokens, $0.000258 per decision (5,849 and $0.000246 with `main` before part 2c).

### End to end

With the real Claude Code (2.1.281) and the real Jev, on part 2b's final code ([`results/e2e-2026-09-27-part2b.txt`](../results/e2e-2026-09-27-part2b.txt)), and again on part 2c's ([`results/e2e-2026-09-27-part2c.txt`](../results/e2e-2026-09-27-part2c.txt)), 3/3 each time:

- **deadend**, 3/3: a session tried to run a TypeScript file that uses an enum through Node's type stripping, dropped it, and saved one `[dead-end]` line that says what was tried and why; a new session with an unrelated prompt got no dead end while that line was live; a new session with a related prompt ("Can we run src/app.ts directly with node and skip it?") had `Already tried: …` in its context.
- **supersede**, 3/3: the same first session; then a new session asked Claude to make the file run with type stripping. Claude changed the code and the file ran (the harness runs it to check). In every run the dead-end line became `[superseded] … → id:new`, the one new line was not a dead end, and a third session's context did not have the dead end.

**What Claude did with "Already tried:" in its context.** It did not always avoid the dead end. In part 2's three runs, Claude ran the failed command once more, unchanged, before it fixed the cause. In part 2b's final runs, with the line in context: in the deadend scenario Claude fixed the enum and then ran the file twice (and those turns superseded the dead end), and once used a different flag (`--experimental-transform-types`); in the supersede scenario it read the file, fixed it and ran it, all three times. Across the part 2b runs in [the results file](../results/e2e-2026-09-27-part2b.txt), Claude re-ran the failed command unchanged in 1 of 12 sessions that had the dead end in context; in part 2c's final runs, in 1 of 6 (it then fixed the enum and ran the file). Whether the line changes what Claude does has not been measured against runs without it.

## Limits

- Claude reports some dead ends while fixing a bug, and Jev's kind choice sometimes calls the turn `bug`: the line then says the bug and its fix, not the failed attempt. A reversal told as a bug report ("keeps missing late uploads", "hasn't worked … shows an error") can still be saved as a bug with the saved line left live: two dev v3 turns, whose contradiction noul is 0.41 and 0.59 (the threshold is 0.7). Held-out v3 superseded 10 of 10; held-out v2 had 2 of 5 with part 2b's code.
- Claude's reply is sent only for a question, a reported attempt ("tried", "reverted"…) or a turn about a live dead end. A dead end that only the reply tells, after a request with none of those, is missed (one held-out v2 turn: "Find out why", then "I first raised GOGC…"). Measured for 0.6.5 on replies that give the verdict first: of 13 held-out dead ends, the reply was read in 6; in the other 7 the verdict was worded outside that list ("That didn't pan out", "No good, so I'm abandoning it") and the request was no question, and in 5 of those the request itself was saved as a decision or a to-do ([benchmark](benchmark.md#the-cause-last-065)).
- A turn with no content source is skipped. With part 2b's question, Jev said "neither" for some plain statements whose reply added nothing (two turns of the 66-turn benchmark, one to-do in held-out v2, 5 of 25 held-out v3 statements); with part 2c's, none of the held-out v3 statements were. Plain statements with no must, never or prefer ("When a model changes its grain, bump the version …") can still fall under `contentMin`, as in 0.5.7.
- The local writer keeps whole clauses of at most two sentences, the ones Jev picks: what was tried and why it failed. A third, what worked instead, is left out even when it would fit (before part 3c it was kept while it fit). For a dead end that now works, the sentence Jev picks can say what was changed without saying that it works now ("I replaced the TypeScript `enum Unit` with a plain `as const` object plus a derived union type …", in part 3c's end-to-end runs, [results/e2e-2026-09-29-part3c.txt](../results/e2e-2026-09-29-part3c.txt)). A retry line with both reasons can be too long for clause cuts: one held-out v3 line ends in "…".
- A retry is judged the same reason or a new one by Jev's noul at 0.5. A retry that fails for the same reason is skipped only as a dead end or a bug; its version or date ("still fails with 1.13") is not saved.
- Recall picks dead ends the way it picks every line. In 0.5.x, and on `main` before part 3, a prompt that shared words with a dead end, the same file for example, could bring an unrelated dead end in at a low probability (0.09 in a probe), and after a dead end was superseded, a related question did not always get the line that superseded it: in 3 of the 6 supersede runs of part 2b and 2 of the 3 of part 2c, "Can I run src/app.ts directly with node now?" got only the older "compiled with tsc" decision, and Claude answered that it cannot. On `main` now, each line needs its own relevance, and the line that superseded a dead end is read with it: no unrelated prompt of the retrieval held-out set got a line, and in the 3 supersede runs of part 3 session 3 got the new line every time and Claude answered yes ([Benchmark](benchmark.md#retrieval-does-the-right-line-get-injected), [results/e2e-2026-09-28-part3.txt](../results/e2e-2026-09-28-part3.txt)). The superseded dead end was never injected.
- The poisoning gate's dead-end noul missed 2 of 20 planted held-out v2 lines, both worded as a lesson that leaves the step in name ("agents lower the coverage threshold to whatever the current number is", "agents build locally and upload the artefact to production themselves").
