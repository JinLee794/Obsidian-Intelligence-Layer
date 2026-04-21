#!/usr/bin/env bash
#
# Bench regression check — compare current performance against a committed baseline.
#
# Usage:
#   ./scripts/bench-check.sh              # compare against bench/baseline.json
#   ./scripts/bench-check.sh --update     # regenerate the baseline
#
# The baseline is committed to the repo so every PR gets a regression check.
# Vitest bench --compare reports per-benchmark deltas and exits non-zero on regression.

set -euo pipefail
cd "$(dirname "$0")/.."

BASELINE="bench/baseline.json"

if [[ "${1:-}" == "--update" ]]; then
  echo "Generating new baseline → $BASELINE"
  npx vitest bench --outputJson "$BASELINE"
  echo "✓ Baseline updated. Commit $BASELINE to lock it in."
  exit 0
fi

if [[ ! -f "$BASELINE" ]]; then
  echo "No baseline found at $BASELINE."
  echo "Run: ./scripts/bench-check.sh --update"
  exit 1
fi

echo "Comparing against baseline: $BASELINE"
npx vitest bench --compare "$BASELINE"
