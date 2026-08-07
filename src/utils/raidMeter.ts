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

import { INVADER_TTL, MAX_SCOUT_DISTANCE, RAID_ARM_FLOOR, RAID_GOAL_CEIL } from "../economy/primitives";

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
 * How recently a room must have been harvested for its armed meter to field
 * a guard: two creep lifetimes - wide enough that no single death, re-solve
 * or vision gap un-arms an active mine, narrow enough that a genuinely
 * abandoned room stands its guard down.
 */
export const GUARD_MINED_RECENCY = 3_000;

/**
 * THE armed-room lens: rooms within scouting range of `homeRoom` that currently
 * want a standing guard, from intel alone.
 *
 * Lives here rather than on the corp because THREE readers need it and the trap
 * list is explicit that they must read the SAME one: RaidGuardCorp (which rooms
 * to hold), CommissionHost (what the guard commission BUDGETS - spec 51 phase 2)
 * and the flow adapter (what the colony ledger DEDUCTS). A price derived from a
 * second copy of this predicate is the two-books failure by construction, and a
 * price derived from a CONSTANT charges a peaceful colony for defense it never
 * fields.
 *
 * Durable signals only (the stranded-reserver trap): NOT live creep positions
 * (flap on every miner death, blind without the dead miner's vision) and NOT the
 * GOAL plan's remote content (remotes flap in and out with home-saturation
 * churn). The signal is the meter's own harvest stamp - raidDebt only grows
 * while we ACTUALLY mine a room, and `lastHarvested` records when we last did.
 *
 * - ARMED (predictive): raidDebt crossed the arm floor and the room was
 *   harvested within GUARD_MINED_RECENCY - the raid can fire any time after
 *   70k, so guarding here pre-positions ahead of the crossing. OVERDUE rooms
 *   (>130k, no raid ever seen) disarm - raids provably don't fire there. A
 *   truly abandoned room disarms when its harvest stamp ages out.
 * - RAID IN PROGRESS (reactive): Invader creeps sighted within their 1500-tick
 *   lifetime with the hostile mark still live - covers rooms whose counter
 *   history we didn't have (first raid after moving in).
 *
 * Owned rooms are never targeted (towers are the home answer, spec 07).
 */
export function guardTargetsFor(homeRoom: string): string[] {
  if (typeof Memory === "undefined" || !Memory.roomIntel) return [];
  // No map (harness, golden master): no range test, so no targets - the same
  // "absent fact = quiet" default the ColonyProblem lens documents.
  if (typeof Game === "undefined" || !Game.map) return [];

  const targets: string[] = [];
  for (const roomName in Memory.roomIntel) {
    if (roomName === homeRoom) continue;
    const intel = Memory.roomIntel[roomName];
    if (!intel) continue;
    if (intel.controllerOwner) continue; // owned rooms never receive raids for us to guard
    if (Game.map.getRoomLinearDistance(homeRoom, roomName) > MAX_SCOUT_DISTANCE) continue;

    const minedRecently = intel.lastHarvested !== undefined && Game.time - intel.lastHarvested < GUARD_MINED_RECENCY;
    const armed = raidMeterState(intel.raidDebt) === "armed" && minedRecently;
    const raidInProgress =
      intel.lastRaidSeen !== undefined &&
      Game.time - intel.lastRaidSeen < INVADER_TTL &&
      (intel.hostileUntil ?? 0) > Game.time;

    if (armed || raidInProgress) targets.push(roomName);
  }
  return targets.sort(); // determinism: stable assignment across ticks
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
