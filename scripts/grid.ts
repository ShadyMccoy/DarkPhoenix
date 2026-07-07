/**
 * grid - run the inflection-point test grid (docs/specs/08).
 *
 * Stages cells at decision moments and judges them inside short verdict
 * windows, many cells per world (one bot user each, isolation-packed).
 * Measures whatever dist/main.js is - run `npm run build` first.
 *
 * Usage:
 *   npm run grid                          # all cells
 *   npm run grid -- --cell churn-canary-readopt
 *   npm run grid -- --tier 1              # one tier
 *   npm run grid -- --avenue churn        # avenue substring match
 *   npm run grid -- --debug               # stream bot consoles
 *   npm run grid -- --update-baseline     # ratchet the new result in
 *
 * Exit code: 1 on baseline regression (bot level drop, or any baseline-green
 * cell now red), else 0. `--update-baseline` skips the check and rewrites
 * test/grid/baseline.json - commit it with the bot change that earned it.
 */

import { ALL_CELLS } from "../test/grid/cells";
import { CellVerdict } from "../test/grid/GridCell";
import { packBatch, partition } from "../test/grid/pack";
import { runBatch } from "../test/grid/runBatch";
import {
  buildResult,
  checkBaseline,
  renderTable,
  renderTimings,
  updateBaseline,
  writeLastRun,
} from "../test/grid/report";

const PORT_BASE = 26000;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  let cells = ALL_CELLS;
  const cellFilter = opt("cell");
  if (cellFilter) {
    const wanted = new Set(cellFilter.split(","));
    cells = cells.filter((c) => wanted.has(c.id));
  }
  const tierFilter = opt("tier");
  if (tierFilter !== undefined) cells = cells.filter((c) => c.tier === Number(tierFilter));
  const avenueFilter = opt("avenue");
  if (avenueFilter) cells = cells.filter((c) => c.avenue.includes(avenueFilter));

  if (flag("list")) {
    for (const c of cells) console.log(`T${c.tier}  ${c.id.padEnd(42)} ${c.window}t  (${c.avenue})`);
    return;
  }
  if (cells.length === 0) {
    console.error("no cells match the filter");
    process.exit(2);
  }

  const batches = partition(cells);
  console.log(`grid: ${cells.length} cell(s) in ${batches.length} world(s)`);

  const verdicts: CellVerdict[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = packBatch(batches[i]);
    const port = PORT_BASE + i;
    console.log(
      `world ${i + 1}/${batches.length}: ${batch.cells.length} bot(s), ` +
        `window ${batch.window}t, port ${port}`
    );
    const started = Date.now();
    let lastLog = started;
    const batchVerdicts = await runBatch(batch, {
      port,
      debug: flag("debug"),
      onTick: (tick, undecided) => {
        if (Date.now() - lastLog > 10_000) {
          lastLog = Date.now();
          console.log(`  tick ${tick}/${batch.window}, ${undecided} cell(s) undecided`);
        }
      },
    });
    console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    verdicts.push(...batchVerdicts);
  }

  const result = buildResult(verdicts);
  console.log("");
  console.log(renderTable(result));
  console.log(renderTimings(result));
  writeLastRun(result);

  if (flag("update-baseline")) {
    updateBaseline(result);
    console.log("\nbaseline updated (commit test/grid/baseline.json with the change that earned it)");
    return;
  }
  const regressions = checkBaseline(result);
  if (regressions.length > 0) {
    console.error("\nRATCHET FAILURE:");
    for (const r of regressions) console.error(`  ${r}`);
    process.exit(1);
  }
}

// The mockup's engine children keep the event loop alive after server.stop()
// (same reason sim-parallel exits explicitly), so exit codes are set by hand.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
