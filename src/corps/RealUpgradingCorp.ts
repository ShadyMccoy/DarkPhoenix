/**
 * @fileoverview RealUpgradingCorp - Manages actual upgrader creeps.
 *
 * Upgraders pick up energy near the controller and upgrade it.
 *
 * @module corps/RealUpgradingCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position } from "../market/Offer";

/** Upgrader body: 2 WORK, 1 CARRY, 1 MOVE = 300 energy */
const UPGRADER_BODY: BodyPartConstant[] = [WORK, WORK, CARRY, MOVE];

/** Cost of an upgrader creep */
const UPGRADER_COST = 300;

/** Maximum upgraders per room */
const MAX_UPGRADERS = 2;

/** Ticks between spawn attempts */
const SPAWN_COOLDOWN = 10;

/**
 * Serialized state specific to RealUpgradingCorp
 */
export interface SerializedRealUpgradingCorp extends SerializedCorp {
  spawnId: string;
  creepNames: string[];
  lastSpawnAttempt: number;
}

/**
 * RealUpgradingCorp manages upgrader creeps that upgrade the controller.
 *
 * Upgraders:
 * - Stay near the controller
 * - Pick up dropped energy or withdraw from containers
 * - Upgrade the controller
 */
export class RealUpgradingCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** Names of creeps owned by this corp */
  private creepNames: string[] = [];

  /** Last tick we attempted to spawn */
  private lastSpawnAttempt: number = 0;

  constructor(nodeId: string, spawnId: string) {
    super("upgrading", nodeId);
    this.spawnId = spawnId;
  }

  /**
   * Upgrading corp doesn't participate in market (for now)
   */
  sells(): Offer[] {
    return [];
  }

  buys(): Offer[] {
    return [];
  }

  /**
   * Get the controller position as the corp's location.
   */
  getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn && spawn.room.controller) {
      const ctrl = spawn.room.controller;
      return { x: ctrl.pos.x, y: ctrl.pos.y, roomName: ctrl.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  /**
   * Main work loop - spawn upgraders and run their behavior.
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

    // Try to spawn if we need more upgraders
    if (this.creepNames.length < MAX_UPGRADERS) {
      this.trySpawn(spawn, tick);
    }

    // Run upgrader behavior
    for (const name of this.creepNames) {
      const creep = Game.creeps[name];
      if (creep && !creep.spawning) {
        this.runUpgrader(creep, room, controller);
      }
    }
  }

  /**
   * Attempt to spawn a new upgrader creep.
   */
  private trySpawn(spawn: StructureSpawn, tick: number): void {
    if (tick - this.lastSpawnAttempt < SPAWN_COOLDOWN) {
      return;
    }

    if (spawn.spawning) {
      return;
    }

    if (spawn.store[RESOURCE_ENERGY] < UPGRADER_COST) {
      return;
    }

    const name = `upgrader-${spawn.room.name}-${tick}`;

    const result = spawn.spawnCreep(UPGRADER_BODY, name, {
      memory: {
        corpId: this.id,
        workType: "upgrade",
        working: false,
      },
    });

    this.lastSpawnAttempt = tick;

    if (result === OK) {
      this.creepNames.push(name);
      this.recordCost(UPGRADER_COST);
      console.log(`[Upgrading] Spawned ${name}`);
    }
  }

  /**
   * Run behavior for an upgrader creep.
   *
   * State machine:
   * - If empty: pick up energy near controller
   * - If carrying: upgrade controller
   */
  private runUpgrader(
    creep: Creep,
    room: Room,
    controller: StructureController
  ): void {
    // State transition
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.working = false;
      creep.say("get E");
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
      creep.say("upgrade");
    }

    if (creep.memory.working) {
      // Upgrade controller
      if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
        creep.moveTo(controller, { visualizePathStyle: { stroke: "#ffffff" } });
      } else {
        // Record revenue when we successfully upgrade
        this.recordRevenue(creep.getActiveBodyparts(WORK) * 0.1);
      }
    } else {
      // Pick up energy
      this.getEnergy(creep, room, controller);
    }
  }

  /**
   * Get energy from dropped resources or containers near controller.
   */
  private getEnergy(
    creep: Creep,
    room: Room,
    controller: StructureController
  ): void {
    // First try dropped energy near controller
    const dropped = room.find(FIND_DROPPED_RESOURCES, {
      filter: (r) =>
        r.resourceType === RESOURCE_ENERGY &&
        r.pos.getRangeTo(controller) <= 5,
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

    // Then try containers near controller
    const containers = room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        s.pos.getRangeTo(controller) <= 5 &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 0,
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

    // Fallback: any dropped energy or container in room
    const anyDropped = room.find(FIND_DROPPED_RESOURCES, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 20,
    });

    if (anyDropped.length > 0) {
      const target = creep.pos.findClosestByPath(anyDropped);
      if (target) {
        if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
        }
        return;
      }
    }

    // Last resort: withdraw from spawn (if it has excess)
    const spawns = room.find(FIND_MY_SPAWNS);
    for (const spawn of spawns) {
      if (spawn.store[RESOURCE_ENERGY] > 200) {
        if (creep.withdraw(spawn, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          creep.moveTo(spawn, { visualizePathStyle: { stroke: "#ffaa00" } });
        }
        return;
      }
    }

    // If no energy, move towards controller and wait
    if (creep.pos.getRangeTo(controller) > 3) {
      creep.moveTo(controller, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
  }

  /**
   * Get number of active upgrader creeps.
   */
  getCreepCount(): number {
    return this.creepNames.filter((n) => Game.creeps[n]).length;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedRealUpgradingCorp {
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
  deserialize(data: SerializedRealUpgradingCorp): void {
    super.deserialize(data);
    this.creepNames = data.creepNames || [];
    this.lastSpawnAttempt = data.lastSpawnAttempt || 0;
  }
}

/**
 * Create a RealUpgradingCorp for a room.
 */
export function createRealUpgradingCorp(
  room: Room,
  spawn: StructureSpawn
): RealUpgradingCorp {
  const nodeId = `${room.name}-upgrading`;
  return new RealUpgradingCorp(nodeId, spawn.id);
}
