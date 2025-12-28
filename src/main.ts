/**
 * @fileoverview Main game loop entry point.
 *
 * This is the entry point for the Screeps AI. It orchestrates the colony
 * using a flow-based economic system.
 *
 * ## Phased Architecture
 *
 * ### EVERY TICK (execution)
 * 1. INIT: Lazy hydration from Memory (once per code push)
 * 2. EXECUTE: Run all corps (spawning, mining, hauling, upgrading, etc.)
 * 3. PERSIST: Save state to Memory
 *
 * ### EVERY 5000 TICKS (planning)
 * 1. SURVEY: Analyze territory, create corps from node resources
 * 2. FLOW: Solve optimal energy allocation (sources -> sinks)
 * 3. MATERIALIZE: Update corps with flow assignments
 *
 * ## Key Components
 * - Colony: Economic coordinator (treasury, surveying)
 * - Nodes: Territory-based regions (from spatial peak detection)
 * - Corps: Business units that execute flow assignments
 * - FlowEconomy: Solver for optimal energy routing
 *
 * ## Console Commands
 * - global.survey() - Force run survey phase
 * - global.plan() - Force run flow economy planning
 * - global.status() - Show orchestration status
 * - global.flowStatus() - Show flow economy details
 *
 * @module main
 */

import { Colony, createColony } from "./colony";
import { deserializeNode, SerializedNode, createNodeNavigator, NodeNavigator, EdgeType } from "./nodes";
import { FlowEconomy, PriorityContext, PriorityManager, materializeCorps } from "./flow";
import { ErrorMapper } from "./utils";
import { getTelemetry } from "./telemetry";
import {
  CorpRegistry,
  createCorpRegistry,
  runBootstrapCorps,
  runRealCorps,
  runScoutCorps,
  runConstructionCorps,
  runSpawningCorps,
  logCorpStats,
  persistState,
  cleanupDeadCreeps,
  getAnalysisCache,
  isAnalysisInProgress,
  resetAnalysis,
  restoreVisualizationCache,
  runIncrementalAnalysis,
  renderNodeVisuals,
  renderSpatialVisuals,
  requestFlowCreeps,
} from "./execution";
import {
  initCorps,
  shouldRunPlanning,
  runSurveyPhase,
  PLANNING_INTERVAL,
  loadContracts,
  loadChains,
  setLastPlanningTick,
  setLastSurveyTick,
} from "./orchestration";
import "./types/Memory";

// =============================================================================
// GLOBALS
// =============================================================================

declare global {
  namespace NodeJS {
    interface Global {
      log: any;
      colony: Colony | undefined;
      corps: CorpRegistry;
      // Flow economy (new integration)
      flowEconomy: FlowEconomy | undefined;
      nodeNavigator: NodeNavigator | undefined;
      // Orchestration commands
      survey: () => void;
      plan: () => void;
      status: () => void;
      flowStatus: () => void;
      // Legacy commands
      recalculateTerrain: () => void;
      resetAnalysis: () => void;
      showNodes: () => void;
      exportNodes: () => string;
      forgiveDebt: (amount?: number) => void;
      clearSpawnQueue: () => void;
      marketStatus: () => void;
    }
  }
}

/** The colony instance (persisted across ticks) */
let colony: Colony | undefined;

/** Node navigator for pathfinding (created from persisted edges) */
let nodeNavigator: NodeNavigator | undefined;

/** Flow economy coordinator (replaces market-based allocation) */
let flowEconomy: FlowEconomy | undefined;

/** All active corps */
let corps: CorpRegistry = createCorpRegistry();

// =============================================================================
// MAIN GAME LOOP
// =============================================================================

/**
 * Main game loop - executed every tick.
 *
 * ## Phased Execution
 *
 * ### Every Tick
 * 1. INIT: Lazy hydration from Memory (once per code push)
 * 2. EXECUTE: Run all corps
 * 3. PERSIST: Save state
 *
 * ### Every 5000 Ticks (Planning Phase)
 * 1. SURVEY: Analyze territory, create corps from node resources
 * 2. MARKET: Register offers, run market clearing
 * 3. PLAN: Find optimal chains, store contracts
 *
 * Wrapped with ErrorMapper to catch and log errors without crashing.
 */
export const loop = ErrorMapper.wrapLoop(() => {
  // ===========================================================================
  // PHASE 0: INIT - Lazy initialization (once per code push)
  // ===========================================================================

  // Initialize corps from Memory if cache is empty (after code push)
  // This is a no-op if corps are already in the global cache
  initCorps(corps);

  // Initialize or restore colony (needed for planning and persistence)
  colony = getOrCreateColony();

  // Initialize or restore flow economy (node navigator + flow solver)
  if (!nodeNavigator || !flowEconomy) {
    const result = getOrCreateFlowEconomy(colony);
    nodeNavigator = result.navigator;
    flowEconomy = result.economy;
  }

  // Make state available globally for debugging
  global.colony = colony;
  global.corps = corps;
  global.flowEconomy = flowEconomy;
  global.nodeNavigator = nodeNavigator;

  // ===========================================================================
  // PHASE 1: EXECUTE - Run all corps (every tick)
  // ===========================================================================

  // Run spawning corps first (they process pending spawn orders)
  runSpawningCorps(corps);

  // Run other corps (bootstrap, mining, hauling, upgrading, scouts, construction)
  runBootstrapCorps(corps);
  runRealCorps(corps);
  runScoutCorps(corps);
  runConstructionCorps(corps);

  // ===========================================================================
  // INCREMENTAL ANALYSIS - Continue if in progress (runs across multiple ticks)
  // ===========================================================================

  // Continue incremental analysis if one is in progress
  // This must happen OUTSIDE the planning phase check to spread across ticks
  if (isAnalysisInProgress()) {
    runIncrementalAnalysis(colony);
  }

  // Fresh respawn detection: if no nodes exist and no analysis in progress,
  // start terrain analysis immediately (don't wait for planning interval)
  const hasNoNodes = colony.getNodes().length === 0 &&
    (!Memory.nodes || Object.keys(Memory.nodes).length === 0);
  if (hasNoNodes && !isAnalysisInProgress()) {
    console.log(`[Respawn] No nodes in memory - starting terrain analysis immediately`);
    runIncrementalAnalysis(colony);
  }

  // ===========================================================================
  // PHASE 2: PLANNING - Survey, Market, Plan (every 5000 ticks)
  // ===========================================================================

  if (shouldRunPlanning(Game.time)) {
    console.log(`[Planning] Starting planning phase at tick ${Game.time}`);

    // --- SURVEY: Analyze territory and create corps ---
    // Start incremental multi-room spatial analysis if no nodes exist
    if (colony.getNodes().length === 0 && !isAnalysisInProgress()) {
      runIncrementalAnalysis(colony);
    }

    // Run the colony economic coordination (surveying, stats)
    colony.run(Game.time, corps);

    // --- FLOW ECONOMY: Update allocations based on game state ---
    // Rebuild flow economy if nodes have changed
    if (flowEconomy && colony.getNodes().length > 0) {
      // Rebuild if node count changed (new nodes discovered)
      const currentNodeCount = colony.getNodes().length;
      if (flowEconomy.getFlowGraph().getSources().length === 0 && currentNodeCount > 0) {
        console.log(`[FlowEconomy] Rebuilding graph with ${currentNodeCount} nodes`);
        flowEconomy.rebuild(colony.getNodes());
      }

      // Build priority context from game state
      const context = buildPriorityContext(corps);
      flowEconomy.update(context, true); // Force update during planning

      // Log flow economy status
      const solution = flowEconomy.getSolution();
      if (solution) {
        console.log(`[FlowEconomy] Solved: ${solution.miners.length} miners, ${solution.haulers.length} haulers`);
        console.log(`[FlowEconomy] Efficiency: ${solution.efficiency.toFixed(1)}%, Sustainable: ${solution.isSustainable}`);
        if (solution.warnings.length > 0) {
          console.log(`[FlowEconomy] Warnings: ${solution.warnings.join(", ")}`);
        }

        // Materialize flow solution into corps
        // This replaces corps querying FlowEconomy - corps ARE the flow now
        const graph = flowEconomy.getFlowGraph();
        const result = materializeCorps(solution, graph, corps, Game.time);
        console.log(`[FlowEconomy] Materialized: ${result.harvestCorpsUpdated} harvest, ${result.carryCorpsUpdated} carry, ${result.upgradingCorpsUpdated} upgrading corps`);
      }
    }

    setLastPlanningTick(Game.time);
    console.log(`[Planning] Complete`);
  }

  // Request creeps from SpawningCorp based on flow assignments
  // Runs AFTER planning so materialized assignments are available
  // Priority: miners first, then haulers, then upgraders
  requestFlowCreeps(corps);

  // ===========================================================================
  // PHASE 3: PERSIST - Save state and update telemetry (every tick)
  // ===========================================================================

  // Persist all state
  persistState(colony, corps, getAnalysisCache());

  // Update telemetry (write to RawMemory segments for external monitoring)
  updateTelemetry(colony, corps);

  // Restore visualization cache from memory if needed (avoids expensive analysis)
  restoreVisualizationCache(colony);

  // Render node visualization
  renderNodeVisuals(colony);

  // Render spatial visualization (territories, edges) for rooms with visual* flags
  renderSpatialVisuals(getAnalysisCache());

  // Clean up memory for dead creeps
  cleanupDeadCreeps();

  // Log stats periodically
  if (Game.time % 100 === 0) {
    logStats(colony, corps);
  }
});

// =============================================================================
// COLONY MANAGEMENT
// =============================================================================

/**
 * Gets existing colony or creates a new one.
 *
 * Restores colony state from memory if available.
 */
function getOrCreateColony(): Colony {
  if (colony) {
    return colony;
  }

  const newColony = createColony();

  // Restore from memory if available
  if (Memory.colony) {
    newColony.deserialize(Memory.colony);
  }

  // Restore nodes from memory
  if (Memory.nodes) {
    for (const nodeId in Memory.nodes) {
      const serializedNode = Memory.nodes[nodeId] as SerializedNode;
      if (serializedNode && serializedNode.peakPosition) {
        const node = deserializeNode(serializedNode);
        newColony.addNode(node);
      }
    }
    console.log(`[Colony] Restored ${newColony.getNodes().length} nodes from memory`);
  }

  return newColony;
}

// =============================================================================
// FLOW ECONOMY MANAGEMENT
// =============================================================================

/**
 * Creates or restores the flow economy from persisted edges.
 *
 * The flow economy requires:
 * 1. NodeNavigator - for pathfinding between nodes
 * 2. FlowEconomy - for solving optimal energy allocation
 *
 * Edges are restored from Memory.nodeEdges (spatial) and Memory.economicEdges.
 */
function getOrCreateFlowEconomy(colony: Colony): {
  navigator: NodeNavigator;
  economy: FlowEconomy;
} {
  const nodes = colony.getNodes();

  // Build edge weights and types from persisted data
  const edgeWeights = new Map<string, number>();
  const edgeTypes = new Map<string, EdgeType>();
  const allEdges: string[] = [];

  // Add spatial edges (weight defaults to 1, or estimate from positions)
  if (Memory.nodeEdges) {
    for (const edgeKey of Memory.nodeEdges) {
      allEdges.push(edgeKey);
      // Default weight 1 for spatial edges (actual walking distance computed by skeleton builder)
      edgeWeights.set(edgeKey, 1);
      edgeTypes.set(edgeKey, "spatial");
    }
  }

  // Add economic edges with persisted weights
  if (Memory.economicEdges) {
    for (const edgeKey in Memory.economicEdges) {
      if (!allEdges.includes(edgeKey)) {
        allEdges.push(edgeKey);
      }
      const weight = Memory.economicEdges[edgeKey];
      edgeWeights.set(edgeKey, weight);
      edgeTypes.set(edgeKey, "economic");
    }
  }

  // Create navigator
  const navigator = createNodeNavigator(nodes, allEdges, edgeWeights, edgeTypes);

  // Create flow economy
  const economy = new FlowEconomy(nodes, navigator);

  if (nodes.length > 0) {
    console.log(`[FlowEconomy] Created with ${nodes.length} nodes, ${allEdges.length} edges`);
    console.log(`[FlowEconomy] Sources: ${economy.getFlowGraph().getSources().length}, Sinks: ${economy.getFlowGraph().getSinks().length}`);
  }

  return { navigator, economy };
}

/**
 * Builds a PriorityContext from current game state.
 *
 * This context is used by the flow economy to calculate dynamic
 * sink priorities (e.g., higher priority for towers during attack).
 */
function buildPriorityContext(corps: CorpRegistry): PriorityContext {
  // Find the first owned room to use as context
  let targetRoom: Room | undefined;
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.controller?.my) {
      targetRoom = room;
      break;
    }
  }

  if (!targetRoom) {
    // Return mock context if no owned rooms
    return PriorityManager.createMockContext({ tick: Game.time });
  }

  const controller = targetRoom.controller;
  const storage = targetRoom.storage;
  const hostiles = targetRoom.find(FIND_HOSTILE_CREEPS);
  const sites = targetRoom.find(FIND_CONSTRUCTION_SITES);

  // Calculate extension energy
  const extensions = targetRoom.find(FIND_MY_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_EXTENSION
  }) as StructureExtension[];

  let extensionEnergy = 0;
  let extensionCapacity = 0;
  for (const ext of extensions) {
    extensionEnergy += ext.store[RESOURCE_ENERGY];
    extensionCapacity += ext.store.getCapacity(RESOURCE_ENERGY);
  }

  // Calculate spawn queue size from spawning corps
  let spawnQueueSize = 0;
  for (const spawnId in corps.spawningCorps) {
    spawnQueueSize += corps.spawningCorps[spawnId].getPendingOrderCount();
  }

  // Track RCL upgrade time (using memory if available)
  const lastRclUpTick = Memory.lastRclUpTick ?? 0;
  const ticksSinceRclUp = Game.time - lastRclUpTick;

  return {
    tick: Game.time,
    rcl: controller?.level ?? 0,
    rclProgress: controller
      ? controller.progress / controller.progressTotal
      : 0,
    constructionSites: sites.length,
    hostileCreeps: hostiles.length,
    storageEnergy: storage?.store[RESOURCE_ENERGY] ?? 0,
    spawnQueueSize,
    underAttack: hostiles.length > 0,
    ticksSinceRclUp,
    extensionEnergy,
    extensionCapacity,
  };
}

// =============================================================================
// TELEMETRY & STATS
// =============================================================================

/**
 * Updates telemetry data in RawMemory segments for external monitoring.
 */
function updateTelemetry(colony: Colony, corps: CorpRegistry): void {
  const telemetry = getTelemetry();
  telemetry.update(
    colony,
    corps.bootstrapCorps,
    corps.harvestCorps,
    corps.haulingCorps,
    corps.upgradingCorps,
    corps.scoutCorps,
    corps.constructionCorps,
    corps.spawningCorps,
    flowEconomy?.getSolution() ?? undefined
  );
}

/**
 * Logs statistics for monitoring.
 */
function logStats(colony: Colony, corps: CorpRegistry): void {
  const stats = colony.getStats();
  const supply = colony.getMoneySupply();

  console.log(`[Colony] Tick ${Game.time}`);
  console.log(`  Nodes: ${stats.nodeCount}, Corps: ${stats.totalCorps} (${stats.activeCorps} active)`);
  console.log(`  Chains: ${stats.activeChains}, Treasury: ${supply.treasury.toFixed(0)}`);
  console.log(`  Money Supply: ${supply.net.toFixed(0)} (minted: ${supply.minted.toFixed(0)}, taxed: ${supply.taxed.toFixed(0)})`);

  logCorpStats(corps);
}

// =============================================================================
// CONSOLE COMMANDS
// =============================================================================

// -----------------------------------------------------------------------------
// ORCHESTRATION COMMANDS
// -----------------------------------------------------------------------------

/**
 * Run survey phase to create corps from node resources.
 * Call from console: `global.survey()`
 *
 * Survey examines all nodes and creates corps based on resources:
 * - Source -> MiningCorp
 * - Spawn -> SpawningCorp
 * - Owned room -> HaulingCorp, UpgradingCorp
 */
global.survey = () => {
  if (!colony) {
    console.log("[Survey] No colony exists. Run global.recalculateTerrain() first.");
    return;
  }

  const result = runSurveyPhase(colony, corps, Game.time);
  setLastSurveyTick(Game.time);

  console.log("\n=== Survey Results ===");
  console.log(`Nodes surveyed: ${result.nodesSurveyed}`);
  console.log(`Resources found: ${result.resourcesFound.sources} sources, ${result.resourcesFound.controllers} controllers, ${result.resourcesFound.spawns} spawns`);
  console.log(`Corps created: ${result.corpsCreated.harvest} harvest, ${result.corpsCreated.hauling} hauling, ${result.corpsCreated.upgrading} upgrading, ${result.corpsCreated.spawning} spawning`);
};

/**
 * Force run flow economy planning phase.
 * Call from console: `global.plan()`
 *
 * Planning:
 * 1. Rebuilds flow graph from nodes if needed
 * 2. Solves optimal energy allocation (sources -> sinks)
 * 3. Materializes solution into corps (miners, haulers, upgraders)
 */
global.plan = () => {
  if (!colony) {
    console.log("[Planning] No colony exists. Run global.recalculateTerrain() first.");
    return;
  }

  console.log(`[Planning] Running planning phase at tick ${Game.time}...`);

  // --- FLOW ECONOMY: Update allocations based on game state ---
  if (flowEconomy && colony.getNodes().length > 0) {
    // Rebuild if no sources yet but we have nodes
    const currentNodeCount = colony.getNodes().length;
    if (flowEconomy.getFlowGraph().getSources().length === 0 && currentNodeCount > 0) {
      console.log(`[FlowEconomy] Rebuilding graph with ${currentNodeCount} nodes`);
      flowEconomy.rebuild(colony.getNodes());
    }

    // Build priority context from game state
    const context = buildPriorityContext(corps);
    flowEconomy.update(context, true); // Force update

    // Get solution and show results
    const solution = flowEconomy.getSolution();
    if (solution) {
      console.log(`\n=== Flow Economy Results ===`);
      console.log(`Miners: ${solution.miners.length}`);
      console.log(`Haulers: ${solution.haulers.length}`);
      console.log(`Total Harvest: ${solution.totalHarvest.toFixed(2)} energy/tick`);
      console.log(`Net Energy: ${solution.netEnergy.toFixed(2)} energy/tick`);
      console.log(`Efficiency: ${solution.efficiency.toFixed(1)}%`);
      console.log(`Sustainable: ${solution.isSustainable ? "YES" : "NO"}`);

      if (solution.warnings.length > 0) {
        console.log(`Warnings: ${solution.warnings.join(", ")}`);
      }

      // Materialize flow solution into corps
      const graph = flowEconomy.getFlowGraph();
      const matResult = materializeCorps(solution, graph, corps, Game.time);
      console.log(`\nMaterialized: ${matResult.harvestCorpsUpdated} harvest, ${matResult.carryCorpsUpdated} carry, ${matResult.upgradingCorpsUpdated} upgrading corps`);
    } else {
      console.log(`[FlowEconomy] No solution computed`);
    }
  } else if (!flowEconomy) {
    console.log(`[FlowEconomy] Not initialized`);
  } else {
    console.log(`[FlowEconomy] No nodes available`);
  }

  setLastPlanningTick(Game.time);
};

/**
 * Show orchestration status.
 * Call from console: `global.status()`
 *
 * Shows:
 * - Last survey/planning tick
 * - Active chains and contracts
 * - Corp counts by type
 */
global.status = () => {
  const chains = loadChains();
  const contracts = loadContracts();
  const activeContracts = contracts.filter(c =>
    Game.time < c.startTick + c.duration && c.delivered < c.quantity
  );

  console.log("\n=== Orchestration Status ===");
  console.log(`Current tick: ${Game.time}`);
  console.log(`Last survey: ${Memory.lastSurveyTick ?? "never"}`);
  console.log(`Last planning: ${Memory.lastPlanningTick ?? "never"}`);
  console.log(`Next planning: tick ${Math.ceil(Game.time / PLANNING_INTERVAL) * PLANNING_INTERVAL}`);

  console.log("\n=== Chains & Contracts ===");
  console.log(`Active chains: ${chains.length}`);
  console.log(`Active contracts: ${activeContracts.length} / ${contracts.length} total`);

  console.log("\n=== Corps ===");
  console.log(`Mining: ${Object.keys(corps.harvestCorps).length}`);
  console.log(`Hauling: ${Object.keys(corps.haulingCorps).length}`);
  console.log(`Upgrading: ${Object.keys(corps.upgradingCorps).length}`);
  console.log(`Spawning: ${Object.keys(corps.spawningCorps).length}`);
  console.log(`Bootstrap: ${Object.keys(corps.bootstrapCorps).length}`);
  console.log(`Scout: ${Object.keys(corps.scoutCorps).length}`);
  console.log(`Construction: ${Object.keys(corps.constructionCorps).length}`);

  if (colony) {
    console.log("\n=== Colony ===");
    console.log(`Nodes: ${colony.getNodes().length}`);
    console.log(`Treasury: ${colony.treasury.toFixed(0)}`);
  }
};

/**
 * Show flow economy status.
 * Call from console: `global.flowStatus()`
 *
 * Shows:
 * - Flow graph summary (sources, sinks, edges)
 * - Current solution allocations
 * - Efficiency and sustainability metrics
 * - Miner and hauler assignments
 */
global.flowStatus = () => {
  if (!flowEconomy) {
    console.log("[FlowEconomy] Not initialized. Colony may have no nodes yet.");
    return;
  }

  const graph = flowEconomy.getFlowGraph();
  const solution = flowEconomy.getSolution();

  console.log("\n=== Flow Economy Status ===");
  console.log(`Sources: ${graph.getSources().length}`);
  console.log(`Sinks: ${graph.getSinks().length}`);
  console.log(`Edges: ${graph.getEdges().length}`);

  if (!solution) {
    console.log("\nNo solution computed yet. Run global.plan() to trigger solve.");
    return;
  }

  console.log("\n=== Solution Metrics ===");
  console.log(`Total Harvest: ${solution.totalHarvest.toFixed(2)} energy/tick`);
  console.log(`Mining Overhead: ${solution.miningOverhead.toFixed(2)} energy/tick`);
  console.log(`Hauling Overhead: ${solution.haulingOverhead.toFixed(2)} energy/tick`);
  console.log(`Net Energy: ${solution.netEnergy.toFixed(2)} energy/tick`);
  console.log(`Efficiency: ${solution.efficiency.toFixed(1)}%`);
  console.log(`Sustainable: ${solution.isSustainable ? "YES" : "NO"}`);

  console.log("\n=== Miner Assignments ===");
  for (const miner of solution.miners.slice(0, 5)) {
    console.log(`  ${miner.sourceId.slice(-8)}: spawn=${miner.spawnId.slice(-8)}, dist=${miner.spawnDistance}`);
  }
  if (solution.miners.length > 5) {
    console.log(`  ... and ${solution.miners.length - 5} more miners`);
  }

  console.log("\n=== Hauler Assignments ===");
  for (const hauler of solution.haulers.slice(0, 5)) {
    console.log(`  ${hauler.fromId.slice(-8)} -> ${hauler.toId.slice(-8)}: ${hauler.carryParts} CARRY, ${hauler.flowRate.toFixed(2)} e/tick`);
  }
  if (solution.haulers.length > 5) {
    console.log(`  ... and ${solution.haulers.length - 5} more haulers`);
  }

  console.log("\n=== Sink Allocations (by priority) ===");
  const allocations = solution.sinkAllocations.sort((a, b) => b.priority - a.priority);
  for (const alloc of allocations.slice(0, 10)) {
    const pct = alloc.demand > 0 ? ((alloc.allocated / alloc.demand) * 100).toFixed(0) : "N/A";
    console.log(`  ${alloc.sinkType}[${alloc.sinkId.slice(-8)}]: ${alloc.allocated.toFixed(1)}/${alloc.demand.toFixed(1)} (${pct}%) pri=${alloc.priority}`);
  }
  if (allocations.length > 10) {
    console.log(`  ... and ${allocations.length - 10} more sinks`);
  }

  if (solution.warnings.length > 0) {
    console.log("\n=== Warnings ===");
    for (const warning of solution.warnings) {
      console.log(`  ⚠ ${warning}`);
    }
  }

  // Show unmet demand if any
  if (solution.unmetDemand.size > 0) {
    console.log("\n=== Unmet Demand ===");
    for (const [sinkId, unmet] of solution.unmetDemand) {
      console.log(`  ${sinkId.slice(-12)}: ${unmet.toFixed(2)} energy/tick unmet`);
    }
  }
};

// -----------------------------------------------------------------------------
// LEGACY COMMANDS
// -----------------------------------------------------------------------------

/**
 * Force recalculation of multi-room spatial analysis.
 * Call from console: `global.recalculateTerrain()`
 *
 * This triggers an incremental analysis that spreads work across multiple ticks.
 */
global.recalculateTerrain = () => {
  resetAnalysis();

  if (colony) {
    console.log(`[MultiRoom] Triggering incremental recalculation (will spread across multiple ticks)...`);
    // Start the incremental analysis - it will continue on subsequent ticks
    runIncrementalAnalysis(colony);
  } else {
    console.log("[MultiRoom] Cache cleared - will recalculate when colony exists");
  }
};

/**
 * Reset analysis cache without triggering recalculation.
 * Call from console: `global.resetAnalysis()`
 */
global.resetAnalysis = () => {
  resetAnalysis();
  console.log("[Analysis] Cache cleared. Will recalculate on next tick.");
};

/**
 * Show node summary with ROI scores based on potential corps.
 * Call from console: `global.showNodes()`
 */
global.showNodes = () => {
  if (!colony) {
    console.log("[Nodes] No colony exists yet");
    return;
  }

  const nodes = colony.getNodes();
  if (nodes.length === 0) {
    console.log("[Nodes] No nodes found. Run global.recalculateTerrain() first.");
    return;
  }

  // Sort by ROI score descending
  const sortedNodes = [...nodes].sort((a, b) => (b.roi?.score ?? 0) - (a.roi?.score ?? 0));

  console.log(`\n=== Colony Nodes (${nodes.length} total) ===`);
  console.log("Sorted by ROI score (based on potential corps value)\n");

  for (const node of sortedNodes) {
    const roi = node.roi;
    if (roi) {
      const corpSummary = roi.potentialCorps.length > 0
        ? roi.potentialCorps.map(c => `${c.type}(${c.estimatedROI.toFixed(2)})`).join(", ")
        : "none";
      const distStr = roi.distanceFromOwned === Infinity ? "∞" : roi.distanceFromOwned.toString();

      console.log(`${node.id} [${roi.isOwned ? "OWNED" : `dist=${distStr}`}]`);
      console.log(`  Score: ${roi.score.toFixed(1)} | Raw Corp ROI: ${roi.rawCorpROI.toFixed(2)} | Openness: ${roi.openness}`);
      console.log(`  Resources: ${roi.sourceCount} sources, ${roi.hasController ? "has controller" : "no controller"}`);
      console.log(`  Potential Corps: ${corpSummary}`);
    } else {
      console.log(`${node.id} | (no ROI data)`);
    }
  }

  // Show top expansion targets
  console.log("\n=== Top Expansion Targets ===");
  const expansionTargets = sortedNodes.filter(n => !n.roi?.isOwned && (n.roi?.score ?? 0) > 0);
  if (expansionTargets.length === 0) {
    console.log("No viable expansion targets found.");
  } else {
    for (const node of expansionTargets.slice(0, 5)) {
      const roi = node.roi!;
      const distStr = roi.distanceFromOwned === Infinity ? "∞" : roi.distanceFromOwned.toString();
      console.log(`  ${node.id}: score=${roi.score.toFixed(1)}, corps=${roi.potentialCorps.length}, dist=${distStr}`);
    }
  }
};

/**
 * Export node graph as JSON for external analysis.
 * Call from console: `global.exportNodes()`
 */
global.exportNodes = (): string => {
  if (!colony) {
    console.log("[Export] No colony exists yet");
    return "{}";
  }

  const nodes = colony.getNodes();

  // Build export structure
  const exportData = {
    exportedAt: Game.time,
    nodeCount: nodes.length,
    nodes: nodes.map(node => ({
      id: node.id,
      roomName: node.roomName,
      peakPosition: node.peakPosition,
      territorySize: node.territorySize,
      resources: node.resources.map(r => ({
        type: r.type,
        id: r.id,
        position: r.position,
        capacity: r.capacity,
        mineralType: r.mineralType
      })),
      roi: node.roi,
      spansRooms: node.spansRooms
    })),
    // Summary stats
    summary: {
      totalSources: nodes.reduce((sum, n) => sum + (n.roi?.sourceCount ?? 0), 0),
      ownedNodes: nodes.filter(n => n.roi?.isOwned).length,
      expansionCandidates: nodes.filter(n => !n.roi?.isOwned && (n.roi?.score ?? 0) > 0).length,
      avgROI: nodes.length > 0
        ? nodes.reduce((sum, n) => sum + (n.roi?.score ?? 0), 0) / nodes.length
        : 0
    }
  };

  const json = JSON.stringify(exportData, null, 2);
  console.log(`[Export] Exported ${nodes.length} nodes. Copy from console or use: JSON.parse(global.exportNodes())`);
  console.log(json);
  return json;
};

/**
 * Full economic reset - clears all corp economic state.
 * Call from console: `global.forgiveDebt()` or `global.forgiveDebt(1000)`
 *
 * This resets:
 * - All corp balances, revenue, and cost tracking
 * - All production/consumption tracking
 *
 * @param amount Optional starting balance for all corps (default: 1000)
 */
global.forgiveDebt = (amount: number = 1000) => {
  let corpsReset = 0;

  const resetCorp = (corp: {
    balance: number;
    totalRevenue: number;
    totalCost: number;
    id: string;
    unitsProduced: number;
    expectedUnitsProduced: number;
    unitsConsumed: number;
    acquisitionCost: number;
  }) => {
    corp.balance = amount;
    corp.totalRevenue = 0;
    corp.totalCost = 0;
    corp.unitsProduced = 0;
    corp.expectedUnitsProduced = 0;
    corp.unitsConsumed = 0;
    corp.acquisitionCost = 0;
    corpsReset++;
  };

  // Reset all corp types
  for (const id in corps.harvestCorps) {
    resetCorp(corps.harvestCorps[id]);
  }
  for (const id in corps.haulingCorps) {
    resetCorp(corps.haulingCorps[id]);
  }
  for (const id in corps.upgradingCorps) {
    resetCorp(corps.upgradingCorps[id]);
  }
  for (const id in corps.constructionCorps) {
    resetCorp(corps.constructionCorps[id]);
  }
  for (const id in corps.spawningCorps) {
    resetCorp(corps.spawningCorps[id]);
    // Give SpawningCorp extra balance for maintenance haulers (3x normal)
    corps.spawningCorps[id].balance = amount * 3;
  }

  console.log(`[GodMode] Full economic reset complete:`);
  console.log(`  - ${corpsReset} corps reset to balance=${amount}`);
  console.log(`  - SpawningCorps given extra balance=${amount * 3} (for maintenance haulers)`);
};

/**
 * Clear all pending spawn requests.
 * Use this to recover from a deadlocked spawn queue.
 * Call from console: `global.clearSpawnQueue()`
 */
global.clearSpawnQueue = () => {
  let totalCleared = 0;

  for (const id in corps.spawningCorps) {
    const spawningCorp = corps.spawningCorps[id];
    const cleared = spawningCorp.clearPendingOrders();
    totalCleared += cleared;
    if (cleared > 0) {
      console.log(`[GodMode] Cleared ${cleared} orders from ${spawningCorp.id}`);
    }
  }

  console.log(`[GodMode] Cleared ${totalCleared} total pending spawn orders`);
};

/**
 * Show current economy status for debugging.
 * Call from console: `global.marketStatus()`
 */
global.marketStatus = () => {
  console.log("\n=== Economy Status ===\n");

  // Show corp stats
  console.log("=== Corps ===");
  const showCorpStats = (name: string, corpMap: { [id: string]: { id: string; balance: number; getCreepCount?: () => number } }) => {
    const count = Object.keys(corpMap).length;
    if (count === 0) return;

    let totalBalance = 0;
    let totalCreeps = 0;
    for (const id in corpMap) {
      totalBalance += corpMap[id].balance;
      if (typeof corpMap[id].getCreepCount === 'function') {
        totalCreeps += corpMap[id].getCreepCount!();
      }
    }
    console.log(`  ${name}: ${count} corps, ${totalCreeps} creeps, ${totalBalance.toFixed(0)} balance`);
  };

  showCorpStats("Mining", corps.harvestCorps);
  showCorpStats("Hauling", corps.haulingCorps);
  showCorpStats("Upgrading", corps.upgradingCorps);
  showCorpStats("Spawning", corps.spawningCorps);
  showCorpStats("Construction", corps.constructionCorps);
  showCorpStats("Scout", corps.scoutCorps);
  showCorpStats("Bootstrap", corps.bootstrapCorps);

  // Show spawn queue status
  console.log("\n=== Spawn Queues ===");
  for (const id in corps.spawningCorps) {
    const sc = corps.spawningCorps[id];
    console.log(`  ${sc.id}: ${sc.getPendingOrderCount()} pending orders`);
  }

  console.log("");
};
