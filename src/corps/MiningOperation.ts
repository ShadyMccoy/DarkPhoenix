/**
 * @fileoverview MiningOperation - Clean implementation of mining.
 *
 * ARCHITECTURE:
 * - Constructor takes corp IDs (dependencies from planner)
 * - Sells: energy (dropped on ground)
 * - Buys: work-ticks (from SpawningCorp)
 * - work() is pure: just runs creeps on the source
 *
 * The planner creates this with:
 *   new MiningOperation(sourceCorpId, spawningCorpId)
 *
 * @module corps/MiningOperation
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position, createOfferId } from "../market/Offer";
import { CREEP_LIFETIME } from "../planning/EconomicConstants";
import { SourceCorp } from "./SourceCorp";

/** Price per energy unit */
const ENERGY_PRICE = 0.1;

/**
 * Serialized state for MiningOperation
 */
export interface SerializedMiningOperation extends SerializedCorp {
  sourceCorpId: string;
  spawningCorpId: string;
  creepNames: string[];
  targetMiners: number;
}

/**
 * MiningOperation - harvests energy from a source.
 *
 * Dependencies (explicit in constructor):
 * - sourceCorp: the SourceCorp to mine from (provides source data)
 * - spawningCorpId: where to get work-ticks from
 *
 * Buys: work-ticks (miners)
 * Sells: energy (on ground)
 */
export class MiningOperation extends Corp {
  // === DEPENDENCIES (from planner) ===
  private readonly sourceCorp: SourceCorp;
  private readonly spawningCorpId: string;

  // === RUNTIME STATE ===
  private creepNames: string[] = [];
  private targetMiners: number = 1;

  /**
   * Create a mining operation.
   *
   * @param sourceCorp - The SourceCorp to mine from (provides source data)
   * @param spawningCorpId - ID of the SpawningCorp to get miners from
   */
  constructor(sourceCorp: SourceCorp, spawningCorpId: string) {
    const nodeId = `mining-${sourceCorp.sourceId.slice(-8)}`;
    super("mining", nodeId);
    this.sourceCorp = sourceCorp;
    this.spawningCorpId = spawningCorpId;
    this.targetMiners = sourceCorp.miningSpots;
  }

  // === ACCESSORS (data comes from SourceCorp) ===
  private get sourceId(): string {
    return this.sourceCorp.sourceId;
  }

  private get sourcePosition(): Position {
    return this.sourceCorp.position;
  }

  private get miningSpots(): number {
    return this.sourceCorp.miningSpots;
  }

  // === SELLS: energy ===
  sells(): Offer[] {
    const creeps = this.getCreeps();
    if (creeps.length === 0) return [];

    // Calculate energy capacity from current miners
    const energyCapacity = creeps.reduce((sum, creep) => {
      const ttl = creep.ticksToLive ?? CREEP_LIFETIME;
      const workParts = creep.getActiveBodyparts(WORK);
      return sum + (workParts * 2 * ttl);
    }, 0);

    const committedEnergy = this.getCommittedSellQuantity("energy", Game.time);
    const availableEnergy = energyCapacity - committedEnergy;
    if (availableEnergy <= 0) return [];

    return [{
      id: createOfferId(this.id, "energy", Game.time),
      corpId: this.id,
      type: "sell",
      resource: "energy",
      quantity: availableEnergy,
      price: ENERGY_PRICE * availableEnergy,
      duration: CREEP_LIFETIME,
      location: this.sourcePosition
    }];
  }

  // === BUYS: work-ticks ===
  buys(): Offer[] {
    const currentMiners = this.getCreeps().length;
    if (currentMiners >= this.targetMiners) return [];

    return [{
      id: createOfferId(this.id, "work-ticks", Game.time),
      corpId: this.id,
      type: "buy",
      resource: "work-ticks",
      quantity: CREEP_LIFETIME,
      price: ENERGY_PRICE * 2 * CREEP_LIFETIME * (1 + this.getMargin()),
      duration: CREEP_LIFETIME,
      location: this.sourcePosition
    }];
  }

  // === WORK: pure execution ===
  work(tick: number): void {
    this.lastActivityTick = tick;

    // Pick up creeps assigned to us
    this.pickupCreeps();

    // Get the source
    const source = Game.getObjectById(this.sourceId as Id<Source>);
    if (!source) return;

    // Run each miner
    for (const creep of this.getCreeps()) {
      if (!creep.spawning) {
        this.runMiner(creep, source);
      }
    }
  }

  /**
   * Run miner behavior - pure function of creep and source.
   */
  private runMiner(creep: Creep, source: Source): void {
    const result = creep.harvest(source);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(source);
    } else if (result === OK) {
      const workParts = creep.getActiveBodyparts(WORK);
      this.recordProduction(workParts * 2);
    }

    // Drop when full
    if (creep.store.getFreeCapacity() === 0) {
      creep.drop(RESOURCE_ENERGY);
    }
  }

  /**
   * Get current creeps (from names).
   */
  private getCreeps(): Creep[] {
    return this.creepNames
      .map(name => Game.creeps[name])
      .filter((c): c is Creep => c !== undefined);
  }

  /**
   * Pick up creeps assigned to this corp.
   */
  private pickupCreeps(): void {
    // Clean dead creeps
    this.creepNames = this.creepNames.filter(name => Game.creeps[name]);

    // Add new creeps
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id && !this.creepNames.includes(name)) {
        this.creepNames.push(name);
        console.log(`[Mining] Picked up miner ${name}`);
      }
    }
  }

  getPosition(): Position {
    return this.sourcePosition;
  }

  // === PLANNING ===
  plan(tick: number): void {
    super.plan(tick);
    // Target = one miner per spot (data from SourceCorp)
    this.targetMiners = this.miningSpots;
  }

  // === SERIALIZATION ===
  serialize(): SerializedMiningOperation {
    return {
      ...super.serialize(),
      sourceCorpId: this.sourceCorp.id,
      spawningCorpId: this.spawningCorpId,
      creepNames: this.creepNames,
      targetMiners: this.targetMiners,
    };
  }

  deserialize(data: SerializedMiningOperation): void {
    super.deserialize(data);
    this.creepNames = data.creepNames || [];
    this.targetMiners = data.targetMiners || 1;
  }

  /**
   * Get the SourceCorp this operation mines from.
   */
  getSourceCorp(): SourceCorp {
    return this.sourceCorp;
  }
}
