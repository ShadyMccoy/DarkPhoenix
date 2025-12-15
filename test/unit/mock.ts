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
