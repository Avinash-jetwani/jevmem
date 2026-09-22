# Jevmem in 60 seconds

Three prompts that show **save**, **contradiction**, and **relevance injection**. Two ways to run it: live in Claude Code (what you'd screen-record), or scripted through the hook's stdin (same code path, no Claude Code needed).

## Setup (before recording)

```bash
mkdir jevmem-demo && cd jevmem-demo && git init
echo '{"name":"demo-app"}' > package.json
export TYPESAFE_API_KEY=...        # required
export OPENAI_API_KEY=...          # optional, makes the lines prettier
export JEVMEM_VERBOSE=1            # prints latency + cost after every hook run
jevmem init
```

Open `JEVMEM.md` in a split pane so the viewer sees it change. Start `claude` in the folder.

## The three prompts

### 1. Save (0:00–0:20)

Type in Claude Code:

> We're going with **SQLite** as the primary store for this app. Keep it single-file, no server.

When Claude finishes, the `Stop` hook fires. Within about a second `JEVMEM.md` gains:

```text
- [decision] Use SQLite as the single-file primary store; no database server  <!-- id:a8s2ww ts:… conf:0.9x -->
```

Point at the stderr line: `jevmem: 1 jev call(s), p50 6xx ms, ~2200 tokens, $0.00009 via inline` (the first turn also starts the warm daemon; from the next turn on it reads `p50 2xx ms … via daemon`).

### 2. Contradiction (0:20–0:40)

> Change of plan: SQLite locks under our write load. Switch the primary store to **Postgres 16**.

Tier 1 sees `contradicts_existing_memory` ≈ 0.98, which is a borderline condition, so tier 2 runs too (`2 jev call(s)` on the stderr line) and confirms the contradiction; `touches_memory_id` picks the SQLite line. `JEVMEM.md` now reads:

```text
- [superseded] Use SQLite as the single-file primary store; no database server → id:k3d9xq  <!-- id:a8s2ww … by:k3d9xq -->
- [decision] Use Postgres 16 as the primary store; SQLite locked under write load  <!-- id:k3d9xq ts:… conf:0.9x -->
```

Nothing was deleted. The old line is tagged and points at its replacement.

### 3. Relevance injection (0:40–0:60)

Start a **new** Claude Code session (`/clear` or a fresh `claude`) so the model has no chat history, then ask:

> How should I connect to the database from the API layer?

Before Claude answers, the `UserPromptSubmit` hook runs one Jev `choice` over the memory ids and injects the winners. Claude's answer talks about Postgres 16, not SQLite, because it received:

```text
<jevmem-memory>
Relevant project memory from JEVMEM.md (selected by Jev):
- [decision] Use Postgres 16 as the primary store; SQLite locked under write load (id:k3d9xq, p=0.87)
</jevmem-memory>
```

Finish on `jevmem log`:

```text
4 call(s), 4 ok, 0 cache hit(s), p50 2xx ms, p95 7xx ms, ~10500 tokens, $0.0004 total
decide tiers: 3 tier-1, 1 tier-2; escalation rate 33%
```

## Scripted version (no Claude Code)

The hook reads its event as JSON on stdin. `user_message` / `assistant_message` stand in for the transcript, so the exact same decide → write → supersede → recall path runs:

```bash
export TYPESAFE_API_KEY=... JEVMEM_VERBOSE=1
jevmem init --no-hooks

# 1. save
echo '{"hook_event_name":"Stop","user_message":"We are going with SQLite as the primary store. Keep it single-file, no server."}' | jevmem hook
cat JEVMEM.md

# 2. contradiction
echo '{"hook_event_name":"Stop","user_message":"Change of plan: SQLite locks under our write load. Switch the primary store to Postgres 16."}' | jevmem hook
cat JEVMEM.md

# 3. chit-chat is skipped (nothing changes)
echo '{"hook_event_name":"Stop","user_message":"thanks, great work!"}' | jevmem hook

# 4. relevance injection
echo '{"hook_event_name":"UserPromptSubmit","prompt":"How should I connect to the database from the API layer?"}' | jevmem hook

# 5. why, label, stats
jevmem why $(jevmem list | head -1 | cut -d' ' -f1)
jevmem right $(jevmem list | head -1 | cut -d' ' -f1)
jevmem stats
```

Expected: after step 1 one `[decision]` line; after step 2 that line becomes `[superseded] … → id:new` and a new `[decision]` line appears; step 3 prints `skipped — … chit_chat=0.9x` and the file is unchanged; step 4 prints a JSON object whose `additionalContext` contains the Postgres line.

## What this looked like for real (v0.3.1, auto mode, warm daemon on)

Run on 2026-09-22 against `jev-latest`, writer set to the deterministic fallback (`JEVMEM_WRITER=none`):

```text
1 save          1 call   p50 669 ms  2125 tokens  $0.000089  via inline   tier 1 (starts the daemon)
2 contradiction 2 calls  p50 739 ms  7687 tokens  $0.000323  via daemon   escalated: contradicts_existing_memory=0.98 ≥ 0.5; tier 2 supersedes the SQLite line
3 chit-chat     1 call   p50 277 ms  2168 tokens  $0.000091  via daemon   tier 1 sure: chit_chat=0.96
4 injection     1 call   p50 216 ms  2186 tokens  $0.000092  via daemon   tier 1 sure: injection=0.99
5 bug finding   1 call   p50 228 ms  2199 tokens  $0.000092  via daemon   tier 1: saved [bug]
6 recall        1 call   p50 210 ms   563 tokens  $0.000024  via daemon   injected the Postgres line
```

```text
- [superseded] We are going with SQLite as the primary store for this app. → id:tsfffg  <!-- id:osixeg ts:2026-09-22T12:48:33.402Z conf:0.93 by:tsfffg -->
- [decision] Switch the primary store to Postgres 16.  <!-- id:tsfffg ts:2026-09-22T12:48:37.606Z conf:0.99 -->
- [bug] Found it: the flaky login test was caused by two tests sharing the same temp directory for the session store.  <!-- id:bvf7wx ts:2026-09-22T12:48:38.687Z conf:0.99 -->
```

`jevmem stats` afterwards: 8 calls, p50 319 ms, p95 739 ms, $0.0007 total, `decide tiers: 5 tier-1, 1 tier-2; escalation rate 20%`.
