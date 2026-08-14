/**
 * @fileoverview guardHoming - WHICH home fields the body for a guarded room.
 *
 * The armed-room lens (`utils/raidMeter.guardTargetsFor`) answers "which armed
 * rooms are in range of this home". It is deliberately per-home and
 * NON-exclusive, because its two budget consumers (CommissionHost's
 * `guardedRoomsLens`, the flow adapter's `infraSpawnLoad` term) fold it over
 * every home into a SET - they want the union, one guard priced per armed
 * room.
 *
 * This module answers the second, different question: of the homes that can
 * see a room, which ONE owns it. The price side (raidGuardKind.propose) and
 * the behaviour side (RaidGuardCorp.guardTargets) both bind through this one
 * rule, so "what we pay to guard a room" and "who actually walks there" cannot
 * become two answers - the same discipline that keeps the armed-room lens
 * itself single-sourced.
 *
 * MEASURED t73003513 (the incident this module exists for): with three home
 * rooms in range of the same three armed rooms, every home's corp claimed all
 * three. Three raidGuard corps stamped the IDENTICAL target set
 * {W43N25, W44N22, W44N23}, each read gate "covered" under its own lens, and
 * each fielded its own bodies - 10 guards / 96 body parts standing for THREE
 * armed rooms, with the colony account's defense line at 10.65 e/t against a
 * 4.16 budget (2.56x). The plan was never wrong: propose() already bound each
 * room to its nearest home and charged it ONCE. Only the runtime double-bought,
 * which is why the fix is a shared binding and not a new price.
 *
 * @module corps/guardHoming
 */

import { roomLinearDistance } from "../utils/RoomDiscovery";
import { MAX_SCOUT_DISTANCE } from "./CorpConstants";

/**
 * The home that owns `target`: nearest by room-linear distance, ties broken
 * lexicographically, out-of-range homes excluded. Undefined when no home can
 * reach it.
 *
 * PURE - no Game/Memory - so the planner's propose() can bind with the exact
 * rule the runtime walks (the conformance purity probe deletes both globals
 * and re-runs propose). The tie-break is not cosmetic: it is what makes the
 * choice DETERMINISTIC across ticks and across the two call sites, so a room
 * never oscillates between two equidistant homes.
 */
export function nearestGuardHome(target: string, homeRooms: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const home of homeRooms) {
    const d = roomLinearDistance(home, target);
    if (d > MAX_SCOUT_DISTANCE) continue;
    if (d < bestDistance || (d === bestDistance && best !== undefined && home.localeCompare(best) < 0)) {
      bestDistance = d;
      best = home;
    }
  }
  return best;
}

/**
 * Every room holding one of my spawns - the binding's runtime input.
 *
 * IMPURE (reads Game.spawns), so only runtime callers use it; propose() passes
 * the problem's own spawn rooms instead. Returns [] when Game is absent
 * (harness, golden master), and callers treat that as "no binding known" and
 * keep their unbound behaviour - the same absent-fact default the armed-room
 * lens documents, so a vision gap can never silently stand a guard down.
 */
export function spawnHomeRooms(): string[] {
  if (typeof Game === "undefined" || !Game.spawns) return [];
  const rooms = new Set<string>();
  for (const name in Game.spawns) {
    const room = Game.spawns[name]?.room;
    if (room) rooms.add(room.name);
  }
  return [...rooms].sort();
}
