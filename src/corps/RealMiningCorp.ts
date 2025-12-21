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
import { SPAWN_COOLDOWN } from "./CorpConstants";
import { SourceMine } from "../types/SourceMine";
import { analyzeSource, getMiningSpots } from "../analysis/SourceAnalysis";
import { buildMinerBody, calculateCreepsNeeded } from "../spawn/BodyBuilder";

/** Default price when no production history (credits per energy) */
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
   * Price = (creep cost / lifetime energy) × (1 + margin)
   */
  sells(): Offer[] {
    // Calculate available energy (based on current production rate)
    const activeCreeps = this.creepNames.filter(n => Game.creeps[n]).length;
    if (activeCreeps === 0) return [];

    // Estimate energy available per tick (2 per WORK part)
    const workParts = this.creepNames.reduce((sum, name) => {
      const creep = Game.creeps[name];
      return sum + (creep ? creep.getActiveBodyparts(WORK) : 0);
    }, 0);
    const energyPerTick = workParts * 2;

    // Get sell price per energy unit
    const pricePerEnergy = this.getSellPrice();

    return [{
      id: createOfferId(this.id, "energy", Game.time),
      corpId: this.id,
      type: "sell",
      resource: "energy",
      quantity: energyPerTick * 100, // Offer 100 ticks worth
      price: pricePerEnergy,
      duration: 100,
      location: this.getPosition()
    }];
  }

  /**
   * Mining corp doesn't buy anything - it's a pure producer
   */
  buys(): Offer[] {
    return [];
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
   * Main work loop - spawn miners and run their behavior.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    // Clean up dead creeps
    this.creepNames = this.creepNames.filter((name) => Game.creeps[name]);

    // Get spawn and source
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const source = Game.getObjectById(this.sourceId as Id<Source>);

    if (!spawn || !source) {
      return;
    }

    // Analyze source if not cached
    if (!this.sourceMine) {
      this.sourceMine = analyzeSource(source, spawn.pos);
    }

    // Calculate optimal body and creep count
    const energyCapacity = spawn.room.energyCapacityAvailable;
    const bodyResult = buildMinerBody(this.desiredWorkParts, energyCapacity);

    if (bodyResult.workParts === 0) {
      return; // Can't build any miners with current energy
    }

    // Calculate max creeps: min of (needed for WORK parts, available mining spots)
    const miningSpots = getMiningSpots(this.sourceMine);
    const maxCreeps = calculateCreepsNeeded(
      this.desiredWorkParts,
      bodyResult.workParts,
      miningSpots
    );

    // Try to spawn if we need more miners
    if (this.creepNames.length < maxCreeps) {
      this.trySpawn(spawn, tick, bodyResult.body, bodyResult.cost);
    }

    // Run miner behavior
    for (const name of this.creepNames) {
      const creep = Game.creeps[name];
      if (creep && !creep.spawning) {
        this.runMiner(creep, source);
      }
    }
  }

  /**
   * Attempt to spawn a new miner creep.
   *
   * @param spawn - The spawn to use
   * @param tick - Current game tick
   * @param body - Body parts array from BodyBuilder
   * @param cost - Energy cost of the body
   */
  private trySpawn(
    spawn: StructureSpawn,
    tick: number,
    body: BodyPartConstant[],
    cost: number
  ): void {
    if (tick - this.lastSpawnAttempt < SPAWN_COOLDOWN) {
      return;
    }

    if (spawn.spawning) {
      return;
    }

    if (spawn.store[RESOURCE_ENERGY] < cost) {
      return;
    }

    const name = `miner-${this.sourceId.slice(-4)}-${tick}`;

    const result = spawn.spawnCreep(body, name, {
      memory: {
        corpId: this.id,
        workType: "harvest",
        sourceId: this.sourceId,
      },
    });

    this.lastSpawnAttempt = tick;

    if (result === OK) {
      this.creepNames.push(name);
      this.recordCost(cost);
      const workParts = body.filter((p) => p === WORK).length;
      console.log(`[Mining] Spawned ${name} with ${workParts} WORK parts (cost: ${cost})`);
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
      // Revenue is now recorded when sold through the market
      // For now, still record a small amount for backwards compatibility
      // This will be replaced by market transactions
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
