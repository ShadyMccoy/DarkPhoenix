/**
 * @fileoverview SpawningCorp - Market participant for creep spawning.
 *
 * SpawningCorp sells work-ticks (for miners/upgraders) and carry-ticks (for haulers).
 * When contracts are matched, it queues spawn orders and creates creeps.
 * This enables market-driven spawning where corps buy labor from spawns
 * regardless of room boundaries.
 *
 * @module corps/SpawningCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position, createOfferId, HAUL_PER_CARRY } from "../market/Offer";
import {
  BODY_PART_COST,
  CREEP_LIFETIME,
  calculateBodyCost,
  calculateSpawnTime,
} from "../planning/EconomicConstants";
import { buildMinerBody, buildHaulerBody, buildUpgraderBody } from "../spawn/BodyBuilder";
import { SpawningCorpState } from "./CorpState";

/**
 * Types of creeps that can be spawned
 */
export type SpawnableCreepType = "miner" | "hauler" | "upgrader" | "builder";

/**
 * A queued spawn order from a matched contract
 */
export interface SpawnOrder {
  /** Corp that bought the work-ticks or carry-ticks */
  buyerCorpId: string;
  /** Type of creep to spawn (derived from buyer corp type) */
  creepType: SpawnableCreepType;
  /** Work-ticks requested (determines body size for miners/upgraders) */
  workTicksRequested: number;
  /** Haul-demand requested (determines body size for haulers) */
  haulDemandRequested?: number;
  /** Contract ID for tracking */
  contractId: string;
  /** Tick when order was queued */
  queuedAt: number;
}

/**
 * Serialized state specific to SpawningCorp
 */
export interface SerializedSpawningCorp extends SerializedCorp {
  spawnId: string;
  pendingOrders: SpawnOrder[];
  energyCapacity: number;
  /** Tick when spawn first became stuck (couldn't afford any orders) */
  stuckSince: number;
  /** Names of maintenance haulers spawned by this corp */
  maintenanceHaulerNames: string[];
}

/**
 * Default work-ticks capacity per spawn per cycle.
 * Based on typical spawn throughput.
 */
const DEFAULT_WORK_TICKS_CAPACITY = CREEP_LIFETIME * 5; // 5 WORK parts worth

/**
 * Default carry-ticks capacity per spawn per cycle.
 * Based on typical spawn throughput for haulers.
 * 8 CARRY parts × 25 HAUL per CARRY = 200 HAUL capacity per creep.
 */
const DEFAULT_HAUL_CAPACITY = HAUL_PER_CARRY * 8; // 8 CARRY parts worth

/**
 * Maximum age of a pending order before it expires (in ticks).
 * Orders older than this are pruned to prevent queue buildup.
 * Set to ~2 creep lifetimes to give reasonable time for energy recovery.
 */
const ORDER_EXPIRATION_TICKS = CREEP_LIFETIME * 2; // 3000 ticks

/**
 * Maximum number of pending orders before new orders are rejected.
 * Prevents runaway queue growth when spawn is energy-starved.
 */
const MAX_PENDING_ORDERS = 10;

/**
 * Energy threshold below which spawn is considered "starving".
 * When starving with pending orders, spawn will prioritize maintenance haulers.
 */
const ENERGY_STARVATION_THRESHOLD = 200;

/**
 * Minimum ticks stuck before spawning a maintenance hauler.
 * Prevents spawning maintenance haulers too eagerly.
 */
const STARVATION_TICKS_THRESHOLD = 50;

/**
 * Minimum energy needed to spawn a tiny maintenance hauler.
 * 1 CARRY + 1 MOVE = 100 energy
 */
const MIN_MAINTENANCE_HAULER_COST = 100;

/**
 * SpawningCorp manages a spawn structure and sells work-ticks.
 *
 * This corp:
 * - Sells work-ticks (creep labor time)
 * - Buys energy to pay for spawning
 * - Queues spawn orders when contracts match
 * - Creates creeps with memory.corpId set to buyer
 */
export class SpawningCorp extends Corp {
  /** ID of the spawn structure */
  private spawnId: string;

  /** Pending spawn orders from matched contracts */
  private pendingOrders: SpawnOrder[] = [];

  /** Energy capacity available for spawning */
  private energyCapacity: number;

  /** Tick when spawn first became stuck (couldn't afford any orders) */
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
   * SpawningCorp sells work-ticks and carry-ticks capacity.
   * Price is based on amortized spawn cost over lifetime.
   */
  sells(): Offer[] {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return [];

    const offers: Offer[] = [];

    // Calculate work-ticks already committed in pending orders
    const pendingWorkTicks = this.pendingOrders
      .filter(o => o.creepType !== "hauler")
      .reduce((sum, order) => sum + order.workTicksRequested, 0);

    // Calculate carry-ticks already committed
    const pendingHaulDemand = this.pendingOrders
      .filter(o => o.creepType === "hauler")
      .reduce((sum, order) => sum + (order.haulDemandRequested ?? 0), 0);

    // Calculate available capacity (subtract pending commitments)
    const isSpawning = !!spawn.spawning;

    // Work-ticks offer
    const availableWorkTicks = isSpawning
      ? 0
      : Math.max(0, DEFAULT_WORK_TICKS_CAPACITY - pendingWorkTicks);

    if (availableWorkTicks > 0) {
      // Price per work-tick = spawn cost / lifetime
      // For a basic worker (WORK + CARRY + MOVE = 200 energy), lifetime = 1500
      const basicWorkerCost = BODY_PART_COST.work + BODY_PART_COST.carry + BODY_PART_COST.move;
      const costPerWorkTick = basicWorkerCost / CREEP_LIFETIME;
      const pricePerWorkTick = costPerWorkTick * (1 + this.getMargin());

      offers.push({
        id: createOfferId(this.id, "work-ticks", Game.time),
        corpId: this.id,
        type: "sell",
        resource: "work-ticks",
        quantity: availableWorkTicks,
        price: pricePerWorkTick * availableWorkTicks,
        duration: CREEP_LIFETIME,
        location: this.getPosition()
      });
    }

    // Carry-ticks offer (for haulers)
    const availableHaulCapacity = isSpawning
      ? 0
      : Math.max(0, DEFAULT_HAUL_CAPACITY - pendingHaulDemand);

    if (availableHaulCapacity > 0) {
      // Price per HAUL = (CARRY + MOVE cost) / (HAUL_PER_CARRY × lifetime)
      // Each CARRY part needs a MOVE part for 1:1 on roads
      const carryMoveCost = BODY_PART_COST.carry + BODY_PART_COST.move; // 100 energy
      const costPerHaul = carryMoveCost / (HAUL_PER_CARRY * CREEP_LIFETIME);
      const pricePerHaul = costPerHaul * (1 + this.getMargin());

      offers.push({
        id: createOfferId(this.id, "carry-ticks", Game.time),
        corpId: this.id,
        type: "sell",
        resource: "carry-ticks",
        quantity: availableHaulCapacity,
        price: pricePerHaul * availableHaulCapacity,
        duration: CREEP_LIFETIME,
        location: this.getPosition()
      });
    }

    return offers;
  }

  /**
   * SpawningCorp doesn't buy through the market.
   *
   * Energy is delivered to spawn/extensions by haulers as their Priority 1 behavior.
   * SpawningCorp just waits for spawn.store[RESOURCE_ENERGY] to fill up.
   * The "cost" of spawning is tracked when we actually spawn (recordCost in work()).
   */
  buys(): Offer[] {
    return [];
  }

  /**
   * Queue a spawn order from a matched contract.
   * Returns false if queue is full (order rejected).
   */
  queueSpawn(order: SpawnOrder): boolean {
    // Reject if queue is full to prevent runaway growth
    if (this.pendingOrders.length >= MAX_PENDING_ORDERS) {
      console.log(`[Spawning] Order rejected - queue full (${this.pendingOrders.length}/${MAX_PENDING_ORDERS})`);
      return false;
    }
    this.pendingOrders.push(order);
    return true;
  }

  /**
   * Clear all pending orders (emergency reset).
   * Use when the spawn queue is deadlocked.
   */
  clearPendingOrders(): number {
    const count = this.pendingOrders.length;
    this.pendingOrders = [];
    console.log(`[Spawning] Cleared ${count} pending orders from ${this.id}`);
    return count;
  }

  /**
   * Prune expired orders from the queue.
   * Called at the start of work() to clean up stale orders.
   */
  private pruneExpiredOrders(currentTick: number): void {
    const initialCount = this.pendingOrders.length;
    this.pendingOrders = this.pendingOrders.filter(order => {
      const age = currentTick - order.queuedAt;
      return age < ORDER_EXPIRATION_TICKS;
    });
    const prunedCount = initialCount - this.pendingOrders.length;
    if (prunedCount > 0) {
      console.log(`[Spawning] Pruned ${prunedCount} expired orders (age > ${ORDER_EXPIRATION_TICKS} ticks)`);
    }
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
   * Convert to SpawningCorpState for projection-based planning.
   *
   * SpawningCorp is the origin of labor in production chains.
   * The state includes spawn position and capacity for distance-aware pricing.
   */
  toCorpState(): SpawningCorpState {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const isSpawning = spawn ? !!spawn.spawning : false;

    return {
      id: this.id,
      type: "spawning",
      nodeId: this.nodeId,
      position: this.getPosition(),
      energyCapacity: this.energyCapacity,
      pendingOrderCount: this.pendingOrders.length,
      isSpawning,
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
   * Main work loop - process pending spawn orders.
   * Includes self-sustaining logic: if spawn is energy-starved and stuck,
   * it will spawn maintenance haulers using its own balance.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    // Prune expired orders to prevent queue buildup
    this.pruneExpiredOrders(tick);

    // Clean up dead maintenance haulers
    this.maintenanceHaulerNames = this.maintenanceHaulerNames.filter(n => Game.creeps[n]);

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn || spawn.spawning) return;

    const currentEnergy = spawn.store[RESOURCE_ENERGY];

    // Check if we're stuck (have orders but can't afford any of them)
    if (this.pendingOrders.length > 0) {
      const canAffordAny = this.pendingOrders.some(order => {
        const body = this.designBodyForOrder(order);
        const cost = this.calculateBodyCost(body);
        return currentEnergy >= cost;
      });

      if (!canAffordAny) {
        // We're stuck - track how long
        if (this.stuckSince === 0) {
          this.stuckSince = tick;
        }

        const ticksStuck = tick - this.stuckSince;

        // If stuck long enough and have enough for a maintenance hauler, spawn one
        if (ticksStuck >= STARVATION_TICKS_THRESHOLD &&
            currentEnergy >= MIN_MAINTENANCE_HAULER_COST &&
            this.maintenanceHaulerNames.length < 2) { // Max 2 maintenance haulers
          this.spawnMaintenanceHauler(spawn, tick);
          return;
        }
      } else {
        // Not stuck anymore
        this.stuckSince = 0;
      }
    } else {
      this.stuckSince = 0;
    }

    // Process pending orders - find one we can afford
    for (let i = 0; i < this.pendingOrders.length; i++) {
      const order = this.pendingOrders[i];
      const body = this.designBodyForOrder(order);
      const bodyCost = this.calculateBodyCost(body);

      // Skip orders we can't afford
      if (currentEnergy < bodyCost) continue;

      // Generate creep name
      const name = `${order.creepType}-${order.buyerCorpId.slice(-6)}-${tick}`;

      // Map creep type to workType
      const workTypeMap: Record<SpawnableCreepType, "harvest" | "haul" | "upgrade" | "build"> = {
        miner: "harvest",
        hauler: "haul",
        upgrader: "upgrade",
        builder: "build"
      };

      // Spawn the creep with corpId set to buyer
      const result = spawn.spawnCreep(body, name, {
        memory: {
          corpId: order.buyerCorpId,
          workType: workTypeMap[order.creepType],
          spawnedBy: this.id,
          contractId: order.contractId
        }
      });

      if (result === OK) {
        // Remove from queue and record cost
        this.pendingOrders.splice(i, 1);
        this.recordCost(bodyCost);
        this.stuckSince = 0; // Reset stuck timer on successful spawn

        // Track production based on creep type
        if (order.creepType === "hauler") {
          const carryParts = body.filter(p => p === CARRY).length;
          const haulCapacityProduced = carryParts * HAUL_PER_CARRY;
          this.recordProduction(haulCapacityProduced);
          console.log(`[Spawning] Spawned ${name} for ${order.buyerCorpId} (${carryParts} CARRY, ${haulCapacityProduced} HAUL, ${bodyCost} energy)`);
        } else {
          const workParts = body.filter(p => p === WORK).length;
          const workTicksProduced = workParts * CREEP_LIFETIME;
          this.recordProduction(workTicksProduced);
          console.log(`[Spawning] Spawned ${name} for ${order.buyerCorpId} (${workParts} WORK, ${bodyCost} energy)`);
        }
        return; // Only spawn one per tick
      }
    }
  }

  /**
   * Spawn a maintenance hauler to bring energy to the spawn.
   * This is paid for by SpawningCorp's own balance to break energy starvation.
   */
  private spawnMaintenanceHauler(spawn: StructureSpawn, tick: number): void {
    const currentEnergy = spawn.store[RESOURCE_ENERGY];

    // Build the biggest hauler we can afford with current energy
    // Each CARRY+MOVE pair costs 100 energy
    const pairsAffordable = Math.floor(currentEnergy / (BODY_PART_COST.carry + BODY_PART_COST.move));
    const pairs = Math.min(pairsAffordable, 5); // Cap at 5 pairs (10 parts) for maintenance hauler

    if (pairs < 1) return;

    const body: BodyPartConstant[] = [];
    for (let i = 0; i < pairs; i++) {
      body.push(CARRY);
    }
    for (let i = 0; i < pairs; i++) {
      body.push(MOVE);
    }

    const bodyCost = pairs * (BODY_PART_COST.carry + BODY_PART_COST.move);

    // Check if we have enough balance to pay for this
    if (this.balance < bodyCost) {
      console.log(`[Spawning] Cannot afford maintenance hauler (need ${bodyCost}, have ${this.balance})`);
      return;
    }

    // Find the hauling corp ID for this room (pattern: hauling-{roomName}-hauling-{suffix})
    const roomName = spawn.room.name;
    let haulingCorpId = `hauling-${roomName}-hauling`; // Base pattern

    // Look for the actual hauling corp ID in Memory or use the pattern
    // The actual ID has a suffix, but the hauling corp will pick up creeps with matching prefix
    // Actually, we need the exact ID. Let's use a different approach -
    // assign to a special "maintenance" corpId that the hauling corp can recognize
    const maintenanceCorpId = `${roomName}-hauling`; // This matches the nodeId pattern

    const name = `maint-hauler-${this.id.slice(-4)}-${tick}`;

    const result = spawn.spawnCreep(body, name, {
      memory: {
        corpId: maintenanceCorpId, // Will be picked up by room's HaulingCorp
        workType: "haul" as const,
        spawnedBy: this.id,
        isMaintenanceHauler: true
      }
    });

    if (result === OK) {
      this.maintenanceHaulerNames.push(name);
      this.recordCost(bodyCost); // SpawningCorp pays for this
      this.stuckSince = 0;
      console.log(`[Spawning] Spawned MAINTENANCE hauler ${name} (${pairs} CARRY, ${bodyCost} energy) - spawn was stuck!`);
    }
  }

  /**
   * Design a creep body for a spawn order.
   * Body type is determined by creepType and sized by workTicksRequested or haulDemandRequested.
   */
  private designBodyForOrder(order: SpawnOrder): BodyPartConstant[] {
    switch (order.creepType) {
      case "miner": {
        // Calculate desired WORK parts from work-ticks
        // work-ticks = WORK parts × lifetime
        const desiredWorkParts = Math.max(1, Math.ceil(order.workTicksRequested / CREEP_LIFETIME));
        const result = buildMinerBody(desiredWorkParts, this.energyCapacity);
        return result.body;
      }
      case "hauler": {
        // Calculate desired CARRY parts from carry-ticks
        // carry-ticks = CARRY parts × HAUL_PER_CARRY
        const haulDemand = order.haulDemandRequested ?? 100;
        const desiredCarryParts = Math.max(2, Math.ceil(haulDemand / HAUL_PER_CARRY));
        // Build hauler with 1:1 CARRY:MOVE ratio for full speed on roads
        const body: BodyPartConstant[] = [];
        const maxParts = Math.floor(this.energyCapacity / (BODY_PART_COST.carry + BODY_PART_COST.move));
        const actualCarryParts = Math.min(desiredCarryParts, maxParts, 25); // Max 50 body parts total
        for (let i = 0; i < actualCarryParts; i++) {
          body.push(CARRY);
        }
        for (let i = 0; i < actualCarryParts; i++) {
          body.push(MOVE);
        }
        return body;
      }
      case "upgrader": {
        const desiredWorkParts = Math.max(1, Math.ceil(order.workTicksRequested / CREEP_LIFETIME));
        const result = buildUpgraderBody(this.energyCapacity, desiredWorkParts);
        return result.body;
      }
      case "builder": {
        // Builders need WORK, CARRY, and MOVE in balanced proportions
        // Each set: 1 WORK + 1 CARRY + 1 MOVE = 200 energy
        const desiredWorkParts = Math.max(1, Math.ceil(order.workTicksRequested / CREEP_LIFETIME));
        const setSize = 200; // WORK(100) + CARRY(50) + MOVE(50)
        const maxSets = Math.floor(this.energyCapacity / setSize);
        const actualSets = Math.min(desiredWorkParts, maxSets, 16); // Max 48 parts (16 sets)

        const body: BodyPartConstant[] = [];
        for (let i = 0; i < actualSets; i++) {
          body.push(WORK);
        }
        for (let i = 0; i < actualSets; i++) {
          body.push(CARRY);
        }
        for (let i = 0; i < actualSets; i++) {
          body.push(MOVE);
        }
        return body.length > 0 ? body : [WORK, CARRY, MOVE];
      }
      default:
        // Fallback: basic worker
        return [WORK, CARRY, MOVE];
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

/**
 * Starting balance for new SpawningCorps.
 * Higher than other corps to allow spawning maintenance haulers
 * when the colony is energy-starved.
 */
const SPAWNING_CORP_STARTING_BALANCE = 3000;

/**
 * Create a SpawningCorp for a spawn structure.
 */
export function createSpawningCorp(
  spawn: StructureSpawn
): SpawningCorp {
  const nodeId = `${spawn.room.name}-spawn-${spawn.id.slice(-4)}`;
  const corp = new SpawningCorp(nodeId, spawn.id, spawn.room.energyCapacityAvailable);
  // Give SpawningCorp extra starting balance for self-sustaining maintenance
  corp.balance = SPAWNING_CORP_STARTING_BALANCE;
  return corp;
}
