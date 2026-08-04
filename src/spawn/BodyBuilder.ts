/**
 * @fileoverview Body building utilities for creeps.
 *
 * Calculates optimal creep bodies based on desired parts and available
 * energy capacity. Enables dynamic scaling of creep size as extensions
 * are built.
 *
 * @module spawn/BodyBuilder
 */

import { BODY_COSTS, CARRY_CAPACITY } from "../economy/primitives";

/**
 * Result of a body building calculation.
 */
export interface BodyResult {
  /** The body parts array to pass to spawnCreep */
  body: BodyPartConstant[];
  /** Total energy cost of this body */
  cost: number;
  /** Number of WORK parts in this body */
  workParts: number;
}

/**
 * Cost of each body part type, keyed by the runtime part constants. Values
 * come from the ONE table (primitives.BODY_COSTS) - this is just the
 * lowercase-key view the builders index with.
 */
const PART_COSTS: Record<BodyPartConstant, number> = {
  [WORK]: BODY_COSTS.WORK,
  [CARRY]: BODY_COSTS.CARRY,
  [MOVE]: BODY_COSTS.MOVE,
  [ATTACK]: BODY_COSTS.ATTACK,
  [RANGED_ATTACK]: BODY_COSTS.RANGED_ATTACK,
  [HEAL]: BODY_COSTS.HEAL,
  [CLAIM]: BODY_COSTS.CLAIM,
  [TOUGH]: BODY_COSTS.TOUGH
};

/**
 * Maximum body parts per creep (Screeps limit).
 */
const MAX_BODY_PARTS = 50;

/**
 * Builds an optimal miner body given energy capacity.
 *
 * Miners need WORK parts for harvesting and MOVE parts for mobility.
 * Pattern: 2 WORK per 1 MOVE (miners stand still while harvesting).
 *
 * At RCL 1 (300 energy): [WORK, WORK, MOVE] = 250 cost, 2 WORK
 * At RCL 4 (800 energy): [WORK x5, CARRY, MOVE x3] = 700 cost, 5 WORK
 * At RCL 7 (5600 energy): same as RCL 4 (capped for full harvest)
 *
 * From MINER_CARRY_MIN_CAPACITY up, the body gains one CARRY part: it buffers
 * the first 50 harvested (harmless for drop mining - once full, harvest spills
 * to the ground/container exactly as before) and is what lets a miner feed an
 * adjacent source LINK at RCL 5+ without a separate body shape.
 *
 * @param desiredWork - Number of WORK parts desired (typically 5 for full harvest)
 * @param energyCapacity - Available energy capacity (room.energyCapacityAvailable)
 * @returns Body configuration with body array, cost, and actual work parts
 */
export const MINER_CARRY_MIN_CAPACITY = 600;

export function buildMinerBody(desiredWork: number, energyCapacity: number, withCarry = false): BodyResult {
  // Minimum viable miner: 1 WORK + 1 MOVE = 150 energy
  const minEnergy = PART_COSTS[WORK] + PART_COSTS[MOVE];
  if (energyCapacity < minEnergy) {
    return { body: [], cost: 0, workParts: 0 };
  }

  // NO CARRY by default (owner 2026-07-10: pre-link it buffers 50 energy
  // once and drops everything anyway - 50 wasted energy + 3 wasted
  // spawn-ticks per miner generation). The ONLY miner that gets a CARRY is
  // a link-fed one (withCarry=true, bodyStrategy "linkFed"): feeding the
  // source link is the one job that uses it.
  const addCarry = withCarry && energyCapacity >= MINER_CARRY_MIN_CAPACITY;
  if (addCarry) energyCapacity -= PART_COSTS[CARRY];

  // Calculate how many WORK parts we can afford
  // Pattern: 2 WORK + 1 MOVE costs 250 energy
  // Each additional pair of WORK + 0.5 MOVE = 150 energy per WORK on average
  // More precisely: for N WORK parts, we need ceil(N/2) MOVE parts
  // Cost = N * 100 + ceil(N/2) * 50

  let workParts = 0;
  let moveParts = 0;
  let cost = 0;

  // Add WORK parts up to desired amount or energy limit
  while (workParts < desiredWork) {
    const newWorkCost = PART_COSTS[WORK];
    // Do we need another MOVE part?
    const needsMove = workParts + 1 > moveParts * 2;
    const newMoveCost = needsMove ? PART_COSTS[MOVE] : 0;
    const totalNewCost = newWorkCost + newMoveCost;

    if (cost + totalNewCost > energyCapacity) {
      break;
    }

    if (workParts + moveParts + 1 + (needsMove ? 1 : 0) > MAX_BODY_PARTS) {
      break;
    }

    workParts++;
    if (needsMove) {
      moveParts++;
    }
    cost += totalNewCost;
  }

  // Build the body array (WORK parts first, then MOVE for damage resistance)
  const body: BodyPartConstant[] = [];
  for (let i = 0; i < workParts; i++) {
    body.push(WORK);
  }
  if (addCarry && workParts + moveParts + 1 <= MAX_BODY_PARTS) {
    body.push(CARRY);
    cost += PART_COSTS[CARRY];
  }
  for (let i = 0; i < moveParts; i++) {
    body.push(MOVE);
  }

  return { body, cost, workParts };
}

/**
 * Result of a hauler body calculation.
 */
export interface HaulerBodyResult {
  /** The body parts array to pass to spawnCreep */
  body: BodyPartConstant[];
  /** Total energy cost of this body */
  cost: number;
  /** Total carry capacity of this body */
  carryCapacity: number;
}

/**
 * Builds a flow hauler body from a desired CARRY count and a ratio hint - the
 * demand-driven executor path (SpawnDemand.bodyParam = desired CARRY,
 * SpawnDemand.haulerRatio = terrain hint). Semantics are the pre-spec-17
 * SpawningCorp role-switch hauler case, verbatim and pinned by
 * test/unit/framework/bodyEquivalence.test.ts: whole CARRY:MOVE units only,
 * at least one unit even when the budget cannot afford it (the executor's
 * energy check rejects the spawn instead), 50-part cap.
 *
 * @param desiredCarry - Desired CARRY parts (undefined/0 = fill the budget)
 * @param energyBudget - Energy granted by the scheduler
 * @param ratio - CARRY:MOVE ratio hint (default balanced 1:1)
 */
export function buildRatioHaulerBody(
  desiredCarry: number | undefined,
  energyBudget: number,
  ratio: "2:1" | "1:1" | "1:2" = "1:1"
): HaulerBodyResult {
  const [carryRatio, moveRatio] = ratio === "2:1" ? [2, 1] : ratio === "1:2" ? [1, 2] : [1, 1];
  const costPerUnit = PART_COSTS[CARRY] * carryRatio + PART_COSTS[MOVE] * moveRatio;
  const partsPerUnit = carryRatio + moveRatio;
  const maxByBudget = Math.floor(energyBudget / costPerUnit);
  const maxBySize = Math.floor(MAX_BODY_PARTS / partsPerUnit);
  const desiredUnits = desiredCarry ? Math.ceil(desiredCarry / carryRatio) : maxByBudget;
  const units = Math.max(1, Math.min(desiredUnits, maxByBudget, maxBySize));
  const body: BodyPartConstant[] = [];
  for (let i = 0; i < units * carryRatio; i++) body.push(CARRY);
  for (let i = 0; i < units * moveRatio; i++) body.push(MOVE);
  return { body, cost: units * costPerUnit, carryCapacity: units * carryRatio * CARRY_CAPACITY };
}

/**
 * Result of a tanker body calculation.
 */
export interface TankerBodyResult {
  /** The body parts array to pass to spawnCreep */
  body: BodyPartConstant[];
  /** Total energy cost of this body */
  cost: number;
  /** Total carry capacity of this body */
  carryCapacity: number;
}

/**
 * Builds a tanker body for local node distribution.
 *
 * Tankers work within a node, shuttling energy between local sinks and sources
 * (e.g. a hauler's drop-off -> the static builder). Crucially, a tanker spends
 * most of its life PARKED at its worker, slowly being drained, and only
 * occasionally trundles back to refuel. Movement speed therefore barely matters:
 * the slow leg (loaded, on plains) is a small fraction of the duty cycle, and a
 * hot-swap relay keeps the worker fed while one tanker is away.
 *
 * So tankers are built CARRY-heavy (few MOVE parts). For the same energy this
 * roughly doubles the buffer a tanker holds versus a balanced hauler body - at
 * 300 energy, 5 CARRY + 1 MOVE (250 capacity) instead of 3 CARRY + 3 MOVE (150).
 * On roads we can go even more CARRY-heavy (fatigue is halved).
 *
 * @param requiredCarry - Number of CARRY parts needed (from demand model)
 * @param energyCapacity - Available energy capacity (room.energyCapacityAvailable)
 * @param useRoads - Whether tanker will primarily use roads (default true)
 * @returns Body configuration with body array, cost, and carry capacity
 */
/** Result of buildBuilderBody: the D3 self-buffered consumer body. */
export interface BuilderBodyResult {
  body: BodyPartConstant[];
  cost: number;
  workParts: number;
  carryParts: number;
}

/**
 * The spec-34 D3 builder body: WORK from the absorb share, CARRY = the onboard
 * BUFFER (sized upstream by primitives.bufferCarryParts to bridge the refuel
 * interval - the corp passes it down as the bufferCarry hint), MOVE sized for
 * UNLADEN travel: empty CARRY generates no fatigue (C3), so relocation between
 * sites is free for the buffer and MOVE only has to move the WORK core -
 * ceil(WORK/2)+1 (the +1 absorbs the odd laden site hop). Under a tight budget
 * WORK and CARRY shrink TOGETHER (a slower burner needs less buffer - the
 * ratio is the contract, not either count alone).
 */
export function buildBuilderBody(desiredWork: number, bufferCarry: number, energyCapacity: number): BuilderBodyResult {
  const movesFor = (w: number): number => Math.ceil(w / 2) + 1;
  const carryFor = (w: number, dw: number): number => Math.max(1, Math.ceil((bufferCarry * w) / Math.max(1, dw)));
  const costOf = (w: number, c: number, m: number): number =>
    w * PART_COSTS[WORK] + c * PART_COSTS[CARRY] + m * PART_COSTS[MOVE];

  const dw = Math.max(1, desiredWork);
  for (let w = dw; w >= 1; w--) {
    const c = carryFor(w, dw);
    const m = movesFor(w);
    if (w + c + m > MAX_BODY_PARTS) continue;
    const cost = costOf(w, c, m);
    if (cost > energyCapacity) continue;
    const body: BodyPartConstant[] = [];
    for (let i = 0; i < w; i++) body.push(WORK);
    for (let i = 0; i < c; i++) body.push(CARRY);
    for (let i = 0; i < m; i++) body.push(MOVE);
    return { body, cost, workParts: w, carryParts: c };
  }
  // Min-viable floor (cold start): 1W 1C 1M at 200 - a crawling starter beats
  // no builder at all; the buffered shape takes over from 250 up.
  const minCost = PART_COSTS[WORK] + PART_COSTS[CARRY] + PART_COSTS[MOVE];
  if (energyCapacity >= minCost) {
    return { body: [WORK, CARRY, MOVE], cost: minCost, workParts: 1, carryParts: 1 };
  }
  return { body: [], cost: 0, workParts: 0, carryParts: 0 };
}

/** The tanker's CARRY:MOVE ratios - one constant, every reader (owner
 * 2026-07-28: sizing must be correct regardless of the ratio). HOMED in
 * primitives since phase 1 of the income-statement program (the commission's
 * all-in price is a third reader and lives plan-side); re-exported here so
 * body-building imports keep reading them beside the builder. */
export { TANKER_CARRY_PER_MOVE_PLAIN, TANKER_CARRY_PER_MOVE_ROAD } from "../economy/primitives";
import { TANKER_CARRY_PER_MOVE_PLAIN, TANKER_CARRY_PER_MOVE_ROAD } from "../economy/primitives";

export function buildTankerBody(requiredCarry: number, energyCapacity: number, useRoads = true): TankerBodyResult {
  // Minimum viable tanker: 1 CARRY + 1 MOVE = 100 energy
  const minEnergy = PART_COSTS[CARRY] + PART_COSTS[MOVE];
  if (energyCapacity < minEnergy) {
    return { body: [], cost: 0, carryCapacity: 0 };
  }

  // CARRY-heavy because a tanker is mostly stationary (see doc above). 1 MOVE
  // per 3 CARRY on plains (slow when loaded, but it rarely moves); on roads,
  // where fatigue is halved, go to 1 MOVE per 5 CARRY.
  const carryPerMove = useRoads ? TANKER_CARRY_PER_MOVE_ROAD : TANKER_CARRY_PER_MOVE_PLAIN;

  let carryParts = 0;
  let moveParts = 0;
  let cost = 0;

  // Build incrementally up to required carry or energy limit
  while (carryParts < requiredCarry) {
    // Add CARRY parts up to the ratio before adding MOVE
    let addedCarry = 0;
    while (addedCarry < carryPerMove && carryParts < requiredCarry) {
      const carryCost = PART_COSTS[CARRY];
      if (cost + carryCost > energyCapacity) break;
      if (carryParts + moveParts + 1 > MAX_BODY_PARTS) break;

      carryParts++;
      cost += carryCost;
      addedCarry++;
    }

    if (addedCarry === 0) break;

    // Add MOVE part
    const moveCost = PART_COSTS[MOVE];
    if (cost + moveCost <= energyCapacity && carryParts + moveParts + 1 <= MAX_BODY_PARTS) {
      moveParts++;
      cost += moveCost;
    }
  }

  // Ensure at least minimum viable
  if (carryParts === 0 && energyCapacity >= minEnergy) {
    carryParts = 1;
    moveParts = 1;
    cost = minEnergy;
  }

  // A creep with zero MOVE parts cannot move at all - it is dead weight. With a
  // CARRY-heavy ratio it is easy for the budget to be fully spent on CARRY
  // before any MOVE is added, so guarantee at least one MOVE: add one if there
  // is spare energy/part-slot, otherwise trade the last CARRY for it (same cost).
  if (moveParts === 0 && carryParts > 0) {
    if (cost + PART_COSTS[MOVE] <= energyCapacity && carryParts + 1 <= MAX_BODY_PARTS) {
      moveParts = 1;
      cost += PART_COSTS[MOVE];
    } else {
      carryParts -= 1;
      moveParts = 1;
      cost = cost - PART_COSTS[CARRY] + PART_COSTS[MOVE];
    }
  }

  // Build body array (CARRY first, then MOVE for damage resistance)
  const body: BodyPartConstant[] = [];
  for (let i = 0; i < carryParts; i++) {
    body.push(CARRY);
  }
  for (let i = 0; i < moveParts; i++) {
    body.push(MOVE);
  }

  return { body, cost, carryCapacity: carryParts * CARRY_CAPACITY };
}

/**
 * Result of an upgrader body calculation.
 */
export interface UpgraderBodyResult {
  /** The body parts array to pass to spawnCreep */
  body: BodyPartConstant[];
  /** Total energy cost of this body */
  cost: number;
  /** Number of WORK parts in this body */
  workParts: number;
  /** Energy consumption per tick (1 per WORK part) */
  energyPerTick: number;
}

/**
 * Upgrader energy-supply strategy. This is an EXPLICIT choice the corp makes and
 * threads through to body construction, so a creep's shape always matches how it
 * will be fed:
 *
 * - "mobile": there is no buffer at the controller. The upgrader has to hold a
 *   meaningful reserve and/or fetch energy between intermittent hauler drops, so
 *   it is built CARRY-heavier (the 2W/1C/1M unit) to self-buffer.
 * - "containerFed": a container/link sits at the controller and refills the
 *   creep every tick, so CARRY beyond a single part is wasted. Build it
 *   WORK-heavy to convert as much of the buffered energy as possible.
 */
export type UpgraderStrategy = "mobile" | "containerFed";

/**
 * Builds an optimal upgrader body given energy capacity and throughput.
 *
 * Upgraders need WORK parts for upgrading, CARRY for holding energy,
 * and MOVE for getting to the controller.
 *
 * The body SHAPE depends on the supply strategy (see {@link UpgraderStrategy}):
 * "mobile" packs the CARRY-heavier 2W/1C/1M unit; "containerFed" goes WORK-heavy
 * (one CARRY + one MOVE reserved, the rest WORK, a MOVE per 4 WORK) because a
 * buffer at its feet refills it each tick.
 *
 * @param energyCapacity - Available energy capacity (room.energyCapacityAvailable)
 * @param maxWorkParts - Maximum WORK parts to include (limits energy consumption)
 * @param strategy - How the upgrader will be fed (defaults to "mobile")
 * @returns Body configuration with body array, cost, and work parts
 */
export function buildUpgraderBody(
  energyCapacity: number,
  maxWorkParts = 10,
  strategy: UpgraderStrategy = "mobile"
): UpgraderBodyResult {
  // Minimum viable upgrader: 1 WORK + 1 CARRY + 1 MOVE = 200 energy
  const minEnergy = PART_COSTS[WORK] + PART_COSTS[CARRY] + PART_COSTS[MOVE];
  if (energyCapacity < minEnergy) {
    return { body: [], cost: 0, workParts: 0, energyPerTick: 0 };
  }

  let workParts = 0;
  let carryParts = 0;
  let moveParts = 0;
  let cost = 0;

  if (strategy === "containerFed") {
    // WORK-heavy: reserve one CARRY (to hold the tick's withdrawal) and one MOVE
    // (the one-time walk to the controller), then spend everything else on WORK,
    // adding a MOVE per 4 WORK so relocating isn't unbearably slow. This packs the
    // budget far better than the 2W/1C/1M unit, which at 550 capacity could only
    // afford ONE unit (2 WORK, 250 wasted); here 550 yields 4 WORK.
    carryParts = 1;
    moveParts = 1;
    cost = PART_COSTS[CARRY] + PART_COSTS[MOVE];
    while (workParts < maxWorkParts) {
      if (cost + PART_COSTS[WORK] > energyCapacity) break;
      if (workParts + carryParts + moveParts + 1 > MAX_BODY_PARTS) break;
      workParts += 1;
      cost += PART_COSTS[WORK];
      if (
        workParts % 4 === 0 &&
        cost + PART_COSTS[MOVE] <= energyCapacity &&
        workParts + carryParts + moveParts + 1 <= MAX_BODY_PARTS
      ) {
        moveParts += 1;
        cost += PART_COSTS[MOVE];
      }
    }
  } else {
    // Mobile: CARRY-heavier 2 WORK + 1 CARRY + 1 MOVE unit (300 cost). The CARRY
    // holds 50 energy so the creep keeps upgrading between intermittent deliveries.
    const unitCost = 2 * PART_COSTS[WORK] + PART_COSTS[CARRY] + PART_COSTS[MOVE]; // 300
    const workPerUnit = 2;
    while (workParts + workPerUnit <= maxWorkParts) {
      if (cost + unitCost > energyCapacity) break;
      if (workParts + carryParts + moveParts + 4 > MAX_BODY_PARTS) break;
      workParts += workPerUnit;
      carryParts += 1;
      moveParts += 1;
      cost += unitCost;
    }
  }

  // If we couldn't afford a full unit, try the minimum viable body
  if (workParts === 0 && energyCapacity >= minEnergy) {
    workParts = 1;
    carryParts = 1;
    moveParts = 1;
    cost = minEnergy;
  }

  // Build the body array
  const body: BodyPartConstant[] = [];
  for (let i = 0; i < workParts; i++) {
    body.push(WORK);
  }
  for (let i = 0; i < carryParts; i++) {
    body.push(CARRY);
  }
  for (let i = 0; i < moveParts; i++) {
    body.push(MOVE);
  }

  return { body, cost, workParts, energyPerTick: workParts };
}

/**
 * Result of building a reserver body.
 */
export interface ReserverBodyResult {
  body: BodyPartConstant[];
  cost: number;
  /** Number of CLAIM parts (reservation gained per tick while reserving). */
  claimParts: number;
}

/**
 * Build a reserver body: CLAIM parts (to reserve a remote controller) paired 1:1
 * with MOVE so it can reach the controller. A single CLAIM held continuously
 * keeps a controller reserved (and its sources at the full 3000 cap); more CLAIM
 * builds the reservation buffer up faster so a brief gap between reservers does
 * not let it lapse. CLAIM is expensive (600), so the count is capped both by the
 * room's energy and by `maxClaim` (2 is plenty for a single remote room).
 *
 * @param energyCapacity - Available spawn energy capacity.
 * @param maxClaim - Upper bound on CLAIM parts (default 2).
 */
export function buildReserverBody(energyCapacity: number, maxClaim = 2): ReserverBodyResult {
  const unitCost = PART_COSTS[CLAIM] + PART_COSTS[MOVE]; // 650 per CLAIM+MOVE pair
  const affordable = Math.floor(energyCapacity / unitCost);
  const claimParts = Math.max(0, Math.min(maxClaim, affordable, Math.floor(MAX_BODY_PARTS / 2)));
  if (claimParts === 0) {
    return { body: [], cost: 0, claimParts: 0 };
  }
  const body: BodyPartConstant[] = [];
  for (let i = 0; i < claimParts; i++) body.push(CLAIM);
  for (let i = 0; i < claimParts; i++) body.push(MOVE);
  return { body, cost: claimParts * unitCost, claimParts };
}

/** Result of building a raid-guard body. */
export interface GuardBodyResult {
  body: BodyPartConstant[];
  cost: number;
  attackParts: number;
}

/**
 * Raid-guard body (spec 13 phase 3): a small ATTACK/MOVE melee sized from the
 * ENGINE'S OWN raid table, not from an estimator - reserved/unowned rooms
 * (all our remotes) only ever face 10-part "small" invaders (1000 hits, <=T1
 * boosts, ~90% solo). 5xATTACK/5xMOVE (650) out-damages every small template
 * including a boosted healer (150 dps > 120 hps); the floor is 3 pairs (390)
 * - below that the guard trades too slowly to win before taking lethal
 * return fire. ATTACK parts first so MOVE survives longest (a wounded guard
 * stays mobile).
 */
export function buildGuardBody(energyCapacity: number, maxAttack = 5): GuardBodyResult {
  const unitCost = PART_COSTS[ATTACK] + PART_COSTS[MOVE]; // 130 per ATTACK+MOVE pair
  const affordable = Math.floor(energyCapacity / unitCost);
  const attackParts = Math.min(maxAttack, affordable);
  if (attackParts < 3) {
    return { body: [], cost: 0, attackParts: 0 };
  }
  const body: BodyPartConstant[] = [];
  for (let i = 0; i < attackParts; i++) body.push(ATTACK);
  for (let i = 0; i < attackParts; i++) body.push(MOVE);
  return { body, cost: attackParts * unitCost, attackParts };
}
