/**
 * @fileoverview SpawningCorp - Manages spawn structures.
 *
 * SpawningCorp handles creep spawning based on demand from other corps.
 * Includes self-sustaining logic for energy starvation recovery.
 *
 * @module corps/SpawningCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Position } from "../types/Position";
import {
  BODY_PART_COST,
  CREEP_LIFETIME,
} from "../planning/EconomicConstants";
import { buildMinerBody, buildUpgraderBody } from "../spawn/BodyBuilder";

/**
 * Types of creeps that can be spawned
 */
export type SpawnableCreepType = "miner" | "hauler" | "upgrader" | "builder" | "scout";

/**
 * A queued spawn order
 */
export interface SpawnOrder {
  buyerCorpId: string;
  creepType: SpawnableCreepType;
  workTicksRequested: number;
  haulDemandRequested?: number;
  queuedAt: number;
}

/**
 * Serialized state specific to SpawningCorp
 */
export interface SerializedSpawningCorp extends SerializedCorp {
  spawnId: string;
  pendingOrders: SpawnOrder[];
  energyCapacity: number;
  stuckSince: number;
  maintenanceHaulerNames: string[];
}

const STARVATION_TICKS_THRESHOLD = 50;
const MIN_MAINTENANCE_HAULER_COST = 100;

/**
 * SpawningCorp manages a spawn structure.
 */
export class SpawningCorp extends Corp {
  /** ID of the spawn structure */
  private spawnId: string;

  /** Energy capacity available for spawning */
  private energyCapacity: number;

  /** Pending spawn orders */
  private pendingOrders: SpawnOrder[] = [];

  /** Tick when spawn first became stuck */
  private stuckSince: number = 0;

  /** Names of maintenance haulers spawned by this corp */
  private maintenanceHaulerNames: string[] = [];

  constructor(
    nodeId: string,
    spawnId: string,
    energyCapacity: number = 300
  ) {
    super("spawning", nodeId);
    this.spawnId = spawnId;
    this.energyCapacity = energyCapacity;
  }

  /**
   * Get the spawn position as the corp's location.
   */
  getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  /**
   * Queue a spawn order.
   */
  queueSpawnOrder(order: SpawnOrder): void {
    this.pendingOrders.push(order);
  }

  /**
   * Main work loop - process spawn orders.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    // Clean up dead maintenance haulers
    this.maintenanceHaulerNames = this.maintenanceHaulerNames.filter(n => Game.creeps[n]);

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn || spawn.spawning) return;

    const currentEnergy = spawn.room.energyAvailable;

    // Check if we're stuck (have pending orders but can't afford any)
    if (this.pendingOrders.length > 0) {
      const canAffordAny = this.pendingOrders.some(order => {
        const body = this.designBody(order.creepType, order.workTicksRequested);
        const cost = this.calculateBodyCost(body);
        return currentEnergy >= cost;
      });

      if (!canAffordAny) {
        if (this.stuckSince === 0) {
          this.stuckSince = tick;
        }

        const ticksStuck = tick - this.stuckSince;

        if (ticksStuck >= STARVATION_TICKS_THRESHOLD &&
            currentEnergy >= MIN_MAINTENANCE_HAULER_COST &&
            this.maintenanceHaulerNames.length < 2) {
          this.spawnMaintenanceHauler(spawn, tick);
          return;
        }
      } else {
        this.stuckSince = 0;
      }
    } else {
      this.stuckSince = 0;
    }

    // Sort orders by priority (miners first)
    const priorityOrder: SpawnableCreepType[] = ["miner", "hauler", "upgrader", "builder", "scout"];
    this.pendingOrders.sort((a, b) =>
      priorityOrder.indexOf(a.creepType) - priorityOrder.indexOf(b.creepType)
    );

    // Process orders
    for (let i = 0; i < this.pendingOrders.length; i++) {
      const order = this.pendingOrders[i];
      const body = this.designBody(order.creepType, order.workTicksRequested);
      const bodyCost = this.calculateBodyCost(body);

      if (currentEnergy < bodyCost) continue;

      const name = `${order.creepType}-${order.buyerCorpId.slice(-6)}-${tick}`;

      const workTypeMap: Record<SpawnableCreepType, "harvest" | "haul" | "upgrade" | "build" | "scout"> = {
        miner: "harvest",
        hauler: "haul",
        upgrader: "upgrade",
        builder: "build",
        scout: "scout"
      };

      const result = spawn.spawnCreep(body, name, {
        memory: {
          corpId: order.buyerCorpId,
          workType: workTypeMap[order.creepType],
          spawnedBy: this.id,
        }
      });

      if (result === OK) {
        this.recordCost(bodyCost);
        this.stuckSince = 0;
        this.pendingOrders.splice(i, 1);

        const workParts = body.filter(p => p === WORK).length;
        const workTicksProduced = workParts * CREEP_LIFETIME;
        this.recordProduction(workTicksProduced);

        console.log(`[Spawning] Spawned ${name} for ${order.buyerCorpId} (${workParts} WORK, ${bodyCost} energy)`);
        return;
      }
    }
  }

  /**
   * Design body for a creep type.
   */
  private designBody(creepType: SpawnableCreepType, workParts: number = 5): BodyPartConstant[] {
    switch (creepType) {
      case "miner": {
        const result = buildMinerBody(workParts, this.energyCapacity);
        return result.body;
      }
      case "hauler": {
        const body: BodyPartConstant[] = [];
        const maxParts = Math.floor(this.energyCapacity / (BODY_PART_COST.carry + BODY_PART_COST.move));
        const actualCarryParts = Math.min(8, maxParts, 25);
        for (let i = 0; i < actualCarryParts; i++) {
          body.push(CARRY);
        }
        for (let i = 0; i < actualCarryParts; i++) {
          body.push(MOVE);
        }
        return body;
      }
      case "upgrader": {
        const result = buildUpgraderBody(this.energyCapacity, workParts);
        return result.body;
      }
      case "builder": {
        const result = buildUpgraderBody(this.energyCapacity, 2);
        return result.body;
      }
      case "scout": {
        return [MOVE];
      }
      default:
        return [WORK, CARRY, MOVE];
    }
  }

  /**
   * Spawn a maintenance hauler to break energy starvation.
   */
  private spawnMaintenanceHauler(spawn: StructureSpawn, tick: number): void {
    const currentEnergy = spawn.room.energyAvailable;
    const pairsAffordable = Math.floor(currentEnergy / (BODY_PART_COST.carry + BODY_PART_COST.move));
    const pairs = Math.min(pairsAffordable, 5);

    if (pairs < 1) return;

    const body: BodyPartConstant[] = [];
    for (let i = 0; i < pairs; i++) {
      body.push(CARRY);
    }
    for (let i = 0; i < pairs; i++) {
      body.push(MOVE);
    }

    const bodyCost = pairs * (BODY_PART_COST.carry + BODY_PART_COST.move);

    if (this.balance < bodyCost) return;

    const roomName = spawn.room.name;
    const maintenanceCorpId = `${roomName}-hauling`;
    const name = `maint-hauler-${this.id.slice(-4)}-${tick}`;

    const result = spawn.spawnCreep(body, name, {
      memory: {
        corpId: maintenanceCorpId,
        workType: "haul" as const,
        spawnedBy: this.id,
        isMaintenanceHauler: true
      }
    });

    if (result === OK) {
      this.maintenanceHaulerNames.push(name);
      this.recordCost(bodyCost);
      this.stuckSince = 0;
      console.log(`[Spawning] Spawned MAINTENANCE hauler ${name} (${pairs} CARRY, ${bodyCost} energy)`);
    }
  }

  /**
   * Calculate energy cost of a body.
   */
  private calculateBodyCost(body: BodyPartConstant[]): number {
    const costs: Record<BodyPartConstant, number> = {
      [WORK]: 100,
      [CARRY]: 50,
      [MOVE]: 50,
      [ATTACK]: 80,
      [RANGED_ATTACK]: 150,
      [HEAL]: 250,
      [CLAIM]: 600,
      [TOUGH]: 10
    };
    return body.reduce((sum, part) => sum + costs[part], 0);
  }

  /**
   * Get number of pending orders.
   */
  getPendingOrderCount(): number {
    return this.pendingOrders.length;
  }

  /**
   * Clear all pending spawn orders.
   * Used to recover from stale/invalid orders in the queue.
   */
  clearPendingOrders(): number {
    const count = this.pendingOrders.length;
    this.pendingOrders = [];
    this.stuckSince = 0;
    return count;
  }

  /**
   * Get the spawn ID.
   */
  getSpawnId(): string {
    return this.spawnId;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedSpawningCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      pendingOrders: this.pendingOrders,
      energyCapacity: this.energyCapacity,
      stuckSince: this.stuckSince,
      maintenanceHaulerNames: this.maintenanceHaulerNames
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedSpawningCorp): void {
    super.deserialize(data);
    this.pendingOrders = data.pendingOrders || [];
    this.energyCapacity = data.energyCapacity || 300;
    this.stuckSince = data.stuckSince || 0;
    this.maintenanceHaulerNames = data.maintenanceHaulerNames || [];
  }
}

const SPAWNING_CORP_STARTING_BALANCE = 3000;

/**
 * Create a SpawningCorp for a spawn structure.
 */
export function createSpawningCorp(
  spawn: StructureSpawn
): SpawningCorp {
  const nodeId = `${spawn.room.name}-spawn-${spawn.id.slice(-4)}`;
  const corp = new SpawningCorp(nodeId, spawn.id, spawn.room.energyCapacityAvailable);
  corp.balance = SPAWNING_CORP_STARTING_BALANCE;
  return corp;
}
