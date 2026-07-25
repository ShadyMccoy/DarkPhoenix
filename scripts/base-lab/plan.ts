/**
 * base-lab/plan - the base planner as an importable function.
 *
 * planBase() computes the whole geometry (core, highways = hauler routes,
 * alveolar extension field) and returns it, so the CLI (index.ts) can render it
 * AND the sim bridge (sim-bridge.ts) can measure its refill. Kept free of any
 * top-level execution so importing it is side-effect-free.
 */
import { readFileSync, readdirSync } from "fs";
import * as path from "path";
import { createMultiRoomDistanceTransform } from "../../src/spatial/algorithms";
import { pickSpawnSpot, type RoomPoint } from "../../src/spatial/spawnPlacement";
import { RoomBuilder } from "../../test/integration/scenario/RoomBuilder";
import { SIZE, packTile, isWall, isSwamp, route, reachable, exitTiles, distanceFromSet, type Pt } from "./geometry";
import { CORE_POCKET, LAB_CLUSTER, RING_FEEDER, GLYPH, extensionCount, type Stamp } from "./stamps";

export const FIXTURE_DIR = path.resolve("test", "fixtures", "real-rooms");
export const RCL8_EXTENSIONS = 60;

export interface Obj {
  type: string;
  x: number;
  y: number;
}
export interface RoomInput {
  name: string;
  terrain: string[];
  objects: Obj[];
}
export interface Placed {
  glyph: string;
  stamp: string;
}
export interface PlanOpts {
  target: number;
  fillMode: string; // "alveoli" | "pockets"
  deadBias: number;
  /** RCL8 building loadout (placed in dead-space, competing with extensions).
   * Defaults: 3 spawns, 6 towers, 10 labs. Set to 0 to omit. */
  spawns?: number;
  towers?: number;
  labs?: number;
  /** Commute cap: the extension field may reach commuteSlack x the tightest
   * packing radius from the core. Bounds the dead-bias so it can't sprawl into
   * open-room wilderness. Default 1.5. */
  commuteSlack?: number;
}

export interface BasePlan {
  input: RoomInput;
  opts: PlanOpts;
  spawn: Pt; // core / storage anchor
  placed: Map<number, Placed>;
  highways: Set<number>;
  reachSet: Set<number>;
  anchorTiles: Set<number>;
  distToHighway: Map<number, number>;
  clearance: (x: number, y: number) => number;
  // extracted geometry (for the sim bridge)
  extensions: Pt[];
  spawns: Pt[];
  /** serpentine spine (ordered, contiguous incl. bridges); empty for other modes */
  lane: Pt[];
  splits: number;
  bridgeLen: number;
  // metrics
  passable: number;
  deadSpace: number;
  highwaySwamp: number;
  coreOk: boolean;
  pocketCount: number;
  extPlaced: number;
  meanExtDist: number;
  meanExtDead: number;
  extOnAccess: number;
  spawnsPlaced: number;
  towersPlaced: number;
  labsPlaced: number;
}

export function listFixtures(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => f.replace(/\.json$/, ""));
}

export function loadFixture(name: string): RoomInput {
  const file = path.resolve(FIXTURE_DIR, `${name}.json`);
  const fx = JSON.parse(readFileSync(file).toString());
  return { name: fx.room ?? name, terrain: fx.terrain, objects: fx.objects ?? [] };
}

export function synthetic(): RoomInput {
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

export function defaultFixture(): string {
  const all = listFixtures();
  return all.includes("shard3-W1N6") ? "shard3-W1N6" : all[0];
}

/**
 * Core placement scored by the EXTENSION-TENDER cost, not just anchor
 * proximity. `pickSpawnSpot` (centroid-nearest open tile) lands the core in a
 * corner when the anchors pull that way (W7N3), which forces a stretched,
 * high-bridge extension string. Here each candidate open-3x3 tile is scored by:
 *   - tenderReach: BFS radius over walkable tiles at which enough checkerboard
 *     extension slots are within reach to hold `target` - the compactness the
 *     tender actually pays (lower = tighter field = shorter refill), and
 *   - anchorDist: mean distance to sources/controller (hauler-route length).
 * Minimising tenderReach + w*anchorDist keeps the core out of corners while
 * still near the anchors.
 */
function pickCore(terrain: string[], anchors: RoomPoint[], target: number, anchorWeight = 0.5): Pt | null {
  const plain = (x: number, y: number): boolean => x >= 0 && x < SIZE && y >= 0 && y < SIZE && terrain[y][x] === ".";
  const open3 = (x: number, y: number): boolean => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (!plain(x + dx, y + dy)) return false;
    return true;
  };
  const fittable = (x: number, y: number): boolean => (x + y) % 2 === 0 && !isWall(terrain, x, y) && !isSwamp(terrain, x, y);

  const tenderReach = (sx: number, sy: number): number => {
    const seen = new Set<number>([packTile(sx, sy)]);
    const q: Array<{ x: number; y: number; d: number }> = [{ x: sx, y: sy, d: 0 }];
    let cnt = 0;
    for (let i = 0; i < q.length; i++) {
      const p = q[i];
      if (fittable(p.x, p.y)) cnt++;
      if (cnt >= target) return p.d;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const nx = p.x + dx;
          const ny = p.y + dy;
          if (isWall(terrain, nx, ny)) continue;
          const t = packTile(nx, ny);
          if (seen.has(t)) continue;
          seen.add(t);
          q.push({ x: nx, y: ny, d: p.d + 1 });
        }
      }
    }
    return SIZE * 2; // couldn't fit the field from here
  };

  let best: Pt | null = null;
  let bestScore = Infinity;
  for (let y = 3; y < SIZE - 3; y++) {
    for (let x = 3; x < SIZE - 3; x++) {
      if (!open3(x, y)) continue;
      if (anchors.some(a => Math.max(Math.abs(a.x - x), Math.abs(a.y - y)) < 2)) continue;
      const anchorDist = anchors.length
        ? anchors.reduce((s, a) => s + Math.abs(a.x - x) + Math.abs(a.y - y), 0) / anchors.length
        : 0;
      const score = tenderReach(x, y) + anchorWeight * anchorDist;
      if (score < bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  return best;
}

function anchorsOf(input: RoomInput): { sources: Obj[]; controller: Obj | null; mineral: Obj | null } {
  return {
    sources: input.objects.filter(o => o.type === "source"),
    controller: input.objects.find(o => o.type === "controller") ?? null,
    mineral: input.objects.find(o => o.type === "mineral") ?? null
  };
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
  deadBias: number,
  commuteSlack: number
): number {
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

  const raw: { x: number; y: number; dCore: number; outskirts: number }[] = [];
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      if ((x + y) % 2 !== 0) continue; // even tiles hold extensions; odd are ducts
      const tile = packTile(x, y);
      if (isWall(terrain, x, y) || isSwamp(terrain, x, y)) continue;
      if (!reachSet.has(tile) || highways.has(tile) || anchorTiles.has(tile) || occupied.has(tile)) continue;
      const dCore = dist.get(tile);
      if (dCore === undefined) continue;
      raw.push({ x, y, dCore, outskirts: distToHighway.get(tile) ?? SIZE });
    }
  }

  // COMMUTE CAP: the bias must not march extensions into the wilderness on open
  // rooms (measured: unbounded bias 2 sprawls to 29 tiles from core -> never
  // refills). Cap the field at commuteSlack x the tightest packing radius (the
  // dCore of the target-th nearest tile), so the bias only picks the deadest
  // tiles WITHIN the compact disk. On congested rooms the walls already cap it,
  // so this is a no-op there.
  const need = target - startCount;
  const cores = raw.map(r => r.dCore).sort((a, b) => a - b);
  const rMin = need > 0 && cores.length > 0 ? cores[Math.min(cores.length - 1, need - 1)] : Infinity;
  const cap = rMin * commuteSlack;

  const cands = raw
    .filter(r => r.dCore <= cap)
    .map(r => ({ x: r.x, y: r.y, cost: r.dCore - deadBias * r.outskirts }));
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
      return reachSet.has(nt) && !occupied.has(nt);
    });

  let count = startCount;
  for (const cd of cands) {
    if (count >= target) break;
    if (!hasDuct(cd.x, cd.y)) continue;
    const tile = packTile(cd.x, cd.y);
    occupied.add(tile);
    placed.set(tile, { glyph: "E", stamp: "alveoli" });
    count++;
  }
  return count;
}

/**
 * Serpentine fill: a diagonal-stripe string threaded through the dead-space.
 * The tender walks the SPINE (every 3rd diagonal is a lane; extensions flank it
 * on the two stripes between), so its world is 1D - in toward the tail, out to
 * the mouth (core) to reload. Real terrain breaks a pure diagonal, so:
 *   - WRAP: at a boundary the walk turns (any adjacent unused lane tile),
 *     staying contiguous.
 *   - SPLIT: when no adjacent lane tile remains, BFS-BRIDGE to the nearest
 *     unused lane run and append the connector tiles - so the whole thing stays
 *     ONE ordered contiguous lane (a split is just a low-density traverse
 *     stretch, not a separate loop). Bridges >2 tiles are counted as splits.
 * Returns the placed count, the ordered lane (spine + bridges), and split stats.
 */
function fillSerpentine(
  terrain: string[],
  reachSet: Set<number>,
  highways: Set<number>,
  anchorTiles: Set<number>,
  occupied: Set<number>,
  placed: Map<number, Placed>,
  core: Pt,
  target: number,
  startCount: number
): { count: number; lane: Pt[]; splits: number; bridgeLen: number } {
  const inRegion = (x: number, y: number): boolean => {
    if (x < 1 || y < 1 || x >= SIZE - 1 || y >= SIZE - 1) return false;
    if (isWall(terrain, x, y) || isSwamp(terrain, x, y)) return false;
    const t = packTile(x, y);
    return reachSet.has(t) && !highways.has(t) && !anchorTiles.has(t);
  };
  const r0 = (((core.x - core.y) % 3) + 3) % 3;
  const isLane = (x: number, y: number): boolean => (((x - y) % 3) + 3) % 3 === r0;

  const laneSet = new Set<number>();
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      if (inRegion(x, y) && !occupied.has(packTile(x, y)) && isLane(x, y)) laneSet.add(packTile(x, y));
    }
  }
  if (laneSet.size === 0) return { count: startCount, lane: [], splits: 0, bridgeLen: 0 };

  const cheb = (a: number, b: number): number =>
    Math.max(Math.abs((a % SIZE) - (b % SIZE)), Math.abs(Math.floor(a / SIZE) - Math.floor(b / SIZE)));
  const coreT = packTile(core.x, core.y);

  // A bridge may TRAVERSE any walkable tile - including highways and swamp (the
  // tender can cross an artery, it just can't build on it). Only walls, out-of-
  // bounds, unreachable, and occupied structures block. (Excluding highways
  // here was the bug that isolated the core pocket on highway-heavy rooms.)
  const bridgeWalkable = (x: number, y: number): boolean =>
    x >= 1 && y >= 1 && x < SIZE - 1 && y < SIZE - 1 && !isWall(terrain, x, y) && reachSet.has(packTile(x, y)) && !occupied.has(packTile(x, y));

  // BFS bridge over walkable tiles, path after `from` up to `to`.
  const bridge = (from: number, to: number): number[] | null => {
    const prev = new Map<number, number>([[from, -1]]);
    const q = [from];
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      if (c === to) break;
      const cx = c % SIZE;
      const cy = Math.floor(c / SIZE);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!bridgeWalkable(nx, ny)) continue;
          const nt = packTile(nx, ny);
          if (prev.has(nt)) continue;
          prev.set(nt, c);
          q.push(nt);
        }
      }
    }
    if (!prev.has(to)) return null;
    const path: number[] = [];
    for (let t = to; t !== -1 && t !== from; t = prev.get(t)!) path.push(t);
    return path.reverse();
  };

  // Keep only the lane tiles in the LARGEST bridge-connected component (the main
  // dead-space); drop tiles the core-pocket/buildings box into tiny pockets.
  // Component of walkable tiles (via bridgeWalkable), independent of the core's
  // neighbours (which the pocket occupies). The sim reaches the main region from
  // storage through the pocket's non-sim-blocked structures.
  const comp = new Map<number, number>();
  const compLaneCount = new Map<number, number>();
  let nextComp = 0;
  for (const laneT of laneSet) {
    if (comp.has(laneT)) continue;
    const id = nextComp++;
    const q = [laneT];
    comp.set(laneT, id);
    let laneCount = 0;
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      if (laneSet.has(c)) laneCount += 1;
      const cx = c % SIZE;
      const cy = Math.floor(c / SIZE);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          if (!bridgeWalkable(cx + dx, cy + dy)) continue;
          const nt = packTile(cx + dx, cy + dy);
          if (comp.has(nt)) continue;
          comp.set(nt, id);
          q.push(nt);
        }
      }
    }
    compLaneCount.set(id, laneCount);
  }
  let bestId = -1;
  let bestCount = -1;
  for (const [id, c] of compLaneCount) if (c > bestCount) {
    bestCount = c;
    bestId = id;
  }
  for (const t of [...laneSet]) if (comp.get(t) !== bestId) laneSet.delete(t);
  if (laneSet.size === 0) return { count: startCount, lane: [], splits: 0, bridgeLen: 0 };

  // Contiguous walk: prefer continuing straight, then any adjacent lane tile
  // (WRAP), then bridge to the nearest remaining run (SPLIT).
  let start = -1;
  let sd = Infinity;
  for (const t of laneSet) {
    const d = cheb(t, coreT);
    if (d < sd) {
      sd = d;
      start = t;
    }
  }
  const remaining = new Set(laneSet);
  const walk: number[] = [start];
  remaining.delete(start);
  let cur = start;
  let lastDx = 0;
  let lastDy = 0;
  let splits = 0;
  let bridgeLen = 0;

  const adjLane = (): number | null => {
    const cx = cur % SIZE;
    const cy = Math.floor(cur / SIZE);
    const dirs: Array<[number, number]> = [];
    if (lastDx || lastDy) dirs.push([lastDx, lastDy]); // continue straight first
    for (const d of [
      [1, 1],
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ] as Array<[number, number]>) {
      dirs.push(d);
    }
    for (const [dx, dy] of dirs) {
      const nt = packTile(cx + dx, cy + dy);
      if (remaining.has(nt)) return nt;
    }
    return null;
  };

  while (remaining.size > 0) {
    const next = adjLane();
    if (next !== null) {
      lastDx = (next % SIZE) - (cur % SIZE);
      lastDy = Math.floor(next / SIZE) - Math.floor(cur / SIZE);
      walk.push(next);
      remaining.delete(next);
      cur = next;
      continue;
    }
    let tgt = -1;
    let bd = Infinity;
    for (const t of remaining) {
      const d = cheb(cur, t);
      if (d < bd) {
        bd = d;
        tgt = t;
      }
    }
    const path = bridge(cur, tgt);
    if (!path || path.length === 0) {
      remaining.delete(tgt);
      continue;
    }
    for (const t of path) {
      walk.push(t);
      remaining.delete(t);
    }
    bridgeLen += path.length;
    // A short hop (a stripe-wrap turn) is not a split; only a genuine long jump
    // across a gap counts.
    if (path.length > 4) splits += 1;
    cur = tgt;
    lastDx = 0;
    lastDy = 0;
  }

  // Place extensions flanking the walk, in walk order (near mouth first), to
  // target. Trim the lane to the prefix that actually carries extensions.
  const walkedSet = new Set(walk);
  let count = startCount;
  let lastUseful = 0;
  const laneOut: Pt[] = [];
  for (let i = 0; i < walk.length; i++) {
    const t = walk[i];
    const x = t % SIZE;
    const y = Math.floor(t / SIZE);
    laneOut.push({ x, y });
    if (count >= target) continue;
    for (let dx = -1; dx <= 1 && count < target; dx++) {
      for (let dy = -1; dy <= 1 && count < target; dy++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!inRegion(nx, ny)) continue;
        const nt = packTile(nx, ny);
        if (walkedSet.has(nt) || occupied.has(nt)) continue;
        occupied.add(nt);
        placed.set(nt, { glyph: "E", stamp: "serpentine" });
        count += 1;
        lastUseful = i;
      }
    }
  }
  return { count, lane: laneOut.slice(0, lastUseful + 1), splits, bridgeLen };
}

export function planBase(input: RoomInput, opts: PlanOpts): BasePlan {
  const { terrain } = input;
  const { sources, controller, mineral } = anchorsOf(input);

  const nearList: RoomPoint[] = [...sources, ...(controller ? [controller] : [])];
  // Tender-aware core placement (avoids corners that stretch the field);
  // falls back to the centroid heuristic, then room centre.
  const spawn: Pt = pickCore(terrain, nearList, opts.target) ?? pickSpawnSpot(terrain, nearList) ?? { x: 25, y: 25 };

  const cb = (_r: string, x: number, y: number): number => (isWall(terrain, x, y) ? 1 : 0);
  const distances = createMultiRoomDistanceTransform([input.name], cb, 1, 1, new Set([input.name]));
  const clearance = (x: number, y: number): number => distances.get(`${input.name}:${x},${y}`) ?? 0;

  const reachSet = reachable(terrain, spawn);
  const anchorTiles = new Set<number>(
    [...sources, ...(controller ? [controller] : []), ...(mineral ? [mineral] : [])].map(o => packTile(o.x, o.y))
  );

  const occupied = new Set<number>();
  const placed = new Map<number, Placed>();

  // Core pocket first (hub the arteries radiate from - exempt from avoid-highway).
  const coreOk = tryPlace(CORE_POCKET, spawn.x, spawn.y, terrain, reachSet, new Set(), anchorTiles, occupied, placed);

  // Highways = hauler routes: core <-> sources, controller, exits.
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

  const distToHighway = distanceFromSet(terrain, highways);

  // --- building loadout: extra spawns + towers (singles) and a lab cluster,
  //     placed nearest-core in dead-space so the extension field flows around
  //     them (they compete with extensions for the quiet space). ---
  const spawnsWanted = opts.spawns ?? 3;
  const towersWanted = opts.towers ?? 6;
  const labsWanted = opts.labs ?? 10;
  const glyphCount = (g: string): number => [...placed.values()].filter(p => p.glyph === g).length;

  const placeNearCore = (glyph: string, count: number): number => {
    if (count <= 0) return 0;
    const cands: { x: number; y: number; d: number }[] = [];
    for (let y = 1; y < SIZE - 1; y++) {
      for (let x = 1; x < SIZE - 1; x++) {
        if ((x + y) % 2 !== 0) continue;
        const tile = packTile(x, y);
        if (isWall(terrain, x, y) || isSwamp(terrain, x, y)) continue;
        if (!reachSet.has(tile) || highways.has(tile) || anchorTiles.has(tile) || occupied.has(tile)) continue;
        cands.push({ x, y, d: Math.max(Math.abs(x - spawn.x), Math.abs(y - spawn.y)) });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    let n = 0;
    for (const c of cands) {
      if (n >= count) break;
      const duct = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1]
      ].some(([dx, dy]) => {
        const nx = c.x + dx;
        const ny = c.y + dy;
        if (isWall(terrain, nx, ny)) return false;
        const nt = packTile(nx, ny);
        return reachSet.has(nt) && !occupied.has(nt);
      });
      if (!duct) continue;
      const tile = packTile(c.x, c.y);
      occupied.add(tile);
      placed.set(tile, { glyph, stamp: "building" });
      n++;
    }
    return n;
  };

  const placeLabs = (count: number): number => {
    if (count <= 0) return 0;
    const centers: { x: number; y: number; d: number }[] = [];
    for (let y = 2; y < SIZE - 2; y++) {
      for (let x = 2; x < SIZE - 2; x++) {
        const tile = packTile(x, y);
        if (!reachSet.has(tile) || highways.has(tile)) continue;
        centers.push({ x, y, d: Math.max(Math.abs(x - spawn.x), Math.abs(y - spawn.y)) });
      }
    }
    centers.sort((a, b) => a.d - b.d);
    for (const c of centers) {
      if (tryPlace(LAB_CLUSTER, c.x, c.y, terrain, reachSet, highways, anchorTiles, occupied, placed)) {
        return LAB_CLUSTER.cells.length;
      }
    }
    return 0;
  };

  const spawnsPlaced = glyphCount("P") + placeNearCore("P", spawnsWanted - glyphCount("P"));
  const towersPlaced = glyphCount("T") + placeNearCore("T", towersWanted - glyphCount("T"));
  const labsPlaced = placeLabs(labsWanted);

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

  let pocketCount = 0;
  let extPlaced = coreOk ? extensionCount(CORE_POCKET) : 0;
  let lane: Pt[] = [];
  let splits = 0;
  let bridgeLen = 0;
  if (opts.fillMode === "serpentine") {
    const s = fillSerpentine(terrain, reachSet, highways, anchorTiles, occupied, placed, spawn, opts.target, extPlaced);
    extPlaced = s.count;
    lane = s.lane;
    splits = s.splits;
    bridgeLen = s.bridgeLen;
  } else if (opts.fillMode === "pockets") {
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
      if (extPlaced >= opts.target) break;
      if (tryPlace(RING_FEEDER, cand.x, cand.y, terrain, reachSet, highways, anchorTiles, occupied, placed)) {
        pocketCount++;
        extPlaced += extensionCount(RING_FEEDER);
      }
    }
  } else {
    extPlaced = fillAlveoli(
      terrain,
      reachSet,
      highways,
      anchorTiles,
      occupied,
      placed,
      spawn,
      opts.target,
      extPlaced,
      distToHighway,
      opts.deadBias,
      opts.commuteSlack ?? 1.5
    );
  }

  // Extract geometry + metrics from the placed map.
  const extensions: Pt[] = [];
  const spawns: Pt[] = [];
  let extDistSum = 0;
  let extDeadSum = 0;
  let extOnAccess = 0;
  for (const [tile, pl] of placed) {
    const x = tile % SIZE;
    const y = (tile - x) / SIZE;
    if (pl.glyph === "P") spawns.push({ x, y });
    if (pl.glyph !== "E") continue;
    extensions.push({ x, y });
    extDistSum += Math.max(Math.abs(x - spawn.x), Math.abs(y - spawn.y));
    const dead = distToHighway.get(tile) ?? SIZE;
    extDeadSum += dead;
    if (dead <= 1) extOnAccess++;
  }
  const extN = extensions.length;

  return {
    input,
    opts,
    spawn,
    placed,
    highways,
    reachSet,
    anchorTiles,
    distToHighway,
    clearance,
    extensions,
    spawns,
    lane,
    splits,
    bridgeLen,
    passable,
    deadSpace,
    highwaySwamp,
    coreOk,
    pocketCount,
    extPlaced,
    meanExtDist: extN > 0 ? extDistSum / extN : 0,
    meanExtDead: extN > 0 ? extDeadSum / extN : 0,
    extOnAccess,
    spawnsPlaced,
    towersPlaced,
    labsPlaced
  };
}
