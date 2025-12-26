/**
 * @fileoverview MiningOperation - Clean implementation of mining.
 *
 * @module corps/MiningOperation
 */

import { Corp, SerializedCorp } from "./Corp";
import { Position } from "../types/Position";
import { SourceCorp } from "./SourceCorp";

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
 */
export class MiningOperation extends Corp {
  private readonly sourceCorp: SourceCorp;
  private readonly spawningCorpId: string;
  private creepNames: string[] = [];
  private targetMiners: number = 1;

  constructor(sourceCorp: SourceCorp, spawningCorpId: string) {
    const nodeId = `mining-${sourceCorp.sourceId.slice(-8)}`;
    super("mining", nodeId);
    this.sourceCorp = sourceCorp;
    this.spawningCorpId = spawningCorpId;
    this.targetMiners = sourceCorp.miningSpots;
  }

  private get sourceId(): string {
    return this.sourceCorp.sourceId;
  }

  private get sourcePosition(): Position {
    return this.sourceCorp.position;
  }

  private get miningSpots(): number {
    return this.sourceCorp.miningSpots;
  }

  work(tick: number): void {
    this.lastActivityTick = tick;
    this.pickupCreeps();

    const source = Game.getObjectById(this.sourceId as Id<Source>);
    if (!source) return;

    for (const creep of this.getCreeps()) {
      if (!creep.spawning) {
        this.runMiner(creep, source);
      }
    }
  }

  private runMiner(creep: Creep, source: Source): void {
    const result = creep.harvest(source);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(source);
    } else if (result === OK) {
      const workParts = creep.getActiveBodyparts(WORK);
      this.recordProduction(workParts * 2);
    }

    if (creep.store.getFreeCapacity() === 0) {
      creep.drop(RESOURCE_ENERGY);
    }
  }

  private getCreeps(): Creep[] {
    return this.creepNames
      .map(name => Game.creeps[name])
      .filter((c): c is Creep => c !== undefined);
  }

  private pickupCreeps(): void {
    this.creepNames = this.creepNames.filter(name => Game.creeps[name]);

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

  plan(tick: number): void {
    super.plan(tick);
    this.targetMiners = this.miningSpots;
  }

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

  getSourceCorp(): SourceCorp {
    return this.sourceCorp;
  }
}
