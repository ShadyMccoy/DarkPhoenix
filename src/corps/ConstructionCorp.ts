/**
 * @fileoverview ConstructionCorp - Manages builder creeps and extension placement.
 *
 * The ConstructionCorp builds extensions to increase spawn capacity.
 * It only invests in construction when there's accumulated profit,
 * ensuring the economy is stable before expanding.
 *
 * Extension placement strategy (for now):
 * - Place extensions along walls where there's still room to path
 * - Avoid blocking important paths (near spawns, sources, controller)
 *
 * @module corps/ConstructionCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position, createOfferId } from "../market/Offer";
import {
  BUILDER_BODY,
  BUILDER_COST,
  MAX_BUILDERS,
  SPAWN_COOLDOWN,
  MIN_CONSTRUCTION_PROFIT,
} from "./CorpConstants";

/** Base value per energy for construction */
const BASE_ENERGY_VALUE = 0.3;

/** Urgency multiplier when we have active construction sites */
const ACTIVE_CONSTRUCTION_URGENCY = 1.5;

/** Urgency multiplier when builder has no energy */
const STARVATION_URGENCY_MULTIPLIER = 2.0;

/**
 * Serialized state specific to ConstructionCorp
 */
export interface SerializedConstructionCorp extends SerializedCorp {
  spawnId: string;
  creepNames: string[];
  lastSpawnAttempt: number;
  lastPlacementAttempt: number;
}

/**
 * Extension limits by controller level (RCL 1-8)
 * RCL 1: 0, RCL 2: 5, RCL 3: 10, RCL 4: 20, RCL 5: 30, RCL 6: 40, RCL 7: 50, RCL 8: 60
 */
const EXTENSION_LIMITS: { [rcl: number]: number } = {
  1: 0,
  2: 5,
  3: 10,
  4: 20,
  5: 30,
  6: 40,
  7: 50,
  8: 60,
};

/**
 * How often to attempt placing new construction sites (ticks)
 */
const PLACEMENT_COOLDOWN = 100;

/**
 * ConstructionCorp manages builder creeps that construct extensions.
 *
 * Builders:
 * - Pick up energy from spawn area
 * - Build construction sites
 * - Only spawned when there's profit and construction to do
 */
export class ConstructionCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** Names of creeps owned by this corp */
  private creepNames: string[] = [];

  /** Last tick we attempted to spawn */
  private lastSpawnAttempt: number = 0;

  /** Last tick we attempted to place extensions */
  private lastPlacementAttempt: number = 0;

  constructor(nodeId: string, spawnId: string) {
    super("building", nodeId);
    this.spawnId = spawnId;
  }

  /**
   * Construction corp doesn't sell anything - it's a pure consumer
   */
  sells(): Offer[] {
    return [];
  }

  /**
   * Construction corp buys delivered energy with priority-based bidding.
   * Lower priority than upgrading (base value 0.3 vs 0.5).
   */
  buys(): Offer[] {
    const activeCreeps = this.creepNames.filter(n => Game.creeps[n]).length;
    if (activeCreeps === 0) return [];

    // Check if there's construction to do
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return [];

    const constructionSites = spawn.room.find(FIND_MY_CONSTRUCTION_SITES);
    if (constructionSites.length === 0) return [];

    // Calculate urgency based on:
    // 1. Active construction sites
    // 2. Builder energy levels
    const urgency = this.calculateUrgency();

    // Calculate how much energy we need
    const energyDeficit = this.creepNames.reduce((sum, name) => {
      const creep = Game.creeps[name];
      return sum + (creep ? creep.store.getFreeCapacity(RESOURCE_ENERGY) : 0);
    }, 0);

    if (energyDeficit === 0) return [];

    // Bid price = base value × urgency
    const bidPrice = BASE_ENERGY_VALUE * urgency;

    return [{
      id: createOfferId(this.id, "delivered-energy", Game.time),
      corpId: this.id,
      type: "buy",
      resource: "delivered-energy",
      quantity: energyDeficit,
      price: bidPrice,
      duration: 100,
      location: this.getPosition()
    }];
  }

  /**
   * Calculate urgency multiplier for bidding.
   */
  private calculateUrgency(): number {
    let urgency = 1.0;

    // Check for active construction
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      const sites = spawn.room.find(FIND_MY_CONSTRUCTION_SITES);
      if (sites.length > 0) {
        urgency *= ACTIVE_CONSTRUCTION_URGENCY;
      }
    }

    // Check builder energy levels
    const totalEnergy = this.creepNames.reduce((sum, name) => {
      const creep = Game.creeps[name];
      return sum + (creep ? creep.store[RESOURCE_ENERGY] : 0);
    }, 0);

    const totalCapacity = this.creepNames.reduce((sum, name) => {
      const creep = Game.creeps[name];
      return sum + (creep ? creep.store.getCapacity() : 0);
    }, 0);

    if (totalCapacity > 0 && totalEnergy / totalCapacity < 0.2) {
      urgency *= STARVATION_URGENCY_MULTIPLIER;
    }

    return urgency;
  }

  /**
   * Get the spawn position as the corp's location.
   */
  getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  /**
   * Main work loop - manage extensions and run builders.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    // Clean up dead creeps
    this.creepNames = this.creepNames.filter((name) => Game.creeps[name]);

    // Get spawn
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) {
      return;
    }

    const room = spawn.room;
    const controller = room.controller;
    if (!controller) {
      return;
    }

    // Check if we can build more extensions
    const rcl = controller.level;
    const maxExtensions = EXTENSION_LIMITS[rcl] || 0;
    const currentExtensions = room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_EXTENSION,
    }).length;
    const constructionSites = room.find(FIND_MY_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_EXTENSION,
    });

    const canBuildMore = currentExtensions + constructionSites.length < maxExtensions;

    // Try to place new extension sites if we have profit and room for more
    if (canBuildMore && this.balance >= MIN_CONSTRUCTION_PROFIT) {
      this.tryPlaceExtension(room, spawn, tick);
    }

    // Only spawn builders if there's construction to do
    const hasConstruction = constructionSites.length > 0;
    if (hasConstruction && this.creepNames.length < MAX_BUILDERS) {
      this.trySpawn(spawn, tick);
    }

    // Run builder behavior
    for (const name of this.creepNames) {
      const creep = Game.creeps[name];
      if (creep && !creep.spawning) {
        this.runBuilder(creep, room);
      }
    }
  }

  /**
   * Try to place a new extension construction site along walls.
   */
  private tryPlaceExtension(room: Room, spawn: StructureSpawn, tick: number): void {
    if (tick - this.lastPlacementAttempt < PLACEMENT_COOLDOWN) {
      return;
    }
    this.lastPlacementAttempt = tick;

    // Find a suitable position along walls
    const pos = this.findWallAdjacentPosition(room, spawn);
    if (!pos) {
      return;
    }

    // Create construction site
    const result = room.createConstructionSite(pos.x, pos.y, STRUCTURE_EXTENSION);
    if (result === OK) {
      // Pay for the construction site placement (investment)
      this.recordCost(100); // Investment cost for planning
      console.log(`[Construction] Placed extension site at (${pos.x}, ${pos.y})`);
    }
  }

  /**
   * Find a position adjacent to walls but still accessible.
   * Strategy: Find tiles that are next to walls but have enough open neighbors for pathing.
   */
  private findWallAdjacentPosition(room: Room, spawn: StructureSpawn): { x: number; y: number } | null {
    const terrain = room.getTerrain();
    const candidates: { x: number; y: number; score: number }[] = [];

    // Get positions to avoid (too close to important structures)
    const avoidPositions = new Set<string>();

    // Avoid tiles near spawn (within 2 tiles)
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        avoidPositions.add(`${spawn.pos.x + dx},${spawn.pos.y + dy}`);
      }
    }

    // Avoid tiles near sources
    const sources = room.find(FIND_SOURCES);
    for (const source of sources) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          avoidPositions.add(`${source.pos.x + dx},${source.pos.y + dy}`);
        }
      }
    }

    // Avoid tiles near controller
    if (room.controller) {
      for (let dx = -3; dx <= 3; dx++) {
        for (let dy = -3; dy <= 3; dy++) {
          avoidPositions.add(`${room.controller.pos.x + dx},${room.controller.pos.y + dy}`);
        }
      }
    }

    // Get existing structures and construction sites to avoid
    const structures = room.find(FIND_STRUCTURES);
    const sites = room.find(FIND_CONSTRUCTION_SITES);
    for (const s of structures) {
      avoidPositions.add(`${s.pos.x},${s.pos.y}`);
    }
    for (const s of sites) {
      avoidPositions.add(`${s.pos.x},${s.pos.y}`);
    }

    // Scan the room for wall-adjacent positions
    for (let x = 2; x < 48; x++) {
      for (let y = 2; y < 48; y++) {
        // Skip walls and swamps for now
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
          continue;
        }

        // Skip avoided positions
        if (avoidPositions.has(`${x},${y}`)) {
          continue;
        }

        // Count adjacent walls and open tiles
        let adjacentWalls = 0;
        let openNeighbors = 0;

        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;

            if (terrain.get(nx, ny) === TERRAIN_MASK_WALL) {
              adjacentWalls++;
            } else {
              openNeighbors++;
            }
          }
        }

        // We want positions that are:
        // 1. Adjacent to at least one wall (score bonus)
        // 2. Have at least 3 open neighbors (for pathing)
        if (adjacentWalls >= 1 && openNeighbors >= 3) {
          // Score: prefer more wall-adjacent (tucked in) but still accessible
          const distToSpawn = Math.max(
            Math.abs(x - spawn.pos.x),
            Math.abs(y - spawn.pos.y)
          );
          // Prefer closer to spawn but not too close
          const score = adjacentWalls * 10 - Math.abs(distToSpawn - 5);
          candidates.push({ x, y, score });
        }
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    // Sort by score and pick the best
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  /**
   * Attempt to spawn a new builder creep.
   */
  private trySpawn(spawn: StructureSpawn, tick: number): void {
    if (tick - this.lastSpawnAttempt < SPAWN_COOLDOWN) {
      return;
    }

    if (spawn.spawning) {
      return;
    }

    if (spawn.store[RESOURCE_ENERGY] < BUILDER_COST) {
      return;
    }

    const name = `builder-${spawn.room.name}-${tick}`;

    const result = spawn.spawnCreep(BUILDER_BODY, name, {
      memory: {
        corpId: this.id,
        workType: "build",
        working: false,
      },
    });

    this.lastSpawnAttempt = tick;

    if (result === OK) {
      this.creepNames.push(name);
      this.recordCost(BUILDER_COST);
      console.log(`[Construction] Spawned ${name}`);
    }
  }

  /**
   * Run behavior for a builder creep.
   *
   * State machine:
   * - If empty: pick up energy from spawn area
   * - If carrying: build construction sites
   */
  private runBuilder(creep: Creep, room: Room): void {
    // State transition
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.working = false;
      creep.say("pickup");
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
      creep.say("build");
    }

    if (creep.memory.working) {
      // Build construction sites
      this.doBuild(creep, room);
    } else {
      // Pick up energy
      this.doPickup(creep, room);
    }
  }

  /**
   * Build the nearest construction site.
   */
  private doBuild(creep: Creep, room: Room): void {
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length === 0) {
      // No construction to do - idle near spawn
      const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
      if (spawn && creep.pos.getRangeTo(spawn) > 3) {
        creep.moveTo(spawn, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // Find the closest construction site
    const target = creep.pos.findClosestByPath(sites);
    if (!target) return;

    const result = creep.build(target);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
    } else if (result === OK) {
      // Track energy consumed (5 energy per WORK part per tick for building)
      const workParts = creep.getActiveBodyparts(WORK);
      this.recordConsumption(workParts * 5);
      // Track production: build progress points generated (5 per WORK)
      this.recordProduction(workParts * 5);
      // Revenue is recorded through market transactions
    }
  }

  /**
   * Pick up energy from spawn area or dropped resources.
   */
  private doPickup(creep: Creep, room: Room): void {
    // First try dropped energy
    const dropped = room.find(FIND_DROPPED_RESOURCES, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 50,
    });

    if (dropped.length > 0) {
      const target = creep.pos.findClosestByPath(dropped);
      if (target) {
        if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
        }
        return;
      }
    }

    // Try to withdraw from spawn/extensions that are full
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn && spawn.store[RESOURCE_ENERGY] >= 200) {
      if (creep.withdraw(spawn, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(spawn, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // Wait near spawn for energy
    if (spawn && creep.pos.getRangeTo(spawn) > 3) {
      creep.moveTo(spawn, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
  }

  /**
   * Get number of active builder creeps.
   */
  getCreepCount(): number {
    return this.creepNames.filter((n) => Game.creeps[n]).length;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedConstructionCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      creepNames: this.creepNames,
      lastSpawnAttempt: this.lastSpawnAttempt,
      lastPlacementAttempt: this.lastPlacementAttempt,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedConstructionCorp): void {
    super.deserialize(data);
    this.creepNames = data.creepNames || [];
    this.lastSpawnAttempt = data.lastSpawnAttempt || 0;
    this.lastPlacementAttempt = data.lastPlacementAttempt || 0;
  }
}

/**
 * Create a ConstructionCorp for a room.
 */
export function createConstructionCorp(
  room: Room,
  spawn: StructureSpawn
): ConstructionCorp {
  const nodeId = `${room.name}-construction`;
  return new ConstructionCorp(nodeId, spawn.id);
}
