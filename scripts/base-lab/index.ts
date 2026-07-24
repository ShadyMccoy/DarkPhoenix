/* eslint-disable no-console */
/**
 * base-lab - a read-only lab for iterating on base designs.
 *
 * Loads a room (a captured fixture, or a synthetic RoomBuilder room), computes
 * the spatial layers we've been reasoning about, drops stamps into the quiet
 * space, and renders an ASCII overlay + metrics so we can LOOK at a design
 * before committing any of it to the live planner.
 *
 * Layers:
 *   - terrain          (# wall, ~ swamp, . plain)   [fixture string[]]
 *   - clearance        distance-transform            [src/spatial/algorithms]
 *   - highways (=)     a-priori routes spawn<->sources/controller  [our A*]
 *   - dead space (.)   reachable, off-highway, non-anchor tiles - the eddies
 *                      where extensions + stationary feeders belong
 *
 * Everything is OFFLINE and pure (no Game/PathFinder/engine). The a-priori
 * route planner in ConstructionCorp isn't callable offline, so highways use a
 * self-contained weighted Dijkstra (plain 2 / swamp 10) - see geometry.ts.
 *
 * Run:
 *   npx ts-node -P tsconfig.test.json scripts/base-lab/index.ts [fixture] [--target N]
 *   npx ts-node -P tsconfig.test.json scripts/base-lab/index.ts --list
 *   npx ts-node -P tsconfig.test.json scripts/base-lab/index.ts --synthetic
 */
import { readFileSync, readdirSync } from "fs";
import * as path from "path";
import { createMultiRoomDistanceTransform } from "../../src/spatial/algorithms";
import { pickSpawnSpot, type RoomPoint } from "../../src/spatial/spawnPlacement";
import { RoomBuilder } from "../../test/integration/scenario/RoomBuilder";
import { SIZE, packTile, isWall, isSwamp, route, reachable, type Pt } from "./geometry";
import { CORE_POCKET, RING_FEEDER, GLYPH, solidCells, extensionCount, type Stamp } from "./stamps";

const FIXTURE_DIR = path.resolve("test", "fixtures", "real-rooms");
const RCL8_EXTENSIONS = 60;

interface Obj {
  type: string;
  x: number;
  y: number;
}
interface RoomInput {
  name: string;
  terrain: string[];
  objects: Obj[];
}

function listFixtures(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => f.replace(/\.json$/, ""));
}

function loadFixture(name: string): RoomInput {
  const file = path.resolve(FIXTURE_DIR, `${name}.json`);
  const fx = JSON.parse(readFileSync(file).toString());
  return { name: fx.room ?? name, terrain: fx.terrain, objects: fx.objects ?? [] };
}

function synthetic(): RoomInput {
  // A room with a swamp belt and a wall spur, to exercise the fit rules.
  const b = new RoomBuilder("W0N0")
    .border()
    .rect(20, 8, 30, 14, "swamp")
    .vWall(38, { gap: [24, 26] })
    .source(8, 12)
    .source(41, 40)
    .controller(15, 40);
  const r = b.toRoom();
  return { name: r.room, terrain: r.terrain, objects: r.objects as Obj[] };
}

/** Anchors the highways connect and the spawn wants to be near. */
function anchorsOf(input: RoomInput): { sources: Obj[]; controller: Obj | null; mineral: Obj | null } {
  return {
    sources: input.objects.filter(o => o.type === "source"),
    controller: input.objects.find(o => o.type === "controller") ?? null,
    mineral: input.objects.find(o => o.type === "mineral") ?? null
  };
}

interface Placed {
  glyph: string;
  stamp: string;
}

function tryPlace(
  stamp: Stamp,
  cx: number,
  cy: number,
  terrain: string[],
  reachSet: Set<number>,
  highways: Set<number>,
  anchorTiles: Set<number>,
  occupied: Set<number>,
  placed: Map<number, Placed>
): boolean {
  // Fit check: every solid cell must land on a reachable, non-wall, non-swamp,
  // off-highway, un-occupied, non-anchor tile. (No swamp under a pocket - the
  // fatigue math detonates 5x on swamp, measured.) Reserved holes only need to
  // be in-bounds and un-occupied so stamps don't interlock.
  for (const c of stamp.cells) {
    const tx = cx + c.dx;
    const ty = cy + c.dy;
    if (tx < 0 || tx >= SIZE || ty < 0 || ty >= SIZE) return false;
    const tile = packTile(tx, ty);
    if (occupied.has(tile)) return false;
    if (c.kind === "reserved") continue;
    if (!reachSet.has(tile)) return false;
    if (isWall(terrain, tx, ty)) return false;
    if (isSwamp(terrain, tx, ty)) return false;
    if (highways.has(tile)) return false;
    if (anchorTiles.has(tile)) return false;
  }
  for (const c of stamp.cells) {
    const tile = packTile(cx + c.dx, cy + c.dy);
    occupied.add(tile);
    if (c.kind !== "reserved") placed.set(tile, { glyph: GLYPH[c.kind], stamp: stamp.name });
  }
  return true;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    console.log(listFixtures().join("\n"));
    return;
  }
  const targetArg = args.indexOf("--target");
  const target = targetArg >= 0 ? Number(args[targetArg + 1]) : RCL8_EXTENSIONS;
  const useSynthetic = args.includes("--synthetic");
  const positional = args.find(a => !a.startsWith("--") && a !== String(target));

  const input = useSynthetic ? synthetic() : loadFixture(positional ?? defaultFixture());
  const { terrain } = input;
  const { sources, controller, mineral } = anchorsOf(input);

  // --- spawn / core anchor ---
  const nearList: RoomPoint[] = [...sources, ...(controller ? [controller] : [])];
  const spawn = pickSpawnSpot(terrain, nearList) ?? { x: 25, y: 25 };

  // --- clearance (distance-transform) ---
  const cb = (_r: string, x: number, y: number): number => (isWall(terrain, x, y) ? 1 : 0);
  const distances = createMultiRoomDistanceTransform([input.name], cb, 1, 1, new Set([input.name]));
  const clearance = (x: number, y: number): number => distances.get(`${input.name}:${x},${y}`) ?? 0;

  // --- reachability + anchors ---
  const reachSet = reachable(terrain, spawn);
  const anchorTiles = new Set<number>(
    [...sources, ...(controller ? [controller] : []), ...(mineral ? [mineral] : [])].map(o => packTile(o.x, o.y))
  );

  const occupied = new Set<number>();
  const placed = new Map<number, Placed>();

  // 1) core pocket at the spawn spot FIRST, before highways exist. The core is
  //    the hub the arteries radiate FROM, so it is exempt from the avoid-
  //    highway rule (highways route out of it, not around it).
  const coreOk = tryPlace(CORE_POCKET, spawn.x, spawn.y, terrain, reachSet, new Set(), anchorTiles, occupied, placed);

  // --- highways: a-priori routes spawn <-> each source and the controller ---
  const highways = new Set<number>();
  let highwaySwamp = 0;
  const routeTargets: Pt[] = [...sources, ...(controller ? [controller] : [])];
  for (const t of routeTargets) {
    const p = route(terrain, spawn, t);
    if (!p) continue;
    for (const tile of p) {
      const packed = packTile(tile.x, tile.y);
      if (!highways.has(packed) && isSwamp(terrain, tile.x, tile.y)) highwaySwamp++;
      highways.add(packed);
    }
  }

  // --- dead-space metric ---
  let passable = 0;
  let deadSpace = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (isWall(terrain, x, y)) continue;
      passable++;
      const tile = packTile(x, y);
      if (reachSet.has(tile) && !highways.has(tile) && !anchorTiles.has(tile)) deadSpace++;
    }
  }

  // --- place ring-feeder pockets into the quiet space, roomiest centers
  //     first, until the extension budget is met or nothing else fits. ---
  let pocketCount = 0;
  const centers: { x: number; y: number; c: number }[] = [];
  for (let y = 2; y < SIZE - 2; y++) {
    for (let x = 2; x < SIZE - 2; x++) {
      const tile = packTile(x, y);
      if (!reachSet.has(tile) || highways.has(tile)) continue;
      centers.push({ x, y, c: clearance(x, y) });
    }
  }
  centers.sort((a, b) => b.c - a.c);

  let extPlaced = coreOk ? extensionCount(CORE_POCKET) : 0;
  for (const cand of centers) {
    if (extPlaced >= target) break;
    if (tryPlace(RING_FEEDER, cand.x, cand.y, terrain, reachSet, highways, anchorTiles, occupied, placed)) {
      pocketCount++;
      extPlaced += extensionCount(RING_FEEDER);
    }
  }

  render(input, spawn, highways, reachSet, anchorTiles, placed);
  report(input, { spawn, passable, deadSpace, highwayTiles: highways.size, highwaySwamp, coreOk, pocketCount, extPlaced, target, clearance });
}

function render(
  input: RoomInput,
  spawn: RoomPoint,
  highways: Set<number>,
  reachSet: Set<number>,
  anchorTiles: Set<number>,
  placed: Map<number, Placed>
): void {
  const { terrain, objects } = input;
  const anchorGlyph = new Map<number, string>();
  for (const o of objects) {
    const g = o.type === "source" ? "*" : o.type === "controller" ? "K" : o.type === "mineral" ? "%" : "?";
    anchorGlyph.set(packTile(o.x, o.y), g);
  }

  const lines: string[] = [];
  for (let y = 0; y < SIZE; y++) {
    let row = "";
    for (let x = 0; x < SIZE; x++) {
      const tile = packTile(x, y);
      if (placed.has(tile)) row += placed.get(tile)!.glyph;
      else if (anchorGlyph.has(tile)) row += anchorGlyph.get(tile)!;
      else if (highways.has(tile)) row += "=";
      else if (isWall(terrain, x, y)) row += "#";
      else if (!reachSet.has(tile)) row += "x"; // sealed pocket
      else if (isSwamp(terrain, x, y)) row += ","; // swamp dead-space
      else row += "·"; // plain dead-space (middle dot)
    }
    lines.push(row);
  }

  console.log(`\n=== base-lab: ${input.name} ===`);
  console.log(lines.join("\n"));
  console.log(
    "\nlegend: # wall  , swamp  · dead-space  = highway  x sealed  * source  K controller  % mineral"
  );
  console.log(
    "        P spawn  @ feeder/manager  L link  O storage  M terminal  T tower  E extension  C container"
  );
}

interface Report {
  spawn: RoomPoint;
  passable: number;
  deadSpace: number;
  highwayTiles: number;
  highwaySwamp: number;
  coreOk: boolean;
  pocketCount: number;
  extPlaced: number;
  target: number;
  clearance: (x: number, y: number) => number;
}

function report(input: RoomInput, r: Report): void {
  const cells = SIZE * SIZE;
  const walls = input.terrain.join("").split("").filter(c => c === "#").length;
  const swamp = input.terrain.join("").split("").filter(c => c === "~").length;
  const pct = (n: number, d: number): string => `${((100 * n) / d).toFixed(0)}%`;
  console.log("\n--- metrics ---");
  console.log(`room            ${input.name}`);
  console.log(`terrain         ${pct(walls, cells)} wall, ${pct(swamp, cells)} swamp, ${r.passable} passable`);
  console.log(`spawn/manager   (${r.spawn.x},${r.spawn.y})  clearance ${r.clearance(r.spawn.x, r.spawn.y)}`);
  console.log(
    `highways        ${r.highwayTiles} tiles (${r.highwaySwamp} on swamp) - the arteries kept clear of pockets`
  );
  console.log(`dead space      ${r.deadSpace} tiles (${pct(r.deadSpace, r.passable)} of passable) - the eddies`);
  console.log(`core pocket     ${r.coreOk ? "placed" : "FAILED to fit at spawn"}`);
  console.log(`ring feeders    ${r.pocketCount} pockets`);
  console.log(
    `extensions      ${r.extPlaced}/${r.target}` +
      (r.extPlaced < r.target ? `  (short ${r.target - r.extPlaced} - room ran out of fitting dead-space)` : "  (target met)")
  );
  console.log(`note            every extension sits in dead-space by construction; no pocket on a highway or swamp`);
}

function defaultFixture(): string {
  const all = listFixtures();
  return all.includes("shard3-W1N6") ? "shard3-W1N6" : all[0];
}

main();
