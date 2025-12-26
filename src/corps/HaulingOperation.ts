/**
 * @fileoverview HaulingOperation - Clean implementation of hauling.
 *
 * @module corps/HaulingOperation
 */

import { Corp, SerializedCorp } from "./Corp";
import { Position } from "../types/Position";
import { CREEP_LIFETIME } from "../planning/EconomicConstants";
import { MiningOperation } from "./MiningOperation";

/**
 * Serialized state for HaulingOperation
 */
export interface SerializedHaulingOperation extends SerializedCorp {
  miningCorpId: string;
  spawningCorpId: string;
  deliveryPosition: Position;
  creepNames: string[];
  targetHaulers: number;
}

/**
 * HaulingOperation - transports energy from source to destination.
 */
export class HaulingOperation extends Corp {
  private readonly miningOp: MiningOperation;
  private readonly spawningCorpId: string;
  private readonly deliveryPosition: Position;
  private creepNames: string[] = [];
  private targetHaulers: number = 1;

  constructor(miningOp: MiningOperation, spawningCorpId: string, deliveryPosition: Position) {
    const nodeId = `hauling-${miningOp.id.slice(-8)}`;
    super("hauling", nodeId);
    this.miningOp = miningOp;
    this.spawningCorpId = spawningCorpId;
    this.deliveryPosition = deliveryPosition;

    const distance = this.calculateDistance();
    this.targetHaulers = Math.max(1, Math.ceil(distance / 25));
  }

  private get pickupPosition(): Position {
    return this.miningOp.getPosition();
  }

  private calculateDistance(): number {
    const pickup = this.pickupPosition;
    const delivery = this.deliveryPosition;
    return Math.abs(pickup.x - delivery.x) + Math.abs(pickup.y - delivery.y);
  }

  work(tick: number): void {
    this.lastActivityTick = tick;
    this.pickupCreeps();

    for (const creep of this.getCreeps()) {
      if (!creep.spawning) {
        this.runHauler(creep);
      }
    }
  }

  private runHauler(creep: Creep): void {
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
        }
      }
    }
  }

  private deliverEnergy(creep: Creep): void {
    const room = Game.rooms[this.deliveryPosition.roomName];
    if (!room) return;

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
      }
      return;
    }

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
    const distance = this.calculateDistance();
    this.targetHaulers = Math.max(1, Math.ceil(distance / 25));
  }

  serialize(): SerializedHaulingOperation {
    return {
      ...super.serialize(),
      miningCorpId: this.miningOp.id,
      spawningCorpId: this.spawningCorpId,
      deliveryPosition: this.deliveryPosition,
      creepNames: this.creepNames,
      targetHaulers: this.targetHaulers,
    };
  }

  deserialize(data: SerializedHaulingOperation): void {
    super.deserialize(data);
    this.creepNames = data.creepNames || [];
    this.targetHaulers = data.targetHaulers || 1;
  }

  getMiningOperation(): MiningOperation {
    return this.miningOp;
  }
}
