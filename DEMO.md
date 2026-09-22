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

Point at the stderr line: `jevmem: 1 jev call(s), p50 6xx ms, ~1900 tokens, $0.00008`.

### 2. Contradiction (0:20–0:40)

> Change of plan: SQLite locks under our write load. Switch the primary store to **Postgres 16**.

The hook makes one Jev call. `contradicts_existing_memory` comes back high and `touches_memory_id` picks the SQLite line. `JEVMEM.md` now reads:

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
3 call(s), 3 ok, p50 6xx ms, avg 6xx ms, ~4300 tokens, $0.0002 total
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

jevmem log
```

Expected: after step 1 one `[decision]` line; after step 2 that line becomes `[superseded] … → id:new` and a new `[decision]` line appears; step 3 prints `skipped — … chit_chat=0.9x` and the file is unchanged; step 4 prints a JSON object whose `additionalContext` contains the Postgres line.

## What this looked like for real

Run on 2026-09-22 against `jev-latest`, writer set to the deterministic fallback (`JEVMEM_WRITER=none`):

```text
- [superseded] We are going with SQLite as the primary store for this app. → id:nu9max  <!-- id:spb54a ts:2026-09-22T11:53:15.192Z conf:0.93 by:nu9max -->
- [decision] Switch the primary store to Postgres 16.  <!-- id:nu9max ts:2026-09-22T11:53:16.010Z conf:1.00 -->
- [bug] Found it: the flaky login test was caused by two tests sharing the same temp directory for the session store.  <!-- id:8bz7ax ts:2026-09-22T11:53:18.110Z conf:0.99 -->
```

Chit-chat: `skipped — kind=none, importance=trivial<useful, chit_chat=0.95`. Injection attempt: `skipped — injection=0.99`. Recall for "How should I connect to the database from the API layer?" injected the Postgres line at p=0.86. Eight Jev calls, p50 632 ms, 11,388 tokens, $0.000478 total.
