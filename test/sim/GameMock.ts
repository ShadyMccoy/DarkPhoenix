/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Lightweight Game Mock for Fast Unit Testing
 *
 * This provides a minimal mock of the Screeps Game API
 * for testing individual functions without a full server.
 */

// Type stubs matching Screeps API
type StructureConstant = string;
type ResourceConstant = string;
type BodyPartConstant = string;

interface MockPosition {
  x: number;
  y: number;
  roomName: string;
}

// Use any for store to avoid index signature conflicts
type MockStore = any;

interface MockCreep {
  id: string;
  name: string;
  pos: MockPosition;
  room: MockRoom;
  body: { type: BodyPartConstant; hits: number }[];
  store: MockStore;
  fatigue: number;
  hits: number;
  hitsMax: number;
  memory: Record<string, unknown>;
  spawning: boolean;
  ticksToLive: number;

  // Methods
  move(direction: number): number;
  moveTo(target: MockPosition | { pos: MockPosition }): number;
  harvest(target: MockSource): number;
  transfer(target: MockStructure, resource: ResourceConstant): number;
  withdraw(target: MockStructure, resource: ResourceConstant): number;
  pickup(target: MockResource): number;
  build(target: MockConstructionSite): number;
  repair(target: MockStructure): number;
  upgradeController(target: MockController): number;
  say(message: string): void;
}

interface MockStructure {
  id: string;
  pos: MockPosition;
  structureType: StructureConstant;
  hits: number;
  hitsMax: number;
  room: MockRoom;
  store?: MockStore;
}

interface MockSource {
  id: string;
  pos: MockPosition;
  energy: number;
  energyCapacity: number;
  room: MockRoom;
  ticksToRegeneration: number;
}

interface MockResource {
  id: string;
  pos: MockPosition;
  resourceType: ResourceConstant;
  amount: number;
  room: MockRoom;
}

interface MockController {
  id: string;
  pos: MockPosition;
  level: number;
  progress: number;
  progressTotal: number;
  room: MockRoom;
  ticksToDowngrade: number;
}

interface MockConstructionSite {
  id: string;
  pos: MockPosition;
  structureType: StructureConstant;
  progress: number;
  progressTotal: number;
  room: MockRoom;
}

interface MockSpawn {
  id: string;
  name: string;
  pos: MockPosition;
  room: MockRoom;
  store: MockStore;
  spawning: { name: string; remainingTime: number } | null;

  spawnCreep(body: BodyPartConstant[], name: string, opts?: { memory?: Record<string, unknown> }): number;
}

interface MockRoom {
  name: string;
  controller?: MockController;
  energyAvailable: number;
  energyCapacityAvailable: number;
  memory: Record<string, unknown>;

  find<T>(type: number, opts?: { filter?: (obj: T) => boolean }): T[];
  lookAt(x: number, y: number): { type: string; [key: string]: unknown }[];
  lookForAt<T>(type: string, x: number, y: number): T[];
  createConstructionSite(x: number, y: number, structureType: StructureConstant): number;
}

interface MockGame {
  time: number;
  cpu: { limit: number; tickLimit: number; bucket: number; getUsed(): number };
  creeps: Record<string, MockCreep>;
  rooms: Record<string, MockRoom>;
  spawns: Record<string, MockSpawn>;
  structures: Record<string, MockStructure>;
  constructionSites: Record<string, MockConstructionSite>;
  gcl: { level: number; progress: number; progressTotal: number };
  map: {
    getRoomTerrain(roomName: string): { get(x: number, y: number): number };
    describeExits(roomName: string): Record<string, string>;
  };
  market: Record<string, unknown>;
  getObjectById<T>(id: string): T | null;
  notify(message: string): void;
}

interface MockMemory {
  creeps: Record<string, Record<string, unknown>>;
  rooms: Record<string, Record<string, unknown>>;
  spawns: Record<string, Record<string, unknown>>;
  flags: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

// Mock implementations
function createMockStore(capacity: number, initial: Record<string, number> = {}): MockStore {
  const store: Record<string, any> = { ...initial };
  const totalCapacity = capacity;

  store.getCapacity = () => totalCapacity;
  store.getFreeCapacity = () => {
    const used = Object.entries(store)
      .filter(([k]) => typeof store[k] === 'number')
      .reduce((a, [, v]) => a + (v as number), 0);
    return totalCapacity - used;
  };
  store.getUsedCapacity = () =>
    Object.entries(store)
      .filter(([k]) => typeof store[k] === 'number')
      .reduce((a, [, v]) => a + (v as number), 0);

  return store;
}

function createMockCreep(
  id: string,
  name: string,
  pos: MockPosition,
  body: BodyPartConstant[],
  room: MockRoom
): MockCreep {
  return {
    id,
    name,
    pos,
    room,
    body: body.map((type) => ({ type, hits: 100 })),
    store: createMockStore(body.filter((b) => b === 'carry').length * 50),
    fatigue: 0,
    hits: body.length * 100,
    hitsMax: body.length * 100,
    memory: {},
    spawning: false,
    ticksToLive: 1500,

    move: () => 0,
    moveTo: () => 0,
    harvest: () => 0,
    transfer: () => 0,
    withdraw: () => 0,
    pickup: () => 0,
    build: () => 0,
    repair: () => 0,
    upgradeController: () => 0,
    say: () => {},
  };
}

function createMockRoom(name: string): MockRoom {
  const objects: Record<string, unknown[]> = {};

  return {
    name,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    memory: {},

    find: <T>(type: number, opts?: { filter?: (obj: T) => boolean }): T[] => {
      const result = (objects[type] || []) as T[];
      return opts?.filter ? result.filter(opts.filter) : result;
    },
    lookAt: () => [],
    lookForAt: () => [],
    createConstructionSite: () => 0,
  };
}

function createMockSpawn(name: string, room: MockRoom): MockSpawn {
  return {
    id: `spawn_${name}`,
    name,
    pos: { x: 25, y: 25, roomName: room.name },
    room,
    store: createMockStore(300, { energy: 300 }),
    spawning: null,

    spawnCreep: () => 0,
  };
}

/**
 * Create a complete mock game environment
 */
export function createMockGame(config: {
  rooms?: string[];
  tick?: number;
} = {}): { Game: MockGame; Memory: MockMemory } {
  const rooms: Record<string, MockRoom> = {};
  const spawns: Record<string, MockSpawn> = {};
  const creeps: Record<string, MockCreep> = {};
  const structures: Record<string, MockStructure> = {};
  const constructionSites: Record<string, MockConstructionSite> = {};

  // Create rooms
  for (const roomName of config.rooms || ['W0N0']) {
    const room = createMockRoom(roomName);
    rooms[roomName] = room;

    // Add a spawn to the first room
    if (Object.keys(spawns).length === 0) {
      const spawn = createMockSpawn('Spawn1', room);
      spawns['Spawn1'] = spawn;
      room.controller = {
        id: `controller_${roomName}`,
        pos: { x: 20, y: 20, roomName },
        level: 1,
        progress: 0,
        progressTotal: 200,
        room,
        ticksToDowngrade: 20000,
      };
    }
  }

  const Game: MockGame = {
    time: config.tick || 1,
    cpu: {
      limit: 20,
      tickLimit: 500,
      bucket: 10000,
      getUsed: () => 0.5,
    },
    creeps,
    rooms,
    spawns,
    structures,
    constructionSites,
    gcl: { level: 1, progress: 0, progressTotal: 1000 },
    map: {
      getRoomTerrain: () => ({
        get: () => 0,
      }),
      describeExits: () => ({}),
    },
    market: {},
    getObjectById: <T>(id: string): T | null => {
      // Search all object collections
      if (creeps[id]) return creeps[id] as unknown as T;
      if (structures[id]) return structures[id] as unknown as T;
      if (spawns[id]) return spawns[id] as unknown as T;
      return null;
    },
    notify: () => {},
  };

  const Memory: MockMemory = {
    creeps: {},
    rooms: {},
    spawns: {},
    flags: {},
  };

  return { Game, Memory };
}

/**
 * Helper to add a creep to the mock game
 */
export function addMockCreep(
  game: MockGame,
  memory: MockMemory,
  config: {
    name: string;
    room: string;
    body: BodyPartConstant[];
    pos?: { x: number; y: number };
    memory?: Record<string, unknown>;
  }
): MockCreep {
  const room = game.rooms[config.room];
  if (!room) throw new Error(`Room ${config.room} not found`);

  const creep = createMockCreep(
    `creep_${config.name}`,
    config.name,
    { x: config.pos?.x || 25, y: config.pos?.y || 25, roomName: config.room },
    config.body,
    room
  );

  creep.memory = config.memory || {};
  game.creeps[config.name] = creep;
  memory.creeps[config.name] = creep.memory;

  return creep;
}

// Export FIND constants for compatibility
export const FIND = {
  FIND_CREEPS: 101,
  FIND_MY_CREEPS: 102,
  FIND_HOSTILE_CREEPS: 103,
  FIND_SOURCES_ACTIVE: 104,
  FIND_SOURCES: 105,
  FIND_DROPPED_RESOURCES: 106,
  FIND_STRUCTURES: 107,
  FIND_MY_STRUCTURES: 108,
  FIND_HOSTILE_STRUCTURES: 109,
  FIND_FLAGS: 110,
  FIND_CONSTRUCTION_SITES: 111,
  FIND_MY_SPAWNS: 112,
  FIND_HOSTILE_SPAWNS: 113,
  FIND_MY_CONSTRUCTION_SITES: 114,
  FIND_HOSTILE_CONSTRUCTION_SITES: 115,
  FIND_MINERALS: 116,
  FIND_NUKES: 117,
  FIND_TOMBSTONES: 118,
  FIND_POWER_CREEPS: 119,
  FIND_MY_POWER_CREEPS: 120,
  FIND_HOSTILE_POWER_CREEPS: 121,
  FIND_DEPOSITS: 122,
  FIND_RUINS: 123,
};

export const OK = 0;
export const ERR_NOT_OWNER = -1;
export const ERR_NO_PATH = -2;
export const ERR_NAME_EXISTS = -3;
export const ERR_BUSY = -4;
export const ERR_NOT_FOUND = -5;
export const ERR_NOT_ENOUGH_ENERGY = -6;
export const ERR_NOT_ENOUGH_RESOURCES = -6;
export const ERR_INVALID_TARGET = -7;
export const ERR_FULL = -8;
export const ERR_NOT_IN_RANGE = -9;
export const ERR_INVALID_ARGS = -10;
export const ERR_TIRED = -11;
export const ERR_NO_BODYPART = -12;
export const ERR_NOT_ENOUGH_EXTENSIONS = -6;
export const ERR_RCL_NOT_ENOUGH = -14;
export const ERR_GCL_NOT_ENOUGH = -15;
