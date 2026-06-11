#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * sim-variance - track corp budget-vs-actual variance over a run.
 *
 * The bot writes Memory.corpVariance every 25 ticks (snapshotCorpVariance): each
 * budgeted corp's budgeted vs actual production rate and (actual-budget)/budget,
 * sorted worst-first. This runs the standard stub world (9 rooms, the path where
 * the engine reliably persists the bot's Memory), samples that snapshot over
 * time, and reports the worst outliers - the corps straying furthest below what
 * they were funded to produce - and how the gap evolves as the colony matures.
 *
 * Runs with the free-economy mod by default (build/upgrade sinks zeroed) so the
 * colony is not starved; pass --paid to keep them.
 *
 * Usage:
 *   npm run sim:variance                 # default ticks
 *   npm run sim:variance -- --ticks 2500 --sample 250 --top 8 --paid
 *
 * Build first (npm run build) so dist/main.js is current.
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { enableMods, FREE_ECONOMY_MOD, padNeighborTerrain } from "../test/integration/loadLayout";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer, TerrainMatrix } = require("screeps-server-mockup");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stubRooms = require("screeps-server-mockup/assets/rooms.json");

const DIST_MAIN_JS = "dist/main.js";

interface VarianceRow {
  id: string;
  type: string;
  budget: number;
  actual: number;
  variance: number;
}

interface Snapshot {
  tick: number;
  rows: VarianceRow[];
}

async function run(ticks: number, sampleEvery: number, free: boolean): Promise<Snapshot[]> {
  const port = 25000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve("server", `variance-${port}`);
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();
  // A SINGLE working room, not the 9-room stub world. The full stub world is
  // degenerate for a from-scratch bot: it exposes all 9 rooms at once (~102
  // nodes), which a real bot never sees at RCL1, and the colony stalls there (1
  // jack, 0 progress). One room with real (walled) terrain bootstraps fine AND
  // produces nodes for the flow economy - so the variance reflects a colony that
  // actually runs. We reuse the stub world's W0N1 terrain (proven to ramp).
  const room = "W0N1";
  const data = stubRooms[room];
  await server.world.addRoom(room);
  await server.world.setTerrain(room, TerrainMatrix.unserialize(data.serial));
  for (const o of data.objects) {
    if (o.type === "controller" || o.type === "source" || o.type === "mineral") {
      await server.world.addRoomObject(room, o.type, o.x, o.y, o.attributes);
    }
  }
  await padNeighborTerrain(server.world, [room]);
  const src = data.objects.find((o: any) => o.type === "source");
  const player = await server.world.addBot({
    username: "player", room, x: Math.min(48, src.x + 1), y: src.y,
    modules: { main: readFileSync(DIST_MAIN_JS).toString() }
  });

  if (free) enableMods(serverPath, [FREE_ECONOMY_MOD]);
  await server.start();

  const snapshots: Snapshot[] = [];
  for (let t = 1; t <= ticks; t += 1) {
    await server.tick();
    if (t % sampleEvery === 0 || t === ticks) {
      let rows: VarianceRow[] = [];
      try {
        rows = (JSON.parse((await player.memory) || "{}").corpVariance as VarianceRow[]) ?? [];
      } catch {
        rows = [];
      }
      snapshots.push({ tick: t, rows });
    }
  }
  await server.stop();
  return snapshots;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };
  const ticks = parseInt(getArg("ticks", "1500"), 10);
  const sampleEvery = parseInt(getArg("sample", "150"), 10);
  const top = parseInt(getArg("top", "6"), 10);
  const free = !args.includes("--paid");

  console.log(`Tracking corp budget-vs-actual variance over ${ticks} ticks (stub world)${free ? " [free economy]" : ""}...`);

  const snapshots = await run(ticks, sampleEvery, free);

  // Trend: how the average variance (over budgeted corps) moves as the colony matures.
  console.log("\n=== Variance trend (mean over budgeted corps) ===");
  console.log("  tick   corps   meanVariance   onBudget(|v|<0.2)");
  for (const s of snapshots) {
    const vs = s.rows.map(r => r.variance);
    const onBudget = vs.filter(v => Math.abs(v) < 0.2).length;
    console.log(`  ${String(s.tick).padStart(4)}  ${String(s.rows.length).padStart(5)}   ${mean(vs).toFixed(2).padStart(12)}   ${onBudget}/${s.rows.length}`);
  }

  // Worst outliers at the final sample.
  const last = snapshots[snapshots.length - 1];
  console.log(`\n=== Worst outliers @ tick ${last?.tick ?? 0} ===`);
  if (!last || last.rows.length === 0) {
    console.log("  (no budgeted corps reported)");
    return;
  }
  console.log("  corp                          type          budget   actual   variance");
  for (const r of last.rows.slice(0, top)) {
    console.log(`  ${r.id.slice(0, 27).padEnd(29)} ${r.type.padEnd(12)} ${String(r.budget).padStart(7)}  ${String(r.actual).padStart(7)}  ${String(r.variance).padStart(8)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("sim-variance failed:", err);
    process.exit(1);
  });
