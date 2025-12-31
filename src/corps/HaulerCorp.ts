/**
 * @fileoverview HaulerCorp - Manages hauler creeps that work on Edges.
 *
 * Haulers are "dumb" conveyor-belt style creeps that:
 * - Pick up energy at the Source end of an edge
 * - Deliver energy at the Sink end of an edge
 * - Follow the path between source and sink like a rail system
 *
 * Haulers don't make decisions - they just follow their assigned route.
 * Each hauler is assigned to a specific edge (source → sink path).
 *
 * @module corps/HaulerCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Position } from "../types/Position";
import { CREEP_LIFETIME } from "../planning/EconomicConstants";
import { HaulerAssignment } from "../flow/FlowTypes";

/**
 * Serialized state for HaulerCorp persistence
 */
export interface SerializedHaulerCorp extends SerializedCorp {
  spawnId: string;
  /** The edge this hauler corp serves */
  edgeId: string;
  /** Source position (pickup point) */
  sourcePos: Position;
  /** Sink position (delivery point) */
  sinkPos: Position;
  /** Flow rate requirement (energy per tick) */
  flowRate: number;
  /** Walking distance (one-way) */
  distance: number;
  /** Required CARRY parts based on flow planner */
  requiredCarryParts: number;
}

/**
 * HaulerCorp manages hauler creeps that transport energy along edges.
 *
 * Haulers are simple: they pick up at source, deliver at sink, repeat.
 * No decision-making - they follow rails like a conveyor belt.
 */
export class HaulerCorp extends Corp {
  private spawnId: string;
  private edgeId: string;
  private sourcePos: Position;
  private sinkPos: Position;
  private flowRate: number;
  private distance: number;
  private requiredCarryParts: number;

  /** Creeps we've already recorded expected production for (session-only) */
  private accountedCreeps: Set<string> = new Set();

  constructor(
    nodeId: string,
    spawnId: string,
    edgeId: string,
    sourcePos: Position,
    sinkPos: Position,
    flowRate: number,
    distance: number,
    requiredCarryParts: number,
    customId?: string
  ) {
    super("hauling", nodeId, customId);
    this.spawnId = spawnId;
    this.edgeId = edgeId;
    this.sourcePos = sourcePos;
    this.sinkPos = sinkPos;
    this.flowRate = flowRate;
    this.distance = distance;
    this.requiredCarryParts = requiredCarryParts;
  }

  /**
   * Get all hauler creeps assigned to this corp.
   */
  private getAssignedCreeps(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (
        creep.memory.corpId === this.id &&
        creep.memory.workType === "haul" &&
        !creep.spawning
      ) {
        creeps.push(creep);

        // Track expected production for new creeps
        if (!this.accountedCreeps.has(name)) {
          this.accountedCreeps.add(name);
          const carryCapacity = creep.store.getCapacity();
          const roundTrip = this.distance * 2 + 10;
          const tripsPerLife = Math.floor(CREEP_LIFETIME / roundTrip);
          this.recordExpectedProduction(carryCapacity * tripsPerLife);
        }
      }
    }
    return creeps;
  }

  /**
   * Get position for this corp (source position).
   */
  getPosition(): Position {
    return this.sourcePos;
  }

  /**
   * Main work loop - run hauler creeps along the edge.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;
    const creeps = this.getAssignedCreeps();

    for (const creep of creeps) {
      this.runHauler(creep);
    }
  }

  /**
   * Run a hauler creep - simple state machine.
   *
   * States:
   * - working=false: Picking up energy at source
   * - working=true: Delivering energy to sink
   */
  private runHauler(creep: Creep): void {
    // State transitions
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.working = false;
      creep.say("pickup");
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
      creep.say("deliver");
    }

    if (creep.memory.working) {
      this.deliverEnergy(creep);
    } else {
      this.pickupEnergy(creep);
    }
  }

  /**
   * Pick up energy at the source position.
   *
   * Haulers look for:
   * 1. Dropped energy near source
   * 2. Containers near source
   * 3. Tombstones/ruins near source
   */
  private pickupEnergy(creep: Creep): void {
    const sourceRoomPos = new RoomPosition(
      this.sourcePos.x,
      this.sourcePos.y,
      this.sourcePos.roomName
    );

    // If not in source room, travel there
    if (creep.room.name !== this.sourcePos.roomName) {
      creep.moveTo(sourceRoomPos, { visualizePathStyle: { stroke: "#ffaa00" } });
      return;
    }

    // Priority 1: Dropped energy near source (within 5 tiles)
    const dropped = creep.room.find(FIND_DROPPED_RESOURCES, {
      filter: (r) =>
        r.resourceType === RESOURCE_ENERGY &&
        r.pos.getRangeTo(sourceRoomPos) <= 5,
    });

    if (dropped.length > 0) {
      // Pick the largest pile
      const target = dropped.reduce((best, curr) =>
        curr.amount > best.amount ? curr : best
      );
      if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // Priority 2: Containers near source
    const containers = creep.room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 0 &&
        s.pos.getRangeTo(sourceRoomPos) <= 3,
    }) as StructureContainer[];

    if (containers.length > 0) {
      const target = containers[0];
      if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // Priority 3: Tombstones near source
    const tombstones = creep.room.find(FIND_TOMBSTONES, {
      filter: (t) =>
        t.store[RESOURCE_ENERGY] > 0 && t.pos.getRangeTo(sourceRoomPos) <= 5,
    });

    if (tombstones.length > 0) {
      const target = tombstones[0];
      if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // Nothing to pick up - wait near source
    if (creep.pos.getRangeTo(sourceRoomPos) > 2) {
      creep.moveTo(sourceRoomPos, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
  }

  /**
   * Deliver energy to the sink position.
   *
   * Haulers deliver to:
   * 1. Storage at sink
   * 2. Containers at sink
   * 3. Drop at sink if nothing else
   */
  private deliverEnergy(creep: Creep): void {
    const sinkRoomPos = new RoomPosition(
      this.sinkPos.x,
      this.sinkPos.y,
      this.sinkPos.roomName
    );

    // If not in sink room, travel there
    if (creep.room.name !== this.sinkPos.roomName) {
      creep.moveTo(sinkRoomPos, { visualizePathStyle: { stroke: "#ffffff" } });
      return;
    }

    // Opportunistic: pick up nearby dropped energy while traveling
    if (creep.store.getFreeCapacity() > 0) {
      const nearbyDropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY,
      });
      if (nearbyDropped.length > 0) {
        creep.pickup(nearbyDropped[0]);
      }
    }

    // Priority 1: Storage near sink
    const storage = creep.room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_STORAGE &&
        (s as StructureStorage).store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
        s.pos.getRangeTo(sinkRoomPos) <= 5,
    }) as StructureStorage[];

    if (storage.length > 0) {
      const target = storage[0];
      const result = creep.transfer(target, RESOURCE_ENERGY);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
      } else if (result === OK) {
        this.recordProduction(creep.store[RESOURCE_ENERGY]);
      }
      return;
    }

    // Priority 2: Containers near sink
    const containers = creep.room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
        s.pos.getRangeTo(sinkRoomPos) <= 3,
    }) as StructureContainer[];

    if (containers.length > 0) {
      const target = containers[0];
      const result = creep.transfer(target, RESOURCE_ENERGY);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
      } else if (result === OK) {
        this.recordProduction(creep.store[RESOURCE_ENERGY]);
      }
      return;
    }

    // Priority 3: Drop at sink position
    if (creep.pos.getRangeTo(sinkRoomPos) <= 2) {
      const dropped = creep.store[RESOURCE_ENERGY];
      creep.drop(RESOURCE_ENERGY);
      this.recordProduction(dropped);
    } else {
      creep.moveTo(sinkRoomPos, { visualizePathStyle: { stroke: "#ffffff" } });
    }
  }

  /**
   * Get number of active hauler creeps.
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
   * Get the required CARRY parts from flow planning.
   */
  getRequiredCarryParts(): number {
    return this.requiredCarryParts;
  }

  /**
   * Set the required CARRY parts (called by flow planner).
   */
  setRequiredCarryParts(parts: number): void {
    this.requiredCarryParts = parts;
  }

  /**
   * Get the edge ID this hauler serves.
   */
  getEdgeId(): string {
    return this.edgeId;
  }

  /**
   * Get the flow rate requirement.
   */
  getFlowRate(): number {
    return this.flowRate;
  }

  /**
   * Update from a HaulerAssignment.
   */
  updateFromAssignment(assignment: HaulerAssignment): void {
    this.flowRate = assignment.flowRate;
    this.distance = assignment.distance;
    this.requiredCarryParts = assignment.carryParts;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedHaulerCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      edgeId: this.edgeId,
      sourcePos: this.sourcePos,
      sinkPos: this.sinkPos,
      flowRate: this.flowRate,
      distance: this.distance,
      requiredCarryParts: this.requiredCarryParts,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedHaulerCorp): void {
    super.deserialize(data);
    this.edgeId = data.edgeId;
    this.sourcePos = data.sourcePos;
    this.sinkPos = data.sinkPos;
    this.flowRate = data.flowRate;
    this.distance = data.distance;
    this.requiredCarryParts = data.requiredCarryParts;
  }
}

/**
 * Create a HaulerCorp for an edge.
 */
export function createHaulerCorp(
  nodeId: string,
  spawnId: string,
  edgeId: string,
  sourcePos: Position,
  sinkPos: Position,
  flowRate: number,
  distance: number,
  requiredCarryParts: number
): HaulerCorp {
  return new HaulerCorp(
    nodeId,
    spawnId,
    edgeId,
    sourcePos,
    sinkPos,
    flowRate,
    distance,
    requiredCarryParts
  );
}
