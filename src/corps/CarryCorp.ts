/**
 * @fileoverview CarryCorp - Manages hauler creeps.
 *
 * CarryCorp is a transport service that moves energy from sources to destinations.
 *
 * @module corps/CarryCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Position } from "../types/Position";
import { CREEP_LIFETIME } from "../planning/EconomicConstants";
import { HaulerAssignment } from "../flow/FlowTypes";

/** Transport fee per energy unit (base cost before margin) */
const TRANSPORT_FEE_PER_ENERGY = 0.05;

/**
 * Serialized state specific to CarryCorp
 */
export interface SerializedCarryCorp extends SerializedCorp {
  spawnId: string;
  /** Flow-based hauler assignments (from FlowEconomy) */
  haulerAssignments?: HaulerAssignment[];
}

/**
 * CarryCorp manages hauler creeps that move energy around.
 */
export class CarryCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** Creeps we've already recorded expected production for (session-only) */
  private accountedCreeps: Set<string> = new Set();

  /**
   * Flow-based hauler assignments from FlowEconomy.
   * Each assignment specifies a source → sink route with CARRY requirements.
   */
  private haulerAssignments: HaulerAssignment[] = [];

  constructor(nodeId: string, spawnId: string) {
    super("hauling", nodeId);
    this.spawnId = spawnId;
  }

  /**
   * Get all creeps assigned to this corp.
   */
  private getAssignedCreeps(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if ((creep.memory.corpId === this.id || creep.memory.corpId === this.nodeId) &&
          creep.memory.workType === "haul" && !creep.spawning) {
        creeps.push(creep);

        if (!this.accountedCreeps.has(name)) {
          this.accountedCreeps.add(name);
          const carryCapacity = creep.store.getCapacity();
          const expectedDeliveries = carryCapacity * CREEP_LIFETIME / 50; // Estimate
          this.recordExpectedProduction(expectedDeliveries);
        }
      }
    }
    return creeps;
  }

  /**
   * Get transport cost per energy unit based on actual operations.
   */
  getTransportCostPerEnergy(): number {
    if (this.unitsProduced === 0) return TRANSPORT_FEE_PER_ENERGY;
    const operatingCost = this.totalCost - this.acquisitionCost;
    return operatingCost / this.unitsProduced;
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
   * Main work loop - run hauler creeps.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    const room = spawn.room;
    const creeps = this.getAssignedCreeps();

    for (const creep of creeps) {
      this.runHauler(creep, room, spawn);
    }
  }

  /**
   * Run behavior for a hauler creep.
   */
  private runHauler(creep: Creep, room: Room, spawn: StructureSpawn): void {
    // State transition
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.working = false;
      creep.say("pickup");
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
      creep.say("deliver");
    }

    // Opportunistic: pick up nearby dropped energy while delivering
    if (creep.memory.working && creep.store.getFreeCapacity() > 0) {
      const nearbyDropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY,
      });
      if (nearbyDropped.length > 0) {
        creep.pickup(nearbyDropped[0]);
      }
    }

    if (creep.memory.working) {
      this.deliverEnergy(creep, room, spawn);
    } else {
      this.pickupEnergy(creep, room);
    }
  }

  /**
   * Get or assign a source for this hauler.
   * Uses creep memory to persist assignment across ticks.
   * Distributes haulers across sources based on their index.
   */
  private getAssignedSource(creep: Creep, sources: Source[]): Source | null {
    if (sources.length === 0) return null;

    // Check if creep already has an assigned source
    if (creep.memory.assignedSourceId) {
      const assigned = Game.getObjectById(creep.memory.assignedSourceId as Id<Source>);
      if (assigned) return assigned;
      // Source no longer exists, clear assignment
      delete creep.memory.assignedSourceId;
    }

    // Assign this creep to a source
    // Get all haulers assigned to this corp
    const allHaulers = this.getAssignedCreeps();
    const myIndex = allHaulers.findIndex(c => c.name === creep.name);

    // Distribute haulers round-robin across sources
    const sourceIndex = myIndex >= 0 ? myIndex % sources.length : 0;
    const assignedSource = sources[sourceIndex];

    creep.memory.assignedSourceId = assignedSource.id;
    return assignedSource;
  }

  /**
   * Pick up energy from the ground or containers.
   * Haulers are assigned to specific sources to prevent thrashing.
   */
  private pickupEnergy(creep: Creep, room: Room): void {
    const sources = room.find(FIND_SOURCES);
    const assignedSource = this.getAssignedSource(creep, sources);

    // First try dropped energy near assigned source (within range 5)
    const dropped = room.find(FIND_DROPPED_RESOURCES, {
      filter: (r) => {
        if (r.resourceType !== RESOURCE_ENERGY) return false;
        // If we have an assigned source, prefer energy near it
        if (assignedSource) {
          return r.pos.getRangeTo(assignedSource) <= 5;
        }
        return true;
      },
    });

    if (dropped.length > 0) {
      // Pick the largest pile near our source instead of closest
      const target = dropped.reduce((best, curr) =>
        curr.amount > best.amount ? curr : best
      );
      const result = creep.pickup(target);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // If no dropped energy near assigned source, check containers near it
    const containers = room.find(FIND_STRUCTURES, {
      filter: (s) => {
        if (s.structureType !== STRUCTURE_CONTAINER) return false;
        if ((s as StructureContainer).store[RESOURCE_ENERGY] === 0) return false;
        if (assignedSource) {
          return s.pos.getRangeTo(assignedSource) <= 3;
        }
        return true;
      },
    }) as StructureContainer[];

    if (containers.length > 0) {
      const target = containers[0]; // Take first container near source
      const result = creep.withdraw(target, RESOURCE_ENERGY);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // If nothing to pick up, move towards assigned source (where miners drop)
    if (assignedSource && creep.pos.getRangeTo(assignedSource) > 3) {
      creep.moveTo(assignedSource, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
  }

  /**
   * Deliver energy to spawn or directly to upgraders.
   */
  private deliverEnergy(creep: Creep, room: Room, spawn: StructureSpawn): void {
    const spawnStructures = room.find(FIND_MY_STRUCTURES, {
      filter: (s) =>
        (s.structureType === STRUCTURE_SPAWN ||
          s.structureType === STRUCTURE_EXTENSION) &&
        (s as StructureSpawn | StructureExtension).store.getFreeCapacity(
          RESOURCE_ENERGY
        ) > 0,
    });

    if (spawnStructures.length > 0) {
      const target = creep.pos.findClosestByPath(spawnStructures);
      if (target) {
        const result = creep.transfer(target, RESOURCE_ENERGY);
        if (result === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
        } else if (result === OK) {
          const transferred = Math.min(
            creep.store[RESOURCE_ENERGY],
            (target as StructureSpawn | StructureExtension).store.getFreeCapacity(RESOURCE_ENERGY)
          );
          this.recordProduction(transferred);
        }
        return;
      }
    }

    const upgraders = room.find(FIND_MY_CREEPS, {
      filter: (c) =>
        c.memory.workType === "upgrade" &&
        c.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    });

    if (upgraders.length > 0) {
      upgraders.sort(
        (a, b) =>
          b.store.getFreeCapacity(RESOURCE_ENERGY) -
          a.store.getFreeCapacity(RESOURCE_ENERGY)
      );
      const target = upgraders[0];
      const result = creep.transfer(target, RESOURCE_ENERGY);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
      } else if (result === OK) {
        const transferred = Math.min(
          creep.store[RESOURCE_ENERGY],
          target.store.getFreeCapacity(RESOURCE_ENERGY)
        );
        this.recordProduction(transferred);
      }
      return;
    }

    if (room.controller) {
      if (creep.pos.getRangeTo(room.controller) <= 3) {
        const dropped = creep.store[RESOURCE_ENERGY];
        creep.drop(RESOURCE_ENERGY);
        this.recordProduction(dropped);
      } else {
        creep.moveTo(room.controller, {
          visualizePathStyle: { stroke: "#ffffff" },
        });
      }
    }
  }

  /**
   * Get number of active hauler creeps.
   */
  getCreepCount(): number {
    return this.getAssignedCreeps().length;
  }

  // ===========================================================================
  // FLOW INTEGRATION
  // ===========================================================================

  /**
   * Set hauler assignments from FlowEconomy.
   * Each assignment describes a route from source to sink with CARRY requirements.
   */
  setHaulerAssignments(assignments: HaulerAssignment[]): void {
    this.haulerAssignments = assignments;
  }

  /**
   * Get all hauler assignments for this corp.
   */
  getHaulerAssignments(): HaulerAssignment[] {
    return this.haulerAssignments;
  }

  /**
   * Check if this corp has flow-based assignments.
   */
  hasFlowAssignments(): boolean {
    return this.haulerAssignments.length > 0;
  }

  /**
   * Get total CARRY parts needed from flow assignments.
   */
  getTotalCarryPartsNeeded(): number {
    return this.haulerAssignments.reduce((sum, h) => sum + h.carryParts, 0);
  }

  /**
   * Get total flow rate from all assignments.
   */
  getTotalFlowRate(): number {
    return this.haulerAssignments.reduce((sum, h) => sum + h.flowRate, 0);
  }

  /**
   * Get the assignment for a specific source (by game ID).
   * Returns the route a hauler should take from this source.
   */
  getAssignmentForSource(sourceGameId: string): HaulerAssignment | undefined {
    const sourceFlowId = `source-${sourceGameId}`;
    return this.haulerAssignments.find(h => h.fromId === sourceFlowId);
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedCarryCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      haulerAssignments: this.haulerAssignments.length > 0 ? this.haulerAssignments : undefined,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedCarryCorp): void {
    super.deserialize(data);
    this.haulerAssignments = data.haulerAssignments ?? [];
  }
}

/**
 * Create a CarryCorp for a room.
 */
export function createCarryCorp(
  room: Room,
  spawn: StructureSpawn
): CarryCorp {
  const nodeId = `${room.name}-hauling`;
  return new CarryCorp(nodeId, spawn.id);
}
