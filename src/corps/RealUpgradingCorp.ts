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
   * Simple behavior:
   * - Stay at the controller (range 3)
   * - If has energy: upgrade
   * - If empty: wait for hauler to transfer energy, pick up any nearby dropped energy
   */
  private runUpgrader(
    creep: Creep,
    room: Room,
    controller: StructureController
  ): void {
    // First priority: get to the controller if not there
    if (creep.pos.getRangeTo(controller) > 3) {
      creep.moveTo(controller, { visualizePathStyle: { stroke: "#ffffff" } });
      return;
    }

    // We're at the controller - stay here and work
    if (creep.store[RESOURCE_ENERGY] > 0) {
      // Upgrade controller
      const result = creep.upgradeController(controller);
      if (result === OK) {
        this.recordRevenue(creep.getActiveBodyparts(WORK) * 0.1);
      }
    } else {
      // No energy - try to pick up nearby dropped energy (within range 1)
      const nearbyDropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY,
      });

      if (nearbyDropped.length > 0) {
        creep.pickup(nearbyDropped[0]);
      }
      // Otherwise just wait - hauler will transfer energy to us
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
