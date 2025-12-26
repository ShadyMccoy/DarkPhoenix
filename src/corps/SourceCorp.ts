/**
 * @fileoverview SourceCorp - Represents an energy source as a market entity.
 *
 * SourceCorp is a passive corp that doesn't have creeps.
 * It simply represents the energy source for planning purposes.
 *
 * @module corps/SourceCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Position } from "../types/Position";
import { countMiningSpots } from "../analysis/SourceAnalysis";
import { SOURCE_REGEN_TIME, PLANNING_EPOCH } from "../planning/EconomicConstants";

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
  readonly sourceId: string;

  /** Position of the source */
  readonly position: Position;

  /** Energy capacity (usually 3000) */
  readonly energyCapacity: number;

  /** Number of spots available for mining */
  readonly miningSpots: number;

  /**
   * Energy produced per planning epoch.
   */
  get energyPerEpoch(): number {
    return (this.energyCapacity / SOURCE_REGEN_TIME) * PLANNING_EPOCH;
  }

  constructor(
    sourceId: string,
    position: Position,
    energyCapacity: number,
    miningSpots: number
  ) {
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
  work(_tick: number): void {
    // Sources just exist
  }

  /**
   * Get the source position.
   */
  getPosition(): Position {
    return this.position;
  }

  /**
   * Get the game Source object.
   */
  getSource(): Source | null {
    return Game.getObjectById(this.sourceId as Id<Source>);
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedSourceCorp {
    return {
      ...super.serialize(),
      sourceId: this.sourceId,
      position: this.position,
      energyCapacity: this.energyCapacity,
      miningSpots: this.miningSpots,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedSourceCorp): void {
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
