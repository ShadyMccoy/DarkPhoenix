/**
 * Flow-based Economy Module
 *
 * The world-translation layer: FlowGraph discovers sources and sinks from
 * spatial nodes, and FlowEconomy drives the ONE economy solve
 * (economy/flowAdapter.solveColony -> planColony). The FlowSolution and its
 * assignment shapes survive as the live DTOs consumed by telemetry and the
 * corps' assignment mappers.
 *
 * Main components:
 * - FlowTypes: Core interfaces and constants
 * - FlowGraph: Source/sink discovery from nodes
 * - FlowEconomy: Solve driver (solves via economy/CorpPlanner)
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

  // Allocation interfaces
  MinerAssignment,
  HaulerAssignment,
  SinkAllocation,

  // Problem/Solution interfaces
  FlowSolution,

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
// FLOW ECONOMY (Main Entry Point)
// =============================================================================

export { FlowEconomy } from "./FlowEconomy";
