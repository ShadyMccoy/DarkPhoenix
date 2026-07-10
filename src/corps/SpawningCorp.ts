/**
 * @fileoverview SpawningCorp - Manages spawn structures.
 *
 * SpawningCorp handles creep spawning based on demand from other corps.
 * Includes self-sustaining logic for energy starvation recovery.
 *
 * @module corps/SpawningCorp
 */

import { BODY_PART_COST, CREEP_LIFETIME, getMaxSpawnCapacity } from "../planning/EconomicConstants";
import { Corp, SerializedCorp } from "./Corp";
import { drawOrder } from "./refillCircuit";
import { HaulerRatio, MiningMode } from "../framework/EdgeVariant";
import {
  UpgraderStrategy,
  buildMinerBody,
  buildReserverBody,
  buildTankerBody,
  buildUpgraderBody
} from "../spawn/BodyBuilder";
import { Position } from "../types/Position";

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
  private stuckSince = 0;

  /** Names of maintenance haulers spawned by this corp */
  private maintenanceHaulerNames: string[] = [];

  public constructor(nodeId: string, spawnId: string, energyCapacity = 300, customId?: string) {
    super("spawning", nodeId, customId);
    this.spawnId = spawnId;
    this.energyCapacity = energyCapacity;
  }

  /**
   * Get the spawn position as the corp's location.
   */
  public getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  /**
   * Queue a spawn order.
   */
  public queueSpawnOrder(order: SpawnOrder): void {
    this.pendingOrders.push(order);
  }

  /**
   * Per-tick work. Spawning itself is now driven externally by the demand-based
   * scheduler (SpawnDirector -> executeSpawn); this only keeps liveness
   * bookkeeping current.
   */
  public work(tick: number): void {
    this.lastActivityTick = tick;
  }

  /**
   * Execute a scheduler decision: build the body for the chosen role within the
   * granted energy budget and spawn it. Returns true if a creep was spawned.
   *
   * This is the executor half of the demand-driven spawn pipeline: the
   * SpawnScheduler decides WHAT to spawn and HOW MUCH energy to spend; this maps
   * that to an actual body and a spawnCreep call.
   */
  public executeSpawn(
    role: "miner" | "hauler" | "upgrader" | "builder" | "scout" | "tanker" | "reserver",
    buyerCorpId: string,
    energyBudget: number,
    tick: number,
    bodyParam?: number,
    haulerRatio?: HaulerRatio,
    bodyStrategy?: string
  ): boolean {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn || spawn.spawning) return false;

    const body = this.buildBodyForRole(role, energyBudget, bodyParam, haulerRatio, bodyStrategy);
    if (body.length === 0) return false;

    const bodyCost = this.calculateBodyCost(body);
    if (spawn.room.energyAvailable < bodyCost) return false;

    const workTypeMap: Record<string, "harvest" | "haul" | "tank" | "upgrade" | "build" | "scout" | "reserve"> = {
      miner: "harvest",
      hauler: "haul",
      upgrader: "upgrade",
      builder: "build",
      scout: "scout",
      reserver: "reserve",
      // A tanker (carrier) is an INTRA-node feeder: it shuttles energy between
      // local sinks and sources within one node (e.g. a hauler's drop-off -> the
      // builder). That is a different job from a hauler, which does long-range
      // INTER-node transport - even though both are CARRY+MOVE creeps. Keep them
      // distinct so the economy can reason about (and instrument) each.
      tanker: "tank"
    };
    const name = `${role}-${buyerCorpId.slice(-6)}-${tick}`;
    // Drain in refill-circuit order (owner directive): spawning empties the
    // same stops in the same sequence the refill bus tops them up, so holes
    // form one contiguous run along the tour instead of scattered potholes.
    const energyStructures = drawOrder(spawn.room);
    const result = spawn.spawnCreep(body, name, {
      memory: { corpId: buyerCorpId, workType: workTypeMap[role], spawnedBy: this.id },
      ...(energyStructures.length > 0 ? { energyStructures } : {})
    });

    if (result === OK) {
      this.recordCost(bodyCost);
      const workParts = body.filter(p => p === WORK).length;
      this.recordProduction(workParts * CREEP_LIFETIME);
      const carryParts = body.filter(p => p === CARRY).length;
      const partsInfo = role === "hauler" ? `${carryParts}C` : `${workParts}W`;
      console.log(`[Spawning] Spawned ${name} (${partsInfo}, ${bodyCost} energy)`);
      return true;
    }
    return false;
  }

  /**
   * Build a body for the given role that costs at most `energyBudget`.
   */
  private buildBodyForRole(
    role: "miner" | "hauler" | "upgrader" | "builder" | "scout" | "tanker" | "reserver",
    energyBudget: number,
    bodyParam?: number,
    haulerRatio?: HaulerRatio,
    bodyStrategy?: string
  ): BodyPartConstant[] {
    switch (role) {
      case "miner":
        // CARRY only for link-fed miners (the one job that uses it).
        return buildMinerBody(bodyParam ?? 5, energyBudget, bodyStrategy === "linkFed").body;
      case "upgrader":
        return buildUpgraderBody(energyBudget, bodyParam ?? 5, bodyStrategy as UpgraderStrategy | undefined).body;
      case "builder":
        return buildUpgraderBody(energyBudget, 2).body;
      case "tanker":
        // Pure CARRY+MOVE feeder; bodyParam is the desired CARRY parts.
        return buildTankerBody(bodyParam ?? 4, energyBudget, false).body;
      case "scout":
        return [MOVE];
      case "reserver":
        // bodyParam is the desired CLAIM count; defaults to 2.
        return buildReserverBody(energyBudget, bodyParam ?? 2).body;
      case "hauler": {
        const { carryRatio, moveRatio } = this.getPartRatios(haulerRatio ?? "1:1");
        const costPerUnit = BODY_PART_COST.carry * carryRatio + BODY_PART_COST.move * moveRatio;
        const partsPerUnit = carryRatio + moveRatio;
        const maxByBudget = Math.floor(energyBudget / costPerUnit);
        const maxBySize = Math.floor(50 / partsPerUnit);
        const desiredUnits = bodyParam ? Math.ceil(bodyParam / carryRatio) : maxByBudget;
        const units = Math.max(1, Math.min(desiredUnits, maxByBudget, maxBySize));
        if (units < 1) return [];
        const body: BodyPartConstant[] = [];
        for (let i = 0; i < units * carryRatio; i++) body.push(CARRY);
        for (let i = 0; i < units * moveRatio; i++) body.push(MOVE);
        return body;
      }
    }
  }

  /**
   * Get CARRY:MOVE part counts for a ratio string.
   */
  private getPartRatios(ratio: HaulerRatio): { carryRatio: number; moveRatio: number } {
    switch (ratio) {
      case "2:1":
        return { carryRatio: 2, moveRatio: 1 }; // Road-optimized
      case "1:1":
        return { carryRatio: 1, moveRatio: 1 }; // Balanced (plains)
      case "1:2":
        return { carryRatio: 1, moveRatio: 2 }; // Swamp-capable
      default:
        return { carryRatio: 1, moveRatio: 1 };
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
  public getPendingOrderCount(): number {
    return this.pendingOrders.length;
  }

  /**
   * Get number of pending orders queued by a specific buyer corp.
   *
   * Buyer corps use this to avoid re-queueing a creep they have already
   * requested but that has not spawned yet (e.g. while the spawn is busy or
   * out of energy), which otherwise floods the queue with duplicates.
   */
  public countPendingOrdersFrom(buyerCorpId: string): number {
    return this.pendingOrders.filter(order => order.buyerCorpId === buyerCorpId).length;
  }

  /**
   * Clear all pending spawn orders.
   * Used to recover from stale/invalid orders in the queue.
   */
  public clearPendingOrders(): number {
    const count = this.pendingOrders.length;
    this.pendingOrders = [];
    this.stuckSince = 0;
    return count;
  }

  /**
   * Get the spawn ID.
   */
  public getSpawnId(): string {
    return this.spawnId;
  }

  /**
   * Serialize for persistence.
   */
  public serialize(): SerializedSpawningCorp {
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
  public deserialize(data: SerializedSpawningCorp): void {
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
export function createSpawningCorp(spawn: StructureSpawn): SpawningCorp {
  const nodeId = `${spawn.room.name}-spawn-${spawn.id.slice(-4)}`;
  const controllerLevel = spawn.room.controller?.level ?? 1;
  const maxCapacity = getMaxSpawnCapacity(controllerLevel);
  const corp = new SpawningCorp(nodeId, spawn.id, maxCapacity);
  corp.balance = SPAWNING_CORP_STARTING_BALANCE;
  return corp;
}
