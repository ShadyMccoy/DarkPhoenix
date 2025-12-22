/**
 * @fileoverview Main game loop entry point.
 *
 * This is the entry point for the Screeps AI. It orchestrates the colony
 * economic system using a phased architecture.
 *
 * ## Phased Architecture
 *
 * ### NEW NODES (rare - when recalculateTerrain runs)
 * Survey phase: Nodes inventory their territory, corps are instantiated.
 *
 * ### EVERY 5000 TICKS (planning)
 * 1. Offer Phase: Corps generate buy/sell offers via projections
 * 2. Planning Phase: GOAP planner finds best value chains
 * 3. Contracts are stored in Memory
 *
 * ### EVERY TICK (execution)
 * 1. Hydrate corps from memory
 * 2. Each corp runs its actions
 * 3. Market clearing for spawn contracts
 *
 * ## Key Components
 * - Colony: Economic coordinator (treasury, surveying)
 * - Nodes: Territory-based regions (from spatial peak detection)
 * - Corps: Business units that buy/sell resources
 * - Chains: Production paths linking corps (from planning)
 * - Contracts: Executable agreements from chains
 *
 * @module main
 */

import { Colony, createColony } from "./colony";
import { deserializeNode, SerializedNode } from "./nodes";
import { ErrorMapper } from "./utils";
import { getTelemetry } from "./telemetry";
import { resetMarket } from "./market/Market";
import {
  CorpRegistry,
  createCorpRegistry,
  runBootstrapCorps,
  runRealCorps,
  runScoutCorps,
  runConstructionCorps,
  runSpawningCorps,
  registerCorpsWithMarket,
  runMarketClearing,
  processSpawnContracts,
  logCorpStats,
  persistState,
  cleanupDeadCreeps,
  getAnalysisCache,
  isAnalysisInProgress,
  resetAnalysis,
  restoreVisualizationCache,
  runIncrementalAnalysis,
  MULTI_ROOM_ANALYSIS_CACHE_TTL,
  renderNodeVisuals,
  renderSpatialVisuals,
} from "./execution";
import {
  shouldRunPlanning,
  runPlanningPhase,
  PLANNING_INTERVAL,
  loadContracts,
  setLastPlanningTick,
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
 * ### Every Tick (Execution Phase)
 * 1. Hydrate corps from memory (via CorpRunner)
 * 2. Run all corps (spawning, bootstrap, mining, hauling, upgrading, etc.)
 * 3. Market clearing for spawn contracts
 *
 * ### Every 5000 Ticks (Planning Phase)
 * 1. Collect offers from all corps via projections
 * 2. Run chain planner to find optimal chains
 * 3. Store contracts in Memory for execution
 *
 * ### On Node Creation (Survey Phase)
 * Survey phase runs when recalculateTerrain creates new nodes.
 * Corps are instantiated based on node resources.
 *
 * Wrapped with ErrorMapper to catch and log errors without crashing.
 */
export const loop = ErrorMapper.wrapLoop(() => {
  // ===========================================================================
  // PHASE 1: EXECUTION - Run all corps (every tick)
  // ===========================================================================

  // Run spawning corps first (they process pending spawn orders)
  runSpawningCorps(corps);

  // Run other corps (bootstrap, mining, hauling, upgrading, scouts, construction)
  runBootstrapCorps(corps);
  runRealCorps(corps);
  runScoutCorps(corps);
  runConstructionCorps(corps);

  // ===========================================================================
  // PHASE 2: MARKET - Match spawn offers to contracts (every tick)
  // ===========================================================================

  // Register all corps with market and run market clearing
  // This matches buy/sell offers (including work-ticks for spawning)
  registerCorpsWithMarket(corps);
  const clearingResult = runMarketClearing();

  // Process spawn contracts - routes work-ticks contracts to SpawningCorps
  processSpawnContracts(clearingResult.contracts, corps);

  // ===========================================================================
  // PHASE 3: COLONY - Territory and surveying
  // ===========================================================================

  // Initialize or restore colony
  colony = getOrCreateColony();

  // Make state available globally for debugging
  global.colony = colony;
  global.corps = corps;

  // Run incremental multi-room spatial analysis (SURVEY phase for new nodes)
  // Starts when cache expires or no nodes exist, spreads work across multiple ticks
  if (isAnalysisInProgress() || Game.time % NEARBY_ROOM_EXPANSION_INTERVAL === 0 || colony.getNodes().length === 0) {
    runIncrementalAnalysis(colony);
  }

  // Run the colony economic coordination (surveying, stats)
  colony.run(Game.time);

  // ===========================================================================
  // PHASE 4: PLANNING - Find optimal chains (every 5000 ticks)
  // ===========================================================================

  if (shouldRunPlanning(Game.time)) {
    const planningResult = runPlanningPhase(corps, colony, Game.time);
    setLastPlanningTick(Game.time);
    console.log(`[Planning] Created ${planningResult.chains.length} chains, ${planningResult.contracts.length} contracts`);
  }

  // ===========================================================================
  // PHASE 5: PERSISTENCE - Save state and update telemetry
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
    corps.miningCorps,
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
 * Full market reset - clears all economic state.
 * Call from console: `global.forgiveDebt()` or `global.forgiveDebt(1000)`
 *
 * This resets:
 * - All corp balances, revenue, and cost tracking
 * - All pending spawn orders
 * - All commitment tracking (work-ticks, energy, delivered-energy)
 * - Market contracts and transactions
 *
 * @param amount Optional starting balance for all corps (default: 1000)
 */
global.forgiveDebt = (amount: number = 1000) => {
  let corpsReset = 0;
  let pendingOrdersCleared = 0;

  const resetCorp = (corp: {
    balance: number;
    totalRevenue: number;
    totalCost: number;
    id: string;
    committedWorkTicks: number;
    committedEnergy: number;
    committedDeliveredEnergy: number;
    unitsProduced: number;
    expectedUnitsProduced: number;
    unitsConsumed: number;
    acquisitionCost: number;
  }) => {
    corp.balance = amount;
    corp.totalRevenue = 0;
    corp.totalCost = 0;
    corp.committedWorkTicks = 0;
    corp.committedEnergy = 0;
    corp.committedDeliveredEnergy = 0;
    corp.unitsProduced = 0;
    corp.expectedUnitsProduced = 0;
    corp.unitsConsumed = 0;
    corp.acquisitionCost = 0;
    corpsReset++;
  };

  // Reset all corp types
  for (const id in corps.miningCorps) {
    resetCorp(corps.miningCorps[id]);
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
    // This allows the spawn to self-sustain and break energy starvation
    corps.spawningCorps[id].balance = amount * 3;
    // Clear pending spawn orders
    const cleared = corps.spawningCorps[id].clearPendingOrders();
    pendingOrdersCleared += cleared;
  }

  // Reset market contracts and transactions
  resetMarket();

  console.log(`[GodMode] Full market reset complete:`);
  console.log(`  - ${corpsReset} corps reset to balance=${amount}`);
  console.log(`  - SpawningCorps given extra balance=${amount * 3} (for maintenance haulers)`);
  console.log(`  - ${pendingOrdersCleared} pending spawn orders cleared`);
  console.log(`  - Market contracts and transactions cleared`);
  console.log(`  - All commitment tracking reset`);
};

/**
 * Clear all pending spawn orders from all SpawningCorps.
 * Use this to recover from a deadlocked spawn queue.
 * Call from console: `global.clearSpawnQueue()`
 */
global.clearSpawnQueue = () => {
  let totalCleared = 0;

  for (const id in corps.spawningCorps) {
    const spawningCorp = corps.spawningCorps[id];
    const cleared = spawningCorp.clearPendingOrders();
    totalCleared += cleared;
  }

  console.log(`[GodMode] Cleared ${totalCleared} pending spawn orders from all SpawningCorps`);
  console.log(`[GodMode] SpawningCorps can now sell work-ticks again`);
};

/**
 * Show current market status for debugging.
 * Call from console: `global.marketStatus()`
 */
global.marketStatus = () => {
  console.log("\n=== Market Status ===\n");

  // Collect offers from all corps
  const buyOffers: { corp: string; type: string; resource: string; qty: number; price: number }[] = [];
  const sellOffers: { corp: string; type: string; resource: string; qty: number; price: number }[] = [];

  const collectOffers = (corp: { id: string; type: string; buys(): any[]; sells(): any[] }) => {
    for (const offer of corp.buys()) {
      buyOffers.push({
        corp: corp.id.slice(-12),
        type: corp.type,
        resource: offer.resource,
        qty: Math.round(offer.quantity),
        price: offer.price / offer.quantity
      });
    }
    for (const offer of corp.sells()) {
      sellOffers.push({
        corp: corp.id.slice(-12),
        type: corp.type,
        resource: offer.resource,
        qty: Math.round(offer.quantity),
        price: offer.price / offer.quantity
      });
    }
  };

  for (const id in corps.miningCorps) collectOffers(corps.miningCorps[id]);
  for (const id in corps.haulingCorps) collectOffers(corps.haulingCorps[id]);
  for (const id in corps.upgradingCorps) collectOffers(corps.upgradingCorps[id]);
  for (const id in corps.spawningCorps) collectOffers(corps.spawningCorps[id]);
  for (const id in corps.constructionCorps) collectOffers(corps.constructionCorps[id]);

  // Group by resource
  const resources = new Set([...buyOffers.map(o => o.resource), ...sellOffers.map(o => o.resource)]);

  for (const resource of resources) {
    const buys = buyOffers.filter(o => o.resource === resource);
    const sells = sellOffers.filter(o => o.resource === resource);

    console.log(`[${resource}]`);
    if (sells.length > 0) {
      console.log(`  SELL: ${sells.map(s => `${s.type}(${s.qty}@${s.price.toFixed(3)})`).join(", ")}`);
    } else {
      console.log(`  SELL: (none)`);
    }
    if (buys.length > 0) {
      console.log(`  BUY:  ${buys.map(b => `${b.type}(${b.qty}@${b.price.toFixed(3)})`).join(", ")}`);
    } else {
      console.log(`  BUY:  (none)`);
    }
  }

  // Show spawn queue status
  console.log("\n=== Spawn Queues ===");
  for (const id in corps.spawningCorps) {
    const sc = corps.spawningCorps[id];
    console.log(`  ${sc.id}: ${sc.getPendingOrderCount()} pending orders`);
  }

  console.log("");
};
