/**
 * NodeFlow - Flow-based Economy Materialization
 *
 * Bridges the FlowSolution to Corps by grouping flow assignments by node.
 * Each NodeFlow represents all economic activity for a territory node,
 * which can then be materialized into corps.
 *
 * Architecture:
 *   FlowSolution → groupByNode() → NodeFlow[] → materializeCorps() → Corps
 *
 * This replaces the query-based integration where corps ask FlowEconomy
 * for their assignments. Instead, the flow solution IS the corps.
 */

import {
  FlowSolution,
  MinerAssignment,
  HaulerAssignment,
  SinkAllocation,
} from "./FlowTypes";

// =============================================================================
// NODE FLOW TYPE
// =============================================================================

/**
 * NodeFlow represents all economic activity for a single territory node.
 *
 * A node contains:
 * - Sources that are mined (miners)
 * - Edges that transport energy out (haulers)
 * - Sinks that consume energy (controller, construction, storage)
 *
 * This groups the flat FlowSolution into a hierarchical structure
 * that maps directly to corps.
 */
export interface NodeFlow {
  /** Node (territory) ID */
  nodeId: string;

  /** Room name (derived from nodeId or first miner) */
  roomName: string;

  /** Miner assignments for sources in this node */
  miners: MinerAssignment[];

  /** Hauler assignments for edges originating from this node's sources */
  haulers: HaulerAssignment[];

  /** Sink allocations for sinks in this node */
  sinks: SinkAllocation[];

  /** Total energy harvested in this node (sum of miner harvestRates) */
  totalHarvest: number;

  /** Total energy flowing out of this node (sum of hauler flowRates) */
  totalOutflow: number;

  /** Total energy consumed by sinks in this node */
  totalConsumption: number;

  /** Spawn IDs serving this node (for creep spawning) */
  spawnIds: Set<string>;
}

/**
 * NodeFlowMap indexes NodeFlows by nodeId for fast lookup.
 */
export type NodeFlowMap = Map<string, NodeFlow>;

// =============================================================================
// GROUPING FUNCTION
// =============================================================================

/**
 * Groups a FlowSolution by node to create NodeFlows.
 *
 * This transforms the flat solution into a hierarchical structure:
 * - Each node gets its own NodeFlow
 * - Miners are grouped by their nodeId
 * - Haulers are grouped by the source's nodeId (origin of flow)
 * - Sinks are grouped by their nodeId
 *
 * @param solution - The flow solution from FlowSolver
 * @param sourceNodeMap - Map of sourceId → nodeId (from FlowGraph)
 * @param sinkNodeMap - Map of sinkId → nodeId (from FlowGraph)
 * @returns Map of nodeId → NodeFlow
 */
export function groupByNode(
  solution: FlowSolution,
  sourceNodeMap: Map<string, string>,
  sinkNodeMap: Map<string, string>
): NodeFlowMap {
  const nodeFlows: NodeFlowMap = new Map();

  // Helper to get or create a NodeFlow
  const getOrCreateNodeFlow = (nodeId: string): NodeFlow => {
    let nodeFlow = nodeFlows.get(nodeId);
    if (!nodeFlow) {
      nodeFlow = {
        nodeId,
        roomName: extractRoomName(nodeId),
        miners: [],
        haulers: [],
        sinks: [],
        totalHarvest: 0,
        totalOutflow: 0,
        totalConsumption: 0,
        spawnIds: new Set(),
      };
      nodeFlows.set(nodeId, nodeFlow);
    }
    return nodeFlow;
  };

  // Group miners by node
  for (const miner of solution.miners) {
    const nodeFlow = getOrCreateNodeFlow(miner.nodeId);
    nodeFlow.miners.push(miner);
    nodeFlow.totalHarvest += miner.harvestRate;
    nodeFlow.spawnIds.add(miner.spawnId);
  }

  // Group haulers by source node (where energy originates)
  for (const hauler of solution.haulers) {
    // fromId is the source ID; look up its node
    const sourceNodeId = sourceNodeMap.get(hauler.fromId);
    if (sourceNodeId) {
      const nodeFlow = getOrCreateNodeFlow(sourceNodeId);
      nodeFlow.haulers.push(hauler);
      nodeFlow.totalOutflow += hauler.flowRate;
      nodeFlow.spawnIds.add(hauler.spawnId);
    }
  }

  // Group sink allocations by node
  for (const sink of solution.sinkAllocations) {
    const sinkNodeId = sinkNodeMap.get(sink.sinkId);
    if (sinkNodeId) {
      const nodeFlow = getOrCreateNodeFlow(sinkNodeId);
      nodeFlow.sinks.push(sink);
      nodeFlow.totalConsumption += sink.allocated;
    }
  }

  return nodeFlows;
}

/**
 * Extract room name from node ID.
 * Node IDs are typically formatted as "roomName-xxx" or similar.
 */
function extractRoomName(nodeId: string): string {
  // Try to extract room name (e.g., "W1N1-peak-0" → "W1N1")
  const parts = nodeId.split("-");
  if (parts.length > 0) {
    // Check if first part looks like a room name
    const roomPattern = /^[WE]\d+[NS]\d+$/;
    if (roomPattern.test(parts[0])) {
      return parts[0];
    }
  }
  return nodeId;
}

// =============================================================================
// QUERY FUNCTIONS
// =============================================================================

/**
 * Get all node IDs that have active flows.
 */
export function getActiveNodeIds(nodeFlows: NodeFlowMap): string[] {
  return Array.from(nodeFlows.keys());
}

/**
 * Get total CARRY parts needed for a node's hauling.
 */
export function getTotalCarryParts(nodeFlow: NodeFlow): number {
  return nodeFlow.haulers.reduce((sum, h) => sum + h.carryParts, 0);
}

/**
 * Get the primary spawn for a node (first spawn serving it).
 */
export function getPrimarySpawn(nodeFlow: NodeFlow): string | undefined {
  return nodeFlow.spawnIds.values().next().value;
}

/**
 * Get sink allocation for a specific sink type in a node.
 */
export function getSinkAllocationByType(
  nodeFlow: NodeFlow,
  sinkType: string
): SinkAllocation | undefined {
  return nodeFlow.sinks.find(s => s.sinkType === sinkType);
}

/**
 * Check if a node is self-sustaining (harvest covers overhead + consumption).
 */
export function isNodeSelfSustaining(nodeFlow: NodeFlow): boolean {
  // A node is self-sustaining if its harvest is enough for its consumption
  // This is a simplified check; full sustainability includes spawn overhead
  return nodeFlow.totalHarvest >= nodeFlow.totalConsumption;
}

// =============================================================================
// DEBUGGING
// =============================================================================

/**
 * Print a NodeFlow summary for debugging.
 */
export function printNodeFlow(nodeFlow: NodeFlow): void {
  console.log(`\n=== NodeFlow: ${nodeFlow.nodeId} (${nodeFlow.roomName}) ===`);
  console.log(`  Harvest: ${nodeFlow.totalHarvest.toFixed(2)} e/tick`);
  console.log(`  Outflow: ${nodeFlow.totalOutflow.toFixed(2)} e/tick`);
  console.log(`  Consumption: ${nodeFlow.totalConsumption.toFixed(2)} e/tick`);
  console.log(`  Spawns: ${Array.from(nodeFlow.spawnIds).join(", ")}`);

  console.log(`\n  Miners (${nodeFlow.miners.length}):`);
  for (const m of nodeFlow.miners) {
    console.log(`    ${m.sourceId.slice(-8)}: ${m.harvestRate} e/tick`);
  }

  console.log(`\n  Haulers (${nodeFlow.haulers.length}):`);
  for (const h of nodeFlow.haulers) {
    console.log(`    ${h.fromId.slice(-8)} → ${h.toId.slice(-8)}: ${h.carryParts}C, ${h.flowRate.toFixed(2)} e/tick`);
  }

  console.log(`\n  Sinks (${nodeFlow.sinks.length}):`);
  for (const s of nodeFlow.sinks) {
    console.log(`    ${s.sinkType}[${s.sinkId.slice(-8)}]: ${s.allocated.toFixed(2)}/${s.demand.toFixed(2)} e/tick`);
  }
}

/**
 * Print all NodeFlows summary.
 */
export function printAllNodeFlows(nodeFlows: NodeFlowMap): void {
  console.log(`\n=== NodeFlow Summary (${nodeFlows.size} nodes) ===`);
  for (const nodeFlow of nodeFlows.values()) {
    printNodeFlow(nodeFlow);
  }
}
