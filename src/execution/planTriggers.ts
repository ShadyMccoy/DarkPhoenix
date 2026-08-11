/**
 * @fileoverview Event-triggered replanning - the trigger DETECTOR (spec 36
 * item 1, P0).
 *
 * The planner's cadence governor re-solves every 50/150 ticks; a durable
 * world transition mid-cadence leaves the plan pricing a world up to a full
 * cadence gone (the retired-remote and stranded-reserver incidents both
 * carried this flavor). This module detects those transitions from DURABLE
 * SIGNALS ONLY (trap list: room state from intel, never creep positions or
 * vision) and asks main.ts to call `runPlanningPhase(true)`.
 *
 * The detector is PURE over two snapshots plus a debounce clock, so the
 * trigger set is unit-pinned. The caller owns snapshot assembly (world
 * reads) and the actual forced call; the CPU governor's bucket still gates -
 * a forced plan is a REQUEST, not a bypass.
 *
 * Trigger set (each a durable transition, per the spec):
 *  - a room flips in RoomDiscovery.hostileRooms (embargo on/off),
 *  - the expansion campaign's state transitions (claim placed / founding
 *    spawn done),
 *  - RCL-up in an owned room,
 *  - a spawn added to / lost from the census.
 *
 * @module execution/planTriggers
 */

/** The durable signals the detector compares between ticks. */
export interface PlanTriggerSnapshot {
  /** Hostile-room set from RoomDiscovery.hostileRooms (any order). */
  hostileRooms: readonly string[];
  /** Expansion campaign phase (Memory.expansion?.state), undefined = none. */
  expansionState?: string;
  /** Controller level per OWNED room. */
  rclByRoom: Record<string, number>;
  /** My-spawn count across owned rooms (the census's spawn set size). */
  spawnCount: number;
}


/**
 * Debounce on FORCED solves: at most one per this many ticks, however many
 * triggers fire (a hostile wave flipping five rooms is ONE replan). Half the
 * governor's 50-tick minimum cadence: fast enough that an embargo reaches
 * the agenda within a tick or two of the intel, slow enough that a flapping
 * signal cannot double the solve load - and the governor's CPU bucket still
 * gates the request behind it.
 */
export const FORCED_SOLVE_DEBOUNCE_TICKS = 25;

/**
 * Which durable transition (if any) separates two snapshots. Returns a
 * human-readable reason for the console/telemetry stamp, or null when the
 * world is (durably) unchanged. First match wins in a fixed order so the
 * stamp is deterministic when several fire at once.
 */
export function planTriggerReason(prev: PlanTriggerSnapshot, curr: PlanTriggerSnapshot): string | null {
  const prevHostile = new Set(prev.hostileRooms);
  const currHostile = new Set(curr.hostileRooms);
  for (const r of currHostile) if (!prevHostile.has(r)) return `hostile-on:${r}`;
  for (const r of prevHostile) if (!currHostile.has(r)) return `hostile-off:${r}`;
  if ((prev.expansionState ?? "") !== (curr.expansionState ?? ""))
    return `expansion:${prev.expansionState ?? "none"}->${curr.expansionState ?? "none"}`;
  // OWNERSHIP transitions (the claim moment / a room lost). The docblock
  // always promised "claim placed" as a trigger, but nothing carried it: the
  // expansion trigger above keys on the campaign's roomName (unchanged by
  // the claim) and spawnCount moves only when the founding spawn STANDS.
  // Under the 50/150t cadence the gap cost up to a cadence; under the
  // fiscal-month term (spec 46 phase A) it cost the MONTH - the
  // exp-t5-claimer cell measured ONE planning pass in 500 ticks, claim
  // @~t35, founding site never placed (first red at #152, bisected
  // 2026-08-11). rclByRoom is already the owned-room lens, so ownership
  // appearing/vanishing is readable from the same durable snapshot.
  for (const room in curr.rclByRoom) {
    if (prev.rclByRoom[room] === undefined) return `owned-room:${room}`;
  }
  for (const room in prev.rclByRoom) {
    if (curr.rclByRoom[room] === undefined) return `owned-room-lost:${room}`;
  }
  for (const room in curr.rclByRoom) {
    const was = prev.rclByRoom[room];
    if (was !== undefined && curr.rclByRoom[room] > was) return `rcl-up:${room}:${was}->${curr.rclByRoom[room]}`;
  }
  if (prev.spawnCount !== curr.spawnCount) return `spawns:${prev.spawnCount}->${curr.spawnCount}`;
  return null;
}

/**
 * Should the caller force a replan THIS tick? Pure: feed it the previous
 * snapshot, the current one, the last forced tick (undefined = never), and
 * now. One decision, debounced; the reason names the trigger for the stamp.
 */
export function shouldForceReplan(
  prev: PlanTriggerSnapshot | undefined,
  curr: PlanTriggerSnapshot,
  lastForcedTick: number | undefined,
  tick: number
): { force: boolean; reason?: string } {
  if (!prev) return { force: false }; // first observation seeds the baseline
  const reason = planTriggerReason(prev, curr);
  if (!reason) return { force: false };
  if (lastForcedTick !== undefined && tick - lastForcedTick < FORCED_SOLVE_DEBOUNCE_TICKS) return { force: false };
  return { force: true, reason };
}

// =============================================================================
// EXECUTION-SIDE STATE (the world half main.ts calls)
// =============================================================================

import { hostileRooms } from "../utils/RoomDiscovery";

/** Persisted detector state (survives resets; a reset re-seeds the baseline). */
interface PlanTriggerState {
  snap: PlanTriggerSnapshot;
  lastForced?: number;
}

const stateHome = (): { planTriggerState?: PlanTriggerState } =>
  Memory as unknown as { planTriggerState?: PlanTriggerState };

/**
 * Assemble the current durable-signal snapshot from the SHARED lenses (trap
 * list: RoomDiscovery for room state, the campaign's persisted identity for
 * expansion - never creep positions or vision).
 */
export function assemblePlanTriggerSnapshot(): PlanTriggerSnapshot {
  const rclByRoom: Record<string, number> = {};
  for (const roomName in Game.rooms) {
    const c = Game.rooms[roomName]?.controller;
    if (c?.my) rclByRoom[roomName] = c.level;
  }
  return {
    hostileRooms: [...hostileRooms()],
    expansionState: Memory.expansion?.roomName,
    rclByRoom,
    spawnCount: Object.keys(Game.spawns ?? {}).length
  };
}

/**
 * The per-tick entry main.ts calls: compares the fresh snapshot against the
 * persisted baseline, decides (debounced), and ADVANCES the baseline either
 * way - a transition observed is a transition absorbed, so a debounced
 * trigger does not re-fire every tick for the rest of its window (the
 * debounce bounds forced-solve FREQUENCY; missing a same-window second flip
 * is the accepted cost, and the cadence solve catches it).
 */
export function checkPlanTriggers(tick: number): { force: boolean; reason?: string } {
  const home = stateHome();
  const curr = assemblePlanTriggerSnapshot();
  const verdict = shouldForceReplan(home.planTriggerState?.snap, curr, home.planTriggerState?.lastForced, tick);
  home.planTriggerState = {
    snap: curr,
    lastForced: verdict.force ? tick : home.planTriggerState?.lastForced
  };
  return verdict;
}
