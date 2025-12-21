/**
 * @fileoverview ConstructionCorp - Manages builder creeps and extension placement.
 *
 * The ConstructionCorp builds extensions to increase spawn capacity.
 * It only invests in construction when there's accumulated profit,
 * ensuring the economy is stable before expanding.
 *
 * Extension placement strategy:
 * - Place extensions close to spawns (2-8 tiles away)
 * - Keep the immediate spawn area (1 tile) clear for creep movement
 * - Avoid blocking important paths (near sources, controller)
 *
 * @module corps/ConstructionCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position, createOfferId } from "../market/Offer";
import {
  MAX_BUILDERS,
  MIN_CONSTRUCTION_PROFIT,
} from "./CorpConstants";
import { CREEP_LIFETIME } from "../planning/EconomicConstants";

/** Base value per energy for construction (higher than upgrading to prioritize finishing builds) */
const BASE_ENERGY_VALUE = 0.6;

/**
 * Serialized state specific to ConstructionCorp
 */
export interface SerializedConstructionCorp extends SerializedCorp {
  spawnId: string;
  creepNames: string[];
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
   * Construction corp buys work-ticks (builder creeps) via the market.
   * Only requests builders when there's construction work to do.
   *
   * SIMPLIFIED LOGIC:
   * - Only request 1 creep at a time (prevents over-ordering)
   * - Calculate need based on current creeps only (no commitment tracking)
   * - The market's natural capacity limiting handles throttling
   */
  buys(): Offer[] {
    const offers: Offer[] = [];

    // Check if there's construction to do
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return [];

    const constructionSites = spawn.room.find(FIND_MY_CONSTRUCTION_SITES);
    if (constructionSites.length === 0) return [];

    // Count current active builders
    const currentBuilders = this.creepNames.filter(name => Game.creeps[name]).length;

    // Simple logic: if we have fewer than MAX_BUILDERS, request exactly 1 more
    if (currentBuilders < MAX_BUILDERS) {
      // Request exactly 1 creep's worth of work-ticks
      const workTicksPerCreep = CREEP_LIFETIME; // 1 WORK part × lifetime

      // Price based on construction value (must be higher than SpawningCorp's ask)
      const pricePerWorkTick = BASE_ENERGY_VALUE * 2 * (1 + this.getMargin());

      offers.push({
        id: createOfferId(this.id, "work-ticks", Game.time),
        corpId: this.id,
        type: "buy",
        resource: "work-ticks",
        quantity: workTicksPerCreep,
        price: pricePerWorkTick * workTicksPerCreep,
        duration: CREEP_LIFETIME,
        location: this.getPosition()
      });
    }

    return offers;
  }

  /**
   * Scan for creeps that were spawned for this corp and add them to our roster.
   * Creeps are spawned by SpawningCorp with memory.corpId set to our ID.
   */
  private pickupAssignedCreeps(): void {
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (
        creep.memory.corpId === this.id &&
        !this.creepNames.includes(name)
      ) {
        this.creepNames.push(name);
        console.log(`[Construction] Picked up builder ${name}`);
      }
    }
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

    // Pick up newly assigned creeps (spawned by SpawningCorp with our corpId)
    this.pickupAssignedCreeps();

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
   * Find a position near spawns that is accessible.
   * Strategy: Place extensions close to spawns while maintaining pathability.
   */
  private findWallAdjacentPosition(room: Room, spawn: StructureSpawn): { x: number; y: number } | null {
    const terrain = room.getTerrain();
    const candidates: { x: number; y: number; score: number }[] = [];

    // Get all spawns in the room for clustering extensions near them
    const spawns = room.find(FIND_MY_SPAWNS);

    // Get positions to avoid (too close to important structures)
    const avoidPositions = new Set<string>();

    // Avoid tiles immediately adjacent to spawns (within 1 tile) to keep spawn area clear
    for (const s of spawns) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          avoidPositions.add(`${s.pos.x + dx},${s.pos.y + dy}`);
        }
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

    // Scan the room for positions near spawns
    for (let x = 2; x < 48; x++) {
      for (let y = 2; y < 48; y++) {
        // Skip walls
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
          continue;
        }

        // Skip avoided positions
        if (avoidPositions.has(`${x},${y}`)) {
          continue;
        }

        // Count open neighbors for pathing
        let openNeighbors = 0;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;

            if (terrain.get(nx, ny) !== TERRAIN_MASK_WALL) {
              openNeighbors++;
            }
          }
        }

        // Require at least 3 open neighbors for pathing
        if (openNeighbors < 3) {
          continue;
        }

        // Calculate distance to nearest spawn
        let minDistToSpawn = Infinity;
        for (const s of spawns) {
          const dist = Math.max(Math.abs(x - s.pos.x), Math.abs(y - s.pos.y));
          minDistToSpawn = Math.min(minDistToSpawn, dist);
        }

        // Only consider positions within reasonable distance of spawns (2-8 tiles)
        if (minDistToSpawn < 2 || minDistToSpawn > 8) {
          continue;
        }

        // Score: heavily prefer closer to spawn
        // Higher score = better position
        const score = 100 - minDistToSpawn * 10;
        candidates.push({ x, y, score });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    // Sort by score (highest first) and pick the best
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
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
      lastPlacementAttempt: this.lastPlacementAttempt,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedConstructionCorp): void {
    super.deserialize(data);
    this.creepNames = data.creepNames || [];
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
