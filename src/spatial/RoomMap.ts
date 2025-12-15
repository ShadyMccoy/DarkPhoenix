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
  floodFillDistanceSearch,
  markBarriers,
  initializeGrid,
  GRID_SIZE,
  UNVISITED,
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

  /** Legacy: Simple wall distance grid */
  private WallDistanceGrid = initializeGrid(UNVISITED);

  /** Legacy: Average wall distance for non-wall tiles */
  private WallDistanceAvg = 0;

  /** Legacy: Distance from energy sources grid */
  private EnergyDistanceGrid = initializeGrid(UNVISITED);

  /**
   * Creates a new RoomMap with full spatial analysis.
   *
   * Performs all spatial calculations on construction:
   * - Distance transform computation
   * - Peak detection and filtering
   * - Territory division
   * - Legacy grid calculations
   *
   * @param room - The room to analyze
   */
  constructor(room: Room) {
    super(new RoomPosition(25, 25, room.name), {});

    const terrainCallback = createTerrainCallback(room);
    const terrain = Game.map.getRoomTerrain(room.name);
    let wallPositions: [number, number][] = [];

    for (let x = 0; x < GRID_SIZE; x++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
          wallPositions.push([x, y]);
        }
      }
    }

    // Create inverted distance transform (peaks = open areas)
    this.distanceTransform = createDistanceTransform(
      terrainCallback,
      TERRAIN_MASK_WALL
    );

    // Find and filter peaks (using pure functions)
    const peakDataList = findPeaksPure(
      this.distanceTransform,
      terrainCallback,
      TERRAIN_MASK_WALL
    );
    const filteredPeakData = filterPeaksPure(peakDataList);

    // Convert PeakData to Peak (with RoomPositions)
    this.peaks = filteredPeakData.map((pd) => peakDataToPeak(pd, room.name));

    // Divide room into territories using BFS (pure function)
    const territoryData = bfsDivideRoomPure(
      filteredPeakData,
      terrainCallback,
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

    // Legacy: Calculate simple wall distance
    floodFillDistanceSearch(this.WallDistanceGrid, wallPositions);

    // Calculate average, excluding wall tiles
    let sum = 0;
    let count = 0;
    for (let x = 0; x < GRID_SIZE; x++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        if (this.WallDistanceGrid[x][y] > 0) {
          sum += this.WallDistanceGrid[x][y];
          count++;
        }
      }
    }
    this.WallDistanceAvg = count > 0 ? sum / count : 0;

    // Calculate distance from energy sources
    markBarriers(this.EnergyDistanceGrid, wallPositions);

    let energyPositions: [number, number][] = [];
    forEach(room.find(FIND_SOURCES), (source) => {
      energyPositions.push([source.pos.x, source.pos.y]);
    });

    floodFillDistanceSearch(this.EnergyDistanceGrid, energyPositions);

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
   * - Peak locations with varying opacity by height
   * - Labels for top 3 peaks
   * - Territory boundaries (limited for performance)
   * - Candidate building sites
   *
   * @param room - The room to render visuals in
   */
  private visualize(room: Room): void {
    // Visualize peaks with varying opacity by height
    const maxHeight = Math.max(...this.peaks.map((p) => p.height), 1);
    forEach(this.peaks, (peak, index) => {
      const opacity = 0.3 + (peak.height / maxHeight) * 0.7;
      room.visual.circle(peak.center.x, peak.center.y, {
        fill: "yellow",
        opacity,
        radius: 0.5,
      });
      // Label top 3 peaks
      if (index < 3) {
        room.visual.text(`P${index + 1}`, peak.center.x, peak.center.y - 1, {
          font: 0.4,
          color: "white",
        });
      }
    });

    // Visualize territory boundaries
    const colors = [
      "#ff000044",
      "#00ff0044",
      "#0000ff44",
      "#ffff0044",
      "#ff00ff44",
    ];
    let colorIndex = 0;
    for (const [peakId, positions] of this.territories) {
      if (colorIndex >= colors.length) break;
      const color = colors[colorIndex++];
      // Only draw boundary positions (limited for performance)
      const boundary = positions
        .filter(
          (pos) =>
            !positions.some(
              (p) =>
                Math.abs(p.x - pos.x) + Math.abs(p.y - pos.y) === 1 &&
                positions.every(
                  (pp) => pp !== p || pp.x !== pos.x + 1 || pp.y !== pos.y
                )
            )
        )
        .slice(0, 100);
      forEach(boundary, (pos) => {
        room.visual.rect(pos.x - 0.5, pos.y - 0.5, 1, 1, { fill: color });
      });
    }

    // Find candidate building sites (good distance from energy sources)
    let sites: { x: number; y: number }[] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        const energyDist = this.EnergyDistanceGrid[x][y];
        if (energyDist > 2 && energyDist < 5) {
          sites.push({ x, y });
        }
      }
    }

    forEach(sites, (site) => {
      room.visual.circle(site.x, site.y, {
        fill: "red",
        radius: 0.3,
        opacity: 0.5,
      });
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
