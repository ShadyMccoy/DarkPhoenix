/**
 * @fileoverview Flow-based edge model for colony economy.
 *
 * Models the colony as a flow network where:
 * - Nodes are sources (supply), spawns (transform), and projects (demand)
 * - Edges carry energy flow with associated costs
 *
 * The key challenge is the bootstrap problem:
 * - Carrying energy requires creeps → creeps require spawning → spawning requires energy
 *
 * This is solved by finding a flow equilibrium where:
 * - Total energy produced >= Total energy consumed (mining + hauling + projects)
 *
 * Edge Types:
 * - SupplyEdge: Source → Spawn (miner assignment, weight = mining cost)
 * - CarryEdge: Node → Node (hauling capacity, weight = carry cost per energy)
 * - SpawnEdge: Spawn → internal (spawn capacity allocation)
 *
 * @module framework/FlowEdge
 */

import { Position } from "../market/Offer";

/**
 * Base interface for all flow edges.
 */
export interface FlowEdge {
  /** Unique edge identifier */
  id: string;

  /** Source node ID */
  fromNodeId: string;

  /** Target node ID */
  toNodeId: string;

  /** Edge type discriminator */
  type: FlowEdgeType;

  /** Flow capacity (units per tick, 0 = unlimited) */
  capacity: number;

  /** Cost per unit of flow (energy cost) */
  costPerUnit: number;

  /** Current allocated flow */
  allocatedFlow: number;
}

export type FlowEdgeType = "supply" | "carry" | "spawn" | "project";

/**
 * Supply edge: Source → Spawn
 *
 * Represents a miner assignment to a source.
 * The spawn node "pays" for the miner (spawn cost + work parts).
 * The source node "produces" energy (capacity - mining cost = net supply).
 */
export interface SupplyEdge extends FlowEdge {
  type: "supply";

  /** Source game object ID */
  sourceId: string;

  /** Spawn game object ID responsible for this miner */
  spawnId: string;

  /** Source position for distance calculations */
  sourcePosition: Position;

  /** Energy capacity of the source (per regen cycle, typically 3000) */
  sourceCapacity: number;

  /** Miner body cost (energy to spawn the miner) */
  minerSpawnCost: number;

  /** Work parts on the miner */
  minerWorkParts: number;

  /** Miner lifetime in ticks */
  minerLifetime: number;

  /** Distance from spawn to source (affects replacement timing) */
  spawnToSourceDistance: number;
}

/**
 * Carry edge: Node → Node
 *
 * Represents hauling capacity between two nodes.
 * Cost includes: hauler spawn cost amortized over lifetime + distance factor.
 */
export interface CarryEdge extends FlowEdge {
  type: "carry";

  /** Spawn responsible for this hauler */
  spawnId: string;

  /** Hauler body cost */
  haulerSpawnCost: number;

  /** Carry capacity per hauler */
  haulerCarryCapacity: number;

  /** Hauler lifetime in ticks */
  haulerLifetime: number;

  /** One-way walking distance between nodes */
  walkingDistance: number;

  /** Round-trip time (2 * distance + loading/unloading) */
  roundTripTicks: number;
}

/**
 * Spawn edge: Internal spawn capacity allocation
 *
 * Represents how spawn time is allocated between different uses:
 * - Mining (producing miners)
 * - Hauling (producing haulers)
 * - Projects (producing workers)
 */
export interface SpawnEdge extends FlowEdge {
  type: "spawn";

  /** Spawn game object ID */
  spawnId: string;

  /** Spawn position */
  spawnPosition: Position;

  /** Total spawn capacity (energy per tick, accounting for spawn time) */
  spawnCapacity: number;

  /** What this spawn capacity is allocated to */
  allocation: SpawnAllocation;
}

export type SpawnAllocation = "mining" | "hauling" | "project" | "unallocated";

/**
 * Project edge: Spawn → Project
 *
 * Represents energy flow to a project (upgrading, building, etc.)
 * This is the "demand" side of the economy.
 */
export interface ProjectEdge extends FlowEdge {
  type: "project";

  /** Project type */
  projectType: ProjectType;

  /** Target game object ID (controller, construction site, etc.) */
  targetId: string;

  /** Target position */
  targetPosition: Position;

  /** Energy value produced per energy consumed (ROI factor) */
  valuePerEnergy: number;
}

export type ProjectType = "upgrade" | "build" | "repair" | "fortify";

/**
 * Creates a unique edge ID.
 */
export function createFlowEdgeId(
  type: FlowEdgeType,
  fromNodeId: string,
  toNodeId: string,
  suffix?: string
): string {
  const base = `${type}:${fromNodeId}→${toNodeId}`;
  return suffix ? `${base}:${suffix}` : base;
}

/**
 * Calculates the net energy production of a supply edge.
 *
 * Net = (energy harvested during effective mining time) - (miner spawn cost)
 *
 * Effective mining time = lifetime - travel time to source
 *
 * The miner must walk from spawn to source before it can start mining.
 * This travel time is "lost" productivity.
 *
 * Example: 65 tiles away, 10 energy/tick harvest rate
 *   - Travel time: 65 ticks
 *   - Lost energy: 65 * 10 = 650 energy
 *   - Effective cost: 650 spawn + 650 travel = 1300
 *   - Net: 15000 - 1300 = 13700 (91.3% efficiency)
 */
export function calculateSupplyEdgeNetEnergy(edge: SupplyEdge): number {
  // Energy harvested per WORK part per tick
  const harvestRate = edge.minerWorkParts * 2;

  // Travel time to reach the source (assume 1 tile/tick with roads)
  const travelTime = edge.spawnToSourceDistance;

  // Effective mining time after travel
  const effectiveMiningTime = Math.max(0, edge.minerLifetime - travelTime);

  // Source regenerates every 300 ticks with sourceCapacity energy
  // Calculate regen cycles during effective mining time
  const regenCycles = Math.floor(effectiveMiningTime / 300);
  const maxFromSource = edge.sourceCapacity * regenCycles;

  // Max energy the miner can harvest during effective time
  const maxFromMiner = harvestRate * effectiveMiningTime;

  const energyHarvested = Math.min(maxFromSource, maxFromMiner);

  // Net = harvested - spawn cost
  return energyHarvested - edge.minerSpawnCost;
}

/**
 * Calculates the effective mining time after travel.
 */
export function calculateEffectiveMiningTime(edge: SupplyEdge): number {
  return Math.max(0, edge.minerLifetime - edge.spawnToSourceDistance);
}

/**
 * Calculates the energy lost to travel time.
 */
export function calculateTravelTimeLoss(edge: SupplyEdge): number {
  const harvestRate = edge.minerWorkParts * 2;
  const sourceRateLimit = edge.sourceCapacity / 300;
  const effectiveRate = Math.min(harvestRate, sourceRateLimit);
  return edge.spawnToSourceDistance * effectiveRate;
}

/**
 * Calculates the net energy per tick of a supply edge.
 */
export function calculateSupplyEdgeNetPerTick(edge: SupplyEdge): number {
  return calculateSupplyEdgeNetEnergy(edge) / edge.minerLifetime;
}

/**
 * Calculates the throughput of a carry edge (energy per tick).
 *
 * Throughput = (carry capacity * trips per lifetime) / lifetime
 *            = carry capacity / round trip time
 *
 * But we also need to subtract the spawn cost amortized over lifetime.
 */
export function calculateCarryEdgeThroughput(edge: CarryEdge): number {
  // Raw throughput: how much energy can be moved per tick
  const tripsPerLifetime = Math.floor(edge.haulerLifetime / edge.roundTripTicks);
  const totalCarried = edge.haulerCarryCapacity * tripsPerLifetime;

  return totalCarried / edge.haulerLifetime;
}

/**
 * Calculates the cost per energy unit for a carry edge.
 *
 * Cost = hauler spawn cost / total energy carried over lifetime
 */
export function calculateCarryEdgeCostPerEnergy(edge: CarryEdge): number {
  const tripsPerLifetime = Math.floor(edge.haulerLifetime / edge.roundTripTicks);
  const totalCarried = edge.haulerCarryCapacity * tripsPerLifetime;

  if (totalCarried === 0) return Infinity;

  return edge.haulerSpawnCost / totalCarried;
}

/**
 * Calculates the net efficiency of a carry edge.
 *
 * For every 1 energy we want to deliver, how much total energy does it cost?
 * Efficiency = 1 / (1 + costPerEnergy)
 *
 * Example: if costPerEnergy = 0.1, efficiency = 0.91 (91% of energy arrives)
 */
export function calculateCarryEdgeEfficiency(edge: CarryEdge): number {
  const costPerEnergy = calculateCarryEdgeCostPerEnergy(edge);
  if (costPerEnergy === Infinity) return 0;
  return 1 / (1 + costPerEnergy);
}

/**
 * Standard creep body costs for calculations.
 */
export const BODY_PART_COSTS = {
  move: 50,
  work: 100,
  carry: 50,
  attack: 80,
  ranged_attack: 150,
  heal: 250,
  claim: 600,
  tough: 10,
};

/**
 * Calculates spawn cost for a miner body.
 * Standard miner: 5 WORK + 1 MOVE = 550 energy
 */
export function calculateMinerSpawnCost(workParts: number): number {
  // Assume 1 MOVE per 2 WORK for miners (they stay stationary)
  const moveParts = Math.ceil(workParts / 2);
  return workParts * BODY_PART_COSTS.work + moveParts * BODY_PART_COSTS.move;
}

/**
 * Calculates spawn cost for a hauler body.
 * Standard ratio: 1 CARRY + 1 MOVE per segment
 */
export function calculateHaulerSpawnCost(carryParts: number): number {
  // 1:1 CARRY:MOVE ratio for roads/plains balance
  return carryParts * (BODY_PART_COSTS.carry + BODY_PART_COSTS.move);
}

/**
 * Calculates optimal miner size for a source.
 *
 * @param sourceCapacity - Energy per regen (typically 3000)
 * @param regenPeriod - Ticks between regen (typically 300)
 * @returns Optimal number of WORK parts
 */
export function calculateOptimalMinerSize(
  sourceCapacity: number = 3000,
  regenPeriod: number = 300
): number {
  // Energy per tick needed to fully harvest
  const energyPerTick = sourceCapacity / regenPeriod; // 10 for standard source

  // Each WORK harvests 2 energy per tick
  const workPartsNeeded = Math.ceil(energyPerTick / 2); // 5 for standard source

  return workPartsNeeded;
}

/**
 * Creates a supply edge from a source to a spawn.
 */
export function createSupplyEdge(params: {
  sourceId: string;
  sourceNodeId: string;
  sourcePosition: Position;
  sourceCapacity: number;
  spawnId: string;
  spawnNodeId: string;
  spawnToSourceDistance: number;
  minerWorkParts?: number;
  minerLifetime?: number;
}): SupplyEdge {
  const workParts = params.minerWorkParts ?? calculateOptimalMinerSize(params.sourceCapacity);
  const spawnCost = calculateMinerSpawnCost(workParts);
  const lifetime = params.minerLifetime ?? 1500;

  return {
    id: createFlowEdgeId("supply", params.sourceNodeId, params.spawnNodeId, params.sourceId),
    fromNodeId: params.sourceNodeId,
    toNodeId: params.spawnNodeId,
    type: "supply",
    capacity: params.sourceCapacity / 300, // per tick capacity
    costPerUnit: spawnCost / (params.sourceCapacity * (lifetime / 300)), // cost per energy
    allocatedFlow: 0,
    sourceId: params.sourceId,
    spawnId: params.spawnId,
    sourcePosition: params.sourcePosition,
    sourceCapacity: params.sourceCapacity,
    minerSpawnCost: spawnCost,
    minerWorkParts: workParts,
    minerLifetime: lifetime,
    spawnToSourceDistance: params.spawnToSourceDistance,
  };
}

/**
 * Creates a carry edge between two nodes.
 */
export function createCarryEdge(params: {
  fromNodeId: string;
  toNodeId: string;
  spawnId: string;
  walkingDistance: number;
  haulerCarryParts?: number;
  haulerLifetime?: number;
}): CarryEdge {
  const carryParts = params.haulerCarryParts ?? 10;
  const spawnCost = calculateHaulerSpawnCost(carryParts);
  const lifetime = params.haulerLifetime ?? 1500;
  const carryCapacity = carryParts * 50;

  // Round trip = 2 * distance + ~10 ticks for pickup/dropoff
  const roundTrip = params.walkingDistance * 2 + 10;

  const edge: CarryEdge = {
    id: createFlowEdgeId("carry", params.fromNodeId, params.toNodeId),
    fromNodeId: params.fromNodeId,
    toNodeId: params.toNodeId,
    type: "carry",
    capacity: 0, // Will be calculated
    costPerUnit: 0, // Will be calculated
    allocatedFlow: 0,
    spawnId: params.spawnId,
    haulerSpawnCost: spawnCost,
    haulerCarryCapacity: carryCapacity,
    haulerLifetime: lifetime,
    walkingDistance: params.walkingDistance,
    roundTripTicks: roundTrip,
  };

  // Calculate derived values
  edge.capacity = calculateCarryEdgeThroughput(edge);
  edge.costPerUnit = calculateCarryEdgeCostPerEnergy(edge);

  return edge;
}
