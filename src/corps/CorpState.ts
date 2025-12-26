/**
 * @fileoverview Corp state types for pure projection functions.
 *
 * CorpState represents the configuration data needed to compute
 * what a corp will buy and sell. It extends SerializedCorp with
 * type-specific fields required for economic calculations.
 *
 * Key principle: State is pure data, projections are computed on-demand.
 *
 * @module corps/CorpState
 */

import { SerializedCorp } from "./Corp";
import { Position } from "../types/Position";

/**
 * Source corp state - passive energy source representation.
 * Created first in the dependency chain.
 */
export interface SourceCorpState extends SerializedCorp {
  type: "source";
  /** Position of the source */
  position: Position;
  /** Source game object ID */
  sourceId: string;
  /** Energy capacity (e.g., 3000) */
  energyCapacity: number;
  /** Number of mining spots available */
  miningSpots: number;
}

/**
 * Mining corp state - harvests energy from sources.
 * Depends on SourceCorp (sourceCorpId).
 *
 * Supports both planning (projected values) and runtime (actual values).
 * When runtime fields are provided, projections use actual creep data.
 */
export interface MiningCorpState extends SerializedCorp {
  type: "mining";
  /** ID of the SourceCorp this operation mines from (dependency) */
  sourceCorpId: string;
  /** Position of the source being mined */
  position: Position;
  /** Energy capacity of the source (e.g., 3000) */
  sourceCapacity: number;
  /** Spawn position for travel time calculation, null if unknown */
  spawnPosition: Position | null;
  /** ID of the SpawningCorp to get workers from */
  spawningCorpId: string;

  // === Runtime fields (optional, from actual creeps) ===
  /** Actual total work parts across all creeps (runtime) */
  actualWorkParts?: number;
  /** Actual total remaining TTL across all creeps (runtime) */
  actualTotalTTL?: number;
  /** Number of active creeps (runtime) */
  activeCreepCount?: number;
}

/**
 * Spawning corp state - produces creeps for other corps.
 *
 * SpawningCorp is the origin of labor in the production chain.
 * It sells spawn-capacity - the ability to continuously supply creeps.
 *
 * Key economics:
 * - Base cost = energy to spawn body parts
 * - Effective cost = base_cost × (lifetime / useful_lifetime)
 * - Useful lifetime = CREEP_LIFETIME - travel_time_to_work_site
 *
 * Example: 750 ticks travel = 50% useful life = 2× effective cost
 */
export interface SpawningCorpState extends SerializedCorp {
  type: "spawning";
  /** Position of the spawn structure */
  position: Position;
  /** Max energy capacity available for spawning (e.g., 300, 550, 1300) */
  energyCapacity: number;
  /** Number of pending spawn orders in queue */
  pendingOrderCount: number;
  /** Whether spawn is currently spawning a creep */
  isSpawning: boolean;
}

/**
 * Upgrading corp state - upgrades room controller.
 * Consumes delivered-energy from HaulingCorp and work-ticks from SpawningCorp.
 */
export interface UpgradingCorpState extends SerializedCorp {
  type: "upgrading";
  /** ID of the SpawningCorp to get workers from (dependency) */
  spawningCorpId: string;
  /** Position of the controller */
  position: Position;
  /** Current controller level (1-8) */
  controllerLevel: number;
  /** Spawn position for travel time calculation, null if unknown */
  spawnPosition: Position | null;
}

/**
 * Hauling corp state - transports resources between locations.
 * Depends on MiningOperation (miningCorpId).
 *
 * Supports both planning (projected values) and runtime (actual values).
 */
export interface HaulingCorpState extends SerializedCorp {
  type: "hauling";
  /** ID of the MiningOperation to pick up energy from (dependency) */
  miningCorpId: string;
  /** ID of the SpawningCorp to get haulers from */
  spawningCorpId: string;
  /** Pick-up location (where resources are collected) - from MiningOperation */
  sourcePosition: Position;
  /** Drop-off location (where resources are delivered) */
  destinationPosition: Position;
  /** Carry capacity per trip */
  carryCapacity: number;
  /** Spawn position for travel time calculation, null if unknown */
  spawnPosition: Position | null;

  // === Runtime fields (optional, from actual creeps) ===
  /** Actual total carry capacity across all creeps (runtime) */
  actualCarryCapacity?: number;
  /** Actual total remaining TTL across all creeps (runtime) */
  actualTotalTTL?: number;
  /** Number of active creeps (runtime) */
  activeCreepCount?: number;
}

/**
 * Building corp state - constructs structures
 */
export interface BuildingCorpState extends SerializedCorp {
  type: "building";
  /** Position of the construction site */
  position: Position;
  /** Total build cost remaining */
  buildCost: number;
  /** Spawn position for travel time calculation, null if unknown */
  spawnPosition: Position | null;
}

/**
 * Bootstrap corp state - initial colony setup (simplified, minimal offers)
 */
export interface BootstrapCorpState extends SerializedCorp {
  type: "bootstrap";
  /** Primary position of bootstrap operations */
  position: Position;
}

/**
 * Scout corp state - explores and claims rooms (no economic offers)
 */
export interface ScoutCorpState extends SerializedCorp {
  type: "scout";
  /** Target room or current position */
  position: Position;
}

/**
 * Union of all corp state types
 */
export type AnyCorpState =
  | SourceCorpState
  | MiningCorpState
  | SpawningCorpState
  | UpgradingCorpState
  | HaulingCorpState
  | BuildingCorpState
  | BootstrapCorpState
  | ScoutCorpState;

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a source corp state (passive energy source).
 * This is the first in the dependency chain.
 */
export function createSourceState(
  id: string,
  nodeId: string,
  position: Position,
  sourceId: string,
  energyCapacity: number,
  miningSpots: number
): SourceCorpState {
  return {
    id,
    type: "source",
    nodeId,
    position,
    sourceId,
    energyCapacity,
    miningSpots,
    balance: 0,
    totalRevenue: 0,
    totalCost: 0,
    createdAt: 0,
    isActive: false,
    lastActivityTick: 0,
    unitsProduced: 0,
    expectedUnitsProduced: 0,
    unitsConsumed: 0,
    acquisitionCost: 0,
    lastPlannedTick: 0,
  };
}

/**
 * Create a mining corp state.
 * Depends on SourceCorpState (must be created first).
 */
export function createMiningState(
  id: string,
  nodeId: string,
  sourceCorpId: string,
  spawningCorpId: string,
  position: Position,
  sourceCapacity: number,
  spawnPosition: Position | null = null
): MiningCorpState {
  return {
    id,
    type: "mining",
    nodeId,
    sourceCorpId,
    spawningCorpId,
    position,
    sourceCapacity,
    spawnPosition,
    balance: 0,
    totalRevenue: 0,
    totalCost: 0,
    createdAt: 0,
    isActive: false,
    lastActivityTick: 0,
    unitsProduced: 0,
    expectedUnitsProduced: 0,
    unitsConsumed: 0,
    acquisitionCost: 0,
    lastPlannedTick: 0,
  };
}

/**
 * Create a spawning corp state.
 *
 * SpawningCorp is the origin of labor in production chains.
 * It sells spawn-capacity with distance-aware pricing.
 */
export function createSpawningState(
  id: string,
  nodeId: string,
  position: Position,
  energyCapacity: number = 300,
  pendingOrderCount: number = 0,
  isSpawning: boolean = false
): SpawningCorpState {
  return {
    id,
    type: "spawning",
    nodeId,
    position,
    energyCapacity,
    pendingOrderCount,
    isSpawning,
    balance: 0,
    totalRevenue: 0,
    totalCost: 0,
    createdAt: 0,
    isActive: false,
    lastActivityTick: 0,
    unitsProduced: 0,
    expectedUnitsProduced: 0,
    unitsConsumed: 0,
    acquisitionCost: 0,
    lastPlannedTick: 0,
  };
}

/**
 * Create an upgrading corp state.
 * Depends on SpawningCorpState (must be created first).
 */
export function createUpgradingState(
  id: string,
  nodeId: string,
  spawningCorpId: string,
  position: Position,
  controllerLevel: number,
  spawnPosition: Position | null = null
): UpgradingCorpState {
  return {
    id,
    type: "upgrading",
    nodeId,
    spawningCorpId,
    position,
    controllerLevel,
    spawnPosition,
    balance: 0,
    totalRevenue: 0,
    totalCost: 0,
    createdAt: 0,
    isActive: false,
    lastActivityTick: 0,
    unitsProduced: 0,
    expectedUnitsProduced: 0,
    unitsConsumed: 0,
    acquisitionCost: 0,
    lastPlannedTick: 0,
  };
}

/**
 * Create a hauling corp state.
 * Depends on MiningCorpState (must be created first).
 */
export function createHaulingState(
  id: string,
  nodeId: string,
  miningCorpId: string,
  spawningCorpId: string,
  sourcePosition: Position,
  destinationPosition: Position,
  carryCapacity: number,
  spawnPosition: Position | null = null
): HaulingCorpState {
  return {
    id,
    type: "hauling",
    nodeId,
    miningCorpId,
    spawningCorpId,
    sourcePosition,
    destinationPosition,
    carryCapacity,
    spawnPosition,
    balance: 0,
    totalRevenue: 0,
    totalCost: 0,
    createdAt: 0,
    isActive: false,
    lastActivityTick: 0,
    unitsProduced: 0,
    expectedUnitsProduced: 0,
    unitsConsumed: 0,
    acquisitionCost: 0,
    lastPlannedTick: 0,
  };
}

/**
 * Get the primary position for any corp state.
 * Used for distance calculations in offer matching.
 */
export function getCorpPosition(state: AnyCorpState): Position {
  switch (state.type) {
    case "hauling":
      // Hauling corps use source position as primary location
      return state.sourcePosition;
    default:
      return state.position;
  }
}
