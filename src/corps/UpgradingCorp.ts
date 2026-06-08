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

/** Safety bound on upgraders per controller (prevents a swarm if an allocation goes stale). */
const UPGRADER_COUNT_CAP = 6;
import { SinkAllocation } from "../flow/FlowTypes";
import { buildUpgraderBody, UpgraderStrategy } from "../spawn/BodyBuilder";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";

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

  /** Last chosen supply strategy, so a switch is logged once rather than every tick. */
  private lastStrategy: UpgraderStrategy | null = null;

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

    // Upgraders only upgrade - they camp at the controller and convert the
    // energy the CarryCorp (local mover) delivers there. Construction is the
    // ConstructionCorp's job; diverting the upgrader to build sites just pulls
    // it away from the controller and stalls RCL progress.
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

  /**
   * Get the spawn ID this corp spawns from.
   */
  getSpawnId(): string {
    return this.spawnId;
  }

  /**
   * Declare this corp's spawn demand for the scheduler.
   *
   * The upgrader is what drives RCL progress, so its demand is blocking when no
   * upgrader exists. Its value comes from the flow solution's controller-sink
   * priority, and it is sized to the allocated energy rate (but can be spawned
   * small and scaled up). It does not produce income - the scheduler's
   * wait-for-blocking logic is what lets it accumulate energy against a steady
   * trickle of mining demand.
   */
  /**
   * Decide how upgraders are fed, EXPLICITLY: "containerFed" when a container or
   * link sits at the controller (a per-tick buffer), otherwise "mobile". This one
   * choice drives both the body shape (WORK-heavy vs CARRY-heavy) and the runt
   * policy, so the corp commits to a single coherent strategy instead of mixing
   * conflicting signals. Logged on change so the active strategy is visible.
   */
  private getUpgraderStrategy(controller: StructureController): UpgraderStrategy {
    const buffers = controller.pos.findInRange(FIND_STRUCTURES, 3, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_LINK,
    });
    const strategy: UpgraderStrategy = buffers.length > 0 ? "containerFed" : "mobile";
    if (strategy !== this.lastStrategy) {
      console.log(`[Upgrading] ${this.id} strategy=${strategy} (controller buffers: ${buffers.length})`);
      this.lastStrategy = strategy;
    }
    return strategy;
  }

  getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    // Commit to a supply strategy up front; body shape and runt policy follow it.
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const controller = spawn?.room.controller;
    const strategy: UpgraderStrategy = controller
      ? this.getUpgraderStrategy(controller)
      : "mobile";

    // Energy/tick the controller is allocated; that is the WORK the upgraders
    // must total to consume it (1 energy/tick per WORK part). Without an
    // allocation, ask for a minimal upgrader to keep the controller alive.
    const allocated = this.sinkAllocation && this.sinkAllocation.allocated > 0
      ? this.sinkAllocation.allocated
      : 2;

    // One upgrader can only afford so many WORK parts at the current capacity;
    // a single small upgrader cannot consume a whole source. Size the COUNT to
    // the allocation, so consumption scales with supply (this is what lets a
    // second source actually help instead of being wasted).
    const affordableWork = Math.max(1, buildUpgraderBody(ctx.energyCapacity, 99, strategy).workParts);
    // Cap the count as a safety bound: should a stale/over-large allocation slip
    // through, we never spawn a swarm of upgraders. The plan keeps `allocated`
    // bounded by real supply in normal operation.
    const targetCount = Math.max(1, Math.min(UPGRADER_COUNT_CAP, Math.ceil(allocated / affordableWork)));
    const current = this.getCreepCount();
    if (current >= targetCount) return [];

    const remainingWork = allocated - current * affordableWork;
    const desiredWork = Math.max(1, Math.min(affordableWork, Math.ceil(remainingWork)));
    const desired = buildUpgraderBody(ctx.energyCapacity, desiredWork, strategy);
    // Runt policy follows the strategy. In containerFed mode the buffer keeps the
    // controller alive while we wait, so ADDITIONAL upgraders hold out for a
    // (near) full-size body instead of wasting a spawn slot on a 1-WORK creep -
    // the first upgrader still spawns cheap so the controller never downgrades. In
    // mobile mode there is no buffer, so a small upgrader now beats none.
    const minWork = strategy === "containerFed" && current > 0
      ? Math.max(1, affordableWork - 1)
      : 1;
    const min = buildUpgraderBody(ctx.energyCapacity, minWork, strategy);
    if (min.cost === 0) return []; // room cannot afford even a minimal upgrader

    return [{
      buyerCorpId: this.id,
      role: "upgrader",
      // Spawn priority is decoupled from the controller's ROUTING value (~50,
      // which keeps construction ranked above it). Consuming the energy the
      // plan budgets for upgrading is as essential as the producers/haulers that
      // supply it - otherwise producers win the queue forever and the budgeted
      // upgraders only trickle in via anti-starvation aging, so a second source
      // is mined and wasted. Rank them alongside haulers.
      value: 90,
      // The first upgrader is blocking (controller would otherwise stall);
      // additional upgraders are scaling capacity (non-blocking).
      blocking: current === 0,
      producesIncome: false,
      desiredCost: desired.cost,
      minCost: min.cost,
      since: 0,
      bodyParam: desiredWork,
      bodyStrategy: strategy,
    }];
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
