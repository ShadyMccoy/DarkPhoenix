/**
 * @fileoverview The construction placement LADDER — pure rung tables and
 * tile-election policy (spec 35 phase H, split out of ConstructionCorp).
 *
 * Charter: WHAT each RCL may build and WHERE to put it — the structure
 * limit/unlock tables (extensions, containers, storage, towers, links), the
 * road-investment pricing constants, the trunk-survey vocabulary, and the
 * this-free tile scorers (extension grid, controller-link tile). Placement
 * EXECUTION — createConstructionSite calls, cooldown clocks, sizing stamps,
 * dead-tile blacklists — stays in ConstructionCorp: this module decides,
 * the corp acts.
 *
 * Layer: Game-global-free (ratcheted by the purity suite): never references
 * Game/Memory — the tile scorers operate only on the Room they are handed.
 *
 * @module corps/constructionPlacement
 */

import { UNMAINTAINED_ROAD_LIFE } from "../economy/roadEconomics";
import { controllerInputSpot, coreDepot } from "./nodeEnergy";

/**
 * Extension limits by controller level (RCL 1-8)
 */
export const EXTENSION_LIMITS: { [rcl: number]: number } = {
  1: 0,
  2: 5,
  3: 10,
  4: 20,
  5: 30,
  6: 40,
  7: 50,
  8: 60
};

/**
 * How often to attempt placing new construction sites (ticks)
 */
export const PLACEMENT_COOLDOWN = 10;

/** Max containers per room (game limit is 5 at every RCL). */
export const CONTAINER_LIMIT = 5;

/**
 * Don't invest in containers (5000 build cost each) before the extension set
 * exists. At RCL 3+ they come first (static mining lifts everything). At RCL 2
 * the owner build order applies: be greedy to RCL2, then EXTENSIONS (3000,
 * compounding capacity), THEN containers - so static-mining efficiency feeds
 * the RCL3 push - and containers only unlock once the extension set is BUILT.
 *
 * A/B'd 2026-07-10 and kept as-is: a broad RCL2 container flip collapsed the
 * maze world's consumption, and even a depot-only early gate just displaced
 * the extension rung (T0 policy cell). The refill SLA is instead served by
 * the universal tender (reloads from any stock) and the near-fuel gate.
 */
const CONTAINER_MIN_RCL = 3;

/** Container rungs open at RCL3+, or at RCL2 once the extension set is built. */
export function containersUnlocked(rcl: number, extensionsAtCap: boolean): boolean {
  return rcl >= CONTAINER_MIN_RCL || (rcl === 2 && extensionsAtCap);
}

/** Storage unlocks at RCL 4 (game rule). It replaces the container core depot. */
export const STORAGE_MIN_RCL = 4;

/** Towers unlock at RCL 3 (CONTROLLER_STRUCTURES) - spec 07's one-tower v1. */
export const TOWER_MIN_RCL = 3;

/** Links allowed per RCL (game rule). The network anchors on the storage. */
export const LINK_LIMITS: { [rcl: number]: number } = { 5: 2, 6: 3, 7: 4, 8: 6 };

/**
 * Don't spend a link on a source this close to the storage: the saved haul is
 * shorter than the link's build cost + 3% transfer fee are worth.
 */
export const LINK_MIN_SOURCE_RANGE = 8;

/**
 * Dropped energy (within range 1 of a source) that signals a source container is
 * worth its 5000 build cost: a pile this big means a miner is producing there
 * faster than haulers clear it, so a static container will buffer the energy (and
 * stop it decaying on the ground) instead. Tunable - lower builds containers more
 * eagerly, higher waits for clearer evidence of sustained over-production.
 */
export const SOURCE_CONTAINER_PILE_THRESHOLD = 200;

/**
 * Energy value assumed for a freed spawn build-part when judging a road route
 * (see primitives.energyPerSpawnPart: ~537 for a home source, ~153 for a d=75
 * remote, ~0 when the spawn is slack). A conservative mid-range constant until
 * the corp can read the planner's actual marginal un-staffed source.
 */
export const ROAD_SPAWN_PART_VALUE = 100;
// The sum-of-projects crew cap (owner 2026-07-19) lives in
// primitives.projectAbsorbRate - shared verbatim with the PLAN's
// construction-sink capacity so plan and crew can never disagree.

/**
 * Horizon a road route must repay its build cost within: the wall-clock life
 * of an unmaintained road (50k ticks). A home room lives far longer, but a
 * route that cannot repay before its own pavement would have fully decayed is
 * not worth the maintenance commitment.
 */
export const ROAD_PAYBACK_HORIZON = UNMAINTAINED_ROAD_LIFE;

/**
 * Ticks between POTHOLE RE-SURVEYS of a route already stamped `paved` (see
 * ConstructionCorp.resurveyPavedRoutes). The paved receipt used to be an
 * absorbing state - once stamped, every read site (`routeSettled`, the trunk
 * completion sweep, the placement loops) skipped the route forever, so a tile
 * whose road DECAYED TO DEATH or was destroyed by an invader was never
 * re-placed: the route stayed "paved" over a hole for the rest of the colony's
 * life. Remote trunks feel it first - their pass-through rooms host no corp, so
 * nothing repairs those tiles and they are the ones that actually die.
 *
 * The cadence is set against how fast a road can plausibly vanish, not against
 * placement cost: an untrafficked road lives UNMAINTAINED_ROAD_LIFE (50k
 * ticks) and a trunk under a 2:1 fleet at 10 e/t about 31k, so a hole opens on
 * a ten-thousand-tick scale while the sweep itself is a lookForAt per tile.
 * 1500 spends a negligible slice of that budget and still re-places within a
 * few hundred ticks of the loss.
 */
export const ROAD_RESURVEY_INTERVAL = 1500;

/** One placement pass over a trunk's tiles: what stands, what was added,
 * which rooms could not be read. */
export interface TrunkSurvey {
  placed: number;
  built: number;
  total: number;
  blind: string[];
  /** The unbuilt VISIBLE tiles, each with its pass state - `room:x,y:site`
   * (construction site standing), `:placed` (site created this pass),
   * `:paused` (governor), or `:err<rc>` (createConstructionSite failed -
   * the silent-forever state; prod t72482860: the gate read
   * trunk-building-36/38 for ~4400t across 5 captures and WHICH 2 tiles
   * never built - or why - was invisible). Capped at 4 entries. */
  missing: string[];
}

/**
 * The trunk gate stamp from a pass survey - each zero-placement state gets
 * its own name (owner 2026-07-20: a single "waiting-vision" stamp conflated
 * "tiles in a blind room" with "fully placed, crews building" and misread a
 * healthy build as stalled for a whole day).
 */
export function trunkGateFromSurvey(s: TrunkSurvey): string {
  if (s.placed > 0) return `trunk-placing-${s.placed}`;
  if (s.blind.length > 0) return `trunk-blind-${s.blind.join("+")}`;
  return `trunk-building-${s.built}/${s.total}`;
}

/**
 * Best tile for the CONTROLLER LINK: a walkable, structure-and-site-free
 * range-2 tile maximizing the same park ring the input election scores
 * (walkable neighbours within upgrade range, controller tile excluded).
 * The link is unwalkable, so it must not steal the container's tile - any
 * other full-ring tile serves (open terrain has several).
 */
export function bestControllerLinkTile(room: Room, ctrl: StructureController): { x: number; y: number } | null {
  const terrain = room.getTerrain();
  const cx = ctrl.pos.x;
  const cy = ctrl.pos.y;
  const walkable = (x: number, y: number): boolean =>
    x >= 1 && x <= 48 && y >= 1 && y <= 48 && terrain.get(x, y) !== TERRAIN_MASK_WALL;
  const inRange = (x: number, y: number): boolean => Math.max(Math.abs(x - cx), Math.abs(y - cy)) <= 3;
  const occupied = (x: number, y: number): boolean =>
    room.lookForAt(LOOK_STRUCTURES, x, y).length > 0 || room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length > 0;
  let best: { x: number; y: number; score: number } | null = null;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      const x = cx + dx;
      const y = cy + dy;
      if ((dx === 0 && dy === 0) || !walkable(x, y) || occupied(x, y)) continue;
      let score = 0;
      for (let ex = -1; ex <= 1; ex++) {
        for (let ey = -1; ey <= 1; ey++) {
          if (ex === 0 && ey === 0) continue;
          const nx = x + ex;
          const ny = y + ey;
          if (nx === cx && ny === cy) continue;
          if (walkable(nx, ny) && inRange(nx, ny)) score++;
        }
      }
      if (!best || score > best.score || (score === best.score && (x < best.x || (x === best.x && y < best.y)))) {
        best = { x, y, score };
      }
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

/**
 * Find a position for extension using a grid pattern near sources.
 * Uses checkerboard pattern (every other tile) for walkability.
 */
export function findGridPosition(room: Room, exclude?: Set<string>): { x: number; y: number } | null {
  const terrain = room.getTerrain();
  const candidates: { x: number; y: number; score: number }[] = [];

  // Build set of positions to avoid (occupied or reserved)
  const avoidPositions = new Set<string>(exclude ?? []);

  // Avoid spawn and adjacent tiles
  const spawns = room.find(FIND_MY_SPAWNS);
  for (const s of spawns) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        avoidPositions.add(`${s.pos.x + dx},${s.pos.y + dy}`);
      }
    }
  }

  // Avoid source mining positions (1 tile radius for miners)
  const sources = room.find(FIND_SOURCES);
  for (const source of sources) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        avoidPositions.add(`${source.pos.x + dx},${source.pos.y + dy}`);
      }
    }
  }

  // Avoid controller upgrade positions (2 tile radius)
  if (room.controller) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        avoidPositions.add(`${room.controller.pos.x + dx},${room.controller.pos.y + dy}`);
      }
    }
  }

  // Avoid existing structures and construction sites
  const structures = room.find(FIND_STRUCTURES);
  const sites = room.find(FIND_CONSTRUCTION_SITES);
  for (const s of structures) {
    avoidPositions.add(`${s.pos.x},${s.pos.y}`);
  }
  for (const s of sites) {
    avoidPositions.add(`${s.pos.x},${s.pos.y}`);
  }

  // ENERGY HUBS stay clear (owner 2026-07-10: extensions built around a
  // drop spot boxed the haulers in on each other): the core depot and the
  // controller input are high-traffic exchange tiles - keep a 1-tile ring
  // of walking room around each.
  const hubRing = (pos: { x: number; y: number } | undefined): void => {
    if (!pos) return;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        avoidPositions.add(`${pos.x + dx},${pos.y + dy}`);
      }
    }
  };
  const depot = coreDepot(room);
  hubRing(depot ? { x: depot.pos.x, y: depot.pos.y } : undefined);
  if (room.controller) {
    const input = controllerInputSpot(room.controller);
    hubRing(input ? { x: input.pos.x, y: input.pos.y } : undefined);
  }

  // CLUSTER placement (owner directive 2026-07-09: "proximity to OTHER
  // extensions and spawns should be a big factor - all in one area so we
  // can refill them efficiently"). The refill chain is haulers -> core
  // depot (beside the spawn) -> tender -> extensions, so the refill cost
  // is the tender's depot<->extension round trip: spawn proximity and
  // cluster tightness are the whole price, and SOURCE distance is
  // irrelevant (haulers deliver to the depot wherever extensions sit).
  // The old source-centered scorer scattered extensions into per-source
  // patches the tender had to tour.
  const spawnPos = spawns[0]?.pos;
  if (!spawnPos) return null;
  const clusterPoints: Array<{ x: number; y: number }> = [];
  for (const s of structures) {
    if (s.structureType === STRUCTURE_EXTENSION) clusterPoints.push({ x: s.pos.x, y: s.pos.y });
  }
  for (const s of sites) {
    if (s.structureType === STRUCTURE_EXTENSION) clusterPoints.push({ x: s.pos.x, y: s.pos.y });
  }

  // Checkerboard tiles within tender range of the spawn.
  for (let dx = -8; dx <= 8; dx++) {
    for (let dy = -8; dy <= 8; dy++) {
      const distToSpawn = Math.max(Math.abs(dx), Math.abs(dy));
      if (distToSpawn < 2) continue; // keep the spawn ring clear

      const x = spawnPos.x + dx;
      const y = spawnPos.y + dy;
      if (x < 2 || x > 47 || y < 2 || y > 47) continue;
      if ((x + y) % 2 !== 0) continue; // checkerboard for walkability
      const terrainType = terrain.get(x, y);
      if (terrainType === TERRAIN_MASK_WALL) continue;
      if (avoidPositions.has(`${x},${y}`)) continue;

      // At least 3 walkable neighbors (path connectivity)
      let walkableNeighbors = 0;
      for (let nx = -1; nx <= 1; nx++) {
        for (let ny = -1; ny <= 1; ny++) {
          if (nx === 0 && ny === 0) continue;
          const tx = x + nx;
          const ty = y + ny;
          if (tx < 0 || tx > 49 || ty < 0 || ty > 49) continue;
          if (terrain.get(tx, ty) !== TERRAIN_MASK_WALL) {
            walkableNeighbors++;
          }
        }
      }
      if (walkableNeighbors < 3) continue;

      // Tight cluster: near the spawn AND near the extensions we already
      // have. Cohesion weighs as much as spawn proximity so the mass grows
      // outward ring by ring instead of sprinkling the whole radius; a
      // small swamp penalty breaks ties toward plains.
      let cohesion = 0;
      if (clusterPoints.length > 0) {
        for (const p of clusterPoints) {
          cohesion += Math.max(Math.abs(p.x - x), Math.abs(p.y - y));
        }
        cohesion /= clusterPoints.length;
      }
      const swampPenalty = terrainType === TERRAIN_MASK_SWAMP ? 2 : 0;
      const score = 100 - distToSpawn * 3 - cohesion * 3 - swampPenalty;
      candidates.push({ x, y, score });
    }
  }

  if (candidates.length === 0) return null;

  // Deterministic best: score, then y, then x.
  candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  return candidates[0];
}
