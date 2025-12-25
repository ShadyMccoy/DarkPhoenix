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
import { Offer, Position, HAUL_PER_CARRY } from "../market/Offer";
import {
  BODY_PART_COST,
  CREEP_LIFETIME,
} from "../planning/EconomicConstants";
import { buildMinerBody, buildUpgraderBody } from "../spawn/BodyBuilder";
import { SpawningCorpState } from "./CorpState";
import { projectSpawning } from "../planning/projections";
import {
  hasPendingRequests,
  fulfillCreepRequest,
  Contract,
  isActive
} from "../market/Contract";

/**
 * Types of creeps that can be spawned
 */
export type SpawnableCreepType = "miner" | "hauler" | "upgrader" | "builder" | "scout";

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
 * Spawn priority by creep type (lower = higher priority).
 * Miners are spawned first since they produce energy that everything else needs.
 */
const SPAWN_PRIORITY: Record<SpawnableCreepType, number> = {
  miner: 1,
  hauler: 2,
  upgrader: 3,
  builder: 4,
  scout: 5
};

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
   * SpawningCorp sells spawn-capacity.
   *
   * Delegates to projectSpawning() for unified offer calculation.
   */
  sells(): Offer[] {
    const state = this.toCorpState();
    const projection = projectSpawning(state, Game.time);
    return projection.sells;
  }

  /**
   * SpawningCorp buys delivered-energy (for extensions refill).
   *
   * Delegates to projectSpawning() for unified offer calculation.
   */
  buys(): Offer[] {
    const state = this.toCorpState();
    const projection = projectSpawning(state, Game.time);
    return projection.buys;
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
      pendingOrderCount: this.getPendingOrderCount(),
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
   * Main work loop - process contracts with pending spawn requests.
   * Only spawns when a buyer corp has requested a creep via the contract.
   * Includes self-sustaining logic for energy starvation recovery.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    // Clean up dead maintenance haulers
    this.maintenanceHaulerNames = this.maintenanceHaulerNames.filter(n => Game.creeps[n]);

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn || spawn.spawning) return;

    const currentEnergy = spawn.room.energyAvailable;
    // Find contracts with pending requests
    // Contracts are now managed directly via this.contracts (ChainPlanner assigns them)
    const contractsWithRequests: Contract[] = [];
    for (const contract of this.contracts) {
      if (contract.sellerId !== this.id) continue;
      if (!isActive(contract, tick)) continue;

      if (hasPendingRequests(contract)) {
        contractsWithRequests.push(contract);
      }
    }

    // Sort by spawn priority (miners first, then haulers, etc.)
    contractsWithRequests.sort((a, b) => {
      const typeA = this.getCreepTypeFromContract(a);
      const typeB = this.getCreepTypeFromContract(b);
      const priorityA = typeA ? SPAWN_PRIORITY[typeA] : 99;
      const priorityB = typeB ? SPAWN_PRIORITY[typeB] : 99;
      return priorityA - priorityB;
    });

    // Check if we're stuck (have pending requests but can't afford any)
    if (contractsWithRequests.length > 0) {
      const canAffordAny = contractsWithRequests.some(contract => {
        const creepType = this.getCreepTypeFromContract(contract);
        if (!creepType) return false;
        const body = this.designBodyForContract(contract, creepType);
        const cost = this.calculateBodyCost(body);
        return currentEnergy >= cost;
      });

      if (!canAffordAny) {
        if (this.stuckSince === 0) {
          this.stuckSince = tick;
        }

        const ticksStuck = tick - this.stuckSince;

        // If stuck long enough, spawn maintenance hauler
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

    // Process contracts with pending requests - find one we can afford
    for (const contract of contractsWithRequests) {
      const creepType = this.getCreepTypeFromContract(contract);
      if (!creepType) continue;

      const body = this.designBodyForContract(contract, creepType);
      const bodyCost = this.calculateBodyCost(body);

      if (currentEnergy < bodyCost) continue;

      const name = `${creepType}-${contract.buyerId.slice(-6)}-${tick}`;

      const workTypeMap: Record<SpawnableCreepType, "harvest" | "haul" | "upgrade" | "build" | "scout"> = {
        miner: "harvest",
        hauler: "haul",
        upgrader: "upgrade",
        builder: "build",
        scout: "scout"
      };

      const result = spawn.spawnCreep(body, name, {
        memory: {
          corpId: contract.buyerId,
          workType: workTypeMap[creepType],
          spawnedBy: this.id,
          contractId: contract.id
        }
      });

      if (result === OK) {
        this.recordCost(bodyCost);
        this.stuckSince = 0;

        // Fulfill the request (assigns creep and decrements pendingRequests)
        fulfillCreepRequest(contract, name);

        // Track production
        if (creepType === "hauler") {
          const carryParts = body.filter(p => p === CARRY).length;
          const haulCapacityProduced = carryParts * HAUL_PER_CARRY;
          this.recordProduction(haulCapacityProduced);
          console.log(`[Spawning] Fulfilled: ${name} for ${contract.buyerId} (${carryParts} CARRY, ${bodyCost} energy)`);
        } else if (creepType === "scout") {
          const moveParts = body.filter(p => p === MOVE).length;
          const moveTicksProduced = moveParts * CREEP_LIFETIME;
          this.recordProduction(moveTicksProduced);
          console.log(`[Spawning] Fulfilled: ${name} for ${contract.buyerId} (${moveParts} MOVE, ${bodyCost} energy)`);
        } else {
          const workParts = body.filter(p => p === WORK).length;
          const workTicksProduced = workParts * CREEP_LIFETIME;
          this.recordProduction(workTicksProduced);
          console.log(`[Spawning] Fulfilled: ${name} for ${contract.buyerId} (${workParts} WORK, ${bodyCost} energy)`);
        }
        return; // Only spawn one per tick
      }
    }
  }

  /**
   * Get creep type from contract's creepSpec.
   * CreepSpec is required for spawning contracts.
   */
  private getCreepTypeFromContract(contract: Contract): SpawnableCreepType | null {
    if (!contract.creepSpec) {
      console.log(`[Spawning] Contract ${contract.id} missing creepSpec - cannot spawn`);
      return null;
    }
    return contract.creepSpec.role;
  }

  /**
   * Design body for a contract-based spawn request.
   */
  private designBodyForContract(
    contract: Contract,
    creepType: SpawnableCreepType
  ): BodyPartConstant[] {
    const spec = contract.creepSpec;

    switch (creepType) {
      case "miner": {
        // Use workParts from spec, or default to 5 (saturates a source)
        const targetWorkParts = spec?.workParts ?? 5;
        const result = buildMinerBody(targetWorkParts, this.energyCapacity);
        return result.body;
      }
      case "hauler": {
        // Use carryParts from spec, or default to 8
        const targetCarryParts = spec?.carryParts ?? 8;
        const body: BodyPartConstant[] = [];
        const maxParts = Math.floor(this.energyCapacity / (BODY_PART_COST.carry + BODY_PART_COST.move));
        const actualCarryParts = Math.min(targetCarryParts, maxParts, 25);
        for (let i = 0; i < actualCarryParts; i++) {
          body.push(CARRY);
        }
        for (let i = 0; i < actualCarryParts; i++) {
          body.push(MOVE);
        }
        return body;
      }
      case "upgrader": {
        // Use workParts from spec, or default to 5
        const targetWorkParts = spec?.workParts ?? 5;
        const result = buildUpgraderBody(this.energyCapacity, targetWorkParts);
        return result.body;
      }
      case "builder": {
        // Builders are similar to upgraders
        const targetWorkParts = spec?.workParts ?? 2;
        const result = buildUpgraderBody(this.energyCapacity, targetWorkParts);
        return result.body;
      }
      case "scout": {
        const targetMoveParts = spec?.moveParts ?? 1;
        const body: BodyPartConstant[] = [];
        for (let i = 0; i < targetMoveParts; i++) {
          body.push(MOVE);
        }
        return body;
      }
      default:
        return [WORK, CARRY, MOVE];
    }
  }

  /**
   * Spawn a maintenance hauler to bring energy to the spawn.
   * This is paid for by SpawningCorp's own balance to break energy starvation.
   */
  private spawnMaintenanceHauler(spawn: StructureSpawn, tick: number): void {
    const currentEnergy = spawn.room.energyAvailable;

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
   * Get number of pending creep requests across all contracts.
   */
  getPendingOrderCount(): number {
    let count = 0;
    for (const contract of this.contracts) {
      if (contract.sellerId === this.id) {
        count += contract.pendingRequests;
      }
    }
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
      pendingOrders: [], // Deprecated - kept for interface compat
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
    // pendingOrders deprecated - spawn now uses contract.pendingRequests
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
