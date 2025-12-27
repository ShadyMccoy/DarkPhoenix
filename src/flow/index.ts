/**
 * Flow-based Economy Module
 *
 * Replaces the market-based offer/contract system with direct flow allocation.
 *
 * Main components:
 * - FlowTypes: Core interfaces and constants
 * - FlowGraph: Flow network construction from nodes
 * - FlowSolver: Priority-weighted allocation algorithm
 * - PriorityManager: Dynamic priority calculation
 * - FlowEconomy: Main coordinator (replaces Market)
 *
 * Usage:
 * ```typescript
 * import { FlowEconomy, PriorityManager } from './flow';
 *
 * // Create economy from nodes and navigator
 * const economy = new FlowEconomy(nodes, navigator);
 *
 * // Update each tick with current game state
 * const context = priorityManager.buildContext(room);
 * economy.update(context);
 *
 * // Query allocations
 * const miners = economy.getMinerAssignments();
 * const upgradeRate = economy.getUpgradeRate();
 * ```
 */

// =============================================================================
// TYPES
// =============================================================================

export {
  // Position (re-exported for convenience)
  Position,

  // Constants
  SOURCE_ENERGY_PER_TICK,
  CREEP_LIFETIME,
  BODY_COSTS,
  MINER_COST,
  MINER_OVERHEAD_PER_TICK,
  DEFAULT_SINK_PRIORITIES,
  DEFAULT_CONSTRAINTS,

  // Sink types
  SinkType,

  // Core interfaces
  FlowSource,
  FlowSink,
  FlowEdge,

  // Allocation interfaces
  MinerAssignment,
  HaulerAssignment,
  SinkAllocation,

  // Problem/Solution interfaces
  FlowProblem,
  FlowConstraints,
  FlowSolution,

  // Context
  PriorityContext,

  // Factory functions
  createFlowSource,
  createFlowSink,
  createEdgeId,

  // Utility functions
  calculateRoundTrip,
  calculateCarryParts,
  calculateHaulerCostPerTick,
  chebyshevDistance,
  estimateRoomDistance,
} from "./FlowTypes";

// =============================================================================
// FLOW GRAPH
// =============================================================================

export {
  FlowGraph,
  createFlowGraph,
} from "./FlowGraph";

// =============================================================================
// FLOW SOLVER
// =============================================================================

export {
  FlowSolver,
  solveIteratively,
  calculateEfficiency,
  estimateOverhead,
  printSolutionSummary,
} from "./FlowSolver";

// =============================================================================
// PRIORITY MANAGER
// =============================================================================

export {
  PriorityManager,
  PRIORITY_PRESETS,
  describePriority,
  comparePriorities,
} from "./PriorityManager";

// =============================================================================
// FLOW ECONOMY (Main Entry Point)
// =============================================================================

export {
  FlowEconomy,
  createFlowEconomy,
  createFlowEconomyWithPreset,
} from "./FlowEconomy";

// =============================================================================
// NODE FLOW (Flow Solution → Node Grouping)
// =============================================================================

export {
  NodeFlow,
  NodeFlowMap,
  groupByNode,
  getActiveNodeIds,
  getTotalCarryParts,
  getPrimarySpawn,
  getSinkAllocationByType,
  isNodeSelfSustaining,
  printNodeFlow,
  printAllNodeFlows,
} from "./NodeFlow";

// =============================================================================
// FLOW MATERIALIZER (Flow Solution → Corps)
// =============================================================================

export {
  MaterializationResult,
  materializeCorps,
  cleanupStaleCorps,
} from "./FlowMaterializer";
