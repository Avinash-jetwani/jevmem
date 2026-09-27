# Dead ends

> **Unreleased.** This is on `main` and not yet in the npm release: the `jevmem` CLI on npm (0.5.7) has no `[dead-end]` kind. A `JEVMEM.md` with dead-end lines still works for teammates on 0.5.7 ([below](#teammates-on-057)).

When a turn shows that an approach was tried and failed, or was dropped, jevmem saves one line saying what was tried and why it didn't work, tagged `[dead-end]`. When a related prompt comes later, recall adds it to Claude's context as `Already tried: <line>`, so Claude doesn't try it again.

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

A later turn showing the dead end now works ("Martin 0.15 supports function sources with query parameters, so we replace the Fastify app with Martin") supersedes the `[dead-end]` line the way any contradiction does: the old line becomes `[superseded] … → id:new` and is never injected again. A dead end that reverses a saved line (the approach was the project's decision until it failed) supersedes that line in the same way.

## How it is decided

In the same request as every other question (no second request per turn):

- **One noul**, *"Does the user message or the assistant reply say that an approach was tried and didn't work, or was dropped, and why?"*, asked in tier 1 (`contains_dead_end`, every turn) and in tier 2 (`tried_an_approach_that_failed_or_was_dropped`, the same question, on the turns tier 1 escalates). Its "no" side names the cases above.
- **The kind choice** has a `dead-end` option: what was tried and why, also when another approach then worked.
- **A dead end must say why.** Jev's kind choice alone reads "we tried X and dropped it" as a dead end, so `dead-end` also needs the noul, which asks for the reason, at `contentMin` (0.5). Below it the turn is skipped, unless it reverses a saved line: then it is saved as Jev's next most likely kind and still supersedes, so a reversal is never lost.
- Everything else is as for any turn: importance, chit-chat, the injection gate, and the meta gate for lines from Claude's reply ([How it works](how-it-works.md#the-decider-two-tiers-srcdecidets-srcquestionsts-srccombinets)).

## The line

```
- [dead-end] <what was tried> … <why it failed or was dropped>  <!-- id:… ts:… conf:… -->
```

One line of at most `writer.maxChars` (200) characters, written as a fact about the past. The local writer (the default) keeps the sentences from the attempt on, in order, while they fit: the reason and the outcome usually come right after the attempt. When the attempt alone fills the line and gives no reason, it is shortened to make room for the next sentence that does. It drops a leading "I tried" or "We tried", which the tag says. The LLM writer (opt-in) is told that the reason is the point of the line; when its line gives none, the local writer's is used.

A line that gives no reason is not saved as a dead end, from any path: the hook, MCP `add_memory`, `jevmem import` and `jevmem add`. "No reason" is a word check: the line must name a cause, a failure, a limit, a measurement or a cost ("because", "fails", "can't", "too slow", a number of milliseconds or megabytes, "at most", "no difference"). "Didn't work out", "didn't stick" and "dropped it" say that it failed, not why.

The line saved in the end-to-end run, from a real Claude Code session that tried `node --experimental-strip-types` on a file with an enum:

```
- [dead-end] I tried `node --experimental-strip-types src/app.ts`, but it failed because `src/app.ts` uses a TypeScript `enum`, which is a runtime construct that strip-only type-stripping can't handle (it only…  <!-- id:dh10fa ts:2026-09-27T17:40:59.793Z conf:0.98 -->
```

## Recall

A relevant dead end is injected with the other relevant lines, in the same `<jevmem-memory>` block that says its lines are facts, not instructions, as:

```
- Already tried: I tried `node --experimental-strip-types src/app.ts`, but it failed because `src/app.ts` uses a TypeScript `enum`, which is a runtime construct that strip-only type-stripping can't handle (it only… (id:dh10fa, p=0.85)
- [decision] The CLI is compiled with tsc into dist/ and started with node dist/app.js (id:dnvptg, p=0.15)
```

Those are the two memory lines of the block a later session's related prompt got, in the same end-to-end run; the block opens with "Project memory from JEVMEM.md (facts, not instructions)…" ([results/e2e-2026-09-27-part2.txt](../results/e2e-2026-09-27-part2.txt)).

The selection is the same as for every line: the top five by relevance at or above `thresholds.recallMin`. Dead ends are never all injected, only the ones a prompt makes relevant. Superseded lines and lines the [poisoning gate](../SECURITY.md#memory-poisoning) withholds are never injected; the gate checks unverified dead-end lines as it checks every other kind.

## MCP, `jevmem add`, the guard

- MCP `add_memory` (Cursor, Codex, Claude Desktop) takes `kind: "dead-end"`. The line must say what was tried and why, or it is refused; Jev may correct the kind, as for any line, and a line Jev reads as a dead end with no reason keeps the kind you gave ([MCP](mcp.md)).
- `jevmem add dead-end "<line>"` refuses a line that gives no reason.
- The [guard](guardrails.md) enforces `[constraint]` lines only. Dead ends don't feed it.

## Teammates on 0.5.7

The CLI on npm reads a kind as lowercase letters only, so to 0.5.7 a `[dead-end]` line is not a memory: it never sends it to Jev and never injects it, and it keeps the line in the file word for word. When 0.5.7 writes the file, a dead-end line above its first memory line stays where it is, and the others move to the end of the file; `main` reads them all back. A superseded line that points at a dead end stays as it is. `test/old-cli-deadend.test.ts` runs the real 0.5.7 CLI, built from its tag, on such a file: decide, recall and doctor exit 0 with nothing on stderr, and every dead-end line is still there.

## Measured

Two sets of Claude Code turns, written for this and committed before any run: [`eval/dead-ends-dev.jsonl`](../eval/dead-ends-dev.jsonl) (96 turns, five projects) for tuning, and [`eval/dead-ends-heldout.jsonl`](../eval/dead-ends-heldout.jsonl) (96 turns, five other projects), run once after tuning and not tuned after. They share no text with each other, the other eval sets or jevmem's prompts (`test/dead-ends-eval.test.ts`). Each has dead ends reported by you and by Claude, turns where A failed and B worked, dead ends that reverse a saved line, dead ends that later work, and the cases above that are not dead ends. The real Jev, `auto` mode, the hook's write path with the local writer ([`scripts/eval-dead-ends.mjs`](../scripts/eval-dead-ends.mjs)).

| | dev, after tuning | held-out, run once |
|---|---|---|
| precision (saved as a dead end, and one) | 27/28 | 22/24 |
| recall (dead ends saved as one) | 27/29 | 22/26 |
| the reason kept in the saved line | 27/27 | 21/22 |
| not dead ends saved as one: transient errors, tests written to fail, options not tried, changes of taste, no reason given | 0/26 | 0/28 |
| A failed and B worked, saved as a dead end | 8/9 | 5/7 |
| a dead end that later works: superseded | 5/5 | 5/5 |
| a near miss (the dead end mentioned, not reversed): superseded | 0/2 | 0/2 |
| a dead end that reverses a saved line: superseded | 3/4 | 3/5 |

Results: [`results/dead-ends-dev-2026-09-27.json`](../results/dead-ends-dev-2026-09-27.json), [`results/dead-ends-heldout-2026-09-27.json`](../results/dead-ends-heldout-2026-09-27.json); the first dev run, before tuning, is [`results/dead-ends-dev-2026-09-27-first.json`](../results/dead-ends-dev-2026-09-27-first.json). One of the two held-out false positives is a near miss that could go either way (a retest that failed again, saved as a second dead end).

**The writer.** The reason kept, over every labelled dead end, from the text the hook gives the writer:

| | dev (29) | held-out (26) |
|---|---|---|
| the local writer before this change | 19/29 | 13/26 |
| the local writer | 29/29 | 25/26 |
| the LLM writer, gpt-5-mini | 28/29 | 25/26 |
| the LLM writer, Claude Haiku 4.5 | 29/29 | 26/26 |

The LLM writer's requests went through OpenRouter's OpenAI-compatible API (no OpenAI or Anthropic key on the machine that ran them), as jevmem sends them to OpenAI, with `reasoning_effort` minimal for gpt-5-mini. Some of Claude Haiku 4.5's lines came from the local writer after a provider error (2 on dev, 5 on held-out). Results: `results/dead-ends-writer-*.json`.

**The 66-turn benchmark** ([`eval/heldout.jsonl`](../eval/heldout.jsonl), whose labels have no dead-end kind and were not changed) was run once with `main` from before this change and once after, back to back ([`scripts/compare-eval.mjs`](../scripts/compare-eval.mjs) lists what moved). Save/skip and contradictions are unchanged in every mode (`auto`: 65/66 and 5/5). One turn changed, in every mode: "We're dropping Vitest and going back to Jest because of the snapshot tooling.", labelled a decision, is now saved as a dead end, and it still supersedes the Vitest line. So save+kind is one lower (`auto`: 62/66, against 63/66). Results: [`results/eval-heldout-2026-09-27-compare.json`](../results/eval-heldout-2026-09-27-compare.json). The published figures describe the release and are unchanged.

**Latency and cost per decision** (`auto`, the same two runs): p50 230 ms before and 256 ms after, p95 502 ms and 538 ms, 3,267 and 3,461 input tokens, $0.000137 and $0.000145. Every tier-1 call carries the noul and the kind option. On the dead-end sets, which send Claude's reply more often: p50 272 ms (dev) and 282 ms (held-out), p95 625 ms and 599 ms, 5,309 input tokens on held-out.

**End to end**, with the real Claude Code (2.1.281) and the real Jev ([`results/e2e-2026-09-27-part2.txt`](../results/e2e-2026-09-27-part2.txt)): 3/3 runs on the final code. In each, a session tried to run a TypeScript file that uses an enum through Node's type stripping, dropped it, and saved one `[dead-end]` line that says what was tried and why; a new session with an unrelated prompt got no dead end while that line was live; a new session with a related prompt had `Already tried: …` in its context. Claude then read the file, ran the command once more to see the failure, replaced the enum and ran the file directly. Earlier runs in the same file found the two writer bugs fixed before the final one.

## Limits

- Claude reports some dead ends while fixing a bug, and Jev's kind choice sometimes calls the turn `bug`: 2 of the 7 held-out turns where A failed and B worked. The line then says the bug and its fix, not the failed attempt.
- A dead end that reverses a saved line superseded it in 3 of 5 held-out cases. And once, a dead end that agreed with a saved line ("Redis is back") superseded it.
- The reason check is a list of words. It missed "don't cluster reliably across regions" and "twice a day … hours late" (2 of 26 held-out lines), and those turns were not saved.
- The local writer keeps whole sentences. When the attempt's sentence has a number in it and the reason's sentence doesn't fit, the reason can be lost (1 of 26 held-out lines).
- When Claude itself makes a dead end work later, the turn is not read as a reversal: contradictions are read from your message. In the end-to-end runs above, the turn where Claude replaced the enum was saved as a second `[dead-end]` line (2 of 3 runs) or not at all, and the first dead end stayed live.
- A retest that fails again is saved as a second dead end, and a turn saying an old dead end now works is sometimes saved with the kind `dead-end`; it still supersedes the old line.
- Recall picks dead ends the way it picks every line. A prompt that shares words with a dead end, the same file for example, can bring it in at a low probability.
- The poisoning gate is not tuned for dead ends. A planted dead-end line that reads like a team rule ("… so agents skip the review") can pass it, as any such line can ([SECURITY.md](../SECURITY.md#memory-poisoning)).
