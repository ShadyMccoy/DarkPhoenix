/**
 * @fileoverview UpgradingCorp - Manages upgrader creeps.
 *
 * Upgraders pick up energy near the controller and upgrade it.
 *
 * @module corps/UpgradingCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Position } from "../types/Position";
import { CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD } from "./CorpConstants";
import { SinkAllocation } from "../flow/FlowTypes";

/**
 * Serialized state specific to UpgradingCorp
 */
export interface SerializedUpgradingCorp extends SerializedCorp {
  spawnId: string;
  targetUpgraders: number;
  /** Flow-based sink allocation (from FlowEconomy) */
  sinkAllocation?: SinkAllocation;
}

/**
 * UpgradingCorp manages upgrader creeps that upgrade the controller.
 *
 * Upgraders:
 * - Stay near the controller
 * - Pick up dropped energy or withdraw from containers
 * - Upgrade the controller
 */
export class UpgradingCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** Target number of upgraders (computed during planning) */
  private targetUpgraders: number = 2;

  /**
   * Flow-based sink allocation from FlowEconomy.
   * Specifies the energy rate allocated to this controller.
   */
  private sinkAllocation: SinkAllocation | null = null;

  constructor(nodeId: string, spawnId: string, customId?: string) {
    super("upgrading", nodeId, customId);
    this.spawnId = spawnId;
  }

  /**
   * Get active creeps assigned to this corp.
   */
  private getActiveCreeps(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id && creep.memory.workType === "upgrade" && !creep.spawning) {
        creeps.push(creep);
      }
    }
    return creeps;
  }

  /**
   * Plan upgrading operations. Called periodically to compute targets.
   * Adjusts target upgraders based on controller level and downgrade risk.
   */
  plan(tick: number): void {
    super.plan(tick);

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn?.room.controller) {
      this.targetUpgraders = 1;
      return;
    }

    const controller = spawn.room.controller;
    const rcl = controller.level;

    let target = rcl <= 2 ? 1 : 2;

    if (controller.ticksToDowngrade < CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD * 0.3) {
      target = Math.max(target, 3);
    }

    this.targetUpgraders = target;
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
   * Main work loop - run upgrader creeps.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    const room = spawn.room;
    const controller = room.controller;
    if (!controller) return;

    const creeps = this.getActiveCreeps();
    for (const creep of creeps) {
      this.runUpgrader(creep, room, controller);
    }
  }

  /**
   * Run behavior for an upgrader creep.
   * Upgraders are stationary - they stay near the controller and only pick up nearby energy.
   */
  private runUpgrader(
    creep: Creep,
    room: Room,
    controller: StructureController
  ): void {
    // Track working state for energy pickup
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.working = false;
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
    }

    // Check for construction sites - prioritize building over upgrading
    const constructionSites = room.find(FIND_MY_CONSTRUCTION_SITES);

    if (constructionSites.length > 0) {
      // Building mode - go to construction site and stay there
      const target = creep.pos.findClosestByRange(constructionSites);
      if (target) {
        // Move to construction site if not in range
        if (creep.pos.getRangeTo(target) > 3) {
          creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
          return;
        }

        if (creep.memory.working) {
          const buildResult = creep.build(target);
          if (buildResult === OK) {
            const workParts = creep.getActiveBodyparts(WORK);
            this.recordConsumption(workParts);
            this.recordProduction(workParts);
          }
        } else {
          // Stationary pickup near construction site
          this.doPickupEnergyNearPosition(creep, target.pos);
        }
      }
    } else {
      // Upgrading mode - stay near controller
      if (creep.pos.getRangeTo(controller) > 3) {
        creep.moveTo(controller, { visualizePathStyle: { stroke: "#ffffff" } });
        return;
      }

      if (creep.memory.working) {
        const result = creep.upgradeController(controller);
        if (result === OK) {
          const workParts = creep.getActiveBodyparts(WORK);
          this.recordConsumption(workParts);
          this.recordProduction(workParts);
        }
      } else {
        // Stationary pickup near controller
        this.doPickupEnergy(creep, controller);
      }
    }
  }

  /**
   * Pick up energy from nearby sources only (stationary - don't travel for energy).
   * Haulers are responsible for delivering energy to upgraders.
   */
  private doPickupEnergy(creep: Creep, controller: StructureController): void {
    const PICKUP_RANGE = 4; // Only grab energy within this range

    // Check for dropped energy within range
    const dropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, PICKUP_RANGE, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 20,
    });
    if (dropped.length > 0) {
      const target = dropped[0];
      if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
      }
      return;
    }

    // Check for tombstones with energy within range
    const tombstones = creep.pos.findInRange(FIND_TOMBSTONES, PICKUP_RANGE, {
      filter: (t) => t.store[RESOURCE_ENERGY] > 0,
    });
    if (tombstones.length > 0) {
      const target = tombstones[0];
      if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
      }
      return;
    }

    // Check for ruins with energy within range
    const ruins = creep.pos.findInRange(FIND_RUINS, PICKUP_RANGE, {
      filter: (r) => r.store[RESOURCE_ENERGY] > 0,
    });
    if (ruins.length > 0) {
      const target = ruins[0];
      if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
      }
      return;
    }

    // Check containers within range
    const containers = creep.pos.findInRange(FIND_STRUCTURES, PICKUP_RANGE, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 50,
    }) as StructureContainer[];
    if (containers.length > 0) {
      const target = containers[0];
      if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
      }
      return;
    }

    // Check links within range (for higher RCL)
    const links = creep.pos.findInRange(FIND_MY_STRUCTURES, PICKUP_RANGE, {
      filter: (s) =>
        s.structureType === STRUCTURE_LINK &&
        (s as StructureLink).store[RESOURCE_ENERGY] > 0,
    }) as StructureLink[];
    if (links.length > 0) {
      const target = links[0];
      if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
      }
      return;
    }

    // Check for containers near the controller (even if not near creep)
    const controllerContainers = controller.pos.findInRange(FIND_STRUCTURES, 4, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 50,
    }) as StructureContainer[];
    if (controllerContainers.length > 0) {
      const target = controllerContainers[0];
      if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
      }
      return;
    }

    // No energy nearby - stay near controller and wait for delivery
    if (creep.pos.getRangeTo(controller) > 3) {
      creep.moveTo(controller);
    }
  }

  /**
   * Pick up energy near a position (stationary - don't travel for energy).
   * Used when building at construction sites.
   */
  private doPickupEnergyNearPosition(creep: Creep, pos: RoomPosition): void {
    const PICKUP_RANGE = 4;

    // Check for dropped energy within range
    const dropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, PICKUP_RANGE, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 20,
    });
    if (dropped.length > 0) {
      const target = dropped[0];
      if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
      }
      return;
    }

    // Check for tombstones with energy within range
    const tombstones = creep.pos.findInRange(FIND_TOMBSTONES, PICKUP_RANGE, {
      filter: (t) => t.store[RESOURCE_ENERGY] > 0,
    });
    if (tombstones.length > 0) {
      const target = tombstones[0];
      if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
      }
      return;
    }

    // Check containers within range
    const containers = creep.pos.findInRange(FIND_STRUCTURES, PICKUP_RANGE, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 50,
    }) as StructureContainer[];
    if (containers.length > 0) {
      const target = containers[0];
      if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
      }
      return;
    }

    // No energy nearby - stay near target position and wait for delivery
    if (creep.pos.getRangeTo(pos) > 3) {
      creep.moveTo(pos);
    }
  }

  /**
   * Get number of active upgrader creeps.
   */
  getCreepCount(): number {
    return this.getActiveCreeps().length;
  }

  // ===========================================================================
  // FLOW INTEGRATION
  // ===========================================================================

  /**
   * Set the sink allocation from FlowEconomy.
   * This determines how much energy should flow to upgrading.
   */
  setSinkAllocation(allocation: SinkAllocation): void {
    this.sinkAllocation = allocation;
    // Dynamically adjust target upgraders based on allocated energy
    // Each upgrader with ~3 WORK parts uses about 3 energy/tick
    const workPerUpgrader = 3;
    this.targetUpgraders = Math.max(1, Math.ceil(allocation.allocated / workPerUpgrader));
  }

  /**
   * Get the current sink allocation (if set by FlowEconomy).
   */
  getSinkAllocation(): SinkAllocation | null {
    return this.sinkAllocation;
  }

  /**
   * Check if this corp has a flow-based allocation.
   */
  hasFlowAllocation(): boolean {
    return this.sinkAllocation !== null;
  }

  /**
   * Get the allocated energy rate from flow solution.
   */
  getAllocatedEnergyRate(): number {
    return this.sinkAllocation?.allocated ?? 0;
  }

  /**
   * Get the demanded energy rate from flow solution.
   */
  getDemandedEnergyRate(): number {
    return this.sinkAllocation?.demand ?? 0;
  }

  /**
   * Get the priority from flow solution.
   */
  getFlowPriority(): number {
    return this.sinkAllocation?.priority ?? 60; // Default controller priority
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedUpgradingCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      targetUpgraders: this.targetUpgraders,
      sinkAllocation: this.sinkAllocation ?? undefined,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedUpgradingCorp): void {
    super.deserialize(data);
    this.targetUpgraders = data.targetUpgraders || 2;
    this.sinkAllocation = data.sinkAllocation ?? null;
  }
}

/**
 * Create an UpgradingCorp for a room.
 */
export function createUpgradingCorp(
  room: Room,
  spawn: StructureSpawn
): UpgradingCorp {
  const nodeId = `${room.name}-upgrading`;
  return new UpgradingCorp(nodeId, spawn.id);
}
