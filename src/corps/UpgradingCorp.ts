/**
 * @fileoverview UpgradingCorp - Manages upgrader creeps.
 *
 * Upgraders pick up energy near the controller and upgrade it.
 *
 * @module corps/UpgradingCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position } from "../market/Offer";
import { CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD } from "./CorpConstants";
import { UpgradingCorpState } from "./CorpState";
import { projectUpgrading } from "../planning/projections";
import {
  Contract,
  isActive,
  canRequestCreep,
  requestCreep,
  replacementsNeeded
} from "../market/Contract";
import { getMarket } from "../market/Market";

/**
 * Serialized state specific to UpgradingCorp
 */
export interface SerializedUpgradingCorp extends SerializedCorp {
  spawnId: string;
  targetUpgraders: number;
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

  constructor(nodeId: string, spawnId: string) {
    super("upgrading", nodeId);
    this.spawnId = spawnId;
  }

  /**
   * Get active creeps assigned to this corp from contracts.
   * Reads from buy contracts where we purchased spawning capacity.
   */
  private getActiveCreeps(): Creep[] {
    const market = getMarket();
    const creeps: Creep[] = [];
    const seen = new Set<string>();

    for (const localContract of this.contracts) {
      if (localContract.buyerId !== this.id) continue;
      if (localContract.resource !== "spawning") continue;
      if (!isActive(localContract, Game.time)) continue;

      const contract = market.getContract(localContract.id) ?? localContract;
      for (const creepName of contract.creepIds) {
        if (seen.has(creepName)) continue;
        seen.add(creepName);

        const creep = Game.creeps[creepName];
        if (creep && !creep.spawning) {
          creeps.push(creep);
        }
      }
    }

    return creeps;
  }

  /**
   * Upgrading corp sells rcl-progress (controller upgrade points).
   *
   * Delegates to projectUpgrading() for unified offer calculation.
   * RCL progress is the terminal value sink - it "mints" credits in the economy.
   */
  sells(): Offer[] {
    const state = this.toCorpState();
    const projection = projectUpgrading(state, Game.time);
    return projection.sells;
  }

  /**
   * Convert current runtime state to UpgradingCorpState for projection.
   * Bridges runtime (actual creeps) to planning model (CorpState).
   */
  toCorpState(): UpgradingCorpState {
    // Get spawn and controller positions
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const spawnPosition = spawn
      ? { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName }
      : null;

    const controller = spawn?.room.controller;
    const controllerPosition = controller
      ? { x: controller.pos.x, y: controller.pos.y, roomName: controller.pos.roomName }
      : this.getPosition();

    const controllerLevel = controller?.level ?? 1;

    return {
      id: this.id,
      type: "upgrading",
      nodeId: this.nodeId,
      spawningCorpId: this.spawnId,
      position: controllerPosition,
      controllerLevel,
      spawnPosition,
      // Economic state from Corp base class
      balance: this.balance,
      totalRevenue: this.totalRevenue,
      totalCost: this.totalCost,
      createdAt: this.createdAt,
      isActive: this.isActive,
      lastActivityTick: this.lastActivityTick,
      unitsProduced: this.unitsProduced,
      expectedUnitsProduced: this.expectedUnitsProduced,
      unitsConsumed: this.unitsConsumed,
      acquisitionCost: this.acquisitionCost,
      lastPlannedTick: this.lastPlannedTick,
      contracts: this.contracts
    };
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

    // Base target: 1 upgrader at RCL 1-2, 2 at RCL 3+
    let target = rcl <= 2 ? 1 : 2;

    // Increase if controller is at risk of downgrading
    if (controller.ticksToDowngrade < CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD * 0.3) {
      target = Math.max(target, 3);
    }

    this.targetUpgraders = target;
  }

  /**
   * Upgrading corp buys delivered-energy and spawn-capacity.
   *
   * Delegates to projectUpgrading() for unified offer calculation.
   */
  buys(): Offer[] {
    const state = this.toCorpState();
    const projection = projectUpgrading(state, Game.time);
    return projection.buys;
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
   * @deprecated Use execute() for contract-driven execution
   */
  work(tick: number): void {
    this.execute(this.contracts, tick);
  }

  /**
   * Execute work to fulfill contracts.
   * Contracts drive the work - creeps assigned to contracts do upgrading.
   */
  execute(contracts: Contract[], tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    const room = spawn.room;
    const controller = room.controller;
    if (!controller) return;

    const market = getMarket();

    // Get buy contracts for spawning (we buy from SpawningCorp)
    const buyContracts = contracts.filter(
      c => c.buyerId === this.id && c.resource === "spawning" && isActive(c, tick)
    );

    // Execute upgrading for creeps assigned to our buy contracts
    for (const contract of buyContracts) {
      const marketContract = market.getContract(contract.id) ?? contract;

      // Request creeps using the option mechanism
      this.requestCreepsForContract(marketContract);

      for (const creepName of marketContract.creepIds) {
        const creep = Game.creeps[creepName];
        if (creep && !creep.spawning) {
          this.runUpgrader(creep, room, controller);
        }
      }
    }
  }

  /**
   * Request creeps from a spawn contract using the option mechanism.
   * Requests initial creeps or replacements for dying creeps.
   */
  private requestCreepsForContract(contract: Contract): void {
    if (contract.creepIds.length === 0 && canRequestCreep(contract)) {
      requestCreep(contract);
      return;
    }

    const numReplacements = replacementsNeeded(contract, (creepId) => {
      const creep = Game.creeps[creepId];
      return creep?.ticksToLive;
    });

    for (let i = 0; i < numReplacements; i++) {
      if (!requestCreep(contract)) break;
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
      const result = creep.upgradeController(controller);
      if (result === OK) {
        const workParts = creep.getActiveBodyparts(WORK);
        this.recordConsumption(workParts);
        this.recordProduction(workParts);
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
   * Get number of active upgrader creeps from contracts.
   */
  getCreepCount(): number {
    return this.getActiveCreeps().length;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedUpgradingCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      targetUpgraders: this.targetUpgraders,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedUpgradingCorp): void {
    super.deserialize(data);
    this.targetUpgraders = data.targetUpgraders || 2;
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
