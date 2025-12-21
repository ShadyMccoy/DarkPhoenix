/**
 * @fileoverview SourceCorp - Represents an energy source as a market entity.
 *
 * SourceCorp is a passive corp that doesn't have creeps.
 * It simply represents the energy source and "sells" access to it.
 * Mining corps buy from SourceCorp to get assigned a source.
 *
 * This allows the planner to:
 * - Know which sources exist
 * - Assign sources to mining corps
 * - Track source utilization
 *
 * @module corps/SourceCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position, createOfferId } from "../market/Offer";

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
 * SourceCorp represents an energy source as a tradeable resource.
 *
 * It sells "energy-source" which represents the right to harvest.
 * Mining corps buy this to get assigned to a source.
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

  constructor(
    sourceId: string,
    position: Position,
    energyCapacity: number,
    miningSpots: number
  ) {
    // nodeId is derived from source position
    const nodeId = `${position.roomName}-source-${sourceId.slice(-4)}`;
    super("mining", nodeId); // Type "mining" for now, could add "source" type
    this.sourceId = sourceId;
    this.position = position;
    this.energyCapacity = energyCapacity;
    this.miningSpots = miningSpots;
  }

  /**
   * SourceCorp sells access to the energy source.
   * Quantity is the energy capacity available per regeneration cycle.
   */
  sells(): Offer[] {
    // Sell access to this source
    // Price is 0 - it's free to access, but you need miners to harvest
    return [{
      id: createOfferId(this.id, "energy-source", Game.time),
      corpId: this.id,
      type: "sell",
      resource: "energy-source",
      quantity: this.energyCapacity,
      price: 0, // Free resource, cost is in mining
      duration: 300, // Regeneration cycle
      location: this.position
    }];
  }

  /**
   * SourceCorp doesn't buy anything - it's a passive resource.
   */
  buys(): Offer[] {
    return [];
  }

  /**
   * SourceCorp doesn't do work - it's passive.
   */
  work(_tick: number): void {
    // Sources just exist - nothing to do
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
   * Check if this source is being fully utilized.
   */
  isFullyUtilized(): boolean {
    // Could track this via contracts
    return false;
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
    // sourceId, position, energyCapacity, miningSpots are readonly, set in constructor
  }
}

/**
 * Create a SourceCorp from a game Source object.
 */
export function createSourceCorp(
  source: Source,
  miningSpots: number
): SourceCorp {
  const position: Position = {
    x: source.pos.x,
    y: source.pos.y,
    roomName: source.pos.roomName
  };
  return new SourceCorp(source.id, position, source.energyCapacity, miningSpots);
}
