#!/bin/sh
# The Jev side of the local-model test of 2026-10-02 (issue #15): fresh Jev baselines with the repo's own eval scripts,
# unmodified, to set beside scripts/local-model-ollaya.sh's runs of the same sets.
#
#   scripts/local-model-jev.sh          (OUT=<folder> to choose where the files go)
#
# The commands as run that day, with two changes: it runs in the repository this script is in, and it writes to $OUT
# (by default a folder in the system temp directory) instead of the session's own folder. The key is read from
# ~/.jevmem/env and never echoed. macOS only: caffeinate keeps the machine awake.
cd "$(dirname "$0")/.." || exit 1
set -a
. "$HOME/.jevmem/env"
set +a
unset TYPESAFE_BASE_URL TYPESAFE_DEFAULT_MODEL
OUT=${OUT:-${TMPDIR:-/tmp}/jevmem-local-model}
mkdir -p "$OUT"
echo "eval start $(date -u +%FT%TZ)"
caffeinate -i node scripts/eval.mjs --out "$OUT/jev-eval-heldout.json" > "$OUT/jev-eval-heldout.txt" 2>&1
echo "eval exit $? $(date -u +%FT%TZ)"
caffeinate -i node scripts/eval-recall.mjs --set heldout2 --pkg . --label jev --out "$OUT/jev-recall-heldout2.json" > "$OUT/jev-recall-heldout2.txt" 2>&1
echo "recall exit $? $(date -u +%FT%TZ)"
caffeinate -i node scripts/eval-guard.mjs --set heldout-v2 --out "$OUT/jev-guard-heldout-v2.json" > "$OUT/jev-guard-heldout-v2.txt" 2>&1
echo "guard exit $? $(date -u +%FT%TZ)"
