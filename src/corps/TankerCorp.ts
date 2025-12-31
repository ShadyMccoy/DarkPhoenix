/**
 * @fileoverview TankerCorp - Manages tanker creeps that work within Nodes.
 *
 * Tankers are local distributors that:
 * - Pick up energy from any source within the node (containers, dropped, storage, links)
 * - Deliver energy to sinks within the node (extensions, spawns, towers)
 * - Work reactively based on what needs filling
 *
 * Unlike Haulers (which follow fixed edge routes), Tankers are intelligent
 * and prioritize based on what needs energy most urgently.
 *
 * Tanker requirements are modeled per-node based on:
 * - Number of extensions/spawns to fill
 * - Average distance within the node
 * - Spawn rate (how fast energy drains)
 *
 * @module corps/TankerCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Position } from "../types/Position";
import { CREEP_LIFETIME } from "../planning/EconomicConstants";

/**
 * Demand modeling for tanker requirements.
 * Used to calculate how many CARRY parts the node needs.
 */
export interface TankerDemand {
  /** Number of extensions in the node */
  extensionCount: number;
  /** Number of spawns in the node */
  spawnCount: number;
  /** Number of towers in the node */
  towerCount: number;
  /** Average fill distance within the node */
  averageFillDistance: number;
  /** Estimated spawn rate (creeps per tick, ~0.01-0.05) */
  spawnRate: number;
  /** Energy consumption rate per tick */
  energyPerTick: number;
}

/**
 * Serialized state for TankerCorp persistence
 */
export interface SerializedTankerCorp extends SerializedCorp {
  spawnId: string;
  /** Node center position */
  nodeCenter: Position;
  /** Current demand model */
  demand?: TankerDemand;
  /** Required CARRY parts based on demand */
  requiredCarryParts: number;
}

/**
 * TankerCorp manages tanker creeps that distribute energy within a node.
 *
 * Tankers are smart local distributors. They look at all sources of energy
 * (containers, dropped, storage) and deliver to sinks (extensions, spawns, towers).
 */
export class TankerCorp extends Corp {
  private spawnId: string;
  private nodeCenter: Position;
  private demand: TankerDemand;
  private requiredCarryParts: number;

  /** Creeps we've already recorded expected production for (session-only) */
  private accountedCreeps: Set<string> = new Set();

  /** Rolling average of fill operations for reactive scaling */
  private fillOperationsPerTick: number = 0;
  private lastMeasureTick: number = 0;

  constructor(
    nodeId: string,
    spawnId: string,
    nodeCenter: Position,
    demand?: TankerDemand,
    customId?: string
  ) {
    super("hauling", nodeId, customId);
    this.spawnId = spawnId;
    this.nodeCenter = nodeCenter;
    this.demand = demand ?? {
      extensionCount: 0,
      spawnCount: 1,
      towerCount: 0,
      averageFillDistance: 5,
      spawnRate: 0.02,
      energyPerTick: 10,
    };
    this.requiredCarryParts = this.calculateRequiredCarryParts();
  }

  /**
   * Calculate required CARRY parts based on demand model.
   *
   * The formula considers:
   * - Energy throughput needed (extensions + spawns + towers)
   * - Round-trip time within the node
   * - Buffer for efficiency losses
   */
  private calculateRequiredCarryParts(): number {
    const { extensionCount, spawnCount, towerCount, averageFillDistance, energyPerTick } = this.demand;

    // Base energy throughput: spawn consumption + tower upkeep
    // Spawns consume ~10 energy/tick when actively spawning
    // Extensions need refilling after each spawn (~50 energy each)
    const structureCount = extensionCount + spawnCount + towerCount;

    // Round trip time for tanker operations
    const roundTrip = averageFillDistance * 2 + 2; // +2 for pickup/dropoff

    // Energy per round trip that needs to be moved
    const energyPerRoundTrip = energyPerTick * roundTrip;

    // Each CARRY part holds 50 energy
    const carryPartsNeeded = Math.ceil(energyPerRoundTrip / 50);

    // Add buffer for reactive capacity (20%) and minimum of 2 parts
    const withBuffer = Math.max(2, Math.ceil(carryPartsNeeded * 1.2));

    // Cap at reasonable maximum based on structure count
    const maxParts = Math.max(4, structureCount * 2);

    return Math.min(withBuffer, maxParts);
  }

  /**
   * Update demand model and recalculate requirements.
   * Called periodically to adjust to changing node conditions.
   */
  updateDemand(room: Room): void {
    const extensions = room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_EXTENSION,
    });
    const spawns = room.find(FIND_MY_SPAWNS);
    const towers = room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_TOWER,
    });

    // Calculate average distance from node center to structures
    const allStructures = [...extensions, ...spawns, ...towers];
    let totalDistance = 0;
    const centerPos = new RoomPosition(
      this.nodeCenter.x,
      this.nodeCenter.y,
      this.nodeCenter.roomName
    );

    for (const s of allStructures) {
      totalDistance += s.pos.getRangeTo(centerPos);
    }

    const avgDistance = allStructures.length > 0
      ? totalDistance / allStructures.length
      : 5;

    // Estimate spawn rate based on RCL and spawn count
    // RCL 1-2: ~0.01, RCL 3-4: ~0.02, RCL 5+: ~0.03
    const rcl = room.controller?.level ?? 1;
    const spawnRate = Math.min(0.05, 0.01 + rcl * 0.005);

    // Energy per tick: spawn consumption + tower consumption (when attacking/healing)
    // Base: ~10 energy/tick for spawning, towers can add up to 10 more each when active
    const energyPerTick = 10 + towers.length * 2; // Conservative estimate

    this.demand = {
      extensionCount: extensions.length,
      spawnCount: spawns.length,
      towerCount: towers.length,
      averageFillDistance: avgDistance,
      spawnRate,
      energyPerTick,
    };

    this.requiredCarryParts = this.calculateRequiredCarryParts();
  }

  /**
   * Get all tanker creeps assigned to this corp.
   */
  private getAssignedCreeps(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (
        creep.memory.corpId === this.id &&
        creep.memory.workType === "tank" &&
        !creep.spawning
      ) {
        creeps.push(creep);

        // Track expected production for new creeps
        if (!this.accountedCreeps.has(name)) {
          this.accountedCreeps.add(name);
          const carryCapacity = creep.store.getCapacity();
          // Estimate based on local round trips
          const roundTrip = this.demand.averageFillDistance * 2 + 4;
          const tripsPerLife = Math.floor(CREEP_LIFETIME / roundTrip);
          this.recordExpectedProduction(carryCapacity * tripsPerLife);
        }
      }
    }
    return creeps;
  }

  /**
   * Get position for this corp (node center).
   */
  getPosition(): Position {
    return this.nodeCenter;
  }

  /**
   * Main work loop - run tanker creeps.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    const room = spawn.room;
    const creeps = this.getAssignedCreeps();

    // Update demand model every 100 ticks
    if (tick - this.lastMeasureTick >= 100) {
      this.updateDemand(room);
      this.lastMeasureTick = tick;
    }

    for (const creep of creeps) {
      this.runTanker(creep, room);
    }
  }

  /**
   * Run a tanker creep - intelligent local distribution.
   *
   * States:
   * - working=false: Finding and picking up energy
   * - working=true: Delivering energy to structures
   */
  private runTanker(creep: Creep, room: Room): void {
    // State transitions
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.working = false;
      creep.say("collect");
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
      creep.say("fill");
    }

    if (creep.memory.working) {
      this.deliverEnergy(creep, room);
    } else {
      this.collectEnergy(creep, room);
    }
  }

  /**
   * Collect energy from sources within the node.
   *
   * Priority:
   * 1. Dropped energy (decays fastest)
   * 2. Tombstones/ruins (decay)
   * 3. Containers near storage/spawn area
   * 4. Storage
   * 5. Links (if configured as receivers)
   */
  private collectEnergy(creep: Creep, room: Room): void {
    // Priority 1: Dropped energy (anywhere in room, prioritize larger piles)
    const dropped = room.find(FIND_DROPPED_RESOURCES, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
    });

    if (dropped.length > 0) {
      // Sort by amount descending, then by distance
      dropped.sort((a, b) => {
        const amountDiff = b.amount - a.amount;
        if (Math.abs(amountDiff) > 100) return amountDiff;
        return creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b);
      });
      const target = dropped[0];
      if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // Priority 2: Tombstones with energy
    const tombstones = room.find(FIND_TOMBSTONES, {
      filter: (t) => t.store[RESOURCE_ENERGY] > 0,
    });

    if (tombstones.length > 0) {
      const target = creep.pos.findClosestByRange(tombstones);
      if (target && creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // Priority 3: Ruins with energy
    const ruins = room.find(FIND_RUINS, {
      filter: (r) => r.store[RESOURCE_ENERGY] > 0,
    });

    if (ruins.length > 0) {
      const target = creep.pos.findClosestByRange(ruins);
      if (target && creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // Priority 4: Containers with significant energy
    const containers = room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store[RESOURCE_ENERGY] >= 100,
    }) as StructureContainer[];

    if (containers.length > 0) {
      // Prefer containers with more energy
      containers.sort((a, b) => b.store[RESOURCE_ENERGY] - a.store[RESOURCE_ENERGY]);
      const target = containers[0];
      if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // Priority 5: Storage
    if (room.storage && room.storage.store[RESOURCE_ENERGY] > 0) {
      if (creep.withdraw(room.storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(room.storage, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // Priority 6: Links (receiver links near spawn/controller)
    const links = room.find(FIND_MY_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_LINK &&
        (s as StructureLink).store[RESOURCE_ENERGY] > 0,
    }) as StructureLink[];

    if (links.length > 0) {
      const target = creep.pos.findClosestByRange(links);
      if (target && creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // Nothing to collect - wait near node center
    const centerPos = new RoomPosition(
      this.nodeCenter.x,
      this.nodeCenter.y,
      this.nodeCenter.roomName
    );
    if (creep.pos.getRangeTo(centerPos) > 3) {
      creep.moveTo(centerPos, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
  }

  /**
   * Deliver energy to sinks within the node.
   *
   * Priority:
   * 1. Spawns (critical for creep production)
   * 2. Extensions (needed for larger creeps)
   * 3. Towers (defense/repair)
   * 4. Storage (buffer for later)
   */
  private deliverEnergy(creep: Creep, room: Room): void {
    // Opportunistic: pick up nearby dropped energy while delivering
    if (creep.store.getFreeCapacity() > 0) {
      const nearbyDropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY,
      });
      if (nearbyDropped.length > 0) {
        creep.pickup(nearbyDropped[0]);
      }
    }

    // Priority 1: Spawns that need energy
    const spawns = room.find(FIND_MY_SPAWNS, {
      filter: (s) => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    });

    if (spawns.length > 0) {
      const target = creep.pos.findClosestByRange(spawns);
      if (target) {
        const result = creep.transfer(target, RESOURCE_ENERGY);
        if (result === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
        } else if (result === OK) {
          this.recordProduction(
            Math.min(creep.store[RESOURCE_ENERGY], target.store.getFreeCapacity(RESOURCE_ENERGY))
          );
        }
        return;
      }
    }

    // Priority 2: Extensions that need energy (use slot-based to avoid herding)
    const extensions = room.find(FIND_MY_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_EXTENSION &&
        (s as StructureExtension).store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    }) as StructureExtension[];

    if (extensions.length > 0) {
      // Use slot-based targeting to avoid all tankers going to same extension
      const target = this.getSlotBasedTarget(creep, extensions);
      if (target) {
        const result = creep.transfer(target, RESOURCE_ENERGY);
        if (result === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
        } else if (result === OK) {
          this.recordProduction(
            Math.min(creep.store[RESOURCE_ENERGY], target.store.getFreeCapacity(RESOURCE_ENERGY))
          );
        }
        return;
      }
    }

    // Priority 3: Towers below 80% energy
    const towers = room.find(FIND_MY_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_TOWER &&
        (s as StructureTower).store[RESOURCE_ENERGY] < 800, // 80% of 1000
    }) as StructureTower[];

    if (towers.length > 0) {
      // Prioritize towers with lowest energy
      towers.sort((a, b) => a.store[RESOURCE_ENERGY] - b.store[RESOURCE_ENERGY]);
      const target = towers[0];
      const result = creep.transfer(target, RESOURCE_ENERGY);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
      } else if (result === OK) {
        this.recordProduction(
          Math.min(creep.store[RESOURCE_ENERGY], target.store.getFreeCapacity(RESOURCE_ENERGY))
        );
      }
      return;
    }

    // Priority 4: Storage (if nothing else needs energy)
    if (room.storage && room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      const result = creep.transfer(room.storage, RESOURCE_ENERGY);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(room.storage, { visualizePathStyle: { stroke: "#ffffff" } });
      } else if (result === OK) {
        this.recordProduction(creep.store[RESOURCE_ENERGY]);
      }
      return;
    }

    // Nothing needs energy - wait near node center
    const centerPos = new RoomPosition(
      this.nodeCenter.x,
      this.nodeCenter.y,
      this.nodeCenter.roomName
    );
    if (creep.pos.getRangeTo(centerPos) > 3) {
      creep.moveTo(centerPos, { visualizePathStyle: { stroke: "#ffffff" } });
    }
  }

  /**
   * Get a target using slot-based distribution to prevent herding.
   */
  private getSlotBasedTarget<T extends Structure>(
    creep: Creep,
    structures: T[]
  ): T | null {
    if (structures.length === 0) return null;

    // Sort by ID for consistent ordering
    const sorted = [...structures].sort((a, b) => a.id.localeCompare(b.id));

    // Get tanker's slot index
    const allTankers = this.getAssignedCreeps();
    const myIndex = allTankers.findIndex((c) => c.name === creep.name);
    const slot = myIndex >= 0 ? myIndex : 0;

    // Start from slot offset and wrap around
    const count = sorted.length;
    for (let i = 0; i < count; i++) {
      const target = sorted[(slot + i) % count];
      return target;
    }

    return sorted[0];
  }

  /**
   * Get number of active tanker creeps.
   */
  getCreepCount(): number {
    return this.getAssignedCreeps().length;
  }

  /**
   * Get total CARRY parts currently assigned.
   */
  getCurrentCarryParts(): number {
    return this.getAssignedCreeps().reduce(
      (sum, creep) => sum + creep.getActiveBodyparts(CARRY),
      0
    );
  }

  /**
   * Get the required CARRY parts based on demand model.
   */
  getRequiredCarryParts(): number {
    return this.requiredCarryParts;
  }

  /**
   * Get the current demand model.
   */
  getDemand(): TankerDemand {
    return this.demand;
  }

  /**
   * Check if tanker capacity is sufficient.
   * Returns true if current CARRY parts meet or exceed required.
   */
  hasAdequateCapacity(): boolean {
    return this.getCurrentCarryParts() >= this.requiredCarryParts;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedTankerCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      nodeCenter: this.nodeCenter,
      demand: this.demand,
      requiredCarryParts: this.requiredCarryParts,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedTankerCorp): void {
    super.deserialize(data);
    this.nodeCenter = data.nodeCenter;
    this.demand = data.demand ?? this.demand;
    this.requiredCarryParts = data.requiredCarryParts;
  }
}

/**
 * Create a TankerCorp for a node.
 */
export function createTankerCorp(
  nodeId: string,
  spawnId: string,
  nodeCenter: Position,
  demand?: TankerDemand
): TankerCorp {
  return new TankerCorp(nodeId, spawnId, nodeCenter, demand);
}
