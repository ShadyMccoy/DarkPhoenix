/**
 * @fileoverview HaulingOperation - Clean implementation of hauling.
 *
 * ARCHITECTURE:
 * - Constructor takes corp IDs (dependencies from planner)
 * - Sells: haul-energy (delivered energy)
 * - Buys: carry-ticks (from SpawningCorp), energy (from MiningCorp)
 * - work() is pure: just runs creeps doing pickup/deliver
 *
 * The planner creates this with:
 *   new HaulingOperation(miningCorpId, spawningCorpId, destinationPosition)
 *
 * @module corps/HaulingOperation
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position, createOfferId, HAUL_PER_CARRY } from "../market/Offer";
import { CREEP_LIFETIME } from "../planning/EconomicConstants";

/** Transport fee per energy */
const TRANSPORT_FEE = 0.05;

/**
 * Serialized state for HaulingOperation
 */
export interface SerializedHaulingOperation extends SerializedCorp {
  miningCorpId: string;
  spawningCorpId: string;
  pickupPosition: Position;
  deliveryPosition: Position;
  creepNames: string[];
  targetHaulers: number;
}

/**
 * HaulingOperation - transports energy from source to destination.
 *
 * Dependencies (explicit in constructor):
 * - miningCorpId: where to pick up energy
 * - spawningCorpId: where to get carry-ticks from
 * - deliveryPosition: where to drop energy (spawn or controller)
 *
 * Buys: carry-ticks (haulers), energy (from miners)
 * Sells: haul-energy (delivered energy)
 */
export class HaulingOperation extends Corp {
  // === DEPENDENCIES (from planner) ===
  private readonly miningCorpId: string;
  private readonly spawningCorpId: string;

  // === ROUTE DATA (from planner) ===
  private pickupPosition: Position = { x: 0, y: 0, roomName: "" };
  private deliveryPosition: Position = { x: 0, y: 0, roomName: "" };

  // === RUNTIME STATE ===
  private creepNames: string[] = [];
  private targetHaulers: number = 1;

  /**
   * Create a hauling operation.
   *
   * @param miningCorpId - ID of the MiningCorp to pick up from
   * @param spawningCorpId - ID of the SpawningCorp to get haulers from
   */
  constructor(miningCorpId: string, spawningCorpId: string) {
    const nodeId = `hauling-${miningCorpId.slice(-8)}`;
    super("hauling", nodeId);
    this.miningCorpId = miningCorpId;
    this.spawningCorpId = spawningCorpId;
  }

  /**
   * Initialize route data from planner.
   */
  initializeRoute(pickupPosition: Position, deliveryPosition: Position, distance: number): void {
    this.pickupPosition = pickupPosition;
    this.deliveryPosition = deliveryPosition;
    // Calculate haulers needed based on distance
    // Higher distance = more haulers needed for same throughput
    this.targetHaulers = Math.max(1, Math.ceil(distance / 25));
  }

  // === SELLS: haul-energy (delivered energy) ===
  sells(): Offer[] {
    const creeps = this.getCreeps();
    if (creeps.length === 0) return [];

    // Calculate delivery capacity
    const TICKS_PER_DELIVERY = 50;
    const deliveryCapacity = creeps.reduce((sum, creep) => {
      const ttl = creep.ticksToLive ?? CREEP_LIFETIME;
      const capacity = creep.store.getCapacity();
      const deliveries = Math.floor(ttl / TICKS_PER_DELIVERY);
      return sum + (capacity * deliveries);
    }, 0);

    const availableCapacity = deliveryCapacity - this.committedDeliveredEnergy;
    if (availableCapacity <= 0) return [];

    const pricePerEnergy = TRANSPORT_FEE * (1 + this.getMargin());

    return [{
      id: createOfferId(this.id, "haul-energy", Game.time),
      corpId: this.id,
      type: "sell",
      resource: "haul-energy",
      quantity: availableCapacity,
      price: pricePerEnergy * availableCapacity,
      duration: CREEP_LIFETIME,
      location: this.deliveryPosition
    }];
  }

  // === BUYS: carry-ticks ===
  buys(): Offer[] {
    const offers: Offer[] = [];
    const currentHaulers = this.getCreeps().length;

    // Buy carry-ticks if below target
    if (currentHaulers < this.targetHaulers) {
      const capacity = 4 * HAUL_PER_CARRY; // Standard hauler

      offers.push({
        id: createOfferId(this.id, "carry-ticks", Game.time),
        corpId: this.id,
        type: "buy",
        resource: "carry-ticks",
        quantity: capacity,
        price: TRANSPORT_FEE * capacity * (1 + this.getMargin()),
        duration: CREEP_LIFETIME,
        location: this.pickupPosition
      });
    }

    return offers;
  }

  // === WORK: pure execution ===
  work(tick: number): void {
    this.lastActivityTick = tick;
    this.pickupCreeps();

    for (const creep of this.getCreeps()) {
      if (!creep.spawning) {
        this.runHauler(creep);
      }
    }
  }

  /**
   * Run hauler behavior - pure function of creep state.
   */
  private runHauler(creep: Creep): void {
    // Switch state based on energy
    if (creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.working = false;
    } else if (creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
    }

    if (creep.memory.working) {
      this.deliverEnergy(creep);
    } else {
      this.pickupEnergy(creep);
    }
  }

  private pickupEnergy(creep: Creep): void {
    // Find dropped energy near pickup position
    const room = Game.rooms[this.pickupPosition.roomName];
    if (!room) return;

    const dropped = room.find(FIND_DROPPED_RESOURCES, {
      filter: r => r.resourceType === RESOURCE_ENERGY
    });

    if (dropped.length > 0) {
      const target = creep.pos.findClosestByPath(dropped);
      if (target) {
        const result = creep.pickup(target);
        if (result === ERR_NOT_IN_RANGE) {
          creep.moveTo(target);
        } else if (result === OK) {
          const pickedUp = Math.min(target.amount, creep.store.getFreeCapacity());
          this.fulfillEnergyCommitment(pickedUp);
        }
      }
    }
  }

  private deliverEnergy(creep: Creep): void {
    // Deliver to spawn or drop at controller
    const room = Game.rooms[this.deliveryPosition.roomName];
    if (!room) return;

    // Find spawn that needs energy
    const spawns = room.find(FIND_MY_SPAWNS, {
      filter: s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
    });

    if (spawns.length > 0) {
      const target = spawns[0];
      const result = creep.transfer(target, RESOURCE_ENERGY);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
      } else if (result === OK) {
        this.recordProduction(creep.store[RESOURCE_ENERGY]);
        this.fulfillDeliveredEnergyCommitment(creep.store[RESOURCE_ENERGY]);
      }
      return;
    }

    // Otherwise drop at delivery position (controller area)
    const targetPos = new RoomPosition(
      this.deliveryPosition.x,
      this.deliveryPosition.y,
      this.deliveryPosition.roomName
    );
    if (creep.pos.getRangeTo(targetPos) > 2) {
      creep.moveTo(targetPos);
    } else {
      creep.drop(RESOURCE_ENERGY);
      this.recordProduction(creep.store[RESOURCE_ENERGY]);
      this.fulfillDeliveredEnergyCommitment(creep.store[RESOURCE_ENERGY]);
    }
  }

  private getCreeps(): Creep[] {
    return this.creepNames
      .map(name => Game.creeps[name])
      .filter((c): c is Creep => c !== undefined);
  }

  private pickupCreeps(): void {
    this.creepNames = this.creepNames.filter(name => Game.creeps[name]);

    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id && !this.creepNames.includes(name)) {
        this.creepNames.push(name);
        console.log(`[Hauling] Picked up hauler ${name}`);
      }
    }
  }

  getPosition(): Position {
    return this.pickupPosition;
  }

  plan(tick: number): void {
    super.plan(tick);
    // Could recalculate target based on throughput needs
  }

  serialize(): SerializedHaulingOperation {
    return {
      ...super.serialize(),
      miningCorpId: this.miningCorpId,
      spawningCorpId: this.spawningCorpId,
      pickupPosition: this.pickupPosition,
      deliveryPosition: this.deliveryPosition,
      creepNames: this.creepNames,
      targetHaulers: this.targetHaulers,
    };
  }

  deserialize(data: SerializedHaulingOperation): void {
    super.deserialize(data);
    this.pickupPosition = data.pickupPosition || { x: 0, y: 0, roomName: "" };
    this.deliveryPosition = data.deliveryPosition || { x: 0, y: 0, roomName: "" };
    this.creepNames = data.creepNames || [];
    this.targetHaulers = data.targetHaulers || 1;
  }
}
