/**
 * @fileoverview RealMiningCorp - Manages actual miner creeps.
 *
 * Miners harvest energy from sources and drop it on the ground
 * for haulers to pick up and deliver.
 *
 * @module corps/RealMiningCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position, createOfferId } from "../market/Offer";
import { SourceMine } from "../types/SourceMine";
import { analyzeSource, getMiningSpots } from "../analysis/SourceAnalysis";
import { buildMinerBody, calculateCreepsNeeded } from "../spawn/BodyBuilder";
import { CREEP_LIFETIME, SOURCE_ENERGY_CAPACITY } from "../planning/EconomicConstants";
import { MiningCorpState } from "./CorpState";
import { projectMining } from "../planning/projections";

/** Default/minimum price when no production history (credits per energy) */
const DEFAULT_ENERGY_PRICE = 0.1;

/**
 * Serialized state specific to RealMiningCorp
 */
export interface SerializedRealMiningCorp extends SerializedCorp {
  spawnId: string;
  sourceId: string;
  creepNames: string[];
  lastSpawnAttempt: number;
  desiredWorkParts: number;
  targetMiners: number;
}

/**
 * RealMiningCorp manages miner creeps that harvest energy.
 *
 * Miners:
 * - Go to assigned source
 * - Harvest energy
 * - Drop energy on ground (for haulers)
 */
/**
 * Default WORK parts for full source harvest.
 * 5 WORK parts = 10 energy/tick = source regeneration rate
 */
const DEFAULT_DESIRED_WORK = 5;

export class RealMiningCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** ID of the source to harvest */
  private sourceId: string;

  /** Names of creeps owned by this corp */
  private creepNames: string[] = [];

  /** Last tick we attempted to spawn */
  private lastSpawnAttempt: number = 0;

  /** Desired WORK parts for this mining operation */
  private desiredWorkParts: number;

  /** Cached source analysis (populated on first work() call) */
  private sourceMine: SourceMine | null = null;

  /** Target number of miners (computed during planning) */
  private targetMiners: number = 1;

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
   * Mining corp sells energy at marginal cost + margin.
   *
   * Delegates to projectMining() for unified offer calculation.
   * Provides actual creep data via toCorpState() for runtime accuracy.
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
    let actualWorkParts = 0;
    let actualTotalTTL = 0;
    let activeCreepCount = 0;

    for (const name of this.creepNames) {
      const creep = Game.creeps[name];
      if (creep) {
        actualWorkParts += creep.getActiveBodyparts(WORK);
        actualTotalTTL += creep.ticksToLive ?? CREEP_LIFETIME;
        activeCreepCount++;
      }
    }

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
   * Plan mining operations. Called periodically to compute targets.
   * Analyzes the source to determine optimal miner count.
   */
  plan(tick: number): void {
    super.plan(tick);
    this.ensureSourceAnalyzed();

    // Get physical constraints
    const miningSpots = this.sourceMine ? getMiningSpots(this.sourceMine) : 1;

    // Calculate miners needed for desired work parts
    // Assume each miner has ~5 WORK parts (adjusts based on energy capacity)
    const avgWorkPerMiner = Math.max(1, Math.floor(this.desiredWorkParts / miningSpots));
    const minersForWorkParts = Math.ceil(this.desiredWorkParts / avgWorkPerMiner);

    // Target is minimum of spots available and miners needed
    this.targetMiners = Math.min(miningSpots, minersForWorkParts);
  }

  /**
   * Mining corp buys work-ticks (miner creeps) from SpawningCorps.
   *
   * EXECUTION LOGIC (uses targets from planning):
   * - If current miners < target, request 1 more
   * - Planning determines the target based on source analysis
   */
  buys(): Offer[] {
    // Count current live creeps
    const currentMiners = this.creepNames.filter(n => Game.creeps[n]).length;

    // If we have enough miners, don't request more
    if (currentMiners >= this.targetMiners) {
      return [];
    }

    // Request exactly 1 creep's worth of work-ticks
    const workTicksPerCreep = CREEP_LIFETIME;

    // Calculate bid price based on expected revenue
    const pricePerWorkTick = DEFAULT_ENERGY_PRICE * 2 * (1 + this.getMargin());

    return [{
      id: createOfferId(this.id, "work-ticks", Game.time),
      corpId: this.id,
      type: "buy",
      resource: "work-ticks",
      quantity: workTicksPerCreep,
      price: pricePerWorkTick * workTicksPerCreep,
      duration: CREEP_LIFETIME,
      location: this.getPosition()
    }];
  }

  /**
   * Ensure source analysis is available (lazy initialization).
   * Populates sourceMine if not already done.
   */
  private ensureSourceAnalyzed(): void {
    if (this.sourceMine) return;

    const source = Game.getObjectById(this.sourceId as Id<Source>);
    if (!source) return;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const spawnPos = spawn?.pos ?? source.pos;
    this.sourceMine = analyzeSource(source, spawnPos);
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
   * Main work loop - pick up assigned creeps and run their behavior.
   * Spawning is handled by SpawningCorp via the market.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    // Pick up newly assigned creeps (spawned by SpawningCorp with our corpId)
    this.pickupAssignedCreeps();

    // Clean up dead creeps
    this.creepNames = this.creepNames.filter((name) => Game.creeps[name]);

    // Get source
    const source = Game.getObjectById(this.sourceId as Id<Source>);
    if (!source) {
      return;
    }

    // Ensure source analysis is available
    this.ensureSourceAnalyzed();

    // Run miner behavior for all creeps
    for (const name of this.creepNames) {
      const creep = Game.creeps[name];
      if (creep && !creep.spawning) {
        this.runMiner(creep, source);
      }
    }
  }

  /**
   * Scan for creeps that were spawned for this corp and add them to our roster.
   * Creeps are spawned by SpawningCorp with memory.corpId set to our ID.
   */
  private pickupAssignedCreeps(): void {
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (
        creep.memory.corpId === this.id &&
        !this.creepNames.includes(name)
      ) {
        this.creepNames.push(name);

        // Record expected lifetime production for amortized pricing
        const workParts = creep.getActiveBodyparts(WORK);
        const expectedEnergy = workParts * 2 * CREEP_LIFETIME;
        this.recordExpectedProduction(expectedEnergy);

        console.log(`[Mining] Picked up miner ${name} (${workParts} WORK)`);
      }
    }
  }

  /**
   * Run behavior for a miner creep.
   * Miners just harvest and drop energy.
   */
  private runMiner(creep: Creep, source: Source): void {
    // Move to source and harvest
    const result = creep.harvest(source);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(source, { visualizePathStyle: { stroke: "#ffaa00" } });
    } else if (result === OK) {
      // Track energy produced for marginal cost calculation
      // 2 energy per WORK part per tick
      const workParts = creep.getActiveBodyparts(WORK);
      const energyHarvested = workParts * 2;
      this.recordProduction(energyHarvested);
    }

    // Drop energy when full (let haulers pick it up)
    if (creep.store.getFreeCapacity() === 0) {
      creep.drop(RESOURCE_ENERGY);
    }
  }

  /**
   * Get number of active miner creeps.
   */
  getCreepCount(): number {
    return this.creepNames.filter((n) => Game.creeps[n]).length;
  }

  /**
   * Get the source ID this corp mines.
   */
  getSourceId(): string {
    return this.sourceId;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedRealMiningCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      sourceId: this.sourceId,
      creepNames: this.creepNames,
      lastSpawnAttempt: this.lastSpawnAttempt,
      desiredWorkParts: this.desiredWorkParts,
      targetMiners: this.targetMiners,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedRealMiningCorp): void {
    super.deserialize(data);
    this.creepNames = data.creepNames || [];
    this.lastSpawnAttempt = data.lastSpawnAttempt || 0;
    this.desiredWorkParts = data.desiredWorkParts || DEFAULT_DESIRED_WORK;
    this.targetMiners = data.targetMiners || 1;
  }
}

/**
 * Create a RealMiningCorp for a source in a room.
 */
export function createRealMiningCorp(
  room: Room,
  spawn: StructureSpawn,
  source: Source
): RealMiningCorp {
  const nodeId = `${room.name}-mining-${source.id.slice(-4)}`;
  return new RealMiningCorp(nodeId, spawn.id, source.id);
}
