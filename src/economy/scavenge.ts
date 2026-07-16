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

/**
 * Chebyshev range around an OWNED controller inside which energy is the
 * upgraders' working buffer, never scavenge supply - WHILE A FEEDER RELAY
 * MANAGES IT (room.memory.controllerFeederActive). Matches upgrade range and
 * the input-spot buffer scan (controllerInputSpot resolves containers within
 * range 3): under a feeder the input stock is held at CONTROLLER_FEED_TARGET,
 * so planning it as supply commissions haulers to carry the upgraders' own
 * buffer home again - an energy circle the feeder immediately refills, paying
 * transport overhead in both directions forever.
 *
 * The gate matters: BEFORE a room has a feeder (no storage - RCL2/3), the
 * controller drop-off is the colony's OVERFLOW buffer (haulers spill the
 * post-spawn surplus there), and scavenging the overgrown pile back into
 * construction is load-bearing recapture - excluding it unconditionally left
 * the spill to rot (measured: fid-t4-preramped gross fidelity 72% -> 53%,
 * decay 5.5 e/t of 20 mined).
 */
export const CONTROLLER_BUCKET_RANGE = 3;

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

/**
 * Drop finds inside the controller bucket (see CONTROLLER_BUCKET_RANGE). Pure:
 * pass null when the room has no owned controller and everything is kept.
 */
export function excludeControllerBucket(finds: EnergyFind[], controllerPos: Position | null): EnergyFind[] {
  if (!controllerPos) return finds;
  return finds.filter(
    f =>
      Math.max(Math.abs(f.pos.x - controllerPos.x), Math.abs(f.pos.y - controllerPos.y)) > CONTROLLER_BUCKET_RANGE
  );
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
  let finds: EnergyFind[] = [];

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

  // The FEEDER-MANAGED controller bucket is not scavengeable: that energy
  // already reached its destination and the feeder would just refill it (the
  // circle). Without a feeder the drop-off is the overflow buffer and stays
  // scavengeable - recapture of over-spill into construction is load-bearing.
  const ctrl = room.controller;
  const feederManaged = !!ctrl && ctrl.my && !!room.memory.controllerFeederActive;
  finds = excludeControllerBucket(
    finds,
    feederManaged ? { x: ctrl!.pos.x, y: ctrl!.pos.y, roomName: room.name } : null
  );

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
