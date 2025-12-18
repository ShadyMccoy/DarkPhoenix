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

import { forEach } from "lodash";
import {
  createDistanceTransform,
  findPeaks as findPeaksPure,
  filterPeaks as filterPeaksPure,
  bfsDivideRoom as bfsDivideRoomPure,
  createMultiRoomDistanceTransform,
  findMultiRoomPeaks,
  filterMultiRoomPeaks,
  bfsDivideMultiRoom,
  GRID_SIZE,
  TerrainCallback,
  MultiRoomTerrainCallback,
  PeakData,
  WorldPeakData,
  WorldCoordinate,
  Coordinate,
  FilterPeaksOptions,
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
 * Inter-room edge connecting to an adjacent room.
 */
export interface InterRoomEdge {
  /** Index of peak in this room */
  peakIndex: number;
  /** Direction to the adjacent room (TOP, RIGHT, BOTTOM, LEFT) */
  exitDirection: ExitConstant;
  /** Adjacent room name */
  targetRoom: string;
  /** Exit position on the room edge */
  exitPos: { x: number; y: number };
}

/**
 * Options for creating a RoomMap with feature biasing.
 */
export interface RoomMapOptions {
  /** Positions of interesting features to boost (sources, controllers, etc.) */
  featurePositions?: { x: number; y: number }[];
  /** Boost amount for feature positions (added to distance value, default 10) */
  featureBoost?: number;
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
 * Creates a terrain callback from just a room name (no vision required).
 */
function createTerrainCallbackByName(roomName: string): TerrainCallback {
  const terrain = Game.map.getRoomTerrain(roomName);
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
export class RoomMap {
  /** The room being analyzed */
  readonly roomName: string;

  /** Distance transform grid (inverted: higher values = more open areas) */
  private distanceTransform: number[][] = [];

  /** Detected peaks (optimal building locations) */
  private peaks: Peak[] = [];

  /** Territory assignments (which peak owns which tiles) */
  private territories: Map<string, RoomPosition[]> = new Map();

  /** Skeleton graph edges with pathfinding distances */
  private edges: Edge[] = [];

  /** Inter-room edges to adjacent rooms */
  private interRoomEdges: InterRoomEdge[] = [];

  /** Terrain callback for pathfinding */
  private terrainCallback: TerrainCallback | null = null;

  /** Options for feature biasing */
  private options: RoomMapOptions = {};

  /**
   * Creates a new RoomMap with full spatial analysis.
   *
   * Performs all spatial calculations on construction:
   * - Distance transform computation
   * - Peak detection and filtering
   * - Territory division
   *
   * @param room - The room to analyze
   * @param options - Optional configuration for feature biasing
   */
  constructor(room: Room, options: RoomMapOptions = {}) {
    this.roomName = room.name;
    this.options = options;

    this.terrainCallback = createTerrainCallback(room);
    this.computeSpatialData(room.name);

    // Visualize results if we have vision
    this.visualize(room);
  }

  /**
   * Creates a RoomMap from just a room name (no vision required).
   * Uses public terrain data via Game.map.getRoomTerrain().
   *
   * @param roomName - The room name to analyze
   * @param options - Optional configuration for feature biasing
   * @returns A new RoomMap instance
   */
  static fromRoomName(roomName: string, options: RoomMapOptions = {}): RoomMap {
    // Create instance without calling constructor
    const map = Object.create(RoomMap.prototype) as RoomMap;

    // Initialize properties
    (map as any).roomName = roomName;
    map.distanceTransform = [];
    map.peaks = [];
    map.territories = new Map();
    map.edges = [];
    map.interRoomEdges = [];
    map.options = options;
    map.terrainCallback = createTerrainCallbackByName(roomName);

    // Compute spatial data
    map.computeSpatialData(roomName);

    return map;
  }

  /**
   * Computes all spatial data (distance transform, peaks, territories, edges).
   */
  private computeSpatialData(roomName: string): void {
    if (!this.terrainCallback) return;

    // Create inverted distance transform (peaks = open areas)
    this.distanceTransform = createDistanceTransform(
      this.terrainCallback,
      TERRAIN_MASK_WALL
    );

    // Apply feature biasing if specified
    if (this.options.featurePositions && this.options.featurePositions.length > 0) {
      const boost = this.options.featureBoost ?? 10;
      for (const pos of this.options.featurePositions) {
        if (pos.x >= 0 && pos.x < GRID_SIZE && pos.y >= 0 && pos.y < GRID_SIZE) {
          this.distanceTransform[pos.x][pos.y] += boost;
        }
      }
    }

    // Find and filter peaks (using pure functions)
    const peakDataList = findPeaksPure(
      this.distanceTransform,
      this.terrainCallback,
      TERRAIN_MASK_WALL
    );
    const filteredPeakData = filterPeaksPure(peakDataList);

    // Convert PeakData to Peak (with RoomPositions)
    this.peaks = filteredPeakData.map((pd) => peakDataToPeak(pd, roomName));

    // Divide room into territories using BFS (pure function)
    const territoryData = bfsDivideRoomPure(
      filteredPeakData,
      this.terrainCallback,
      TERRAIN_MASK_WALL
    );

    // Convert territories to RoomPositions
    for (const [peakId, coords] of territoryData) {
      const positions = coords.map(
        (c: Coordinate) => new RoomPosition(c.x, c.y, roomName)
      );
      // Use room name prefix for consistency with original implementation
      const fullPeakId = `${roomName}-${peakId}`;
      this.territories.set(fullPeakId, positions);
    }

    // Build skeleton graph edges
    this.buildEdges();

    // Build inter-room edges
    this.buildInterRoomEdges(roomName);
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
   * Gets all edges in the skeleton graph.
   *
   * @returns Array of edges with pathfinding distances
   */
  getEdges(): Edge[] {
    return [...this.edges];
  }

  /**
   * Calculates BFS pathfinding distance between two positions.
   * Ignores walls, walks through all terrain.
   *
   * @param from - Starting position
   * @param to - Target position
   * @returns Distance in tiles, or Infinity if unreachable
   */
  private bfsDistance(from: RoomPosition, to: RoomPosition): number {
    if (from.x === to.x && from.y === to.y) return 0;
    if (!this.terrainCallback) return Infinity;

    const visited = new Set<string>();
    const queue: { x: number; y: number; dist: number }[] = [
      { x: from.x, y: from.y, dist: 0 },
    ];
    visited.add(`${from.x},${from.y}`);

    const neighbors = [
      { dx: -1, dy: 0 },
      { dx: 1, dy: 0 },
      { dx: 0, dy: -1 },
      { dx: 0, dy: 1 },
      { dx: -1, dy: -1 },
      { dx: -1, dy: 1 },
      { dx: 1, dy: -1 },
      { dx: 1, dy: 1 },
    ];

    while (queue.length > 0) {
      const { x, y, dist } = queue.shift()!;

      for (const { dx, dy } of neighbors) {
        const nx = x + dx;
        const ny = y + dy;
        const key = `${nx},${ny}`;

        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
        if (visited.has(key)) continue;
        if (this.terrainCallback(nx, ny) === TERRAIN_MASK_WALL) continue;

        if (nx === to.x && ny === to.y) {
          return dist + 1;
        }

        visited.add(key);
        queue.push({ x: nx, y: ny, dist: dist + 1 });
      }
    }

    return Infinity;
  }

  /**
   * Builds skeleton graph edges between adjacent territories.
   * Calculates pathfinding distance for each edge.
   */
  private buildEdges(): void {
    if (this.peaks.length < 2) return;

    // Build map from peak index to territory key
    const peakToTerritory: Map<number, string> = new Map();
    let tidx = 0;
    for (const [tkey] of this.territories) {
      if (tidx < this.peaks.length) {
        peakToTerritory.set(tidx, tkey);
      }
      tidx++;
    }

    // Check if two territories share a border
    const territoriesAdjacent = (t1: string, t2: string): boolean => {
      const pos1 = this.territories.get(t1) || [];
      const pos2Set = new Set(
        (this.territories.get(t2) || []).map((p) => `${p.x},${p.y}`)
      );
      for (const p of pos1) {
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

    // Build MST first to ensure connectivity
    const edgeSet = new Set<string>();
    const edgeKey = (i: number, j: number) =>
      i < j ? `${i}-${j}` : `${j}-${i}`;

    const inMST = new Set<number>([0]);
    while (inMST.size < this.peaks.length) {
      let bestEdge: [number, number] | null = null;
      let bestDist = Infinity;

      for (const i of inMST) {
        for (let j = 0; j < this.peaks.length; j++) {
          if (inMST.has(j)) continue;
          const d =
            Math.abs(this.peaks[i].center.x - this.peaks[j].center.x) +
            Math.abs(this.peaks[i].center.y - this.peaks[j].center.y);
          if (d < bestDist) {
            bestDist = d;
            bestEdge = [i, j];
          }
        }
      }

      if (bestEdge) {
        edgeSet.add(edgeKey(bestEdge[0], bestEdge[1]));
        inMST.add(bestEdge[1]);
      }
    }

    // Add edges for adjacent territories
    for (let i = 0; i < this.peaks.length; i++) {
      for (let j = i + 1; j < this.peaks.length; j++) {
        const key = edgeKey(i, j);
        if (edgeSet.has(key)) continue;

        const t1 = peakToTerritory.get(i);
        const t2 = peakToTerritory.get(j);
        if (t1 && t2 && territoriesAdjacent(t1, t2)) {
          edgeSet.add(key);
        }
      }
    }

    // Calculate pathfinding distance for each edge
    for (const key of edgeSet) {
      const [i, j] = key.split("-").map(Number);
      const distance = this.bfsDistance(
        this.peaks[i].center,
        this.peaks[j].center
      );
      this.edges.push({ source: i, target: j, distance });
    }
  }

  /**
   * Builds inter-room edges from peaks to adjacent rooms.
   * Uses Game.map.describeExits to find neighboring rooms.
   */
  private buildInterRoomEdges(roomName: string): void {
    if (this.peaks.length === 0) return;

    const exits = Game.map.describeExits(roomName);
    if (!exits) return;

    // For each exit direction, find the closest peak and create an inter-room edge
    const exitDirections: { dir: ExitConstant; edge: "x" | "y"; value: number; midPos: { x: number; y: number } }[] = [
      { dir: TOP, edge: "y", value: 0, midPos: { x: 25, y: 0 } },
      { dir: BOTTOM, edge: "y", value: 49, midPos: { x: 25, y: 49 } },
      { dir: LEFT, edge: "x", value: 0, midPos: { x: 0, y: 25 } },
      { dir: RIGHT, edge: "x", value: 49, midPos: { x: 49, y: 25 } },
    ];

    for (const { dir, midPos } of exitDirections) {
      const targetRoom = exits[dir];
      if (!targetRoom) continue;

      // Find the closest peak to this exit
      let closestPeakIdx = 0;
      let closestDist = Infinity;

      for (let i = 0; i < this.peaks.length; i++) {
        const peak = this.peaks[i];
        const dist = Math.abs(peak.center.x - midPos.x) + Math.abs(peak.center.y - midPos.y);
        if (dist < closestDist) {
          closestDist = dist;
          closestPeakIdx = i;
        }
      }

      this.interRoomEdges.push({
        peakIndex: closestPeakIdx,
        exitDirection: dir,
        targetRoom,
        exitPos: midPos,
      });
    }
  }

  /**
   * Gets all inter-room edges.
   *
   * @returns Array of inter-room edges to adjacent rooms
   */
  getInterRoomEdges(): InterRoomEdge[] {
    return [...this.interRoomEdges];
  }

  /**
   * Renders visual debugging information.
   *
   * Shows:
   * - Territory colors (sphere of influence)
   * - Edges with pathfinding distances
   * - Peak nodes with height labels
   *
   * @param room - The room to render visuals in
   */
  private visualize(room: Room): void {
    if (this.peaks.length === 0) return;

    const maxHeight = Math.max(...this.peaks.map((p) => p.height), 1);

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

    // Draw edges with distance labels
    for (const edge of this.edges) {
      const p1 = this.peaks[edge.source].center;
      const p2 = this.peaks[edge.target].center;

      // Draw edge line
      room.visual.line(p1.x, p1.y, p2.x, p2.y, {
        color: "#ffffff",
        opacity: 0.8,
        width: 0.15,
      });

      // Draw distance label at midpoint
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      room.visual.text(`${edge.distance}`, midX, midY, {
        font: 0.4,
        color: "#ffffff",
        stroke: "#000000",
        strokeWidth: 0.1,
      });
    }

    // Draw inter-room edges (to adjacent rooms)
    for (const interEdge of this.interRoomEdges) {
      const peak = this.peaks[interEdge.peakIndex];
      const exitPos = interEdge.exitPos;

      // Draw dashed line from peak to exit
      room.visual.line(peak.center.x, peak.center.y, exitPos.x, exitPos.y, {
        color: "#88ccff",
        opacity: 0.6,
        width: 0.1,
        lineStyle: "dashed",
      });

      // Draw exit marker
      room.visual.circle(exitPos.x, exitPos.y, {
        fill: "#88ccff",
        opacity: 0.5,
        radius: 0.3,
      });

      // Label with target room name
      room.visual.text(interEdge.targetRoom, exitPos.x, exitPos.y + 0.8, {
        font: 0.3,
        color: "#88ccff",
        stroke: "#000000",
        strokeWidth: 0.05,
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
   * Renders visual debugging information on demand.
   *
   * Call this method from the game loop to show spatial analysis.
   * Checks Memory.visualRooms to determine if visuals should be shown.
   *
   * @param room - The room to visualize
   */
  render(room: Room): void {
    // Check if visualization is enabled for this room
    if (!shouldVisualize(room.name)) return;
    this.visualize(room);
  }

  /**
   * Renders visual debugging information using RoomVisual (no Room object needed).
   * Only renders if the room name is in Memory.visualRooms.
   */
  renderByName(): void {
    if (!shouldVisualize(this.roomName)) return;
    this.visualizeByName();
  }

  /**
   * Renders visualization using only RoomVisual (no Room object needed).
   */
  private visualizeByName(): void {
    if (this.peaks.length === 0) return;

    const visual = new RoomVisual(this.roomName);
    const maxHeight = Math.max(...this.peaks.map((p) => p.height), 1);

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
        visual.rect(pos.x - 0.5, pos.y - 0.5, 1, 1, {
          fill: color,
          opacity: 1,
        });
      }
    }

    // Draw edges with distance labels
    for (const edge of this.edges) {
      const p1 = this.peaks[edge.source].center;
      const p2 = this.peaks[edge.target].center;

      visual.line(p1.x, p1.y, p2.x, p2.y, {
        color: "#ffffff",
        opacity: 0.8,
        width: 0.15,
      });

      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      visual.text(`${edge.distance}`, midX, midY, {
        font: 0.4,
        color: "#ffffff",
        stroke: "#000000",
        strokeWidth: 0.1,
      });
    }

    // Draw inter-room edges (to adjacent rooms)
    for (const interEdge of this.interRoomEdges) {
      const peak = this.peaks[interEdge.peakIndex];
      const exitPos = interEdge.exitPos;

      // Draw dashed line from peak to exit
      visual.line(peak.center.x, peak.center.y, exitPos.x, exitPos.y, {
        color: "#88ccff",
        opacity: 0.6,
        width: 0.1,
        lineStyle: "dashed",
      });

      // Draw exit marker
      visual.circle(exitPos.x, exitPos.y, {
        fill: "#88ccff",
        opacity: 0.5,
        radius: 0.3,
      });

      // Label with target room name
      visual.text(interEdge.targetRoom, exitPos.x, exitPos.y + 0.8, {
        font: 0.3,
        color: "#88ccff",
        stroke: "#000000",
        strokeWidth: 0.05,
      });
    }

    // Draw peak nodes
    this.peaks.forEach((peak, index) => {
      const opacity = 0.5 + (peak.height / maxHeight) * 0.5;
      visual.circle(peak.center.x, peak.center.y, {
        fill: "yellow",
        stroke: "#886600",
        strokeWidth: 0.1,
        opacity,
        radius: 0.4 + (peak.height / maxHeight) * 0.3,
      });
      if (index < 3) {
        visual.text(`${peak.height}`, peak.center.x, peak.center.y + 0.15, {
          font: 0.35,
          color: "#000000",
        });
      }
    });
  }
}

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

/**
 * Check if visualization should be shown for a room.
 * Visualization is shown if:
 * - Memory.visualRooms contains the room name, OR
 * - There's a flag named "visual" in the room
 *
 * @param roomName - The room to check
 * @returns True if visualization should be shown
 */
export function shouldVisualize(roomName: string): boolean {
  // Check Memory.visualRooms array
  if (Memory.visualRooms?.includes(roomName)) {
    return true;
  }

  // Check for a flag named "visual" in the room
  const flags = Game.flags;
  for (const flagName in flags) {
    const flag = flags[flagName];
    if (flag.pos.roomName === roomName && flagName.toLowerCase().startsWith("visual")) {
      return true;
    }
  }

  return false;
}

/**
 * Gets all room names that should have visualization rendered.
 * Collects from both Memory.visualRooms and flags named "visual*".
 *
 * @returns Set of room names to visualize
 */
export function getRoomsToVisualize(): Set<string> {
  const rooms = new Set<string>();

  // Add rooms from Memory.visualRooms
  if (Memory.visualRooms) {
    for (const roomName of Memory.visualRooms) {
      rooms.add(roomName);
    }
  }

  // Add rooms with "visual*" flags
  for (const flagName in Game.flags) {
    if (flagName.toLowerCase().startsWith("visual")) {
      rooms.add(Game.flags[flagName].pos.roomName);
    }
  }

  return rooms;
}

// ============================================================================
// Cross-Room Territory Calculation
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
 * Peak info needed for cross-room territory calculation.
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

/**
 * Extracts peak info from a set of RoomMaps for cross-room territory calculation.
 *
 * @param roomMaps - Map of room name to RoomMap instance
 * @returns Array of peaks suitable for calculateCrossRoomTerritories
 */
export function extractPeaksFromRoomMaps(
  roomMaps: Map<string, RoomMap>
): CrossRoomPeak[] {
  const peaks: CrossRoomPeak[] = [];

  for (const [roomName, roomMap] of roomMaps) {
    for (const peak of roomMap.getPeaks()) {
      peaks.push({
        peakId: `${roomName}-${peak.center.x}-${peak.center.y}`,
        roomName,
        center: { x: peak.center.x, y: peak.center.y },
        height: peak.height,
      });
    }
  }

  return peaks;
}

// ============================================================================
// Unified Multi-Room Spatial Analysis
// ============================================================================

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
}

/**
 * Options for multi-room spatial analysis.
 */
export interface MultiRoomAnalysisOptions {
  /** Maximum rooms to include in analysis (default: 9) */
  maxRooms?: number;
  /** Peak filtering options */
  peakOptions?: FilterPeaksOptions;
}

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
  const { maxRooms = 9, peakOptions = {} } = options;

  // Create terrain callback
  const terrainCallback = createMultiRoomTerrainCallback();

  // Step 1: Compute multi-room distance transform
  const distances = createMultiRoomDistanceTransform(
    startRooms,
    terrainCallback,
    TERRAIN_MASK_WALL,
    maxRooms
  );

  // Step 2: Find peaks across all rooms
  const rawPeaks = findMultiRoomPeaks(distances, terrainCallback, TERRAIN_MASK_WALL);

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
    maxRooms
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

  return { peaks, territories, distances };
}

/**
 * Computes BFS pathfinding distance between two positions in the same room.
 * Walks through walkable terrain only.
 *
 * @param from - Starting position
 * @param to - Target position
 * @param roomName - Room to pathfind in
 * @returns Distance in tiles, or Infinity if unreachable
 */
function bfsDistanceInRoom(
  from: { x: number; y: number },
  to: { x: number; y: number },
  roomName: string
): number {
  if (from.x === to.x && from.y === to.y) return 0;

  const terrain = Game.map.getRoomTerrain(roomName);
  const visited = new Set<string>();
  const queue: { x: number; y: number; dist: number }[] = [
    { x: from.x, y: from.y, dist: 0 },
  ];
  visited.add(`${from.x},${from.y}`);

  const neighbors = [
    { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
    { dx: 0, dy: -1 }, { dx: 0, dy: 1 },
    { dx: -1, dy: -1 }, { dx: -1, dy: 1 },
    { dx: 1, dy: -1 }, { dx: 1, dy: 1 },
  ];

  while (queue.length > 0) {
    const { x, y, dist } = queue.shift()!;

    for (const { dx, dy } of neighbors) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;

      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (visited.has(key)) continue;
      if (terrain.get(nx, ny) === TERRAIN_MASK_WALL) continue;

      if (nx === to.x && ny === to.y) {
        return dist + 1;
      }

      visited.add(key);
      queue.push({ x: nx, y: ny, dist: dist + 1 });
    }
  }

  return Infinity;
}

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
 * Builds edges between peaks in the same room with BFS distances.
 */
function buildVisualizationEdges(
  peaksInRoom: CrossRoomPeak[],
  roomName: string
): VisualizationEdge[] {
  if (peaksInRoom.length < 2) return [];

  const edges: VisualizationEdge[] = [];

  // Build MST to ensure connectivity, then add adjacent edges
  const edgeSet = new Set<string>();
  const edgeKey = (i: number, j: number) => i < j ? `${i}-${j}` : `${j}-${i}`;

  // Prim's MST
  const inMST = new Set<number>([0]);
  while (inMST.size < peaksInRoom.length) {
    let bestEdge: [number, number] | null = null;
    let bestDist = Infinity;

    for (const i of inMST) {
      for (let j = 0; j < peaksInRoom.length; j++) {
        if (inMST.has(j)) continue;
        const d = Math.abs(peaksInRoom[i].center.x - peaksInRoom[j].center.x) +
                  Math.abs(peaksInRoom[i].center.y - peaksInRoom[j].center.y);
        if (d < bestDist) {
          bestDist = d;
          bestEdge = [i, j];
        }
      }
    }

    if (bestEdge) {
      edgeSet.add(edgeKey(bestEdge[0], bestEdge[1]));
      inMST.add(bestEdge[1]);
    } else {
      break;
    }
  }

  // Calculate BFS distance for each edge
  for (const key of edgeSet) {
    const [i, j] = key.split("-").map(Number);
    const p1 = peaksInRoom[i];
    const p2 = peaksInRoom[j];
    const distance = bfsDistanceInRoom(p1.center, p2.center, roomName);

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
 * @param force - If true, skip the shouldVisualize check
 */
export function visualizeMultiRoomAnalysis(
  roomName: string,
  result: MultiRoomAnalysisResult,
  showDistances: boolean = false,
  force: boolean = false
): void {
  if (!force && !shouldVisualize(roomName)) return;

  const visual = new RoomVisual(roomName);

  // Territory colors (matching old visualization)
  const territoryColors = [
    "#ff000022", "#00ff0022", "#0000ff22", "#ffff0022",
    "#ff00ff22", "#00ffff22", "#ff880022", "#88ff0022",
  ];

  // Draw territories
  let colorIdx = 0;
  for (const [, positions] of result.territories) {
    const positionsInRoom = positions.filter((p) => p.roomName === roomName);
    if (positionsInRoom.length === 0) continue;

    const color = territoryColors[colorIdx % territoryColors.length];
    colorIdx++;

    for (const pos of positionsInRoom) {
      visual.rect(pos.x - 0.5, pos.y - 0.5, 1, 1, {
        fill: color,
        opacity: 1,
      });
    }
  }

  // Get peaks in this room
  const peaksInRoom = result.peaks.filter((p) => p.roomName === roomName);
  const maxHeight = Math.max(...result.peaks.map((p) => p.height), 1);

  // Build and draw edges with distance labels (like old visualization)
  const edges = buildVisualizationEdges(peaksInRoom, roomName);
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

  // Build and draw inter-room edges (like old visualization)
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

  // Draw peak nodes (matching old visualization style)
  peaksInRoom.forEach((peak, index) => {
    const opacity = 0.5 + (peak.height / maxHeight) * 0.5;
    visual.circle(peak.center.x, peak.center.y, {
      fill: "yellow",
      stroke: "#886600",
      strokeWidth: 0.1,
      opacity,
      radius: 0.4 + (peak.height / maxHeight) * 0.3,
    });
    // Label top 3 peaks with their height (like old visualization)
    if (index < 3) {
      visual.text(`${peak.height}`, peak.center.x, peak.center.y + 0.15, {
        font: 0.35,
        color: "#000000",
      });
    }
  });

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
