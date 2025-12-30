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

  constructor(nodeId: string, spawnId: string, customId?: string) {
    super("hauling", nodeId, customId);
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
   * Get a target structure using slot-based distribution.
   * Each hauler is assigned a "slot" (index) and picks structures starting from that offset.
   * This prevents all haulers from targeting the same structure (herd behavior).
   *
   * Algorithm:
   * 1. Sort structures by ID for consistent ordering across ticks
   * 2. Assign each hauler an offset based on their index
   * 3. Hauler picks first available structure starting from their offset
   *
   * Result: Haulers distribute evenly across structures like a rotating belt.
   */
  private getSlotBasedTarget(
    creep: Creep,
    structures: (StructureSpawn | StructureExtension)[]
  ): StructureSpawn | StructureExtension | null {
    if (structures.length === 0) return null;

    // Sort by ID for consistent ordering (structures don't change mid-tick)
    const sorted = [...structures].sort((a, b) => a.id.localeCompare(b.id));

    // Get hauler's slot index
    const allHaulers = this.getAssignedCreeps();
    const myIndex = allHaulers.findIndex(c => c.name === creep.name);
    const slot = myIndex >= 0 ? myIndex : 0;

    // Start from slot offset and wrap around
    const count = sorted.length;
    for (let i = 0; i < count; i++) {
      const target = sorted[(slot + i) % count];
      // Check if this structure needs energy and no other hauler is already targeting it
      if (target.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        // Additional check: prefer structures not already being approached by closer haulers
        // This is a soft preference - we still take it if it's our slot
        if (i === 0 || !this.isTargetCrowded(creep, target, allHaulers)) {
          return target;
        }
      }
    }

    // Fallback: take any structure that needs energy
    return sorted.find(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0) ?? null;
  }

  /**
   * Check if a target structure already has enough haulers approaching it.
   * Returns true if there's another hauler closer to this target than us.
   */
  private isTargetCrowded(
    creep: Creep,
    target: Structure,
    allHaulers: Creep[]
  ): boolean {
    const myDistance = creep.pos.getRangeTo(target);

    // Count haulers closer than us that are also delivering
    let closerHaulers = 0;
    for (const other of allHaulers) {
      if (other.name === creep.name) continue;
      if (!other.memory.working) continue; // Not delivering

      const otherDistance = other.pos.getRangeTo(target);
      if (otherDistance < myDistance) {
        closerHaulers++;
      }
    }

    // Consider crowded if there's already a closer hauler
    // The structure can only accept so much energy anyway
    return closerHaulers >= 1;
  }

  /**
   * Get the source this CarryCorp's haulers should serve.
   * With per-source CarryCorps, each corp has exactly one source from its hauler assignment.
   * Falls back to round-robin distribution for legacy room-based corps.
   */
  private getAssignedSource(creep: Creep, sources: Source[]): Source | null {
    // Per-source CarryCorp: use the source from hauler assignment
    if (this.haulerAssignments.length > 0) {
      const assignment = this.haulerAssignments[0];
      // Extract source game ID from flow source ID (e.g., "source-abc123" → "abc123")
      const sourceGameId = assignment.fromId.replace("source-", "");

      // Check if this is an intel-based source (remote room without vision)
      if (sourceGameId.startsWith("intel-")) {
        // Intel source: parse position from ID format "intel-ROOMNAME-X-Y"
        const match = sourceGameId.match(/^intel-([EW]\d+[NS]\d+)-(\d+)-(\d+)$/);
        if (match) {
          const [, roomName, x, y] = match;
          // Store position for navigation even without source object
          creep.memory.assignedSourcePos = { x: parseInt(x), y: parseInt(y), roomName };
        }
        return null; // No live source object for intel sources
      }

      const source = Game.getObjectById(sourceGameId as Id<Source>);
      if (source) {
        creep.memory.assignedSourceId = source.id;
        return source;
      }
    }

    // Fallback: legacy round-robin distribution (for transition period)
    if (sources.length === 0) return null;

    if (creep.memory.assignedSourceId) {
      const assigned = Game.getObjectById(creep.memory.assignedSourceId as Id<Source>);
      if (assigned) return assigned;
      delete creep.memory.assignedSourceId;
    }

    const allHaulers = this.getAssignedCreeps();
    const myIndex = allHaulers.findIndex(c => c.name === creep.name);
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

    // Get target position (from source object or intel position)
    let targetPos: RoomPosition | null = null;
    if (assignedSource) {
      targetPos = assignedSource.pos;
    } else if (creep.memory.assignedSourcePos) {
      const pos = creep.memory.assignedSourcePos;
      targetPos = new RoomPosition(pos.x, pos.y, pos.roomName);
    }

    // If target is in a different room, navigate there first
    if (targetPos && targetPos.roomName !== creep.room.name) {
      creep.moveTo(targetPos, { visualizePathStyle: { stroke: "#ffaa00" } });
      return;
    }

    // First try dropped energy near assigned source (within range 5)
    const dropped = room.find(FIND_DROPPED_RESOURCES, {
      filter: (r) => {
        if (r.resourceType !== RESOURCE_ENERGY) return false;
        // If we have a target position, prefer energy near it
        if (targetPos) {
          return r.pos.getRangeTo(targetPos) <= 5;
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
        if (targetPos) {
          return s.pos.getRangeTo(targetPos) <= 3;
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
    if (targetPos && creep.pos.getRangeTo(targetPos) > 3) {
      creep.moveTo(targetPos, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
  }

  /**
   * Deliver energy to spawn, extensions, or workers.
   * Uses slot-based distribution to prevent herd behavior.
   * At RCL 2 with construction sites, prioritizes dropping near sources.
   */
  private deliverEnergy(creep: Creep, room: Room, spawn: StructureSpawn): void {
    // Priority 1: Fill spawn and extensions using slot-based distribution
    // This prevents all haulers from switching to the same target
    const spawnStructures = room.find(FIND_MY_STRUCTURES, {
      filter: (s) =>
        (s.structureType === STRUCTURE_SPAWN ||
          s.structureType === STRUCTURE_EXTENSION) &&
        (s as StructureSpawn | StructureExtension).store.getFreeCapacity(
          RESOURCE_ENERGY
        ) > 0,
    }) as (StructureSpawn | StructureExtension)[];

    if (spawnStructures.length > 0) {
      // Use slot-based distribution: each hauler gets assigned structures
      // based on their index, preventing all from targeting the same one
      const target = this.getSlotBasedTarget(creep, spawnStructures);
      if (target) {
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
    }

    // Check if there are construction sites (building phase)
    const constructionSites = room.find(FIND_MY_CONSTRUCTION_SITES);
    const rcl = room.controller?.level ?? 1;

    // At RCL 2 with construction sites: drop near sources, not controller
    // Workers (upgraders doing build duty) are near sources picking up dropped energy
    if (rcl <= 2 && constructionSites.length > 0) {
      // Drop near assigned source where workers are building
      const sources = room.find(FIND_SOURCES);
      const assignedSource = this.getAssignedSource(creep, sources);
      if (assignedSource) {
        if (creep.pos.getRangeTo(assignedSource) <= 3) {
          const dropped = creep.store[RESOURCE_ENERGY];
          creep.drop(RESOURCE_ENERGY);
          this.recordProduction(dropped);
        } else {
          creep.moveTo(assignedSource, { visualizePathStyle: { stroke: "#ffaa00" } });
        }
        return;
      }
    }

    // Priority 2: Transfer directly to upgraders
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

    // Priority 3: Drop at controller (for upgrading)
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
