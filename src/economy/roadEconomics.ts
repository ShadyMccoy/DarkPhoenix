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
 * The second line matters as much as the first: spawn build-time is the
 * colony's scarce resource (see CorpPlanner's mining budget), so paving
 * effectively ENLARGES the mining budget - roads let the same spawn sustain
 * more sources.
 *
 * WHAT ROADS COST. Building: ROAD_BUILD_COST per plain tile, 5x on swamp
 * (a swamp road also REMOVES the swamp penalty entirely, which is why swamp
 * tiles are paved first below). Maintenance: roads decay by time, not by
 * use - ROAD_DECAY_HITS per ROAD_DECAY_INTERVAL, and repair restores
 * REPAIR_HITS_PER_ENERGY hits per energy, so a plain road tile costs a flat
 * ~0.001 e/t to keep standing (5x on swamp). A repairer's body time is
 * charged via REPAIR_OVERHEAD_FACTOR.
 *
 * All flows are amortized to energy/tick so the verdict composes with
 * netEnergy()/spawnPartsFor() in primitives.ts.
 */

import { BODY_COSTS, CARRY_CAPACITY, CREEP_LIFETIME, effectiveLife } from "./primitives";

/** Energy to build one road construction site's worth on plain terrain. */
export const ROAD_BUILD_COST = 300;
/** Swamp roads cost 5x to build (and to keep standing). */
export const SWAMP_ROAD_MULTIPLIER = 5;
/** Hits a plain road loses per decay interval. */
export const ROAD_DECAY_HITS = 100;
/** Ticks between road decay events. */
export const ROAD_DECAY_INTERVAL = 1000;
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
  /** bodySavingsPerTick - maintenancePerTick. */
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
 * Evaluate paving a route. `horizonTicks` is how long the route is expected
 * to exist (a home-source route lives as long as the room; a remote route at
 * least a reservation cycle) - the build cost must pay back within it.
 *
 * Note the asymmetry: swamp tiles are far better converts than plain ones
 * (10x fatigue falls to 1x), so a route with ANY swamp usually pays even
 * when an all-plain route of the same length would not.
 */
export function evaluateRoadRoute(route: RoadRouteSpec, horizonTicks: number = 4 * CREEP_LIFETIME): RoadVerdict {
  const oneWay = route.plainTiles + route.swampTiles;
  const units = carryUnits(route.flow, oneWay);
  const life = effectiveLife(oneWay);

  // Weighted MOVE need per CARRY across the unpaved path: each tile
  // contributes its surface's MOVE requirement, averaged over the path.
  const unpavedMovePerCarry =
    oneWay === 0
      ? MOVE_PER_CARRY_PLAIN
      : (route.plainTiles * MOVE_PER_CARRY_PLAIN + route.swampTiles * MOVE_PER_CARRY_SWAMP) / oneWay;

  const moveSavedPerCarry = Math.max(0, unpavedMovePerCarry - MOVE_PER_CARRY_ROAD);
  const bodySavingsPerTick = (units * moveSavedPerCarry * BODY_COSTS.MOVE) / life;
  // Each MOVE part saved is one spawn build-part not spent, recurring.
  const spawnPartsFreedPerTick = (units * moveSavedPerCarry) / life;

  const buildCost = route.plainTiles * ROAD_BUILD_COST + route.swampTiles * ROAD_BUILD_COST * SWAMP_ROAD_MULTIPLIER;
  const decayEnergyPerTick =
    (route.plainTiles * ROAD_DECAY_HITS + route.swampTiles * ROAD_DECAY_HITS * SWAMP_ROAD_MULTIPLIER) /
    ROAD_DECAY_INTERVAL /
    REPAIR_HITS_PER_ENERGY;
  const maintenancePerTick = decayEnergyPerTick * REPAIR_OVERHEAD_FACTOR;

  const netSavingsPerTick = bodySavingsPerTick - maintenancePerTick;
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
 * Priority ordering for paving: swamp tiles first (each converts 5 MOVE/CARRY
 * to 0.5), then plain tiles of the highest-flow routes. Returns a sortable
 * score - higher paves sooner.
 */
export function paveScore(route: RoadRouteSpec): number {
  const v = evaluateRoadRoute(route);
  return v.netSavingsPerTick <= 0 ? -Infinity : v.netSavingsPerTick / Math.max(1, v.buildCost / 1000);
}
