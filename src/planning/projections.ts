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

import { Offer, createOfferId, HAUL_PER_CARRY } from "../market/Offer";
import {
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
import { calculateMargin } from "../corps/Corp";

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
// Mining Projection
// =============================================================================

/**
 * Calculate offers for a mining corp.
 *
 * Mining corps are LEAF NODES in the supply chain:
 * - Buy: nothing (raw producer - extracts energy from source)
 * - Sell: energy at source location
 *
 * Note: Work-ticks dependency is handled separately via labor allocation,
 * not through the supply chain. For chain building, mining is the origin
 * of value (energy) without dependencies.
 *
 * Price is based on amortized spawn cost over effective lifetime.
 */
export function projectMining(state: MiningCorpState, tick: number): CorpProjection {
  const workParts = calculateOptimalWorkParts(state.sourceCapacity);

  // Calculate effective output considering travel time
  const effectiveLifetime = state.spawnPosition
    ? calculateEffectiveWorkTime(state.spawnPosition, state.position)
    : CREEP_LIFETIME;

  // Energy output = work parts × harvest rate × effective time
  const expectedOutput = workParts * HARVEST_RATE * effectiveLifetime;

  // Calculate input cost for pricing (amortized spawn cost)
  const body = designMiningCreep(workParts);
  const spawnCost = calculateBodyCost(body);
  const inputCostPerUnit = expectedOutput > 0 ? spawnCost / expectedOutput : 0;

  const margin = calculateMargin(state.balance);
  const sellPrice = inputCostPerUnit * (1 + margin);

  // Mining is a leaf node - no buy offers
  // It produces energy from the source without supply chain dependencies
  return {
    buys: [],
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
 * Spawning corps:
 * - Buy: energy (to spawn creeps)
 * - Sell: work-ticks (creep labor time for miners/upgraders)
 * - Sell: haul-demand (hauling capacity for haulers)
 *
 * Price is based on body part costs amortized over lifetime.
 */
export function projectSpawning(state: SpawningCorpState, tick: number): CorpProjection {
  // Standard worker creep cost (WORK + CARRY + MOVE)
  const workerCost = BODY_PART_COST.work + BODY_PART_COST.carry + BODY_PART_COST.move;

  // Energy needed to spawn one worker
  const energyNeeded = workerCost;

  // Work-ticks produced = 1 WORK part × lifetime
  const workTicksProduced = CREEP_LIFETIME;

  // Price per work-tick = spawn cost / lifetime
  const costPerWorkTick = workerCost / CREEP_LIFETIME;

  const margin = calculateMargin(state.balance);
  const sellPricePerWorkTick = costPerWorkTick * (1 + margin);

  // Haul-demand capacity: assume 4 CARRY parts worth
  const haulerCarryParts = 4;
  const haulCapacityProduced = haulerCarryParts * HAUL_PER_CARRY; // 100 HAUL
  const haulerCost = haulerCarryParts * (BODY_PART_COST.carry + BODY_PART_COST.move);
  const costPerHaul = haulerCost / (haulCapacityProduced * CREEP_LIFETIME);
  const sellPricePerHaul = costPerHaul * (1 + margin);

  return {
    buys: [
      {
        id: createOfferId(state.id, "energy", tick),
        corpId: state.id,
        type: "buy",
        resource: "energy",
        quantity: energyNeeded,
        price: 0, // Price determined by seller
        duration: CREEP_LIFETIME,
        location: state.position
      }
    ],
    sells: [
      {
        id: createOfferId(state.id, "work-ticks", tick),
        corpId: state.id,
        type: "sell",
        resource: "work-ticks",
        quantity: workTicksProduced,
        price: sellPricePerWorkTick * workTicksProduced,
        duration: CREEP_LIFETIME,
        location: state.position
      },
      {
        id: createOfferId(state.id, "haul-demand", tick),
        corpId: state.id,
        type: "sell",
        resource: "haul-demand",
        quantity: haulCapacityProduced,
        price: sellPricePerHaul * haulCapacityProduced,
        duration: CREEP_LIFETIME,
        location: state.position
      }
    ]
  };
}

// =============================================================================
// Upgrading Projection
// =============================================================================

/**
 * Calculate offers for an upgrading corp.
 *
 * Upgrading corps:
 * - Buy: delivered-energy (from haulers)
 * - Buy: work-ticks (need upgrader creep)
 * - Sell: rcl-progress (controller points)
 *
 * 1 WORK part + 1 energy = 1 upgrade point per tick
 */
export function projectUpgrading(state: UpgradingCorpState, tick: number): CorpProjection {
  // Calculate effective work time
  const effectiveLifetime = state.spawnPosition
    ? calculateEffectiveWorkTime(state.spawnPosition, state.position)
    : CREEP_LIFETIME;

  // Assume 1 WORK part for simplicity
  const workParts = 1;
  const workTicksNeeded = workParts * CREEP_LIFETIME;

  // Energy consumption = 1 per upgrade action per WORK part
  const energyNeeded = workParts * effectiveLifetime;

  // RCL progress = energy consumed (1:1 ratio)
  const rclProgress = energyNeeded;

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
        id: createOfferId(state.id, "work-ticks", tick),
        corpId: state.id,
        type: "buy",
        resource: "work-ticks",
        quantity: workTicksNeeded,
        price: 0,
        duration: CREEP_LIFETIME,
        location: state.position
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

/**
 * Calculate offers for a hauling corp.
 *
 * Hauling corps:
 * - Buy: haul-demand (need hauler creep capacity)
 * - Sell: delivered-energy (transport service)
 *
 * Haul demand = flow × distance, where:
 * - flow = throughput rate (energy/tick) to transport
 * - distance = one-way distance from source to destination
 *
 * Each CARRY part provides HAUL_PER_CARRY (25) capacity.
 */
export function projectHauling(state: HaulingCorpState, tick: number): CorpProjection {
  // Calculate one-way distance
  const distance = calculateTravelTime(state.sourcePosition, state.destinationPosition);
  const roundTripTime = distance * 2;

  // Trips per lifetime
  const effectiveLifetime = state.spawnPosition
    ? calculateEffectiveWorkTime(state.spawnPosition, state.sourcePosition)
    : CREEP_LIFETIME;

  const tripsPerLifetime = roundTripTime > 0
    ? Math.floor(effectiveLifetime / roundTripTime)
    : 0;

  // Calculate haul demand needed
  // carryCapacity represents the total carry capacity needed
  // haul-demand = (carryCapacity / CARRY_CAPACITY) × HAUL_PER_CARRY
  const carryParts = Math.ceil(state.carryCapacity / CARRY_CAPACITY);
  const haulDemandNeeded = carryParts * HAUL_PER_CARRY;

  // Energy transported per lifetime
  const energyTransported = tripsPerLifetime * state.carryCapacity;

  // Hauler body cost (CARRY + MOVE per unit)
  const haulerCost = carryParts * (BODY_PART_COST.carry + BODY_PART_COST.move);

  const margin = calculateMargin(state.balance);
  const costPerEnergy = energyTransported > 0 ? haulerCost / energyTransported : 0;
  const pricePerEnergy = costPerEnergy * (1 + margin);

  return {
    buys: [
      {
        id: createOfferId(state.id, "haul-demand", tick),
        corpId: state.id,
        type: "buy",
        resource: "haul-demand",
        quantity: haulDemandNeeded,
        price: 0,
        duration: CREEP_LIFETIME,
        location: state.sourcePosition
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
