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
JEVMEM_DOCKER=1 pnpm test # also builds the Dockerfile and asks the image for tools/list (needs Docker, and the pinned version on npm)
node scripts/eval.mjs --set heldout --out results/eval-heldout-$(date +%F).json   # score `decide` in fast/auto/full (live Jev); also --set regression
node scripts/bench-llm.mjs --set heldout   # the Benchmark tables (needs TYPESAFE_API_KEY + OPENROUTER_API_KEY)
node scripts/bench-ops.mjs                 # the non-decide rows of the Cost math table
node scripts/eval-injection.mjs            # the memory-poisoning gate on eval/memory-injection.jsonl (live Jev); --set dev for the dev set
node scripts/eval-lines.mjs --set dev      # the text of saved lines, judged by the rows' keys (live Jev); --set rules-dev for genuine rules and planted lines; --set cause-last-dev for replies that give the cause last
node scripts/check-claims.mjs              # fails if a number in the docs is not in a results file listed in results/CURRENT.json (runs in CI)
node scripts/check-versions.mjs            # fails if package.json, plugin.json and the marketplace entry name different versions (runs in CI)
scripts/e2e.sh --runs 3 --automemory both   # REAL multi-turn Claude Code sessions under the desktop app's stripped env, in a temporary CLAUDE_CONFIG_DIR (needs CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`)
scripts/e2e.sh --scenario plugin           # the same turns with jevmem installed as a Claude Code plugin (from an npm pack tarball)
scripts/e2e.sh --scenario outage           # Jev answers 529 for one turn (local proxy), then recovers
scripts/e2e.sh --scenario dormant          # plugin installed, a session in a project without `jevmem enable` (nothing may happen), then enable
scripts/e2e.sh --scenario full --model NAME   # the same sessions on one named model (`claude --model NAME`); without it they get Claude Code's own default, and either way the log names the model that served each scenario run
claude plugin validate --strict plugin     # the Claude Code plugin (plugin/)
node scripts/check-plugin.mjs              # plugin/ ships no code: no file over 256 KiB, no dist/, nothing minified (runs in CI)
```

See [DEMO.md](DEMO.md) for a scripted 60-second demo, [DECISIONS.md](DECISIONS.md) for the design decisions, and [results/README.md](results/README.md) for what each results file is.

`pnpm test` needs no keys. The eval, benchmark and e2e commands call real APIs and cost a little money; they are not needed for most changes.

## Changes that affect numbers

Every measured number in the README and `docs/` must come from a file in `results/` listed in `results/CURRENT.json`; `node scripts/check-claims.mjs` enforces it in CI. If your change moves a number, re-run the script that produces it, commit the new results file, and update the docs. Do not tune against `eval/heldout.jsonl`, `eval/memory-injection.jsonl`, `eval/guard-heldout.jsonl`, `eval/guard-heldout-v2.jsonl`, the dead-end held-out sets (`eval/dead-ends-heldout.jsonl`, `eval/dead-ends-heldout-v2.jsonl`, `eval/dead-ends-heldout-v3.jsonl`, `eval/dead-ends-gate-heldout-v2.jsonl`) the retrieval held-out sets (`eval/recall-heldout.jsonl`, `eval/recall-heldout-v2.jsonl`), decide held-out v4 (`eval/stops-heldout-v4.jsonl`), the line-text and genuine-rule held-out sets (`eval/lines-heldout.jsonl`, `eval/rules-heldout.jsonl`), or the cause-last held-out set (`eval/cause-last-heldout.jsonl`): they are final exams, and a changed decide path, writer, gate or recall needs a new held-out set. Tune on `eval/contradictions-dev.jsonl`, `eval/memory-injection-dev.jsonl`, the dead-end dev sets, `eval/recall-dev.jsonl`, `eval/stops-dev.jsonl`, `eval/lines-dev.jsonl`, `eval/rules-dev.jsonl`, `eval/cause-last-dev.jsonl`, the guard's dev sets (`eval/guard-dev.jsonl`, `eval/guard-git-dev.jsonl`, `eval/guard-shell-dev.jsonl`) or a new dev set. The outcome A/B's tasks (`eval/ab/tasks.mjs`) are not a tuning set either: they measure what Claude does, with real sessions (`node scripts/ab.mjs`, then `node scripts/ab-report.mjs`).

## Pull requests

Keep them focused, add a test for behaviour changes, and run `pnpm build && pnpm lint && pnpm test && node scripts/check-claims.mjs` before opening one.

## Releasing

1. Bump the version in `package.json`, `plugin/.claude-plugin/plugin.json` (its `version` and `mcpServers.jevmem.env.JEVMEM_PLUGIN_VERSION`), `server.json` (its `version` and `packages[0].version`, the MCP Registry entry) and the `Dockerfile` (the `jevmem@X.Y.Z` it installs, for MCP directories that inspect the server) together, in the same commit, and add a CHANGELOG entry. Claude Code updates an installed plugin only when `plugin.json`'s `version` changes, so a release that bumps only `package.json` never reaches plugin users. `node scripts/check-versions.mjs` (run in CI) and `test/plugin.test.ts` fail when they differ. Bump both for a plugin-only change too: the directory and Claude Code both key updates on that `version`.
2. **Restate every measured number for the version that ships, or date it.** Rerun the 66-turn benchmark with the build being released (`node scripts/eval.mjs --set heldout --out results/eval-heldout-<date>-v<version>.json`) and restate jevmem's row in the README's benchmark table and the sentences under it from that run, or label them clearly as an earlier version's figures; add the run as a column to the every-mode table in `docs/benchmark.md` (one dated run per column, with its results file). For every other number in the README, `docs/whats-new.md` and `docs/limits.md`, check whether the code it depends on changed after it was measured: if it did, rerun its set on the release build and restate the number (a changed recall, decide path, writer or gate needs a new held-out set, since the old one has been run); if it did not, keep it with its fine print (set, runs, Claude Code version, jevmem commit, date). Dev figures, answered-only figures and diagnostics stay in `docs/benchmark.md`. State the known limits: the misses of the held-out sets that were not fixed. The graphics in `docs/img/` repeat some of these numbers and `check-claims` does not read them: when one changes, change it in `docs/img/make_svgs.py` and write the SVGs again (`python3 docs/img/make_svgs.py .`).
3. `pnpm build && pnpm lint && pnpm test && node scripts/check-claims.mjs`, `node scripts/check-plugin.mjs`, `claude plugin validate --strict plugin`, and `scripts/e2e.sh --runs 3 --scenario full` for anything that touches the hooks, keys or `plugin/`. e2e needs `TYPESAFE_API_KEY` in its own environment, which it copies into the sessions' temporary `~/.jevmem/env`, and a Claude Code token (see the script's header); its log starts with the Claude Code binary and version it ran and ends with the model that served the sessions, which belong in the results file's header. And no guard errors in the trial log: where a copy of the candidate has run as the guard before the release (the trial in jevmem's own repository; its `report.sh` counts them), `jevmem doctor` lists no guard check that failed, and the guard log has no call on the `error` route or with an `error` since that build went in. 0.6.0 shipped with three such failures in its release session's log, the `[` fail-open fixed in 0.6.1.
4. Push to `main` and wait for CI to pass.
5. Tag `vX.Y.Z` on that commit and push the tag. **Tags are permanent: never move, delete or re-use a pushed tag.** The release workflow publishes whatever a version tag points at, so a moved tag can publish different code under a version people already installed. If something is wrong after tagging, fix it in a new commit and release the next patch version.
6. `.github/workflows/release.yml` then runs three jobs in order:
   - `verify`: build, lint, tests, check-claims, matching versions, check-plugin, and the packed tarball runs without `node_modules`.
   - `publish` (only when the repository variable `NPM_PUBLISH` is `true`): `npm publish` with provenance through npm trusted publishing (OIDC).
   - `directory` (only after `publish` succeeds): fast-forwards the `directory` branch to the tagged commit. It never force-pushes, and it fails if the tagged commit isn't on `main` or isn't ahead of `directory`. On `release/0.5.x`, a `main_check` job skips it for a tag that isn't on `main`, so a 0.5.x patch is published to npm and leaves `directory` as it is.

   **Then wait for npm.** The release is not done until `npm view jevmem@X.Y.Z version` shows the version (and `npm view jevmem dist-tags` says `latest` is it): a published version takes minutes to appear (0.6.0 took five), and `npm view` and the registry's own document miss it meanwhile. Until it is visible, nothing may write to the package on npm from anywhere, no `npm deprecate` and no `npm dist-tag`. What 0.6.1's release showed: a deprecation of the previous version was written while 0.6.1 was not yet listed; 0.6.1 stayed unlisted for more than thirty minutes; a re-run of the workflow got `E409 Cannot publish over previously staged version`; `npm stage list` had nothing to approve; 0.6.2 republished the same code, and npm listed both later. The steps below come after that.
7. Create the GitHub release for the tag.
8. The Claude plugin directory follows `directory`, not `main`, and picks up the new commit on its own (on a schedule, or through the push webhook if it is set up). To have it look at once, select **Check for new commits** on the plugin's page at claude.ai/directory/manage. Depending on the plugin's publish setting, select **Publish** there once the version passes.
9. **The MCP Registry** (from 0.6.0; nothing is published there before it). The entry is `server.json`: the npm package `jevmem`, stdio, `jevmem mcp`, and the variables the server reads. The registry checks that the published npm package's `package.json` has `mcpName` equal to `server.json`'s `name` (`io.github.Avinash-jetwani/jevmem`), so publish only after npm has the version `server.json` names (`npm view jevmem@X.Y.Z mcpName` prints it). With the registry's `mcp-publisher` ([releases](https://github.com/modelcontextprotocol/registry/releases); 1.8.1 validated the file on 2026-09-29), from the repository root:
   - `mcp-publisher validate server.json`
   - `mcp-publisher login github`: a device-code login as the GitHub user `Avinash-jetwani`, which grants the `io.github.Avinash-jetwani/*` namespace.
   - `mcp-publisher publish server.json`, then check it is listed: `curl "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.Avinash-jetwani/jevmem"`.
   A version in the registry cannot be changed; a fix is the next version. Later releases repeat the three steps after npm has the version.

Never push to `directory` by hand, except to fast-forward it to a released tag if the `directory` job failed. The "Protect main" ruleset blocks deleting or force-pushing `main` and `directory`. With `NPM_PUBLISH` unset, publish by hand with `npm publish`, then fast-forward `directory` yourself: `git push origin vX.Y.Z^{commit}:refs/heads/directory` (no `--force`).

Users who add the marketplace with `claude plugin marketplace add Avinash-jetwani/jevmem` read `plugin/` from `main`. That is why a plugin version and its CLI are released together: in the gap between the push to `main` and `npm publish`, the launcher warns that the CLI is older than the plugin.
