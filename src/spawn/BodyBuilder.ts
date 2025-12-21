/**
 * @fileoverview Body building utilities for creeps.
 *
 * Calculates optimal creep bodies based on desired parts and available
 * energy capacity. Enables dynamic scaling of creep size as extensions
 * are built.
 *
 * @module spawn/BodyBuilder
 */

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

/** Cost of each body part type */
const PART_COSTS: Record<BodyPartConstant, number> = {
  [WORK]: 100,
  [CARRY]: 50,
  [MOVE]: 50,
  [ATTACK]: 80,
  [RANGED_ATTACK]: 150,
  [HEAL]: 250,
  [CLAIM]: 600,
  [TOUGH]: 10,
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
 * At RCL 4 (800 energy): [WORK x5, MOVE x3] = 650 cost, 5 WORK
 * At RCL 7 (5600 energy): [WORK x5, MOVE x3] = 650 cost, 5 WORK (capped for full harvest)
 *
 * @param desiredWork - Number of WORK parts desired (typically 5 for full harvest)
 * @param energyCapacity - Available energy capacity (room.energyCapacityAvailable)
 * @returns Body configuration with body array, cost, and actual work parts
 */
export function buildMinerBody(
  desiredWork: number,
  energyCapacity: number
): BodyResult {
  // Minimum viable miner: 1 WORK + 1 MOVE = 150 energy
  const minEnergy = PART_COSTS[WORK] + PART_COSTS[MOVE];
  if (energyCapacity < minEnergy) {
    return { body: [], cost: 0, workParts: 0 };
  }

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
    const needsMove = (workParts + 1) > moveParts * 2;
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
  for (let i = 0; i < moveParts; i++) {
    body.push(MOVE);
  }

  return { body, cost, workParts };
}

/**
 * Calculates how many creeps are needed to fulfill a WORK parts order.
 *
 * @param desiredWork - Total WORK parts needed
 * @param workPerCreep - WORK parts per creep from buildMinerBody
 * @param maxCreeps - Maximum creeps allowed (e.g., mining spots available)
 * @returns Number of creeps to spawn
 */
export function calculateCreepsNeeded(
  desiredWork: number,
  workPerCreep: number,
  maxCreeps: number
): number {
  if (workPerCreep <= 0) return 0;
  const needed = Math.ceil(desiredWork / workPerCreep);
  return Math.min(needed, maxCreeps);
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
 * Builds an optimal hauler body given energy rate and distance.
 *
 * Haulers need CARRY parts for capacity and MOVE parts for mobility.
 * The ratio is 1:1 CARRY:MOVE for full speed on roads (and plains when empty).
 *
 * The required carry capacity is calculated as:
 *   carryNeeded = energyRate * roundTripTime
 *   roundTripTime = 2 * distance (assuming 1 tile/tick movement)
 *
 * @param energyRate - Energy per tick being produced (e.g., 10 for full harvest)
 * @param distance - One-way path distance from source to delivery
 * @param energyCapacity - Available energy capacity (room.energyCapacityAvailable)
 * @returns Body configuration with body array, cost, and carry capacity
 */
export function buildHaulerBody(
  energyRate: number,
  distance: number,
  energyCapacity: number
): HaulerBodyResult {
  // Minimum viable hauler: 1 CARRY + 1 MOVE = 100 energy
  const minEnergy = PART_COSTS[CARRY] + PART_COSTS[MOVE];
  if (energyCapacity < minEnergy) {
    return { body: [], cost: 0, carryCapacity: 0 };
  }

  // Calculate required carry capacity
  // Round trip = 2 * distance ticks
  // Energy to haul = energyRate * roundTrip
  // Add 20% buffer for path variability and pickup time
  const roundTrip = 2 * distance;
  const carryNeeded = Math.ceil(energyRate * roundTrip * 1.2);

  // Each CARRY part holds 50 energy
  const CARRY_CAPACITY = 50;
  const carryPartsNeeded = Math.ceil(carryNeeded / CARRY_CAPACITY);

  // Build body with 1:1 CARRY:MOVE ratio
  let carryParts = 0;
  let moveParts = 0;
  let cost = 0;

  // Add pairs of CARRY + MOVE up to the needed amount or energy limit
  const pairCost = PART_COSTS[CARRY] + PART_COSTS[MOVE]; // 100 energy per pair

  while (carryParts < carryPartsNeeded) {
    if (cost + pairCost > energyCapacity) {
      break;
    }

    if (carryParts + moveParts + 2 > MAX_BODY_PARTS) {
      break;
    }

    carryParts++;
    moveParts++;
    cost += pairCost;
  }

  // Ensure we have at least the minimum viable hauler
  if (carryParts === 0 && energyCapacity >= minEnergy) {
    carryParts = 1;
    moveParts = 1;
    cost = minEnergy;
  }

  // Build the body array (CARRY parts first, then MOVE)
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
 * Calculates hauling requirements for a set of sources.
 *
 * @param sources - Array of { flow, distanceToSpawn } for each source
 * @returns Total carry capacity needed per trip cycle
 */
export function calculateHaulingNeeds(
  sources: { flow: number; distanceToSpawn: number }[]
): { totalCarryNeeded: number; avgDistance: number } {
  if (sources.length === 0) {
    return { totalCarryNeeded: 0, avgDistance: 0 };
  }

  let totalCarryNeeded = 0;
  let totalDistance = 0;

  for (const source of sources) {
    const roundTrip = 2 * source.distanceToSpawn;
    totalCarryNeeded += source.flow * roundTrip;
    totalDistance += source.distanceToSpawn;
  }

  return {
    totalCarryNeeded: Math.ceil(totalCarryNeeded * 1.2), // 20% buffer
    avgDistance: Math.ceil(totalDistance / sources.length),
  };
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
 * Builds an optimal upgrader body given energy capacity and throughput.
 *
 * Upgraders need WORK parts for upgrading, CARRY for holding energy,
 * and MOVE for getting to the controller.
 *
 * Pattern: 2 WORK + 1 CARRY + 1 MOVE is the efficient unit (300 cost)
 * This gives 2 upgrade work per tick, consuming 2 energy per tick.
 * The CARRY holds 50 energy, enough for 25 ticks of work.
 *
 * @param energyCapacity - Available energy capacity (room.energyCapacityAvailable)
 * @param maxWorkParts - Maximum WORK parts to include (limits energy consumption)
 * @returns Body configuration with body array, cost, and work parts
 */
export function buildUpgraderBody(
  energyCapacity: number,
  maxWorkParts: number = 10
): UpgraderBodyResult {
  // Minimum viable upgrader: 1 WORK + 1 CARRY + 1 MOVE = 200 energy
  const minEnergy = PART_COSTS[WORK] + PART_COSTS[CARRY] + PART_COSTS[MOVE];
  if (energyCapacity < minEnergy) {
    return { body: [], cost: 0, workParts: 0, energyPerTick: 0 };
  }

  // Build with pattern: 2 WORK + 1 CARRY + 1 MOVE (300 cost per unit)
  // Each unit gives 2 upgrade work per tick
  const unitCost = 2 * PART_COSTS[WORK] + PART_COSTS[CARRY] + PART_COSTS[MOVE]; // 300
  const workPerUnit = 2;

  let workParts = 0;
  let carryParts = 0;
  let moveParts = 0;
  let cost = 0;

  // Add units up to energy limit and work cap
  while (workParts + workPerUnit <= maxWorkParts) {
    if (cost + unitCost > energyCapacity) {
      break;
    }

    if (workParts + carryParts + moveParts + 4 > MAX_BODY_PARTS) {
      break;
    }

    workParts += workPerUnit;
    carryParts += 1;
    moveParts += 1;
    cost += unitCost;
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
