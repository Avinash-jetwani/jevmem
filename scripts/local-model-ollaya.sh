#!/bin/sh
# One eval step against a local model server (Ollaya, on http://localhost:11435), as in the local-model test of
# 2026-10-02 (issue #15). The server must be running with the model pulled.
#
#   scripts/local-model-ollaya.sh <model> <step> [modes]      (OUT=<folder> to choose where the files go)
#   scripts/local-model-ollaya.sh winnow:e4b eval-timeout auto
#
# The commands as run that day, with two changes: it runs in the repository this script is in, and it writes its
# results and its patched copies of the eval scripts to $OUT (by default a folder in the system temp directory)
# instead of the session's own folder. The real TypeSafe key is never loaded: each step gets a clean environment with
# a stand-in key, which the server ignores. macOS only: caffeinate keeps the machine awake.
# Traps: the results files do not record the model (the file name does), and eval-guard.mjs writes "jev-latest"
# whatever answered.
MODEL=$1
STEP=$2
TAG=$(printf %s "$MODEL" | tr ':/' '--')
cd "$(dirname "$0")/.." || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/jevmem-local-model}
mkdir -p "$OUT"
run() {
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
    TYPESAFE_BASE_URL=http://localhost:11435 TYPESAFE_DEFAULT_MODEL="$MODEL" TYPESAFE_API_KEY=local \
    caffeinate -i node "$@"
}
echo "$STEP start $(date -u +%FT%TZ)"
case $STEP in
  eval-fast)
    # The repo's script, unmodified, tier 1 only.
    run scripts/eval.mjs --modes fast --out "$OUT/$TAG-eval-heldout-fast.json" > "$OUT/$TAG-eval-heldout-fast.txt" 2>&1 ;;
  eval-all-unmodified)
    # The repo's script, unmodified, its default three modes (10 s client timeout).
    run scripts/eval.mjs --out "$OUT/$TAG-eval-heldout-unmodified.json" > "$OUT/$TAG-eval-heldout-unmodified.txt" 2>&1 ;;
  eval-timeout)
    # A copy of the script whose only change is the client timeout (10 s -> 180 s), for the modes named in $3.
    sed 's/lib.createJev({ noLogFile: true, cache: false })/lib.createJev({ noLogFile: true, cache: false, timeoutMs: 180000 })/' scripts/eval.mjs > "$OUT/eval-timeout.mjs"
    diff scripts/eval.mjs "$OUT/eval-timeout.mjs" | head -5
    MODES=${3:-auto,full}
    MTAG=$(printf %s "$MODES" | tr ',' '-')
    run "$OUT/eval-timeout.mjs" --modes "$MODES" --out "$OUT/$TAG-eval-heldout-$MTAG-timeout180.json" > "$OUT/$TAG-eval-heldout-$MTAG-timeout180.txt" 2>&1 ;;
  guard)
    run scripts/eval-guard.mjs --set heldout-v2 --out "$OUT/$TAG-guard-heldout-v2.json" > "$OUT/$TAG-guard-heldout-v2.txt" 2>&1 ;;
  recall)
    run scripts/eval-recall.mjs --set heldout2 --pkg . --label "$TAG" --out "$OUT/$TAG-recall-heldout2.json" > "$OUT/$TAG-recall-heldout2.txt" 2>&1 ;;
  recall-budget)
    # A copy of the script whose only change is the scratch project's config: the model named there, and the
    # hook's two Jev budgets raised from 1 s / 2 s to 600 s, so the model's own answers are scored.
    sed 's/JSON.stringify({ jev: { cache: false } }, null, 2)/JSON.stringify({ jev: { cache: false, model: process.env.TYPESAFE_DEFAULT_MODEL, recallTimeoutMs: 600000, timeoutMs: 600000 } }, null, 2)/' scripts/eval-recall.mjs > "$OUT/eval-recall-budget.mjs"
    diff scripts/eval-recall.mjs "$OUT/eval-recall-budget.mjs" | head -5
    run "$OUT/eval-recall-budget.mjs" --set heldout2 --pkg . --label "$TAG-budget600" --out "$OUT/$TAG-recall-heldout2-budget600.json" > "$OUT/$TAG-recall-heldout2-budget600.txt" 2>&1 ;;
  *) echo "unknown step $STEP"; exit 2 ;;
esac
echo "$STEP exit $? $(date -u +%FT%TZ)"
