#!/usr/bin/env ts-node
/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * THE CORP-SUMMED BUDGET (spec 51) - the statement's cost side as a projection
 * of the corps, not a reconstruction of them.
 *
 * Owner 2026-08-06: *"Every corp plan is essentially a list of inputs and
 * outputs. Thats the corp budget. The colony budget is the sum of the corps.
 * Each corps is assigned a reporting category for aggregate overview and
 * presentation but the row can be drilled down to the corp level."*
 *
 * That is exactly what this prints: category rows that ARE the sum of their
 * corps, each expandable to the corps that add up to it. Nothing here computes
 * an economic quantity - every number is `consumes`/`produces` read off a
 * published commission envelope (segment 4 v17).
 *
 * Contrast with `waste-ledger.ts`'s budget column, which re-derives the same
 * quantities with its own formulas (`minerOverhead`, `haulerOverhead`,
 * `planSpawnLoad`). Two books. This is the first one; run both and diff.
 *
 * Usage:
 *   npm run audit:corps                 # newest capture
 *   npm run audit:corps -- --drill      # expand every category to its corps
 *   npm run audit:corps -- --file shard1-t72823437.json
 *
 * @module scripts/corp-budget
 */

import * as fs from "fs";
import * as path from "path";

const FIXTURES = path.join(__dirname, "..", "test", "fixtures", "telemetry");

/** One published corp row, as segment 4 v17 emits it. */
export interface CorpRow {
  id: string;
  kind: string;
  roomName?: string;
  account?: string;
  shape?: string;
  consumes?: { energyRate?: number; spawnPartsPerTick?: number };
  produces?: { energyRate?: number; valuePerTick?: number };
  creepCount?: number;
  bodyParts?: number;
}

export interface CategoryRoll {
  account: string;
  spawnPartsPerTick: number;
  energyIn: number;
  energyOut: number;
  valueOut: number;
  corps: CorpRow[];
}

/**
 * Group corp rows into category rolls. THE projection - a category row is
 * defined as the sum of its corps and nothing else, which is what makes the
 * drill-down exact rather than illustrative.
 *
 * Rows with no `account` are grouped under "UNCLASSIFIED" rather than dropped or
 * folded into a residual: an unclassified corp must be visible. (Silently
 * absorbing one is how the `jack` role hid inside overhead for months.)
 */
export function rollUp(rows: CorpRow[]): CategoryRoll[] {
  const by = new Map<string, CategoryRoll>();
  for (const r of rows) {
    const account = r.account ?? "UNCLASSIFIED";
    const roll = by.get(account) ?? {
      account,
      spawnPartsPerTick: 0,
      energyIn: 0,
      energyOut: 0,
      valueOut: 0,
      corps: []
    };
    roll.spawnPartsPerTick += r.consumes?.spawnPartsPerTick ?? 0;
    roll.energyIn += r.consumes?.energyRate ?? 0;
    roll.energyOut += r.produces?.energyRate ?? 0;
    roll.valueOut += r.produces?.valuePerTick ?? 0;
    roll.corps.push(r);
    by.set(account, roll);
  }
  // Statement order: direct cost of mining, then overhead, then capital.
  const ORDER = [
    "extraction",
    "evacuation",
    "reservation",
    "infra",
    "defense",
    "consumers",
    "expansion",
    "incursion",
    "bootstrap",
    "UNCLASSIFIED"
  ];
  return [...by.values()].sort((a, b) => {
    const ia = ORDER.indexOf(a.account);
    const ib = ORDER.indexOf(b.account);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

const n2 = (v: number): string => v.toFixed(2);
const n4 = (v: number): string => v.toFixed(4);

/**
 * Render the roll-up. `drill` expands each category to the corps that sum to it
 * - the point of the whole design, so it is one flag away, never a second tool.
 */
export function formatCorpBudget(rows: CorpRow[], drill: boolean): string {
  const rolls = rollUp(rows);
  const out: string[] = [];
  out.push("CORP BUDGET  (the colony budget as the SUM of the corps - spec 51)");
  out.push("");
  out.push("  category        corps   spawn p/t     energy in    energy out    value out");
  out.push("  " + "-".repeat(74));
  let tParts = 0;
  let tIn = 0;
  let tOut = 0;
  let tVal = 0;
  for (const r of rolls) {
    out.push(
      "  " +
        r.account.padEnd(15) +
        String(r.corps.length).padStart(5) +
        n4(r.spawnPartsPerTick).padStart(12) +
        n2(r.energyIn).padStart(14) +
        n2(r.energyOut).padStart(14) +
        n2(r.valueOut).padStart(13)
    );
    tParts += r.spawnPartsPerTick;
    tIn += r.energyIn;
    tOut += r.energyOut;
    tVal += r.valueOut;
    if (drill) {
      // The addends. A category row is exactly this list summed - if the
      // drill-down does not add up, the roll-up is wrong, not the display.
      for (const c of r.corps.sort(
        (a, b) => (b.consumes?.spawnPartsPerTick ?? 0) - (a.consumes?.spawnPartsPerTick ?? 0)
      )) {
        out.push(
          "      " +
            c.id.slice(0, 30).padEnd(31) +
            n4(c.consumes?.spawnPartsPerTick ?? 0).padStart(10) +
            n2(c.consumes?.energyRate ?? 0).padStart(14) +
            n2(c.produces?.energyRate ?? 0).padStart(14) +
            n2(c.produces?.valuePerTick ?? 0).padStart(13) +
            (c.shape ? `   [${c.shape}]` : "")
        );
      }
    }
  }
  out.push("  " + "-".repeat(74));
  out.push(
    "  " +
      "COLONY".padEnd(15) +
      String(rows.length).padStart(5) +
      n4(tParts).padStart(12) +
      n2(tIn).padStart(14) +
      n2(tOut).padStart(14) +
      n2(tVal).padStart(13)
  );
  out.push("");

  // HONESTY LINES. The sum is only the colony budget once every corp is on it.
  const unpriced = rows.filter(r => (r.consumes?.spawnPartsPerTick ?? 0) === 0);
  const unclassified = rows.filter(r => !r.account);
  if (unpriced.length > 0) {
    out.push(`  ${unpriced.length} of ${rows.length} corps declare a ZERO budget (spec 51 GAP 2 - auxiliary corps are`);
    out.push(`  off-budget until spec 39 phase 4). Their real cost is deducted from the plan as`);
    out.push(`  standing infra and owned by NO row here: ${[...new Set(unpriced.map(r => r.kind))].join(", ")}`);
  }
  if (unclassified.length > 0) {
    out.push(`  ${unclassified.length} corps have no declared account category - classify them in`);
    out.push(`  economy/accountCategory: ${[...new Set(unclassified.map(r => r.kind))].join(", ")}`);
  }
  return out.join("\n");
}

function newestCapture(file?: string): { name: string; data: any } | undefined {
  const files = fs
    .readdirSync(FIXTURES)
    .filter(f => /^shard1-t\d+\.json$/.test(f))
    .map(f => ({ tick: Number(f.match(/t(\d+)/)![1]), f }))
    .sort((a, b) => b.tick - a.tick);
  const pick = file ? files.find(x => x.f === file) : files[0];
  if (!pick) return undefined;
  return { name: pick.f, data: JSON.parse(fs.readFileSync(path.join(FIXTURES, pick.f), "utf8")) };
}

if (require.main === module) {
  const fileArg = process.argv.indexOf("--file");
  const cap = newestCapture(fileArg >= 0 ? process.argv[fileArg + 1] : undefined);
  if (!cap) {
    console.log("corp budget: no capture found");
  } else {
    const rows = (cap.data?.data?.corps?.corps ?? []) as CorpRow[];
    const version = cap.data?.data?.corps?.version ?? 0;
    console.log(`capture ${cap.name}  (corps segment v${version})\n`);
    if (version < 17) {
      console.log(
        "This capture PREDATES the corp budget (segment 4 v17, spec 51): it carries no\n" +
          "consumes/produces/account, so there is nothing to sum. Deploy and recapture.\n" +
          "Printing what the rows DO carry, so the gap is visible rather than an empty table:\n"
      );
    }
    console.log(formatCorpBudget(rows, process.argv.includes("--drill")));
  }
}
