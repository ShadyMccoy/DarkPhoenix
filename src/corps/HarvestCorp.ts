/**
 * @fileoverview HarvestCorp - Manages harvester creeps.
 *
 * Harvesters harvest energy from sources and drop it on the ground
 * for haulers to pick up and deliver.
 *
 * @module corps/HarvestCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position } from "../market/Offer";
import { CREEP_LIFETIME, SOURCE_ENERGY_CAPACITY, calculateOptimalWorkParts } from "../planning/EconomicConstants";
import { MiningCorpState } from "./CorpState";
import { projectMining } from "../planning/projections";
import {
  Contract,
  isActive,
  recordDelivery,
  canRequestCreep,
  requestCreep,
  replacementsNeeded
} from "../market/Contract";


/**
 * Serialized state specific to HarvestCorp
 */
export interface SerializedHarvestCorp extends SerializedCorp {
  spawnId: string;
  sourceId: string;
  creepNames: string[];
  lastSpawnAttempt: number;
  desiredWorkParts: number;
  targetMiners: number;
}

/**
 * HarvestCorp manages harvester creeps that harvest energy.
 *
 * Harvesters:
 * - Go to assigned source
 * - Harvest energy
 * - Drop energy on ground (for haulers)
 */
/**
 * Fallback WORK parts for standard 3000-capacity sources.
 * Use calculateOptimalWorkParts() for actual capacity-based calculation.
 */
const DEFAULT_DESIRED_WORK = 5;

export class HarvestCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** ID of the source to harvest */
  private sourceId: string;

  /** Last tick we attempted to spawn */
  private lastSpawnAttempt: number = 0;

  /** Desired WORK parts for this mining operation */
  private desiredWorkParts: number;

  /** Target number of harvesters (computed during planning) */
  private targetMiners: number = 1;

  /** Creeps we've already recorded expected production for (session-only) */
  private accountedCreeps: Set<string> = new Set();

  /**
   * Get active creeps assigned to this corp from contracts.
   * Contracts are assigned directly by ChainPlanner.
   */
  private getActiveCreeps(): Creep[] {
    const creeps: Creep[] = [];
    const seen = new Set<string>();

    // Get creeps from buy contracts
    for (const contract of this.contracts) {
      if (contract.buyerId !== this.id) continue;
      if (!isActive(contract, Game.time)) continue;

      for (const creepName of contract.creepIds) {
        if (seen.has(creepName)) continue;
        seen.add(creepName);

        const creep = Game.creeps[creepName];
        if (creep && !creep.spawning) {
          creeps.push(creep);

          // Record expected production once per creep (session-only tracking)
          if (!this.accountedCreeps.has(creepName)) {
            this.accountedCreeps.add(creepName);
            const workParts = creep.getActiveBodyparts(WORK);
            const expectedEnergy = workParts * 2 * CREEP_LIFETIME;
            this.recordExpectedProduction(expectedEnergy);
          }
        }
      }
    }

    // Fallback: scan for creeps with our corpId not in contracts
    for (const name in Game.creeps) {
      if (seen.has(name)) continue;
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id && !creep.spawning) {
        creeps.push(creep);
        seen.add(name);

        if (!this.accountedCreeps.has(name)) {
          this.accountedCreeps.add(name);
          const workParts = creep.getActiveBodyparts(WORK);
          const expectedEnergy = workParts * 2 * CREEP_LIFETIME;
          this.recordExpectedProduction(expectedEnergy);
        }
      }
    }

    return creeps;
  }

  constructor(
    nodeId: string,
    spawnId: string,
    sourceId: string,
    desiredWorkParts: number = DEFAULT_DESIRED_WORK
  ) {
    super("mining", nodeId);
    this.spawnId = spawnId;
    this.sourceId = sourceId;
    this.desiredWorkParts = desiredWorkParts;
  }

  /**
   * HarvestCorp sells energy.
   *
   * Delegates to projectMining() for unified offer calculation.
   * Always generates offers based on source capacity (for planning visibility).
   */
  sells(): Offer[] {
    const state = this.toCorpState();
    const projection = projectMining(state, Game.time);
    return projection.sells;
  }

  /**
   * Convert current runtime state to MiningCorpState for projection.
   * Bridges runtime (actual creeps) to planning model (CorpState).
   */
  toCorpState(): MiningCorpState {
    // Calculate actual work parts and TTL from live creeps
    const creeps = this.getActiveCreeps();
    let actualWorkParts = 0;
    let actualTotalTTL = 0;

    for (const creep of creeps) {
      actualWorkParts += creep.getActiveBodyparts(WORK);
      actualTotalTTL += creep.ticksToLive ?? CREEP_LIFETIME;
    }
    const activeCreepCount = creeps.length;

    // Get source info
    const source = Game.getObjectById(this.sourceId as Id<Source>);
    const sourceCapacity = source?.energyCapacity ?? SOURCE_ENERGY_CAPACITY;

    // Get spawn position
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const spawnPosition = spawn
      ? { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName }
      : null;

    return {
      id: this.id,
      type: "mining",
      nodeId: this.nodeId,
      sourceCorpId: this.sourceId, // Using sourceId as sourceCorpId
      spawningCorpId: this.spawnId, // Using spawnId as spawningCorpId
      position: this.getPosition(),
      sourceCapacity,
      spawnPosition,
      // Runtime fields for actual creep data
      actualWorkParts,
      actualTotalTTL,
      activeCreepCount,
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
   * Plan harvesting operations. Called periodically to compute targets.
   */
  plan(tick: number): void {
    super.plan(tick);
    // One harvester with 5 WORK parts saturates a standard source (10 energy/tick)
    this.targetMiners = 1;
  }

  /**
   * HarvestCorp buys spawn-capacity from SpawningCorps.
   *
   * Delegates to projectMining() for unified offer calculation.
   */
  buys(): Offer[] {
    const state = this.toCorpState();
    const projection = projectMining(state, Game.time);
    return projection.buys;
  }

  /**
   * Get the source position as the corp's location.
   */
  getPosition(): Position {
    const source = Game.getObjectById(this.sourceId as Id<Source>);
    if (source) {
      return { x: source.pos.x, y: source.pos.y, roomName: source.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  /**
   * @deprecated Use execute() for contract-driven execution
   */
  work(tick: number): void {
    // Legacy - delegates to execute with contracts from this.contracts
    this.execute(this.contracts, tick);
  }

  /**
   * Execute work to fulfill contracts.
   * Contracts drive the work - creeps assigned to contracts do harvesting.
   */
  execute(contracts: Contract[], tick: number): void {
    this.lastActivityTick = tick;

    const source = Game.getObjectById(this.sourceId as Id<Source>);
    if (!source) return;

    // Get sell contracts for energy (we sell to haulers)
    const sellContracts = contracts.filter(
      c => c.sellerId === this.id && c.resource === "energy" && isActive(c, tick)
    );

    // Get buy contracts for spawning (we buy from SpawningCorp)
    const buyContracts = contracts.filter(
      c => c.buyerId === this.id && isActive(c, tick)
    );

    // Execute harvesting for creeps assigned to our buy contracts
    // (creeps we bought from SpawningCorp)
    for (const contract of buyContracts) {
      // Request creeps using the option mechanism
      this.requestCreepsForContract(contract);

      for (const creepName of contract.creepIds) {
        const creep = Game.creeps[creepName];
        if (creep && !creep.spawning) {
          this.runHarvesterForContract(creep, source, sellContracts);

          // Record expected production for new creeps
          if (!this.accountedCreeps.has(creepName)) {
            this.accountedCreeps.add(creepName);
            const workParts = creep.getActiveBodyparts(WORK);
            const expectedEnergy = workParts * 2 * CREEP_LIFETIME;
            this.recordExpectedProduction(expectedEnergy);
          }
        }
      }
    }
  }

  /**
   * Request creeps from a spawn contract using the option mechanism.
   * Requests initial creeps or replacements for dying creeps.
   */
  private requestCreepsForContract(contract: Contract): void {
    // If we have no creeps yet, request initial creep
    if (contract.creepIds.length === 0 && canRequestCreep(contract)) {
      requestCreep(contract);
      return;
    }

    // Check if any creeps need replacements based on TTL vs travel time
    const numReplacements = replacementsNeeded(contract, (creepId) => {
      const creep = Game.creeps[creepId];
      return creep?.ticksToLive;
    });

    for (let i = 0; i < numReplacements; i++) {
      if (!requestCreep(contract)) break;
    }
  }

  /**
   * Run harvester and record delivery on sell contracts.
   * Returns amount harvested.
   */
  private runHarvesterForContract(
    creep: Creep,
    source: Source,
    sellContracts: Contract[]
  ): number {
    const result = creep.harvest(source);

    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(source, { visualizePathStyle: { stroke: "#ffaa00" } });
      return 0;
    }

    if (result === OK) {
      const workParts = creep.getActiveBodyparts(WORK);
      const energyHarvested = workParts * 2;

      // Track production for marginal cost
      this.recordProduction(energyHarvested);

      // Record delivery on sell contracts
      if (sellContracts.length > 0) {
        const perContract = energyHarvested / sellContracts.length;
        for (const contract of sellContracts) {
          recordDelivery(contract, perContract);
        }
      }

      return energyHarvested;
    }

    return 0;
  }

  /**
   * Get number of active harvester creeps.
   */
  getCreepCount(): number {
    return this.getActiveCreeps().length;
  }

  /**
   * Get the source ID this corp harvests.
   */
  getSourceId(): string {
    return this.sourceId;
  }

  /**
   * Serialize for persistence.
   * Note: creepNames not persisted - contracts are source of truth.
   */
  serialize(): SerializedHarvestCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      sourceId: this.sourceId,
      creepNames: [], // Deprecated - kept for interface compat
      lastSpawnAttempt: this.lastSpawnAttempt,
      desiredWorkParts: this.desiredWorkParts,
      targetMiners: this.targetMiners,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedHarvestCorp): void {
    super.deserialize(data);
    this.lastSpawnAttempt = data.lastSpawnAttempt || 0;
    this.desiredWorkParts = data.desiredWorkParts || DEFAULT_DESIRED_WORK;
    this.targetMiners = data.targetMiners || 1;
  }
}

/**
 * Create a HarvestCorp for a source in a room.
 * Calculates optimal work parts based on the source's energy capacity.
 */
export function createHarvestCorp(
  room: Room,
  spawn: StructureSpawn,
  source: Source
): HarvestCorp {
  const nodeId = `${room.name}-harvest-${source.id.slice(-4)}`;
  const desiredWorkParts = calculateOptimalWorkParts(source.energyCapacity);
  return new HarvestCorp(nodeId, spawn.id, source.id, desiredWorkParts);
}
