/**
 * @fileoverview RealUpgradingCorp - Manages actual upgrader creeps.
 *
 * Upgraders pick up energy near the controller and upgrade it.
 *
 * @module corps/RealUpgradingCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position, createOfferId } from "../market/Offer";
import { CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD } from "./CorpConstants";
import { buildUpgraderBody, UpgraderBodyResult } from "../spawn/BodyBuilder";
import { CREEP_LIFETIME } from "../planning/EconomicConstants";
import { UpgradingCorpState } from "./CorpState";
import { projectUpgrading } from "../planning/projections";

/** Base value per energy for upgrading (what we're willing to pay) */
const BASE_ENERGY_VALUE = 0.5;

/** Urgency multiplier when controller is close to downgrading */
const DOWNGRADE_URGENCY_MULTIPLIER = 5.0;

/** Urgency multiplier when we have no energy */
const STARVATION_URGENCY_MULTIPLIER = 2.0;

/**
 * Serialized state specific to RealUpgradingCorp
 */
export interface SerializedRealUpgradingCorp extends SerializedCorp {
  spawnId: string;
  creepNames: string[];
  lastSpawnAttempt: number;
  targetUpgraders: number;
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

  /** Target number of upgraders (computed during planning) */
  private targetUpgraders: number = 2;

  constructor(nodeId: string, spawnId: string) {
    super("upgrading", nodeId);
    this.spawnId = spawnId;
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
      committedWorkTicks: this.committedWorkTicks,
      committedEnergy: this.committedEnergy,
      committedDeliveredEnergy: this.committedDeliveredEnergy,
      lastPlannedTick: this.lastPlannedTick
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
   * Upgrading corp buys work-ticks (upgrader creeps) and haul-energy (energy delivery).
   *
   * EXECUTION LOGIC (uses targets from planning):
   * - If current upgraders < target, request 1 more
   */
  buys(): Offer[] {
    const offers: Offer[] = [];

    // Count current active upgraders
    const currentUpgraders = this.creepNames.filter(name => Game.creeps[name]).length;

    // Request 1 upgrader if below target
    if (currentUpgraders < this.targetUpgraders) {
      const workTicksPerCreep = CREEP_LIFETIME;
      const pricePerWorkTick = BASE_ENERGY_VALUE * 2 * (1 + this.getMargin());

      offers.push({
        id: createOfferId(this.id, "work-ticks", Game.time),
        corpId: this.id,
        type: "buy",
        resource: "work-ticks",
        quantity: workTicksPerCreep,
        price: pricePerWorkTick * workTicksPerCreep,
        duration: CREEP_LIFETIME,
        location: this.getPosition()
      });
    }

    // Buy haul-energy - long-term contract based on upgrade capacity
    const activeCreeps = this.creepNames.filter(n => Game.creeps[n]).length;
    if (activeCreeps > 0) {
      const urgency = this.calculateUrgency();

      // Calculate long-term energy needs based on work capacity
      // Each WORK part consumes 1 energy per tick for upgrading
      const energyCapacity = this.creepNames.reduce((sum, name) => {
        const creep = Game.creeps[name];
        if (!creep) return sum;
        const ttl = creep.ticksToLive ?? CREEP_LIFETIME;
        const workParts = creep.getActiveBodyparts(WORK);
        return sum + (workParts * ttl); // energy consumed over remaining lifespan
      }, 0);

      // Subtract already-committed haul-energy to prevent double-ordering
      const energyNeeded = energyCapacity - this.committedDeliveredEnergy;

      if (energyNeeded > 0) {
        const bidPricePerUnit = BASE_ENERGY_VALUE * urgency;

        offers.push({
          id: createOfferId(this.id, "haul-energy", Game.time),
          corpId: this.id,
          type: "buy",
          resource: "haul-energy",
          quantity: energyNeeded,
          price: bidPricePerUnit * energyNeeded, // Total price for contract
          duration: CREEP_LIFETIME,
          location: this.getPosition()
        });
      }
    }

    return offers;
  }

  /**
   * Calculate urgency multiplier for bidding.
   * Higher urgency when:
   * - Controller is close to downgrading
   * - Upgraders have no energy
   */
  private calculateUrgency(): number {
    let urgency = 1.0;

    // Check controller downgrade timer
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn?.room.controller) {
      const controller = spawn.room.controller;
      const ticksToDowngrade = controller.ticksToDowngrade;
      const maxTicks = CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD;

      if (ticksToDowngrade < maxTicks * 0.1) {
        // Critical: less than 10% of safe threshold
        urgency *= DOWNGRADE_URGENCY_MULTIPLIER;
      } else if (ticksToDowngrade < maxTicks * 0.3) {
        // Warning: less than 30% of safe threshold
        urgency *= 2.0;
      }
    }

    // Check upgrader energy levels
    const totalEnergy = this.creepNames.reduce((sum, name) => {
      const creep = Game.creeps[name];
      return sum + (creep ? creep.store[RESOURCE_ENERGY] : 0);
    }, 0);

    const totalCapacity = this.creepNames.reduce((sum, name) => {
      const creep = Game.creeps[name];
      return sum + (creep ? creep.store.getCapacity() : 0);
    }, 0);

    if (totalCapacity > 0 && totalEnergy / totalCapacity < 0.2) {
      // Starving: less than 20% energy
      urgency *= STARVATION_URGENCY_MULTIPLIER;
    }

    return urgency;
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
   * Main work loop - pick up assigned creeps and run their behavior.
   * Spawning is handled by SpawningCorp via the market.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    // Pick up newly assigned creeps (spawned by SpawningCorp with our corpId)
    this.pickupAssignedCreeps();

    // Clean up dead creeps
    this.creepNames = this.creepNames.filter((name) => Game.creeps[name]);

    // Get spawn (for room reference)
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) {
      return;
    }

    const room = spawn.room;
    const controller = room.controller;
    if (!controller) {
      return;
    }

    // Run upgrader behavior for all creeps
    for (const name of this.creepNames) {
      const creep = Game.creeps[name];
      if (creep && !creep.spawning) {
        this.runUpgrader(creep, room, controller);
      }
    }
  }

  /**
   * Scan for creeps that were spawned for this corp and add them to our roster.
   */
  private pickupAssignedCreeps(): void {
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (
        creep.memory.corpId === this.id &&
        !this.creepNames.includes(name)
      ) {
        this.creepNames.push(name);
        console.log(`[Upgrading] Picked up upgrader ${name}`);
      }
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
        // Track energy consumed (1 energy per WORK part per tick)
        const workParts = creep.getActiveBodyparts(WORK);
        this.recordConsumption(workParts);
        // Track production: controller progress points generated
        this.recordProduction(workParts);
        // Revenue is recorded through market transactions
      }
    } else {
      // No energy - try to pick up nearby dropped energy (within range 1)
      const nearbyDropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY,
      });

      if (nearbyDropped.length > 0) {
        const target = nearbyDropped[0];
        const result = creep.pickup(target);
        if (result === OK) {
          // Fulfill delivered-energy commitment as we receive energy
          const pickedUp = Math.min(target.amount, creep.store.getFreeCapacity());
          this.fulfillDeliveredEnergyCommitment(pickedUp);
        }
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
      targetUpgraders: this.targetUpgraders,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedRealUpgradingCorp): void {
    super.deserialize(data);
    this.creepNames = data.creepNames || [];
    this.lastSpawnAttempt = data.lastSpawnAttempt || 0;
    this.targetUpgraders = data.targetUpgraders || 2;
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
