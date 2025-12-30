/**
 * FlowMaterializer - Converts Flow Solution to Corps
 *
 * This module bridges the gap between flow planning and execution by
 * materializing the abstract FlowSolution into concrete Corps that
 * manage creeps.
 *
 * Key insight: Instead of corps querying FlowEconomy for their assignments,
 * the flow solution IS materialized into corps. Corps store their
 * assignments directly and execute based on them.
 *
 * Flow:
 *   FlowSolution → groupByNode() → NodeFlow[] → materializeCorps() → CorpRegistry
 */

import { CorpRegistry } from "../execution/CorpRunner";
import { HarvestCorp } from "../corps/HarvestCorp";
import { CarryCorp } from "../corps/CarryCorp";
import { UpgradingCorp } from "../corps/UpgradingCorp";
import { SpawningCorp } from "../corps/SpawningCorp";
import { ConstructionCorp } from "../corps/ConstructionCorp";
import {
  FlowSolution,
  MinerAssignment,
  HaulerAssignment,
  SinkAllocation,
} from "./FlowTypes";
import { NodeFlow, NodeFlowMap, groupByNode } from "./NodeFlow";
import { FlowGraph } from "./FlowGraph";

// =============================================================================
// MATERIALIZATION RESULT
// =============================================================================

/**
 * Result of materializing flow solution into corps.
 */
export interface MaterializationResult {
  /** Tick when materialization occurred */
  tick: number;

  /** Number of HarvestCorps updated */
  harvestCorpsUpdated: number;

  /** Number of CarryCorps updated */
  carryCorpsUpdated: number;

  /** Number of UpgradingCorps updated */
  upgradingCorpsUpdated: number;

  /** Number of ConstructionCorps updated */
  constructionCorpsUpdated: number;

  /** Number of new corps created */
  newCorpsCreated: number;

  /** Warnings during materialization */
  warnings: string[];
}

// =============================================================================
// MAIN MATERIALIZATION FUNCTION
// =============================================================================

/**
 * Materialize a FlowSolution into the CorpRegistry.
 *
 * This is the main entry point for converting flow planning results
 * into executable corps. It:
 *
 * 1. Groups the solution by node (territory)
 * 2. For each node, updates or creates corps with their assignments
 * 3. Corps store assignments directly (no runtime querying)
 *
 * @param solution - The solved flow allocation
 * @param graph - The flow graph (for node lookups)
 * @param corps - The corp registry to update
 * @param tick - Current game tick
 */
export function materializeCorps(
  solution: FlowSolution,
  graph: FlowGraph,
  corps: CorpRegistry,
  tick: number
): MaterializationResult {
  const result: MaterializationResult = {
    tick,
    harvestCorpsUpdated: 0,
    carryCorpsUpdated: 0,
    upgradingCorpsUpdated: 0,
    constructionCorpsUpdated: 0,
    newCorpsCreated: 0,
    warnings: [],
  };

  // Build source/sink → node maps from graph
  const sourceNodeMap = buildSourceNodeMap(graph);
  const sinkNodeMap = buildSinkNodeMap(graph);

  // Group solution by node
  const nodeFlows = groupByNode(solution, sourceNodeMap, sinkNodeMap);

  // Materialize each node flow into corps
  for (const nodeFlow of nodeFlows.values()) {
    materializeNodeFlow(nodeFlow, corps, tick, result);
  }

  // Clean up stale corps that are no longer in the flow solution
  // This removes HarvestCorps for sources that were filtered out (e.g., SK rooms)
  const cleanupResult = cleanupStaleCorps(nodeFlows, corps);

  console.log(`[FlowMaterializer] Materialized ${nodeFlows.size} node flows into corps`);
  console.log(`  Harvest: ${result.harvestCorpsUpdated}, Carry: ${result.carryCorpsUpdated}`);
  console.log(`  Upgrading: ${result.upgradingCorpsUpdated}, Construction: ${result.constructionCorpsUpdated}`);
  if (cleanupResult.removed > 0) {
    console.log(`  Cleaned up: ${cleanupResult.removed} stale corps`);
  }

  if (result.warnings.length > 0) {
    console.log(`  Warnings: ${result.warnings.join(", ")}`);
  }

  return result;
}

/**
 * Build a map of sourceId → nodeId from the flow graph.
 */
function buildSourceNodeMap(graph: FlowGraph): Map<string, string> {
  const map = new Map<string, string>();
  for (const source of graph.getSources()) {
    map.set(source.id, source.nodeId);
  }
  return map;
}

/**
 * Build a map of sinkId → nodeId from the flow graph.
 */
function buildSinkNodeMap(graph: FlowGraph): Map<string, string> {
  const map = new Map<string, string>();
  for (const sink of graph.getSinks()) {
    map.set(sink.id, sink.nodeId);
  }
  return map;
}

// =============================================================================
// NODE FLOW MATERIALIZATION
// =============================================================================

/**
 * Materialize a single NodeFlow into corps.
 *
 * Each NodeFlow becomes:
 * - One HarvestCorp per source (miner assignment)
 * - One CarryCorp per source-to-sink edge (hauler assignment)
 * - One UpgradingCorp if there's a controller sink
 * - One ConstructionCorp if there are construction sinks
 */
function materializeNodeFlow(
  nodeFlow: NodeFlow,
  corps: CorpRegistry,
  tick: number,
  result: MaterializationResult
): void {
  const roomName = nodeFlow.roomName;
  const room = Game.rooms[roomName];

  // Materialize HarvestCorps from miner assignments (works for remote rooms too)
  // Each miner assignment has its own spawnId
  // Note: Profitability filtering is done in the flow solver, not here
  for (const miner of nodeFlow.miners) {
    materializeHarvestCorp(miner, corps, tick, result);
  }

  // Materialize one CarryCorp per hauler assignment (per source-to-sink edge)
  // This allows independent scaling of haulers per source
  for (const hauler of nodeFlow.haulers) {
    materializeCarryCorpForSource(hauler, corps, tick, result);
  }

  // Upgrading and construction only in rooms we own
  if (room && room.controller?.my) {
    const spawn = room.find(FIND_MY_SPAWNS)[0];
    if (spawn) {
      // Materialize UpgradingCorp from controller sink
      const controllerSink = nodeFlow.sinks.find(s => s.sinkType === "controller");
      if (controllerSink) {
        materializeUpgradingCorp(controllerSink, room, spawn, corps, tick, result);
      }

      // Materialize ConstructionCorp from construction sinks
      const constructionSinks = nodeFlow.sinks.filter(s => s.sinkType === "construction");
      if (constructionSinks.length > 0) {
        materializeConstructionCorp(constructionSinks, room, spawn, corps, tick, result);
      }
    }
  }
}

// =============================================================================
// CORP-SPECIFIC MATERIALIZATION
// =============================================================================

/**
 * Materialize a HarvestCorp from a MinerAssignment.
 */
function materializeHarvestCorp(
  miner: MinerAssignment,
  corps: CorpRegistry,
  tick: number,
  result: MaterializationResult
): void {
  // Extract source game ID from flow source ID (e.g., "source-abc123" → "abc123")
  const sourceGameId = miner.sourceId.replace("source-", "");

  // Extract spawn game ID from flow sink ID (e.g., "spawn-abc123" → "abc123")
  const spawnGameId = miner.spawnId.replace("spawn-", "");

  // Get spawn for this miner
  const spawn = Game.getObjectById(spawnGameId as Id<StructureSpawn>);
  if (!spawn) {
    result.warnings.push(`Spawn ${miner.spawnId} not found for source ${sourceGameId.slice(-4)}`);
    return;
  }

  let harvestCorp = corps.harvestCorps[sourceGameId];

  if (!harvestCorp) {
    // Check if this is an intel-based source (remote room without vision)
    const isIntelSource = sourceGameId.startsWith("intel-");

    // Extract room name: from nodeId (e.g., "E27S12-36-39" → "E27S12")
    // or from live source if available
    let roomName: string;

    if (isIntelSource) {
      // Intel source: extract room name from nodeId (format: "ROOMNAME-X-Y")
      roomName = miner.nodeId.split("-").slice(0, 1).join("");
      // Handle room names like "E27S12" which don't have hyphens
      const match = miner.nodeId.match(/^([EW]\d+[NS]\d+)/);
      if (match) {
        roomName = match[1];
      }
    } else {
      // Live source: get from game object
      const source = Game.getObjectById(sourceGameId as Id<Source>);
      if (!source) {
        result.warnings.push(`Source ${sourceGameId} not found`);
        return;
      }
      roomName = source.room.name;
    }

    // Use consistent nodeId format: roomName-harvest-sourceIdSuffix
    // This must match createHarvestCorp() format for proper creep association
    const nodeId = `${roomName}-harvest-${sourceGameId.slice(-4)}`;
    harvestCorp = new HarvestCorp(nodeId, spawnGameId, sourceGameId);
    harvestCorp.createdAt = tick;
    corps.harvestCorps[sourceGameId] = harvestCorp;
    result.newCorpsCreated++;
    console.log(`[FlowMaterializer] Created HarvestCorp for ${sourceGameId.slice(-4)} in ${roomName}`);
  }

  // Update the corp with its miner assignment
  harvestCorp.setMinerAssignment(miner);
  result.harvestCorpsUpdated++;
}

/**
 * Materialize a CarryCorp for a specific source-to-sink edge (HaulerAssignment).
 * Each source gets its own CarryCorp so haulers can be independently scaled.
 */
function materializeCarryCorpForSource(
  hauler: HaulerAssignment,
  corps: CorpRegistry,
  tick: number,
  result: MaterializationResult
): void {
  // Extract source game ID from flow source ID (e.g., "source-abc123" → "abc123")
  const sourceGameId = hauler.fromId.replace("source-", "");

  // Extract spawn game ID from flow sink ID (e.g., "spawn-abc123" → "abc123")
  const spawnGameId = hauler.spawnId.replace("spawn-", "");
  const spawn = Game.getObjectById(spawnGameId as Id<StructureSpawn>);

  if (!spawn) {
    result.warnings.push(`Spawn ${spawnGameId.slice(-4)} not found for haulers serving ${sourceGameId.slice(-4)}`);
    return;
  }

  // Key by source ID so each source has its own CarryCorp
  let carryCorp = corps.haulingCorps[sourceGameId];

  if (!carryCorp) {
    // Create new CarryCorp for this source
    // Use source-based nodeId for proper creep association
    const nodeId = `${spawn.room.name}-hauling-${sourceGameId.slice(-4)}`;
    carryCorp = new CarryCorp(nodeId, spawn.id);
    carryCorp.createdAt = tick;
    corps.haulingCorps[sourceGameId] = carryCorp;
    result.newCorpsCreated++;
    console.log(`[FlowMaterializer] Created CarryCorp for source ${sourceGameId.slice(-4)}`);
  }

  // Update with this source's hauler assignment (single assignment per corp)
  carryCorp.setHaulerAssignments([hauler]);
  result.carryCorpsUpdated++;
}

/**
 * Materialize an UpgradingCorp from a controller SinkAllocation.
 */
function materializeUpgradingCorp(
  controllerSink: SinkAllocation,
  room: Room,
  spawn: StructureSpawn,
  corps: CorpRegistry,
  tick: number,
  result: MaterializationResult
): void {
  const roomName = room.name;

  let upgradingCorp = corps.upgradingCorps[roomName];

  if (!upgradingCorp) {
    // Create new UpgradingCorp
    const nodeId = `${roomName}-upgrading`;
    upgradingCorp = new UpgradingCorp(nodeId, spawn.id);
    upgradingCorp.createdAt = tick;
    corps.upgradingCorps[roomName] = upgradingCorp;
    result.newCorpsCreated++;
    console.log(`[FlowMaterializer] Created UpgradingCorp for ${roomName}`);
  }

  // Update with controller allocation
  upgradingCorp.setSinkAllocation(controllerSink);
  result.upgradingCorpsUpdated++;
}

/**
 * Materialize a ConstructionCorp from construction SinkAllocations.
 */
function materializeConstructionCorp(
  constructionSinks: SinkAllocation[],
  room: Room,
  spawn: StructureSpawn,
  corps: CorpRegistry,
  tick: number,
  result: MaterializationResult
): void {
  const roomName = room.name;

  let constructionCorp = corps.constructionCorps[roomName];

  if (!constructionCorp) {
    // Create new ConstructionCorp
    const nodeId = `${roomName}-construction`;
    constructionCorp = new ConstructionCorp(nodeId, spawn.id);
    constructionCorp.createdAt = tick;
    corps.constructionCorps[roomName] = constructionCorp;
    result.newCorpsCreated++;
    console.log(`[FlowMaterializer] Created ConstructionCorp for ${roomName}`);
  }

  // Update with construction allocations
  constructionCorp.setConstructionAllocations(constructionSinks);
  result.constructionCorpsUpdated++;
}

// =============================================================================
// CLEANUP FUNCTIONS
// =============================================================================

/**
 * Remove corps that are no longer in the flow solution.
 * Call this after materialization to clean up stale corps.
 */
export function cleanupStaleCorps(
  nodeFlows: NodeFlowMap,
  corps: CorpRegistry
): { removed: number } {
  let removed = 0;

  // Build set of active source IDs (used by both HarvestCorps and CarryCorps)
  const activeSourceIds = new Set<string>();
  for (const nodeFlow of nodeFlows.values()) {
    for (const miner of nodeFlow.miners) {
      const sourceGameId = miner.sourceId.replace("source-", "");
      activeSourceIds.add(sourceGameId);
    }
    // Also track sources from hauler assignments
    for (const hauler of nodeFlow.haulers) {
      const sourceGameId = hauler.fromId.replace("source-", "");
      activeSourceIds.add(sourceGameId);
    }
  }

  // Remove HarvestCorps not in flow (from both registry AND Memory to prevent re-hydration)
  for (const sourceId in corps.harvestCorps) {
    if (!activeSourceIds.has(sourceId)) {
      delete corps.harvestCorps[sourceId];
      // Also remove from Memory to prevent re-hydration on next tick
      if (typeof Memory !== "undefined" && Memory.harvestCorps) {
        delete Memory.harvestCorps[sourceId];
      }
      removed++;
      console.log(`[FlowMaterializer] Removed stale HarvestCorp for ${sourceId.slice(-4)}`);
    }
  }

  // Remove CarryCorps not in flow (keyed by source ID)
  for (const sourceId in corps.haulingCorps) {
    if (!activeSourceIds.has(sourceId)) {
      delete corps.haulingCorps[sourceId];
      // Also remove from Memory to prevent re-hydration on next tick
      if (typeof Memory !== "undefined" && Memory.haulingCorps) {
        delete Memory.haulingCorps[sourceId];
      }
      removed++;
      console.log(`[FlowMaterializer] Removed stale CarryCorp for ${sourceId.slice(-4)}`);
    }
  }

  return { removed };
}
