/**
 * Flow-based Economy Types
 *
 * Core interfaces for the MFMC (Min-cost Max-flow) economy system.
 * Replaces the market-based offer/contract system with direct flow allocation.
 */

// Position type (shared across modules)
export { Position } from "../types/Position";
import { HaulerRatio } from "../framework/EdgeVariant";
import { Position } from "../types/Position";

// =============================================================================
// CONSTANTS
// =============================================================================

/** Energy produced per tick by a source (3000 capacity / 300 regen) */
export const SOURCE_ENERGY_PER_TICK = 10;

// Body-part costs, creep lifetime and the standard-miner body are homed in
// economy/primitives (spec 32 phase B inverted the constants dependency);
// re-exported here so legacy flow-layer import paths keep working.
export { BODY_COSTS, CREEP_LIFETIME, MINER_COST, MINER_PARTS } from "../economy/primitives";

// =============================================================================
// SINK TYPES
// =============================================================================

/**
 * Types of energy sinks (consumers) in the economy.
 * Priority ordering is handled by PriorityManager.
 */
export type SinkType =
  | "spawn" // Spawn overhead - keeping creeps alive (CRITICAL)
  | "extension" // Extension fill - spawn capacity
  | "tower" // Tower energy - defense and repair
  | "construction" // Construction sites - building new structures
  | "controller" // Controller upgrading
  | "terminal" // Terminal operations
  | "link" // Link network transfers
  | "storage" // Storage buffer (lowest priority - excess only)
  | "lab" // Lab operations
  | "factory" // Factory production
  | "nuker" // Nuker charging
  | "powerSpawn"; // Power processing

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

  /**
   * Mining efficiency percentage (0-100).
   * Calculated as: (harvestRate - totalOverhead) / harvestRate * 100
   * where totalOverhead = minerOverhead + haulerOverhead.
   * Higher efficiency = more net energy per unit harvested = higher spawn priority.
   */
  efficiency: number;
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

  /**
   * Planner's own spawn-PARTS/tick for this route (parts, not energy):
   * `((paved?1.5:2)*carryPartsFor(take,dEff))/effectiveLife(d)`, carried
   * verbatim from the CommissionedHauler so the waste ledger's P4 can ECHO the
   * planner's paved-aware number instead of re-deriving it (owner 2026-07-22:
   * share the code, don't duplicate the pricing). Optional: the corp-side
   * materialization path (haulerAssignmentFromCommissioned) leaves it unset.
   */
  spawnParts?: number;

  /** Nearest spawn for these haulers */
  spawnId: string;

  /**
   * Deposit port (spec 26): a link position the plan chose as a shorter delivery
   * leg to the storage hub. When set, this route's `distance`/`carryParts` are
   * already priced to the port leg and CarryCorp delivers HERE first (falling
   * back to the storage on port-full). Carried verbatim from CommissionedHauler.
   */
  depositPos?: Position;

  /** Terrain profile for this route */

  /** Hauler CARRY:MOVE ratio selected by variant optimizer */
  haulerRatio?: HaulerRatio;

  /** Selected EdgeVariant for this hauler assignment */
}

/**
 * Energy allocation to a sink from the solver.
 */
export interface SinkAllocation {
  /** Sink receiving energy */
  sinkId: string;

  /**
   * Spawn-parts ledger remaining when this sink's fill ENDED (spec 15 P4
   * trace) - why filling stopped: capacity met, pool dry, or ledger dry.
   */
  partsLeft?: number;

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
  sourceFlows: {
    sourceId: string;
    amount: number;
    distance: number;
  }[];
}

// =============================================================================
// FLOW PROBLEM & SOLUTION
// =============================================================================

/**
 * Output from the flow solver.
 */
export interface FlowSolution {
  /** Miner assignments */
  miners: MinerAssignment[];

  /**
   * The plan's spawn-parts ledger, traced (spec 15 P4): capacity, standing
   * deductions, and the routing budget the sink fill worked with.
   */
  partsLedger?: { capacity: number; minerLoad: number; infra: number; budget: number };
  /** Problem-assembly counts (flow v5): names the layer that dropped sources. */
  assembly?: { graphSources: number; mined: number; transient: number; bank: number };

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

  /**
   * Per-candidate funding verdicts from producer selection (spec 14 phase 5) -
   * why each non-transient source was funded or excluded (unprofitable /
   * over-budget / no-spawn), with the net/tax pricing the decision read.
   * Shape: economy/CorpPlanner.SourceVerdict[]. Optional: absent on legacy
   * solutions.
   */
  sourceVerdicts?: {
    sourceId: string;
    rate: number;
    distance: number;
    net: number;
    tax: number;
    parts: number;
    verdict: string;
  }[];
}

// =============================================================================
// PRIORITY CONTEXT
// =============================================================================


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
  maxMiners = 1
): FlowSource {
  return {
    id: `source-${gameId}`,
    nodeId,
    position,
    capacity,
    gameId,
    maxMiners
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
    // Vestigial: sinks are VALUED by the planner's ladder (perInstanceSinkValue
    // over DEFAULT_SINK_VALUE - the ONE value model, ONTOLOGY §7). This field
    // survives only as a telemetry passthrough; nothing routes on it.
    priority: priority ?? 0,
    demand,
    capacity,
    allocation: 0,
    gameId
  };
}

/**
 * Create an edge ID from two node/source/sink IDs.
 * Always sorts alphabetically for consistent bidirectional keys.
 */
export function createEdgeId(fromId: string, toId: string): string {
  return fromId < toId ? `${fromId}|${toId}` : `${toId}|${fromId}`;
}

// (Round-trip / carry-part / hauler-cost formulas live in economy/primitives -
// the single canonical home for economic math. See docs/ONTOLOGY.md § 2.)

// Re-export distance functions from shared Position module
export { chebyshevDistance, estimateRoomDistance } from "../types/Position";
