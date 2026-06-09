/**
 * @fileoverview SourceCorp - Represents an energy source as a market entity.
 *
 * SourceCorp is a passive corp that doesn't have creeps.
 * It simply represents the energy source for planning purposes.
 *
 * @module corps/SourceCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { PLANNING_EPOCH, SOURCE_REGEN_TIME } from "../planning/EconomicConstants";
import { Position } from "../types/Position";
import { countMiningSpots } from "../analysis/SourceAnalysis";

/**
 * Serialized state specific to SourceCorp
 */
export interface SerializedSourceCorp extends SerializedCorp {
  sourceId: string;
  position: Position;
  energyCapacity: number;
  miningSpots: number;
}

/**
 * SourceCorp represents an energy source.
 */
export class SourceCorp extends Corp {
  /** The game source ID */
  public readonly sourceId: string;

  /** Position of the source */
  public readonly position: Position;

  /** Energy capacity (usually 3000) */
  public readonly energyCapacity: number;

  /** Number of spots available for mining */
  public readonly miningSpots: number;

  /**
   * Energy produced per planning epoch.
   */
  public get energyPerEpoch(): number {
    return (this.energyCapacity / SOURCE_REGEN_TIME) * PLANNING_EPOCH;
  }

  public constructor(sourceId: string, position: Position, energyCapacity: number, miningSpots: number) {
    const nodeId = `${position.roomName}-source-${sourceId.slice(-4)}`;
    super("source", nodeId);
    this.sourceId = sourceId;
    this.position = position;
    this.energyCapacity = energyCapacity;
    this.miningSpots = miningSpots;
  }

  /**
   * SourceCorp doesn't do work - it's passive.
   */
  public work(_tick: number): void {
    // Sources just exist
  }

  /**
   * Get the source position.
   */
  public getPosition(): Position {
    return this.position;
  }

  /**
   * Get the game Source object.
   */
  public getSource(): Source | null {
    return Game.getObjectById(this.sourceId as Id<Source>);
  }

  /**
   * Serialize for persistence.
   */
  public serialize(): SerializedSourceCorp {
    return {
      ...super.serialize(),
      sourceId: this.sourceId,
      position: this.position,
      energyCapacity: this.energyCapacity,
      miningSpots: this.miningSpots
    };
  }

  /**
   * Deserialize from persistence.
   */
  public deserialize(data: SerializedSourceCorp): void {
    super.deserialize(data);
  }
}

/**
 * Create a SourceCorp from a game Source object.
 */
export function createSourceCorp(source: Source): SourceCorp {
  const position: Position = {
    x: source.pos.x,
    y: source.pos.y,
    roomName: source.pos.roomName
  };
  const miningSpots = countMiningSpots(source);
  return new SourceCorp(source.id, position, source.energyCapacity, miningSpots);
}
