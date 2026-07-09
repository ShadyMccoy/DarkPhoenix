#!/usr/bin/env bash
# Full grid with per-world process isolation (see scripts/grid.ts header):
# one short-lived process per world, so mockup engine/storage memory can never
# accumulate across worlds (measured: 8.7GB by world 11 in a single process,
# then "Storage connection lost"). Flags (e.g. --update-baseline) are applied
# at the merge step.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf test/grid/.batch-verdicts # stale verdicts from a killed run must not merge
GRID=(npx ts-node -P tsconfig.test.json scripts/grid.ts)
COUNT=$("${GRID[@]}" --count | tail -1)
echo "grid:full - ${COUNT} world(s), one process each"
for i in $(seq 0 $((COUNT - 1))); do
  "${GRID[@]}" --batch "$i"
done
"${GRID[@]}" --merge "$@"
