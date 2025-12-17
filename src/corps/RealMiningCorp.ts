/**
 * @fileoverview RealMiningCorp - Manages actual miner creeps.
 *
 * Miners harvest energy from sources and drop it on the ground
 * for haulers to pick up and deliver.
 *
 * @module corps/RealMiningCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position } from "../market/Offer";

/** Miner body: 2 WORK, 1 MOVE = 250 energy */
const MINER_BODY: BodyPartConstant[] = [WORK, WORK, MOVE];

/** Cost of a miner creep */
const MINER_COST = 250;

/** Maximum miners per source */
const MAX_MINERS = 1;

/** Ticks between spawn attempts */
const SPAWN_COOLDOWN = 10;

/**
 * Serialized state specific to RealMiningCorp
 */
export interface SerializedRealMiningCorp extends SerializedCorp {
  spawnId: string;
  sourceId: string;
  creepNames: string[];
  lastSpawnAttempt: number;
}

/**
 * RealMiningCorp manages miner creeps that harvest energy.
 *
 * Miners:
 * - Go to assigned source
 * - Harvest energy
 * - Drop energy on ground (for haulers)
 */
export class RealMiningCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** ID of the source to harvest */
  private sourceId: string;

  /** Names of creeps owned by this corp */
  private creepNames: string[] = [];

  /** Last tick we attempted to spawn */
  private lastSpawnAttempt: number = 0;

  constructor(nodeId: string, spawnId: string, sourceId: string) {
    super("mining", nodeId);
    this.spawnId = spawnId;
    this.sourceId = sourceId;
  }

  /**
   * Mining corp doesn't participate in market (for now)
   */
  sells(): Offer[] {
    return [];
  }

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

    // Try to spawn if we need more miners
    if (this.creepNames.length < MAX_MINERS) {
      this.trySpawn(spawn, tick);
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
   */
  private trySpawn(spawn: StructureSpawn, tick: number): void {
    if (tick - this.lastSpawnAttempt < SPAWN_COOLDOWN) {
      return;
    }

    if (spawn.spawning) {
      return;
    }

    if (spawn.store[RESOURCE_ENERGY] < MINER_COST) {
      return;
    }

    const name = `miner-${this.sourceId.slice(-4)}-${tick}`;

    const result = spawn.spawnCreep(MINER_BODY, name, {
      memory: {
        corpId: this.id,
        workType: "harvest",
        sourceId: this.sourceId,
      },
    });

    this.lastSpawnAttempt = tick;

    if (result === OK) {
      this.creepNames.push(name);
      this.recordCost(MINER_COST);
      console.log(`[Mining] Spawned ${name}`);
    }
  }

  /**
   * Run behavior for a miner creep.
   * Miners just harvest and drop energy.
   */
  private runMiner(creep: Creep, source: Source): void {
    // Move to source and harvest
    if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
      creep.moveTo(source, { visualizePathStyle: { stroke: "#ffaa00" } });
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
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedRealMiningCorp): void {
    super.deserialize(data);
    this.creepNames = data.creepNames || [];
    this.lastSpawnAttempt = data.lastSpawnAttempt || 0;
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
