/**
 * @fileoverview Main game loop entry point.
 *
 * This is the entry point for the Screeps AI. It orchestrates the colony
 * economic system using a graph-based architecture.
 *
 * ## Architecture Overview
 *
 * The system uses an economic model where:
 * - Colony: Top-level orchestrator managing all economic activity
 * - Nodes: Territory-based regions (derived from spatial peak detection)
 * - Corps: Business units that buy/sell resources (mining, hauling, upgrading)
 * - Chains: Production paths linking corps together
 * - BootstrapCorp: Fallback corp that keeps colony alive with basic creeps
 *
 * ## Execution Flow
 *
 * Each tick:
 * 1. Run bootstrap corps (fallback to keep colony alive)
 * 2. Run real corps (mining, hauling, upgrading)
 * 3. Run scout corps (room exploration)
 * 4. Initialize colony and run economic tick
 * 5. Run incremental spatial analysis (spread across multiple ticks)
 * 6. Persist state to memory
 * 7. Update telemetry and render visualization
 * 8. Clean up dead creep memory
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
  registerCorpsWithMarket,
  runMarketClearing,
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
      showNodes: () => void;
      exportNodes: () => string;
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
 * Wrapped with ErrorMapper to catch and log errors without crashing.
 */
export const loop = ErrorMapper.wrapLoop(() => {
  // Run corps (bootstrap, mining, hauling, upgrading, scouts, construction)
  runBootstrapCorps(corps);
  runRealCorps(corps);
  runScoutCorps(corps);
  runConstructionCorps(corps);

  // Register corps with market and run market clearing
  // This matches buy/sell offers and records transactions
  registerCorpsWithMarket(corps);
  runMarketClearing();

  // Initialize or restore colony
  colony = getOrCreateColony();

  // Make state available globally for debugging
  global.colony = colony;
  global.corps = corps;

  // Run incremental multi-room spatial analysis
  // Starts when cache expires or no nodes exist, spreads work across multiple ticks
  if (isAnalysisInProgress() || Game.time % NEARBY_ROOM_EXPANSION_INTERVAL === 0 || colony.getNodes().length === 0) {
    runIncrementalAnalysis(colony);
  }

  // Run the colony economic tick
  colony.run(Game.time);

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
    corps.constructionCorps
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
