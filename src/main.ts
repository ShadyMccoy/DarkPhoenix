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
 * 2. Initialize nodes from rooms (spatial analysis)
 * 3. Run colony economic tick (survey, plan, execute, settle)
 * 4. Persist state to memory
 * 5. Clean up dead creep memory
 *
 * @module main
 */

import { Colony, createColony } from "./colony";
import { createNode, Node, serializeNode, deserializeNode, calculateNodeROI, NodeROI, NodeSurveyor, SerializedNode } from "./nodes";
import {
  BootstrapCorp,
  createBootstrapCorp,
  SerializedBootstrapCorp,
  RealMiningCorp,
  createRealMiningCorp,
  SerializedRealMiningCorp,
  RealHaulingCorp,
  createRealHaulingCorp,
  SerializedRealHaulingCorp,
  RealUpgradingCorp,
  createRealUpgradingCorp,
  SerializedRealUpgradingCorp,
  ScoutCorp,
  createScoutCorp,
  SerializedScoutCorp,
} from "./corps";
import { ErrorMapper, get5x5BoxAroundOwnedRooms } from "./utils";
import {
  analyzeMultiRoomTerrain,
  MultiRoomAnalysisResult,
  visualizeMultiRoomAnalysis,
  findTerritoryAdjacencies,
  WorldCoordinate,
  WorldPosition,
  CrossRoomPeak,
} from "./spatial";
import { getTelemetry } from "./telemetry";
import "./types/Memory";

/** Tick interval for expanding to nearby rooms (expensive operation) */
const NEARBY_ROOM_EXPANSION_INTERVAL = 500;

declare global {
  namespace NodeJS {
    interface Global {
      log: any;
      colony: Colony | undefined;
      bootstrapCorps: { [roomName: string]: BootstrapCorp };
      miningCorps: { [sourceId: string]: RealMiningCorp };
      haulingCorps: { [roomName: string]: RealHaulingCorp };
      upgradingCorps: { [roomName: string]: RealUpgradingCorp };
      scoutCorps: { [roomName: string]: ScoutCorp };
      recalculateTerrain: () => void;
      showNodes: () => void;
      exportNodes: () => string;
    }
  }

  interface Memory {
    bootstrapCorps?: { [roomName: string]: SerializedBootstrapCorp };
    miningCorps?: { [sourceId: string]: SerializedRealMiningCorp };
    haulingCorps?: { [roomName: string]: SerializedRealHaulingCorp };
    upgradingCorps?: { [roomName: string]: SerializedRealUpgradingCorp };
    scoutCorps?: { [roomName: string]: SerializedScoutCorp };
  }
}

/** The colony instance (persisted across ticks) */
let colony: Colony | undefined;

/** Bootstrap corps per room (fallback workers) */
const bootstrapCorps: { [roomName: string]: BootstrapCorp } = {};

/** Mining corps per source */
const miningCorps: { [sourceId: string]: RealMiningCorp } = {};

/** Hauling corps per room */
const haulingCorps: { [roomName: string]: RealHaulingCorp } = {};

/** Upgrading corps per room */
const upgradingCorps: { [roomName: string]: RealUpgradingCorp } = {};

/** Scout corps per room */
const scoutCorps: { [roomName: string]: ScoutCorp } = {};

/**
 * Main game loop - executed every tick.
 *
 * Wrapped with ErrorMapper to catch and log errors without crashing.
 */
export const loop = ErrorMapper.wrapLoop(() => {
  // Run bootstrap corps first (keep colony alive)
  runBootstrapCorps();

  // Run real corps (mining, hauling, upgrading)
  runRealCorps();

  // Run scout corps (room exploration)
  runScoutCorps();

  // Initialize or restore colony
  colony = getOrCreateColony();

  // Make colony available globally for debugging
  global.colony = colony;
  global.bootstrapCorps = bootstrapCorps;
  global.miningCorps = miningCorps;
  global.haulingCorps = haulingCorps;
  global.upgradingCorps = upgradingCorps;
  global.scoutCorps = scoutCorps;

  // Run incremental multi-room spatial analysis
  // Starts when cache expires or no nodes exist, spreads work across multiple ticks
  if (incrementalState || Game.time % NEARBY_ROOM_EXPANSION_INTERVAL === 0 || colony.getNodes().length === 0) {
    runIncrementalAnalysis(colony);
  }

  // Run the colony economic tick
  colony.run(Game.time);

  // Persist all state
  persistState(colony);

  // Update telemetry (write to RawMemory segments for external monitoring)
  updateTelemetry(colony);

  // Restore visualization cache from memory if needed (avoids expensive analysis)
  restoreVisualizationCache(colony);

  // Render node visualization
  renderNodeVisuals(colony);

  // Render spatial visualization (territories, edges) for rooms with visual* flags
  renderSpatialVisuals();

  // Clean up memory for dead creeps
  cleanupDeadCreeps();

  // Log stats periodically
  if (Game.time % 100 === 0) {
    logStats(colony);
  }
});

/**
 * Run bootstrap corps for all owned rooms.
 *
 * Bootstrap corps are the fallback - they create simple jack creeps
 * that harvest energy and return it to spawn.
 */
function runBootstrapCorps(): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];

    // Only process owned rooms with spawns
    if (!room.controller?.my) continue;
    if (room.find(FIND_MY_SPAWNS).length === 0) continue;

    // Get or create bootstrap corp for this room
    let bootstrapCorp = bootstrapCorps[roomName];

    if (!bootstrapCorp) {
      // Try to restore from memory
      const saved = Memory.bootstrapCorps?.[roomName];
      if (saved) {
        const spawns = room.find(FIND_MY_SPAWNS);
        const sources = room.find(FIND_SOURCES);
        if (spawns.length > 0 && sources.length > 0) {
          bootstrapCorp = new BootstrapCorp(
            saved.nodeId,
            saved.spawnId,
            saved.sourceId
          );
          bootstrapCorp.deserialize(saved);
          bootstrapCorps[roomName] = bootstrapCorp;
        }
      }

      // Create new if still missing
      if (!bootstrapCorp) {
        const newCorp = createBootstrapCorp(room);
        if (newCorp) {
          newCorp.createdAt = Game.time;
          bootstrapCorps[roomName] = newCorp;
          bootstrapCorp = newCorp;
          console.log(`[Bootstrap] Created corp for ${roomName}`);
        }
      }
    }

    // Run the bootstrap corp
    if (bootstrapCorp) {
      bootstrapCorp.work(Game.time);
    }
  }
}

/**
 * Run real corps (mining, hauling, upgrading) for all owned rooms.
 *
 * These corps work together:
 * - Mining: Harvests energy and drops it
 * - Hauling: Picks up energy and delivers to spawn/controller
 * - Upgrading: Picks up energy near controller and upgrades
 */
function runRealCorps(): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];

    // Only process owned rooms with spawns
    if (!room.controller?.my) continue;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;

    const spawn = spawns[0];
    const sources = room.find(FIND_SOURCES);

    // Initialize and run mining corps (one per source)
    for (const source of sources) {
      let miningCorp = miningCorps[source.id];

      if (!miningCorp) {
        // Try to restore from memory
        const saved = Memory.miningCorps?.[source.id];
        if (saved) {
          miningCorp = new RealMiningCorp(saved.nodeId, saved.spawnId, saved.sourceId);
          miningCorp.deserialize(saved);
          miningCorps[source.id] = miningCorp;
        } else {
          // Create new
          miningCorp = createRealMiningCorp(room, spawn, source);
          miningCorp.createdAt = Game.time;
          miningCorps[source.id] = miningCorp;
          console.log(`[Mining] Created corp for source ${source.id.slice(-4)} in ${roomName}`);
        }
      }

      miningCorp.work(Game.time);
    }

    // Initialize and run hauling corp (one per room)
    let haulingCorp = haulingCorps[roomName];

    if (!haulingCorp) {
      const saved = Memory.haulingCorps?.[roomName];
      if (saved) {
        haulingCorp = new RealHaulingCorp(saved.nodeId, saved.spawnId);
        haulingCorp.deserialize(saved);
        haulingCorps[roomName] = haulingCorp;
      } else {
        haulingCorp = createRealHaulingCorp(room, spawn);
        haulingCorp.createdAt = Game.time;
        haulingCorps[roomName] = haulingCorp;
        console.log(`[Hauling] Created corp for ${roomName}`);
      }
    }

    haulingCorp.work(Game.time);

    // Initialize and run upgrading corp (one per room)
    let upgradingCorp = upgradingCorps[roomName];

    if (!upgradingCorp) {
      const saved = Memory.upgradingCorps?.[roomName];
      if (saved) {
        upgradingCorp = new RealUpgradingCorp(saved.nodeId, saved.spawnId);
        upgradingCorp.deserialize(saved);
        upgradingCorps[roomName] = upgradingCorp;
      } else {
        upgradingCorp = createRealUpgradingCorp(room, spawn);
        upgradingCorp.createdAt = Game.time;
        upgradingCorps[roomName] = upgradingCorp;
        console.log(`[Upgrading] Created corp for ${roomName}`);
      }
    }

    upgradingCorp.work(Game.time);
  }
}

/**
 * Run scout corps for all owned rooms.
 *
 * Scout corps create minimal creeps (1 MOVE) that explore nearby rooms
 * to gather intel about sources, minerals, hostiles, etc.
 */
function runScoutCorps(): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];

    // Only process owned rooms with spawns
    if (!room.controller?.my) continue;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;

    // Get or create scout corp for this room
    let scoutCorp = scoutCorps[roomName];

    if (!scoutCorp) {
      // Try to restore from memory
      const saved = Memory.scoutCorps?.[roomName];
      if (saved) {
        scoutCorp = new ScoutCorp(saved.nodeId, saved.spawnId);
        scoutCorp.deserialize(saved);
        scoutCorps[roomName] = scoutCorp;
      } else {
        // Create new
        const newCorp = createScoutCorp(room);
        if (newCorp) {
          newCorp.createdAt = Game.time;
          scoutCorps[roomName] = newCorp;
          scoutCorp = newCorp;
          console.log(`[Scout] Created corp for ${roomName}`);
        }
      }
    }

    // Run the scout corp
    if (scoutCorp) {
      scoutCorp.work(Game.time);
    }
  }
}

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

/** Cache for multi-room analysis results */
let multiRoomAnalysisCache: { result: MultiRoomAnalysisResult; tick: number } | null = null;

/**
 * Restore visualization cache from persisted Memory data.
 * This allows edge visualization without running the expensive analysis.
 */
function restoreVisualizationCache(colony: Colony): void {
  if (multiRoomAnalysisCache) return; // Already have cache

  const nodes = colony.getNodes();
  if (nodes.length === 0) return; // No nodes to visualize

  // Reconstruct peaks from nodes
  const peaks = nodes.map(node => ({
    peakId: node.id,
    roomName: node.roomName,
    center: { x: node.peakPosition.x, y: node.peakPosition.y },
    height: node.roi?.openness || 5
  }));

  // Restore adjacencies from memory
  const adjacencies = Memory.nodeEdges
    ? new Set<string>(Memory.nodeEdges)
    : new Set<string>();

  // Create minimal cache for visualization
  multiRoomAnalysisCache = {
    result: {
      peaks,
      territories: new Map(), // Not needed for edge visualization
      distances: new Map(), // Not needed for visualization
      adjacencies,
      edgeWeights: new Map() // Will use Chebyshev distance as fallback
    },
    tick: Game.time
  };

  console.log(`[Colony] Restored visualization cache: ${peaks.length} peaks, ${adjacencies.size} edges`);
}

/**
 * Force recalculation of multi-room spatial analysis.
 * Call from console: `global.recalculateTerrain()`
 *
 * This triggers an incremental analysis that spreads work across multiple ticks.
 */
global.recalculateTerrain = () => {
  multiRoomAnalysisCache = null;
  incrementalState = null; // Reset any in-progress analysis

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

/** TTL for multi-room analysis cache */
const MULTI_ROOM_ANALYSIS_CACHE_TTL = 500;

/** Max rooms to analyze per batch to avoid CPU timeout */
const ROOMS_PER_BATCH = 9;

/** State for incremental terrain analysis */
interface IncrementalAnalysisState {
  phase: 'analyzing' | 'merging' | 'updating';
  allRooms: string[];
  batches: string[][];
  currentBatchIndex: number;
  batchResults: MultiRoomAnalysisResult[];
  mergedResult: MultiRoomAnalysisResult | null;
  startTick: number;
}

let incrementalState: IncrementalAnalysisState | null = null;

/**
 * Runs terrain analysis incrementally across multiple ticks.
 * Processes rooms in small batches to avoid CPU timeout.
 * Returns true if analysis is complete, false if still in progress.
 */
function runIncrementalAnalysis(colony: Colony): boolean {
  // Check if we should start a new analysis
  if (!incrementalState) {
    // Check cache first
    if (multiRoomAnalysisCache && Game.time - multiRoomAnalysisCache.tick < MULTI_ROOM_ANALYSIS_CACHE_TTL) {
      return true; // Use cached result
    }

    const roomsToAnalyzeSet = get5x5BoxAroundOwnedRooms();
    const allRooms = Array.from(roomsToAnalyzeSet);

    if (allRooms.length === 0) return true;

    // Split into batches
    const batches: string[][] = [];
    for (let i = 0; i < allRooms.length; i += ROOMS_PER_BATCH) {
      batches.push(allRooms.slice(i, i + ROOMS_PER_BATCH));
    }

    console.log(`[MultiRoom] Starting incremental analysis: ${allRooms.length} rooms in ${batches.length} batches`);
    incrementalState = {
      phase: 'analyzing',
      allRooms,
      batches,
      currentBatchIndex: 0,
      batchResults: [],
      mergedResult: null,
      startTick: Game.time
    };
  }

  const state = incrementalState;

  // Phase 1: Analyze rooms in batches (one batch per tick)
  if (state.phase === 'analyzing') {
    if (state.currentBatchIndex < state.batches.length) {
      const batch = state.batches[state.currentBatchIndex];
      console.log(`[MultiRoom] Analyzing batch ${state.currentBatchIndex + 1}/${state.batches.length}: ${batch.join(", ")}`);

      try {
        const result = analyzeMultiRoomTerrain(batch, {
          maxRooms: batch.length,
          peakOptions: { minHeight: 2 },
          limitToStartRooms: true,
        });
        state.batchResults.push(result);
        console.log(`[MultiRoom] Batch ${state.currentBatchIndex + 1} complete: ${result.peaks.length} peaks`);
      } catch (e) {
        console.log(`[MultiRoom] Batch ${state.currentBatchIndex + 1} failed: ${e}`);
      }

      state.currentBatchIndex++;
      return false; // Continue next tick
    }

    // All batches done, move to merging
    state.phase = 'merging';
    return false;
  }

  // Phase 2: Merge batch results
  if (state.phase === 'merging') {
    console.log(`[MultiRoom] Merging ${state.batchResults.length} batch results...`);

    // Merge all peaks and territories
    const allPeaks: CrossRoomPeak[] = [];
    const allTerritories = new Map<string, WorldPosition[]>();
    const allDistances = new Map<string, number>();

    for (const result of state.batchResults) {
      allPeaks.push(...result.peaks);
      for (const [peakId, positions] of result.territories) {
        allTerritories.set(peakId, positions);
      }
      for (const [key, dist] of result.distances) {
        allDistances.set(key, dist);
      }
    }

    // Compute adjacencies across all territories
    const territoriesAsWorldCoord = new Map<string, WorldCoordinate[]>();
    for (const [peakId, positions] of allTerritories) {
      territoriesAsWorldCoord.set(peakId, positions.map(p => ({
        x: p.x,
        y: p.y,
        roomName: p.roomName
      })));
    }
    const adjacencies = findTerritoryAdjacencies(territoriesAsWorldCoord);

    state.mergedResult = {
      peaks: allPeaks,
      territories: allTerritories,
      distances: allDistances,
      adjacencies,
      edgeWeights: new Map()
    };

    console.log(`[MultiRoom] Merged: ${allPeaks.length} peaks, ${adjacencies.size} edges`);
    state.phase = 'updating';
    return false;
  }

  // Phase 3: Update nodes
  if (state.phase === 'updating' && state.mergedResult) {
    updateNodesFromAnalysis(colony, state.mergedResult);

    // Cache result
    multiRoomAnalysisCache = { result: state.mergedResult, tick: Game.time };

    const duration = Game.time - state.startTick;
    console.log(`[MultiRoom] Incremental analysis completed in ${duration} ticks`);

    incrementalState = null;
    return true;
  }

  return false;
}

/**
 * Updates colony nodes from analysis result.
 */
function updateNodesFromAnalysis(colony: Colony, result: MultiRoomAnalysisResult): void {
  const newNodeIds = new Set(result.peaks.map((p) => p.peakId));

  // Remove old nodes
  const existingNodes = colony.getNodes();
  for (const node of existingNodes) {
    if (!newNodeIds.has(node.id)) {
      colony.removeNode(node.id);
    }
  }

  // Clean up room memory
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.memory.nodeIds) {
      room.memory.nodeIds = room.memory.nodeIds.filter((id) => newNodeIds.has(id));
    }
  }

  const existingNodeIds = new Set(colony.getNodes().map((n) => n.id));
  const ownedRooms = new Set<string>();
  for (const roomName in Game.rooms) {
    if (Game.rooms[roomName].controller?.my) {
      ownedRooms.add(roomName);
    }
  }

  const surveyor = new NodeSurveyor();

  // Create/update nodes
  for (const peak of result.peaks) {
    const nodeId = peak.peakId;
    const positions = result.territories.get(nodeId);
    if (!positions || positions.length === 0) continue;

    const territorySize = positions.length;
    const spansRooms = [...new Set(positions.map((p) => p.roomName))];

    if (!existingNodeIds.has(nodeId)) {
      const peakPosition = { x: peak.center.x, y: peak.center.y, roomName: peak.roomName };
      const node = createNode(nodeId, peak.roomName, peakPosition, territorySize, spansRooms, Game.time);
      colony.addNode(node);
    }

    const node = colony.getNode(nodeId);
    if (node) {
      node.territorySize = territorySize;
      node.spansRooms = spansRooms;
      populateNodeResources(node, positions, result.territories);
      const surveyResult = surveyor.survey(node, Game.time);
      node.roi = calculateNodeROI(node, peak.height, ownedRooms, surveyResult.potentialCorps);
    }
  }

  console.log(`[MultiRoom] Updated ${colony.getNodes().length} nodes`);
}

/**
 * Performs unified multi-room spatial analysis and creates/updates nodes.
 *
 * This replaces per-room peak detection with a unified approach where:
 * - Distance transform crosses room boundaries
 * - Peaks are found based on true terrain openness
 * - Territories span rooms based purely on terrain
 */
function runMultiRoomAnalysis(colony: Colony): void {
  // Collect all rooms to analyze: 5x5 box centered on each owned room
  const roomsToAnalyzeSet = get5x5BoxAroundOwnedRooms();
  const roomsToAnalyze = Array.from(roomsToAnalyzeSet);

  if (roomsToAnalyze.length === 0) return;

  // Check cache
  if (multiRoomAnalysisCache && Game.time - multiRoomAnalysisCache.tick < MULTI_ROOM_ANALYSIS_CACHE_TTL) {
    // Use cached result for visualization
    return;
  }

  console.log(`[MultiRoom] Analyzing ${roomsToAnalyze.length} rooms: ${roomsToAnalyze.join(", ")}`);

  // Run unified multi-room analysis
  const result = analyzeMultiRoomTerrain(roomsToAnalyze, {
    maxRooms: roomsToAnalyze.length,
    peakOptions: { minHeight: 2 },
    limitToStartRooms: true,
  });

  // Compute territory adjacencies (edges between nodes)
  // Convert WorldPosition to WorldCoordinate for the algorithm
  const territoriesAsWorldCoord = new Map<string, WorldCoordinate[]>();
  for (const [peakId, positions] of result.territories) {
    territoriesAsWorldCoord.set(peakId, positions.map(p => ({
      x: p.x,
      y: p.y,
      roomName: p.roomName
    })));
  }
  result.adjacencies = findTerritoryAdjacencies(territoriesAsWorldCoord);
  console.log(`[MultiRoom] Computed ${result.adjacencies.size} edges between territories`);

  // Cache result
  multiRoomAnalysisCache = { result, tick: Game.time };

  // Debug: Log peaks per room
  const peaksByRoom = new Map<string, number>();
  for (const peak of result.peaks) {
    peaksByRoom.set(peak.roomName, (peaksByRoom.get(peak.roomName) || 0) + 1);
  }
  console.log(`[MultiRoom] Peaks by room: ${Array.from(peaksByRoom.entries()).map(([r, c]) => `${r}:${c}`).join(", ")}`);

  // Get set of new node IDs from multi-room analysis
  const newNodeIds = new Set(result.peaks.map((p) => p.peakId));

  // Remove existing nodes that are NOT in the new multi-room analysis
  // This clears old per-room nodes that were created before multi-room analysis
  const existingNodes = colony.getNodes();
  for (const node of existingNodes) {
    if (!newNodeIds.has(node.id)) {
      colony.removeNode(node.id);
      console.log(`[MultiRoom] Removed old node ${node.id}`);
    }
  }

  // Clean up room memory nodeIds for all rooms
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.memory.nodeIds) {
      room.memory.nodeIds = room.memory.nodeIds.filter((id) => newNodeIds.has(id));
    }
  }

  const existingNodeIds = new Set(colony.getNodes().map((n) => n.id));

  // Get owned rooms for ROI calculation
  const ownedRooms = new Set<string>();
  for (const roomName in Game.rooms) {
    if (Game.rooms[roomName].controller?.my) {
      ownedRooms.add(roomName);
    }
  }

  // Create surveyor for ROI estimation
  const surveyor = new NodeSurveyor();

  // Track stats for final summary
  let nodesCreated = 0;
  let nodesRemoved = 0;

  // Create/update nodes from peaks
  for (const peak of result.peaks) {
    const nodeId = peak.peakId;
    const positions = result.territories.get(nodeId);

    if (!positions || positions.length === 0) {
      // No territory for this peak - skip it
      if (existingNodeIds.has(nodeId)) {
        colony.removeNode(nodeId);
        nodesRemoved++;
        console.log(`[MultiRoom] Removed node ${nodeId} (no territory - peak on wall?)`);
      }
      continue;
    }

    // Calculate territory info
    const territorySize = positions.length;
    const spansRooms = [...new Set(positions.map((p) => p.roomName))];

    if (!existingNodeIds.has(nodeId)) {
      // Create new node
      const peakPosition = { x: peak.center.x, y: peak.center.y, roomName: peak.roomName };
      const node = createNode(nodeId, peak.roomName, peakPosition, territorySize, spansRooms, Game.time);
      colony.addNode(node);
      nodesCreated++;
    }

    // Update node territory info
    const node = colony.getNode(nodeId);
    if (node) {
      node.territorySize = territorySize;
      node.spansRooms = spansRooms;

      // Log cross-room territories
      if (spansRooms.length > 1) {
        console.log(`[MultiRoom] Node ${nodeId} spans ${spansRooms.length} rooms: ${spansRooms.join(", ")}`);
      }

      // Populate resources from room intel or live data (only within territory)
      populateNodeResources(node, positions, result.territories);

      // Survey node to find potential corps and their ROI
      const surveyResult = surveyor.survey(node, Game.time);

      // Calculate ROI based on potential corps
      node.roi = calculateNodeROI(node, peak.height, ownedRooms, surveyResult.potentialCorps);
    }
  }

  // Final summary
  const finalNodes = colony.getNodes();
  const nodesByRoom = new Map<string, number>();
  for (const node of finalNodes) {
    nodesByRoom.set(node.roomName, (nodesByRoom.get(node.roomName) || 0) + 1);
  }
  console.log(`[MultiRoom] Analysis complete: ${result.peaks.length} peaks, ${nodesCreated} created, ${nodesRemoved} removed (no territory)`);
  console.log(`[MultiRoom] Final nodes by room: ${Array.from(nodesByRoom.entries()).map(([r, c]) => `${r}:${c}`).join(", ") || "none"}`);
  console.log(`[MultiRoom] Territories in result: ${result.territories.size}`);
}

/**
 * Populates a node's resources from room intel or live game data.
 *
 * Only resources within the node's territory are included. Resources on wall
 * tiles (common for sources/minerals) are included if adjacent to a territory tile.
 * When a resource is adjacent to multiple territories, it's assigned to the node
 * with the lexicographically smallest adjacent tile (deterministic tie-breaker).
 */
function populateNodeResources(
  node: Node,
  territoryPositions: WorldPosition[],
  allTerritories: Map<string, WorldPosition[]>
): void {
  node.resources = [];

  // Build a set of territory position keys for efficient lookup
  const territorySet = new Set<string>();
  for (const pos of territoryPositions) {
    territorySet.add(`${pos.roomName}-${pos.x}-${pos.y}`);
  }

  // Build a map of all territory positions to their owning node for tie-breaking
  const positionToNode = new Map<string, string>();
  for (const [nodeId, positions] of allTerritories) {
    for (const pos of positions) {
      positionToNode.set(`${pos.roomName}-${pos.x}-${pos.y}`, nodeId);
    }
  }

  // Helper to check if a position should be claimed by this node.
  // For direct territory membership: always true.
  // For wall-adjacent resources: use lexicographically smallest adjacent tile as tie-breaker.
  const shouldClaimResource = (x: number, y: number, roomName: string): boolean => {
    const posKey = `${roomName}-${x}-${y}`;

    // Direct membership - always claim
    if (territorySet.has(posKey)) {
      return true;
    }

    // For wall resources: find the lexicographically smallest adjacent tile
    // that belongs to ANY territory, then check if it's ours
    let smallestAdjacentKey: string | null = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const adjKey = `${roomName}-${x + dx}-${y + dy}`;
        // Only consider tiles that belong to some territory
        if (positionToNode.has(adjKey)) {
          if (smallestAdjacentKey === null || adjKey < smallestAdjacentKey) {
            smallestAdjacentKey = adjKey;
          }
        }
      }
    }

    // Claim if the smallest adjacent tile is in our territory
    return smallestAdjacentKey !== null && territorySet.has(smallestAdjacentKey);
  };

  for (const roomName of node.spansRooms) {
    // Try live data first (if we have vision)
    const room = Game.rooms[roomName];
    if (room) {
      // Add sources within territory
      for (const source of room.find(FIND_SOURCES)) {
        if (shouldClaimResource(source.pos.x, source.pos.y, roomName)) {
          node.resources.push({
            type: "source",
            id: source.id,
            position: { x: source.pos.x, y: source.pos.y, roomName },
            capacity: source.energyCapacity
          });
        }
      }

      // Add controller if within territory
      if (room.controller && shouldClaimResource(room.controller.pos.x, room.controller.pos.y, roomName)) {
        node.resources.push({
          type: "controller",
          id: room.controller.id,
          position: { x: room.controller.pos.x, y: room.controller.pos.y, roomName },
          level: room.controller.level
        });
      }

      // Add minerals within territory
      for (const mineral of room.find(FIND_MINERALS)) {
        if (shouldClaimResource(mineral.pos.x, mineral.pos.y, roomName)) {
          node.resources.push({
            type: "mineral",
            id: mineral.id,
            position: { x: mineral.pos.x, y: mineral.pos.y, roomName },
            mineralType: mineral.mineralType
          });
        }
      }
    } else {
      // Fall back to room intel
      const intel = Memory.roomIntel?.[roomName];
      if (intel) {
        // Add sources from intel within territory
        for (const sourcePos of intel.sourcePositions || []) {
          if (shouldClaimResource(sourcePos.x, sourcePos.y, roomName)) {
            node.resources.push({
              type: "source",
              id: `intel-${roomName}-${sourcePos.x}-${sourcePos.y}`,
              position: { x: sourcePos.x, y: sourcePos.y, roomName },
              capacity: 3000 // Default capacity
            });
          }
        }

        // Add controller from intel if within territory
        if (intel.controllerPos && shouldClaimResource(intel.controllerPos.x, intel.controllerPos.y, roomName)) {
          node.resources.push({
            type: "controller",
            id: `intel-controller-${roomName}`,
            position: { x: intel.controllerPos.x, y: intel.controllerPos.y, roomName },
            level: intel.controllerLevel
          });
        }

        // Add mineral from intel if within territory
        if (intel.mineralPos && shouldClaimResource(intel.mineralPos.x, intel.mineralPos.y, roomName)) {
          node.resources.push({
            type: "mineral",
            id: `intel-mineral-${roomName}`,
            position: { x: intel.mineralPos.x, y: intel.mineralPos.y, roomName },
            mineralType: intel.mineralType ?? undefined
          });
        }
      }
    }
  }
}

/**
 * Persists all state to memory.
 */
function persistState(colony: Colony): void {
  // Persist colony
  Memory.colony = colony.serialize();

  // Persist nodes
  Memory.nodes = {};
  for (const node of colony.getNodes()) {
    Memory.nodes[node.id] = serializeNode(node);
  }

  // Persist node edges (from cached analysis)
  if (multiRoomAnalysisCache?.result.adjacencies) {
    Memory.nodeEdges = Array.from(multiRoomAnalysisCache.result.adjacencies);
  }

  // Persist bootstrap corps
  Memory.bootstrapCorps = {};
  for (const roomName in bootstrapCorps) {
    Memory.bootstrapCorps[roomName] = bootstrapCorps[roomName].serialize();
  }

  // Persist mining corps
  Memory.miningCorps = {};
  for (const sourceId in miningCorps) {
    Memory.miningCorps[sourceId] = miningCorps[sourceId].serialize();
  }

  // Persist hauling corps
  Memory.haulingCorps = {};
  for (const roomName in haulingCorps) {
    Memory.haulingCorps[roomName] = haulingCorps[roomName].serialize();
  }

  // Persist upgrading corps
  Memory.upgradingCorps = {};
  for (const roomName in upgradingCorps) {
    Memory.upgradingCorps[roomName] = upgradingCorps[roomName].serialize();
  }

  // Persist scout corps
  Memory.scoutCorps = {};
  for (const roomName in scoutCorps) {
    Memory.scoutCorps[roomName] = scoutCorps[roomName].serialize();
  }
}

/**
 * Cleans up memory for dead creeps.
 */
function cleanupDeadCreeps(): void {
  for (const name in Memory.creeps) {
    if (!Game.creeps[name]) {
      delete Memory.creeps[name];
    }
  }
}

/**
 * Updates telemetry data in RawMemory segments for external monitoring.
 */
function updateTelemetry(colony: Colony): void {
  const telemetry = getTelemetry();
  telemetry.update(
    colony,
    bootstrapCorps,
    miningCorps,
    haulingCorps,
    upgradingCorps,
    scoutCorps
  );
}

/**
 * Renders node visualization in rooms with vision.
 * Draws nodes at their peak positions and connections for cross-room nodes.
 */
function renderNodeVisuals(colony: Colony): void {
  const nodes = colony.getNodes();

  for (const node of nodes) {
    const roomName = node.peakPosition.roomName;
    // RoomVisual works without vision - no need to check Game.rooms
    const visual = new RoomVisual(roomName);
    const peak = node.peakPosition;
    const isOwned = node.roi?.isOwned;

    // Draw node circle at peak position
    const radius = Math.min(2, Math.max(0.8, (node.roi?.openness || 5) / 5));
    visual.circle(peak.x, peak.y, {
      radius,
      fill: isOwned ? "#60a5fa" : "#facc15",
      opacity: 0.6,
      stroke: isOwned ? "#3b82f6" : "#eab308",
      strokeWidth: 0.1,
    });

    // Draw source count in node
    const sourceCount = node.roi?.sourceCount || 0;
    visual.text(String(sourceCount), peak.x, peak.y + 0.15, {
      font: "bold 0.6 sans-serif",
      color: "#ffffff",
      align: "center",
    });

    // Draw controller indicator (small diamond above node)
    if (node.roi?.hasController) {
      visual.poly([
        [peak.x, peak.y - radius - 0.4],
        [peak.x + 0.3, peak.y - radius - 0.7],
        [peak.x, peak.y - radius - 1.0],
        [peak.x - 0.3, peak.y - radius - 0.7],
      ], {
        fill: "#e94560",
        opacity: 0.8,
      });
    }

    // Draw dashed lines to other rooms this node spans
    if (node.spansRooms.length > 1) {
      for (const spanRoom of node.spansRooms) {
        if (spanRoom === roomName) continue;

        // Find exit direction to target room and draw line toward it
        const exits = Game.map.describeExits(roomName);
        for (const [dir, exitRoom] of Object.entries(exits || {})) {
          if (exitRoom === spanRoom) {
            let targetX = peak.x;
            let targetY = peak.y;
            if (dir === "1") targetY = 0; // TOP
            if (dir === "3") targetX = 49; // RIGHT
            if (dir === "5") targetY = 49; // BOTTOM
            if (dir === "7") targetX = 0; // LEFT

            visual.line(peak.x, peak.y, targetX, targetY, {
              color: "#4a4a6e",
              width: 0.1,
              opacity: 0.5,
              lineStyle: "dashed",
            });
          }
        }
      }
    }
  }
}

/**
 * Renders spatial visualization (edges between peaks) for rooms.
 * Draws for all rooms in the analysis (owned rooms + nearby rooms).
 */
function renderSpatialVisuals(): void {
  if (!multiRoomAnalysisCache) return;

  // Get all unique room names from the analysis
  const roomsInAnalysis = new Set<string>();
  for (const peak of multiRoomAnalysisCache.result.peaks) {
    roomsInAnalysis.add(peak.roomName);
  }

  for (const roomName of roomsInAnalysis) {
    // Skip peaks since renderNodeVisuals draws colony nodes with ownership styling
    visualizeMultiRoomAnalysis(roomName, multiRoomAnalysisCache.result, false, true);
  }
}

/**
 * Logs statistics for monitoring.
 */
function logStats(colony: Colony): void {
  const stats = colony.getStats();
  const supply = colony.getMoneySupply();

  console.log(`[Colony] Tick ${Game.time}`);
  console.log(`  Nodes: ${stats.nodeCount}, Corps: ${stats.totalCorps} (${stats.activeCorps} active)`);
  console.log(`  Chains: ${stats.activeChains}, Treasury: ${supply.treasury.toFixed(0)}`);
  console.log(`  Money Supply: ${supply.net.toFixed(0)} (minted: ${supply.minted.toFixed(0)}, taxed: ${supply.taxed.toFixed(0)})`);

  // Log bootstrap stats
  let totalJacks = 0;
  for (const roomName in bootstrapCorps) {
    const corp = bootstrapCorps[roomName];
    totalJacks += corp.getCreepCount();
  }
  console.log(`  Bootstrap Jacks: ${totalJacks}`);

  // Log real corps stats
  let totalMiners = 0;
  let totalHaulers = 0;
  let totalUpgraders = 0;

  for (const sourceId in miningCorps) {
    totalMiners += miningCorps[sourceId].getCreepCount();
  }
  for (const roomName in haulingCorps) {
    totalHaulers += haulingCorps[roomName].getCreepCount();
  }
  for (const roomName in upgradingCorps) {
    totalUpgraders += upgradingCorps[roomName].getCreepCount();
  }

  let totalScouts = 0;
  for (const roomName in scoutCorps) {
    totalScouts += scoutCorps[roomName].getCreepCount();
  }

  console.log(`  Miners: ${totalMiners}, Haulers: ${totalHaulers}, Upgraders: ${totalUpgraders}, Scouts: ${totalScouts}`);
}
