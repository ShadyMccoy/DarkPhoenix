/**
 * @fileoverview Economic constants and calculations for abstract planning.
 *
 * These values are hardcoded based on Screeps game mechanics but are
 * decoupled from the Game API to enable unit testing without a live game.
 *
 * Key concepts:
 * - Energy is "free" at the source, but harvesting costs body parts and travel time
 * - Creep cost per energy = spawn cost / total energy harvested over lifetime
 * - Travel time reduces effective work time, making remote mining more expensive
 */

import { Position } from "../types/Position";

/**
 * Body part types used in creep design
 */
export type BodyPart =
  | "work"
  | "carry"
  | "move"
  | "attack"
  | "ranged_attack"
  | "heal"
  | "claim"
  | "tough";

/**
 * Energy cost per body part (Screeps constants)
 */
export const BODY_PART_COST: Record<BodyPart, number> = {
  work: 100,
  carry: 50,
  move: 50,
  attack: 80,
  ranged_attack: 150,
  heal: 250,
  claim: 600,
  tough: 10
};

/**
 * Creep lifetime in ticks (Screeps constant)
 */
export const CREEP_LIFETIME = 1500;

/**
 * Energy harvested per WORK part per tick (Screeps constant)
 */
export const HARVEST_RATE = 2;

/**
 * Energy capacity per CARRY part (Screeps constant)
 */
export const CARRY_CAPACITY = 50;

/**
 * Ticks to spawn one body part (Screeps constant)
 */
export const SPAWN_TIME_PER_PART = 3;

/**
 * Source regeneration time in ticks (Screeps constant)
 */
export const SOURCE_REGEN_TIME = 300;

/**
 * Source energy capacity in claimed rooms (Screeps constant)
 */
export const SOURCE_ENERGY_CAPACITY = 3000;

/**
 * Source energy capacity in unclaimed/unowned rooms (Screeps constant)
 */
export const SOURCE_ENERGY_CAPACITY_UNCLAIMED = 1500;

/**
 * Source energy per tick in claimed rooms (capacity / regen time)
 */
export const SOURCE_ENERGY_PER_TICK = SOURCE_ENERGY_CAPACITY / SOURCE_REGEN_TIME; // 10 energy/tick

/**
 * Planning epoch duration in ticks.
 * This is the time horizon for economic planning and offer calculations.
 */
export const PLANNING_EPOCH = 5000;

/**
 * Parse room name to get coordinates.
 * Returns {x, y} where W/S are negative, E/N are positive.
 */
export function parseRoomCoords(roomName: string): { rx: number; ry: number } | null {
  const match = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
  if (!match) return null;

  const [, ew, ewNum, ns, nsNum] = match;
  const rx = ew === "W" ? -(parseInt(ewNum, 10) + 1) : parseInt(ewNum, 10);
  const ry = ns === "N" ? -(parseInt(nsNum, 10) + 1) : parseInt(nsNum, 10);

  return { rx, ry };
}

/**
 * Calculate Manhattan distance between two positions.
 * For same-room positions, this is the simple dx + dy.
 * For cross-room positions, we estimate based on room distance.
 */
export function calculateTravelTime(from: Position, to: Position): number {
  if (from.roomName === to.roomName) {
    // Same room - simple Manhattan distance
    return Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
  }

  // Cross-room distance
  const fromCoords = parseRoomCoords(from.roomName);
  const toCoords = parseRoomCoords(to.roomName);

  if (!fromCoords || !toCoords) {
    // Invalid room names - return large distance
    return Infinity;
  }

  // Room distance in tiles (50 tiles per room boundary)
  const roomDx = Math.abs(toCoords.rx - fromCoords.rx);
  const roomDy = Math.abs(toCoords.ry - fromCoords.ry);
  const roomDistance = (roomDx + roomDy) * 50;

  // Add in-room position offset
  // When crossing rooms, we approximate the path
  const inRoomDistance = Math.abs(from.x - to.x) + Math.abs(from.y - to.y);

  return roomDistance + inRoomDistance;
}

/**
 * Calculate effective work time for a creep.
 * This is the total lifetime minus travel time to the work location.
 *
 * @param spawnLocation - Where the creep is spawned
 * @param workLocation - Where the creep will work
 * @param creepLifetime - Optional custom lifetime (default: CREEP_LIFETIME)
 * @returns Effective ticks available for work
 */
export function calculateEffectiveWorkTime(
  spawnLocation: Position,
  workLocation: Position,
  creepLifetime: number = CREEP_LIFETIME
): number {
  const travelTime = calculateTravelTime(spawnLocation, workLocation);
  const effectiveTime = creepLifetime - travelTime;
  return Math.max(0, effectiveTime);
}

/**
 * Calculate the energy cost of a creep body.
 *
 * @param bodyParts - Array of body part types
 * @returns Total energy cost to spawn
 */
export function calculateBodyCost(bodyParts: BodyPart[]): number {
  return bodyParts.reduce((sum, part) => sum + BODY_PART_COST[part], 0);
}

/**
 * Count specific body parts in a body design.
 *
 * @param bodyParts - Array of body part types
 * @param partType - Type to count
 * @returns Number of that part type
 */
export function countBodyParts(bodyParts: BodyPart[], partType: BodyPart): number {
  return bodyParts.filter((p) => p === partType).length;
}

/**
 * Calculate total energy a mining creep will harvest over its effective lifetime.
 *
 * @param workParts - Number of WORK parts
 * @param effectiveLifetime - Ticks available for harvesting
 * @returns Total energy harvested
 */
export function calculateTotalHarvest(workParts: number, effectiveLifetime: number): number {
  return workParts * HARVEST_RATE * effectiveLifetime;
}

/**
 * Calculate the cost per energy unit for a mining creep.
 * This represents how much it "costs" to produce 1 energy.
 *
 * @param bodyParts - The creep's body design
 * @param spawnLocation - Where the creep is spawned
 * @param workLocation - Where the creep will harvest
 * @returns Cost per energy unit (spawn cost / total harvest)
 */
export function calculateCreepCostPerEnergy(
  bodyParts: BodyPart[],
  spawnLocation: Position,
  workLocation: Position
): number {
  const spawnCost = calculateBodyCost(bodyParts);
  const effectiveLifetime = calculateEffectiveWorkTime(spawnLocation, workLocation);

  if (effectiveLifetime <= 0) {
    return Infinity; // No effective work time = infinite cost
  }

  const workParts = countBodyParts(bodyParts, "work");
  if (workParts === 0) {
    return Infinity; // No work parts = can't harvest
  }

  const totalHarvest = calculateTotalHarvest(workParts, effectiveLifetime);
  if (totalHarvest <= 0) {
    return Infinity;
  }

  return spawnCost / totalHarvest;
}

/**
 * Design a simple mining creep body.
 * Uses a basic ratio of 1 WORK : 1 CARRY : 1 MOVE per unit.
 *
 * @param workPartsNeeded - Number of WORK parts required
 * @returns Body part array
 */
export function designMiningCreep(workPartsNeeded: number): BodyPart[] {
  const body: BodyPart[] = [];
  for (let i = 0; i < workPartsNeeded; i++) {
    body.push("work", "carry", "move");
  }
  return body;
}

/**
 * Calculate optimal work parts needed to fully harvest a source.
 * Based on source capacity and regen time.
 *
 * @param sourceCapacity - Energy capacity of the source (default: 3000)
 * @param regenTime - Ticks between regenerations (default: 300)
 * @returns Number of work parts needed
 */
export function calculateOptimalWorkParts(
  sourceCapacity: number = SOURCE_ENERGY_CAPACITY,
  regenTime: number = SOURCE_REGEN_TIME
): number {
  const energyPerTick = sourceCapacity / regenTime;
  return Math.ceil(energyPerTick / HARVEST_RATE);
}

/**
 * Calculate spawn time for a creep body.
 *
 * @param bodyParts - Array of body part types
 * @returns Ticks needed to spawn
 */
export function calculateSpawnTime(bodyParts: BodyPart[]): number {
  return bodyParts.length * SPAWN_TIME_PER_PART;
}

/**
 * Maximum spawn energy capacity by room controller level.
 * This is the maximum capacity when all spawns and extensions are built.
 *
 * Calculations:
 * - RCL 1: 1 spawn × 300 = 300
 * - RCL 2: 1 spawn × 300 + 5 extensions × 50 = 550
 * - RCL 3: 1 spawn × 300 + 10 extensions × 50 = 800
 * - RCL 4: 1 spawn × 300 + 20 extensions × 50 = 1300
 * - RCL 5: 1 spawn × 300 + 30 extensions × 50 = 1800
 * - RCL 6: 1 spawn × 300 + 40 extensions × 50 = 2300
 * - RCL 7: 2 spawns × 300 + 50 extensions × 100 = 5600
 * - RCL 8: 3 spawns × 300 + 60 extensions × 200 = 12900
 */
export const MAX_SPAWN_CAPACITY_BY_RCL: Record<number, number> = {
  1: 300,
  2: 550,
  3: 800,
  4: 1300,
  5: 1800,
  6: 2300,
  7: 5600,
  8: 12900,
};

/**
 * Get the maximum spawn energy capacity for a room's controller level.
 * This returns the maximum possible capacity when all extensions are built,
 * rather than the current capacity. Use this when planning creep sizes to
 * ensure creeps are designed for full capacity even while building up.
 *
 * @param controllerLevel - The room's controller level (1-8)
 * @returns Maximum energy capacity for spawning
 */
export function getMaxSpawnCapacity(controllerLevel: number): number {
  if (controllerLevel < 1) return 300;
  if (controllerLevel > 8) return MAX_SPAWN_CAPACITY_BY_RCL[8];
  return MAX_SPAWN_CAPACITY_BY_RCL[controllerLevel] ?? 300;
}
