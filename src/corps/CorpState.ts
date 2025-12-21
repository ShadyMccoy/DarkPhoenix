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
import { Position } from "../market/Offer";

/**
 * Mining corp state - harvests energy from sources
 */
export interface MiningCorpState extends SerializedCorp {
  type: "mining";
  /** Position of the source being mined */
  position: Position;
  /** Energy capacity of the source (e.g., 3000) */
  sourceCapacity: number;
  /** Spawn position for travel time calculation, null if unknown */
  spawnPosition: Position | null;
}

/**
 * Spawning corp state - produces creeps
 */
export interface SpawningCorpState extends SerializedCorp {
  type: "spawning";
  /** Position of the spawn structure */
  position: Position;
  /** Energy capacity available for spawning */
  energyCapacity: number;
}

/**
 * Upgrading corp state - upgrades room controller
 */
export interface UpgradingCorpState extends SerializedCorp {
  type: "upgrading";
  /** Position of the controller */
  position: Position;
  /** Current controller level (1-8) */
  controllerLevel: number;
  /** Spawn position for travel time calculation, null if unknown */
  spawnPosition: Position | null;
}

/**
 * Hauling corp state - transports resources between locations
 */
export interface HaulingCorpState extends SerializedCorp {
  type: "hauling";
  /** Pick-up location (where resources are collected) */
  sourcePosition: Position;
  /** Drop-off location (where resources are delivered) */
  destinationPosition: Position;
  /** Carry capacity per trip */
  carryCapacity: number;
  /** Spawn position for travel time calculation, null if unknown */
  spawnPosition: Position | null;
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
 * Create a minimal mining corp state for testing
 */
export function createMiningState(
  id: string,
  nodeId: string,
  position: Position,
  sourceCapacity: number,
  spawnPosition: Position | null = null
): MiningCorpState {
  return {
    id,
    type: "mining",
    nodeId,
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
    unitsConsumed: 0,
    acquisitionCost: 0
  };
}

/**
 * Create a minimal spawning corp state for testing
 */
export function createSpawningState(
  id: string,
  nodeId: string,
  position: Position,
  energyCapacity: number = 300
): SpawningCorpState {
  return {
    id,
    type: "spawning",
    nodeId,
    position,
    energyCapacity,
    balance: 0,
    totalRevenue: 0,
    totalCost: 0,
    createdAt: 0,
    isActive: false,
    lastActivityTick: 0,
    unitsProduced: 0,
    unitsConsumed: 0,
    acquisitionCost: 0
  };
}

/**
 * Create a minimal upgrading corp state for testing
 */
export function createUpgradingState(
  id: string,
  nodeId: string,
  position: Position,
  controllerLevel: number,
  spawnPosition: Position | null = null
): UpgradingCorpState {
  return {
    id,
    type: "upgrading",
    nodeId,
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
    unitsConsumed: 0,
    acquisitionCost: 0
  };
}

/**
 * Create a minimal hauling corp state for testing
 */
export function createHaulingState(
  id: string,
  nodeId: string,
  sourcePosition: Position,
  destinationPosition: Position,
  carryCapacity: number,
  spawnPosition: Position | null = null
): HaulingCorpState {
  return {
    id,
    type: "hauling",
    nodeId,
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
    unitsConsumed: 0,
    acquisitionCost: 0
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
