/**
 * @fileoverview ConstructionCorp - Auxiliary corp for building infrastructure.
 *
 * The ConstructionCorp builds extensions to increase spawn capacity.
 * It only invests in construction when there's accumulated profit,
 * ensuring the economy is stable before expanding.
 *
 * @module corps/ConstructionCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Position } from "../types/Position";
import {
  MAX_BUILDERS,
  MIN_CONSTRUCTION_PROFIT,
} from "./CorpConstants";
import { BODY_PART_COST } from "../planning/EconomicConstants";
import { SinkAllocation } from "../flow/FlowTypes";

/**
 * Serialized state specific to ConstructionCorp
 */
export interface SerializedConstructionCorp extends SerializedCorp {
  spawnId: string;
  lastPlacementAttempt: number;
  targetBuilders: number;
  /** Flow-based construction allocations (from FlowEconomy) */
  constructionAllocations?: SinkAllocation[];
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
 */
export class ConstructionCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** Last tick we attempted to place extensions */
  private lastPlacementAttempt: number = 0;

  /** Target number of builders (computed during planning) */
  private targetBuilders: number = 0;

  /**
   * Flow-based construction allocations from FlowEconomy.
   * Each allocation specifies energy for a construction site.
   */
  private constructionAllocations: SinkAllocation[] = [];

  constructor(nodeId: string, spawnId: string, customId?: string) {
    super("building", nodeId, customId);
    this.spawnId = spawnId;
  }

  /**
   * Get active creeps assigned to this corp.
   */
  private getActiveCreeps(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id && creep.memory.workType === "build" && !creep.spawning) {
        creeps.push(creep);
      }
    }
    return creeps;
  }

  /**
   * Plan construction operations.
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

    const totalWorkRemaining = constructionSites.reduce((sum, site) => {
      return sum + (site.progressTotal - site.progress);
    }, 0);

    const buildersNeeded = Math.min(MAX_BUILDERS, Math.ceil(totalWorkRemaining / 50000));
    this.targetBuilders = Math.max(1, buildersNeeded);
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
   * Main work loop - run builder creeps.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    const room = spawn.room;
    const controller = room.controller;
    if (!controller) return;

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

    if (canBuildMore && this.balance >= MIN_CONSTRUCTION_PROFIT) {
      this.tryPlaceExtension(room, spawn, tick);
    }

    const creeps = this.getActiveCreeps();
    for (const creep of creeps) {
      this.runBuilder(creep, room);
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

    for (const s of spawns) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          avoidPositions.add(`${s.pos.x + dx},${s.pos.y + dy}`);
        }
      }
    }

    const sources = room.find(FIND_SOURCES);
    for (const source of sources) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          avoidPositions.add(`${source.pos.x + dx},${source.pos.y + dy}`);
        }
      }
    }

    if (room.controller) {
      for (let dx = -3; dx <= 3; dx++) {
        for (let dy = -3; dy <= 3; dy++) {
          avoidPositions.add(`${room.controller.pos.x + dx},${room.controller.pos.y + dy}`);
        }
      }
    }

    const structures = room.find(FIND_STRUCTURES);
    const sites = room.find(FIND_CONSTRUCTION_SITES);
    for (const s of structures) {
      avoidPositions.add(`${s.pos.x},${s.pos.y}`);
    }
    for (const s of sites) {
      avoidPositions.add(`${s.pos.x},${s.pos.y}`);
    }

    for (let x = 2; x < 48; x++) {
      for (let y = 2; y < 48; y++) {
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        if (avoidPositions.has(`${x},${y}`)) continue;

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
   * Get number of active builder creeps.
   */
  getCreepCount(): number {
    return this.getActiveCreeps().length;
  }

  // ===========================================================================
  // FLOW INTEGRATION
  // ===========================================================================

  /**
   * Set construction allocations from FlowEconomy.
   * Each allocation specifies energy rate for a construction site.
   */
  setConstructionAllocations(allocations: SinkAllocation[]): void {
    this.constructionAllocations = allocations;
    // Adjust target builders based on total allocated energy
    const totalAllocated = allocations.reduce((sum, a) => sum + a.allocated, 0);
    // Each builder with ~2 WORK parts builds at ~10 energy/tick
    const workPerBuilder = 10;
    this.targetBuilders = Math.min(MAX_BUILDERS, Math.max(1, Math.ceil(totalAllocated / workPerBuilder)));
  }

  /**
   * Get all construction allocations.
   */
  getConstructionAllocations(): SinkAllocation[] {
    return this.constructionAllocations;
  }

  /**
   * Check if this corp has flow-based allocations.
   */
  hasFlowAllocations(): boolean {
    return this.constructionAllocations.length > 0;
  }

  /**
   * Get total allocated energy rate for construction.
   */
  getTotalAllocatedEnergy(): number {
    return this.constructionAllocations.reduce((sum, a) => sum + a.allocated, 0);
  }

  /**
   * Get the highest priority construction site (from flow allocations).
   */
  getHighestPriorityAllocation(): SinkAllocation | undefined {
    if (this.constructionAllocations.length === 0) return undefined;
    return this.constructionAllocations.reduce((best, curr) =>
      curr.priority > best.priority ? curr : best
    );
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
      constructionAllocations: this.constructionAllocations.length > 0 ? this.constructionAllocations : undefined,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedConstructionCorp): void {
    super.deserialize(data);
    this.lastPlacementAttempt = data.lastPlacementAttempt || 0;
    this.targetBuilders = data.targetBuilders || 0;
    this.constructionAllocations = data.constructionAllocations ?? [];
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
