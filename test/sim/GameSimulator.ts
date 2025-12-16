/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @fileoverview GameSimulator - Full simulation environment for testing.
 *
 * This provides a complete mock of the Screeps Game API that can simulate
 * tick-by-tick game execution, including:
 * - Sources that regenerate and can be harvested
 * - Creeps that can move, harvest, transfer, build, upgrade
 * - Spawns that can spawn creeps
 * - Controllers that can be upgraded
 * - Energy tracking throughout the system
 *
 * @module test/sim/GameSimulator
 */

// ============================================================================
// Constants (matching Screeps API)
// ============================================================================

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

export const FIND_CREEPS = 101;
export const FIND_MY_CREEPS = 102;
export const FIND_SOURCES = 105;
export const FIND_SOURCES_ACTIVE = 104;
export const FIND_DROPPED_RESOURCES = 106;
export const FIND_STRUCTURES = 107;
export const FIND_MY_STRUCTURES = 108;
export const FIND_MY_SPAWNS = 112;
export const FIND_CONSTRUCTION_SITES = 111;
export const FIND_MY_CONSTRUCTION_SITES = 114;

export const LOOK_TERRAIN = "terrain";
export const LOOK_CREEPS = "creeps";
export const LOOK_STRUCTURES = "structures";
export const LOOK_CONSTRUCTION_SITES = "constructionSites";
export const LOOK_ENERGY = "energy";

export const RESOURCE_ENERGY = "energy";

export const STRUCTURE_SPAWN = "spawn";
export const STRUCTURE_CONTAINER = "container";
export const STRUCTURE_EXTENSION = "extension";
export const STRUCTURE_CONTROLLER = "controller";

export const BODYPART_COST: Record<string, number> = {
  move: 50,
  work: 100,
  carry: 50,
  attack: 80,
  ranged_attack: 150,
  heal: 250,
  claim: 600,
  tough: 10,
};

// ============================================================================
// Types
// ============================================================================

type BodyPartConstant = string;
type ResourceConstant = string;
type StructureConstant = string;

interface SimPosition {
  x: number;
  y: number;
  roomName: string;
}

// ============================================================================
// SimStore - Tracks resources
// ============================================================================

class SimStore {
  private contents: Map<string, number> = new Map();
  private _capacity: number;

  constructor(capacity: number, initial: Record<string, number> = {}) {
    this._capacity = capacity;
    for (const [resource, amount] of Object.entries(initial)) {
      this.contents.set(resource, amount);
    }
  }

  getCapacity(resource?: string): number {
    if (resource) {
      // For specific resource, return total capacity (simplified)
      return this._capacity;
    }
    return this._capacity;
  }

  getUsedCapacity(resource?: string): number {
    if (resource) {
      return this.contents.get(resource) || 0;
    }
    let total = 0;
    for (const amount of this.contents.values()) {
      total += amount;
    }
    return total;
  }

  getFreeCapacity(resource?: string): number {
    return this._capacity - this.getUsedCapacity(resource);
  }

  get energy(): number {
    return this.contents.get(RESOURCE_ENERGY) || 0;
  }

  set energy(value: number) {
    this.contents.set(RESOURCE_ENERGY, value);
  }

  add(resource: string, amount: number): number {
    const current = this.contents.get(resource) || 0;
    const free = this.getFreeCapacity();
    const toAdd = Math.min(amount, free);
    this.contents.set(resource, current + toAdd);
    return toAdd;
  }

  remove(resource: string, amount: number): number {
    const current = this.contents.get(resource) || 0;
    const toRemove = Math.min(amount, current);
    this.contents.set(resource, current - toRemove);
    return toRemove;
  }
}

// ============================================================================
// SimRoomPosition
// ============================================================================

class SimRoomPosition implements SimPosition {
  x: number;
  y: number;
  roomName: string;

  constructor(x: number, y: number, roomName: string) {
    this.x = x;
    this.y = y;
    this.roomName = roomName;
  }

  getRangeTo(target: SimPosition | { pos: SimPosition }): number {
    const pos = "pos" in target ? target.pos : target;
    return Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y));
  }

  isNearTo(target: SimPosition | { pos: SimPosition }): boolean {
    return this.getRangeTo(target) <= 1;
  }

  lookFor(type: string): any[] {
    // This will be filled by the room
    return [];
  }
}

// ============================================================================
// SimSource
// ============================================================================

class SimSource {
  id: string;
  pos: SimRoomPosition;
  energy: number;
  energyCapacity: number;
  room: SimRoom;
  ticksToRegeneration: number;

  constructor(id: string, pos: SimRoomPosition, room: SimRoom) {
    this.id = id;
    this.pos = pos;
    this.room = room;
    this.energy = 3000;
    this.energyCapacity = 3000;
    this.ticksToRegeneration = 300;
  }

  harvest(amount: number): number {
    const harvested = Math.min(amount, this.energy);
    this.energy -= harvested;
    return harvested;
  }

  tick(): void {
    if (this.energy < this.energyCapacity) {
      this.ticksToRegeneration--;
      if (this.ticksToRegeneration <= 0) {
        this.energy = this.energyCapacity;
        this.ticksToRegeneration = 300;
      }
    }
  }
}

// ============================================================================
// SimController
// ============================================================================

class SimController {
  id: string;
  pos: SimRoomPosition;
  level: number;
  progress: number;
  progressTotal: number;
  room: SimRoom;
  ticksToDowngrade: number;
  my: boolean;

  constructor(id: string, pos: SimRoomPosition, room: SimRoom) {
    this.id = id;
    this.pos = pos;
    this.room = room;
    this.level = 1;
    this.progress = 0;
    this.progressTotal = 200; // RCL 1 -> 2
    this.ticksToDowngrade = 20000;
    this.my = true;
  }

  addProgress(amount: number): void {
    this.progress += amount;
    if (this.progress >= this.progressTotal) {
      this.level++;
      this.progress = 0;
      // Set new progress total based on RCL
      const progressByLevel: Record<number, number> = {
        2: 45000,
        3: 135000,
        4: 405000,
        5: 1215000,
        6: 3645000,
        7: 10935000,
        8: Infinity,
      };
      this.progressTotal = progressByLevel[this.level] || 200;
    }
  }
}

// ============================================================================
// SimSpawn
// ============================================================================

class SimSpawn {
  id: string;
  name: string;
  pos: SimRoomPosition;
  room: SimRoom;
  store: SimStore;
  spawning: { name: string; remainingTime: number } | null = null;
  structureType = STRUCTURE_SPAWN;
  hits = 5000;
  hitsMax = 5000;
  my = true;

  private simulator: GameSimulator;

  constructor(
    id: string,
    name: string,
    pos: SimRoomPosition,
    room: SimRoom,
    simulator: GameSimulator
  ) {
    this.id = id;
    this.name = name;
    this.pos = pos;
    this.room = room;
    this.store = new SimStore(300, { energy: 300 });
    this.simulator = simulator;
  }

  spawnCreep(
    body: BodyPartConstant[],
    name: string,
    opts?: { memory?: Record<string, unknown> }
  ): number {
    if (this.spawning) {
      return ERR_BUSY;
    }

    // Calculate cost
    const cost = body.reduce((sum, part) => sum + (BODYPART_COST[part] || 0), 0);
    if (this.store.energy < cost) {
      return ERR_NOT_ENOUGH_ENERGY;
    }

    // Check name uniqueness
    if (this.simulator.Game.creeps[name]) {
      return ERR_NAME_EXISTS;
    }

    // Start spawning
    this.store.energy -= cost;
    this.spawning = {
      name,
      remainingTime: body.length * 3, // 3 ticks per body part
    };

    // Queue creep creation
    this.simulator.queueSpawn(this, name, body, opts?.memory || {});

    return OK;
  }

  tick(): void {
    if (this.spawning) {
      this.spawning.remainingTime--;
      if (this.spawning.remainingTime <= 0) {
        this.simulator.completeSpawn(this);
        this.spawning = null;
      }
    }
  }
}

// ============================================================================
// SimCreep
// ============================================================================

class SimCreep {
  id: string;
  name: string;
  pos: SimRoomPosition;
  room: SimRoom;
  body: { type: BodyPartConstant; hits: number }[];
  store: SimStore;
  fatigue: number = 0;
  hits: number;
  hitsMax: number;
  memory: Record<string, unknown>;
  spawning: boolean = false;
  ticksToLive: number = 1500;
  my = true;

  private simulator: GameSimulator;
  private harvestedThisTick = false;
  private transferredThisTick = false;

  constructor(
    id: string,
    name: string,
    pos: SimRoomPosition,
    room: SimRoom,
    body: BodyPartConstant[],
    memory: Record<string, unknown>,
    simulator: GameSimulator
  ) {
    this.id = id;
    this.name = name;
    this.pos = pos;
    this.room = room;
    this.body = body.map((type) => ({ type, hits: 100 }));
    this.memory = memory;
    this.simulator = simulator;

    // Calculate capacity based on CARRY parts
    const carryParts = body.filter((b) => b === "carry").length;
    this.store = new SimStore(carryParts * 50);

    this.hits = body.length * 100;
    this.hitsMax = body.length * 100;
  }

  getActiveBodyparts(type: string): number {
    return this.body.filter((p) => p.type === type && p.hits > 0).length;
  }

  move(direction: number): number {
    if (this.fatigue > 0) return ERR_TIRED;
    // Simplified movement - just reduce fatigue calc for now
    return OK;
  }

  moveTo(target: SimPosition | { pos: SimPosition }, opts?: any): number {
    if (this.fatigue > 0) return ERR_TIRED;

    const pos = "pos" in target ? target.pos : target;

    // Simple movement: move one step closer
    const dx = Math.sign(pos.x - this.pos.x);
    const dy = Math.sign(pos.y - this.pos.y);

    this.pos = new SimRoomPosition(
      this.pos.x + dx,
      this.pos.y + dy,
      this.pos.roomName
    );

    // Calculate fatigue based on terrain and body
    const moveParts = this.getActiveBodyparts("move");
    const weight =
      this.body.filter((p) => p.type !== "move" && p.type !== "carry").length +
      Math.ceil(this.store.getUsedCapacity() / 50);
    this.fatigue = Math.max(0, (weight - moveParts) * 2);

    return OK;
  }

  harvest(target: SimSource): number {
    if (this.harvestedThisTick) return ERR_BUSY;
    if (this.pos.getRangeTo(target) > 1) return ERR_NOT_IN_RANGE;
    if (this.store.getFreeCapacity() === 0) return ERR_FULL;

    const workParts = this.getActiveBodyparts("work");
    if (workParts === 0) return ERR_NO_BODYPART;

    const harvestAmount = workParts * 2; // 2 energy per WORK part
    const harvested = target.harvest(harvestAmount);
    this.store.add(RESOURCE_ENERGY, harvested);

    this.harvestedThisTick = true;
    return OK;
  }

  transfer(target: SimSpawn | SimCreep, resource: ResourceConstant, amount?: number): number {
    if (this.transferredThisTick) return ERR_BUSY;
    if (this.pos.getRangeTo(target) > 1) return ERR_NOT_IN_RANGE;

    const available = this.store.getUsedCapacity(resource);
    if (available === 0) return ERR_NOT_ENOUGH_RESOURCES;

    const targetFree = target.store.getFreeCapacity(resource);
    if (targetFree === 0) return ERR_FULL;

    const toTransfer = Math.min(amount || available, available, targetFree);
    this.store.remove(resource, toTransfer);
    target.store.add(resource, toTransfer);

    this.transferredThisTick = true;
    return OK;
  }

  withdraw(target: { store: SimStore }, resource: ResourceConstant, amount?: number): number {
    if (this.pos.getRangeTo(target as any) > 1) return ERR_NOT_IN_RANGE;

    const available = target.store.getUsedCapacity(resource);
    if (available === 0) return ERR_NOT_ENOUGH_RESOURCES;

    const free = this.store.getFreeCapacity();
    if (free === 0) return ERR_FULL;

    const toWithdraw = Math.min(amount || available, available, free);
    target.store.remove(resource, toWithdraw);
    this.store.add(resource, toWithdraw);

    return OK;
  }

  pickup(target: SimDroppedResource): number {
    if (this.pos.getRangeTo(target) > 1) return ERR_NOT_IN_RANGE;

    const free = this.store.getFreeCapacity();
    if (free === 0) return ERR_FULL;

    const toPickup = Math.min(target.amount, free);
    this.store.add(target.resourceType, toPickup);
    target.amount -= toPickup;

    return OK;
  }

  upgradeController(target: SimController): number {
    if (this.pos.getRangeTo(target) > 3) return ERR_NOT_IN_RANGE;

    const workParts = this.getActiveBodyparts("work");
    if (workParts === 0) return ERR_NO_BODYPART;

    const energy = this.store.getUsedCapacity(RESOURCE_ENERGY);
    if (energy === 0) return ERR_NOT_ENOUGH_RESOURCES;

    const toUpgrade = Math.min(workParts, energy);
    this.store.remove(RESOURCE_ENERGY, toUpgrade);
    target.addProgress(toUpgrade);

    return OK;
  }

  build(target: SimConstructionSite): number {
    if (this.pos.getRangeTo(target) > 3) return ERR_NOT_IN_RANGE;

    const workParts = this.getActiveBodyparts("work");
    if (workParts === 0) return ERR_NO_BODYPART;

    const energy = this.store.getUsedCapacity(RESOURCE_ENERGY);
    if (energy === 0) return ERR_NOT_ENOUGH_RESOURCES;

    const toBuild = Math.min(workParts * 5, energy);
    this.store.remove(RESOURCE_ENERGY, toBuild);
    target.progress += toBuild;

    return OK;
  }

  repair(target: any): number {
    return OK;
  }

  say(message: string): void {
    // Console log for debugging
    // console.log(`[${this.name}] ${message}`);
  }

  dismantle(target: any): number {
    return OK;
  }

  tick(): void {
    this.ticksToLive--;
    this.fatigue = Math.max(0, this.fatigue - 2);
    this.harvestedThisTick = false;
    this.transferredThisTick = false;
  }
}

// ============================================================================
// SimDroppedResource
// ============================================================================

class SimDroppedResource {
  id: string;
  pos: SimRoomPosition;
  resourceType: ResourceConstant;
  amount: number;
  room: SimRoom;

  constructor(
    id: string,
    pos: SimRoomPosition,
    resourceType: ResourceConstant,
    amount: number,
    room: SimRoom
  ) {
    this.id = id;
    this.pos = pos;
    this.resourceType = resourceType;
    this.amount = amount;
    this.room = room;
  }
}

// ============================================================================
// SimConstructionSite
// ============================================================================

class SimConstructionSite {
  id: string;
  pos: SimRoomPosition;
  structureType: StructureConstant;
  progress: number;
  progressTotal: number;
  room: SimRoom;
  my = true;

  constructor(
    id: string,
    pos: SimRoomPosition,
    structureType: StructureConstant,
    room: SimRoom
  ) {
    this.id = id;
    this.pos = pos;
    this.structureType = structureType;
    this.room = room;
    this.progress = 0;
    // Progress totals by structure type
    const progressByType: Record<string, number> = {
      container: 5000,
      extension: 3000,
      road: 300,
      wall: 1,
      rampart: 1,
    };
    this.progressTotal = progressByType[structureType] || 5000;
  }

  isComplete(): boolean {
    return this.progress >= this.progressTotal;
  }
}

// ============================================================================
// SimRoom
// ============================================================================

class SimRoom {
  name: string;
  controller: SimController | undefined;
  memory: Record<string, unknown>;

  private sources: SimSource[] = [];
  private spawns: SimSpawn[] = [];
  private creeps: SimCreep[] = [];
  private droppedResources: SimDroppedResource[] = [];
  private constructionSites: SimConstructionSite[] = [];
  private terrain: number[][] = [];

  private simulator: GameSimulator;

  constructor(name: string, simulator: GameSimulator) {
    this.name = name;
    this.memory = {};
    this.simulator = simulator;

    // Initialize terrain (0 = plain, 1 = wall, 2 = swamp)
    for (let y = 0; y < 50; y++) {
      this.terrain[y] = [];
      for (let x = 0; x < 50; x++) {
        // Border walls
        if (x === 0 || x === 49 || y === 0 || y === 49) {
          this.terrain[y][x] = 1;
        } else {
          this.terrain[y][x] = 0;
        }
      }
    }
  }

  get energyAvailable(): number {
    let energy = 0;
    for (const spawn of this.spawns) {
      energy += spawn.store.energy;
    }
    return energy;
  }

  get energyCapacityAvailable(): number {
    return this.spawns.length * 300; // Just spawns for now
  }

  addSource(x: number, y: number): SimSource {
    const id = `source_${this.name}_${this.sources.length}`;
    const pos = new SimRoomPosition(x, y, this.name);
    const source = new SimSource(id, pos, this);
    this.sources.push(source);
    return source;
  }

  addSpawn(name: string, x: number, y: number): SimSpawn {
    const id = `spawn_${name}`;
    const pos = new SimRoomPosition(x, y, this.name);
    const spawn = new SimSpawn(id, name, pos, this, this.simulator);
    this.spawns.push(spawn);
    return spawn;
  }

  addController(x: number, y: number): SimController {
    const id = `controller_${this.name}`;
    const pos = new SimRoomPosition(x, y, this.name);
    this.controller = new SimController(id, pos, this);
    return this.controller;
  }

  addCreep(creep: SimCreep): void {
    this.creeps.push(creep);
  }

  removeCreep(creep: SimCreep): void {
    const idx = this.creeps.indexOf(creep);
    if (idx !== -1) {
      this.creeps.splice(idx, 1);
    }
  }

  addConstructionSite(x: number, y: number, structureType: StructureConstant): number {
    const id = `site_${this.name}_${Date.now()}_${Math.random()}`;
    const pos = new SimRoomPosition(x, y, this.name);
    const site = new SimConstructionSite(id, pos, structureType, this);
    this.constructionSites.push(site);
    return OK;
  }

  find<T>(type: number, opts?: { filter?: (obj: T) => boolean }): T[] {
    let result: any[] = [];

    switch (type) {
      case FIND_SOURCES:
      case FIND_SOURCES_ACTIVE:
        result = this.sources.filter((s) => type === FIND_SOURCES || s.energy > 0);
        break;
      case FIND_MY_SPAWNS:
        result = this.spawns;
        break;
      case FIND_MY_CREEPS:
      case FIND_CREEPS:
        result = this.creeps.filter((c) => !c.spawning);
        break;
      case FIND_DROPPED_RESOURCES:
        result = this.droppedResources;
        break;
      case FIND_CONSTRUCTION_SITES:
      case FIND_MY_CONSTRUCTION_SITES:
        result = this.constructionSites;
        break;
      case FIND_STRUCTURES:
      case FIND_MY_STRUCTURES:
        result = [...this.spawns];
        break;
    }

    if (opts?.filter) {
      result = result.filter(opts.filter as any);
    }

    return result as T[];
  }

  lookAt(x: number, y: number): { type: string; [key: string]: unknown }[] {
    const results: { type: string; [key: string]: unknown }[] = [];

    // Terrain
    results.push({ type: LOOK_TERRAIN, terrain: this.getTerrainAt(x, y) });

    // Creeps
    for (const creep of this.creeps) {
      if (creep.pos.x === x && creep.pos.y === y) {
        results.push({ type: LOOK_CREEPS, creep });
      }
    }

    return results;
  }

  lookForAt<T>(type: string, x: number, y: number): T[] {
    const results: any[] = [];

    switch (type) {
      case LOOK_TERRAIN:
        results.push(this.getTerrainAt(x, y));
        break;
      case LOOK_CREEPS:
        for (const creep of this.creeps) {
          if (creep.pos.x === x && creep.pos.y === y) {
            results.push(creep);
          }
        }
        break;
      case LOOK_ENERGY:
        for (const resource of this.droppedResources) {
          if (
            resource.pos.x === x &&
            resource.pos.y === y &&
            resource.resourceType === RESOURCE_ENERGY
          ) {
            results.push(resource);
          }
        }
        break;
      case LOOK_STRUCTURES:
        for (const spawn of this.spawns) {
          if (spawn.pos.x === x && spawn.pos.y === y) {
            results.push(spawn);
          }
        }
        break;
      case LOOK_CONSTRUCTION_SITES:
        for (const site of this.constructionSites) {
          if (site.pos.x === x && site.pos.y === y) {
            results.push(site);
          }
        }
        break;
    }

    return results as T[];
  }

  lookForAtArea(
    type: string,
    top: number,
    left: number,
    bottom: number,
    right: number,
    asArray: boolean
  ): any[] {
    const results: any[] = [];

    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        if (type === LOOK_TERRAIN) {
          results.push({
            x,
            y,
            terrain: this.getTerrainAt(x, y),
          });
        }
      }
    }

    return results;
  }

  getTerrainAt(x: number, y: number): string {
    const t = this.terrain[y]?.[x] ?? 0;
    if (t === 1) return "wall";
    if (t === 2) return "swamp";
    return "plain";
  }

  setTerrain(x: number, y: number, type: "plain" | "wall" | "swamp"): void {
    const value = type === "wall" ? 1 : type === "swamp" ? 2 : 0;
    if (this.terrain[y]) {
      this.terrain[y][x] = value;
    }
  }

  createConstructionSite(x: number, y: number, structureType: StructureConstant): number {
    return this.addConstructionSite(x, y, structureType);
  }

  tick(): void {
    // Tick sources
    for (const source of this.sources) {
      source.tick();
    }

    // Tick spawns
    for (const spawn of this.spawns) {
      spawn.tick();
    }

    // Tick creeps
    for (const creep of this.creeps) {
      creep.tick();
    }

    // Remove dead creeps
    this.creeps = this.creeps.filter((c) => c.ticksToLive > 0);

    // Remove depleted dropped resources
    this.droppedResources = this.droppedResources.filter((r) => r.amount > 0);

    // Check completed construction sites
    this.constructionSites = this.constructionSites.filter((s) => !s.isComplete());
  }

  getSources(): SimSource[] {
    return this.sources;
  }

  getSpawns(): SimSpawn[] {
    return this.spawns;
  }

  getCreeps(): SimCreep[] {
    return this.creeps;
  }
}

// ============================================================================
// GameSimulator
// ============================================================================

export class GameSimulator {
  Game: {
    time: number;
    cpu: { limit: number; tickLimit: number; bucket: number; getUsed: () => number };
    creeps: Record<string, SimCreep>;
    rooms: Record<string, SimRoom>;
    spawns: Record<string, SimSpawn>;
    structures: Record<string, any>;
    constructionSites: Record<string, SimConstructionSite>;
    gcl: { level: number; progress: number; progressTotal: number };
    map: {
      getRoomTerrain: (roomName: string) => { get: (x: number, y: number) => number };
      describeExits: (roomName: string) => Record<string, string>;
    };
    market: Record<string, unknown>;
    getObjectById: <T>(id: string) => T | null;
    notify: (message: string) => void;
  };

  Memory: {
    creeps: Record<string, Record<string, unknown>>;
    rooms: Record<string, Record<string, unknown>>;
    spawns: Record<string, Record<string, unknown>>;
    flags: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  };

  private pendingSpawns: Map<
    SimSpawn,
    { name: string; body: BodyPartConstant[]; memory: Record<string, unknown> }
  > = new Map();

  private objectsById: Map<string, any> = new Map();

  constructor() {
    this.Game = {
      time: 1,
      cpu: {
        limit: 20,
        tickLimit: 500,
        bucket: 10000,
        getUsed: () => 0.5,
      },
      creeps: {},
      rooms: {},
      spawns: {},
      structures: {},
      constructionSites: {},
      gcl: { level: 1, progress: 0, progressTotal: 1000 },
      map: {
        getRoomTerrain: () => ({ get: () => 0 }),
        describeExits: () => ({}),
      },
      market: {},
      getObjectById: <T>(id: string): T | null => {
        return this.objectsById.get(id) || null;
      },
      notify: () => {},
    };

    this.Memory = {
      creeps: {},
      rooms: {},
      spawns: {},
      flags: {},
    };
  }

  /**
   * Creates a room with the specified configuration.
   */
  createRoom(
    name: string,
    config: {
      sources?: Array<{ x: number; y: number }>;
      spawn?: { name: string; x: number; y: number };
      controller?: { x: number; y: number };
    } = {}
  ): SimRoom {
    const room = new SimRoom(name, this);
    this.Game.rooms[name] = room;
    this.Memory.rooms[name] = {};

    // Add controller
    if (config.controller) {
      const controller = room.addController(config.controller.x, config.controller.y);
      this.objectsById.set(controller.id, controller);
    }

    // Add spawn
    if (config.spawn) {
      const spawn = room.addSpawn(config.spawn.name, config.spawn.x, config.spawn.y);
      this.Game.spawns[config.spawn.name] = spawn;
      this.objectsById.set(spawn.id, spawn);
    }

    // Add sources
    if (config.sources) {
      for (const sourceConfig of config.sources) {
        const source = room.addSource(sourceConfig.x, sourceConfig.y);
        this.objectsById.set(source.id, source);
      }
    }

    return room;
  }

  /**
   * Queues a spawn (called by SimSpawn.spawnCreep)
   */
  queueSpawn(
    spawn: SimSpawn,
    name: string,
    body: BodyPartConstant[],
    memory: Record<string, unknown>
  ): void {
    this.pendingSpawns.set(spawn, { name, body, memory });
  }

  /**
   * Completes a spawn (called by SimSpawn.tick when spawning finishes)
   */
  completeSpawn(spawn: SimSpawn): void {
    const data = this.pendingSpawns.get(spawn);
    if (!data) return;

    const { name, body, memory } = data;
    const pos = new SimRoomPosition(spawn.pos.x, spawn.pos.y, spawn.room.name);
    const creep = new SimCreep(
      `creep_${name}`,
      name,
      pos,
      spawn.room,
      body,
      memory,
      this
    );

    spawn.room.addCreep(creep);
    this.Game.creeps[name] = creep;
    this.Memory.creeps[name] = memory;
    this.objectsById.set(creep.id, creep);

    this.pendingSpawns.delete(spawn);
  }

  /**
   * Advances the simulation by one tick.
   */
  tick(): void {
    this.Game.time++;

    // Tick all rooms
    for (const room of Object.values(this.Game.rooms)) {
      room.tick();
    }

    // Clean up dead creeps
    for (const [name, creep] of Object.entries(this.Game.creeps)) {
      if (creep.ticksToLive <= 0) {
        delete this.Game.creeps[name];
        delete this.Memory.creeps[name];
        this.objectsById.delete(creep.id);
      }
    }
  }

  /**
   * Runs simulation for multiple ticks with callback.
   */
  runTicks(
    count: number,
    onTick?: (tick: number) => void
  ): void {
    for (let i = 0; i < count; i++) {
      this.tick();
      if (onTick) {
        onTick(this.Game.time);
      }
    }
  }

  /**
   * Installs globals for testing (Game, Memory, constants, etc.)
   */
  installGlobals(): void {
    (global as any).Game = this.Game;
    (global as any).Memory = this.Memory;
    (global as any).RoomPosition = SimRoomPosition;

    // Install constants
    (global as any).OK = OK;
    (global as any).ERR_NOT_OWNER = ERR_NOT_OWNER;
    (global as any).ERR_NO_PATH = ERR_NO_PATH;
    (global as any).ERR_NAME_EXISTS = ERR_NAME_EXISTS;
    (global as any).ERR_BUSY = ERR_BUSY;
    (global as any).ERR_NOT_FOUND = ERR_NOT_FOUND;
    (global as any).ERR_NOT_ENOUGH_ENERGY = ERR_NOT_ENOUGH_ENERGY;
    (global as any).ERR_NOT_ENOUGH_RESOURCES = ERR_NOT_ENOUGH_RESOURCES;
    (global as any).ERR_INVALID_TARGET = ERR_INVALID_TARGET;
    (global as any).ERR_FULL = ERR_FULL;
    (global as any).ERR_NOT_IN_RANGE = ERR_NOT_IN_RANGE;
    (global as any).ERR_INVALID_ARGS = ERR_INVALID_ARGS;
    (global as any).ERR_TIRED = ERR_TIRED;
    (global as any).ERR_NO_BODYPART = ERR_NO_BODYPART;

    (global as any).FIND_CREEPS = FIND_CREEPS;
    (global as any).FIND_MY_CREEPS = FIND_MY_CREEPS;
    (global as any).FIND_SOURCES = FIND_SOURCES;
    (global as any).FIND_SOURCES_ACTIVE = FIND_SOURCES_ACTIVE;
    (global as any).FIND_DROPPED_RESOURCES = FIND_DROPPED_RESOURCES;
    (global as any).FIND_STRUCTURES = FIND_STRUCTURES;
    (global as any).FIND_MY_STRUCTURES = FIND_MY_STRUCTURES;
    (global as any).FIND_MY_SPAWNS = FIND_MY_SPAWNS;
    (global as any).FIND_CONSTRUCTION_SITES = FIND_CONSTRUCTION_SITES;
    (global as any).FIND_MY_CONSTRUCTION_SITES = FIND_MY_CONSTRUCTION_SITES;

    (global as any).LOOK_TERRAIN = LOOK_TERRAIN;
    (global as any).LOOK_CREEPS = LOOK_CREEPS;
    (global as any).LOOK_STRUCTURES = LOOK_STRUCTURES;
    (global as any).LOOK_CONSTRUCTION_SITES = LOOK_CONSTRUCTION_SITES;
    (global as any).LOOK_ENERGY = LOOK_ENERGY;

    (global as any).RESOURCE_ENERGY = RESOURCE_ENERGY;

    (global as any).STRUCTURE_SPAWN = STRUCTURE_SPAWN;
    (global as any).STRUCTURE_CONTAINER = STRUCTURE_CONTAINER;
    (global as any).STRUCTURE_EXTENSION = STRUCTURE_EXTENSION;
    (global as any).STRUCTURE_CONTROLLER = STRUCTURE_CONTROLLER;

    (global as any).BODYPART_COST = BODYPART_COST;

    // Body part constants
    (global as any).WORK = "work";
    (global as any).CARRY = "carry";
    (global as any).MOVE = "move";
    (global as any).ATTACK = "attack";
    (global as any).RANGED_ATTACK = "ranged_attack";
    (global as any).HEAL = "heal";
    (global as any).CLAIM = "claim";
    (global as any).TOUGH = "tough";

    // Install lodash as _ (used by routines)
    (global as any)._ = require("lodash");

    // Install RoomVisual stub
    (global as any).RoomVisual = class {
      line() {
        return this;
      }
    };
  }
}

/**
 * Factory to create a simulator with a standard room setup.
 */
export function createStandardSimulator(): GameSimulator {
  const sim = new GameSimulator();

  sim.createRoom("W0N0", {
    controller: { x: 25, y: 35 },
    spawn: { name: "Spawn1", x: 25, y: 25 },
    sources: [
      { x: 15, y: 15 },
      { x: 35, y: 15 },
    ],
  });

  return sim;
}
