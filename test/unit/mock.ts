// ============================================================================
// Enhanced Screeps Mocks - Ported from santa branch
// Enables proper unit testing without Screeps server
// ============================================================================

export const Game: {
  creeps: { [name: string]: any };
  rooms: { [name: string]: any };
  spawns: { [name: string]: any };
  time: number;
  map: {
    getRoomTerrain: (roomName: string) => any;
  };
  getObjectById: (id: string) => any;
} = {
  creeps: {},
  rooms: {},
  spawns: {},
  time: 12345,
  map: {
    getRoomTerrain: (roomName: string) => ({
      get: (x: number, y: number) => 0 // Default: not a wall
    })
  },
  getObjectById: (id: string): any => null
};

export const Memory: {
  creeps: { [name: string]: any };
  rooms: { [name: string]: any };
  colonies?: { [id: string]: any };
  nodeNetwork?: any;
} = {
  creeps: {},
  rooms: {}
};

// ============================================================================
// RoomPosition Mock - Full implementation for pathfinding tests
// ============================================================================
export class MockRoomPosition {
  x: number;
  y: number;
  roomName: string;

  constructor(x: number, y: number, roomName: string) {
    this.x = x;
    this.y = y;
    this.roomName = roomName;
  }

  getRangeTo(target: MockRoomPosition | { x: number; y: number }): number {
    const dx = Math.abs(this.x - target.x);
    const dy = Math.abs(this.y - target.y);
    return Math.max(dx, dy); // Chebyshev distance (Screeps uses this)
  }

  getDirectionTo(target: MockRoomPosition | { x: number; y: number }): number {
    const dx = target.x - this.x;
    const dy = target.y - this.y;

    if (dx > 0 && dy === 0) return 3; // RIGHT
    if (dx > 0 && dy > 0) return 4;   // BOTTOM_RIGHT
    if (dx === 0 && dy > 0) return 5; // BOTTOM
    if (dx < 0 && dy > 0) return 6;   // BOTTOM_LEFT
    if (dx < 0 && dy === 0) return 7; // LEFT
    if (dx < 0 && dy < 0) return 8;   // TOP_LEFT
    if (dx === 0 && dy < 0) return 1; // TOP
    if (dx > 0 && dy < 0) return 2;   // TOP_RIGHT
    return 0;
  }

  isNearTo(target: MockRoomPosition | { x: number; y: number }): boolean {
    return this.getRangeTo(target) <= 1;
  }

  isEqualTo(target: MockRoomPosition | { x: number; y: number; roomName?: string }): boolean {
    return this.x === target.x &&
           this.y === target.y &&
           (!target.roomName || this.roomName === target.roomName);
  }

  inRangeTo(target: MockRoomPosition | { x: number; y: number }, range: number): boolean {
    return this.getRangeTo(target) <= range;
  }

  toString(): string {
    return `[room ${this.roomName} pos ${this.x},${this.y}]`;
  }
}

// ============================================================================
// PathFinder Mock - CostMatrix for spatial algorithms
// ============================================================================
export const MockPathFinder = {
  CostMatrix: class CostMatrix {
    private _bits: Uint8Array;

    constructor() {
      this._bits = new Uint8Array(2500); // 50x50 grid
    }

    get(x: number, y: number): number {
      return this._bits[y * 50 + x];
    }

    set(x: number, y: number, val: number): void {
      this._bits[y * 50 + x] = val;
    }

    clone(): CostMatrix {
      const copy = new MockPathFinder.CostMatrix();
      copy._bits = new Uint8Array(this._bits);
      return copy;
    }

    serialize(): number[] {
      return Array.from(this._bits);
    }

    static deserialize(data: number[]): CostMatrix {
      const matrix = new MockPathFinder.CostMatrix();
      matrix._bits = new Uint8Array(data);
      return matrix;
    }
  },

  search: (origin: any, goal: any, opts?: any) => ({
    path: [],
    ops: 0,
    cost: 0,
    incomplete: false
  })
};

// ============================================================================
// Screeps Constants
// ============================================================================
export const FIND_SOURCES = 105;
export const FIND_MINERALS = 106;
export const FIND_STRUCTURES = 107;
export const FIND_MY_SPAWNS = 112;
export const FIND_MY_CREEPS = 106;
export const FIND_HOSTILE_CREEPS = 103;

export const LOOK_SOURCES = 'source';
export const LOOK_STRUCTURES = 'structure';
export const LOOK_CREEPS = 'creep';
export const LOOK_RESOURCES = 'resource';

export const TERRAIN_MASK_WALL = 1;
export const TERRAIN_MASK_SWAMP = 2;

export const STRUCTURE_SPAWN = 'spawn';
export const STRUCTURE_EXTENSION = 'extension';
export const STRUCTURE_STORAGE = 'storage';
export const STRUCTURE_CONTAINER = 'container';
export const STRUCTURE_CONTROLLER = 'controller';

export const OK = 0;
export const ERR_NOT_IN_RANGE = -9;
export const ERR_NOT_ENOUGH_ENERGY = -6;
export const ERR_BUSY = -4;
export const ERR_INVALID_TARGET = -7;

export const WORK = 'work';
export const CARRY = 'carry';
export const MOVE = 'move';
export const ATTACK = 'attack';
export const RANGED_ATTACK = 'ranged_attack';
export const HEAL = 'heal';
export const TOUGH = 'tough';
export const CLAIM = 'claim';

// ============================================================================
// Helper to setup globals for tests
// ============================================================================
export function setupGlobals(): void {
  (global as any).Game = Game;
  (global as any).Memory = Memory;
  (global as any).RoomPosition = MockRoomPosition;
  (global as any).PathFinder = MockPathFinder;

  // Constants
  (global as any).FIND_SOURCES = FIND_SOURCES;
  (global as any).FIND_MINERALS = FIND_MINERALS;
  (global as any).FIND_STRUCTURES = FIND_STRUCTURES;
  (global as any).FIND_MY_SPAWNS = FIND_MY_SPAWNS;
  (global as any).FIND_MY_CREEPS = FIND_MY_CREEPS;
  (global as any).FIND_HOSTILE_CREEPS = FIND_HOSTILE_CREEPS;

  (global as any).LOOK_SOURCES = LOOK_SOURCES;
  (global as any).LOOK_STRUCTURES = LOOK_STRUCTURES;
  (global as any).LOOK_CREEPS = LOOK_CREEPS;
  (global as any).LOOK_RESOURCES = LOOK_RESOURCES;

  (global as any).TERRAIN_MASK_WALL = TERRAIN_MASK_WALL;
  (global as any).TERRAIN_MASK_SWAMP = TERRAIN_MASK_SWAMP;

  (global as any).STRUCTURE_SPAWN = STRUCTURE_SPAWN;
  (global as any).STRUCTURE_EXTENSION = STRUCTURE_EXTENSION;
  (global as any).STRUCTURE_STORAGE = STRUCTURE_STORAGE;
  (global as any).STRUCTURE_CONTAINER = STRUCTURE_CONTAINER;
  (global as any).STRUCTURE_CONTROLLER = STRUCTURE_CONTROLLER;

  (global as any).OK = OK;
  (global as any).ERR_NOT_IN_RANGE = ERR_NOT_IN_RANGE;
  (global as any).ERR_NOT_ENOUGH_ENERGY = ERR_NOT_ENOUGH_ENERGY;
  (global as any).ERR_BUSY = ERR_BUSY;
  (global as any).ERR_INVALID_TARGET = ERR_INVALID_TARGET;

  (global as any).WORK = WORK;
  (global as any).CARRY = CARRY;
  (global as any).MOVE = MOVE;
  (global as any).ATTACK = ATTACK;
  (global as any).RANGED_ATTACK = RANGED_ATTACK;
  (global as any).HEAL = HEAL;
  (global as any).TOUGH = TOUGH;
  (global as any).CLAIM = CLAIM;
}

// ============================================================================
// Mock Room Factory
// ============================================================================
export function createMockRoom(name: string, options: {
  energySources?: { x: number; y: number }[];
  controller?: { x: number; y: number; level: number };
  spawns?: { x: number; y: number; name: string }[];
  terrain?: (x: number, y: number) => number;
} = {}): any {
  const terrain = options.terrain || (() => 0);

  return {
    name,
    controller: options.controller ? {
      id: `controller-${name}` as Id<StructureController>,
      pos: new MockRoomPosition(options.controller.x, options.controller.y, name),
      level: options.controller.level,
      my: true
    } : undefined,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    find: (type: number) => {
      if (type === FIND_SOURCES && options.energySources) {
        return options.energySources.map((pos, i) => ({
          id: `source-${name}-${i}` as Id<Source>,
          pos: new MockRoomPosition(pos.x, pos.y, name),
          energy: 3000,
          energyCapacity: 3000
        }));
      }
      if (type === FIND_MY_SPAWNS && options.spawns) {
        return options.spawns.map(spawn => ({
          id: `spawn-${spawn.name}` as Id<StructureSpawn>,
          name: spawn.name,
          pos: new MockRoomPosition(spawn.x, spawn.y, name),
          spawning: null,
          spawnCreep: () => OK
        }));
      }
      return [];
    },
    lookForAt: (type: string, x: number, y: number) => [],
    getTerrain: () => ({ get: terrain }),
    visual: {
      circle: () => {},
      rect: () => {},
      text: () => {},
      line: () => {},
      poly: () => {}
    }
  };
}

// ============================================================================
// Terrain Matrix Helpers - For Pure Algorithm Testing
// ============================================================================

/**
 * Creates a terrain callback from a string pattern.
 *
 * Character mapping:
 * - 'X' or '#' = wall (TERRAIN_MASK_WALL = 1)
 * - '~' = swamp (TERRAIN_MASK_SWAMP = 2)
 * - '.' or ' ' = plain (0)
 *
 * @param pattern - Array of strings representing terrain rows
 * @returns Terrain callback function (x, y) => terrainMask
 *
 * @example
 * const terrain = createTerrainFromPattern([
 *   "XXXXXXXXXX",
 *   "X........X",
 *   "X........X",
 *   "X........X",
 *   "XXXXXXXXXX"
 * ]);
 * console.log(terrain(0, 0)); // 1 (wall)
 * console.log(terrain(5, 2)); // 0 (plain)
 */
export function createTerrainFromPattern(pattern: string[]): (x: number, y: number) => number {
  return (x: number, y: number): number => {
    // Out of pattern bounds = wall
    if (y < 0 || y >= pattern.length) return TERRAIN_MASK_WALL;
    if (x < 0 || x >= pattern[y].length) return TERRAIN_MASK_WALL;

    const char = pattern[y][x];
    switch (char) {
      case 'X':
      case '#':
        return TERRAIN_MASK_WALL;
      case '~':
        return TERRAIN_MASK_SWAMP;
      case '.':
      case ' ':
      default:
        return 0; // plain
    }
  };
}

/**
 * Creates a full 50x50 terrain callback from a smaller pattern.
 * The pattern is centered in the room, with walls at the borders.
 *
 * @param pattern - Array of strings representing terrain rows
 * @param wallBorder - Whether to add wall borders (default: true)
 * @returns Terrain callback function (x, y) => terrainMask
 *
 * @example
 * const terrain = createFullRoomTerrain([
 *   "........",
 *   "........",
 *   "...XX...",
 *   "...XX...",
 *   "........",
 *   "........"
 * ]);
 */
export function createFullRoomTerrain(
  pattern: string[],
  wallBorder: boolean = true
): (x: number, y: number) => number {
  const patternHeight = pattern.length;
  const patternWidth = pattern[0]?.length || 0;

  // Center the pattern
  const offsetX = Math.floor((50 - patternWidth) / 2);
  const offsetY = Math.floor((50 - patternHeight) / 2);

  const innerTerrain = createTerrainFromPattern(pattern);

  return (x: number, y: number): number => {
    // Room border walls (edge tiles are always walls in Screeps)
    if (wallBorder && (x === 0 || x === 49 || y === 0 || y === 49)) {
      return TERRAIN_MASK_WALL;
    }

    // Check if within pattern bounds
    const patternX = x - offsetX;
    const patternY = y - offsetY;

    if (patternX >= 0 && patternX < patternWidth &&
        patternY >= 0 && patternY < patternHeight) {
      return innerTerrain(patternX, patternY);
    }

    // Outside pattern = plain
    return 0;
  };
}

/**
 * Creates an empty room terrain (all plains except border walls).
 *
 * @returns Terrain callback function (x, y) => terrainMask
 */
export function createEmptyRoomTerrain(): (x: number, y: number) => number {
  return (x: number, y: number): number => {
    // Room border walls
    if (x === 0 || x === 49 || y === 0 || y === 49) {
      return TERRAIN_MASK_WALL;
    }
    return 0; // plain
  };
}

/**
 * Creates a corridor room terrain (walls on top and bottom).
 *
 * @param corridorY - Y position of the corridor center (default: 25)
 * @param corridorHeight - Height of the open corridor (default: 10)
 * @returns Terrain callback function (x, y) => terrainMask
 */
export function createCorridorTerrain(
  corridorY: number = 25,
  corridorHeight: number = 10
): (x: number, y: number) => number {
  const halfHeight = Math.floor(corridorHeight / 2);
  const minY = corridorY - halfHeight;
  const maxY = corridorY + halfHeight;

  return (x: number, y: number): number => {
    // Room border walls
    if (x === 0 || x === 49 || y === 0 || y === 49) {
      return TERRAIN_MASK_WALL;
    }
    // Corridor walls (above and below the corridor)
    if (y < minY || y > maxY) {
      return TERRAIN_MASK_WALL;
    }
    return 0; // plain
  };
}

/**
 * Creates an islands room terrain (multiple separated open areas).
 *
 * @param islands - Array of island definitions {x, y, radius}
 * @returns Terrain callback function (x, y) => terrainMask
 */
export function createIslandsTerrain(
  islands: { x: number; y: number; radius: number }[]
): (x: number, y: number) => number {
  return (x: number, y: number): number => {
    // Room border walls
    if (x === 0 || x === 49 || y === 0 || y === 49) {
      return TERRAIN_MASK_WALL;
    }

    // Check if point is within any island
    for (const island of islands) {
      const dx = x - island.x;
      const dy = y - island.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance <= island.radius) {
        return 0; // plain (inside island)
      }
    }

    return TERRAIN_MASK_WALL; // wall (between islands)
  };
}

/**
 * Visualizes terrain as ASCII art for debugging.
 *
 * @param terrain - Terrain callback function
 * @param width - Width to visualize (default: 50)
 * @param height - Height to visualize (default: 50)
 * @returns Multi-line string representation
 */
export function visualizeTerrain(
  terrain: (x: number, y: number) => number,
  width: number = 50,
  height: number = 50
): string {
  const lines: string[] = [];
  for (let y = 0; y < height; y++) {
    let line = '';
    for (let x = 0; x < width; x++) {
      const t = terrain(x, y);
      if (t === TERRAIN_MASK_WALL) {
        line += '#';
      } else if (t === TERRAIN_MASK_SWAMP) {
        line += '~';
      } else {
        line += '.';
      }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Visualizes a distance matrix as ASCII art for debugging.
 * Uses digits 0-9 and letters for higher values.
 *
 * @param matrix - 2D distance matrix
 * @returns Multi-line string representation
 */
export function visualizeDistanceMatrix(matrix: number[][]): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lines: string[] = [];

  for (let y = 0; y < matrix[0]?.length || 0; y++) {
    let line = '';
    for (let x = 0; x < matrix.length; x++) {
      const val = matrix[x]?.[y];
      if (val === undefined || val === Infinity) {
        line += '?';
      } else if (val < 0) {
        line += '-';
      } else if (val < chars.length) {
        line += chars[val];
      } else {
        line += '+';
      }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// ============================================================================
// Multi-Room Test Helpers
// ============================================================================

import {
  createMultiRoomDistanceTransform,
  findMultiRoomPeaks,
  filterMultiRoomPeaks,
  bfsDivideMultiRoom,
  WorldPeakData,
  WorldCoordinate,
  FilterPeaksOptions,
} from "../../src/spatial/algorithms";

/** Default test room name for single-room tests */
export const TEST_ROOM = "W1N1";

/** Simple coordinate type for test compatibility */
export interface Coordinate {
  x: number;
  y: number;
}

/** Peak data for test compatibility (single-room) */
export interface PeakData {
  tiles: Coordinate[];
  center: Coordinate;
  height: number;
}

/**
 * Single-room distance transform wrapper for testing.
 * Uses multi-room function internally with a single room.
 */
export function createDistanceTransform(
  terrain: (x: number, y: number) => number,
  wallMask: number = TERRAIN_MASK_WALL
): number[][] {
  const distances = createMultiRoomDistanceTransform(
    [TEST_ROOM],
    wrapTerrainForMultiRoom(terrain),
    wallMask,
    1 // Only one room
  );
  return distanceMapToArray(distances);
}

/**
 * Single-room peak detection wrapper for testing.
 * Uses multi-room function internally with a single room.
 */
export function findPeaks(
  distanceMatrix: number[][],
  terrain: (x: number, y: number) => number,
  wallMask: number = TERRAIN_MASK_WALL
): PeakData[] {
  // Convert 2D array to Map for multi-room function
  const distances = new Map<string, number>();
  for (let x = 0; x < distanceMatrix.length; x++) {
    for (let y = 0; y < (distanceMatrix[x]?.length ?? 0); y++) {
      distances.set(`${TEST_ROOM}:${x},${y}`, distanceMatrix[x][y]);
    }
  }

  const worldPeaks = findMultiRoomPeaks(distances);

  // Convert WorldPeakData to PeakData
  return worldPeaks.map((wp) => ({
    tiles: wp.tiles.map((t) => ({ x: t.x, y: t.y })),
    center: { x: wp.center.x, y: wp.center.y },
    height: wp.height,
  }));
}

/**
 * Single-room peak filtering wrapper for testing.
 * Uses multi-room function internally.
 */
export function filterPeaks(
  peaks: PeakData[],
  options: FilterPeaksOptions = {}
): PeakData[] {
  // Convert PeakData to WorldPeakData
  const worldPeaks: WorldPeakData[] = peaks.map((p) => ({
    tiles: p.tiles.map((t) => ({ x: t.x, y: t.y, roomName: TEST_ROOM })),
    center: { x: p.center.x, y: p.center.y, roomName: TEST_ROOM },
    height: p.height,
  }));

  const filtered = filterMultiRoomPeaks(worldPeaks, options);

  // Convert back to PeakData
  return filtered.map((wp) => ({
    tiles: wp.tiles.map((t) => ({ x: t.x, y: t.y })),
    center: { x: wp.center.x, y: wp.center.y },
    height: wp.height,
  }));
}

/**
 * Single-room territory division wrapper for testing.
 * Uses multi-room function internally.
 */
export function bfsDivideRoom(
  peaks: PeakData[],
  terrain: (x: number, y: number) => number,
  wallMask: number = TERRAIN_MASK_WALL
): Map<string, Coordinate[]> {
  // Convert PeakData to WorldPeakData
  const worldPeaks: WorldPeakData[] = peaks.map((p) => ({
    tiles: p.tiles.map((t) => ({ x: t.x, y: t.y, roomName: TEST_ROOM })),
    center: { x: p.center.x, y: p.center.y, roomName: TEST_ROOM },
    height: p.height,
  }));

  const worldTerritories = bfsDivideMultiRoom(
    worldPeaks,
    wrapTerrainForMultiRoom(terrain),
    wallMask,
    1 // Only one room
  );

  // Convert to single-room format (peakId without room prefix)
  const territories = new Map<string, Coordinate[]>();
  for (const [worldPeakId, worldCoords] of worldTerritories) {
    // Convert "W1N1-x-y" to "x-y"
    const peakId = worldPeakId.replace(`${TEST_ROOM}-`, "");
    territories.set(
      peakId,
      worldCoords.map((c) => ({ x: c.x, y: c.y }))
    );
  }

  return territories;
}

/**
 * Wraps a single-room terrain callback for use with multi-room functions.
 * All room names will use the same terrain callback.
 *
 * @param terrain - Single-room terrain callback (x, y) => number
 * @returns Multi-room terrain callback (roomName, x, y) => number
 */
export function wrapTerrainForMultiRoom(
  terrain: (x: number, y: number) => number
): (roomName: string, x: number, y: number) => number {
  return (_roomName: string, x: number, y: number) => terrain(x, y);
}

/**
 * Converts a distance Map to a 2D array for easier testing/visualization.
 * Only extracts distances for the specified room.
 *
 * @param distances - Multi-room distance map
 * @param roomName - Room to extract (default: TEST_ROOM)
 * @returns 2D array [x][y] = distance
 */
export function distanceMapToArray(
  distances: Map<string, number>,
  roomName: string = TEST_ROOM
): number[][] {
  const grid: number[][] = [];
  for (let x = 0; x < 50; x++) {
    grid[x] = [];
    for (let y = 0; y < 50; y++) {
      grid[x][y] = distances.get(`${roomName}:${x},${y}`) ?? 0;
    }
  }
  return grid;
}

/**
 * Gets distance at a specific position from a multi-room distance map.
 *
 * @param distances - Multi-room distance map
 * @param x - X coordinate
 * @param y - Y coordinate
 * @param roomName - Room name (default: TEST_ROOM)
 */
export function getDistance(
  distances: Map<string, number>,
  x: number,
  y: number,
  roomName: string = TEST_ROOM
): number {
  return distances.get(`${roomName}:${x},${y}`) ?? 0;
}
