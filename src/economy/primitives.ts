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
import { RESERVER_DUTY, SPAWN_PARTS_PER_TICK } from "../corps/economics";

export { BODY_COSTS, CREEP_LIFETIME, MINER_COST, MINER_PARTS, SPAWN_PARTS_PER_TICK };

/** CARRY part capacity (energy a CARRY part holds). */
export const CARRY_CAPACITY = 50;

/** Energy/tick a standard source yields (3000 capacity / 300 regen). */
export const SOURCE_RATE = 10;

/** Energy/tick a single WORK part moves, by work class (Screeps *_POWER). */
export const HARVEST_ENERGY_PER_WORK = 2; // HARVEST_POWER: 2 energy/tick per WORK
export const UPGRADE_ENERGY_PER_WORK = 1; // UPGRADE_CONTROLLER_POWER: 1 energy/tick per WORK
export const BUILD_ENERGY_PER_WORK = 5; // BUILD_POWER: 5 energy/tick per WORK

/**
 * WORK parts needed to move `energyPerTick` at `energyPerWork` energy/tick per
 * WORK - the single conversion behind every "energy rate -> WORK body" figure
 * (miner harvest, upgrader burn, builder burn). Rounded up: a fractional WORK
 * cannot be spawned. Zero/negative rate -> 0 parts.
 */
export function workPartsForEnergyRate(energyPerTick: number, energyPerWork: number): number {
  if (energyPerTick <= 0) return 0;
  return Math.ceil(energyPerTick / energyPerWork);
}

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

/**
 * Body parts per WORK part of upgrader fleet, measured from the live fed-in-
 * place body (15W1C4M = 20 parts / 15 WORK). Used to convert a controller
 * energy allocation into the standing bodies that burn it.
 */
export const UPGRADER_PARTS_PER_WORK = 4 / 3;

/**
 * Spawn build-time (parts/tick) to MAINTAIN the upgrader fleet burning
 * `energyPerTick` at a controller `distance` tiles from its spawn. One WORK
 * burns UPGRADE_ENERGY_PER_WORK (1) e/t, each WORK rides in a body of
 * UPGRADER_PARTS_PER_WORK parts, amortized over the effective life. This is
 * the consumer side of the plan's spawn-parts ledger (spec 15 P4): energy
 * allocations are wishes until the bodies that burn them are affordable in
 * the spawn's OTHER currency.
 */
export function controllerWorkSpawnLoad(energyPerTick: number, distance: number): number {
  // Continuous, like carryPartsFor: planning math stays fractional and the
  // body sizer rounds (workPartsForEnergyRate ceils - correct for bodies,
  // wrong for a ledger, where the ceil made charge and audit disagree by a
  // fraction of one WORK body).
  const workParts = energyPerTick / UPGRADE_ENERGY_PER_WORK;
  return (workParts * UPGRADER_PARTS_PER_WORK) / effectiveLife(distance);
}

/**
 * Body parts per WORK of builder fleet (W-heavy build body: 5W1C3M = 1.8,
 * rounded up for the shuttle tanker's share). With BUILD_ENERGY_PER_WORK = 5,
 * a construction sink burns energy 5x more spawn-cheaply than a controller:
 * the same e/t needs one fifth the WORK bodies.
 */
export const BUILDER_PARTS_PER_WORK = 1.8; // measured: 5W1C3M = 9 parts / 5 WORK

/**
 * Spawn build-time (parts/tick) to maintain the builder fleet burning
 * `energyPerTick` at sites `distance` from the spawn - the construction-sink
 * side of the plan's spawn-parts ledger (spec 15 P4), mirror of
 * controllerWorkSpawnLoad. Continuous, like every planning formula here.
 */
export function constructionWorkSpawnLoad(energyPerTick: number, distance: number): number {
  const workParts = energyPerTick / BUILD_ENERGY_PER_WORK;
  return (workParts * BUILDER_PARTS_PER_WORK) / effectiveLife(distance);
}

/** Nominal feeder shuttle distance (storage -> controller input, measured live: 6). */
const FEEDER_NOMINAL_DISTANCE = 6;

/**
 * Spawn build-time (parts/tick) of the standing infrastructure the plan
 * implies but does not commission through routeToSinks: the storage->
 * controller feeder shuttle sized to `relayRate`, the extension tender
 * detail, and one reserver per remote room. Priced at CURRENT behavior
 * (reserver duty 1.0 - spec 15 P5; when the duty cycle ships this halves and
 * frees the parts). Fed to the planner as ColonyProblem.infraPartsPerTick by
 * the flow adapter, so the sink fill spends only what is truly left.
 */
export function infraSpawnLoad(relayRate: number, depotRoomCount: number, remoteRoomCount: number): number {
  // Feeder + tender are DEPOT movers: they exist only in rooms with a built
  // storage (`depotRoomCount`). Charging them unconditionally taxed early
  // worlds ~5-7% of the parts budget for infra that cannot exist there
  // (caught by grid cell plan-t1-single-source-loop on the first P4 gate).
  const feeder =
    depotRoomCount > 0 ? (2 * carryPartsFor(relayRate, FEEDER_NOMINAL_DISTANCE)) / effectiveLife(FEEDER_NOMINAL_DISTANCE) : 0;
  const TENDER_FLEET_PARTS = 72; // 3 tankers x measured 24-part body, per depot room
  const tender = (depotRoomCount * TENDER_FLEET_PARTS) / CREEP_LIFETIME;
  const RESERVER_PARTS_PER_ROOM = 4; // 2 CLAIM 2 MOVE
  const CLAIM_LIFETIME = 600;
  const RESERVER_WALK = 60; // nominal remote-controller walk
  // Priced at the SHIPPED duty cycle (P5, verified live 2026-07-18): the
  // corp coasts on the reservation bank, one stint per ~1080t. Holding this
  // at 1.0 after the fix shipped was pure phantom slack (owner: no standing
  // reserves - defense preempts via priority when needed, it does not
  // reserve capacity).
  const reservers =
    (RESERVER_DUTY * (remoteRoomCount * RESERVER_PARTS_PER_ROOM)) / Math.max(1, CLAIM_LIFETIME - RESERVER_WALK);
  return feeder + tender + reservers;
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
 * Expected defense cost per NPC raid under the fight-first posture: one
 * 5xATTACK/5xMOVE guard body (650) with a ~15% margin for the multi-creep
 * tail (~10% of raids are 2-5 smalls) and the occasional lost trade. A
 * DERIVED starting point - phase 5 telemetry replaces it with the measured
 * number (calibration windows >= 10x1500 ticks per the multi-draw rule).
 */
export const EXPECTED_RAID_DEFENSE_COST = 750;

/**
 * The invader tax as a per-energy coefficient: raids fire as a function of
 * energy harvested (one per E[105k] - see INVADER_RAID_MEAN_ENERGY), so the
 * expected defense cost composes as a constant tax on every harvested unit.
 * By construction it can never reorder equal-gross flows - it shifts
 * margins, dropping remotes whose profit was fictional.
 */
export function invaderTaxPerEnergy(expectedRaidCost: number): number {
  return expectedRaidCost / INVADER_RAID_MEAN_ENERGY;
}

/** The default remote-source tax rate (~0.71% of gross at the derived cost). */
export const INVADER_TAX_PER_ENERGY = invaderTaxPerEnergy(EXPECTED_RAID_DEFENSE_COST);

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
