#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * sim-multiroom - does one colony owning N rooms behave like N single rooms?
 *
 * Builds N well-separated, identical all-plain rooms (each its own spawn,
 * controller and two sources) owned by ONE bot, runs them, and compares each
 * room's progress to a single-room baseline. If the multi-room code scales
 * linearly - no cross-room cannibalisation, no interference - every room should
 * land close to the baseline and to each other.
 *
 * Usage:
 *   npm run sim:multiroom                 # baseline vs 3 rooms, default ticks
 *   npm run sim:multiroom -- --rooms 4 --ticks 1200
 *
 * Build first (npm run build) so dist/main.js is current.
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadLayout, addOwnedRoom, padNeighborTerrain, enableMods, FREE_ECONOMY_MOD, RoomLayout } from "../test/integration/loadLayout";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const DIST_MAIN_JS = "dist/main.js";

/** Rooms spaced 3 apart on the W axis so their analysis boxes never overlap. */
function roomName(i: number): string {
  return `W${i * 3}N0`;
}

/** An identical all-plain room: controller up top, two sources at the bottom. */
function room(name: string): RoomLayout {
  return {
    room: name,
    terrain: Array.from({ length: 50 }, () => ".".repeat(50)),
    objects: [
      { type: "controller", x: 25, y: 10 },
      { type: "source", x: 10, y: 40 },
      { type: "source", x: 40, y: 40 }
    ]
  };
}

interface RoomMetric {
  room: string;
  creeps: number;
  rcl: number;
  progress: number;
}

async function run(nRooms: number, ticks: number, sampleEvery: number, free = false): Promise<RoomMetric[]> {
  const port = 24000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve("server", `multiroom-${port}`);
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();

  const rooms = Array.from({ length: nRooms }, (_v, i) => roomName(i));
  for (const r of rooms) await loadLayout(server.world, room(r));
  await padNeighborTerrain(server.world, rooms);

  const modules = { main: readFileSync(DIST_MAIN_JS).toString() };
  // First room via addBot (creates the player); the rest are attached to it.
  const player = await server.world.addBot({ username: "player", room: rooms[0], x: 25, y: 25, modules });
  for (let i = 1; i < nRooms; i += 1) {
    await addOwnedRoom(server.world, player.id, rooms[i], 25, 25, `Spawn${i + 1}`);
  }

  // Inject the free-economy mod after the world is built, before the engine
  // forks - zeroes the build/upgrade energy sinks for faster, "longer" sims.
  if (free) enableMods(serverPath, [FREE_ECONOMY_MOD]);

  await server.start();
  for (let t = 1; t <= ticks; t += 1) {
    await server.tick();
    if (t % sampleEvery === 0) process.stdout.write(".");
  }
  process.stdout.write("\n");

  const metrics: RoomMetric[] = [];
  for (const r of rooms) {
    const objs = await server.world.roomObjects(r);
    const ctrl = objs.find((o: any) => o.type === "controller");
    metrics.push({
      room: r,
      creeps: objs.filter((o: any) => o.type === "creep").length,
      rcl: ctrl?.level ?? 0,
      progress: ctrl?.progress ?? 0
    });
  }
  await server.stop();
  return metrics;
}

function summarize(label: string, metrics: RoomMetric[]): void {
  console.log(`\n--- ${label} ---`);
  console.log("  room      creeps  RCL  progress");
  for (const m of metrics) {
    console.log(`  ${m.room.padEnd(8)}  ${String(m.creeps).padStart(6)}  ${String(m.rcl).padStart(3)}  ${String(m.progress).padStart(8)}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };
  const nRooms = parseInt(getArg("rooms", "3"), 10);
  const ticks = parseInt(getArg("ticks", "1000"), 10);
  const sampleEvery = parseInt(getArg("sample", "100"), 10);
  const free = args.includes("--free");

  console.log(`Baseline (1 room) vs ${nRooms} rooms, ${ticks} ticks each${free ? " [free economy]" : ""}...`);

  const baseline = (await run(1, ticks, sampleEvery, free))[0];
  const multi = await run(nRooms, ticks, sampleEvery, free);

  summarize("baseline (1 room)", [baseline]);
  summarize(`${nRooms} rooms (one colony)`, multi);

  // How far does each room stray from the baseline, and from each other?
  const progresses = multi.map(m => m.progress);
  const min = Math.min(...progresses);
  const max = Math.max(...progresses);
  const mean = progresses.reduce((a, b) => a + b, 0) / progresses.length;
  const spread = mean > 0 ? ((max - min) / mean) * 100 : 0;
  const vsBaseline = baseline.progress > 0 ? ((mean - baseline.progress) / baseline.progress) * 100 : 0;

  console.log("\n=== Linearity check ===");
  console.log(`  baseline progress:   ${baseline.progress}`);
  console.log(`  multi mean progress: ${mean.toFixed(0)}  (${vsBaseline >= 0 ? "+" : ""}${vsBaseline.toFixed(1)}% vs baseline)`);
  console.log(`  spread across rooms: ${spread.toFixed(1)}%  (min ${min}, max ${max})`);
  console.log(
    spread < 25 && Math.abs(vsBaseline) < 25
      ? "  => rooms scale ~linearly (each behaves like the single-room baseline)."
      : "  => OUTLIER: rooms diverge from the baseline / each other - investigate interference."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("sim-multiroom failed:", err);
    process.exit(1);
  });
