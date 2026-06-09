#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * sim-variance - hunt for corps whose ACTUAL throughput strays far from the
 * BUDGET they were funded with, across a range of room generations.
 *
 * The bot writes Memory.corpVariance every tick (snapshotCorpVariance): each
 * budgeted corp's budgeted vs actual rate and (actual-budget)/budget, sorted
 * worst-first. This runs several deliberately awkward rooms - long hauls, swamp
 * belts, far-flung or single sources - and prints the worst outliers in each, so
 * we can see which corp types misfire and where the cost model under/over-shoots.
 *
 * Runs with the free-economy mod by default so colonies reach a working state
 * fast (energy is not burned on build/upgrade); pass --paid to keep the sinks.
 *
 * Usage:
 *   npm run sim:variance                  # all scenarios, default ticks
 *   npm run sim:variance -- --ticks 2000 --top 8 --paid
 *
 * Build first (npm run build) so dist/main.js is current.
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadLayout, padNeighborTerrain, enableMods, FREE_ECONOMY_MOD, RoomLayout } from "../test/integration/loadLayout";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const DIST_MAIN_JS = "dist/main.js";
const ROOM = "W0N0";

/** A 50-line terrain with a horizontal swamp belt across the given rows. */
function swampBelt(y0: number, y1: number): string[] {
  return Array.from({ length: 50 }, (_v, y) => (y >= y0 && y <= y1 ? "~".repeat(50) : ".".repeat(50)));
}

interface Scenario {
  name: string;
  description: string;
  layout: RoomLayout;
  /** Where the bot's spawn goes. */
  spawn: { x: number; y: number };
}

const SCENARIOS: Scenario[] = [
  {
    name: "plain-2src",
    description: "baseline: two sources, controller, all plain",
    layout: { room: ROOM, objects: [
      { type: "controller", x: 25, y: 10 },
      { type: "source", x: 12, y: 40 }, { type: "source", x: 38, y: 40 }
    ] },
    spawn: { x: 25, y: 25 }
  },
  {
    name: "far-sources",
    description: "sources in opposite corners - long, unequal hauls",
    layout: { room: ROOM, objects: [
      { type: "controller", x: 25, y: 25 },
      { type: "source", x: 3, y: 3 }, { type: "source", x: 46, y: 46 }
    ] },
    spawn: { x: 25, y: 25 }
  },
  {
    name: "swamp-belt",
    description: "swamp band between the sources and the spawn - slow haulers",
    layout: { room: ROOM, terrain: swampBelt(20, 30), objects: [
      { type: "controller", x: 25, y: 8 },
      { type: "source", x: 12, y: 44 }, { type: "source", x: 38, y: 44 }
    ] },
    spawn: { x: 25, y: 12 }
  },
  {
    name: "one-src-far",
    description: "a single far-corner source - low income, long haul",
    layout: { room: ROOM, objects: [
      { type: "controller", x: 25, y: 25 },
      { type: "source", x: 45, y: 45 }
    ] },
    spawn: { x: 25, y: 25 }
  }
];

interface VarianceRow {
  id: string;
  type: string;
  budget: number;
  actual: number;
  variance: number;
}

async function run(scenario: Scenario, ticks: number, free: boolean): Promise<VarianceRow[]> {
  const port = 25000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve("server", `variance-${port}`);
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();
  await loadLayout(server.world, scenario.layout);
  await padNeighborTerrain(server.world, [scenario.layout.room]);

  const modules = { main: readFileSync(DIST_MAIN_JS).toString() };
  const player = await server.world.addBot({ username: "player", room: scenario.layout.room, x: scenario.spawn.x, y: scenario.spawn.y, modules });

  if (free) enableMods(serverPath, [FREE_ECONOMY_MOD]);
  await server.start();

  for (let t = 1; t <= ticks; t += 1) {
    await server.tick();
    if (t % 200 === 0) process.stdout.write(".");
  }
  process.stdout.write("\n");

  let rows: VarianceRow[] = [];
  try {
    const mem = JSON.parse((await player.memory) || "{}");
    rows = (mem.corpVariance as VarianceRow[]) ?? [];
  } catch {
    rows = [];
  }
  await server.stop();
  return rows;
}

function report(scenario: Scenario, rows: VarianceRow[], top: number): void {
  console.log(`\n--- ${scenario.name} (${scenario.description}) ---`);
  if (rows.length === 0) {
    console.log("  (no budgeted corps reported)");
    return;
  }
  console.log("  corp                         type          budget   actual   variance");
  for (const r of rows.slice(0, top)) {
    console.log(
      `  ${r.id.slice(0, 26).padEnd(28)} ${r.type.padEnd(12)} ${String(r.budget).padStart(7)}  ${String(r.actual).padStart(7)}  ${String(r.variance).padStart(8)}`
    );
  }
  const worst = rows[0];
  console.log(`  worst: ${worst.type} ${worst.id.slice(0, 24)} budget ${worst.budget} -> actual ${worst.actual} (${(worst.variance * 100).toFixed(0)}%)`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };
  const ticks = parseInt(getArg("ticks", "1500"), 10);
  const top = parseInt(getArg("top", "6"), 10);
  const free = !args.includes("--paid");

  console.log(`Hunting corp budget-vs-actual outliers across ${SCENARIOS.length} rooms, ${ticks} ticks${free ? " [free economy]" : ""}...`);

  const summary: Array<{ scenario: string; worstType: string; worstVariance: number }> = [];
  for (const scenario of SCENARIOS) {
    const rows = await run(scenario, ticks, free);
    report(scenario, rows, top);
    if (rows.length > 0) {
      summary.push({ scenario: scenario.name, worstType: rows[0].type, worstVariance: rows[0].variance });
    }
  }

  console.log("\n=== Worst outlier per scenario ===");
  for (const s of summary) {
    console.log(`  ${s.scenario.padEnd(14)} ${s.worstType.padEnd(12)} ${(s.worstVariance * 100).toFixed(0)}%`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("sim-variance failed:", err);
    process.exit(1);
  });
