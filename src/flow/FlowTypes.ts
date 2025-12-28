/**
 * Flow-based Economy Types
 *
 * Core interfaces for the MFMC (Min-cost Max-flow) economy system.
 * Replaces the market-based offer/contract system with direct flow allocation.
 */

// Position type (shared across modules)
export { Position } from "../types/Position";
import { Position } from "../types/Position";

// =============================================================================
// CONSTANTS
// =============================================================================

/** Energy produced per tick by a source (3000 capacity / 300 regen) */
export const SOURCE_ENERGY_PER_TICK = 10;

/** Creep lifetime in ticks */
export const CREEP_LIFETIME = 1500;

/** Body part costs */
export const BODY_COSTS = {
  WORK: 100,
  CARRY: 50,
  MOVE: 50,
} as const;

/** Standard miner: 5W 3M */
export const MINER_COST = 5 * BODY_COSTS.WORK + 3 * BODY_COSTS.MOVE; // 650

/** Miner spawn overhead per tick */
export const MINER_OVERHEAD_PER_TICK = MINER_COST / CREEP_LIFETIME; // ~0.433

// =============================================================================
// SINK TYPES
// =============================================================================

/**
 * Types of energy sinks (consumers) in the economy.
 * Priority ordering is handled by PriorityManager.
 */
export type SinkType =
  | "spawn"         // Spawn overhead - keeping creeps alive (CRITICAL)
  | "extension"     // Extension fill - spawn capacity
  | "tower"         // Tower energy - defense and repair
  | "construction"  // Construction sites - building new structures
  | "controller"    // Controller upgrading
  | "terminal"      // Terminal operations
  | "link"          // Link network transfers
  | "storage"       // Storage buffer (lowest priority - excess only)
  | "lab"           // Lab operations
  | "factory"       // Factory production
  | "nuker"         // Nuker charging
  | "powerSpawn";   // Power processing

/**
 * Default priority values for each sink type.
 * Higher = more important. Range: 0-100.
 * These are defaults - PriorityManager adjusts based on game state.
 */
export const DEFAULT_SINK_PRIORITIES: Record<SinkType, number> = {
  spawn: 100,        // Always critical
  extension: 85,     // High when spawning
  tower: 80,         // High during combat
  construction: 70,  // High after RCL-up
  controller: 60,    // Normal operation
  link: 50,          // Convenience
  terminal: 40,      // Trade operations
  storage: 30,       // Buffer
  lab: 25,           // Production
  factory: 20,       // Production
  powerSpawn: 10,    // Luxury
  nuker: 5,          // Very low priority
};

// =============================================================================
// FLOW SOURCE
// =============================================================================

/**
 * A source of energy in the flow network.
 * Each game Source object becomes one FlowSource.
 */
export interface FlowSource {
  /** Unique identifier: "source-{gameId}" */
  id: string;

  /** Node (territory) containing this source */
  nodeId: string;

  /** World position of the source */
  position: Position;

  /** Energy production capacity (default: 10/tick) */
  capacity: number;

  /** Game object ID of the source */
  gameId: string;

  /** Whether a miner is assigned to this source */
  assigned: boolean;

  /** Current energy output (may be less than capacity if not fully mined) */
  currentOutput: number;

  /**
   * Maximum miners that can work this source simultaneously.
   * Determined by counting walkable tiles adjacent to the source.
   * Used for early game when multiple small miners are more efficient.
   */
  maxMiners: number;
}

// =============================================================================
// FLOW SINK
// =============================================================================

/**
 * A consumer of energy in the flow network.
 * Sinks have priorities that determine allocation order.
 */
export interface FlowSink {
  /** Unique identifier: "{type}-{gameId}" */
  id: string;

  /** Node (territory) containing this sink */
  nodeId: string;

  /** World position of the sink */
  position: Position;

  /** Type of sink (determines default priority) */
  type: SinkType;

  /** Current priority (0-100, higher = more important) */
  priority: number;

  /** Energy demand per tick */
  demand: number;

  /** Maximum energy this sink can accept per tick */
  capacity: number;

  /** Energy allocated by the solver (set after solving) */
  allocation: number;

  /** Game object ID (if applicable) */
  gameId?: string;

  /** For construction sites: build progress remaining */
  progressRemaining?: number;
}

// =============================================================================
// FLOW EDGE
// =============================================================================

/**
 * An edge in the flow network representing transport capacity.
 * Edges connect sources to sinks, possibly via intermediate nodes.
 */
export interface FlowEdge {
  /** Unique identifier: "{fromId}|{toId}" */
  id: string;

  /** Source node/source ID */
  fromId: string;

  /** Destination node/sink ID */
  toId: string;

  /** Walking distance (Chebyshev) between endpoints */
  distance: number;

  /** Round trip time: 2 * distance + 2 */
  roundTrip: number;

  /** CARRY parts needed for this flow rate */
  carryParts: number;

  /** Energy flow rate through this edge (per tick) */
  flowRate: number;

  /** Spawn cost per tick to maintain this flow */
  spawnCostPerTick: number;

  /** Whether this edge uses roads (affects move ratio) */
  hasRoads: boolean;
}

// =============================================================================
// FLOW ALLOCATIONS (Solver Output)
// =============================================================================

/**
 * Miner assignment from the solver.
 */
export interface MinerAssignment {
  /** Source being mined */
  sourceId: string;

  /** Node where source is located */
  nodeId: string;

  /** Nearest spawn for this miner */
  spawnId: string;

  /** Distance from spawn to source */
  spawnDistance: number;

  /** Expected harvest rate (usually 10/tick per source) */
  harvestRate: number;

  /** Spawn cost per tick for this miner */
  spawnCostPerTick: number;

  /**
   * Maximum number of miners that can work this source simultaneously.
   * Determined by counting walkable tiles adjacent to the source.
   * Allows spawning multiple smaller miners in early game when energy capacity is limited.
   */
  maxMiners: number;
}

/**
 * Hauler assignment from the solver.
 */
export interface HaulerAssignment {
  /** Edge this hauler serves */
  edgeId: string;

  /** Source of energy */
  fromId: string;

  /** Destination (sink or intermediate node) */
  toId: string;

  /** Walking distance */
  distance: number;

  /** CARRY parts needed */
  carryParts: number;

  /** Energy transported per tick */
  flowRate: number;

  /** Spawn cost per tick for these haulers */
  spawnCostPerTick: number;

  /** Nearest spawn for these haulers */
  spawnId: string;
}

/**
 * Energy allocation to a sink from the solver.
 */
export interface SinkAllocation {
  /** Sink receiving energy */
  sinkId: string;

  /** Type of sink */
  sinkType: SinkType;

  /** Energy allocated per tick */
  allocated: number;

  /** Original demand */
  demand: number;

  /** Unmet demand (demand - allocated) */
  unmet: number;

  /** Priority at time of allocation */
  priority: number;

  /** Sources contributing to this sink */
  sourceFlows: Array<{
    sourceId: string;
    amount: number;
    distance: number;
  }>;
}

// =============================================================================
// FLOW PROBLEM & SOLUTION
// =============================================================================

/**
 * Input to the flow solver.
 */
export interface FlowProblem {
  /** All energy sources */
  sources: FlowSource[];

  /** All energy sinks (sorted by priority) */
  sinks: FlowSink[];

  /** All transport edges */
  edges: FlowEdge[];

  /** Solver constraints */
  constraints: FlowConstraints;
}

/**
 * Constraints for the flow solver.
 */
export interface FlowConstraints {
  /** Maximum miners per source (usually 1) */
  maxMinersPerSource: number;

  /** Maximum CARRY parts per edge (creep size limit) */
  maxCarryPerEdge: number;

  /** Minimum controller upgrade rate (prevent downgrade) */
  minControllerUpgrade: number;

  /** Whether to allow deficit operation */
  allowDeficit: boolean;
}

/**
 * Default constraints.
 */
export const DEFAULT_CONSTRAINTS: FlowConstraints = {
  maxMinersPerSource: 1,
  maxCarryPerEdge: 25, // 25C25M = 50 parts max
  minControllerUpgrade: 1, // At least 1/tick to prevent downgrade
  allowDeficit: false,
};

/**
 * Output from the flow solver.
 */
export interface FlowSolution {
  /** Miner assignments */
  miners: MinerAssignment[];

  /** Hauler assignments */
  haulers: HaulerAssignment[];

  /** Sink allocations */
  sinkAllocations: SinkAllocation[];

  /** Total gross harvest (before overhead) */
  totalHarvest: number;

  /** Total mining overhead (miner spawn costs) */
  miningOverhead: number;

  /** Total hauling overhead (hauler spawn costs) */
  haulingOverhead: number;

  /** Total overhead (mining + hauling) */
  totalOverhead: number;

  /** Net energy available for sinks */
  netEnergy: number;

  /** Overall efficiency: netEnergy / totalHarvest */
  efficiency: number;

  /** Sinks with unmet demand */
  unmetDemand: Map<string, number>;

  /** Is the economy self-sustaining? */
  isSustainable: boolean;

  /** Warnings from the solver */
  warnings: string[];

  /** Tick when this solution was computed */
  computedAt: number;
}

// =============================================================================
// PRIORITY CONTEXT
// =============================================================================

/**
 * Game state context for priority calculations.
 * Passed to PriorityManager to determine dynamic priorities.
 */
export interface PriorityContext {
  /** Current game tick */
  tick: number;

  /** Room's RCL */
  rcl: number;

  /** Progress toward next RCL (0-1) */
  rclProgress: number;

  /** Number of active construction sites */
  constructionSites: number;

  /** Number of hostile creeps in room */
  hostileCreeps: number;

  /** Current storage energy level */
  storageEnergy: number;

  /** Number of creeps in spawn queue */
  spawnQueueSize: number;

  /** Whether room is under attack */
  underAttack: boolean;

  /** Ticks since last RCL upgrade */
  ticksSinceRclUp: number;

  /** Energy in extensions (for spawn capacity) */
  extensionEnergy: number;

  /** Total extension capacity */
  extensionCapacity: number;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create a flow source from a game source.
 */
export function createFlowSource(
  gameId: string,
  nodeId: string,
  position: Position,
  capacity: number = SOURCE_ENERGY_PER_TICK,
  maxMiners: number = 1
): FlowSource {
  return {
    id: `source-${gameId}`,
    nodeId,
    position,
    capacity,
    gameId,
    assigned: false,
    currentOutput: 0,
    maxMiners,
  };
}

/**
 * Create a flow sink.
 */
export function createFlowSink(
  type: SinkType,
  gameId: string,
  nodeId: string,
  position: Position,
  demand: number,
  capacity: number,
  priority?: number
): FlowSink {
  return {
    id: `${type}-${gameId}`,
    nodeId,
    position,
    type,
    priority: priority ?? DEFAULT_SINK_PRIORITIES[type],
    demand,
    capacity,
    allocation: 0,
    gameId,
  };
}

/**
 * Create an edge ID from two node/source/sink IDs.
 * Always sorts alphabetically for consistent bidirectional keys.
 */
export function createEdgeId(fromId: string, toId: string): string {
  return fromId < toId ? `${fromId}|${toId}` : `${toId}|${fromId}`;
}

/**
 * Calculate round trip time for a given distance.
 * Assumes 1:1 CARRY:MOVE ratio (full speed both ways).
 */
export function calculateRoundTrip(distance: number, hasRoads: boolean = false): number {
  // With roads and 2:1 ratio, still full speed
  // Without roads, 1:1 ratio = full speed both ways
  return 2 * distance + 2;
}

/**
 * Calculate CARRY parts needed for a flow rate at a given distance.
 * Formula: CARRY = flowRate * roundTrip / 50
 */
export function calculateCarryParts(flowRate: number, distance: number): number {
  const roundTrip = calculateRoundTrip(distance);
  return (flowRate * roundTrip) / 50;
}

/**
 * Calculate spawn cost per tick for haulers.
 * Assumes 1:1 CARRY:MOVE ratio (100 energy per CARRY).
 */
export function calculateHaulerCostPerTick(carryParts: number): number {
  const costPerCarry = BODY_COSTS.CARRY + BODY_COSTS.MOVE; // 100
  return (carryParts * costPerCarry) / CREEP_LIFETIME;
}

// Re-export distance functions from shared Position module
export { chebyshevDistance, estimateRoomDistance } from "../types/Position";
