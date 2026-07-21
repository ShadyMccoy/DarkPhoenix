/**
 * Flow-based Economy Module
 *
 * Replaces the market-based offer/contract system with direct flow allocation.
 *
 * Main components:
 * - FlowTypes: Core interfaces and constants
 * - FlowGraph: Flow network construction from nodes
 * - PriorityManager: Dynamic priority calculation
 * - FlowEconomy: Main coordinator (solves via economy/CorpPlanner)
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
  FlowSolution,

  // Context

  // Factory functions
  createFlowSource,
  createFlowSink,
  createEdgeId,

  // Utility functions
  chebyshevDistance,
  estimateRoomDistance
} from "./FlowTypes";

// =============================================================================
// FLOW GRAPH
// =============================================================================

export { FlowGraph, createFlowGraph } from "./FlowGraph";

// =============================================================================
// PRIORITY MANAGER
// =============================================================================


// =============================================================================
// FLOW ECONOMY (Main Entry Point)
// =============================================================================

export { FlowEconomy } from "./FlowEconomy";

// =============================================================================
// FLOW MATERIALIZER (Flow Solution → Corps)
// =============================================================================
