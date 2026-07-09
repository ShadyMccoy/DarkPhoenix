/**
 * roadEconomics - closed-form cost/benefit for paving a haul route.
 *
 * THE TRADE. A loaded creep generates fatigue per non-MOVE body part by
 * terrain: 2 on plain, 10 on swamp, 1 on road. Each MOVE part clears
 * 2 fatigue/tick. So a full-speed loaded hauler needs, per CARRY part:
 *
 *   plain: 1 MOVE   (the codebase's current 1:1 default)
 *   swamp: 5 MOVE   (why pathing detours around swamps)
 *   road:  0.5 MOVE (2:1 CARRY:MOVE - the `haulerRatio` hint exists for this)
 *
 * Paving therefore cuts the recurring cost of every CARRY unit on the route:
 *
 *   energy: 100 -> 75 per CARRY unit per effective life  (25% cheaper)
 *   spawn build-parts: 2 -> 1.5 per CARRY unit           (25% fewer)
 *
 * The second line matters MORE than the first: spawn build-time is the
 * colony's scarce resource (see CorpPlanner's mining budget), so paving
 * effectively ENLARGES the mining budget - roads let the same spawn sustain
 * more sources. Pass `spawnPartValue` (energy per build-part, from
 * primitives.energyPerSpawnPart at the marginal un-staffed source) to
 * monetize this: at ~150 e/part (a d=75 remote waiting on spawn time) the
 * freed parts are worth ~3x the direct body-energy savings and cut the
 * plain-road payback from ~65k to ~12k ticks. When the spawn is slack the
 * value is 0 and the verdict falls back to body energy alone.
 *
 * WHAT ROADS COST. Building: ROAD_BUILD_COST per plain tile, 5x on swamp,
 * 150x on wall (a tunnel - the only way to make wall terrain passable).
 * A road holds ROAD_HITS (same 5x/150x terrain scaling) and its decay timer
 * loses ROAD_DECAY_HITS per ROAD_DECAY_INTERVAL of timer time - but the
 * timer drains by 1 tick of wall-clock PLUS 1 tick per body part of every
 * creep that steps on the tile. Decay is therefore traffic-driven: an unused
 * road lasts UNMAINTAINED_ROAD_LIFE (50k ticks) on any terrain, while a busy
 * haul route wears out in proportion to the flow it carries. For a 2:1 road
 * hauler fleet the extra drain works out to a flat 3*flow/50 per tile per
 * tick, independent of route length (fleet size grows with length, but each
 * creep's steps spread over more tiles - the two cancel).
 *
 * Repair restores REPAIR_HITS_PER_ENERGY hits per energy, so a plain road
 * tile on a 10 e/t route costs ~0.0024 e/t to keep standing (5x on swamp,
 * 150x on wall - one tunnel tile at 10 e/t costs ~0.36 e/t, more than the
 * total savings of a 50-tile plain road). A repairer's body time is charged
 * via REPAIR_OVERHEAD_FACTOR.
 *
 * TUNNELS. A wall tile has no unpaved baseline (it is impassable), so
 * evaluateRoadRoute claims no fatigue savings for it - a tunnel pays only by
 * SHORTENING the route. Decide tunnels by comparing pavedRouteCostPerTick
 * (and build cost) of the tunneled candidate against the long-way-around
 * candidate; the massive per-tile upkeep means a tunnel must cut a long
 * detour on a busy route to win, and even then the 45k/tile build cost
 * pushes payback out by hundreds of thousands of ticks.
 *
 * All flows are amortized to energy/tick so the verdict composes with
 * netEnergy()/spawnPartsFor() in primitives.ts.
 */

import { BODY_COSTS, CARRY_CAPACITY, CREEP_LIFETIME, effectiveLife } from "./primitives";

/** Energy to build one road construction site's worth on plain terrain. */
export const ROAD_BUILD_COST = 300;
/** Swamp roads cost 5x to build, hold 5x hits, and decay 5x per interval. */
export const SWAMP_ROAD_MULTIPLIER = 5;
/** Wall (tunnel) roads: 150x build cost, hits, and decay. */
export const WALL_ROAD_MULTIPLIER = 150;
/** Max hits of a plain road (5x swamp, 150x wall). */
export const ROAD_HITS = 5000;
/** Hits a road loses per decay interval (plain; 5x swamp, 150x wall). */
export const ROAD_DECAY_HITS = 100;
/** Decay-timer ticks between decay events. */
export const ROAD_DECAY_INTERVAL = 1000;
/**
 * Wall-clock life of an untrafficked, unrepaired road. hits/decay is 50
 * intervals on every terrain, so this is uniform: 50,000 ticks. Traffic
 * divides it - each creep step drains the decay timer by its body-part count.
 */
export const UNMAINTAINED_ROAD_LIFE = (ROAD_HITS / ROAD_DECAY_HITS) * ROAD_DECAY_INTERVAL;
/** Hits restored per 1 energy of repair (100 hits per energy at 1 WORK). */
export const REPAIR_HITS_PER_ENERGY = 100;
/**
 * Multiplier on raw maintenance energy to cover the repairer's own body
 * amortization and walking. Roads share the room's existing repair fleet, so
 * this is a light surcharge, not a dedicated creep.
 */
export const REPAIR_OVERHEAD_FACTOR = 1.5;

/** MOVE parts needed per CARRY part for a LOADED hauler, by surface. */
export const MOVE_PER_CARRY_PLAIN = 1;
export const MOVE_PER_CARRY_SWAMP = 5;
export const MOVE_PER_CARRY_ROAD = 0.5;

/** A haul route as the road planner sees it. */
export interface RoadRouteSpec {
  /** One-way path length in tiles (the actual path, not chebyshev). */
  plainTiles: number;
  /** How many of those tiles are swamp (subset of the path). */
  swampTiles: number;
  /** Wall tiles to tunnel through (subset of the path; 150x everything). */
  wallTiles?: number;
  /** Energy per tick flowing over the route (the planned haul amount). */
  flow: number;
}

export interface RoadVerdict {
  /** One-time energy to pave the route. */
  buildCost: number;
  /** Recurring e/t to keep the pavement standing (repair energy + overhead). */
  maintenancePerTick: number;
  /** Recurring e/t saved on hauler bodies (smaller MOVE complement). */
  bodySavingsPerTick: number;
  /** Recurring spawn build-parts/tick freed (the mining-budget currency). */
  spawnPartsFreedPerTick: number;
  /** bodySavings + spawnPartsFreed * spawnPartValue - maintenance. */
  netSavingsPerTick: number;
  /** Ticks for the net savings to repay the build cost (Infinity if never). */
  paybackTicks: number;
  /** True when the route should be paved within the given horizon. */
  worthPaving: boolean;
}

/**
 * Carry units (CARRY parts) a route needs: flow * roundTrip / CARRY_CAPACITY.
 * Mirrors primitives.carryPartsFor's model (2 ticks load/unload included).
 */
function carryUnits(flow: number, oneWay: number): number {
  return (flow * (2 * oneWay + 2)) / CARRY_CAPACITY;
}

/**
 * Extra decay-timer ticks drained per tile per tick by the hauler fleet.
 * Every step drains 1 tick per body part. A 2:1 road hauler is
 * (1 + MOVE_PER_CARRY_ROAD) parts per CARRY unit, and each tile is crossed
 * twice per round trip, so drain = 2 * 1.5 * units / (2*oneWay + 2)
 * = 3 * flow / CARRY_CAPACITY - a flat function of flow, length-free.
 */
function trafficTimerDrain(flow: number): number {
  return (2 * (1 + MOVE_PER_CARRY_ROAD) * flow) / CARRY_CAPACITY;
}

/** Decay-weighted tile count: plain=1, swamp=5x, wall=150x. */
function weightedTiles(route: RoadRouteSpec): number {
  return (
    route.plainTiles +
    route.swampTiles * SWAMP_ROAD_MULTIPLIER +
    (route.wallTiles ?? 0) * WALL_ROAD_MULTIPLIER
  );
}

/** Recurring e/t of repair (with overhead) to keep the route standing. */
function maintenanceFor(route: RoadRouteSpec): number {
  const hitsPerTick =
    (weightedTiles(route) * ROAD_DECAY_HITS * (1 + trafficTimerDrain(route.flow))) / ROAD_DECAY_INTERVAL;
  return (hitsPerTick / REPAIR_HITS_PER_ENERGY) * REPAIR_OVERHEAD_FACTOR;
}

/**
 * Evaluate paving a route. `horizonTicks` is how long the route is expected
 * to exist (a home-source route lives as long as the room; a remote route at
 * least a reservation cycle) - the build cost must pay back within it.
 * `spawnPartValue` is the shadow price of a spawn build-part (energy/part,
 * see energyPerSpawnPart); pass the marginal un-staffed source's value when
 * the spawn budget binds, 0 (the conservative default) when it is slack.
 *
 * Note the asymmetry: swamp tiles are far better converts than plain ones
 * (10x fatigue falls to 1x), so a route with ANY swamp usually pays even
 * when an all-plain route of the same length would not. Wall tiles claim NO
 * fatigue savings here (there is no unpaved baseline) - see the header for
 * how to decide tunnels.
 */
export function evaluateRoadRoute(
  route: RoadRouteSpec,
  horizonTicks: number = 4 * CREEP_LIFETIME,
  spawnPartValue: number = 0
): RoadVerdict {
  const wallTiles = route.wallTiles ?? 0;
  const oneWay = route.plainTiles + route.swampTiles + wallTiles;
  const units = carryUnits(route.flow, oneWay);
  const life = effectiveLife(oneWay);

  // Weighted MOVE need per CARRY across the unpaved path: each tile
  // contributes its surface's MOVE requirement, averaged over the path.
  // Wall tiles have no unpaved baseline, so they contribute the road rate
  // (zero savings) - a tunnel's benefit is route shortening, not fatigue.
  const unpavedMovePerCarry =
    oneWay === 0
      ? MOVE_PER_CARRY_PLAIN
      : (route.plainTiles * MOVE_PER_CARRY_PLAIN +
          route.swampTiles * MOVE_PER_CARRY_SWAMP +
          wallTiles * MOVE_PER_CARRY_ROAD) /
        oneWay;

  const moveSavedPerCarry = Math.max(0, unpavedMovePerCarry - MOVE_PER_CARRY_ROAD);
  const bodySavingsPerTick = (units * moveSavedPerCarry * BODY_COSTS.MOVE) / life;
  // Each MOVE part saved is one spawn build-part not spent, recurring.
  const spawnPartsFreedPerTick = (units * moveSavedPerCarry) / life;

  const buildCost = weightedTiles(route) * ROAD_BUILD_COST;
  const maintenancePerTick = maintenanceFor(route);

  const netSavingsPerTick = bodySavingsPerTick + spawnPartsFreedPerTick * spawnPartValue - maintenancePerTick;
  const paybackTicks = netSavingsPerTick > 0 ? buildCost / netSavingsPerTick : Infinity;

  return {
    buildCost,
    maintenancePerTick,
    bodySavingsPerTick,
    spawnPartsFreedPerTick,
    netSavingsPerTick,
    paybackTicks,
    worthPaving: oneWay > 0 && netSavingsPerTick > 0 && paybackTicks <= horizonTicks
  };
}

/**
 * Total recurring e/t of operating the route ONCE PAVED: hauler bodies at the
 * 2:1 road ratio plus road maintenance. This is the number to compare between
 * route candidates - e.g. a tunneled shortcut vs the long way around - since
 * evaluateRoadRoute's savings are only relative to the SAME route unpaved.
 */
export function pavedRouteCostPerTick(route: RoadRouteSpec): number {
  const oneWay = route.plainTiles + route.swampTiles + (route.wallTiles ?? 0);
  const units = carryUnits(route.flow, oneWay);
  const bodyCost = (units * (BODY_COSTS.CARRY + MOVE_PER_CARRY_ROAD * BODY_COSTS.MOVE)) / effectiveLife(oneWay);
  return bodyCost + maintenanceFor(route);
}

/**
 * Priority ordering for paving: swamp tiles first (each converts 5 MOVE/CARRY
 * to 0.5), then plain tiles of the highest-flow routes. Returns a sortable
 * score - higher paves sooner.
 */
export function paveScore(route: RoadRouteSpec, spawnPartValue: number = 0): number {
  const v = evaluateRoadRoute(route, undefined, spawnPartValue);
  return v.netSavingsPerTick <= 0 ? -Infinity : v.netSavingsPerTick / Math.max(1, v.buildCost / 1000);
}
