/**
 * @fileoverview Pure projection functions for computing corp offers.
 *
 * These functions take CorpState and compute what the corp will buy and sell.
 * All calculations use EconomicConstants.ts as the single source of truth.
 *
 * Key principle: Projections are stateless computations, not cached state.
 *
 * @module planning/projections
 */

import { Offer, createOfferId } from "../market/Offer";
import {
  SourceCorpState,
  MiningCorpState,
  SpawningCorpState,
  UpgradingCorpState,
  HaulingCorpState,
  AnyCorpState,
  getCorpPosition
} from "../corps/CorpState";
import {
  calculateOptimalWorkParts,
  calculateEffectiveWorkTime,
  designMiningCreep,
  calculateBodyCost,
  calculateTravelTime,
  HARVEST_RATE,
  CREEP_LIFETIME,
  BODY_PART_COST,
  CARRY_CAPACITY
} from "./EconomicConstants";
import { calculateMargin, SerializedCorp } from "../corps/Corp";
import { isActive, remainingQuantity } from "../market/Contract";

/**
 * Calculate committed sell quantity for a resource from contracts.
 * This is the remaining quantity to deliver on active sell contracts.
 */
function getCommittedSellQuantity(state: SerializedCorp, resource: string, tick: number): number {
  return (state.contracts || [])
    .filter(c => c.sellerId === state.id && c.resource === resource && isActive(c, tick))
    .reduce((sum, c) => sum + remainingQuantity(c), 0);
}

/**
 * Projection result - buy and sell offers for a corp
 */
export interface CorpProjection {
  buys: Offer[];
  sells: Offer[];
}

/**
 * Empty projection for corps that don't participate in the market
 */
const EMPTY_PROJECTION: CorpProjection = { buys: [], sells: [] };

// =============================================================================
// Source Projection
// =============================================================================

/**
 * Calculate offers for a source corp.
 *
 * Source corps are PASSIVE:
 * - Buy: nothing
 * - Sell: energy-source (access to harvest from this source)
 *
 * The source is free to access - value is created when energy is harvested.
 */
export function projectSource(state: SourceCorpState, tick: number): CorpProjection {
  return {
    buys: [],
    sells: [
      {
        id: createOfferId(state.id, "energy-source", tick),
        corpId: state.id,
        type: "sell",
        resource: "energy-source",
        quantity: state.energyCapacity,
        price: 0, // Free resource - cost is in mining
        duration: 300, // Regeneration cycle
        location: state.position
      }
    ]
  };
}

// =============================================================================
// Mining Projection
// =============================================================================

/** Minimum price floor to prevent selling at 0 */
const MIN_ENERGY_PRICE = 0.05;

/**
 * Calculate offers for a mining corp.
 *
 * Mining corps:
 * - Buy: spawn-capacity (need miners continuously supplied)
 * - Sell: energy at source location
 *
 * The spawn-capacity buy is expressed as energy cost of the desired miner body.
 * Distance from spawn to source affects effective cost (travel reduces useful work time).
 *
 * Supports both planning mode (projected values) and runtime mode (actual creeps).
 * When actualWorkParts/actualTotalTTL are provided, uses actual creep data.
 * Otherwise, calculates optimal values for planning projections.
 *
 * Price is based on amortized spawn cost over effective lifetime.
 */
export function projectMining(state: MiningCorpState, tick: number): CorpProjection {
  // Use actual values if available (runtime), otherwise calculate optimal (planning)
  const isRuntime = state.actualWorkParts !== undefined && state.actualTotalTTL !== undefined;

  let expectedOutput: number;
  let workParts: number;

  if (isRuntime && state.activeCreepCount && state.activeCreepCount > 0) {
    // Runtime mode: use actual creep data
    workParts = state.actualWorkParts!;
    const avgTTL = state.actualTotalTTL! / state.activeCreepCount;
    expectedOutput = workParts * HARVEST_RATE * avgTTL;

    // Subtract already-committed energy from active sell contracts
    const committedEnergy = getCommittedSellQuantity(state, "energy", tick);
    expectedOutput = Math.max(0, expectedOutput - committedEnergy);
  } else if (isRuntime) {
    // Runtime mode but no active creeps
    return { buys: [], sells: [] };
  } else {
    // Planning mode: calculate optimal values
    workParts = calculateOptimalWorkParts(state.sourceCapacity);
    const effectiveLifetime = state.spawnPosition
      ? calculateEffectiveWorkTime(state.spawnPosition, state.position)
      : CREEP_LIFETIME;
    expectedOutput = workParts * HARVEST_RATE * effectiveLifetime;
  }

  if (expectedOutput <= 0) {
    return { buys: [], sells: [] };
  }

  // Calculate miner body cost (what we need to buy from spawn)
  const body = designMiningCreep(workParts);
  const spawnCost = calculateBodyCost(body);

  // Calculate input cost for pricing (amortized spawn cost)
  const inputCostPerUnit = expectedOutput > 0 ? spawnCost / expectedOutput : 0;

  const margin = calculateMargin(state.balance);
  const calculatedPrice = inputCostPerUnit * (1 + margin);
  const sellPrice = Math.max(calculatedPrice, MIN_ENERGY_PRICE);

  return {
    buys: [
      {
        id: createOfferId(state.id, "spawn-capacity", tick),
        corpId: state.id,
        type: "buy",
        resource: "spawn-capacity",
        // Quantity = energy cost of desired miner body
        // This expresses "I need a creep that costs X energy"
        quantity: spawnCost,
        price: 0, // Price determined by spawn + distance
        duration: CREEP_LIFETIME,
        location: state.position // Work site - distance from spawn affects price
      }
    ],
    sells: [
      {
        id: createOfferId(state.id, "energy", tick),
        corpId: state.id,
        type: "sell",
        resource: "energy",
        quantity: expectedOutput,
        price: sellPrice * expectedOutput, // Total price for quantity
        duration: CREEP_LIFETIME,
        location: state.position
      }
    ]
  };
}

// =============================================================================
// Spawning Projection
// =============================================================================

/**
 * Calculate offers for a spawning corp.
 *
 * SpawningCorp is the ORIGIN of labor in production chains.
 * It sells spawn-capacity AND buys delivered-energy (for extensions).
 *
 * Key economics:
 * - Spawn sells spawn-capacity to mining/hauling/upgrading corps
 * - Spawn buys delivered-energy for refilling extensions
 * - The buy is NOT a dependency for the sell - they're parallel concerns
 * - This allows spawn to compete with upgrader for hauler services
 *
 * The spawn-capacity resource represents:
 * - Quantity: energy capacity available per spawn cycle
 * - Price: base energy cost + margin
 *
 * SpawningCorp buys: delivered-energy (for extensions refill)
 * SpawningCorp sells: spawn-capacity (creep spawning service)
 *
 * Note: The chain planner treats spawning as an "origin" - its buys
 * create separate demand chains, but don't block its spawn-capacity sells.
 */
export function projectSpawning(state: SpawningCorpState, tick: number): CorpProjection {
  // If spawn is busy or queue is full, don't offer capacity
  if (state.isSpawning || state.pendingOrderCount >= 10) {
    return { buys: [], sells: [] };
  }

  // Available capacity = energy capacity per spawn
  // This represents how big a creep the spawn can produce
  const availableCapacity = state.energyCapacity;

  // Spawn needs energy delivered to refill extensions
  // This creates demand that competes with upgrader
  const energyNeeded = availableCapacity;

  // Price is 1:1 with energy - the base cost of spawning
  // Distance penalty is applied by the chain planner when matching
  const pricePerEnergy = 1.0;

  const margin = calculateMargin(state.balance);

  return {
    buys: [
      {
        id: createOfferId(state.id, "delivered-energy", tick),
        corpId: state.id,
        type: "buy",
        resource: "delivered-energy",
        quantity: energyNeeded,
        price: 0, // Price determined by hauler's sell price
        duration: CREEP_LIFETIME,
        location: state.position
      }
    ],
    sells: [
      {
        id: createOfferId(state.id, "spawn-capacity", tick),
        corpId: state.id,
        type: "sell",
        resource: "spawn-capacity",
        quantity: availableCapacity,
        price: pricePerEnergy * availableCapacity * (1 + margin),
        duration: CREEP_LIFETIME,
        location: state.position
      }
    ]
  };
}

// =============================================================================
// Upgrading Projection
// =============================================================================

/** Large demand for upgrading - essentially "give me all you can" */
const UPGRADER_ENERGY_DEMAND = 100000;

/**
 * Calculate offers for an upgrading corp.
 *
 * Upgrading corps:
 * - Buy: delivered-energy (from haulers) - essentially unlimited demand
 * - Buy: spawn-capacity (need upgrader creeps continuously supplied)
 * - Sell: rcl-progress (controller points)
 *
 * The upgrader has large/unlimited demand for energy. The limiting factor
 * should be supply (mining + hauling capacity), not demand.
 *
 * 1 WORK part + 1 energy = 1 upgrade point per tick
 */
export function projectUpgrading(state: UpgradingCorpState, tick: number): CorpProjection {
  // Calculate effective work time for spawn-capacity needs
  const effectiveLifetime = state.spawnPosition
    ? calculateEffectiveWorkTime(state.spawnPosition, state.position)
    : CREEP_LIFETIME;

  // Upgrader wants as much energy as it can get
  // The chain planner will build multiple chains to satisfy this demand
  // until supply (mining/hauling) is exhausted
  const energyNeeded = UPGRADER_ENERGY_DEMAND;

  // RCL progress = energy consumed (1:1 ratio)
  // This will be the fulfilled amount, not the demand
  const rclProgress = energyNeeded;

  // Calculate upgrader body cost (WORK + CARRY + MOVE = 200 energy)
  // Scale spawn needs based on how much energy we expect to process
  // More energy = more upgraders needed
  const upgraderBodyCost = BODY_PART_COST.work + BODY_PART_COST.carry + BODY_PART_COST.move;

  // Need multiple upgraders to process large energy amounts
  // Rough estimate: 1 upgrader processes ~1500 energy per lifetime
  const upgradersNeeded = Math.ceil(energyNeeded / (effectiveLifetime * 1));
  const totalSpawnCapacityNeeded = upgraderBodyCost * upgradersNeeded;

  // RCL progress "mints" credits - it's the terminal value sink
  // Price is 0 because this is where value is created in the system

  return {
    buys: [
      {
        id: createOfferId(state.id, "delivered-energy", tick),
        corpId: state.id,
        type: "buy",
        resource: "delivered-energy",
        quantity: energyNeeded,
        price: 0,
        duration: CREEP_LIFETIME,
        location: state.position
      },
      {
        id: createOfferId(state.id, "spawn-capacity", tick),
        corpId: state.id,
        type: "buy",
        resource: "spawn-capacity",
        quantity: totalSpawnCapacityNeeded,
        price: 0, // Price determined by spawn + distance
        duration: CREEP_LIFETIME,
        location: state.position // Controller location - distance from spawn affects price
      }
    ],
    sells: [
      {
        id: createOfferId(state.id, "rcl-progress", tick),
        corpId: state.id,
        type: "sell",
        resource: "rcl-progress",
        quantity: rclProgress,
        price: 0, // Terminal value - mints credits
        duration: CREEP_LIFETIME,
        location: state.position
      }
    ]
  };
}

// =============================================================================
// Hauling Projection
// =============================================================================

/** Minimum transport fee per energy */
const MIN_TRANSPORT_FEE = 0.05;

/**
 * Calculate offers for a hauling corp.
 *
 * Hauling corps:
 * - Buy: energy (from mining corps at source location)
 * - Buy: spawn-capacity (need hauler creep continuously supplied)
 * - Sell: delivered-energy (transport service to destination)
 *
 * This creates the supply chain: Mining → Hauling → Upgrading
 * Hauling buys raw energy at the source and sells delivered-energy at destination.
 *
 * Haulers are expressed as CARRY parts. E.g., [CARRY,CARRY,CARRY,MOVE,MOVE,MOVE]
 * Distance from spawn affects effective cost.
 *
 * Supports both planning mode (projected values) and runtime mode (actual creeps).
 * When actualCarryCapacity/actualTotalTTL are provided, uses actual creep data.
 */
export function projectHauling(state: HaulingCorpState, tick: number): CorpProjection {
  // Use actual values if available (runtime), otherwise calculate projected (planning)
  const isRuntime = state.actualCarryCapacity !== undefined && state.actualTotalTTL !== undefined;

  let carryCapacity: number;
  let effectiveLifetime: number;

  if (isRuntime && state.activeCreepCount && state.activeCreepCount > 0) {
    // Runtime mode: use actual creep data
    carryCapacity = state.actualCarryCapacity!;
    effectiveLifetime = state.actualTotalTTL! / state.activeCreepCount;
  } else if (isRuntime) {
    // Runtime mode but no active creeps
    return { buys: [], sells: [] };
  } else {
    // Planning mode: use configured capacity
    carryCapacity = state.carryCapacity;
    effectiveLifetime = state.spawnPosition
      ? calculateEffectiveWorkTime(state.spawnPosition, state.sourcePosition)
      : CREEP_LIFETIME;
  }

  // Calculate one-way distance
  const distance = calculateTravelTime(state.sourcePosition, state.destinationPosition);
  const roundTripTime = Math.max(distance * 2, 1); // Avoid division by zero

  // Trips per lifetime
  const tripsPerLifetime = Math.floor(effectiveLifetime / roundTripTime);

  if (tripsPerLifetime <= 0) {
    return { buys: [], sells: [] };
  }

  // Calculate CARRY parts needed for desired capacity
  const carryParts = Math.ceil(carryCapacity / CARRY_CAPACITY);

  // Energy transported per lifetime
  let energyTransported = tripsPerLifetime * carryCapacity;

  // Subtract already-committed delivery from active sell contracts
  if (isRuntime) {
    const committedDelivery = getCommittedSellQuantity(state, "delivered-energy", tick);
    energyTransported = Math.max(0, energyTransported - committedDelivery);
  }

  if (energyTransported <= 0) {
    return { buys: [], sells: [] };
  }

  // Hauler body cost (CARRY + MOVE per part for 1:1 ratio on roads)
  const haulerBodyCost = carryParts * (BODY_PART_COST.carry + BODY_PART_COST.move);

  const margin = calculateMargin(state.balance);
  const costPerEnergy = energyTransported > 0 ? haulerBodyCost / energyTransported : 0;
  const calculatedPrice = costPerEnergy * (1 + margin);
  const pricePerEnergy = Math.max(calculatedPrice, MIN_TRANSPORT_FEE);

  return {
    buys: [
      {
        id: createOfferId(state.id, "energy", tick),
        corpId: state.id,
        type: "buy",
        resource: "energy",
        // Quantity = energy we want to pick up and transport
        quantity: energyTransported,
        price: 0, // Price determined by mining's sell price
        duration: CREEP_LIFETIME,
        location: state.sourcePosition // Pickup location - must match mining's sell location
      },
      {
        id: createOfferId(state.id, "spawn-capacity", tick),
        corpId: state.id,
        type: "buy",
        resource: "spawn-capacity",
        // Quantity = energy cost of desired hauler body
        // E.g., 4 CARRY + 4 MOVE = 400 energy
        quantity: haulerBodyCost,
        price: 0, // Price determined by spawn + distance
        duration: CREEP_LIFETIME,
        location: state.sourcePosition // Pickup location - distance from spawn affects price
      }
    ],
    sells: [
      {
        id: createOfferId(state.id, "delivered-energy", tick),
        corpId: state.id,
        type: "sell",
        resource: "delivered-energy",
        quantity: energyTransported,
        price: pricePerEnergy * energyTransported,
        duration: CREEP_LIFETIME,
        location: state.destinationPosition
      }
    ]
  };
}

// =============================================================================
// Dispatcher
// =============================================================================

/**
 * Project offers for any corp state.
 *
 * This is the main entry point - dispatches to type-specific projection.
 */
export function project(state: AnyCorpState, tick: number): CorpProjection {
  switch (state.type) {
    case "source":
      return projectSource(state, tick);
    case "mining":
      return projectMining(state, tick);
    case "spawning":
      return projectSpawning(state, tick);
    case "upgrading":
      return projectUpgrading(state, tick);
    case "hauling":
      return projectHauling(state, tick);
    case "building":
    case "bootstrap":
    case "scout":
      // These corps don't participate in the standard offer system
      return EMPTY_PROJECTION;
    default: {
      // Exhaustiveness check - TypeScript will error if we miss a case
      const _exhaustive: never = state;
      return EMPTY_PROJECTION;
    }
  }
}

/**
 * Project offers for multiple corp states.
 */
export function projectAll(states: AnyCorpState[], tick: number): CorpProjection[] {
  return states.map((s) => project(s, tick));
}

/**
 * Collect all buy offers from multiple projections.
 */
export function collectBuys(projections: CorpProjection[]): Offer[] {
  const result: Offer[] = [];
  for (const p of projections) {
    result.push(...p.buys);
  }
  return result;
}

/**
 * Collect all sell offers from multiple projections.
 */
export function collectSells(projections: CorpProjection[]): Offer[] {
  const result: Offer[] = [];
  for (const p of projections) {
    result.push(...p.sells);
  }
  return result;
}
