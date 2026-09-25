# Results

Every measured number in the docs comes from a file listed in [`CURRENT.json`](CURRENT.json); `node scripts/check-claims.mjs` (run in CI) fails if a doc number has no source here.

| File | Produced by | What it is |
|---|---|---|
| `contradictions-dev-before.json`, `contradictions-dev-after-run1.json`, `contradictions-dev-after-run2.json` | `node scripts/diag-contradictions.mjs` | v0.4.1 code (before, commit `b1b38a2`) and v0.4.2 code (two after runs, commit `5f2fe15`) on `eval/contradictions-dev.jsonl`: found / wrong id / false supersedes per mode, and every tier's contradiction signals per case |
| `bench-heldout-2026-09-23-v042.json` | `node scripts/bench-llm.mjs --set heldout` | v0.4.2 final exam, run once after the fix: six LLMs + jevmem `auto` on `eval/heldout.jsonl` (66 turns), all seven concurrently (15:17–15:32 UTC) |
| `bench-regression-2026-09-23-v042.json` | `node scripts/bench-llm.mjs --set regression` | v0.4.2. The same on `eval/transcript.jsonl` (50 turns), 15:32–15:44 UTC |
| `eval-heldout-2026-09-23-v042.json`, `eval-regression-2026-09-23-v042.json` | `node scripts/eval.mjs --set … --out …` | v0.4.2. jevmem `decide` in `fast` / `auto` / `full` |
| `ops-2026-09-23-v042.json` | `node scripts/bench-ops.mjs` | v0.4.2. recall / search / audit warm, cache hit, cold processes, hook processes through the warm daemon |
| `demo-2026-09-23-v042.txt` | the DEMO.md scripted steps | v0.4.2. Captured CLI output (home directory replaced with `~`) |
| `e2e-2026-09-23-v042.txt` | `scripts/e2e.sh --runs 3` | v0.4.2. Real Claude Code session, three runs (paths replaced with `~` / `<scratch>`) |
| `e2e-2026-09-25-v053.txt` | `scripts/e2e.sh --runs 3 --scenario full`, then `--scenario published` and `--scenario nocli` | v0.5.3 gate: 18 runs (linkguard, handwrite, plugin, dormant, nocli, outage, three each), all passed, with the plugin from `./plugin` and the CLI npm-installed from the packed checkout; then the plugin installed from GitHub (`plugin/` on main at `7d861f1`) and the no-CLI run, both passed. `~/.claude` unchanged before and after |
| `ops-2026-09-25-v053.json` | `node scripts/bench-ops.mjs` | v0.5.3 (working tree before the v0.5.3 commit): adds the plugin launcher (`plugin/hooks/jevmem-hook.sh`, finding the installed CLI) next to the `init` launcher, both through the warm daemon, in the same run. The machine was busier than in the earlier ops runs (load average above 10), so compare the two launchers within this file |
| `e2e-2026-09-25-v052.txt` | `scripts/e2e.sh --runs 3 --scenario full` | v0.5.2 gate, commit `d3b7f46`: the same 15 runs as v0.5.1, all passed; `~/.claude` unchanged before and after |
| `e2e-2026-09-25-v051.txt` | `scripts/e2e.sh --runs 3 --scenario full` | v0.5.1 gate, commit `60832e5`: three runs each of linkguard, handwrite, plugin (user-scope install, then `jevmem enable`), dormant (a session in a project not enabled: 0 requests through a counting proxy, no files; then enable and a saved line) and outage. Every `claude` call ran in a temporary `CLAUDE_CONFIG_DIR`; `~/.claude` was compared before and after and had not changed |
| `e2e-2026-09-25-v050.txt` | `scripts/e2e.sh --runs 3`, `--scenario plugin`, `--scenario outage` | v0.5.0 gate, commit `f4ea397`: a real Claude Code session per turn under the desktop app's stripped environment. Three runs of both existing scenarios with the async Stop hook, one plugin-install run (npm pack tarball, local marketplace, no init), one outage-then-recovery run (529 proxy in front of the real Jev API). Paths replaced with `~` / `<scratch>` |
| `demo-2026-09-25-v050.txt` | the DEMO.md scripted steps | v0.5.0. Captured CLI output, including a planted line withheld from recall and `audit --security --ci` exiting 1 |
| `memory-injection-2026-09-25-run1.json`, `memory-injection-2026-09-25-run2.json` | `node scripts/eval-injection.mjs` | v0.5.0 poisoning gate on `eval/memory-injection.jsonl` (44 lines, committed in `e9f4111` before the first run), two runs: blocked planted lines, false blocks, and the gate's added tokens and latency against the same recall call without it |
| `ops-2026-09-25-after-async-run1.json`, `ops-2026-09-25-after-async-run2.json` | `node scripts/bench-ops.mjs` | v0.5.0 non-blocking Stop hook (run on the part-C working tree before it was committed, hence `68b481e+dirty`; the code is commit `3e4b3ec`): launcher and handoff wall time, start to decision recorded. Two runs because the first run's daemon-off cold Stop (1,288 ms) was out of line with the second (653 ms) and the before file (679 ms); both are kept |
| `ops-2026-09-25-before-async.json` | `node scripts/bench-ops.mjs` | v0.5.0 code before the non-blocking Stop hook (commit `e9f4111`): the gated recall rows, and the "before" Stop hook wall time |
| `*-v041.*` | v0.4.1 | History: the v0.4.1 runs (before the contradiction fix). Not cited by the v0.4.2 docs |
| `bench-*-2026-09-23.json`, `eval-*-2026-09-23.json`, `ops-2026-09-23.json`, `demo-2026-09-23.txt`, `e2e-2026-09-23.txt` (no suffix) | v0.4.0 | History: the same runs on v0.4.0, whose tier 1 also asked the four atomic injection nouls. Not cited by the v0.4.1 docs |
| `a5-tier1-injection/` | `node scripts/eval.mjs --modes fast,auto` | History: tier 1 with one injection noul vs five, the measurement behind the v0.4.1 revert |
| `bench-2026-09-23.json`, `bench-2026-09-23-r2.json` | v0.3.7 / v0.3.8 | History. The LLMs got `previous_turns: null`, ran cold, and the eval set overlaps jevmem's prompt examples |

Notes on provenance:

- The v0.4.2 bench, eval and ops files record `commit 4323bfe` (the fix `5f2fe15` plus the dev-set results and DECISIONS entry), with a clean `src/`.
- The v0.4.1 files record `commit bd6951b` with a clean `src/`. A first v0.4.1 benchmark run (14:03–14:28 UTC) was discarded: its regression half hit OpenRouter's key credit limit (HTTP 402) for four LLMs. Both sets were re-run back to back after the limit was raised; the files here are that re-run.
- The v0.4.0 bench and eval files record `commit 32dc637` (bench) and `32dc637+dirty` (eval). `dist/` was built from `32dc637` before the runs and not rebuilt during them; the `+dirty` flag reflected edits to help text, agent rules and the writer made while the runs were in progress.
- Costs: LLMs = input × input price + output × output price; jevmem = input tokens × $0.042/M (output free).
- Latency percentiles exclude malformed answers; latency includes retries.
