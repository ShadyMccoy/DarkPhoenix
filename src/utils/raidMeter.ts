/**
 * @fileoverview raidMeter - an EXACT mirror of the engine's invader-raid fuse.
 *
 * The engine adds every harvested unit to a per-source `invaderHarvested`
 * counter and fires a raid when a room's sum crosses its goal (spec 13 ground
 * truth). The increment point on our side is HarvestCorp's own successful
 * harvest, so the mirror is tick-exact for OUR harvesting - not the
 * regen-boundary approximation the public bots use (Overmind/bonzAI).
 *
 * Lifecycle (same Memory discipline as the spec-12 defund marks):
 * - ACCRUE  - every successful harvest adds WORKx2 to the room's raidDebt.
 * - RESET   - the hostileRooms() vision pass sights Invader-owned creeps in
 *             the room: the engine zeroed its counter when it spawned them,
 *             so the mirror zeroes too (and stamps lastRaidSeen).
 * - ARMED   - debt >= RAID_ARM_FLOOR: a raid can fire soon; the guard corp
 *             pre-spawns so it is standing at the source when it does.
 * - OVERDUE - debt > RAID_GOAL_CEIL with no raid seen: raids aren't firing
 *             here (no live stronghold in the sector, or every exit borders
 *             an owned/reserved room). The guard disarms; the state is kept
 *             for calibration.
 *
 * Honesty note: the engine's counter may already hold debt we never saw
 * (prior tenants, pre-mark harvesting), so the FIRST raid in a room can come
 * early. The reactive layers (guard-on-sighting + spec-12 defund) cover that;
 * after the first observed raid the mirror is exact.
 *
 * @module utils/raidMeter
 */

import { RAID_ARM_FLOOR, RAID_GOAL_CEIL } from "../economy/primitives";

export type RaidMeterState = "idle" | "armed" | "overdue";

/** Classify a room's accrued raid debt. Pure. */
export function raidMeterState(raidDebt: number | undefined): RaidMeterState {
  const debt = raidDebt ?? 0;
  if (debt > RAID_GOAL_CEIL) return "overdue";
  if (debt >= RAID_ARM_FLOOR) return "armed";
  return "idle";
}

/**
 * Add harvested energy to a room's raid debt. Written straight to Memory at
 * the harvest site - NOT reconstructed from corp state, because harvest corps
 * churn exactly when an invader wipes a remote (the duplicate-miner incident,
 * Memory.ts sourceIds note). Creates the partial-intel-object shape the
 * defund marks already use (RoomDiscovery precedent).
 */
export function accrueRaidDebt(roomName: string, amount: number): void {
  if (amount <= 0) return;
  if (typeof Memory === "undefined") return;
  if (!Memory.roomIntel) Memory.roomIntel = {};
  const intel = Memory.roomIntel[roomName];
  if (intel) {
    intel.raidDebt = (intel.raidDebt ?? 0) + amount;
    intel.lastHarvested = Game.time;
  } else {
    Memory.roomIntel[roomName] = { lastVisit: Game.time, raidDebt: amount, lastHarvested: Game.time } as RoomIntel;
  }
}

/**
 * A raid is being SIGHTED in the room: zero the mirror (the engine zeroed its
 * counter when the raid spawned) and stamp the observation. Idempotent while
 * the raid stays visible.
 */
export function recordRaidSighting(roomName: string): void {
  if (typeof Memory === "undefined") return;
  if (!Memory.roomIntel) Memory.roomIntel = {};
  const intel = Memory.roomIntel[roomName];
  if (intel) {
    intel.raidDebt = 0;
    intel.lastRaidSeen = Game.time;
  } else {
    Memory.roomIntel[roomName] = { lastVisit: Game.time, raidDebt: 0, lastRaidSeen: Game.time } as RoomIntel;
  }
}
