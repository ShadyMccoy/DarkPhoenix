/**
 * @fileoverview HarvestCorp - Manages harvester creeps.
 *
 * Harvesters harvest energy from sources and drop it on the ground
 * for haulers to pick up and deliver.
 *
 * @module corps/HarvestCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Position } from "../types/Position";
import { CREEP_LIFETIME, SOURCE_ENERGY_CAPACITY, calculateOptimalWorkParts } from "../planning/EconomicConstants";

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
   * Get active creeps assigned to this corp.
   */
  private getActiveCreeps(): Creep[] {
    const creeps: Creep[] = [];
    const seen = new Set<string>();

    // Scan for creeps with our corpId
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
   * Plan harvesting operations. Called periodically to compute targets.
   */
  plan(tick: number): void {
    super.plan(tick);
    // One harvester with 5 WORK parts saturates a standard source (10 energy/tick)
    this.targetMiners = 1;
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
   * Main work loop - run harvester creeps.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    const source = Game.getObjectById(this.sourceId as Id<Source>);
    if (!source) return;

    // Run all assigned creeps
    const creeps = this.getActiveCreeps();
    for (const creep of creeps) {
      this.runHarvester(creep, source);
    }
  }

  /**
   * Run a single harvester creep.
   */
  private runHarvester(creep: Creep, source: Source): number {
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
   * Get desired work parts for this source.
   */
  getDesiredWorkParts(): number {
    return this.desiredWorkParts;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedHarvestCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      sourceId: this.sourceId,
      creepNames: [],
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
