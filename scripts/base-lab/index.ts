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
import { SIZE, packTile, isWall, isSwamp, route, reachable, exitTiles, distanceFromSet, type Pt } from "./geometry";
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

/**
 * Alveolar fill: extensions flood the dead-space in a checkerboard (even tiles
 * hold extensions, odd tiles are the walkable ducts), grown OUTWARD from the
 * core by true walk-distance. The field stays clustered at the storage - short
 * trips win refill (sim finding #3) - and simply RUNS INTO the walls and flows
 * AROUND the highways as it spreads. The wall-hugging alveoli are the emergent
 * shape of a compact blob meeting the pleura, not a wall-seeking heuristic.
 */
function fillAlveoli(
  terrain: string[],
  reachSet: Set<number>,
  highways: Set<number>,
  anchorTiles: Set<number>,
  occupied: Set<number>,
  placed: Map<number, Placed>,
  core: Pt,
  target: number,
  startCount: number,
  distToHighway: Map<number, number>,
  deadBias: number
): number {
  // BFS walk-distance from the core over walkable tiles (walls block).
  const dist = new Map<number, number>();
  const start = packTile(core.x, core.y);
  dist.set(start, 0);
  const queue: Pt[] = [core];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    const d = dist.get(packTile(p.x, p.y))!;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nx = p.x + dx;
        const ny = p.y + dy;
        if (isWall(terrain, nx, ny)) continue;
        const nt = packTile(nx, ny);
        if (dist.has(nt)) continue;
        dist.set(nt, d + 1);
        queue.push({ x: nx, y: ny });
      }
    }
  }

  // Checkerboard extension candidates in dead-space (no swamp under extensions,
  // the fatigue rule). Cost = travel-distance-from-core MINUS deadBias * the
  // outskirts depth (distance from the nearest artery): the blob grows out from
  // the core (compact) but leans toward the dead-end suburbs as it spreads.
  const cands: { x: number; y: number; cost: number }[] = [];
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      if ((x + y) % 2 !== 0) continue; // even tiles hold extensions; odd are ducts
      const tile = packTile(x, y);
      if (isWall(terrain, x, y) || isSwamp(terrain, x, y)) continue;
      if (!reachSet.has(tile) || highways.has(tile) || anchorTiles.has(tile) || occupied.has(tile)) continue;
      const dCore = dist.get(tile);
      if (dCore === undefined) continue;
      const outskirts = distToHighway.get(tile) ?? SIZE; // unreachable-from-artery = deepest dead-end
      cands.push({ x, y, cost: dCore - deadBias * outskirts });
    }
  }
  cands.sort((a, b) => a.cost - b.cost);

  const hasDuct = (x: number, y: number): boolean =>
    [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ].some(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      if (isWall(terrain, nx, ny)) return false;
      const nt = packTile(nx, ny);
      return reachSet.has(nt) && !occupied.has(nt); // a walkable access duct (highway lanes count)
    });

  let count = startCount;
  for (const cd of cands) {
    if (count >= target) break;
    if (!hasDuct(cd.x, cd.y)) continue; // every extension keeps a walkable duct
    const tile = packTile(cd.x, cd.y);
    occupied.add(tile);
    placed.set(tile, { glyph: "E", stamp: "alveoli" });
    count++;
  }
  return count;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    console.log(listFixtures().join("\n"));
    return;
  }
  const valueFlags = new Set(["--target", "--fill", "--dead-bias"]);
  const flagVal = (name: string, dflt: string): string => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const target = Number(flagVal("--target", String(RCL8_EXTENSIONS)));
  const fillMode = flagVal("--fill", "alveoli"); // "alveoli" (wall-edge flood) | "pockets" (ring stamps)
  const deadBias = Number(flagVal("--dead-bias", "1")); // pull toward the dead-end suburbs (0 = compact only)
  const useSynthetic = args.includes("--synthetic");
  const positional = args.find((a, i) => !a.startsWith("--") && !(i > 0 && valueFlags.has(args[i - 1])));

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

  // --- highways: the hauler routes. core <-> each source, the controller, and
  //     the room exits (remote hauling / defense sorties). These arteries are
  //     terrain-shaped, not cardinal lanes - they are kept clear; extensions
  //     fill the walled-edge alveoli off them. ---
  const highways = new Set<number>();
  let highwaySwamp = 0;
  const routeTargets: Pt[] = [...sources, ...(controller ? [controller] : []), ...exitTiles(terrain, spawn)];
  for (const t of routeTargets) {
    const p = route(terrain, spawn, t);
    if (!p) continue;
    for (const tile of p) {
      const packed = packTile(tile.x, tile.y);
      if (!highways.has(packed) && isSwamp(terrain, tile.x, tile.y)) highwaySwamp++;
      highways.add(packed);
    }
  }

  // --- traffic-proximity field: distance from every tile to the nearest
  //     artery. The measurable "how dead is this tile" - extensions bias toward
  //     the high end (the dead-end outskirts). ---
  const distToHighway = distanceFromSet(terrain, highways);

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

  // --- fill extensions ---
  let pocketCount = 0;
  let extPlaced = coreOk ? extensionCount(CORE_POCKET) : 0;
  if (fillMode === "pockets") {
    // ring-feeder stamps into the roomiest centers first
    const centers: { x: number; y: number; c: number }[] = [];
    for (let y = 2; y < SIZE - 2; y++) {
      for (let x = 2; x < SIZE - 2; x++) {
        const tile = packTile(x, y);
        if (!reachSet.has(tile) || highways.has(tile)) continue;
        centers.push({ x, y, c: clearance(x, y) });
      }
    }
    centers.sort((a, b) => b.c - a.c);
    for (const cand of centers) {
      if (extPlaced >= target) break;
      if (tryPlace(RING_FEEDER, cand.x, cand.y, terrain, reachSet, highways, anchorTiles, occupied, placed)) {
        pocketCount++;
        extPlaced += extensionCount(RING_FEEDER);
      }
    }
  } else {
    // alveolar flood: grow the extension blob outward from the core into the
    // walled-edge dead-space, biased toward the dead-end outskirts.
    extPlaced = fillAlveoli(terrain, reachSet, highways, anchorTiles, occupied, placed, spawn, target, extPlaced, distToHighway, deadBias);
  }

  // Compactness gauge (mean ext travel-distance from core) and the dead-space
  // gauge (mean outskirts depth = distance from the nearest artery). The two
  // are the tradeoff the --dead-bias knob trades between.
  let extDistSum = 0;
  let extDeadSum = 0;
  let extOnAccess = 0; // adjacent to an artery (distToHighway <= 1)
  let extN = 0;
  for (const [tile, pl] of placed) {
    if (pl.glyph !== "E") continue;
    const x = tile % SIZE;
    const y = (tile - x) / SIZE;
    extDistSum += Math.max(Math.abs(x - spawn.x), Math.abs(y - spawn.y));
    const dead = distToHighway.get(tile) ?? SIZE;
    extDeadSum += dead;
    if (dead <= 1) extOnAccess++;
    extN++;
  }
  const meanExtDist = extN > 0 ? extDistSum / extN : 0;
  const meanExtDead = extN > 0 ? extDeadSum / extN : 0;

  render(input, spawn, highways, reachSet, anchorTiles, placed);
  report(input, {
    spawn,
    passable,
    deadSpace,
    highwayTiles: highways.size,
    highwaySwamp,
    coreOk,
    pocketCount,
    extPlaced,
    target,
    clearance,
    fillMode,
    meanExtDist,
    meanExtDead,
    extOnAccess,
    deadBias
  });
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
  fillMode: string;
  meanExtDist: number;
  meanExtDead: number;
  extOnAccess: number;
  deadBias: number;
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
    `highways        ${r.highwayTiles} tiles (${r.highwaySwamp} on swamp) - hauler routes to sources/controller/exits, kept clear`
  );
  console.log(`dead space      ${r.deadSpace} tiles (${pct(r.deadSpace, r.passable)} of passable) - the eddies`);
  console.log(`core pocket     ${r.coreOk ? "placed" : "FAILED to fit at spawn"}`);
  console.log(
    `fill mode       ${r.fillMode}` +
      (r.fillMode === "pockets" ? ` (${r.pocketCount} ring pockets)` : ` (wall-edge flood, grown from core, dead-bias ${r.deadBias})`)
  );
  console.log(
    `extensions      ${r.extPlaced}/${r.target}` +
      (r.extPlaced < r.target ? `  (short ${r.target - r.extPlaced} - ran out of fitting dead-space)` : "  (target met)")
  );
  console.log(`compactness     mean ext travel-dist from core ${r.meanExtDist.toFixed(1)} (lower = tighter blob = shorter refill)`);
  console.log(
    `outskirts       mean dead-end depth ${r.meanExtDead.toFixed(1)} tiles from nearest artery; ${r.extOnAccess} ext on the artery edge` +
      ` (higher depth = deeper in the dead-end suburbs)`
  );
  console.log(`note            extensions grow OUTWARD from the core into the dead-end suburbs, around the arteries`);
}

function defaultFixture(): string {
  const all = listFixtures();
  return all.includes("shard3-W1N6") ? "shard3-W1N6" : all[0];
}

main();
