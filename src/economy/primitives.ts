/**
 * @fileoverview Canonical economic primitives for the colony economy.
 *
 * ONE definition of every per-tick economic quantity the planner and corps reason
 * about. Before this module these formulas were copy-pasted across FlowTypes,
 * FlowSolver, EconomyPlanner, EconomyAdapter, ConstructionCorp, BodyBuilder,
 * EdgeVariant and FlowEdge - with subtle divergences (fixed CREEP_LIFETIME vs
 * life-minus-travel, +2 vs +4 round-trip, etc.). Everything economic now derives
 * from here so the numbers cannot drift apart.
 *
 * The semantics match the live planner (CorpPlanner): a creep posted
 * `distance` tiles from its spawn loses ~`distance` ticks walking out, so its
 * spawn cost is amortised over `effectiveLife(distance)`, not the full lifetime.
 *
 * @module economy/primitives
 */

import { BODY_COSTS, CREEP_LIFETIME, MINER_COST, MINER_PARTS } from "../flow/FlowTypes";
import { SPAWN_PARTS_PER_TICK } from "../corps/economics";

export { BODY_COSTS, CREEP_LIFETIME, MINER_COST, MINER_PARTS, SPAWN_PARTS_PER_TICK };

/** CARRY part capacity (energy a CARRY part holds). */
export const CARRY_CAPACITY = 50;

/** Energy/tick a standard source yields (3000 capacity / 300 regen). */
export const SOURCE_RATE = 10;

/**
 * Effective working life (ticks) of a creep posted `distance` tiles from its
 * spawn. It spends ~`distance` ticks walking to its post before it can work or
 * be replaced, so its build cost is amortised over the remainder. Floored at 1
 * so overhead stays finite for absurd distances.
 */
export function effectiveLife(distance: number): number {
  return Math.max(1, CREEP_LIFETIME - distance);
}

/**
 * Round-trip travel time (ticks) for a hauler covering `distance` tiles each way,
 * plus 2 ticks to load and unload. A 1:1 CARRY:MOVE hauler moves at full speed
 * both ways, so the trip is symmetric.
 */
export function roundTripTicks(distance: number): number {
  return 2 * distance + 2;
}

/**
 * CARRY parts needed to keep `rate` energy/tick in flight across `distance`.
 * carry = rate * roundTrip / CARRY_CAPACITY. Continuous (fractional); callers
 * round up when sizing an actual body.
 */
export function carryPartsFor(rate: number, distance: number): number {
  return (rate * roundTripTicks(distance)) / CARRY_CAPACITY;
}

export { SPAWN_TIME_PER_PART } from "../planning/EconomicConstants";
import { SPAWN_TIME_PER_PART } from "../planning/EconomicConstants";

/**
 * Ticks between STARTING a creep's spawn and it standing at its post:
 * build time (3/part) plus the walk out. `travelTicks` is the walk in TICKS,
 * not tiles - callers convert (e.g. distance * travelTicksPerTile) so slow
 * early bodies get the longer lead they actually need. This is the delivery
 * contract's lead time - the planner's effectiveLife amortization already
 * assumes a successor arrives the tick its predecessor dies, and that only
 * happens if the replacement STARTS this many ticks early.
 */
export function deliveryLeadTime(bodyParts: number, travelTicks: number): number {
  // 1.5x + 10 safety on the walk: measured (grid churn-t3-gapless-replacement)
  // real walks run ~1.75x the fatigue model once pathing noise, spawn-exit
  // delay and assignment lag are paid, and the cost asymmetry favors early
  // (a few ticks of double-staffing) over late (a dark post).
  return SPAWN_TIME_PER_PART * bodyParts + Math.ceil(travelTicks * 1.5) + 10;
}

/**
 * Whether an incumbent still counts as staffing its post for SPAWN PLANNING.
 * A creep inside its replacement lead time keeps working until it dies, but
 * its successor must start spawning NOW for the post to stay continuously
 * staffed - so for demand purposes it no longer holds the post. `ttl` is
 * undefined while a creep is still spawning: that is the freshest possible
 * incumbent (a successor already in the pipe), so it staffs.
 */
export function staffsPost(ttl: number | undefined, bodyParts: number, travelTicks: number): boolean {
  if (ttl === undefined) return true;
  return ttl > deliveryLeadTime(bodyParts, travelTicks);
}

/**
 * The consumption rate (energy/tick) a CONSUMER should be sized to, given the
 * ACTUAL energy at its work site (owner doctrine 2026-07-10: "plan consuming
 * corps only based on the actual energy available... 2000 in a storage by the
 * controller over a ~1500-tick lifetime needs X body parts"). Stock drains
 * over one creep generation, plus whatever measurably flows in. Sizing
 * consumers from ACTUALS (not the goal plan's allocation) is self-correcting:
 * under-delivery -> small stock -> small consumers -> spawn capacity stays on
 * the supply side (macro: income first, then spend savings); a windfall ->
 * consumers scale up to eat it.
 */
export function sustainableConsumptionRate(stock: number, inflow = 0): number {
  return inflow + stock / CREEP_LIFETIME;
}

/** Miner spawn overhead (energy/tick) for a source `distance` from its spawn. */
export function minerOverhead(distance: number): number {
  return MINER_COST / effectiveLife(distance);
}

/** Hauler spawn overhead (energy/tick) for `carryParts` posted `distance` away. */
export function haulerOverhead(carryParts: number, distance: number): number {
  return (carryParts * (BODY_COSTS.CARRY + BODY_COSTS.MOVE)) / effectiveLife(distance);
}

/**
 * Net energy/tick a source actually yields the colony after paying for the miner
 * and the haulers that carry its energy home: rate - minerOverhead -
 * haulerOverhead. This is the profitability of mining the source; <= 0 means it
 * costs more to staff than it produces.
 */
export function netEnergy(rate: number, distance: number): number {
  return rate - minerOverhead(distance) - haulerOverhead(carryPartsFor(rate, distance), distance);
}

/**
 * Spawn build-time (parts/tick) the miner + haulers serving a source consume.
 * (MINER_PARTS + 2*carryParts) / life: the miner is MINER_PARTS parts, and each
 * hauler CARRY part needs a MOVE to pair with it, so 2 parts per carry. This is
 * the scarce resource the planner budgets across a spawn's sources.
 */
export function spawnPartsFor(rate: number, distance: number): number {
  return (MINER_PARTS + 2 * carryPartsFor(rate, distance)) / effectiveLife(distance);
}

/**
 * Shadow price of spawn build-time: energy/tick gained per build-part/tick
 * spent staffing a source at `distance`. netEnergy / spawnPartsFor - the
 * exchange rate between the colony's two currencies. Evaluated AT THE MARGIN
 * (the best un-staffed source), it prices anything that frees spawn parts:
 * ~537 e/part for a home source (d=20), ~150 at d=75, ~79 at d=120. When the
 * spawn budget is slack (no source waiting), freed parts are worth ~0 - the
 * caller owns that regime check.
 */
export function energyPerSpawnPart(rate: number, distance: number): number {
  return netEnergy(rate, distance) / spawnPartsFor(rate, distance);
}

/**
 * Fraction of a spawn's build-rate that mining + hauling may claim. The spawn
 * also builds upgraders, builders, reservers and scouts, so income creeps get
 * only part of its 1/3 parts-per-tick. This sets how hard the spawn-time budget
 * bites before far sources fall out of contention.
 */
export const MINING_BUDGET_FRACTION = 0.6;

/** A spawn's per-tick build-time budget available to mining + hauling. */
export function miningBudgetPerSpawn(): number {
  return SPAWN_PARTS_PER_TICK * MINING_BUDGET_FRACTION;
}

// ---------------------------------------------------------------------------
// NPC-invader raid facts (spec 13 ground truth, verified against the vendored
// engine in node_modules - the same code the live servers run). Raids are a
// metered tax on OUR harvesting: the engine sums a per-source counter
// (engine harvest.js:45-48) and the backend cron fires a raid when the room's
// sum reaches `invaderGoal` (backend cronjobs.js:386-391).
// ---------------------------------------------------------------------------

/** The base raid goal (backend `C.INVADERS_ENERGY_GOAL`, constants.js:776). */
export const INVADERS_ENERGY_GOAL = 100_000;

/**
 * The goal's post-raid reroll floor: `floor(100k * U(0.7, 1.3))`
 * (cronjobs.js:433-438). Below this much accrued debt a raid CANNOT fire.
 */
export const RAID_GOAL_FLOOR = 70_000;

/**
 * The reroll ceiling for the common (90%) branch. Debt beyond this with no
 * raid observed is evidence raids aren't firing here at all (sector has no
 * live stronghold, or every exit borders an owned/reserved room) - the meter
 * goes OVERDUE and the guard disarms.
 */
export const RAID_GOAL_CEIL = 130_000;

/**
 * Expected energy harvested per raid: 90% U(70k,130k) + 5% doubled + 5%
 * exactly 100k (the engine's Math.floor(0.5)=0 quirk falls back to the base
 * goal) = 0.9*100k + 0.05*200k + 0.05*100k.
 */
export const INVADER_RAID_MEAN_ENERGY = 105_000;

/**
 * Arm the guard one delivery lead under the goal floor: the crossing at
 * ~10 e/tick gives >=500 ticks of lead versus ~180 needed for spawn + walk,
 * so a guard commissioned here stands at the source before the raid can fire
 * (bonzAI/Overmind arm 65k-90k against the same floor).
 */
export const RAID_ARM_FLOOR = 65_000;

/** Raid invaders live exactly this long and never leave their room (cronjobs.js:281). */
export const INVADER_TTL = 1_500;

/**
 * Minimum REMAINING occupation (read `invaderReservedUntil - Game.time`)
 * before the core-buster mission is worth commissioning. Payback sketch
 * (engine facts): income under a foreign reservation is 0, an unmolested
 * level-0 core renews its reservation for the parent stronghold's whole
 * collapse window (tens of thousands of ticks), and the mission costs one
 * ATTACK body (390-1300) plus one CLAIM striker (650) against the room's
 * FULL rate restored. At a 5-10 e/tick blackout, the mission repays in well
 * under 1000 ticks of remaining occupation; below the gate the reservation
 * is about to lapse on its own and fighting buys nothing.
 */
export const CORE_BUSTER_MIN_REMAINING = 1_000;
