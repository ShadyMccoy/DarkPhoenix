/**
 * @fileoverview RealUpgradingCorp - Manages actual upgrader creeps.
 *
 * Upgraders pick up energy near the controller and upgrade it.
 *
 * @module corps/RealUpgradingCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position, createOfferId } from "../market/Offer";
import {
  SPAWN_COOLDOWN,
  CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD,
} from "./CorpConstants";
import { buildUpgraderBody, UpgraderBodyResult } from "../spawn/BodyBuilder";

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
   * Upgrading corp doesn't sell anything - it's a pure consumer
   */
  sells(): Offer[] {
    return [];
  }

  /**
   * Upgrading corp buys delivered energy with urgency-based bidding.
   * Higher urgency = higher bid = gets served first by haulers.
   */
  buys(): Offer[] {
    const activeCreeps = this.creepNames.filter(n => Game.creeps[n]).length;
    if (activeCreeps === 0) return [];

    // Calculate urgency based on:
    // 1. Controller downgrade timer
    // 2. Current energy levels of upgraders
    const urgency = this.calculateUrgency();

    // Calculate how much energy we need
    const energyDeficit = this.creepNames.reduce((sum, name) => {
      const creep = Game.creeps[name];
      return sum + (creep ? creep.store.getFreeCapacity(RESOURCE_ENERGY) : 0);
    }, 0);

    if (energyDeficit === 0) return [];

    // Bid price = base value × urgency
    const bidPrice = BASE_ENERGY_VALUE * urgency;

    return [{
      id: createOfferId(this.id, "delivered-energy", Game.time),
      corpId: this.id,
      type: "buy",
      resource: "delivered-energy",
      quantity: energyDeficit,
      price: bidPrice,
      duration: 100,
      location: this.getPosition()
    }];
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

    // Calculate dynamic upgrader configuration based on available energy
    const { body, cost, maxUpgraders } = this.calculateUpgraderConfig(room, controller);

    // Try to spawn if we need more upgraders
    if (this.creepNames.length < maxUpgraders && body.length > 0) {
      this.trySpawn(spawn, tick, body, cost);
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
   * Calculate optimal upgrader configuration based on available energy.
   *
   * Scales upgraders based on:
   * - Room energy capacity (bigger bodies)
   * - Available energy near controller (more upgraders when energy is plentiful)
   */
  private calculateUpgraderConfig(room: Room, controller: StructureController): {
    body: BodyPartConstant[];
    cost: number;
    maxUpgraders: number;
  } {
    const energyCapacity = room.energyCapacityAvailable;

    // Build upgrader body scaled to room capacity
    const bodyResult = buildUpgraderBody(energyCapacity);

    if (bodyResult.workParts === 0) {
      return { body: [], cost: 0, maxUpgraders: 0 };
    }

    // Calculate max upgraders based on available energy near controller
    // This creates natural scaling: more energy → more upgraders → energy consumed
    const nearbyEnergy = this.getAvailableEnergyNearController(room, controller);

    // Base: 2 upgraders (minimum to keep controller healthy)
    // Bonus: +1 upgrader per 300 energy available (roughly one upgrader's worth of work time)
    const baseUpgraders = 2;
    const bonusUpgraders = Math.floor(nearbyEnergy / 300);
    const maxUpgraders = Math.min(baseUpgraders + bonusUpgraders, 6);

    return {
      body: bodyResult.body,
      cost: bodyResult.cost,
      maxUpgraders,
    };
  }

  /**
   * Get total energy available near the controller (dropped + containers).
   * This is the supply signal that drives upgrader scaling.
   */
  private getAvailableEnergyNearController(room: Room, controller: StructureController): number {
    // Find dropped energy near controller (range 5)
    const droppedEnergy = room.find(FIND_DROPPED_RESOURCES, {
      filter: (r) =>
        r.resourceType === RESOURCE_ENERGY &&
        r.pos.getRangeTo(controller) <= 5,
    }).reduce((sum, r) => sum + r.amount, 0);

    // Find container energy near controller (range 5)
    const containerEnergy = room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        s.pos.getRangeTo(controller) <= 5,
    }).reduce((sum, s) => sum + (s as StructureContainer).store[RESOURCE_ENERGY], 0);

    // Also count energy held by upgraders (they're already supplied)
    const upgraderEnergy = this.creepNames.reduce((sum, name) => {
      const creep = Game.creeps[name];
      return sum + (creep ? creep.store[RESOURCE_ENERGY] : 0);
    }, 0);

    return droppedEnergy + containerEnergy + upgraderEnergy;
  }

  /**
   * Attempt to spawn a new upgrader creep.
   *
   * @param spawn - The spawn to use
   * @param tick - Current game tick
   * @param body - Body parts array from calculateUpgraderConfig
   * @param cost - Energy cost of the body
   */
  private trySpawn(
    spawn: StructureSpawn,
    tick: number,
    body: BodyPartConstant[],
    cost: number
  ): void {
    if (tick - this.lastSpawnAttempt < SPAWN_COOLDOWN) {
      return;
    }

    if (spawn.spawning) {
      return;
    }

    if (spawn.store[RESOURCE_ENERGY] < cost) {
      return;
    }

    const name = `upgrader-${spawn.room.name}-${tick}`;

    const result = spawn.spawnCreep(body, name, {
      memory: {
        corpId: this.id,
        workType: "upgrade",
        working: false,
      },
    });

    this.lastSpawnAttempt = tick;

    if (result === OK) {
      this.creepNames.push(name);
      this.recordCost(cost);
      const workParts = body.filter((p) => p === WORK).length;
      console.log(
        `[Upgrading] Spawned ${name} with ${workParts} WORK parts (cost: ${cost})`
      );
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
