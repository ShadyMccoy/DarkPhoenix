/**
 * @fileoverview Cached walking-distance functions over static world positions.
 *
 * pathDistance() is THE distance function for the planner (economy/flowAdapter),
 * SpawnDirector tie-breaks, FlowGraph discovery, and telemetry. It wraps the
 * expensive PathFinder in a process-lifetime cache keyed by the (static)
 * endpoints, falling back to the analytic estimate when PathFinder is
 * unavailable or cannot complete a path.
 *
 * @module nodes/NodeNavigator
 */

import { Position } from "../types/Position";

/**
 * Estimates walking distance between two positions.
 * Uses Manhattan distance with room distance multiplier.
 */
export function estimateWalkingDistance(from: Position, to: Position): number {
  if (from.roomName === to.roomName) {
    // Same room - use Chebyshev distance (max of dx, dy for 8-directional movement)
    return Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  }

  // Cross-room estimation
  // Parse room names to calculate room distance
  const fromMatch = /^([WE])(\d+)([NS])(\d+)$/.exec(from.roomName);
  const toMatch = /^([WE])(\d+)([NS])(\d+)$/.exec(to.roomName);

  if (!fromMatch || !toMatch) {
    return Infinity;
  }

  // Calculate world coordinates
  const fromWorldX = fromMatch[1] === "E" ? parseInt(fromMatch[2], 10) : -parseInt(fromMatch[2], 10) - 1;
  const fromWorldY = fromMatch[3] === "N" ? -parseInt(fromMatch[4], 10) - 1 : parseInt(fromMatch[4], 10);
  const toWorldX = toMatch[1] === "E" ? parseInt(toMatch[2], 10) : -parseInt(toMatch[2], 10) - 1;
  const toWorldY = toMatch[3] === "N" ? -parseInt(toMatch[4], 10) - 1 : parseInt(toMatch[4], 10);

  // Room distance
  const roomDx = Math.abs(toWorldX - fromWorldX);
  const roomDy = Math.abs(toWorldY - fromWorldY);

  // Estimate: each room crossing is ~50 tiles, plus in-room distance
  const roomDistance = Math.max(roomDx, roomDy) * 50;
  const inRoomOffset = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));

  return roomDistance + inRoomOffset;
}

/**
 * Cache of real path distances keyed by the two (static) endpoint positions.
 * Sources, spawns and controllers never move, so a path computed once is valid
 * for the life of the process; in real Screeps this resets on a global reset,
 * which simply recomputes. Keeps PathFinder (expensive) off the per-tick path.
 */
const pathDistanceCache = new Map<string, number>();

function positionKey(p: Position): string {
  return `${p.roomName}:${p.x},${p.y}`;
}

/** Clear the path-distance cache. Test seam; not used in the live game. */
export function clearPathDistanceCache(): void {
  pathDistanceCache.clear();
}

/**
 * Real walking distance (in tile-steps) between two positions via PathFinder,
 * cached by the endpoints. Falls back to {@link estimateWalkingDistance} when
 * PathFinder is unavailable or cannot complete a path - e.g. unit-test mocks, or
 * a remote whose terrain isn't loaded - so callers always get a finite number.
 *
 * This is what the remote-mining profitability gate needs. The analytic estimate
 * ignores walls and swamps, so a source a few tiles away as the crow flies but
 * walled off behind a long detour looks far cheaper to haul from than it is -
 * the colony then opens remotes it can never haul home profitably (the "lots of
 * miners out, little energy back" failure). Real path cost reflects the detour,
 * so the planner rejects those remotes.
 */
export function pathDistance(from: Position, to: Position): number {
  const key = `${positionKey(from)}->${positionKey(to)}`;
  const cached = pathDistanceCache.get(key);
  if (cached !== undefined) return cached;

  const estimate = estimateWalkingDistance(from, to);
  let result = estimate;

  const pf = (globalThis as { PathFinder?: typeof PathFinder }).PathFinder;
  const RP = (globalThis as { RoomPosition?: typeof RoomPosition }).RoomPosition;
  if (pf && typeof pf.search === "function" && typeof RP === "function") {
    try {
      const origin = new RP(from.x, from.y, from.roomName);
      const goal = { pos: new RP(to.x, to.y, to.roomName), range: 1 };
      const search = pf.search(origin, goal, {
        plainCost: 1,
        swampCost: 5,
        maxOps: 4000,
        maxRooms: 16
      });
      // A real completed path: trust its step count. The mock (and an
      // unreachable/unloaded target) returns an empty or incomplete path - keep
      // the analytic estimate in that case.
      if (search && !search.incomplete && search.path && search.path.length > 0) {
        result = search.path.length;
      }
    } catch {
      result = estimate;
    }
  }

  pathDistanceCache.set(key, result);
  return result;
}
