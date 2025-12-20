/**
 * @fileoverview RealHaulingCorp - Manages actual hauler creeps.
 *
 * Haulers pick up dropped energy from mining sites and deliver it
 * to spawns (for energy) and the controller area (for upgraders).
 *
 * @module corps/RealHaulingCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position } from "../market/Offer";
import {
  HAULER_BODY,
  HAULER_COST,
  MAX_HAULERS,
  SPAWN_COOLDOWN,
} from "./CorpConstants";

/**
 * Serialized state specific to RealHaulingCorp
 */
export interface SerializedRealHaulingCorp extends SerializedCorp {
  spawnId: string;
  creepNames: string[];
  lastSpawnAttempt: number;
}

/**
 * RealHaulingCorp manages hauler creeps that move energy around.
 *
 * Haulers:
 * - Pick up dropped energy from the ground
 * - Deliver to spawn if spawn needs energy
 * - Otherwise deliver near controller for upgraders
 */
export class RealHaulingCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** Names of creeps owned by this corp */
  private creepNames: string[] = [];

  /** Last tick we attempted to spawn */
  private lastSpawnAttempt: number = 0;

  constructor(nodeId: string, spawnId: string) {
    super("hauling", nodeId);
    this.spawnId = spawnId;
  }

  /**
   * Hauling corp doesn't participate in market (for now)
   */
  sells(): Offer[] {
    return [];
  }

  buys(): Offer[] {
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
   * Main work loop - spawn haulers and run their behavior.
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

    // Try to spawn if we need more haulers
    if (this.creepNames.length < MAX_HAULERS) {
      this.trySpawn(spawn, tick);
    }

    // Run hauler behavior
    for (const name of this.creepNames) {
      const creep = Game.creeps[name];
      if (creep && !creep.spawning) {
        this.runHauler(creep, room, spawn);
      }
    }
  }

  /**
   * Attempt to spawn a new hauler creep.
   */
  private trySpawn(spawn: StructureSpawn, tick: number): void {
    if (tick - this.lastSpawnAttempt < SPAWN_COOLDOWN) {
      return;
    }

    if (spawn.spawning) {
      return;
    }

    if (spawn.store[RESOURCE_ENERGY] < HAULER_COST) {
      return;
    }

    const name = `hauler-${spawn.room.name}-${tick}`;

    const result = spawn.spawnCreep(HAULER_BODY, name, {
      memory: {
        corpId: this.id,
        workType: "haul",
        working: false,
      },
    });

    this.lastSpawnAttempt = tick;

    if (result === OK) {
      this.creepNames.push(name);
      this.recordCost(HAULER_COST);
      console.log(`[Hauling] Spawned ${name}`);
    }
  }

  /**
   * Run behavior for a hauler creep.
   *
   * State machine:
   * - If empty: find dropped energy and pick it up
   * - If carrying: deliver to spawn (if not full) or controller area
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

    if (creep.memory.working) {
      // Deliver energy
      this.deliverEnergy(creep, room, spawn);
    } else {
      // Pick up energy
      this.pickupEnergy(creep, room);
    }
  }

  /**
   * Pick up energy from the ground or containers.
   */
  private pickupEnergy(creep: Creep, room: Room): void {
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

    // Then try containers
    const containers = room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 50,
    }) as StructureContainer[];

    if (containers.length > 0) {
      const target = creep.pos.findClosestByPath(containers);
      if (target) {
        if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
        }
        return;
      }
    }

    // If nothing to pick up, move towards sources (where miners drop)
    const sources = room.find(FIND_SOURCES);
    if (sources.length > 0) {
      const source = creep.pos.findClosestByPath(sources);
      if (source && creep.pos.getRangeTo(source) > 3) {
        creep.moveTo(source, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
    }
  }

  /**
   * Deliver energy to spawn or directly to upgraders.
   */
  private deliverEnergy(creep: Creep, room: Room, spawn: StructureSpawn): void {
    // Priority 1: Fill spawn and extensions
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
        if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
        }
        return;
      }
    }

    // Priority 2: Transfer directly to upgraders (prioritize the one with most free capacity)
    const upgraders = room.find(FIND_MY_CREEPS, {
      filter: (c) =>
        c.memory.workType === "upgrade" &&
        c.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    });

    if (upgraders.length > 0) {
      // Sort by free capacity (descending) to prioritize upgraders that need energy most
      upgraders.sort(
        (a, b) =>
          b.store.getFreeCapacity(RESOURCE_ENERGY) -
          a.store.getFreeCapacity(RESOURCE_ENERGY)
      );
      const target = upgraders[0];
      if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
      } else {
        this.recordRevenue(creep.store[RESOURCE_ENERGY] * 0.001);
      }
      return;
    }

    // Priority 3: If no upgraders need energy, drop near controller
    if (room.controller) {
      if (creep.pos.getRangeTo(room.controller) <= 3) {
        creep.drop(RESOURCE_ENERGY);
        this.recordRevenue(creep.store[RESOURCE_ENERGY] * 0.001);
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
    return this.creepNames.filter((n) => Game.creeps[n]).length;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedRealHaulingCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      creepNames: this.creepNames,
      lastSpawnAttempt: this.lastSpawnAttempt,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedRealHaulingCorp): void {
    super.deserialize(data);
    this.creepNames = data.creepNames || [];
    this.lastSpawnAttempt = data.lastSpawnAttempt || 0;
  }
}

/**
 * Create a RealHaulingCorp for a room.
 */
export function createRealHaulingCorp(
  room: Room,
  spawn: StructureSpawn
): RealHaulingCorp {
  const nodeId = `${room.name}-hauling`;
  return new RealHaulingCorp(nodeId, spawn.id);
}
