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
scripts/e2e.sh --runs 3 --automemory both   # REAL multi-turn Claude Code session under the desktop app's stripped env (needs a logged-in `claude`)
scripts/e2e.sh --scenario plugin           # the same turns with jevmem installed as a Claude Code plugin (from an npm pack tarball)
scripts/e2e.sh --scenario outage           # Jev answers 529 for one turn (local proxy), then recovers
claude plugin validate --strict .claude-plugin/plugin.json
```

See [DEMO.md](DEMO.md) for a scripted 60-second demo, [DECISIONS.md](DECISIONS.md) for the design decisions, and [results/README.md](results/README.md) for what each results file is.

`pnpm test` needs no keys. The eval, benchmark and e2e commands call real APIs and cost a little money; they are not needed for most changes.

## Changes that affect numbers

Every measured number in the README and `docs/` must come from a file in `results/` listed in `results/CURRENT.json`; `node scripts/check-claims.mjs` enforces it in CI. If your change moves a number, re-run the script that produces it, commit the new results file, and update the docs. Do not tune against `eval/heldout.jsonl` or `eval/memory-injection.jsonl`: they are final exams. Tune on `eval/contradictions-dev.jsonl`, `eval/memory-injection-dev.jsonl` or a new dev set.

## Pull requests

Keep them focused, add a test for behaviour changes, and run `pnpm build && pnpm lint && pnpm test && node scripts/check-claims.mjs` before opening one.

## Releasing

1. Bump the version in `package.json`, `.claude-plugin/plugin.json` and the npm source in `.claude-plugin/marketplace.json` (a test keeps the three equal), and add a CHANGELOG entry.
2. `pnpm build && pnpm lint && pnpm test && node scripts/check-claims.mjs`, and `scripts/e2e.sh --runs 3` plus the `plugin` and `outage` scenarios for anything that touches the hooks.
3. Tag `vX.Y.Z` and push the tag. `.github/workflows/release.yml` verifies the tag (build, lint, tests, check-claims, matching versions, the packed tarball runs without `node_modules`) and, when the repository variable `NPM_PUBLISH` is `true`, publishes to npm with provenance through npm trusted publishing (OIDC). With `NPM_PUBLISH` unset, publish by hand with `npm publish`.

The Claude Code plugin is installed from npm (`.claude-plugin/marketplace.json` names an `npm` source), so a new plugin version reaches users only once that version is on npm.
