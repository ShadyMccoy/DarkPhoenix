/**
 * @fileoverview Incremental multi-room terrain analysis.
 *
 * This module handles the CPU-intensive spatial analysis of rooms,
 * spreading the work across multiple ticks to avoid CPU timeouts.
 * The analysis identifies territory peaks and their adjacencies.
 *
 * @module execution/IncrementalAnalysis
 */

import "../types/Memory";
import { Colony } from "../colony";
import { createNode, Node, calculateNodeROI, NodeSurveyor, ReachableSource } from "../nodes";
import {
  analyzeMultiRoomTerrain,
  MultiRoomAnalysisResult,
  findTerritoryAdjacencies,
  WorldCoordinate,
  WorldPosition,
  CrossRoomPeak,
} from "../spatial";
import { get7x7BoxAroundOwnedRooms } from "../utils";

// =============================================================================
// CONSTANTS
// =============================================================================

/** TTL for multi-room analysis cache (5000 ticks ≈ ~4 hours) */
export const MULTI_ROOM_ANALYSIS_CACHE_TTL = 5000;

/** Max rooms to analyze per batch to avoid CPU timeout */
const ROOMS_PER_BATCH = 9;

// =============================================================================
// STATE
// =============================================================================

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

/** Current incremental analysis state */
let incrementalState: IncrementalAnalysisState | null = null;

/** Cache for multi-room analysis results */
let multiRoomAnalysisCache: { result: MultiRoomAnalysisResult; tick: number } | null = null;

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Gets the current analysis cache.
 */
export function getAnalysisCache(): { result: MultiRoomAnalysisResult; tick: number } | null {
  return multiRoomAnalysisCache;
}

/**
 * Checks if an incremental analysis is in progress.
 */
export function isAnalysisInProgress(): boolean {
  return incrementalState !== null;
}

/**
 * Force recalculation of multi-room spatial analysis.
 */
export function resetAnalysis(): void {
  multiRoomAnalysisCache = null;
  incrementalState = null;
}

/**
 * Restore visualization cache from persisted Memory data.
 * This allows edge visualization without running the expensive analysis.
 *
 * NOTE: If any nodes are missing ROI or expansionScore, we don't create
 * the cache. This forces the full analysis to run, which will calculate
 * proper ROI for all nodes.
 */
export function restoreVisualizationCache(colony: Colony): void {
  if (multiRoomAnalysisCache) return; // Already have cache

  const nodes = colony.getNodes();
  if (nodes.length === 0) return; // No nodes to visualize

  // Check if any nodes are missing ROI or expansionScore
  // If so, don't create the cache - let the full analysis run to calculate ROI
  const hasMissingROI = nodes.some(node =>
    !node.roi || node.roi.expansionScore === undefined
  );
  if (hasMissingROI) {
    console.log(`[Colony] Nodes missing ROI/expansionScore - skipping visualization cache to trigger analysis`);
    return;
  }

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
 * Runs terrain analysis incrementally across multiple ticks.
 * Processes rooms in small batches to avoid CPU timeout.
 * Returns true if analysis is complete, false if still in progress.
 */
export function runIncrementalAnalysis(colony: Colony): boolean {
  // Check if we should start a new analysis
  if (!incrementalState) {
    // Check cache first
    if (multiRoomAnalysisCache && Game.time - multiRoomAnalysisCache.tick < MULTI_ROOM_ANALYSIS_CACHE_TTL) {
      return true; // Use cached result
    }

    const roomsToAnalyzeSet = get7x7BoxAroundOwnedRooms();
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

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

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

  // Build position-to-node map ONCE for all nodes (tie-breaking for wall resources)
  const positionToNode = new Map<string, string>();
  for (const [nodeId, positions] of result.territories) {
    for (const pos of positions) {
      positionToNode.set(`${pos.roomName}-${pos.x}-${pos.y}`, nodeId);
    }
  }

  // Build peak height map for quick lookup
  const peakHeightMap = new Map<string, number>();
  for (const peak of result.peaks) {
    peakHeightMap.set(peak.peakId, peak.height);
  }

  // First pass: create/update nodes and populate resources
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
      populateNodeResources(node, positions, positionToNode);
    }
  }

  // Build adjacency map from result.adjacencies
  // Adjacencies are stored as "nodeA|nodeB" strings
  const adjacencyMap = new Map<string, Set<string>>();
  for (const edgeKey of result.adjacencies || []) {
    const [nodeA, nodeB] = edgeKey.split("|");
    if (!adjacencyMap.has(nodeA)) adjacencyMap.set(nodeA, new Set());
    if (!adjacencyMap.has(nodeB)) adjacencyMap.set(nodeB, new Set());
    adjacencyMap.get(nodeA)!.add(nodeB);
    adjacencyMap.get(nodeB)!.add(nodeA);
  }

  // Second pass: calculate ROI with reachable sources from adjacent nodes
  for (const peak of result.peaks) {
    const nodeId = peak.peakId;
    const node = colony.getNode(nodeId);
    if (!node) continue;

    // Gather reachable sources from adjacent nodes
    const reachableSources: ReachableSource[] = [];
    const adjacentNodeIds = adjacencyMap.get(nodeId) || new Set();

    for (const adjNodeId of adjacentNodeIds) {
      const adjNode = colony.getNode(adjNodeId);
      if (!adjNode) continue;

      // Get sources from adjacent node (skip Source Keeper rooms for now)
      const sources = adjNode.resources.filter(r =>
        r.type === "source" && !isSourceKeeperRoom(r.position.roomName)
      );
      for (const source of sources) {
        // Calculate distance from this node's peak to the source
        const distance = estimateSourceDistance(node, source.position);
        reachableSources.push({
          capacity: source.capacity ?? 3000,
          distance
        });
      }
    }

    const surveyResult = surveyor.survey(node, Game.time);
    node.roi = calculateNodeROI(node, peak.height, ownedRooms, surveyResult.potentialCorps, reachableSources);
  }

  console.log(`[MultiRoom] Updated ${colony.getNodes().length} nodes`);
}

/**
 * Estimate distance from a node's peak to a source position.
 * Uses Manhattan distance for same room, adds 50 tiles per room for cross-room.
 */
function estimateSourceDistance(node: Node, sourcePos: { x: number; y: number; roomName: string }): number {
  if (node.peakPosition.roomName === sourcePos.roomName) {
    // Same room - Manhattan distance
    return Math.abs(node.peakPosition.x - sourcePos.x) + Math.abs(node.peakPosition.y - sourcePos.y);
  }

  // Cross-room: estimate room distance and add in-room distance
  const parseRoom = (name: string): { x: number; y: number } | null => {
    const match = name.match(/^([WE])(\d+)([NS])(\d+)$/);
    if (!match) return null;
    const x = match[1] === "W" ? -parseInt(match[2]) : parseInt(match[2]);
    const y = match[3] === "N" ? -parseInt(match[4]) : parseInt(match[4]);
    return { x, y };
  };

  const nodeRoomCoord = parseRoom(node.peakPosition.roomName);
  const sourceRoomCoord = parseRoom(sourcePos.roomName);

  if (!nodeRoomCoord || !sourceRoomCoord) return 100; // Fallback

  const roomDistance = Math.abs(nodeRoomCoord.x - sourceRoomCoord.x) + Math.abs(nodeRoomCoord.y - sourceRoomCoord.y);

  // Base: 50 tiles per room + average in-room distance (~25 tiles)
  return roomDistance * 50 + 25;
}

/**
 * Check if a room is a Source Keeper room.
 * SK rooms have coordinates where both X and Y end in 4, 5, or 6,
 * but are not center rooms (where both end in 5).
 */
function isSourceKeeperRoom(roomName: string): boolean {
  const match = roomName.match(/^[WE](\d+)[NS](\d+)$/);
  if (!match) return false;

  const x = parseInt(match[1]) % 10;
  const y = parseInt(match[2]) % 10;

  // Center rooms (portals) have both coords ending in 5
  if (x === 5 && y === 5) return false;

  // SK rooms have both coords in [4, 5, 6] range
  return x >= 4 && x <= 6 && y >= 4 && y <= 6;
}

/**
 * Populates a node's resources from room intel or live game data.
 *
 * Only resources within the node's territory are included. Resources on wall
 * tiles (common for sources/minerals) are included if adjacent to a territory tile.
 * When a resource is adjacent to multiple territories, it's assigned to the node
 * with the lexicographically smallest adjacent tile (deterministic tie-breaker).
 *
 * @param positionToNode Pre-built map of position keys to node IDs (shared across all nodes)
 */
function populateNodeResources(
  node: Node,
  territoryPositions: WorldPosition[],
  positionToNode: Map<string, string>
): void {
  node.resources = [];

  // Build a set of territory position keys for efficient lookup
  const territorySet = new Set<string>();
  for (const pos of territoryPositions) {
    territorySet.add(`${pos.roomName}-${pos.x}-${pos.y}`);
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

  // Get my username for ownership checks
  const myUsername = Object.values(Game.spawns)[0]?.owner?.username;

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

      // Add controller if within territory (only if owned by us)
      if (room.controller && room.controller.my && shouldClaimResource(room.controller.pos.x, room.controller.pos.y, roomName)) {
        node.resources.push({
          type: "controller",
          id: room.controller.id,
          position: { x: room.controller.pos.x, y: room.controller.pos.y, roomName },
          level: room.controller.level,
          isOwned: true
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

      // Add spawns within territory
      for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (shouldClaimResource(spawn.pos.x, spawn.pos.y, roomName)) {
          node.resources.push({
            type: "spawn",
            id: spawn.id,
            position: { x: spawn.pos.x, y: spawn.pos.y, roomName },
            capacity: 300  // Spawn energy capacity
          });
        }
      }
    } else {
      // Fall back to room intel
      const intel = Memory.roomIntel?.[roomName];
      if (intel) {
        // Check if this room is owned by us (from intel)
        const isOwnedRoom = myUsername && intel.controllerOwner === myUsername;

        // Source capacity: 3000 for owned rooms, 1500 for unclaimed/unowned
        const sourceCapacity = isOwnedRoom ? 3000 : 1500;

        // Add sources from intel within territory
        for (const sourcePos of intel.sourcePositions || []) {
          if (shouldClaimResource(sourcePos.x, sourcePos.y, roomName)) {
            node.resources.push({
              type: "source",
              id: `intel-${roomName}-${sourcePos.x}-${sourcePos.y}`,
              position: { x: sourcePos.x, y: sourcePos.y, roomName },
              capacity: sourceCapacity
            });
          }
        }

        // Add controller from intel only if owned by us
        if (intel.controllerPos && isOwnedRoom && shouldClaimResource(intel.controllerPos.x, intel.controllerPos.y, roomName)) {
          node.resources.push({
            type: "controller",
            id: `intel-controller-${roomName}`,
            position: { x: intel.controllerPos.x, y: intel.controllerPos.y, roomName },
            level: intel.controllerLevel,
            isOwned: true
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
