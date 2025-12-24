/**
 * @fileoverview ConstructionCorp - Auxiliary corp for building infrastructure.
 *
 * The ConstructionCorp builds extensions to increase spawn capacity.
 * It only invests in construction when there's accumulated profit,
 * ensuring the economy is stable before expanding.
 *
 * NOTE: This is an auxiliary corp - it participates in the market for
 * creep spawning (buys work-ticks) but does NOT participate in the
 * main energy->RCL production chain planned by ChainPlanner.
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
import { CREEP_LIFETIME, BODY_PART_COST } from "../planning/EconomicConstants";
import { CreepSpec } from "../market/Contract";
import {
  Contract,
  isActive,
  canRequestCreep,
  requestCreep,
  replacementsNeeded
} from "../market/Contract";
import { getMarket } from "../market/Market";

/** Base value per energy for construction (higher than upgrading to prioritize finishing builds) */
const BASE_ENERGY_VALUE = 0.6;

/**
 * Serialized state specific to ConstructionCorp
 */
export interface SerializedConstructionCorp extends SerializedCorp {
  spawnId: string;
  lastPlacementAttempt: number;
  targetBuilders: number;
}

/**
 * Extension limits by controller level (RCL 1-8)
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
 * This corp:
 * - Buys work-ticks from SpawningCorp via contracts
 * - Places extension construction sites when profitable
 * - Builds structures to improve spawn capacity
 * - Revenue is internal (infrastructure value), not sold to other corps
 */
export class ConstructionCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** Last tick we attempted to place extensions */
  private lastPlacementAttempt: number = 0;

  /** Target number of builders (computed during planning) */
  private targetBuilders: number = 0;

  constructor(nodeId: string, spawnId: string) {
    super("building", nodeId);
    this.spawnId = spawnId;
  }

  /**
   * Get active creeps assigned to this corp from contracts.
   * Reads from buy contracts where we purchased spawning capacity.
   */
  private getActiveCreeps(): Creep[] {
    const market = getMarket();
    const creeps: Creep[] = [];
    const seen = new Set<string>();

    for (const localContract of this.contracts) {
      if (localContract.buyerId !== this.id) continue;
      if (localContract.resource !== "spawning") continue;
      if (!isActive(localContract, Game.time)) continue;

      const contract = market.getContract(localContract.id) ?? localContract;
      for (const creepName of contract.creepIds) {
        if (seen.has(creepName)) continue;
        seen.add(creepName);

        const creep = Game.creeps[creepName];
        if (creep && !creep.spawning) {
          creeps.push(creep);
        }
      }
    }

    return creeps;
  }

  /**
   * Construction corp doesn't sell anything - it's a pure consumer.
   * Infrastructure value is internal, not traded to other corps.
   */
  sells(): Offer[] {
    return [];
  }

  /**
   * Plan construction operations. Called periodically to compute targets.
   * Determines how many builders are needed based on construction sites.
   */
  plan(tick: number): void {
    super.plan(tick);

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) {
      this.targetBuilders = 0;
      return;
    }

    const constructionSites = spawn.room.find(FIND_MY_CONSTRUCTION_SITES);
    if (constructionSites.length === 0) {
      this.targetBuilders = 0;
      return;
    }

    // Calculate total work remaining
    const totalWorkRemaining = constructionSites.reduce((sum, site) => {
      return sum + (site.progressTotal - site.progress);
    }, 0);

    // Roughly 1 builder per 50k work remaining, capped at MAX_BUILDERS
    const buildersNeeded = Math.min(MAX_BUILDERS, Math.ceil(totalWorkRemaining / 50000));
    this.targetBuilders = Math.max(1, buildersNeeded);
  }

  /**
   * Construction corp buys spawning capacity (builder creeps) via the market.
   */
  buys(): Offer[] {
    if (this.targetBuilders === 0) return [];

    // Count current active builders from contracts
    const currentBuilders = this.getCreepCount();

    // Request 1 builder if below target
    if (currentBuilders < this.targetBuilders) {
      // Builder body: 2 WORK + 2 CARRY + 2 MOVE = 400 energy
      const builderWorkParts = 2;
      const builderEnergyCost = builderWorkParts * (BODY_PART_COST.work + BODY_PART_COST.carry + BODY_PART_COST.move);
      const pricePerEnergy = BASE_ENERGY_VALUE * 2 * (1 + this.getMargin());

      const creepSpec: CreepSpec = {
        role: "builder",
        workParts: builderWorkParts
      };

      return [{
        id: createOfferId(this.id, "spawning", Game.time),
        corpId: this.id,
        type: "buy",
        resource: "spawning",
        quantity: builderEnergyCost,
        price: pricePerEnergy * builderEnergyCost,
        duration: CREEP_LIFETIME,
        location: this.getPosition(),
        creepSpec
      }];
    }

    return [];
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
   * @deprecated Use execute() for contract-driven execution
   */
  work(tick: number): void {
    this.execute(this.contracts, tick);
  }

  /**
   * Execute work to fulfill contracts.
   * Contracts drive the work - creeps assigned to contracts do building.
   */
  execute(contracts: Contract[], tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    const room = spawn.room;
    const controller = room.controller;
    if (!controller) return;

    const market = getMarket();

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

    // Get buy contracts for spawning (we buy from SpawningCorp)
    const buyContracts = contracts.filter(
      c => c.buyerId === this.id && c.resource === "spawning" && isActive(c, tick)
    );

    // Execute building for creeps assigned to our buy contracts
    for (const contract of buyContracts) {
      const marketContract = market.getContract(contract.id) ?? contract;

      // Request creeps using the option mechanism
      this.requestCreepsForContract(marketContract);

      for (const creepName of marketContract.creepIds) {
        const creep = Game.creeps[creepName];
        if (creep && !creep.spawning) {
          this.runBuilder(creep, room);
        }
      }
    }
  }

  /**
   * Request creeps from a spawn contract using the option mechanism.
   */
  private requestCreepsForContract(contract: Contract): void {
    if (contract.creepIds.length === 0 && canRequestCreep(contract)) {
      requestCreep(contract);
      return;
    }

    const numReplacements = replacementsNeeded(contract, (creepId) => {
      const creep = Game.creeps[creepId];
      return creep?.ticksToLive;
    });

    for (let i = 0; i < numReplacements; i++) {
      if (!requestCreep(contract)) break;
    }
  }

  /**
   * Try to place a new extension construction site.
   */
  private tryPlaceExtension(room: Room, spawn: StructureSpawn, tick: number): void {
    if (tick - this.lastPlacementAttempt < PLACEMENT_COOLDOWN) {
      return;
    }
    this.lastPlacementAttempt = tick;

    const pos = this.findWallAdjacentPosition(room, spawn);
    if (!pos) {
      return;
    }

    const result = room.createConstructionSite(pos.x, pos.y, STRUCTURE_EXTENSION);
    if (result === OK) {
      this.recordCost(100);
      console.log(`[Construction] Placed extension site at (${pos.x}, ${pos.y})`);
    }
  }

  /**
   * Find a position near spawns that is accessible.
   */
  private findWallAdjacentPosition(room: Room, spawn: StructureSpawn): { x: number; y: number } | null {
    const terrain = room.getTerrain();
    const candidates: { x: number; y: number; score: number }[] = [];

    const spawns = room.find(FIND_MY_SPAWNS);
    const avoidPositions = new Set<string>();

    // Avoid tiles immediately adjacent to spawns
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
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        if (avoidPositions.has(`${x},${y}`)) continue;

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

        if (openNeighbors < 3) continue;

        // Calculate distance to nearest spawn
        let minDistToSpawn = Infinity;
        for (const s of spawns) {
          const dist = Math.max(Math.abs(x - s.pos.x), Math.abs(y - s.pos.y));
          minDistToSpawn = Math.min(minDistToSpawn, dist);
        }

        if (minDistToSpawn < 2 || minDistToSpawn > 8) continue;

        const score = 100 - minDistToSpawn * 10;
        candidates.push({ x, y, score });
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  /**
   * Run behavior for a builder creep.
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
      this.doBuild(creep, room);
    } else {
      this.doPickup(creep, room);
    }
  }

  /**
   * Build the nearest construction site.
   */
  private doBuild(creep: Creep, room: Room): void {
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length === 0) {
      const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
      if (spawn && creep.pos.getRangeTo(spawn) > 3) {
        creep.moveTo(spawn, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    const target = creep.pos.findClosestByPath(sites);
    if (!target) return;

    const result = creep.build(target);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
    } else if (result === OK) {
      const workParts = creep.getActiveBodyparts(WORK);
      this.recordConsumption(workParts * 5);
      this.recordProduction(workParts * 5);
    }
  }

  /**
   * Pick up energy from spawn area or dropped resources.
   */
  private doPickup(creep: Creep, room: Room): void {
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

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn && spawn.store[RESOURCE_ENERGY] >= 200) {
      if (creep.withdraw(spawn, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(spawn, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    if (spawn && creep.pos.getRangeTo(spawn) > 3) {
      creep.moveTo(spawn, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
  }

  /**
   * Get number of active builder creeps from contracts.
   */
  getCreepCount(): number {
    return this.getActiveCreeps().length;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedConstructionCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      lastPlacementAttempt: this.lastPlacementAttempt,
      targetBuilders: this.targetBuilders,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedConstructionCorp): void {
    super.deserialize(data);
    this.lastPlacementAttempt = data.lastPlacementAttempt || 0;
    this.targetBuilders = data.targetBuilders || 0;
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
