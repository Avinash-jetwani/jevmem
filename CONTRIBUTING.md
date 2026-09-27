# Contributing

Thanks for helping. jevmem is small and young; issues, bug reports and pull requests are all welcome.

**Please don't post API keys in issues or pull requests.** That includes `TYPESAFE_API_KEY`, OpenAI, Anthropic and OpenRouter keys, and lines from `.jevmem/log.jsonl` or `.jevmem/hook-debug.log` that contain them. Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Setup

Node 20 or newer and pnpm.

```bash
pnpm install
pnpm build        # tsup → dist/
pnpm test         # vitest, Jev mocked (includes spawning dist/cli.js for the exit-code tests)
pnpm lint         # tsc --noEmit + eslint
JEVMEM_LIVE=1 pnpm test   # adds one real Jev test (needs TYPESAFE_API_KEY)
node scripts/eval.mjs --set heldout --out results/eval-heldout-$(date +%F).json   # score `decide` in fast/auto/full (live Jev); also --set regression
node scripts/bench-llm.mjs --set heldout   # the Benchmark tables (needs TYPESAFE_API_KEY + OPENROUTER_API_KEY)
node scripts/bench-ops.mjs                 # the non-decide rows of the Cost math table
node scripts/eval-injection.mjs            # the memory-poisoning gate on eval/memory-injection.jsonl (live Jev); --set dev for the dev set
node scripts/check-claims.mjs              # fails if a number in the docs is not in a results file listed in results/CURRENT.json (runs in CI)
node scripts/check-versions.mjs            # fails if package.json, plugin.json and the marketplace entry name different versions (runs in CI)
scripts/e2e.sh --runs 3 --automemory both   # REAL multi-turn Claude Code sessions under the desktop app's stripped env, in a temporary CLAUDE_CONFIG_DIR (needs CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`)
scripts/e2e.sh --scenario plugin           # the same turns with jevmem installed as a Claude Code plugin (from an npm pack tarball)
scripts/e2e.sh --scenario outage           # Jev answers 529 for one turn (local proxy), then recovers
scripts/e2e.sh --scenario dormant          # plugin installed, a session in a project without `jevmem enable` (nothing may happen), then enable
claude plugin validate --strict plugin     # the Claude Code plugin (plugin/)
node scripts/check-plugin.mjs              # plugin/ ships no code: no file over 256 KiB, no dist/, nothing minified (runs in CI)
```

See [DEMO.md](DEMO.md) for a scripted 60-second demo, [DECISIONS.md](DECISIONS.md) for the design decisions, and [results/README.md](results/README.md) for what each results file is.

`pnpm test` needs no keys. The eval, benchmark and e2e commands call real APIs and cost a little money; they are not needed for most changes.

## Changes that affect numbers

Every measured number in the README and `docs/` must come from a file in `results/` listed in `results/CURRENT.json`; `node scripts/check-claims.mjs` enforces it in CI. If your change moves a number, re-run the script that produces it, commit the new results file, and update the docs. Do not tune against `eval/heldout.jsonl`, `eval/memory-injection.jsonl`, `eval/guard-heldout.jsonl` or the dead-end held-out sets (`eval/dead-ends-heldout.jsonl`, `eval/dead-ends-heldout-v2.jsonl`, `eval/dead-ends-gate-heldout-v2.jsonl`): they are final exams, and a changed decide path, writer or gate needs a new held-out set. Tune on `eval/contradictions-dev.jsonl`, `eval/memory-injection-dev.jsonl`, the dead-end dev sets or a new dev set.

## Pull requests

Keep them focused, add a test for behaviour changes, and run `pnpm build && pnpm lint && pnpm test && node scripts/check-claims.mjs` before opening one.

## Releasing

1. Bump the version in `package.json` and `plugin/.claude-plugin/plugin.json` (its `version` and `mcpServers.jevmem.env.JEVMEM_PLUGIN_VERSION`) together, in the same commit, and add a CHANGELOG entry. Claude Code updates an installed plugin only when `plugin.json`'s `version` changes, so a release that bumps only `package.json` never reaches plugin users. `node scripts/check-versions.mjs` (run in CI) and `test/plugin.test.ts` fail when they differ. Bump both for a plugin-only change too: the directory and Claude Code both key updates on that `version`.
2. **Restate the README's benchmark for the version that ships, or date it.** The README's benchmark table and the sentences under it (save/skip, save+kind, contradictions, p50 and $/decision for jevmem) are v0.4.2's, measured 2026-09-23. Rerun the 66-turn benchmark with the build being released (`node scripts/eval.mjs --set heldout`) and restate jevmem's row and those sentences from it, or label them clearly as v0.4.2's figures. They have moved on `main`: in `auto`, save+kind 62/66 at $0.000145 per decision after v0.6 part 2 ([results/eval-heldout-2026-09-27-after.json](results/eval-heldout-2026-09-27-after.json)), and 60/66 at $0.000143 after part 2b ([results/eval-heldout-2026-09-27-2b.json](results/eval-heldout-2026-09-27-2b.json)). The LLM rows need `scripts/bench-llm.mjs` only if they are restated too.
3. `pnpm build && pnpm lint && pnpm test && node scripts/check-claims.mjs`, `node scripts/check-plugin.mjs`, `claude plugin validate --strict plugin`, and `scripts/e2e.sh --runs 3 --scenario full` for anything that touches the hooks, keys or `plugin/`. e2e needs `TYPESAFE_API_KEY` in its own environment, which it copies into the sessions' temporary `~/.jevmem/env`, and a Claude Code token (see the script's header).
4. Push to `main` and wait for CI to pass.
5. Tag `vX.Y.Z` on that commit and push the tag. **Tags are permanent: never move, delete or re-use a pushed tag.** The release workflow publishes whatever a version tag points at, so a moved tag can publish different code under a version people already installed. If something is wrong after tagging, fix it in a new commit and release the next patch version.
6. `.github/workflows/release.yml` then runs three jobs in order:
   - `verify`: build, lint, tests, check-claims, matching versions, check-plugin, and the packed tarball runs without `node_modules`.
   - `publish` (only when the repository variable `NPM_PUBLISH` is `true`): `npm publish` with provenance through npm trusted publishing (OIDC).
   - `directory` (only after `publish` succeeds): fast-forwards the `directory` branch to the tagged commit. It never force-pushes, and it fails if the tagged commit isn't on `main` or isn't ahead of `directory`.
7. Create the GitHub release for the tag.
8. The Claude plugin directory follows `directory`, not `main`, and picks up the new commit on its own (on a schedule, or through the push webhook if it is set up). To have it look at once, select **Check for new commits** on the plugin's page at claude.ai/directory/manage. Depending on the plugin's publish setting, select **Publish** there once the version passes.

Never push to `directory` by hand, except to fast-forward it to a released tag if the `directory` job failed. The "Protect main" ruleset blocks deleting or force-pushing `main` and `directory`. With `NPM_PUBLISH` unset, publish by hand with `npm publish`, then fast-forward `directory` yourself: `git push origin vX.Y.Z^{commit}:refs/heads/directory` (no `--force`).

Users who add the marketplace with `claude plugin marketplace add Avinash-jetwani/jevmem` read `plugin/` from `main`. That is why a plugin version and its CLI are released together: in the gap between the push to `main` and `npm publish`, the launcher warns that the CLI is older than the plugin.
