/**
 * @fileoverview Border-safe creep movement.
 *
 * A creep entering a room lands on that room's edge - an exit tile, x or y == 0
 * or 49. From an exit tile the native pathfinder can pick a step back across the
 * border (it sees the target as reachable that way too), so the creep re-enters
 * the room it came from, paths back, and oscillates on the border forever: the
 * "miner flipping back and forth on the room border" symptom. It never makes
 * inward progress, so a remote miner never reaches its source and a remote hauler
 * never delivers - wasting the whole spawn investment behind that remote.
 *
 * `travelTo` breaks the loop: when the creep is sitting on an exit tile of the
 * very room that holds its target, it takes one raw step straight inward (off the
 * border), ignoring any cached path. Sources, controllers and containers are never
 * on exit tiles, so an inward step always makes progress toward an in-room target;
 * once off the edge, normal moveTo pathing resumes.
 *
 * @module corps/movement
 */

/** A target is either a bare position or anything with a `.pos` (creep, structure, source). */
type MoveTarget = RoomPosition | { pos: RoomPosition };

function targetPos(target: MoveTarget): RoomPosition {
  return (target as { pos?: RoomPosition }).pos ?? (target as RoomPosition);
}

/** Direction (Screeps constant) for a unit step by (dx, dy), each in {-1, 0, 1}. */
function stepDirection(dx: number, dy: number): DirectionConstant {
  if (dx === 0 && dy === -1) return TOP;
  if (dx === 1 && dy === -1) return TOP_RIGHT;
  if (dx === 1 && dy === 0) return RIGHT;
  if (dx === 1 && dy === 1) return BOTTOM_RIGHT;
  if (dx === 0 && dy === 1) return BOTTOM;
  if (dx === -1 && dy === 1) return BOTTOM_LEFT;
  if (dx === -1 && dy === 0) return LEFT;
  return TOP_LEFT; // dx === -1 && dy === -1
}

/**
 * Move a creep toward a target, robust against the room-border bounce. A drop-in
 * replacement for `creep.moveTo(target, opts)` that additionally forces an inward
 * step when the creep is stuck on an exit tile of its target's room.
 */
export function travelTo(creep: Creep, target: MoveTarget, opts?: MoveToOpts): ScreepsReturnCode {
  const pos = targetPos(target);
  const { x, y } = creep.pos;
  const onExit = x === 0 || x === 49 || y === 0 || y === 49;

  // Only intervene when we're on the edge of the room our target is in - that is
  // the bounce: the pathfinder keeps shoving us back across the border instead of
  // letting us walk into the room body. (While still traversing OTHER rooms en
  // route, let moveTo carry us across borders normally.)
  if (onExit && creep.pos.roomName === pos.roomName && !creep.pos.isEqualTo(pos)) {
    const dx = x === 0 ? 1 : x === 49 ? -1 : 0;
    const dy = y === 0 ? 1 : y === 49 ? -1 : 0;
    return creep.move(stepDirection(dx, dy));
  }

  return creep.moveTo(target as RoomPosition, opts);
}

/**
 * Is this friendly creep YIELDING - a parked upgrader sitting on its assigned
 * upgrade tile? Such a creep has no travel intent of its own this tick (it camps
 * and upgrades in place) and walks straight back next tick, so it is safe to swap
 * through. We deliberately do NOT treat other stationary creeps as yielding: we
 * don't want to yank a hauler off its route or a miner off its source. Pure
 * predicate so the swap rule is unit-testable.
 */
export function isYielding(creep: {
  my?: boolean;
  pos: { x: number; y: number };
  memory: { workType?: string; upgradeSpot?: { x: number; y: number } };
}): boolean {
  const spot = creep.memory.upgradeSpot;
  return (
    creep.my === true &&
    creep.memory.workType === "upgrade" &&
    !!spot &&
    creep.pos.x === spot.x &&
    creep.pos.y === spot.y
  );
}

/**
 * Move toward a target like {@link travelTo}, but if the immediate step is blocked
 * by a YIELDING creep (a parked upgrader on its tile), SWAP through it: both
 * creeps step onto each other's tile the same tick. The engine permits this -
 * two creeps each moving onto the other's tile pass through, while a lone mover
 * onto a standing creep is blocked (the "bypass" rule). The displaced upgrader
 * returns to its post next tick.
 *
 * This is what lets a hauler thread in to the shared controller pile/container
 * even when parked upgraders fully ring it (the dense-camp case): without the
 * swap the ring walls the input off and the whole camp starves. We path with
 * `ignoreCreeps` so the route heads straight at the target (revealing the swap)
 * instead of detouring around a ring that has no gap; if the next tile is NOT a
 * yielding creep we fall back to normal creep-aware pathing.
 */
export function travelToBypass(creep: Creep, target: MoveTarget, opts?: MoveToOpts): ScreepsReturnCode {
  const pos = targetPos(target);
  const range = opts?.range ?? 0;
  if (creep.pos.roomName === pos.roomName && creep.pos.getRangeTo(pos) <= range) return OK;

  if (creep.pos.roomName === pos.roomName) {
    const path = creep.room.findPath(creep.pos, pos, { range, ignoreCreeps: true, maxRooms: 1 });
    if (path.length > 0) {
      const step = path[0];
      const next = new RoomPosition(step.x, step.y, creep.pos.roomName);
      const blocker = next.lookFor(LOOK_CREEPS).find(c => c.name !== creep.name);
      if (blocker && isYielding(blocker)) {
        blocker.move(blocker.pos.getDirectionTo(creep.pos)); // step onto our tile
        return creep.move(step.direction); // we take its tile - mutual swap
      }
    }
  }
  return travelTo(creep, target, opts);
}
