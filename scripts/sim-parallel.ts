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

function grid(): string[] {
  return Array.from({ length: 50 }, () => ".".repeat(50));
}
function setTile(g: string[], x: number, y: number, ch: string): void {
  if (x < 0 || x > 49 || y < 0 || y > 49) return;
  g[y] = g[y].slice(0, x) + ch + g[y].slice(x + 1);
}
function vWall(g: string[], x: number, gap?: [number, number]): void {
  for (let y = 1; y < 49; y++) if (!gap || y < gap[0] || y > gap[1]) setTile(g, x, y, "#");
}
function swampBand(g: string[], y1: number, y2: number): void {
  for (let y = y1; y <= y2; y++) for (let x = 1; x < 49; x++) setTile(g, x, y, "~");
}
/** Wall a source's 8 neighbours except one opening (north), so it has 1 mining spot. */
function pocket(g: string[], x: number, y: number): void {
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      if (dx === 0 && dy === -1) continue; // opening to the north
      setTile(g, x + dx, y + dy, "#");
    }
}

function layout(
  room: string,
  sources: Array<{ x: number; y: number }>,
  opts: { terrain?: string[]; controller?: { x: number; y: number } } = {}
): RoomLayout {
  return {
    room,
    terrain: opts.terrain ?? grid(),
    objects: [
      { type: "controller", x: opts.controller?.x ?? 25, y: opts.controller?.y ?? 10 },
      ...sources.map((s) => ({ type: "source", x: s.x, y: s.y })),
    ],
  };
}
function plainRoom(room: string, sources: Array<{ x: number; y: number }>): RoomLayout {
  return layout(room, sources);
}
const withTerrain = (build: (g: string[]) => void): string[] => {
  const g = grid();
  build(g);
  return g;
};

// Distinct, well-spaced rooms (spacing 2 so no bot's analysis box overlaps
// another's owned room). Each stresses a different "little thing" that tends to
// get stuck: source distance, count, corners/edges, a 1-spot pocket, a swamp
// haul, a choke point between source and spawn, and a far controller.
const SCENARIOS: Scenario[] = [
  { name: "1src-near", room: "W0N0", layout: layout("W0N0", [{ x: 25, y: 30 }]) },
  { name: "1src-far", room: "W2N0", layout: layout("W2N0", [{ x: 25, y: 45 }]) },
  { name: "2src-near", room: "W4N0", layout: layout("W4N0", [{ x: 18, y: 30 }, { x: 32, y: 30 }]) },
  { name: "2src-far", room: "W6N0", layout: layout("W6N0", [{ x: 8, y: 45 }, { x: 42, y: 45 }]) },
  { name: "1src-corner", room: "W8N0", layout: layout("W8N0", [{ x: 3, y: 3 }]) },
  { name: "1src-edge", room: "W10N0", layout: layout("W10N0", [{ x: 1, y: 25 }]) },
  { name: "src-pocket", room: "W12N0", layout: layout("W12N0", [{ x: 10, y: 25 }], { terrain: withTerrain((g) => pocket(g, 10, 25)) }) },
  { name: "swamp-haul", room: "W14N0", layout: layout("W14N0", [{ x: 25, y: 42 }], { terrain: withTerrain((g) => swampBand(g, 18, 24)) }) },
  { name: "choke", room: "W16N0", layout: layout("W16N0", [{ x: 8, y: 25 }], { terrain: withTerrain((g) => vWall(g, 15, [24, 25])) }) },
  { name: "3src", room: "W18N0", layout: layout("W18N0", [{ x: 12, y: 30 }, { x: 25, y: 42 }, { x: 38, y: 30 }]) },
  { name: "ctrl-corner", room: "W20N0", layout: layout("W20N0", [{ x: 20, y: 30 }, { x: 30, y: 30 }], { controller: { x: 45, y: 45 } }) },
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
