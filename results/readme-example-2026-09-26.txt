# README example lines, 2026-09-26: jevmem 0.5.7, dist built from commit 87c99dc (src unchanged), default writer ("provider": "none", no OpenAI or Anthropic key in the environment).
# A scratch git project with `jevmem enable`; three Stop-hook payloads with user_message only, through `node dist/cli.js hook` with JEVMEM_DAEMON=0 and the real Jev API.
#
# Turn 1: We'll use SQLite as the primary store for now.
# Turn 2: Actually, switch the primary store to Postgres 16. SQLite locks up under concurrent writes.
# Turn 3: Node 20 is the minimum supported version, and CI runs Node 20 and 22.
#
# The local writer keeps one sentence of the turn: turn 2's reason sentence is not in its line.
#
# JEVMEM.md after the three turns:
# JEVMEM.md

Project memory, maintained automatically by jevmem (https://github.com/Avinash-jetwani/jevmem).
AI assistants: do not add, edit or remove lines in this file. jevmem records decisions, constraints and bugs from the conversation on its own.
People: edit freely, one memory per line.

- [superseded] We'll use SQLite as the primary store for now. → id:cuasaq  <!-- id:21ycba ts:2026-09-26T13:46:34.703Z conf:1.00 by:cuasaq -->
- [decision] Switch the primary store to Postgres 16.  <!-- id:cuasaq ts:2026-09-26T13:46:35.240Z conf:1.00 -->
- [constraint] Node 20 is the minimum supported version, and CI runs Node 20 and 22.  <!-- id:tollba ts:2026-09-26T13:46:35.763Z conf:0.90 -->
