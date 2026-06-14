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

import { FlowSolution, HaulerAssignment, SinkAllocation } from "./FlowTypes";
import { NodeFlow, groupByNode } from "./NodeFlow";
import { ConstructionCorp } from "../corps/ConstructionCorp";
import { REPAIR_TO } from "../corps/repair";
import { CorpRegistry } from "../execution/CorpRunner";
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
    warnings: []
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

  // Harvest/carry/upgrade corps (and their stale-cleanup) are owned by
  // CommissionHost now; FlowMaterializer only materializes construction.
  console.log(
    `[FlowMaterializer] Materialized ${nodeFlows.size} node flows; construction ${result.constructionCorpsUpdated}`
  );

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

/**
 * Group hauler assignments by their source, keeping only sources that have a
 * miner (per `hasMiner`). Sources with haulers but no miner are returned in
 * `orphaned` so the caller can drop them - a hauler with no miner has nothing to
 * pick up. Pure, so the gate can be unit tested directly.
 */
export function groupHaulersByMinedSource(
  haulers: HaulerAssignment[],
  hasMiner: (sourceId: string) => boolean
): { bySource: Map<string, HaulerAssignment[]>; orphaned: string[] } {
  const bySource = new Map<string, HaulerAssignment[]>();
  const orphaned = new Set<string>();
  for (const hauler of haulers) {
    const src = hauler.fromId.replace("source-", "");
    // A scavenger serves a transient ground stock, which intentionally has no
    // miner (the energy is already harvested) - so it is never orphaned.
    if (!src.startsWith("scavenge-") && !hasMiner(src)) {
      orphaned.add(src);
      continue;
    }
    const list = bySource.get(src);
    if (list) list.push(hauler);
    else bySource.set(src, [hauler]);
  }
  return { bySource, orphaned: [...orphaned] };
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

  // Harvest, carry, and upgrade corps are framework-commissioned now:
  // CommissionHost drives them from the planner's commissions
  // (FlowEconomy.getCommissions), so FlowMaterializer no longer creates them.
  // Construction stays here until it ports.
  if (room && room.controller?.my) {
    const spawn = room.find(FIND_MY_SPAWNS)[0];
    if (spawn) {
      // Materialize the ConstructionCorp when there is something to build, OR keep
      // one alive to MAINTAIN containers: containers decay and need periodic repair
      // even in a fully-built room with no construction sinks, so the corp must
      // exist there too (it self-recycles its builder once all containers are full).
      const constructionSinks = nodeFlow.sinks.filter(s => s.sinkType === "construction");
      const decayingContainer =
        room.find(FIND_STRUCTURES, {
          filter: s => s.structureType === STRUCTURE_CONTAINER && s.hits < s.hitsMax * REPAIR_TO
        }).length > 0;
      if (constructionSinks.length > 0 || decayingContainer) {
        materializeConstructionCorp(constructionSinks, room, spawn, corps, tick, result);
      }
    }
  }
}

// =============================================================================
// CORP-SPECIFIC MATERIALIZATION
// =============================================================================

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
