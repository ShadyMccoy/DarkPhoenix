/**
 * @fileoverview Pure spatial algorithms for room mapping.
 *
 * This module contains pure functions with no dependencies on Screeps Game
 * globals or RoomPosition objects. This enables comprehensive unit testing
 * without mocking the Screeps environment.
 *
 * ## Design Pattern: Pure Core / Imperative Shell
 *
 * These functions form the "Pure Core" of the spatial analysis system:
 * - Take primitive inputs (callbacks, arrays, coordinates)
 * - Return primitive outputs (arrays, maps, coordinates)
 * - NO Game/RoomPosition/Memory dependencies
 *
 * The RoomMap class acts as the "Imperative Shell" that:
 * - Calls these pure functions with Game API data
 * - Converts results to RoomPosition objects
 * - Handles visualization
 *
 * @module spatial/algorithms
 */

/** Room grid dimensions */
export const GRID_SIZE = 50;

/** Marker for unvisited tiles in flood fill */
export const UNVISITED = -1;

/** Marker for barrier tiles (walls) in flood fill */
export const BARRIER = -2;

/**
 * Callback type for terrain queries.
 * Returns terrain mask value (0 = plain, 1 = wall, 2 = swamp).
 */
export type TerrainCallback = (x: number, y: number) => number;

/**
 * Simple coordinate type for pure functions.
 */
export interface Coordinate {
  x: number;
  y: number;
}

/**
 * World coordinate that includes room name.
 * Used for cross-room algorithms.
 */
export interface WorldCoordinate {
  x: number;
  y: number;
  roomName: string;
}

/**
 * Peak data structure for pure functions.
 * Uses Coordinate instead of RoomPosition.
 */
export interface PeakData {
  /** All tiles at this peak's height (plateau) */
  tiles: Coordinate[];
  /** Centroid of the peak cluster */
  center: Coordinate;
  /** Distance transform value (higher = more open space) */
  height: number;
}

/**
 * 8-directional neighbors for BFS propagation.
 */
const NEIGHBORS_8: Coordinate[] = [
  { x: -1, y: -1 },
  { x: -1, y: 0 },
  { x: -1, y: 1 },
  { x: 0, y: 1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: -1 },
];

/**
 * 4-directional neighbors for BFS flood fill.
 */
const NEIGHBORS_4: Coordinate[] = [
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: 0, y: 1 },
];

// ============================================================================
// Distance Transform Algorithm
// ============================================================================

/**
 * Creates a distance transform matrix where open areas have high values.
 *
 * Uses BFS from walls to calculate distance. Tiles far from walls (in open
 * areas) naturally get high values, making them "peaks" for building zones.
 *
 * Algorithm:
 * 1. Initialize walls at distance 0, others at Infinity
 * 2. BFS propagate distances from walls (8-directional)
 * 3. Higher values indicate tiles further from walls (more open space)
 *
 * @param terrain - Callback that returns terrain mask for (x, y)
 * @param wallMask - Terrain mask value for walls (default: 1)
 * @returns 2D array where higher values indicate more open areas
 *
 * @example
 * const terrain = (x, y) => terrainMatrix[y][x] === 'X' ? 1 : 0;
 * const distanceMatrix = createDistanceTransform(terrain);
 * console.log(distanceMatrix[25][25]); // Peak value at center
 */
export function createDistanceTransform(
  terrain: TerrainCallback,
  wallMask: number = 1
): number[][] {
  const grid: number[][] = [];
  const queue: { x: number; y: number; distance: number }[] = [];

  // Initialize grid
  for (let x = 0; x < GRID_SIZE; x++) {
    grid[x] = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      if (terrain(x, y) === wallMask) {
        grid[x][y] = 0;
        queue.push({ x, y, distance: 0 });
      } else {
        grid[x][y] = Infinity;
      }
    }
  }

  // BFS with 8-directional propagation for accuracy
  // Tiles far from walls naturally get high distance values
  while (queue.length > 0) {
    const { x, y, distance } = queue.shift()!;

    for (const neighbor of NEIGHBORS_8) {
      const nx = x + neighbor.x;
      const ny = y + neighbor.y;

      if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE) {
        const currentDistance = grid[nx][ny];
        const newDistance = distance + 1;

        if (terrain(nx, ny) !== wallMask && newDistance < currentDistance) {
          grid[nx][ny] = newDistance;
          queue.push({ x: nx, y: ny, distance: newDistance });
        }
      }
    }
  }

  // Replace any remaining Infinity with 0 (isolated tiles)
  for (let x = 0; x < GRID_SIZE; x++) {
    for (let y = 0; y < GRID_SIZE; y++) {
      if (grid[x][y] === Infinity) {
        grid[x][y] = 0;
      }
    }
  }

  return grid;
}

// ============================================================================
// Peak Detection Algorithm
// ============================================================================

/**
 * Finds peaks (local maxima) in the distance transform.
 *
 * Peaks represent the most open areas in the room - ideal for bases.
 *
 * Algorithm:
 * 1. Collect all non-wall tiles with their heights
 * 2. Sort by height descending (process highest first)
 * 3. For each tile, BFS to find connected tiles at same height (plateau)
 * 4. Calculate centroid of the plateau cluster
 * 5. Record as a peak
 *
 * @param distanceMatrix - Inverted distance transform grid
 * @param terrain - Callback that returns terrain mask for (x, y)
 * @param wallMask - Terrain mask value for walls (default: 1)
 * @returns Array of peaks with their tiles, center, and height
 *
 * @example
 * const distanceMatrix = createDistanceTransform(terrain);
 * const peaks = findPeaks(distanceMatrix, terrain);
 * const bestPeak = peaks.reduce((a, b) => a.height > b.height ? a : b);
 */
export function findPeaks(
  distanceMatrix: number[][],
  terrain: TerrainCallback,
  wallMask: number = 1
): PeakData[] {
  const searchCollection: { x: number; y: number; height: number }[] = [];
  const visited = new Set<string>();
  const peaks: PeakData[] = [];

  // Collect all non-wall tiles with their heights
  for (let x = 0; x < GRID_SIZE; x++) {
    for (let y = 0; y < GRID_SIZE; y++) {
      if (terrain(x, y) !== wallMask) {
        const height = distanceMatrix[x][y];
        if (height > 0 && height !== Infinity) {
          searchCollection.push({ x, y, height });
        }
      }
    }
  }

  // Sort by height descending (process highest first)
  searchCollection.sort((a, b) => b.height - a.height);

  // Find peaks by clustering connected tiles of same height
  while (searchCollection.length > 0) {
    const tile = searchCollection.shift()!;
    if (visited.has(`${tile.x},${tile.y}`)) continue;

    // Find all connected tiles at the same height (forming a peak plateau)
    const cluster: Coordinate[] = [];
    const queue = [{ x: tile.x, y: tile.y }];

    while (queue.length > 0) {
      const { x, y } = queue.pop()!;
      const key = `${x},${y}`;

      if (visited.has(key)) continue;
      if (distanceMatrix[x][y] !== tile.height) continue;

      visited.add(key);
      cluster.push({ x, y });

      // Check 4-connected neighbors for same height
      for (const neighbor of NEIGHBORS_4) {
        const nx = x + neighbor.x;
        const ny = y + neighbor.y;
        if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE) {
          queue.push({ x: nx, y: ny });
        }
      }
    }

    if (cluster.length === 0) continue;

    // Calculate centroid of the cluster
    const centerX = Math.round(
      cluster.reduce((sum, t) => sum + t.x, 0) / cluster.length
    );
    const centerY = Math.round(
      cluster.reduce((sum, t) => sum + t.y, 0) / cluster.length
    );

    peaks.push({
      tiles: cluster,
      center: { x: centerX, y: centerY },
      height: tile.height,
    });
  }

  return peaks;
}

/**
 * Options for peak filtering.
 */
export interface FilterPeaksOptions {
  /** Multiplier for height-based exclusion radius (default: 1.5) */
  exclusionMultiplier?: number;
  /** Minimum height threshold - peaks below this are discarded (default: 3) */
  minHeight?: number;
  /** Maximum number of peaks to keep (default: 8) */
  maxPeaks?: number;
}

/**
 * Filters peaks to create a sparse graph of significant open areas.
 *
 * Uses the peak's height as exclusion radius - taller peaks dominate more area.
 * This prevents clustering of many small peaks near large open areas.
 *
 * @param peaks - Unfiltered peaks from findPeaks
 * @param options - Filtering options (exclusionMultiplier, minHeight, maxPeaks)
 * @returns Filtered peaks with appropriate spacing
 *
 * @example
 * const peaks = findPeaks(distanceMatrix, terrain);
 * const filteredPeaks = filterPeaks(peaks, { minHeight: 3, maxPeaks: 8 });
 * // Only significant, well-spaced peaks remain
 */
export function filterPeaks(
  peaks: PeakData[],
  options: FilterPeaksOptions = {}
): PeakData[] {
  const {
    exclusionMultiplier = 1.5,
    minHeight = 3,
    maxPeaks = 8,
  } = options;

  // Filter by minimum height first
  const validPeaks = peaks.filter((p) => p.height >= minHeight);

  // Sort by height descending (keep tallest)
  const sortedPeaks = [...validPeaks].sort((a, b) => b.height - a.height);

  const finalPeaks: PeakData[] = [];
  const excludedPositions = new Set<string>();

  for (const peak of sortedPeaks) {
    // Stop if we've reached max peaks
    if (finalPeaks.length >= maxPeaks) break;

    const key = `${peak.center.x},${peak.center.y}`;
    if (excludedPositions.has(key)) continue;

    finalPeaks.push(peak);

    // Exclude nearby positions based on peak height
    const exclusionRadius = Math.floor(peak.height * exclusionMultiplier);
    for (let dx = -exclusionRadius; dx <= exclusionRadius; dx++) {
      for (let dy = -exclusionRadius; dy <= exclusionRadius; dy++) {
        const ex = peak.center.x + dx;
        const ey = peak.center.y + dy;
        if (ex >= 0 && ex < GRID_SIZE && ey >= 0 && ey < GRID_SIZE) {
          excludedPositions.add(`${ex},${ey}`);
        }
      }
    }
  }

  return finalPeaks;
}

// ============================================================================
// BFS Territory Division
// ============================================================================

/**
 * Divides room tiles among peaks using BFS flood fill from each peak.
 *
 * Tiles are assigned to the nearest peak (by BFS distance).
 * All peaks expand simultaneously at the same rate, ensuring fair division.
 *
 * @param peaks - Peaks to divide territory among
 * @param terrain - Callback that returns terrain mask for (x, y)
 * @param wallMask - Terrain mask value for walls (default: 1)
 * @returns Map of peak IDs (format: "x-y") to their assigned coordinates
 *
 * @example
 * const peaks = filterPeaks(findPeaks(distanceMatrix, terrain));
 * const territories = bfsDivideRoom(peaks, terrain);
 * for (const [peakId, coords] of territories) {
 *   console.log(`Peak ${peakId} owns ${coords.length} tiles`);
 * }
 */
export function bfsDivideRoom(
  peaks: PeakData[],
  terrain: TerrainCallback,
  wallMask: number = 1
): Map<string, Coordinate[]> {
  const territories = new Map<string, Coordinate[]>();
  const visited = new Set<string>();

  interface QueueItem {
    x: number;
    y: number;
    peakId: string;
  }

  const queue: QueueItem[] = [];

  // Sort peaks by height (highest first gets priority in ties)
  const sortedPeaks = [...peaks].sort((a, b) => b.height - a.height);

  for (const peak of sortedPeaks) {
    const peakId = `${peak.center.x}-${peak.center.y}`;
    territories.set(peakId, []);

    // Add peak center to queue
    queue.push({ x: peak.center.x, y: peak.center.y, peakId });
  }

  // BFS expansion - all peaks expand at same rate
  while (queue.length > 0) {
    const { x, y, peakId } = queue.shift()!;
    const key = `${x},${y}`;

    // Skip if already visited or wall
    if (visited.has(key)) continue;
    if (terrain(x, y) === wallMask) continue;

    visited.add(key);

    // Assign tile to this peak's territory
    const territory = territories.get(peakId)!;
    territory.push({ x, y });

    // Add unvisited neighbors to queue
    for (const neighbor of NEIGHBORS_4) {
      const nx = x + neighbor.x;
      const ny = y + neighbor.y;
      const nkey = `${nx},${ny}`;

      if (
        nx >= 0 &&
        nx < GRID_SIZE &&
        ny >= 0 &&
        ny < GRID_SIZE &&
        !visited.has(nkey) &&
        terrain(nx, ny) !== wallMask
      ) {
        queue.push({ x: nx, y: ny, peakId });
      }
    }
  }

  return territories;
}

// ============================================================================
// Legacy Support Functions
// ============================================================================

/**
 * Initializes a grid with a default value.
 *
 * @param initialValue - Value to fill the grid with
 * @param size - Grid size (default: GRID_SIZE = 50)
 * @returns Initialized 2D array
 */
export function initializeGrid(
  initialValue: number = UNVISITED,
  size: number = GRID_SIZE
): number[][] {
  const grid: number[][] = [];
  for (let x = 0; x < size; x++) {
    grid[x] = [];
    for (let y = 0; y < size; y++) {
      grid[x][y] = initialValue;
    }
  }
  return grid;
}

/**
 * Marks barrier positions in a grid.
 *
 * @param grid - Grid to mark
 * @param positions - Positions to mark as barriers
 */
export function markBarriers(
  grid: number[][],
  positions: [number, number][]
): void {
  positions.forEach(([x, y]) => {
    grid[x][y] = BARRIER;
  });
}

/**
 * Simple BFS flood fill for distance calculation.
 *
 * @param grid - Grid to fill (modified in place)
 * @param startPositions - Starting positions (distance 0)
 */
export function floodFillDistanceSearch(
  grid: number[][],
  startPositions: [number, number][]
): void {
  const queue: [number, number, number][] = [];

  for (const [x, y] of startPositions) {
    if (grid[x][y] !== BARRIER) {
      grid[x][y] = 0;
      queue.push([x, y, 0]);
    }
  }

  while (queue.length > 0) {
    const [x, y, distance] = queue.shift()!;
    for (const neighbor of NEIGHBORS_4) {
      const newX = x + neighbor.x;
      const newY = y + neighbor.y;
      if (
        newX >= 0 &&
        newX < GRID_SIZE &&
        newY >= 0 &&
        newY < GRID_SIZE &&
        grid[newX][newY] === UNVISITED
      ) {
        grid[newX][newY] = distance + 1;
        queue.push([newX, newY, distance + 1]);
      }
    }
  }
}

// ============================================================================
// Cross-Room Coordinate Utilities
// ============================================================================

/**
 * Parsed room coordinates.
 */
export interface RoomCoords {
  /** Horizontal direction: 'W' or 'E' */
  horizontalDir: "W" | "E";
  /** Horizontal distance from origin */
  horizontalPos: number;
  /** Vertical direction: 'N' or 'S' */
  verticalDir: "N" | "S";
  /** Vertical distance from origin */
  verticalPos: number;
}

/**
 * Parses a room name into its coordinate components.
 *
 * @param roomName - Room name like "W1N2" or "E0S3"
 * @returns Parsed coordinates or null if invalid
 */
export function parseRoomName(roomName: string): RoomCoords | null {
  const match = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
  if (!match) return null;

  return {
    horizontalDir: match[1] as "W" | "E",
    horizontalPos: parseInt(match[2], 10),
    verticalDir: match[3] as "N" | "S",
    verticalPos: parseInt(match[4], 10),
  };
}

/**
 * Converts room coordinates back to a room name.
 *
 * @param coords - Parsed room coordinates
 * @returns Room name string
 */
export function roomCoordsToName(coords: RoomCoords): string {
  return `${coords.horizontalDir}${coords.horizontalPos}${coords.verticalDir}${coords.verticalPos}`;
}

/**
 * Gets the adjacent room name and entry position when crossing a room boundary.
 *
 * @param fromRoom - Room name being exited
 * @param x - X coordinate at exit (0 or 49)
 * @param y - Y coordinate at exit (0 or 49)
 * @returns Adjacent room and entry position, or null if not an exit
 */
export function getAdjacentRoomPosition(
  fromRoom: string,
  x: number,
  y: number
): { roomName: string; x: number; y: number } | null {
  const coords = parseRoomName(fromRoom);
  if (!coords) return null;

  // Not an exit tile
  if (x !== 0 && x !== 49 && y !== 0 && y !== 49) return null;

  let newCoords = { ...coords };
  let newX = x;
  let newY = y;

  // Handle horizontal exit (LEFT or RIGHT)
  if (x === 0) {
    // Exit LEFT - go west
    if (coords.horizontalDir === "E") {
      if (coords.horizontalPos === 0) {
        newCoords.horizontalDir = "W";
        newCoords.horizontalPos = 0;
      } else {
        newCoords.horizontalPos = coords.horizontalPos - 1;
      }
    } else {
      newCoords.horizontalPos = coords.horizontalPos + 1;
    }
    newX = 49;
  } else if (x === 49) {
    // Exit RIGHT - go east
    if (coords.horizontalDir === "W") {
      if (coords.horizontalPos === 0) {
        newCoords.horizontalDir = "E";
        newCoords.horizontalPos = 0;
      } else {
        newCoords.horizontalPos = coords.horizontalPos - 1;
      }
    } else {
      newCoords.horizontalPos = coords.horizontalPos + 1;
    }
    newX = 0;
  }

  // Handle vertical exit (TOP or BOTTOM)
  if (y === 0) {
    // Exit TOP - go north
    if (coords.verticalDir === "S") {
      if (coords.verticalPos === 0) {
        newCoords.verticalDir = "N";
        newCoords.verticalPos = 0;
      } else {
        newCoords.verticalPos = coords.verticalPos - 1;
      }
    } else {
      newCoords.verticalPos = coords.verticalPos + 1;
    }
    newY = 49;
  } else if (y === 49) {
    // Exit BOTTOM - go south
    if (coords.verticalDir === "N") {
      if (coords.verticalPos === 0) {
        newCoords.verticalDir = "S";
        newCoords.verticalPos = 0;
      } else {
        newCoords.verticalPos = coords.verticalPos - 1;
      }
    } else {
      newCoords.verticalPos = coords.verticalPos + 1;
    }
    newY = 0;
  }

  return {
    roomName: roomCoordsToName(newCoords),
    x: newX,
    y: newY,
  };
}

// ============================================================================
// Multi-Room BFS Territory Division
// ============================================================================

/**
 * Peak data with room name for multi-room algorithms.
 */
export interface WorldPeakData {
  /** All tiles at this peak's height (plateau) */
  tiles: WorldCoordinate[];
  /** Centroid of the peak cluster */
  center: WorldCoordinate;
  /** Distance transform value (higher = more open space) */
  height: number;
}

/**
 * Callback type for multi-room terrain queries.
 * Returns terrain mask value for a position in any room.
 */
export type MultiRoomTerrainCallback = (
  roomName: string,
  x: number,
  y: number
) => number;

/**
 * Creates a multi-room distance transform where room boundaries don't affect distances.
 *
 * Unlike the single-room version, this BFS from walls continues across room exits,
 * giving accurate "distance from walls" values for positions near room edges.
 *
 * @param startRooms - Initial rooms to include in the analysis
 * @param terrainCallback - Multi-room terrain callback
 * @param wallMask - Terrain mask value for walls (default: 1)
 * @param maxRooms - Maximum rooms to expand into (default: 9)
 * @returns Map of "roomName:x,y" to distance value
 */
export function createMultiRoomDistanceTransform(
  startRooms: string[],
  terrainCallback: MultiRoomTerrainCallback,
  wallMask: number = 1,
  maxRooms: number = 9
): Map<string, number> {
  const distances = new Map<string, number>();
  const visitedRooms = new Set<string>(startRooms);

  interface QueueItem {
    x: number;
    y: number;
    roomName: string;
    distance: number;
  }

  const queue: QueueItem[] = [];

  // Initialize: find all walls in starting rooms and set distance 0
  for (const roomName of startRooms) {
    for (let x = 0; x < GRID_SIZE; x++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        const key = `${roomName}:${x},${y}`;
        if (terrainCallback(roomName, x, y) === wallMask) {
          distances.set(key, 0);
          queue.push({ x, y, roomName, distance: 0 });
        } else {
          distances.set(key, Infinity);
        }
      }
    }
  }

  // BFS from walls, crossing room boundaries
  while (queue.length > 0) {
    const { x, y, roomName, distance } = queue.shift()!;

    // 8-directional neighbors for accurate distance
    for (const neighbor of NEIGHBORS_8) {
      let nx = x + neighbor.x;
      let ny = y + neighbor.y;
      let nRoomName = roomName;

      // Check if crossing room boundary
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) {
        const adjacent = getAdjacentRoomPosition(
          roomName,
          nx < 0 ? 0 : nx >= GRID_SIZE ? 49 : nx,
          ny < 0 ? 0 : ny >= GRID_SIZE ? 49 : ny
        );

        if (!adjacent) continue;

        // Limit expansion
        if (!visitedRooms.has(adjacent.roomName)) {
          if (visitedRooms.size >= maxRooms) continue;
          visitedRooms.add(adjacent.roomName);

          // Initialize new room's tiles
          for (let rx = 0; rx < GRID_SIZE; rx++) {
            for (let ry = 0; ry < GRID_SIZE; ry++) {
              const rkey = `${adjacent.roomName}:${rx},${ry}`;
              if (!distances.has(rkey)) {
                if (terrainCallback(adjacent.roomName, rx, ry) === wallMask) {
                  distances.set(rkey, 0);
                  queue.push({ x: rx, y: ry, roomName: adjacent.roomName, distance: 0 });
                } else {
                  distances.set(rkey, Infinity);
                }
              }
            }
          }
        }

        nRoomName = adjacent.roomName;
        nx = adjacent.x;
        ny = adjacent.y;
      }

      const nkey = `${nRoomName}:${nx},${ny}`;
      const currentDist = distances.get(nkey) ?? Infinity;
      const newDist = distance + 1;

      if (terrainCallback(nRoomName, nx, ny) !== wallMask && newDist < currentDist) {
        distances.set(nkey, newDist);
        queue.push({ x: nx, y: ny, roomName: nRoomName, distance: newDist });
      }
    }
  }

  // Replace Infinity with 0 for any isolated tiles
  for (const [key, value] of distances) {
    if (value === Infinity) {
      distances.set(key, 0);
    }
  }

  return distances;
}

/**
 * Finds peaks across multiple rooms from a multi-room distance transform.
 *
 * @param distances - Multi-room distance map from createMultiRoomDistanceTransform
 * @param terrainCallback - Multi-room terrain callback
 * @param wallMask - Terrain mask value for walls
 * @returns Array of peaks with world coordinates
 */
export function findMultiRoomPeaks(
  distances: Map<string, number>,
  terrainCallback: MultiRoomTerrainCallback,
  wallMask: number = 1
): WorldPeakData[] {
  // Collect all tiles with heights
  const tiles: { roomName: string; x: number; y: number; height: number }[] = [];
  const visited = new Set<string>();

  for (const [key, height] of distances) {
    if (height > 0) {
      const [roomPart, coordPart] = key.split(":");
      const [xStr, yStr] = coordPart.split(",");
      tiles.push({
        roomName: roomPart,
        x: parseInt(xStr, 10),
        y: parseInt(yStr, 10),
        height,
      });
    }
  }

  // Sort by height descending
  tiles.sort((a, b) => b.height - a.height);

  const peaks: WorldPeakData[] = [];

  // Find peaks by clustering connected tiles of same height
  for (const tile of tiles) {
    const startKey = `${tile.roomName}:${tile.x},${tile.y}`;
    if (visited.has(startKey)) continue;

    // BFS to find connected tiles at same height (plateau)
    const cluster: WorldCoordinate[] = [];
    const clusterQueue = [{ x: tile.x, y: tile.y, roomName: tile.roomName }];

    while (clusterQueue.length > 0) {
      const { x, y, roomName } = clusterQueue.pop()!;
      const key = `${roomName}:${x},${y}`;

      if (visited.has(key)) continue;

      const h = distances.get(key);
      if (h !== tile.height) continue;

      visited.add(key);
      cluster.push({ x, y, roomName });

      // Check 4-connected neighbors (including cross-room)
      for (const neighbor of NEIGHBORS_4) {
        let nx = x + neighbor.x;
        let ny = y + neighbor.y;
        let nRoomName = roomName;

        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) {
          const adjacent = getAdjacentRoomPosition(
            roomName,
            nx < 0 ? 0 : nx >= GRID_SIZE ? 49 : nx,
            ny < 0 ? 0 : ny >= GRID_SIZE ? 49 : ny
          );
          if (!adjacent) continue;
          if (!distances.has(`${adjacent.roomName}:${adjacent.x},${adjacent.y}`)) continue;
          nRoomName = adjacent.roomName;
          nx = adjacent.x;
          ny = adjacent.y;
        }

        clusterQueue.push({ x: nx, y: ny, roomName: nRoomName });
      }
    }

    if (cluster.length === 0) continue;

    // Calculate centroid - need to handle cross-room clusters
    // Use the most common room as the center's room
    const roomCounts = new Map<string, number>();
    for (const c of cluster) {
      roomCounts.set(c.roomName, (roomCounts.get(c.roomName) || 0) + 1);
    }
    let centerRoom = cluster[0].roomName;
    let maxCount = 0;
    for (const [room, count] of roomCounts) {
      if (count > maxCount) {
        maxCount = count;
        centerRoom = room;
      }
    }

    // Calculate center within the dominant room
    const roomTiles = cluster.filter((c) => c.roomName === centerRoom);
    const centerX = Math.round(roomTiles.reduce((s, t) => s + t.x, 0) / roomTiles.length);
    const centerY = Math.round(roomTiles.reduce((s, t) => s + t.y, 0) / roomTiles.length);

    peaks.push({
      tiles: cluster,
      center: { x: centerX, y: centerY, roomName: centerRoom },
      height: tile.height,
    });
  }

  return peaks;
}

/**
 * Filters multi-room peaks using exclusion radius.
 *
 * Adaptive filtering ensures skinny/narrow rooms get at least one peak
 * even if all their peaks are below minHeight threshold.
 *
 * @param peaks - Unfiltered peaks from findMultiRoomPeaks
 * @param options - Filtering options
 * @returns Filtered peaks with appropriate spacing
 */
export function filterMultiRoomPeaks(
  peaks: WorldPeakData[],
  options: FilterPeaksOptions = {}
): WorldPeakData[] {
  const {
    exclusionMultiplier = 1.5,
    minHeight = 3,
    maxPeaks = 8,
  } = options;

  // Group peaks by room to track which rooms have peaks
  const peaksByRoom = new Map<string, WorldPeakData[]>();
  for (const peak of peaks) {
    const room = peak.center.roomName;
    if (!peaksByRoom.has(room)) {
      peaksByRoom.set(room, []);
    }
    peaksByRoom.get(room)!.push(peak);
  }

  // Filter by minimum height
  const validPeaks = peaks.filter((p) => p.height >= minHeight);

  // Sort by height descending
  const sortedPeaks = [...validPeaks].sort((a, b) => b.height - a.height);

  const finalPeaks: WorldPeakData[] = [];
  const excludedPositions = new Set<string>();
  const roomsWithPeaks = new Set<string>();

  for (const peak of sortedPeaks) {
    if (finalPeaks.length >= maxPeaks) break;

    const centerKey = `${peak.center.roomName}:${peak.center.x},${peak.center.y}`;
    if (excludedPositions.has(centerKey)) continue;

    finalPeaks.push(peak);
    roomsWithPeaks.add(peak.center.roomName);

    // Exclude nearby positions (within same room for simplicity)
    const exclusionRadius = Math.floor(peak.height * exclusionMultiplier);
    for (let dx = -exclusionRadius; dx <= exclusionRadius; dx++) {
      for (let dy = -exclusionRadius; dy <= exclusionRadius; dy++) {
        const ex = peak.center.x + dx;
        const ey = peak.center.y + dy;
        if (ex >= 0 && ex < GRID_SIZE && ey >= 0 && ey < GRID_SIZE) {
          excludedPositions.add(`${peak.center.roomName}:${ex},${ey}`);
        }
      }
    }
  }

  // Adaptive: For rooms that had peaks but got filtered out, add the best peak
  // This ensures narrow/skinny rooms still get representation
  for (const [room, roomPeaks] of peaksByRoom) {
    if (roomsWithPeaks.has(room)) continue; // Room already has a peak
    if (finalPeaks.length >= maxPeaks) break;

    // Find the highest peak in this room (regardless of minHeight)
    const bestPeak = roomPeaks.reduce((best, p) =>
      p.height > best.height ? p : best
    );

    // Only add if it has some height (not completely flat)
    if (bestPeak.height >= 1) {
      finalPeaks.push(bestPeak);
      roomsWithPeaks.add(room);
    }
  }

  return finalPeaks;
}

/**
 * Divides territory among peaks using BFS that crosses room boundaries.
 *
 * Tiles are assigned to the nearest peak (by BFS distance), regardless
 * of which room they're in. The BFS expands through exit tiles into
 * adjacent rooms, but ONLY into rooms that have competing peaks.
 *
 * This prevents a single peak from flooding entire adjacent rooms that
 * have no peaks to compete for territory.
 *
 * @param peaks - Peaks to divide territory among (with room names)
 * @param terrainCallback - Multi-room terrain callback
 * @param wallMask - Terrain mask value for walls (default: 1)
 * @param maxRooms - Maximum number of rooms to expand into (default: 9)
 * @returns Map of peak IDs (format: "roomName-x-y") to their assigned coordinates
 */
export function bfsDivideMultiRoom(
  peaks: WorldPeakData[],
  terrainCallback: MultiRoomTerrainCallback,
  wallMask: number = 1,
  maxRooms: number = 9
): Map<string, WorldCoordinate[]> {
  const territories = new Map<string, WorldCoordinate[]>();
  const visited = new Set<string>();

  // Collect all rooms that have peaks - territory can ONLY expand into these rooms
  // This prevents flooding into adjacent rooms with no competition
  const roomsWithPeaks = new Set<string>();
  for (const peak of peaks) {
    roomsWithPeaks.add(peak.center.roomName);
  }

  interface QueueItem {
    x: number;
    y: number;
    roomName: string;
    peakId: string;
  }

  const queue: QueueItem[] = [];

  // Sort peaks by height (highest first gets priority in ties)
  const sortedPeaks = [...peaks].sort((a, b) => b.height - a.height);

  // Initialize with peak centers
  for (const peak of sortedPeaks) {
    const peakId = `${peak.center.roomName}-${peak.center.x}-${peak.center.y}`;
    territories.set(peakId, []);

    queue.push({
      x: peak.center.x,
      y: peak.center.y,
      roomName: peak.center.roomName,
      peakId,
    });
  }

  // BFS expansion - crosses room boundaries only into rooms with peaks
  while (queue.length > 0) {
    const { x, y, roomName, peakId } = queue.shift()!;
    const key = `${roomName}:${x},${y}`;

    // Skip if already visited or wall
    if (visited.has(key)) continue;
    if (terrainCallback(roomName, x, y) === wallMask) continue;

    visited.add(key);

    // Assign tile to this peak's territory
    const territory = territories.get(peakId)!;
    territory.push({ x, y, roomName });

    // Add unvisited neighbors to queue
    for (const neighbor of NEIGHBORS_4) {
      let nx = x + neighbor.x;
      let ny = y + neighbor.y;
      let nRoomName = roomName;

      // Check if crossing room boundary
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) {
        // Get adjacent room position
        const adjacent = getAdjacentRoomPosition(
          roomName,
          nx < 0 ? 0 : nx >= GRID_SIZE ? 49 : nx,
          ny < 0 ? 0 : ny >= GRID_SIZE ? 49 : ny
        );

        if (!adjacent) continue;

        // CRITICAL FIX: Only expand into rooms that have peaks
        // This prevents flooding into empty adjacent rooms
        if (!roomsWithPeaks.has(adjacent.roomName)) {
          continue;
        }

        nRoomName = adjacent.roomName;
        nx = adjacent.x;
        ny = adjacent.y;
      }

      const nkey = `${nRoomName}:${nx},${ny}`;

      if (
        !visited.has(nkey) &&
        terrainCallback(nRoomName, nx, ny) !== wallMask
      ) {
        queue.push({ x: nx, y: ny, roomName: nRoomName, peakId });
      }
    }
  }

  return territories;
}
