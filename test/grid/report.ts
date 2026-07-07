/**
 * report - aggregate cell verdicts into the tier ladder, print the table,
 * write the JSON artifact, and enforce the baseline ratchet.
 *
 * BOT LEVEL = the highest tier T such that every tier <= T is 100% green
 * across all avenues (strict: one red T1 cell caps the bot at level 0, even if
 * T4 cells pass). The "frontier" (highest tier with any pass) is reported for
 * texture. The committed ratchet (test/grid/baseline.json) makes regressions
 * loud: CI exits 1 if the bot level drops OR any cell that passed in baseline
 * now fails - the per-cell ratchet catches regressions above the current
 * level. baseline.json is updated deliberately, in the same commit as the bot
 * change that earned it, so its git log is the bot's capability history.
 */

import * as fs from "fs";
import * as path from "path";
import { CellVerdict } from "./GridCell";

export const LAST_RUN_PATH = path.resolve(__dirname, "last-run.json");
export const BASELINE_PATH = path.resolve(__dirname, "baseline.json");

export interface GridResult {
  timestamp: string;
  botLevel: number;
  frontier: number;
  cells: CellVerdict[];
}

/** Highest tier T with every tier <= T fully green (-1 if T0 has a red). */
export function botLevel(verdicts: CellVerdict[]): number {
  let level = -1;
  for (let t = 0; t <= 5; t++) {
    const tier = verdicts.filter((v) => v.tier === t);
    if (tier.length === 0) continue; // an unpopulated tier doesn't cap the ladder
    if (tier.every((v) => v.status === "pass")) level = t;
    else break;
  }
  return level;
}

/** Highest tier with any pass at all. */
export function frontier(verdicts: CellVerdict[]): number {
  return verdicts.reduce((f, v) => (v.status === "pass" && v.tier > f ? v.tier : f), -1);
}

export function buildResult(verdicts: CellVerdict[]): GridResult {
  return {
    timestamp: new Date().toISOString(),
    botLevel: botLevel(verdicts),
    frontier: frontier(verdicts),
    cells: verdicts,
  };
}

const STATUS_MARK: Record<string, string> = { pass: "+", fail: "x", timeout: "T", error: "E" };

/** Human table: tiers x avenues, failing cells detailed, bot level last. */
export function renderTable(result: GridResult): string {
  const avenues = [...new Set(result.cells.map((c) => c.avenue))];
  const lines: string[] = [];

  const header = ["tier", ...avenues, "total"].map((s) => s.padEnd(14));
  lines.push(header.join(""));
  for (let t = 0; t <= 5; t++) {
    const tier = result.cells.filter((c) => c.tier === t);
    if (tier.length === 0) continue;
    const row = [`T${t}`.padEnd(14)];
    for (const a of avenues) {
      const cells = tier.filter((c) => c.avenue === a);
      row.push(
        (cells.length === 0 ? "-" : `${cells.filter((c) => c.status === "pass").length}/${cells.length}`).padEnd(14)
      );
    }
    row.push(`${tier.filter((c) => c.status === "pass").length}/${tier.length}`.padEnd(14));
    lines.push(row.join(""));
  }

  const bad = result.cells.filter((c) => c.status !== "pass");
  if (bad.length > 0) {
    lines.push("");
    for (const v of bad) {
      const failed = v.assertions.filter((a) => !a.satisfied).map((a) => `${a.mode}:"${a.name}"`);
      lines.push(
        `  [${STATUS_MARK[v.status]}] ${v.id} (T${v.tier}, ${v.status} @${v.decidedTick}/${v.window}t)` +
          (v.error ? ` ${v.error}` : failed.length ? ` ${failed.join(", ")}` : "")
      );
    }
  }

  lines.push("");
  lines.push(`BOT LEVEL: ${result.botLevel}   (frontier: T${result.frontier})`);
  return lines.join("\n");
}

/** Per-assertion satisfaction ticks - the calibration readout. */
export function renderTimings(result: GridResult): string {
  const lines: string[] = ["", "assertion timings (satisfiedAt ticks):"];
  for (const v of result.cells) {
    for (const a of v.assertions) {
      if (a.mode === "eventually" && a.satisfiedAt !== undefined) {
        lines.push(`  ${v.id} :: "${a.name}" @ tick ${a.satisfiedAt}`);
      }
    }
  }
  return lines.join("\n");
}

interface Baseline {
  botLevel: number;
  cells: Record<string, string>;
}

export function writeLastRun(result: GridResult): void {
  fs.writeFileSync(LAST_RUN_PATH, JSON.stringify(result, null, 2));
}

export function updateBaseline(result: GridResult): void {
  const cells: Record<string, string> = {};
  for (const c of result.cells) cells[c.id] = c.status;
  const baseline: Baseline = { botLevel: result.botLevel, cells };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
}

/**
 * Compare against the committed baseline. Returns human-readable regressions
 * (empty = ratchet holds). Cells new since baseline can't regress; cells
 * removed from the run are reported (a silently deleted guard is a regression
 * of the harness).
 */
export function checkBaseline(result: GridResult): string[] {
  if (!fs.existsSync(BASELINE_PATH)) return [];
  const baseline: Baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  const regressions: string[] = [];

  if (result.botLevel < baseline.botLevel) {
    regressions.push(`bot level dropped: ${baseline.botLevel} -> ${result.botLevel}`);
  }
  const byId = new Map(result.cells.map((c) => [c.id, c.status]));
  for (const [id, status] of Object.entries(baseline.cells)) {
    if (status !== "pass") continue;
    const now = byId.get(id);
    if (now === undefined) regressions.push(`baseline-green cell missing from run: ${id}`);
    else if (now !== "pass") regressions.push(`baseline-green cell regressed: ${id} (${now})`);
  }
  return regressions;
}
