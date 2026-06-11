/**
 * @fileoverview Scavenging - turn ground energy stocks into transient sources.
 *
 * A pile of dropped energy, a tombstone, or a ruin is already-harvested energy
 * lying around. Above a threshold it becomes a TRANSIENT source (see CorpPlanner):
 * no miner, just a scavenger that hauls it home. Below the threshold it is left to
 * the ordinary source-haulers' opportunistic pickup (nodeEnergy.sourcePickupSpot)
 * - promoting every few-energy trickle to a dedicated scavenger would cost more to
 * run than it recovers.
 *
 * The "short term" is emergent: stocks are re-detected every economy rebuild, so a
 * stock that has been drained or has decayed below the threshold simply stops
 * being a source and its scavengers demobilise. No decay dynamics live in the
 * planner.
 *
 * The economic functions here are pure and unit-tested; only `detectRoomStocks`
 * touches the Screeps room API.
 *
 * @module economy/scavenge
 */

import { Position } from "../types/Position";
import { PlannerSource } from "./CorpPlanner";

/** Below this many energy a stock is left to opportunistic source-hauler pickup. */
export const SCAVENGE_THRESHOLD = 750;

/** Target ticks to clear a stock - sets how much hauling we throw at it. */
export const SCAVENGE_DRAIN_TICKS = 150;

/** Cap on a single stock's drain rate so we never over-provision scavengers. */
export const MAX_SCAVENGE_RATE = 20;

/** A scavengeable ground energy stock (dropped pile, tombstone, or ruin). */
export interface GroundStock {
  /** Stable id derived from the game object: "scavenge-<objectId>". */
  id: string;
  /** Where the stock sits. */
  pos: Position;
  /** Energy available right now. */
  amount: number;
}

/** A raw energy find before thresholding - the testable input to collectStocks. */
export interface EnergyFind {
  id: string;
  pos: Position;
  energy: number;
}

/**
 * Bounded drain rate (energy/tick) to assign a stock of `amount` energy: clear it
 * over SCAVENGE_DRAIN_TICKS, capped at MAX_SCAVENGE_RATE so a huge pile doesn't ask
 * for an absurd scavenger fleet. The cap means very large stocks drain over more
 * ticks - which is fine, the stock persists and is re-detected next cycle.
 */
export function scavengeRate(amount: number): number {
  return Math.min(MAX_SCAVENGE_RATE, amount / SCAVENGE_DRAIN_TICKS);
}

/**
 * Filter raw finds to stocks worth a dedicated scavenger (>= threshold) and tag
 * them with a stable scavenge id. Pure.
 */
export function collectStocks(finds: EnergyFind[], threshold = SCAVENGE_THRESHOLD): GroundStock[] {
  return finds
    .filter(f => f.energy >= threshold)
    .map(f => ({ id: `scavenge-${f.id}`, pos: f.pos, amount: f.energy }));
}

/** Turn a detected stock into a transient PlannerSource (no miner; bounded drain rate). */
export function stockToTransientSource(stock: GroundStock, nodeId: string): PlannerSource {
  return {
    id: stock.id,
    nodeId,
    pos: stock.pos,
    rate: scavengeRate(stock.amount),
    maxMiners: 0,
    transient: true
  };
}

/**
 * Scan a room for scavengeable stocks: dropped energy, plus tombstone and ruin
 * energy. Thin wrapper over the room API; the thresholding/rate logic is the pure
 * functions above.
 */
export function detectRoomStocks(room: Room, threshold = SCAVENGE_THRESHOLD): GroundStock[] {
  const finds: EnergyFind[] = [];

  for (const r of room.find(FIND_DROPPED_RESOURCES)) {
    if (r.resourceType === RESOURCE_ENERGY && r.amount > 0) {
      finds.push({ id: r.id, pos: r.pos, energy: r.amount });
    }
  }
  for (const t of room.find(FIND_TOMBSTONES)) {
    const energy = t.store[RESOURCE_ENERGY];
    if (energy > 0) finds.push({ id: t.id, pos: t.pos, energy });
  }
  for (const ruin of room.find(FIND_RUINS)) {
    const energy = ruin.store[RESOURCE_ENERGY];
    if (energy > 0) finds.push({ id: ruin.id, pos: ruin.pos, energy });
  }

  return collectStocks(finds, threshold);
}
