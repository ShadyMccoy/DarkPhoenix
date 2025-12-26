/**
 * @fileoverview Main game loop entry point.
 *
 * This is the entry point for the Screeps AI. It orchestrates the colony
 * economic system using a phased architecture.
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
 * 2. MARKET: Register offers, run market clearing
 * 3. PLAN: Find optimal chains, store contracts in Memory
 *
 * ## Key Components
 * - Colony: Economic coordinator (treasury, surveying)
 * - Nodes: Territory-based regions (from spatial peak detection)
 * - Corps: Business units that buy/sell resources
 * - Chains: Production paths linking corps (from planning)
 * - Contracts: Executable agreements stored in Memory
 *
 * ## Console Commands
 * - global.survey() - Force run survey phase
 * - global.plan() - Force run planning phase
 * - global.status() - Show orchestration status
 *
 * @module main
 */

import { Colony, createColony } from "./colony";
import { deserializeNode, SerializedNode } from "./nodes";
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
} from "./execution";
import {
  initCorps,
  shouldRunPlanning,
  runPlanningPhase,
  runSurveyPhase,
  PLANNING_INTERVAL,
  loadContracts,
  loadChains,
  setLastPlanningTick,
  setLastSurveyTick,
} from "./orchestration";
import "./types/Memory";

// =============================================================================
// CONSTANTS
// =============================================================================

/** Tick interval for expanding to nearby rooms (expensive operation) */
const NEARBY_ROOM_EXPANSION_INTERVAL = 500;

// =============================================================================
// GLOBALS
// =============================================================================

declare global {
  namespace NodeJS {
    interface Global {
      log: any;
      colony: Colony | undefined;
      corps: CorpRegistry;
      // Orchestration commands
      survey: () => void;
      plan: () => void;
      status: () => void;
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

  // Make state available globally for debugging
  global.colony = colony;
  global.corps = corps;

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

    // --- PLAN: Find optimal chains and assign contracts ---
    // ChainPlanner finds viable chains, creates contracts, and assigns them to corps
    // This is the unified economic planning - no separate market clearing needed
    const planningResult = runPlanningPhase(corps, colony, Game.time);
    setLastPlanningTick(Game.time);

    console.log(`[Planning] Complete: ${planningResult.chains.length} chains, ${planningResult.contracts.length} contracts`);
  }

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
    corps.spawningCorps
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
 * Force run planning phase to find optimal chains.
 * Call from console: `global.plan()`
 *
 * Planning:
 * 1. Collects offers from all corps via projections
 * 2. Runs chain planner to find optimal chains
 * 3. Stores contracts in Memory
 */
global.plan = () => {
  if (!colony) {
    console.log("[Planning] No colony exists. Run global.recalculateTerrain() first.");
    return;
  }

  const result = runPlanningPhase(corps, colony, Game.time);
  setLastPlanningTick(Game.time);

  console.log("\n=== Planning Results ===");
  console.log(`Chains found: ${result.chains.length}`);
  console.log(`Contracts created: ${result.contracts.length}`);

  if (result.chains.length > 0) {
    console.log("\nTop chains:");
    for (const chain of result.chains.slice(0, 5)) {
      console.log(`  ${chain.id}: profit=${chain.profit.toFixed(2)}, segments=${chain.segments.length}`);
    }
  }
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
    const pendingCount = spawningCorp.getPendingOrderCount();
    if (pendingCount > 0) {
      // The SpawningCorp's pendingOrders are private, so we'd need to add a clear method
      // For now, just report what would be cleared
      totalCleared += pendingCount;
    }
  }

  console.log(`[GodMode] Found ${totalCleared} pending spawn orders`);
  console.log(`[GodMode] To clear, use global.forgiveDebt() to reset all corps`);
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
