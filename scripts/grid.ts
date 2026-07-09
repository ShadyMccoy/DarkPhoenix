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
 *
 * FULL RUNS use per-world process isolation (npm run grid:full): a single
 * process running every world sequentially accumulates mockup engine/storage
 * memory (measured: one child at 8.7GB by world 11 of 14, then "Storage
 * connection lost"). `--count` prints the batch count, `--batch i` runs ONE
 * world and stores its verdicts under test/grid/.batch-verdicts/, `--merge`
 * combines them into the normal report + ratchet.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import * as path from "path";
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

  // Per-world process isolation (see file header). --count/--batch/--merge
  // only make sense on FULL cell sets: a filter changes batch indexing.
  const VERDICT_DIR = path.resolve("test", "grid", ".batch-verdicts");
  if (flag("count")) {
    console.log(String(batches.length));
    return;
  }
  const batchIdx = opt("batch");
  if (batchIdx !== undefined) {
    const i = Number(batchIdx);
    if (!batches[i]) throw new Error(`no batch ${i} (have ${batches.length})`);
    const batch = packBatch(batches[i]);
    console.log(
      `world ${i + 1}/${batches.length}: ${batch.cells.length} bot(s), window ${batch.window}t`
    );
    const batchVerdicts = await runBatch(batch, { port: PORT_BASE + i, debug: flag("debug") });
    mkdirSync(VERDICT_DIR, { recursive: true });
    writeFileSync(path.join(VERDICT_DIR, `batch-${i}.json`), JSON.stringify(batchVerdicts));
    return;
  }
  if (flag("merge")) {
    const verdicts: CellVerdict[] = [];
    for (const f of readdirSync(VERDICT_DIR).filter((f) => f.endsWith(".json"))) {
      verdicts.push(...(JSON.parse(readFileSync(path.join(VERDICT_DIR, f)).toString()) as CellVerdict[]));
    }
    if (verdicts.length === 0) throw new Error("no batch verdicts to merge");
    removeVerdictDir(VERDICT_DIR);
    finishRun(verdicts, false);
    return;
  }
  removeVerdictDir(VERDICT_DIR);

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

  // The ratchet's missing-cell check only means something on FULL runs; a
  // --cell/--tier/--avenue subset legitimately omits baseline cells.
  finishRun(verdicts, Boolean(cellFilter || tierFilter !== undefined || avenueFilter));
}

/** rmSync isn't in this repo's @types/node vintage; unlink + rmdir suffice. */
function removeVerdictDir(dir: string): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) unlinkSync(path.join(dir, f));
  rmdirSync(dir);
}

/** Report + ratchet, shared by the sequential path and --merge. */
function finishRun(verdicts: CellVerdict[], filtered: boolean): void {
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
  if (filtered) {
    console.log("\n(filtered run: baseline ratchet skipped)");
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
