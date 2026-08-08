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
import { ContainerCensus } from "../telemetry/containerCensus";
import { Position } from "../types/Position";
import { controllerInputSpot, coreDepot } from "./nodeEnergy";

/**
 * Extension limits by controller level (RCL 1-8)
 */
/**
 * Spawns permitted per RCL, mirroring the engine's CONTROLLER_STRUCTURES
 * (owner 2026-07-29: "lets take a look at placing the additional spawns as rcl
 * allows"). The colony's hardest physical ceiling is spawn throughput -
 * `spawnCount * SPAWN_PARTS_PER_TICK` - and until now STRUCTURE_SPAWN was
 * placed NOWHERE but ExpansionCampaign (a new colony's founding spawn), so an
 * owned room could never add its second while Spawn1 ran 0.87-0.97 utilization
 * with a 4-6 deep queue (measured t72663189-t72665987).
 */
export const SPAWN_LIMITS: { [rcl: number]: number } = {
  1: 1,
  2: 1,
  3: 1,
  4: 1,
  5: 1,
  6: 1,
  7: 2,
  8: 3
};

/**
 * Free adjacent tiles a spawn tile needs so NEWBORNS CAN STEP OUT. The one
 * predicate neither existing scorer has: findGridPosition packs extensions
 * densely (extensions do not care), and SpawningCorp aims emergence with
 * spawnCreep({directions}) - a spawn walled in by its own grid would strand
 * every creep it builds. Two keeps a lane open even while one tile is occupied
 * by the creep already emerging.
 */
export const SPAWN_EMERGENCE_MIN = 2;

/** How far down findGridPosition's ranking to look for a spawn tile that can
 *  also release newborns before giving up this cooldown. */
export const SPAWN_PLACEMENT_ATTEMPTS = 12;

/**
 * Count the walkable neighbours of (x,y) through a pure `isBlocked` lens (wall
 * terrain or a movement-blocking structure). Room-EDGE tiles (0 and 49) never
 * count: they are the border, not usable posts. Pure so the emergence rule is
 * unit-pinned without a room.
 */
export function emergenceTileCount(isBlocked: (x: number, y: number) => boolean, x: number, y: number): number {
  let free = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx <= 0 || nx >= 49 || ny <= 0 || ny >= 49) continue;
      if (!isBlocked(nx, ny)) free++;
    }
  }
  return free;
}

/**
 * Does this room want ANOTHER spawn? Pending SITES count against the limit: a
 * 15k spawn site builds slowly, and re-placing every cooldown would spam
 * ERR_INVALID_TARGET while hiding the rung below it. An unknown RCL falls back
 * to one spawn, so bad input can never over-place.
 */
export function wantsAnotherSpawn(rcl: number, builtSpawns: number, spawnSites: number): boolean {
  const limit = SPAWN_LIMITS[rcl] ?? 1;
  return builtSpawns + spawnSites < limit;
}

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

/**
 * The engine's global construction-site cap (MAX_CONSTRUCTION_SITES). Placing
 * past it fails ERR_FULL on every attempt, which - under the wide placement
 * below - would burn a cooldown per rung and stamp nothing but errors.
 */
export const SITE_CAP = 100;

/**
 * Should the ladder place structures this pass? (owner 2026-07-29: "instead
 * of just placing one construction site at a time ... place all of them,
 * however we still only build them one at a time, but we size the builders
 * to the size of all the construction sites").
 *
 * The OLD rule was `activeSites === 0`: no new rung until everything standing
 * was finished. That capped the crew against whatever single site happened to
 * be open, because the sum-of-projects lens (siteWorkRemaining ->
 * projectAbsorbRate) can only amortize a crew against work that EXISTS as
 * sites - the same reasoning that batched the extension set (owner
 * 2026-07-20), now generalized to every rung.
 *
 * Placing wide is safe precisely because the two things that could go wrong
 * are handled elsewhere: build FOCUS is the latch + ladder rank (buildRank /
 * nextBuildTarget), so a wide board is still built one site at a time in the
 * owner's order; and the RCL sequencing intent (at RCL2 containers wait for
 * the extension SET to be BUILT) lives in the rung gates themselves, which
 * still read BUILT structures, not sites.
 *
 * WIDENING IS A SURPLUS-SPEND LEVER, not a bootstrap behaviour. Placing the
 * set while sites already stand multiplies the construction sink (the same
 * sum-of-projects number that sizes the crew also sizes the PLAN's build
 * allocation), and in a cold room that diverts the spawn energy income
 * depends on - macro doctrine: production over consumption, fund producers
 * first. Measured shape: the runt-economy world (RCL2, 5 extensions built,
 * ~20 e/t) goes from 1 standing site to 3 per pass under a naive widening,
 * against the very spawn energy the miner upsize needs. So a room with
 * nothing spendable keeps the old conservative ladder - finish what you
 * started - exactly the rule paving already follows (roads wait for
 * spendableBankSurplus > 0). An EMPTY board always places: bootstrap must
 * progress.
 *
 * `atSiteCap` closes the gate at the engine limit so a full board doesn't
 * spam ERR_FULL every cooldown.
 */
export function placementGateOpen(x: {
  activeSites: number;
  wantsMore: boolean;
  atSiteCap: boolean;
  hasSurplus: boolean;
}): boolean {
  if (x.atSiteCap) return false;
  if (!x.wantsMore) return false;
  if (x.activeSites === 0) return true; // empty board: unchanged, bootstrap progresses
  return x.hasSurplus; // widen only when the colony can fund the set
}

/** A hauling route that would deposit at a port, for container siting. */
export interface PortApproach {
  /**
   * The IN-ROOM tile this route ARRIVES AT - the exit tile it enters by for a
   * remote source, or the source's own haul position when it is same-room.
   *
   * It must be in-room, and the caller resolves that. Passing a remote
   * source's raw position would be a silent geometry bug: room coordinates
   * restart at 0-49 per room, so a chebyshev between a tile in W42N22 and one
   * in W43N23 is not a distance at all. The direction a hauler actually comes
   * from is decided by which EXIT it enters through, which is what this is.
   */
  from: { x: number; y: number };
  /** Energy/tick this route deposits - the weight on its detour. */
  flowRate: number;
}

/**
 * Elect the tile for a DEPOSIT-PORT CONTAINER (owner 2026-08-06: *"it's
 * important to build the container where it's best accessible to incoming
 * hauling routes as well as adjacent to the link of course"*).
 *
 * THE TENDER IS WHAT MAKES THE TWO REQUIREMENTS COMPATIBLE. Without one, the
 * container must touch the link, because something has to move energy across
 * the gap - and the link's own tile is fixed wherever it was built, which may
 * be nowhere near where haulers arrive. A parked tender relaxes "adjacent to
 * the link" into "within 2 of it, sharing a parking tile", and that slack is
 * exactly what buys hauler accessibility. Its second job is decoupling the
 * container's position from the link's; the throughput was only its first.
 *
 * The constraint, from `parkedRelayCarry`'s own premise (a creep "standing
 * adjacent to both its bank and its sink", withdraw tick + transfer tick, zero
 * travel): there must be a walkable tile P with `range(P, container) <= 1` AND
 * `range(P, link) <= 1`. That forces `range(container, link) <= 2`, and no
 * further.
 *
 * WHY THE TILE IS WORTH OPTIMISING rather than taking the first legal one: the
 * candidate set spans at most ~4 tiles of one-way distance, i.e. ~8 round-trip
 * tiles. Against a d~50 route that is ~16% more CARRY - the same order as the
 * entire saving the deposit port exists to produce (DEP: 31.8 CARRY, 16%). A
 * badly sited container can eat the whole point of the port.
 *
 * Score = sum over routes of `flowRate * chebyshev(from, tile)`, minimised -
 * flow-weighted so the fattest route wins the tie, which is the same weighting
 * `depositSavings` already uses to rank ports. `from` is the route's ENTRY
 * TILE (see PortApproach): the cross-room leg up to that exit is identical for
 * every candidate, so only the in-room remainder can move the ranking, and
 * measuring it from the exit is both correct and sufficient.
 *
 * Pure: takes lenses, never Game/Memory (the module's purity ratchet).
 */
export function bestPortContainerTile(
  link: { x: number; y: number },
  approaches: readonly PortApproach[],
  isBlocked: (x: number, y: number) => boolean,
  isOccupied: (x: number, y: number) => boolean
): { x: number; y: number } | null {
  const inBounds = (x: number, y: number): boolean => x >= 1 && x <= 48 && y >= 1 && y <= 48;
  const cheb = (ax: number, ay: number, bx: number, by: number): number =>
    Math.max(Math.abs(ax - bx), Math.abs(ay - by));
  /** Is there a walkable tile adjacent to BOTH the candidate and the link? */
  const hasParkingTile = (x: number, y: number): boolean => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const px = x + dx;
        const py = y + dy;
        if (px === x && py === y) continue;
        if (!inBounds(px, py) || isBlocked(px, py)) continue;
        // The parking tile must not be the link's own tile (a structure), and
        // must touch the link so the transfer leg is range 1.
        if (px === link.x && py === link.y) continue;
        if (cheb(px, py, link.x, link.y) <= 1) return true;
      }
    }
    return false;
  };
  let best: { x: number; y: number; score: number } | null = null;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      const x = link.x + dx;
      const y = link.y + dy;
      if (dx === 0 && dy === 0) continue; // the link's own tile
      if (!inBounds(x, y) || isBlocked(x, y) || isOccupied(x, y)) continue;
      if (!hasParkingTile(x, y)) continue;
      let score = 0;
      for (const a of approaches) score += a.flowRate * cheb(a.from.x, a.from.y, x, y);
      // Tie-break toward the link: a closer container keeps the tender's
      // parking choice open as the room fills in around it.
      const tie = cheb(x, y, link.x, link.y);
      if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) <= 1e-9 && tie < cheb(best.x, best.y, link.x, link.y))) {
        best = { x, y, score };
      }
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

/**
 * A container slot worth RECLAIMING, or null (owner 2026-08-06: *"yes I think
 * we should definitely reclaim the unused container and have a mechanism for
 * that"*).
 *
 * `CONTAINER_LIMIT` is the GAME's per-room cap, so container rungs do not
 * queue - they stall, silently and forever, the moment the table fills. In the
 * live home room all five slots are spent (2 source + core depot + controller
 * + recycle pad), which is why the deposit-port rung has never placed anything
 * and 22.4% of port arrivals still HOLD at a full link.
 *
 * The controller container is not a TRADE against the port container - it is
 * already dead. `controllerInputSpot` returns a controller LINK before it ever
 * looks at a container, and `findMissingControllerContainer` refuses to build
 * one while a link stands, so a container there can only predate the link and
 * nothing reads it.
 *
 * PRECEDENT: the LINK SWAP rung already retires the weakest source link to
 * free a link-table slot for the controller link. This is that, one table over.
 *
 * CONDITIONS, each a guard rather than a preference:
 *  - the census must have PROVEN the container superseded, which it only does
 *    with a controller link present. Without one the container IS the input
 *    spot and retiring it strands the upgraders mid-upgrade.
 *  - something must WANT it gone. Reclaiming for tidiness is pure loss, so
 *    either the table is FULL and a port needs the slot, or - added
 *    2026-08-08 - the dead container is itself BLOCKING a port.
 *
 * THE BLOCKING CASE (owner 2026-08-08: *"the controller link should not have a
 * container"*). Measured t72862894: the superseded controller container at
 * (41,36) sits within 2 of the deposit port at (43,38), and that range is not
 * incidental - it is exactly the range `resolvePortBuffer` searches and
 * `hasContainerNear` tests. So the dead container made the port rung believe
 * that port was already served (it never places one, forever) while the
 * delivery side bound the CONTROLLER's store as the port's buffer. The table
 * was 4/5 with a free slot the whole time, so the FULL gate never fired and
 * nothing ever noticed.
 *
 * That is not tidiness - one dead container silently costs a real port its
 * buffer. The `full` gate is therefore lifted for this case only.
 *
 * THE SPILL IS ACCEPTED (owner 2026-08-08: *"I don't care about draining it
 * first. I just want this done asap"*). Destroying a container drops its
 * contents, and a ground pile decays at ceil(amount/1000) per tick - the live
 * one held 1,900e. That is a ONE-OFF bounded by the container cap; the block it
 * clears costs a whole deposit port its buffer for every tick it stands.
 * `energyLost` is still reported so the trade is visible, never silent.
 */
/** The range `resolvePortBuffer` searches for a port's buffer, and therefore
 *  the range at which a foreign container BLOCKS one. */
export const PORT_BUFFER_RANGE = 2;

export function reclaimableContainer(
  census: ContainerCensus | null
): { pos: Position; energyLost: number; reason: string } | null {
  if (!census) return null;
  const dead = census.supersededControllerContainer;
  if (!dead) return null;
  const cheb = (a: Position, b: Position): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  // Is this dead container the thing a port is mistaking for its buffer? Range
  // 2 because that is what resolvePortBuffer and hasContainerNear both use - a
  // third number here would be the two-books failure by construction.
  const blocking = census.ports.some(p => cheb(p.pos, dead.pos) <= PORT_BUFFER_RANGE);
  const wanted = census.full && census.ports.some(p => !p.hasContainer);
  if (!wanted && !blocking) return null;
  // NO DRAIN WAIT (owner 2026-08-08: *"I don't care about draining it first"*).
  // The spill is real - a ground pile decays at ceil(amount/1000) per tick - but
  // it is one-off and bounded by the container cap, while the block it clears
  // costs a whole port its buffer for as long as it stands. `energyLost` still
  // reports the spill, so the trade stays visible rather than silent.
  return {
    pos: dead.pos,
    energyLost: dead.energy,
    reason: blocking
      ? "controller link owns the input spot; this dead container is inside a deposit port's buffer range and blocks it"
      : "controller link owns the input spot; this container predates it and nothing reads it"
  };
}
