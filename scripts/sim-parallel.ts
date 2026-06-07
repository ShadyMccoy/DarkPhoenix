/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * sim-parallel - run many colony scenarios in ONE world, in parallel.
 *
 * The screeps-server-mockup engine costs ~233 ms/tick regardless of how many
 * rooms/users it simulates; our bot adds ~67 ms/tick per colony. So running N
 * scenarios as N bots in one world costs `engine + N*bot` instead of
 * `N*(engine+bot)` - roughly 2-3x more throughput - and lets us compare room
 * designs side by side from a single run.
 *
 * Usage:
 *   npm run sim:parallel                       # default scenarios + ticks
 *   npm run sim:parallel -- --ticks 1500 --sample 150
 *
 * Each scenario is one room + one bot (its own user/GCL). We sample every
 * scenario each interval and print a side-by-side table.
 */

import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadLayout, padNeighborTerrain, RoomLayout } from "../test/integration/loadLayout";

// screeps-server-mockup ships no type definitions.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

interface Scenario {
  name: string;
  room: string;
  layout: RoomLayout;
  /** Optional: start the controller at this RCL for fast iteration. */
  startRcl?: number;
}

function plainRoom(room: string, sources: Array<{ x: number; y: number }>): RoomLayout {
  return {
    room,
    terrain: Array.from({ length: 50 }, () => ".".repeat(50)),
    objects: [
      { type: "controller", x: 25, y: 10 },
      ...sources.map((s) => ({ type: "source", x: s.x, y: s.y })),
    ],
  };
}

// Distinct rooms (must be separate room names in one world). Vary the design to
// compare: source count, source distance from the central controller/spawn, etc.
const SCENARIOS: Scenario[] = [
  { name: "1src-near", room: "W0N0", layout: plainRoom("W0N0", [{ x: 25, y: 30 }]) },
  { name: "1src-far", room: "W1N0", layout: plainRoom("W1N0", [{ x: 25, y: 45 }]) },
  { name: "2src-near", room: "W2N0", layout: plainRoom("W2N0", [{ x: 18, y: 30 }, { x: 32, y: 30 }]) },
  { name: "2src-far", room: "W3N0", layout: plainRoom("W3N0", [{ x: 8, y: 45 }, { x: 42, y: 45 }]) },
];

function getArg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

/** Cumulative control points for reaching a given RCL + progress (rough proxy). */
const RCL_TOTALS = [0, 200, 45200, 180200, 585200, 1395200, 3405200, 10405200];
function controlPoints(level: number, progress: number): number {
  return (RCL_TOTALS[level - 1] ?? 0) + progress;
}

async function main(): Promise<void> {
  const ticks = getArg("ticks", 1200);
  const sample = getArg("sample", 150);

  const port = 25000;
  const serverPath = path.resolve("server", String(port));
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();
  const main = readFileSync("dist/main.js").toString();

  for (const s of SCENARIOS) {
    await loadLayout(server.world, s.layout);
  }
  await padNeighborTerrain(server.world, SCENARIOS.map((s) => s.room));
  for (const s of SCENARIOS) {
    await server.world.addBot({ username: s.name, room: s.room, x: 25, y: 25, modules: { main } });
  }
  // Optional fast-start: bump controllers to the requested RCL.
  const { db } = await server.world.load();
  for (const s of SCENARIOS) {
    if (s.startRcl && s.startRcl > 1) {
      await db["rooms.objects"].update(
        { room: s.room, type: "controller" },
        { $set: { level: s.startRcl, progress: 0, downgradeTime: null, safeMode: null } }
      );
    }
  }

  await server.start();

  const pad = (s: string) => s.padStart(18);
  console.log(`Running ${SCENARIOS.length} scenarios in parallel for ${ticks} ticks (sample ${sample})`);
  console.log(["tick", ...SCENARIOS.map((s) => s.name)].map(pad).join(" "));

  for (let t = 1; t <= ticks; t++) {
    await server.tick();
    if (t % sample === 0) {
      const cells = [String(t)];
      for (const s of SCENARIOS) {
        const objs = await server.world.roomObjects(s.room);
        const ctrl = objs.find((o: any) => o.type === "controller");
        const creeps = objs.filter((o: any) => o.type === "creep").length;
        const exts = objs.filter((o: any) => o.type === "extension").length;
        const cp = ctrl ? controlPoints(ctrl.level, ctrl.progress) : 0;
        cells.push(`R${ctrl?.level ?? "?"} cp${cp} c${creeps} x${exts}`);
      }
      console.log(cells.map(pad).join(" "));
    }
  }

  await server.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
