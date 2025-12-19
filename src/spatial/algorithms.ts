/**
 * @fileoverview Pure spatial algorithms for multi-room mapping.
 *
 * This module contains pure functions with no dependencies on Screeps Game
 * globals or RoomPosition objects. This enables comprehensive unit testing
 * without mocking the Screeps environment.
 *
 * All algorithms operate across room boundaries - single rooms are just
 * a special case of multi-room analysis with one room.
 *
 * @module spatial/algorithms
 */

/** Room grid dimensions */
export const GRID_SIZE = 50;

/**
 * World coordinate that includes room name.
 */
export interface WorldCoordinate {
  x: number;
  y: number;
  roomName: string;
}

/**
 * Peak data with room context.
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
 * Options for peak filtering.
 */
export interface FilterPeaksOptions {
  /** Multiplier for height-based exclusion radius (default: 1.2) */
  exclusionMultiplier?: number;
  /** Minimum height threshold - peaks below this are discarded (default: 2) */
  minHeight?: number;
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
 * 8-directional neighbors for BFS propagation.
 */
const NEIGHBORS_8: { x: number; y: number }[] = [
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
const NEIGHBORS_4: { x: number; y: number }[] = [
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: 0, y: 1 },
];

// ============================================================================
// Room Coordinate Utilities
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
// Distance Transform
// ============================================================================

/**
 * Creates a multi-room distance transform where room boundaries don't affect distances.
 *
 * BFS from walls continues across room exits, giving accurate "distance from walls"
 * values for positions near room edges. Higher values indicate more open areas.
 *
 * @param startRooms - Initial rooms to include in the analysis
 * @param terrainCallback - Multi-room terrain callback
 * @param wallMask - Terrain mask value for walls (default: 1)
 * @param maxRooms - Maximum rooms to expand into (default: 9)
 * @param allowedRooms - If provided, only expand into these rooms
 * @returns Map of "roomName:x,y" to distance value
 */
export function createMultiRoomDistanceTransform(
  startRooms: string[],
  terrainCallback: MultiRoomTerrainCallback,
  wallMask: number = 1,
  maxRooms: number = 9,
  allowedRooms?: Set<string>
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

        // If allowedRooms is set, only expand to rooms in that set
        if (allowedRooms && !allowedRooms.has(adjacent.roomName)) {
          continue;
        }

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

// ============================================================================
// Peak Detection
// ============================================================================

/**
 * Finds peaks across multiple rooms from a multi-room distance transform.
 *
 * Peaks are local maxima - the centers of open areas. They represent
 * ideal locations for bases, extensions, and control points.
 *
 * @param distances - Multi-room distance map from createMultiRoomDistanceTransform
 * @returns Array of peaks with world coordinates
 */
export function findMultiRoomPeaks(
  distances: Map<string, number>
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

      // Check 4-connected neighbors (crosses room boundaries for unified peaks)
      for (const neighbor of NEIGHBORS_4) {
        const nx = x + neighbor.x;
        const ny = y + neighbor.y;

        // Check if we're crossing a room boundary
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) {
          // Get the adjacent room position
          // When nx < 0, we were at x=0 going left; when nx >= 50, we were at x=49 going right
          const edgeX = nx < 0 ? 0 : nx >= GRID_SIZE ? 49 : x;
          const edgeY = ny < 0 ? 0 : ny >= GRID_SIZE ? 49 : y;
          const adjacent = getAdjacentRoomPosition(roomName, edgeX, edgeY);

          if (adjacent) {
            // Check if this position exists in the distance map (room was loaded)
            const adjKey = `${adjacent.roomName}:${adjacent.x},${adjacent.y}`;
            if (distances.has(adjKey)) {
              clusterQueue.push({ x: adjacent.x, y: adjacent.y, roomName: adjacent.roomName });
            }
          }
          continue;
        }

        clusterQueue.push({ x: nx, y: ny, roomName });
      }
    }

    if (cluster.length === 0) continue;

    // Calculate centroid - use the most common room as the center's room
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

// ============================================================================
// Peak Filtering
// ============================================================================

/**
 * Filters multi-room peaks using exclusion radius.
 *
 * Uses the peak's height as exclusion radius - taller peaks dominate more area.
 * This prevents clustering of many small peaks near large open areas.
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
    minHeight = 2,
  } = options;

  if (peaks.length === 0) return [];

  // Filter by minimum height and sort by height descending
  const sortedPeaks = peaks
    .filter((p) => p.height >= minHeight)
    .sort((a, b) => b.height - a.height);

  const finalPeaks: WorldPeakData[] = [];
  const excludedPositions = new Set<string>();

  for (const peak of sortedPeaks) {
    const centerKey = `${peak.center.roomName}:${peak.center.x},${peak.center.y}`;
    if (excludedPositions.has(centerKey)) continue;

    finalPeaks.push(peak);

    // Exclude nearby positions (crosses room boundaries)
    const exclusionRadius = Math.min(Math.floor(peak.height * exclusionMultiplier), 20);
    for (let dx = -exclusionRadius; dx <= exclusionRadius; dx++) {
      for (let dy = -exclusionRadius; dy <= exclusionRadius; dy++) {
        const ex = peak.center.x + dx;
        const ey = peak.center.y + dy;
        if (ex >= 0 && ex < GRID_SIZE && ey >= 0 && ey < GRID_SIZE) {
          excludedPositions.add(`${peak.center.roomName}:${ex},${ey}`);
        } else {
          // Handle exclusion zone crossing into adjacent rooms
          const edgeX = ex < 0 ? 0 : ex >= GRID_SIZE ? 49 : peak.center.x;
          const edgeY = ey < 0 ? 0 : ey >= GRID_SIZE ? 49 : peak.center.y;
          const adjacent = getAdjacentRoomPosition(peak.center.roomName, edgeX, edgeY);
          if (adjacent) {
            // Calculate the position in the adjacent room
            // ex < 0 means we went left from x=0, so in adjacent room it's 49 + (ex + 1) = 49 + ex + 1 = 50 + ex
            // ex >= 50 means we went right from x=49, so in adjacent room it's ex - 50
            const adjX = ex < 0 ? GRID_SIZE + ex : ex >= GRID_SIZE ? ex - GRID_SIZE : adjacent.x;
            const adjY = ey < 0 ? GRID_SIZE + ey : ey >= GRID_SIZE ? ey - GRID_SIZE : adjacent.y;
            if (adjX >= 0 && adjX < GRID_SIZE && adjY >= 0 && adjY < GRID_SIZE) {
              excludedPositions.add(`${adjacent.roomName}:${adjX},${adjY}`);
            }
          }
        }
      }
    }
  }

  return finalPeaks;
}

// ============================================================================
// Territory Division
// ============================================================================

/**
 * Computes BFS walking distance between two world positions.
 * Walks through non-wall terrain, crossing room boundaries.
 *
 * @param from - Starting position with room name
 * @param to - Target position with room name
 * @param terrainCallback - Multi-room terrain callback
 * @param wallMask - Terrain mask value for walls (default: 1)
 * @param maxDistance - Maximum distance to search (default: 200)
 * @returns Walking distance in tiles, or Infinity if unreachable
 */
export function bfsWalkingDistance(
  from: WorldCoordinate,
  to: WorldCoordinate,
  terrainCallback: MultiRoomTerrainCallback,
  wallMask: number = 1,
  maxDistance: number = 200
): number {
  if (from.roomName === to.roomName && from.x === to.x && from.y === to.y) {
    return 0;
  }

  const visited = new Set<string>();
  const queue: { x: number; y: number; roomName: string; dist: number }[] = [
    { x: from.x, y: from.y, roomName: from.roomName, dist: 0 },
  ];
  visited.add(`${from.roomName}:${from.x},${from.y}`);

  while (queue.length > 0) {
    const { x, y, roomName, dist } = queue.shift()!;

    if (dist >= maxDistance) continue;

    for (const neighbor of NEIGHBORS_8) {
      let nx = x + neighbor.x;
      let ny = y + neighbor.y;
      let nRoomName = roomName;

      // Handle room boundary crossing
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) {
        const adjacent = getAdjacentRoomPosition(
          roomName,
          nx < 0 ? 0 : nx >= GRID_SIZE ? 49 : nx,
          ny < 0 ? 0 : ny >= GRID_SIZE ? 49 : ny
        );
        if (!adjacent) continue;
        nRoomName = adjacent.roomName;
        nx = adjacent.x;
        ny = adjacent.y;
      }

      const nKey = `${nRoomName}:${nx},${ny}`;
      if (visited.has(nKey)) continue;
      if (terrainCallback(nRoomName, nx, ny) === wallMask) continue;

      // Check if we reached the target
      if (nRoomName === to.roomName && nx === to.x && ny === to.y) {
        return dist + 1;
      }

      visited.add(nKey);
      queue.push({ x: nx, y: ny, roomName: nRoomName, dist: dist + 1 });
    }
  }

  return Infinity;
}

/**
 * Finds which territories are adjacent (share a border).
 * This creates the skeleton graph - edges exist only between peaks
 * whose territories touch.
 *
 * @param territories - Map of peak IDs to their territory coordinates
 * @returns Set of edge keys in format "peakId1|peakId2" (sorted alphabetically)
 */
export function findTerritoryAdjacencies(
  territories: Map<string, WorldCoordinate[]>
): Set<string> {
  // Build reverse lookup: "roomName:x,y" -> peakId
  const tileToTerritory = new Map<string, string>();
  for (const [peakId, tiles] of territories) {
    for (const tile of tiles) {
      const key = `${tile.roomName}:${tile.x},${tile.y}`;
      tileToTerritory.set(key, peakId);
    }
  }

  // Find adjacent pairs by checking borders
  const adjacentPairs = new Set<string>();

  for (const [peakId, tiles] of territories) {
    for (const tile of tiles) {
      // Check 4-connected neighbors (sufficient for adjacency)
      for (const neighbor of NEIGHBORS_4) {
        let nx = tile.x + neighbor.x;
        let ny = tile.y + neighbor.y;
        let nRoomName = tile.roomName;

        // Handle room boundary crossing
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) {
          const adjacent = getAdjacentRoomPosition(
            tile.roomName,
            nx < 0 ? 0 : nx >= GRID_SIZE ? 49 : nx,
            ny < 0 ? 0 : ny >= GRID_SIZE ? 49 : ny
          );
          if (!adjacent) continue;
          nRoomName = adjacent.roomName;
          nx = adjacent.x;
          ny = adjacent.y;
        }

        const nKey = `${nRoomName}:${nx},${ny}`;
        const neighborPeakId = tileToTerritory.get(nKey);

        if (neighborPeakId && neighborPeakId !== peakId) {
          // Found adjacent territories - create sorted edge key
          const edgeKey = [peakId, neighborPeakId].sort().join("|");
          adjacentPairs.add(edgeKey);
        }
      }
    }
  }

  return adjacentPairs;
}

// ============================================================================
// Incremental Skeleton Builder (multi-tick)
// ============================================================================

/**
 * State for incremental skeleton building across multiple ticks.
 */
export interface SkeletonBuilderState {
  /** Current phase: 'lookup' | 'adjacencies' | 'distances' | 'done' */
  phase: "lookup" | "adjacencies" | "distances" | "done";
  /** Reverse lookup map being built */
  tileToTerritory: Map<string, string>;
  /** Territory entries to process */
  territoryEntries: [string, WorldCoordinate[]][];
  /** Current territory index */
  territoryIndex: number;
  /** Current tile index within territory */
  tileIndex: number;
  /** Found adjacencies */
  adjacencies: Set<string>;
  /** Adjacency keys to compute distances for */
  adjacencyList: string[];
  /** Current adjacency index for distance computation */
  adjacencyIndex: number;
  /** Computed edge weights */
  edgeWeights: Map<string, number>;
}

/**
 * Creates initial state for incremental skeleton building.
 */
export function createSkeletonBuilderState(
  territories: Map<string, WorldCoordinate[]>
): SkeletonBuilderState {
  return {
    phase: "lookup",
    tileToTerritory: new Map(),
    territoryEntries: Array.from(territories.entries()),
    territoryIndex: 0,
    tileIndex: 0,
    adjacencies: new Set(),
    adjacencyList: [],
    adjacencyIndex: 0,
    edgeWeights: new Map(),
  };
}

/**
 * Processes a chunk of skeleton building work.
 * Call this each tick until state.phase === 'done'.
 *
 * @param state - Current builder state
 * @param peaks - Peak data for distance computation
 * @param terrainCallback - Terrain callback for walking distance
 * @param wallMask - Wall terrain mask
 * @param maxOpsPerTick - Maximum operations per tick (default: 1000)
 * @returns true if done, false if more work needed
 */
export function processSkeletonBuilderChunk(
  state: SkeletonBuilderState,
  peaks: { peakId: string; center: WorldCoordinate }[],
  terrainCallback: MultiRoomTerrainCallback,
  wallMask: number = 1,
  maxOpsPerTick: number = 1000
): boolean {
  let ops = 0;

  // Phase 1: Build reverse lookup
  if (state.phase === "lookup") {
    while (state.territoryIndex < state.territoryEntries.length && ops < maxOpsPerTick) {
      const [peakId, tiles] = state.territoryEntries[state.territoryIndex];
      while (state.tileIndex < tiles.length && ops < maxOpsPerTick) {
        const tile = tiles[state.tileIndex];
        const key = `${tile.roomName}:${tile.x},${tile.y}`;
        state.tileToTerritory.set(key, peakId);
        state.tileIndex++;
        ops++;
      }
      if (state.tileIndex >= tiles.length) {
        state.territoryIndex++;
        state.tileIndex = 0;
      }
    }
    if (state.territoryIndex >= state.territoryEntries.length) {
      state.phase = "adjacencies";
      state.territoryIndex = 0;
      state.tileIndex = 0;
    }
    return false;
  }

  // Phase 2: Find adjacencies
  if (state.phase === "adjacencies") {
    while (state.territoryIndex < state.territoryEntries.length && ops < maxOpsPerTick) {
      const [peakId, tiles] = state.territoryEntries[state.territoryIndex];
      while (state.tileIndex < tiles.length && ops < maxOpsPerTick) {
        const tile = tiles[state.tileIndex];
        for (const neighbor of NEIGHBORS_4) {
          let nx = tile.x + neighbor.x;
          let ny = tile.y + neighbor.y;
          let nRoomName = tile.roomName;

          if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) {
            const adjacent = getAdjacentRoomPosition(
              tile.roomName,
              nx < 0 ? 0 : nx >= GRID_SIZE ? 49 : nx,
              ny < 0 ? 0 : ny >= GRID_SIZE ? 49 : ny
            );
            if (!adjacent) continue;
            nRoomName = adjacent.roomName;
            nx = adjacent.x;
            ny = adjacent.y;
          }

          const nKey = `${nRoomName}:${nx},${ny}`;
          const neighborPeakId = state.tileToTerritory.get(nKey);

          if (neighborPeakId && neighborPeakId !== peakId) {
            const edgeKey = [peakId, neighborPeakId].sort().join("|");
            state.adjacencies.add(edgeKey);
          }
        }
        state.tileIndex++;
        ops++;
      }
      if (state.tileIndex >= tiles.length) {
        state.territoryIndex++;
        state.tileIndex = 0;
      }
    }
    if (state.territoryIndex >= state.territoryEntries.length) {
      state.phase = "distances";
      state.adjacencyList = Array.from(state.adjacencies);
      state.adjacencyIndex = 0;
      // Clear lookup to free memory
      state.tileToTerritory.clear();
    }
    return false;
  }

  // Phase 3: Compute walking distances
  if (state.phase === "distances") {
    const peakById = new Map<string, { peakId: string; center: WorldCoordinate }>();
    for (const peak of peaks) {
      peakById.set(peak.peakId, peak);
    }

    // Process one edge per tick (BFS is expensive)
    while (state.adjacencyIndex < state.adjacencyList.length && ops < 1) {
      const adjacencyKey = state.adjacencyList[state.adjacencyIndex];
      const [peakId1, peakId2] = adjacencyKey.split("|");
      const p1 = peakById.get(peakId1);
      const p2 = peakById.get(peakId2);

      if (p1 && p2) {
        const distance = bfsWalkingDistance(p1.center, p2.center, terrainCallback, wallMask);
        state.edgeWeights.set(adjacencyKey, distance);
      }
      state.adjacencyIndex++;
      ops++;
    }

    if (state.adjacencyIndex >= state.adjacencyList.length) {
      state.phase = "done";
      return true;
    }
    return false;
  }

  return state.phase === "done";
}

/**
 * Divides territory among peaks using BFS that crosses room boundaries.
 *
 * Tiles are assigned to the nearest peak (by BFS distance), regardless
 * of which room they're in. All peaks expand simultaneously at the same rate.
 *
 * The BFS expands through exit tiles into adjacent rooms, but ONLY into
 * rooms that have competing peaks. This prevents a single peak from
 * flooding entire adjacent rooms with no competition.
 *
 * @param peaks - Peaks to divide territory among (with room names)
 * @param terrainCallback - Multi-room terrain callback
 * @param wallMask - Terrain mask value for walls (default: 1)
 * @param maxRooms - Maximum number of rooms to expand into (default: 9)
 * @param allowedRooms - If provided, only expand into these rooms
 * @returns Map of peak IDs (format: "roomName-x-y") to their assigned coordinates
 */
export function bfsDivideMultiRoom(
  peaks: WorldPeakData[],
  terrainCallback: MultiRoomTerrainCallback,
  wallMask: number = 1,
  maxRooms: number = 9,
  allowedRooms?: Set<string>
): Map<string, WorldCoordinate[]> {
  const territories = new Map<string, WorldCoordinate[]>();
  const visited = new Set<string>();

  // Collect all rooms that have peaks - territory can ONLY expand into these rooms
  // This prevents flooding into adjacent rooms with no competition
  // If allowedRooms is provided, use that instead (more restrictive)
  const roomsWithPeaks = new Set<string>();
  for (const peak of peaks) {
    roomsWithPeaks.add(peak.center.roomName);
  }

  // Use allowedRooms if provided, otherwise fall back to roomsWithPeaks
  const eligibleRooms = allowedRooms ?? roomsWithPeaks;

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

  // BFS expansion - crosses room boundaries only into eligible rooms
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

        // Only expand into eligible rooms
        if (!eligibleRooms.has(adjacent.roomName)) {
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
