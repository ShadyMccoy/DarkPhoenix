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
   * At RCL 2, upgraders also help build (extensions are priority to increase spawn capacity).
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

    if (creep.memory.working) {
      // At RCL 2+, upgraders help build if there are construction sites
      if (controller.level > 1) {
        const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
        if (sites.length > 0) {
          const site = creep.pos.findClosestByPath(sites);
          if (site) {
            const result = creep.build(site);
            if (result === ERR_NOT_IN_RANGE) {
              creep.moveTo(site, { visualizePathStyle: { stroke: "#ffaa00" } });
            } else if (result === OK) {
              const workParts = creep.getActiveBodyparts(WORK);
              this.recordConsumption(workParts * 5); // BUILD costs 5 energy per WORK
              this.recordProduction(workParts * 5);
            }
            return;
          }
        }
      }

      // No construction sites (or RCL > 2), upgrade controller
      if (creep.pos.getRangeTo(controller) > 3) {
        creep.moveTo(controller, { visualizePathStyle: { stroke: "#ffffff" } });
        return;
      }

      const result = creep.upgradeController(controller);
      if (result === OK) {
        const workParts = creep.getActiveBodyparts(WORK);
        this.recordConsumption(workParts);
        this.recordProduction(workParts);
      }
    } else {
      // Pick up energy - check dropped resources first, then spawn/extensions
      this.doPickupEnergy(creep, room);
    }
  }

  /**
   * Pick up energy from various sources.
   */
  private doPickupEnergy(creep: Creep, room: Room): void {
    // First check for dropped energy nearby
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

    // Check containers near controller
    const containers = room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        s.store[RESOURCE_ENERGY] > 50,
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

    // Last resort: withdraw from spawn (only if it has plenty of energy)
    const spawns = room.find(FIND_MY_SPAWNS);
    for (const spawn of spawns) {
      if (spawn.store[RESOURCE_ENERGY] >= 200) {
        if (creep.withdraw(spawn, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          creep.moveTo(spawn, { visualizePathStyle: { stroke: "#ffaa00" } });
        }
        return;
      }
    }

    // Move towards controller and wait for energy delivery
    const controller = room.controller;
    if (controller && creep.pos.getRangeTo(controller) > 3) {
      creep.moveTo(controller, { visualizePathStyle: { stroke: "#ffffff" } });
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
