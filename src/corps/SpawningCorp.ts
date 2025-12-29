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
  getMaxSpawnCapacity,
} from "../planning/EconomicConstants";
import { buildMinerBody, buildUpgraderBody } from "../spawn/BodyBuilder";
import { HaulerRatio, MiningMode } from "../framework/EdgeVariant";

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

  // === EdgeVariant optimization (optional) ===

  /** Hauler CARRY:MOVE ratio for terrain optimization */
  haulerRatio?: HaulerRatio;

  /** Mining mode (affects harvester CARRY parts) */
  miningMode?: MiningMode;

  /** Extra CARRY parts for harvester (for drop mining decay reduction) */
  harvesterCarryParts?: number;
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
    energyCapacity: number = 300,
    customId?: string
  ) {
    super("spawning", nodeId, customId);
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
        const body = this.designBody(order.creepType, order.workTicksRequested, order);
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
      const body = this.designBody(order.creepType, order.workTicksRequested, order);
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
        const carryParts = body.filter(p => p === CARRY).length;
        const moveParts = body.filter(p => p === MOVE).length;
        const workTicksProduced = workParts * CREEP_LIFETIME;
        this.recordProduction(workTicksProduced);

        let partsInfo: string;
        if (order.creepType === "hauler") {
          const ratioStr = order.haulerRatio ? ` ${order.haulerRatio}` : "";
          partsInfo = `${carryParts}C${moveParts}M${ratioStr}`;
        } else {
          partsInfo = `${workParts} WORK`;
        }
        console.log(`[Spawning] Spawned ${name} for ${order.buyerCorpId} (${partsInfo}, ${bodyCost} energy)`);
        return;
      }
    }
  }

  /**
   * Design body for a creep type.
   * @param order - The spawn order (for variant-specific configuration)
   */
  private designBody(creepType: SpawnableCreepType, workParts: number = 5, order?: SpawnOrder): BodyPartConstant[] {
    switch (creepType) {
      case "miner": {
        const result = buildMinerBody(workParts, this.energyCapacity);
        const body = [...result.body];

        // Add CARRY parts for drop mining (reduces decay)
        const extraCarry = order?.harvesterCarryParts ?? 0;
        if (extraCarry > 0 && order?.miningMode === "drop") {
          const bodyCost = this.calculateBodyCost(body);
          const carryToAdd = Math.min(
            extraCarry,
            Math.floor((this.energyCapacity - bodyCost) / BODY_PART_COST.carry),
            50 - body.length // Body size limit
          );
          for (let i = 0; i < carryToAdd; i++) {
            body.push(CARRY);
          }
        }
        return body;
      }
      case "hauler": {
        // workParts represents requested CARRY parts for haulers
        const body: BodyPartConstant[] = [];

        // Get the CARRY:MOVE ratio from the order, default to 1:1
        const ratio = order?.haulerRatio ?? "1:1";
        const { carryRatio, moveRatio } = this.getPartRatios(ratio);

        // Calculate parts based on ratio
        const costPerUnit = (BODY_PART_COST.carry * carryRatio) + (BODY_PART_COST.move * moveRatio);
        const maxUnits = Math.floor(this.energyCapacity / costPerUnit);
        const partsPerUnit = carryRatio + moveRatio;
        const maxUnitsByBodySize = Math.floor(50 / partsPerUnit);

        // Calculate how many units we need for requested carry parts
        const unitsNeeded = Math.ceil(workParts / carryRatio);
        const actualUnits = Math.min(unitsNeeded, maxUnits, maxUnitsByBodySize);

        const actualCarryParts = actualUnits * carryRatio;
        const actualMoveParts = actualUnits * moveRatio;

        for (let i = 0; i < actualCarryParts; i++) {
          body.push(CARRY);
        }
        for (let i = 0; i < actualMoveParts; i++) {
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
   * Get CARRY:MOVE part counts for a ratio string.
   */
  private getPartRatios(ratio: HaulerRatio): { carryRatio: number; moveRatio: number } {
    switch (ratio) {
      case "2:1": return { carryRatio: 2, moveRatio: 1 }; // Road-optimized
      case "1:1": return { carryRatio: 1, moveRatio: 1 }; // Balanced (plains)
      case "1:2": return { carryRatio: 1, moveRatio: 2 }; // Swamp-capable
      default:    return { carryRatio: 1, moveRatio: 1 };
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
 * Uses max spawn capacity for the room's RCL so creeps are sized for
 * full capacity even while extensions are still being built.
 */
export function createSpawningCorp(
  spawn: StructureSpawn
): SpawningCorp {
  const nodeId = `${spawn.room.name}-spawn-${spawn.id.slice(-4)}`;
  const controllerLevel = spawn.room.controller?.level ?? 1;
  const maxCapacity = getMaxSpawnCapacity(controllerLevel);
  const corp = new SpawningCorp(nodeId, spawn.id, maxCapacity);
  corp.balance = SPAWNING_CORP_STARTING_BALANCE;
  return corp;
}
