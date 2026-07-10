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
 * Stable, position-encoded id for a stock: "scavenge-ROOM-X-Y". Mirrors the
 * "intel-ROOM-X-Y" source id so the CarryCorp can parse the pickup position from
 * the id alone, with no live game object to look up.
 */
export function stockId(pos: Position): string {
  return `scavenge-${pos.roomName}-${pos.x}-${pos.y}`;
}

/**
 * Filter raw finds to stocks worth a dedicated scavenger (>= threshold) and tag
 * each with its position-encoded id. Pure.
 */
export function collectStocks(finds: EnergyFind[], threshold = SCAVENGE_THRESHOLD): GroundStock[] {
  return finds
    .filter(f => f.energy >= threshold)
    .map(f => ({ id: stockId(f.pos), pos: f.pos, amount: f.energy }));
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
      finds.push({ pos: r.pos, energy: r.amount });
    }
  }
  for (const t of room.find(FIND_TOMBSTONES)) {
    const energy = t.store[RESOURCE_ENERGY];
    if (energy > 0) finds.push({ pos: t.pos, energy });
  }
  for (const ruin of room.find(FIND_RUINS)) {
    const energy = ruin.store[RESOURCE_ENERGY];
    if (energy > 0) finds.push({ pos: ruin.pos, energy });
  }

  // ONE SUMMED STOCK (owner 2026-07-10): a pile sitting on/next to a stocked
  // container is a single quantity of energy for planning - the container's
  // contents join the pile's find so thresholding and drain-rate sizing see
  // the true stock (execution drains the decaying pile first; nodeEnergy).
  for (const find of finds) {
    const pos = new RoomPosition(find.pos.x, find.pos.y, find.pos.roomName);
    for (const s of pos.findInRange(FIND_STRUCTURES, 0)) {
      if (s.structureType === STRUCTURE_CONTAINER) {
        find.energy += (s as StructureContainer).store[RESOURCE_ENERGY];
      }
    }
  }

  return collectStocks(finds, threshold);
}
