/**
 * @fileoverview Multi-room spatial analysis system.
 *
 * This module provides cross-room spatial analysis for colony planning
 * and territory management. It uses distance transforms and peak detection
 * to identify optimal building locations across multiple rooms.
 *
 * ## Key Concepts
 *
 * ### Multi-Room Distance Transform
 * Unlike single-room analysis, the distance transform crosses room boundaries.
 * This means positions near exits get accurate "distance from walls" values
 * by considering terrain in adjacent rooms.
 *
 * ### Peak Detection
 * Peaks are local maxima in the distance transform - the centers of open areas.
 * These are ideal locations for bases, extensions, and towers.
 *
 * ### Territory Division
 * Using BFS flood fill from peaks, rooms are divided into territories.
 * Each tile belongs to the nearest peak, enabling zone-based management.
 *
 * @module spatial/RoomMap
 */

import {
  createMultiRoomDistanceTransform,
  findMultiRoomPeaks,
  filterMultiRoomPeaks,
  bfsDivideMultiRoom,
  MultiRoomTerrainCallback,
  WorldPeakData,
  WorldCoordinate,
  FilterPeaksOptions,
} from "./algorithms";

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Position with room name for cross-room territories.
 */
export interface WorldPosition {
  x: number;
  y: number;
  roomName: string;
}

/**
 * Peak info for cross-room territory calculation.
 */
export interface CrossRoomPeak {
  /** Peak ID (format: "roomName-x-y") */
  peakId: string;
  /** Room where peak is located */
  roomName: string;
  /** Peak center coordinates */
  center: { x: number; y: number };
  /** Peak height (distance from walls) */
  height: number;
}

/**
 * Result of multi-room spatial analysis.
 */
export interface MultiRoomAnalysisResult {
  /** All peaks found across rooms (peaks can be near room edges) */
  peaks: CrossRoomPeak[];
  /** Territory assignments for each peak (may span multiple rooms) */
  territories: Map<string, WorldPosition[]>;
  /** Distance transform values (for visualization) */
  distances: Map<string, number>;
  /** Territory adjacencies - edges between peaks with touching territories (computed incrementally) */
  adjacencies?: Set<string>;
  /** Walking distances between adjacent peaks - edge weights (computed incrementally) */
  edgeWeights?: Map<string, number>;
}

/**
 * Options for multi-room spatial analysis.
 */
export interface MultiRoomAnalysisOptions {
  /** Maximum rooms to include in analysis (default: 9) */
  maxRooms?: number;
  /** Peak filtering options */
  peakOptions?: FilterPeaksOptions;
  /** If true, strictly limit analysis to startRooms only (no room expansion) */
  limitToStartRooms?: boolean;
}

// ============================================================================
// Terrain Callbacks
// ============================================================================

/**
 * Creates a multi-room terrain callback that uses Game.map.getRoomTerrain.
 * Caches terrain data to avoid repeated API calls.
 *
 * @returns Multi-room terrain callback
 */
export function createMultiRoomTerrainCallback(): MultiRoomTerrainCallback {
  const terrainCache: { [roomName: string]: RoomTerrain } = {};

  return (roomName: string, x: number, y: number): number => {
    if (!terrainCache[roomName]) {
      terrainCache[roomName] = Game.map.getRoomTerrain(roomName);
    }
    return terrainCache[roomName].get(x, y);
  };
}

// ============================================================================
// Main Analysis Functions
// ============================================================================

/**
 * Performs unified spatial analysis across multiple rooms.
 *
 * This is the main entry point for cross-room node mapping. It:
 * 1. Computes a distance transform that crosses room boundaries
 * 2. Finds peaks based on true terrain openness (not affected by room edges)
 * 3. Assigns territories using BFS from all peaks simultaneously
 *
 * Peaks naturally fall where terrain is most open, regardless of room boundaries.
 * A large open area spanning two rooms will have its peak at the true center.
 *
 * @param startRooms - Rooms to include in the analysis
 * @param options - Analysis options
 * @returns Peaks and territories spanning multiple rooms
 *
 * @example
 * const result = analyzeMultiRoomTerrain(["W1N1", "W1N2", "W2N1"]);
 * for (const peak of result.peaks) {
 *   console.log(`Peak at ${peak.roomName} (${peak.center.x},${peak.center.y}) height=${peak.height}`);
 *   const territory = result.territories.get(peak.peakId);
 *   console.log(`  Territory: ${territory?.length} tiles across rooms`);
 * }
 */
export function analyzeMultiRoomTerrain(
  startRooms: string[],
  options: MultiRoomAnalysisOptions = {}
): MultiRoomAnalysisResult {
  const { maxRooms = 9, peakOptions = {}, limitToStartRooms = false } = options;

  // Create terrain callback
  const terrainCallback = createMultiRoomTerrainCallback();

  // Create set of allowed rooms (only startRooms if limiting)
  const allowedRooms = limitToStartRooms ? new Set(startRooms) : undefined;

  // Step 1: Compute multi-room distance transform
  const distances = createMultiRoomDistanceTransform(
    startRooms,
    terrainCallback,
    TERRAIN_MASK_WALL,
    maxRooms,
    allowedRooms
  );

  // Step 2: Find peaks across all rooms
  const rawPeaks = findMultiRoomPeaks(distances);

  // Step 3: Filter peaks
  const filteredPeaks = filterMultiRoomPeaks(rawPeaks, peakOptions);

  // Convert to CrossRoomPeak format
  const peaks: CrossRoomPeak[] = filteredPeaks.map((p) => ({
    peakId: `${p.center.roomName}-${p.center.x}-${p.center.y}`,
    roomName: p.center.roomName,
    center: { x: p.center.x, y: p.center.y },
    height: p.height,
  }));

  // Step 4: Divide territories using BFS from peaks
  const worldPeaks: WorldPeakData[] = filteredPeaks;
  const rawTerritories = bfsDivideMultiRoom(
    worldPeaks,
    terrainCallback,
    TERRAIN_MASK_WALL,
    maxRooms,
    allowedRooms
  );

  // Convert to WorldPosition format
  const territories = new Map<string, WorldPosition[]>();
  for (const [peakId, coords] of rawTerritories) {
    territories.set(
      peakId,
      coords.map((c: WorldCoordinate) => ({
        x: c.x,
        y: c.y,
        roomName: c.roomName,
      }))
    );
  }

  // Adjacencies and edge weights are computed incrementally via createSkeletonBuilderState
  // and processSkeletonBuilderChunk to avoid CPU timeouts

  return { peaks, territories, distances };
}

/**
 * Calculates cross-room territories for a set of peaks.
 *
 * This function takes peaks from multiple rooms and assigns territories
 * based on BFS distance, allowing territories to cross room boundaries.
 * Terrain is the only factor - room boundaries don't affect assignment.
 *
 * @param peaks - Peaks from all rooms to divide territory among
 * @param maxRooms - Maximum number of rooms to expand into (default: 9)
 * @returns Map of peak IDs to their territory positions (may include positions from multiple rooms)
 *
 * @example
 * const peaks = [
 *   { peakId: "W1N1-25-30", roomName: "W1N1", center: { x: 25, y: 30 }, height: 8 },
 *   { peakId: "W1N2-25-45", roomName: "W1N2", center: { x: 25, y: 45 }, height: 6 },
 * ];
 * const territories = calculateCrossRoomTerritories(peaks);
 * // territories.get("W1N1-25-30") may include positions from both W1N1 and W1N2
 */
export function calculateCrossRoomTerritories(
  peaks: CrossRoomPeak[],
  maxRooms: number = 9
): Map<string, WorldPosition[]> {
  if (peaks.length === 0) {
    return new Map();
  }

  // Convert to WorldPeakData format
  const worldPeaks: WorldPeakData[] = peaks.map((p) => ({
    tiles: [{ x: p.center.x, y: p.center.y, roomName: p.roomName }],
    center: { x: p.center.x, y: p.center.y, roomName: p.roomName },
    height: p.height,
  }));

  // Create multi-room terrain callback
  const terrainCallback = createMultiRoomTerrainCallback();

  // Run BFS territory division
  const rawTerritories = bfsDivideMultiRoom(
    worldPeaks,
    terrainCallback,
    TERRAIN_MASK_WALL,
    maxRooms
  );

  // Convert WorldCoordinate to WorldPosition
  const territories = new Map<string, WorldPosition[]>();
  for (const [peakId, coords] of rawTerritories) {
    territories.set(
      peakId,
      coords.map((c: WorldCoordinate) => ({
        x: c.x,
        y: c.y,
        roomName: c.roomName,
      }))
    );
  }

  return territories;
}

// ============================================================================
// Feature Collection
// ============================================================================

/**
 * Collects feature positions from a room with vision.
 * Includes sources, controller, and mineral positions.
 *
 * @param room - The room to collect features from
 * @returns Array of feature positions
 */
export function collectFeaturePositions(room: Room): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = [];

  // Add sources
  for (const source of room.find(FIND_SOURCES)) {
    positions.push({ x: source.pos.x, y: source.pos.y });
  }

  // Add controller
  if (room.controller) {
    positions.push({ x: room.controller.pos.x, y: room.controller.pos.y });
  }

  // Add minerals
  for (const mineral of room.find(FIND_MINERALS)) {
    positions.push({ x: mineral.pos.x, y: mineral.pos.y });
  }

  return positions;
}

/**
 * Collects feature positions from room intel (no vision required).
 *
 * @param roomName - The room name to look up
 * @returns Array of feature positions, or empty array if no intel
 */
export function collectFeaturePositionsFromIntel(roomName: string): { x: number; y: number }[] {
  const intel = Memory.roomIntel?.[roomName];
  if (!intel) return [];

  const positions: { x: number; y: number }[] = [];

  // Add sources from intel
  for (const sourcePos of intel.sourcePositions) {
    positions.push({ x: sourcePos.x, y: sourcePos.y });
  }

  // Add mineral from intel
  if (intel.mineralPos) {
    positions.push({ x: intel.mineralPos.x, y: intel.mineralPos.y });
  }

  return positions;
}

// ============================================================================
// Visualization
// ============================================================================

/**
 * Internal edge representation for visualization.
 */
interface VisualizationEdge {
  sourcePeakId: string;
  targetPeakId: string;
  sourceCenter: { x: number; y: number };
  targetCenter: { x: number; y: number };
  distance: number;
}

/**
 * Internal inter-room edge for visualization.
 */
interface VisualizationInterRoomEdge {
  peakId: string;
  peakCenter: { x: number; y: number };
  exitPos: { x: number; y: number };
  targetRoom: string;
}

/**
 * Calculates Chebyshev distance (max of dx, dy) between two positions.
 * This is the geometric distance ignoring walls.
 */
function chebyshevDistance(
  from: { x: number; y: number },
  to: { x: number; y: number }
): number {
  return Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y));
}

/**
 * Builds edges for visualization using pre-computed adjacencies and edge weights.
 * Uses cached data to avoid expensive per-tick recomputation.
 */
function buildVisualizationEdgesFromCache(
  peaksInRoom: CrossRoomPeak[],
  allPeaks: CrossRoomPeak[],
  adjacencies: Set<string>,
  edgeWeights: Map<string, number>
): VisualizationEdge[] {
  if (peaksInRoom.length === 0) return [];

  const edges: VisualizationEdge[] = [];
  const addedEdges = new Set<string>();
  const targetRoom = peaksInRoom[0]?.roomName;

  // Build peak lookup by ID
  const peakById = new Map<string, CrossRoomPeak>();
  for (const peak of allPeaks) {
    peakById.set(peak.peakId, peak);
  }

  // Create edges only for adjacent territories
  for (const adjacencyKey of adjacencies) {
    const [peakId1, peakId2] = adjacencyKey.split("|");
    const p1 = peakById.get(peakId1);
    const p2 = peakById.get(peakId2);

    if (!p1 || !p2) continue;

    // Only include edges where at least one endpoint is in this room
    if (p1.roomName !== targetRoom && p2.roomName !== targetRoom) {
      continue;
    }

    if (addedEdges.has(adjacencyKey)) continue;
    addedEdges.add(adjacencyKey);

    // Use pre-computed walking distance
    const distance = edgeWeights.get(adjacencyKey) ?? chebyshevDistance(p1.center, p2.center);

    edges.push({
      sourcePeakId: p1.peakId,
      targetPeakId: p2.peakId,
      sourceCenter: p1.center,
      targetCenter: p2.center,
      distance,
    });
  }

  return edges;
}

/**
 * Builds inter-room edges from peaks to adjacent room exits.
 */
function buildVisualizationInterRoomEdges(
  peaksInRoom: CrossRoomPeak[],
  roomName: string
): VisualizationInterRoomEdge[] {
  if (peaksInRoom.length === 0) return [];

  const exits = Game.map.describeExits(roomName);
  if (!exits) return [];

  const interRoomEdges: VisualizationInterRoomEdge[] = [];

  const exitDirections: { dir: ExitConstant; midPos: { x: number; y: number } }[] = [
    { dir: TOP, midPos: { x: 25, y: 0 } },
    { dir: BOTTOM, midPos: { x: 25, y: 49 } },
    { dir: LEFT, midPos: { x: 0, y: 25 } },
    { dir: RIGHT, midPos: { x: 49, y: 25 } },
  ];

  for (const { dir, midPos } of exitDirections) {
    const targetRoom = exits[dir];
    if (!targetRoom) continue;

    // Find the closest peak to this exit
    let closestPeak = peaksInRoom[0];
    let closestDist = Infinity;

    for (const peak of peaksInRoom) {
      const dist = Math.abs(peak.center.x - midPos.x) + Math.abs(peak.center.y - midPos.y);
      if (dist < closestDist) {
        closestDist = dist;
        closestPeak = peak;
      }
    }

    interRoomEdges.push({
      peakId: closestPeak.peakId,
      peakCenter: closestPeak.center,
      exitPos: midPos,
      targetRoom,
    });
  }

  return interRoomEdges;
}

/**
 * Visualizes multi-room analysis results in a specific room.
 *
 * @param roomName - Room to render visualization in
 * @param result - Analysis result from analyzeMultiRoomTerrain
 * @param showDistances - Whether to show distance values (can be noisy)
 * @param skipPeaks - If true, skip drawing peak circles (use when colony nodes are drawn separately)
 */
export function visualizeMultiRoomAnalysis(
  roomName: string,
  result: MultiRoomAnalysisResult,
  showDistances: boolean = false,
  skipPeaks: boolean = false
): void {
  const visual = new RoomVisual(roomName);

  // Get peaks in this room
  const peaksInRoom = result.peaks.filter((p) => p.roomName === roomName);
  const maxHeight = Math.max(...result.peaks.map((p) => p.height), 1);

  // Draw edges only if adjacencies have been computed (incrementally)
  if (result.adjacencies) {
    const edges = buildVisualizationEdgesFromCache(
      peaksInRoom,
      result.peaks,
      result.adjacencies,
      result.edgeWeights ?? new Map()
    );
    for (const edge of edges) {
      // Draw edge line
      visual.line(
        edge.sourceCenter.x, edge.sourceCenter.y,
        edge.targetCenter.x, edge.targetCenter.y,
        {
          color: "#ffffff",
          opacity: 0.8,
          width: 0.15,
        }
      );

      // Draw distance label at midpoint
      const midX = (edge.sourceCenter.x + edge.targetCenter.x) / 2;
      const midY = (edge.sourceCenter.y + edge.targetCenter.y) / 2;
      if (edge.distance < Infinity) {
        visual.text(`${edge.distance}`, midX, midY, {
          font: 0.4,
          color: "#ffffff",
          stroke: "#000000",
          strokeWidth: 0.1,
        });
      }
    }
  }

  // Build and draw inter-room edges
  const interRoomEdges = buildVisualizationInterRoomEdges(peaksInRoom, roomName);
  for (const interEdge of interRoomEdges) {
    // Draw dashed line from peak to exit
    visual.line(
      interEdge.peakCenter.x, interEdge.peakCenter.y,
      interEdge.exitPos.x, interEdge.exitPos.y,
      {
        color: "#88ccff",
        opacity: 0.6,
        width: 0.1,
        lineStyle: "dashed",
      }
    );

    // Draw exit marker (circle)
    visual.circle(interEdge.exitPos.x, interEdge.exitPos.y, {
      fill: "#88ccff",
      opacity: 0.5,
      radius: 0.3,
    });

    // Label with target room name
    visual.text(interEdge.targetRoom, interEdge.exitPos.x, interEdge.exitPos.y + 0.8, {
      font: 0.3,
      color: "#88ccff",
      stroke: "#000000",
      strokeWidth: 0.05,
    });
  }

  // Draw peak nodes - skip if colony nodes are drawn separately
  if (!skipPeaks) {
    peaksInRoom.forEach((peak, index) => {
      const opacity = 0.5 + (peak.height / maxHeight) * 0.5;
      visual.circle(peak.center.x, peak.center.y, {
        fill: "yellow",
        stroke: "#886600",
        strokeWidth: 0.1,
        opacity,
        radius: 0.4 + (peak.height / maxHeight) * 0.3,
      });
      // Label top 3 peaks with their height
      if (index < 3) {
        visual.text(`${peak.height}`, peak.center.x, peak.center.y + 0.15, {
          font: 0.35,
          color: "#000000",
        });
      }
    });
  }

  // Show distance values if requested (can be noisy but useful for debugging)
  if (showDistances) {
    for (let x = 0; x < 50; x += 5) {
      for (let y = 0; y < 50; y += 5) {
        const key = `${roomName}:${x},${y}`;
        const dist = result.distances.get(key);
        if (dist !== undefined && dist > 0) {
          visual.text(`${dist}`, x, y, {
            font: 0.25,
            color: "#888888",
            opacity: 0.5,
          });
        }
      }
    }
  }
}

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Invalidates the room map cache for a specific room or all rooms.
 * This forces the room map to be recalculated on next access.
 *
 * @param roomName - The room to invalidate, or undefined to invalidate all rooms
 */
export function invalidateRoomMapCache(roomName?: string): void {
  if (!Memory.roomMapCache) return;

  if (roomName) {
    delete Memory.roomMapCache[roomName];
  } else {
    Memory.roomMapCache = {};
  }
}
