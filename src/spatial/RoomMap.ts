/**
 * @fileoverview Spatial analysis system for room mapping.
 *
 * The RoomMap module provides sophisticated spatial analysis for colony
 * planning and territory management. It uses distance transforms and
 * peak detection to identify optimal building locations.
 *
 * ## Design Pattern: Pure Core / Imperative Shell
 *
 * This class is the "Imperative Shell" that:
 * - Calls pure functions from algorithms.ts with Game API data
 * - Converts results to RoomPosition objects
 * - Handles visualization
 *
 * The pure algorithms in algorithms.ts can be tested independently
 * without mocking Screeps globals.
 *
 * ## Key Concepts
 *
 * ### Inverted Distance Transform
 * Traditional distance transforms measure distance FROM a point.
 * Our inverted transform measures distance TO walls, then inverts
 * so that open areas have HIGH values. This makes "peaks" represent
 * the most buildable spaces.
 *
 * ### Peak Detection
 * Peaks are local maxima in the distance transform - the centers
 * of open areas. These are ideal locations for:
 * - Base placement (highest peak = most open area)
 * - Extension clusters
 * - Tower positioning
 *
 * ### Territory Division
 * Using BFS flood fill from peaks, the room is divided into
 * territories. Each tile belongs to the nearest peak, enabling
 * zone-based management and resource allocation.
 *
 * @module spatial/RoomMap
 */

import { RoomRoutine } from "../core/RoomRoutine";
import { forEach } from "lodash";
import {
  createDistanceTransform,
  findPeaks as findPeaksPure,
  filterPeaks as filterPeaksPure,
  bfsDivideRoom as bfsDivideRoomPure,
  GRID_SIZE,
  TerrainCallback,
  PeakData,
  Coordinate,
} from "./algorithms";

/**
 * Represents a spatial peak (local maximum in distance from walls).
 *
 * Peaks identify optimal locations for bases, extensions, and control points.
 * Higher peaks are more desirable as they have more open space around them.
 */
export interface Peak {
  /** All tiles at this peak's height (plateau) */
  tiles: RoomPosition[];
  /** Centroid of the peak cluster */
  center: RoomPosition;
  /** Distance transform value (higher = more open space) */
  height: number;
}

/**
 * Territory assigned to a peak via BFS flood fill.
 *
 * Used for zone-based creep management and resource allocation.
 */
export interface Territory {
  /** Identifier for the peak owning this territory */
  peakId: string;
  /** All positions belonging to this territory */
  positions: RoomPosition[];
}

/**
 * Edge connecting two peaks in the skeleton graph.
 */
export interface Edge {
  /** Index of source peak */
  source: number;
  /** Index of target peak */
  target: number;
  /** Pathfinding distance between peaks (ignoring walls, through walkable terrain) */
  distance: number;
}

/**
 * Converts a PeakData (pure) to Peak (with RoomPositions).
 */
function peakDataToPeak(data: PeakData, roomName: string): Peak {
  return {
    tiles: data.tiles.map((t) => new RoomPosition(t.x, t.y, roomName)),
    center: new RoomPosition(data.center.x, data.center.y, roomName),
    height: data.height,
  };
}

/**
 * Creates a terrain callback from a Room's terrain.
 */
function createTerrainCallback(room: Room): TerrainCallback {
  const terrain = Game.map.getRoomTerrain(room.name);
  return (x: number, y: number) => terrain.get(x, y);
}

/**
 * Spatial analysis and mapping for a room.
 *
 * Provides peak detection, territory division, and distance metrics
 * for colony planning decisions.
 *
 * @example
 * const roomMap = new RoomMap(room);
 * const bestPeak = roomMap.getBestBasePeak();
 * console.log(`Best base location: ${bestPeak?.center}`);
 */
export class RoomMap extends RoomRoutine {
  name = "RoomMap";

  /** Distance transform grid (inverted: higher values = more open areas) */
  private distanceTransform: number[][] = [];

  /** Detected peaks (optimal building locations) */
  private peaks: Peak[] = [];

  /** Territory assignments (which peak owns which tiles) */
  private territories: Map<string, RoomPosition[]> = new Map();

  /** Skeleton graph edges with pathfinding distances */
  private edges: Edge[] = [];

  /** Terrain callback for pathfinding */
  private terrainCallback: TerrainCallback | null = null;

  /**
   * Creates a new RoomMap with full spatial analysis.
   *
   * Performs all spatial calculations on construction:
   * - Distance transform computation
   * - Peak detection and filtering
   * - Territory division
   *
   * @param room - The room to analyze
   */
  constructor(room: Room) {
    super(new RoomPosition(25, 25, room.name), {});

    this.terrainCallback = createTerrainCallback(room);

    // Create inverted distance transform (peaks = open areas)
    this.distanceTransform = createDistanceTransform(
      this.terrainCallback,
      TERRAIN_MASK_WALL
    );

    // Find and filter peaks (using pure functions)
    const peakDataList = findPeaksPure(
      this.distanceTransform,
      this.terrainCallback,
      TERRAIN_MASK_WALL
    );
    const filteredPeakData = filterPeaksPure(peakDataList);

    // Convert PeakData to Peak (with RoomPositions)
    this.peaks = filteredPeakData.map((pd) => peakDataToPeak(pd, room.name));

    // Divide room into territories using BFS (pure function)
    const territoryData = bfsDivideRoomPure(
      filteredPeakData,
      this.terrainCallback,
      TERRAIN_MASK_WALL
    );

    // Convert territories to RoomPositions
    for (const [peakId, coords] of territoryData) {
      const positions = coords.map(
        (c: Coordinate) => new RoomPosition(c.x, c.y, room.name)
      );
      // Use room name prefix for consistency with original implementation
      const fullPeakId = `${room.name}-${peakId}`;
      this.territories.set(fullPeakId, positions);
    }

    // Build skeleton graph edges
    this.buildEdges();

    // Visualize results
    this.visualize(room);
  }

  /**
   * Gets all detected peaks, sorted by height (most open first).
   *
   * @returns Sorted array of peaks
   */
  getPeaks(): Peak[] {
    return [...this.peaks].sort((a, b) => b.height - a.height);
  }

  /**
   * Gets the best peak for base placement.
   *
   * The highest peak represents the most open area in the room,
   * ideal for the main base location.
   *
   * @returns The highest peak, or undefined if none found
   */
  getBestBasePeak(): Peak | undefined {
    return this.peaks.reduce(
      (best, peak) => (!best || peak.height > best.height ? peak : best),
      undefined as Peak | undefined
    );
  }

  /**
   * Gets the territory assigned to a specific peak.
   *
   * @param peakId - The peak identifier
   * @returns Array of positions in the territory
   */
  getTerritory(peakId: string): RoomPosition[] {
    return this.territories.get(peakId) || [];
  }

  /**
   * Gets all territories as a map.
   *
   * @returns Map of peak IDs to their territory positions
   */
  getAllTerritories(): Map<string, RoomPosition[]> {
    return new Map(this.territories);
  }

  /**
   * Finds which peak's territory contains a given position.
   *
   * @param pos - The position to look up
   * @returns The peak ID owning the position, or undefined
   */
  findTerritoryOwner(pos: RoomPosition): string | undefined {
    for (const [peakId, positions] of this.territories) {
      if (positions.some((p) => p.x === pos.x && p.y === pos.y)) {
        return peakId;
      }
    }
    return undefined;
  }

  /**
   * Renders visual debugging information.
   *
   * Shows:
   * - Peak nodes (already filtered to sparse graph by filterPeaks)
   * - MST edges ensuring connectivity, plus short non-redundant edges
   * - Labels for top 3 peaks
   *
   * @param room - The room to render visuals in
   */
  private visualize(room: Room): void {
    if (this.peaks.length === 0) return;

    const maxHeight = Math.max(...this.peaks.map((p) => p.height), 1);

    // Helper to compute Manhattan distance
    const dist = (a: Peak, b: Peak) =>
      Math.abs(a.center.x - b.center.x) + Math.abs(a.center.y - b.center.y);

    const edgeKey = (i: number, j: number) =>
      i < j ? `${i}-${j}` : `${j}-${i}`;

    // Build MST using Prim's algorithm to ensure connectivity
    const mstEdges: Set<string> = new Set();
    if (this.peaks.length > 1) {
      const inMST = new Set<number>([0]);
      while (inMST.size < this.peaks.length) {
        let bestEdge: [number, number] | null = null;
        let bestDist = Infinity;

        for (const i of inMST) {
          for (let j = 0; j < this.peaks.length; j++) {
            if (inMST.has(j)) continue;
            const d = dist(this.peaks[i], this.peaks[j]);
            if (d < bestDist) {
              bestDist = d;
              bestEdge = [i, j];
            }
          }
        }

        if (bestEdge) {
          mstEdges.add(edgeKey(bestEdge[0], bestEdge[1]));
          inMST.add(bestEdge[1]);
        }
      }
    }

    // Build map from peak index to territory key
    const peakToTerritory: Map<number, string> = new Map();
    let tidx = 0;
    for (const [tkey] of this.territories) {
      if (tidx < this.peaks.length) {
        peakToTerritory.set(tidx, tkey);
      }
      tidx++;
    }

    // Check if two territories share a border (are adjacent)
    const territoriesAdjacent = (t1: string, t2: string): boolean => {
      const pos1 = this.territories.get(t1) || [];
      const pos2Set = new Set(
        (this.territories.get(t2) || []).map((p) => `${p.x},${p.y}`)
      );
      for (const p of pos1) {
        // Check 4-directional neighbors
        if (
          pos2Set.has(`${p.x - 1},${p.y}`) ||
          pos2Set.has(`${p.x + 1},${p.y}`) ||
          pos2Set.has(`${p.x},${p.y - 1}`) ||
          pos2Set.has(`${p.x},${p.y + 1}`)
        ) {
          return true;
        }
      }
      return false;
    };

    // Add edges between peaks whose territories are adjacent
    const allEdges: Set<string> = new Set(mstEdges);
    for (let i = 0; i < this.peaks.length; i++) {
      for (let j = i + 1; j < this.peaks.length; j++) {
        const key = edgeKey(i, j);
        if (allEdges.has(key)) continue;

        const t1 = peakToTerritory.get(i);
        const t2 = peakToTerritory.get(j);
        if (t1 && t2 && territoriesAdjacent(t1, t2)) {
          allEdges.add(key);
        }
      }
    }

    // Draw territory colors (sphere of influence for each peak)
    const territoryColors = [
      "#ff000022", "#00ff0022", "#0000ff22", "#ffff0022",
      "#ff00ff22", "#00ffff22", "#ff880022", "#88ff0022",
    ];
    let colorIdx = 0;
    for (const [, positions] of this.territories) {
      const color = territoryColors[colorIdx % territoryColors.length];
      colorIdx++;
      for (const pos of positions) {
        room.visual.rect(pos.x - 0.5, pos.y - 0.5, 1, 1, {
          fill: color,
          opacity: 1,
        });
      }
    }

    // Draw edges on top of territory
    for (const key of allEdges) {
      const [i, j] = key.split("-").map(Number);
      const p1 = this.peaks[i].center;
      const p2 = this.peaks[j].center;
      room.visual.line(p1.x, p1.y, p2.x, p2.y, {
        color: "#ffffff",
        opacity: 0.8,
        width: 0.15,
      });
    }

    // Draw peak nodes
    forEach(this.peaks, (peak, index) => {
      const opacity = 0.5 + (peak.height / maxHeight) * 0.5;
      room.visual.circle(peak.center.x, peak.center.y, {
        fill: "yellow",
        stroke: "#886600",
        strokeWidth: 0.1,
        opacity,
        radius: 0.4 + (peak.height / maxHeight) * 0.3,
      });
      // Label top 3 peaks with their height
      if (index < 3) {
        room.visual.text(`${peak.height}`, peak.center.x, peak.center.y + 0.15, {
          font: 0.35,
          color: "#000000",
        });
      }
    });
  }

  /**
   * Main routine logic - re-visualizes each tick.
   *
   * @param room - The room to visualize
   */
  routine(room: Room): void {
    this.visualize(room);
  }

  /**
   * RoomMap doesn't spawn creeps.
   */
  calcSpawnQueue(room: Room): void {
    // No creeps needed
  }
}
