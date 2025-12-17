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
