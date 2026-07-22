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
 * P-CPU meter (spec 23 step 1, observability only): the measured BEFORE
 * number for the cached-routes doctrine. Every metered moveTo's CPU delta
 * accumulates per corp FAMILY (the corpId's first segment - mining/hauling/
 * moving/upgrading/building) in Memory.pathMeter, reset each tick. moveTo
 * includes the path search when the cached path is stale - exactly the cost
 * the RouteCache will delete; the per-family split names the top offender.
 */
export function meteredMoveTo(creep: Creep, target: MoveTarget, opts?: MoveToOpts): ScreepsReturnCode {
  const cpuApi = typeof Game !== "undefined" ? Game.cpu : undefined;
  if (typeof Memory === "undefined" || !cpuApi || typeof cpuApi.getUsed !== "function") {
    return creep.moveTo(target as RoomPosition, opts); // harness/mocks: no meter
  }
  const before = cpuApi.getUsed();
  const result = creep.moveTo(target as RoomPosition, opts);
  const spent = cpuApi.getUsed() - before;
  let meter = Memory.pathMeter;
  if (!meter || meter.tick !== Game.time) {
    meter = { tick: Game.time, calls: 0, cpu: 0, byCorp: {} };
    Memory.pathMeter = meter;
  }
  meter.calls++;
  meter.cpu += spent;
  const family = (creep.memory?.corpId ?? "unattributed").split("-")[0] || "unattributed";
  const slot = (meter.byCorp[family] ??= { calls: 0, cpu: 0 });
  slot.calls++;
  slot.cpu += spent;
  return result;
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

  return meteredMoveTo(creep, target, opts);
}

/**
 * ROAD-LANE travel for haul legs (owner 2026-07-21: "pathfind with ignoring
 * creeps. so they stay on the road. the creeps can just bypass each other as
 * necessary"). Creeps are TRANSIENT obstacles: pathing around them steps the
 * loaded leg off the pavement - at the 2:1 road body that tile is HALF speed,
 * and the detour outlives the blocker. So the lane paths creep-BLIND (long
 * reuse: the route is stable, and skipping the re-searches is CPU off the
 * P-CPU meter's top line). Opposing lane traffic resolves itself: two creeps
 * each moving onto the other's tile swap through (the engine's mutual-move
 * rule - the same physics travelToBypass's forced swap rides). Only a
 * STANDING blocker (parked/working, never leaving the lane) defeats that, so
 * after LANE_PATIENCE consecutive stuck ticks ONE creep-aware repath detours
 * around it and the lane resumes. Fatigue is rest, not a jam; a gap in calls
 * (loading/unloading at an endpoint) resets the clock.
 */
export const LANE_PATIENCE = 2;

export function travelToLane(creep: Creep, target: MoveTarget, opts?: MoveToOpts): ScreepsReturnCode {
  const now = typeof Game !== "undefined" && typeof Game.time === "number" ? Game.time : 0;
  const mem = creep.memory as CreepMemory & { _lane?: { p: string; n: number; t: number } };
  const here = `${creep.pos.roomName}:${creep.pos.x},${creep.pos.y}`;
  const prev = mem._lane && mem._lane.t === now - 1 ? mem._lane : undefined;
  const stuck = prev && prev.p === here && (creep.fatigue ?? 0) === 0 ? prev.n + 1 : 0;
  if (stuck > LANE_PATIENCE) {
    delete mem._lane; // detour issued - the clock restarts on the next call
    return travelTo(creep, target, { ...opts, reusePath: 0, ignoreCreeps: false });
  }
  mem._lane = { p: here, n: stuck, t: now };
  // EMPTY LANE (owner 2026-07-21 re-directive; first tried 2026-07-20 and
  // reverted on a bisected maiden-trip break, now scoped to haul legs only):
  // an empty pure-hauler pays no fatigue, so terrain is free and the
  // geometric line is fastest - while every step on a road still wears it by
  // body.length (measured, load-independent). The outbound leg paths
  // terrain-blind with roads PENALIZED: shorter empty legs where the road
  // detours around swamp, zero empty-leg road wear, and two-lane traffic
  // (loaded on the pavement, empty beside it). The loaded leg keeps the
  // road-preferring defaults.
  const lane = isFatigueFreeWhenEmpty(creep) ? emptyLaneOpts() : undefined;
  return travelTo(creep, target, { reusePath: 20, ...lane, ...opts, ignoreCreeps: true });
}

/** Fatigue-free right now: empty, and every non-MOVE part is CARRY (empty
 * CARRY is weightless; WORK/ATTACK/etc always weigh). Pure predicate -
 * part types compare as their string values ("carry"/"move" === the game
 * constants), so this runs identically in-game and under unit mocks. */
export function isFatigueFreeWhenEmpty(creep: {
  store?: { getUsedCapacity: () => number };
  body?: { type: string }[];
}): boolean {
  if (!creep.store || !creep.body) return false;
  if (creep.store.getUsedCapacity() > 0) return false;
  for (const part of creep.body) {
    if (part.type !== "carry" && part.type !== "move") return false;
  }
  return creep.body.length > 0;
}

/** Road cost on the empty lane: above plain/swamp (1) so the line avoids
 * pavement when a parallel tile exists, below blockers. */
export const EMPTY_LANE_ROAD_COST = 2;
/** Road-position cache TTL (roads change slowly; a stale lane is harmless). */
const EMPTY_LANE_CACHE_TTL = 200;
const roadTileCache = new Map<string, { tick: number; tiles: { x: number; y: number }[] }>();

/** moveTo options for the empty lane: terrain-blind, roads penalized. */
export function emptyLaneOpts(): MoveToOpts {
  return {
    plainCost: 1,
    swampCost: 1,
    ignoreRoads: true,
    costCallback: (roomName: string, matrix: CostMatrix): void => {
      const room = Game.rooms[roomName];
      if (!room) return; // blind rooms: terrain-only is already the lane
      let cached = roadTileCache.get(roomName);
      if (!cached || Game.time - cached.tick >= EMPTY_LANE_CACHE_TTL) {
        cached = {
          tick: Game.time,
          tiles: room
            .find(FIND_STRUCTURES)
            .filter(s => s.structureType === STRUCTURE_ROAD)
            .map(s => ({ x: s.pos.x, y: s.pos.y }))
        };
        roadTileCache.set(roomName, cached);
      }
      for (const t of cached.tiles) {
        // only RAISE plain-cost tiles - never overwrite a blocker (255)
        if (matrix.get(t.x, t.y) < EMPTY_LANE_ROAD_COST) matrix.set(t.x, t.y, EMPTY_LANE_ROAD_COST);
      }
    }
  };
}

/**
 * Is this friendly creep YIELDING - a parked upgrader sitting on its assigned
 * upgrade tile? Such a creep has no travel intent of its own this tick (it camps
 * and upgrades in place) and walks straight back next tick, so swapping through it
 * costs it nothing. This is the only kind of creep the swap rule may displace
 * (see {@link mayDisplace}); it never delays any real work. Pure predicate so the
 * swap rule is unit-testable.
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
 * Can this blocking creep be FORCE-displaced this tick? Only our own creeps can be
 * commanded (`move` on a foreign creep is a no-op), and only if they can physically
 * step: a spawning creep is welded into its spawn and a fatigued one cannot move, so
 * ordering either to swap would leave OUR mover wedged against a tile that never
 * clears (its move onto the still-occupied tile just fails). This is the PHYSICAL
 * gate only - whether the swap is also allowed is {@link mayDisplace}. Pure
 * predicate so the force-swap rule is unit-testable.
 */
export function canForceThrough(blocker: { my?: boolean; spawning?: boolean; fatigue?: number }): boolean {
  return blocker.my === true && blocker.spawning !== true && (blocker.fatigue ?? 0) === 0;
}

/**
 * May we COMMAND this blocker into a mutual swap? Only a yielding parked upgrader
 * ({@link isYielding}) that is physically commandable ({@link canForceThrough}).
 * A yielding upgrader issues no move intent of its own, so our command sticks and
 * both creeps trade tiles; it camps in place and walks straight back next tick, so
 * the swap costs it nothing - this is what threads a hauler through a dense
 * upgrader ring with no gap. Commanding ANY OTHER creep is wrong: a creep already
 * moving has its own intent, and whichever intent lands last wins - either our
 * command drags it backward off the step it chose (measured: the park-settle
 * livelock, two upgraders counter-commanding each other between the same two
 * tiles forever), or its own move overwrites our command and no swap happens. And
 * a creep SEATED on its post (miner on its source tile, hauler mid-service on a
 * drop spot) loses real work when shoved (measured: the #97 regression broke
 * park-settle, both ring cells, and all three plan-fidelity floors). Both are
 * routed around instead. (A follow-the-traveler variant - stepping onto a moving
 * blocker's tile with no command, trusting the engine's move chaining - was
 * measured on fid-t5-real-maze at 25% gross vs 43% without it: followers pile
 * into failed moves behind any stalled head in maze corridors. Don't re-add it.)
 */
export function mayDisplace(
  blocker: {
    my?: boolean;
    spawning?: boolean;
    fatigue?: number;
    pos: { x: number; y: number };
    memory: { workType?: string; upgradeSpot?: { x: number; y: number } };
  }
): boolean {
  return canForceThrough(blocker) && isYielding(blocker);
}

/**
 * Move toward a target like {@link travelTo}, but if the immediate step is blocked
 * by a yielding parked upgrader, FORCE a swap: both creeps step onto each other's
 * tile the same tick. The engine permits this - two creeps each moving onto the
 * other's tile pass through, while a lone mover onto a standing creep is blocked
 * (the "bypass" rule). The displaced upgrader walks back to its post next tick.
 *
 * This swaps ONLY through {@link isYielding} parked upgraders (the full rule is
 * {@link mayDisplace}), threading a hauler into a controller pile ringed by a
 * dense upgrader camp; every other blocker - traveling or seated - is routed
 * around via the creep-aware fallback. We path with `ignoreCreeps` so the route
 * heads straight at the target (revealing the swap) instead of detouring around a
 * ring that has no gap; if the next tile holds no displaceable creep we fall back
 * to normal creep-aware pathing.
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
      if (blocker && mayDisplace(blocker)) {
        blocker.move(blocker.pos.getDirectionTo(creep.pos)); // step onto our tile
        return creep.move(step.direction); // we take its tile - mutual swap
      }
    }
  }
  return travelTo(creep, target, opts);
}

/**
 * Should we HOLD in line behind the creep on our next step toward a contended
 * target, instead of swapping past it? Yes when that creep is one of ours, can
 * still move (so it will eventually clear), is NOT a yielding parked upgrader (a
 * permanent resident of the approach - waiting for it would starve the target),
 * and is strictly CLOSER to the target than we are (genuinely ahead of us in
 * line). Pure predicate so the queue rule is unit-testable.
 */
export function shouldQueueBehind(
  blocker: { my?: boolean; spawning?: boolean; fatigue?: number; pos: RoomPosition; memory: CreepMemory },
  creepRangeToTarget: number,
  targetPosition: RoomPosition
): boolean {
  if (!canForceThrough(blocker)) return false;
  if (isYielding(blocker)) return false;
  return blocker.pos.getRangeTo(targetPosition) < creepRangeToTarget;
}

/**
 * Approach a contended target in SINGLE FILE instead of swarming it. Identical to
 * {@link travelToBypass}, except that when the next step toward the target is
 * blocked by one of our own transient creeps that is AHEAD of us in line (see
 * {@link shouldQueueBehind}), we HOLD our tile rather than swapping past it or
 * letting the pathfinder fan us out around it. That hold IS the queue: approaching
 * creeps stack up along the lane and drain one at a time as the creep at the front
 * reaches the target, services it, and leaves.
 *
 * The creep at the FRONT (nothing closer to the target ahead of it) never queues,
 * so it always advances, services, and frees the spot - the line drains from the
 * head. A yielding parked upgrader ringing the target is force-swapped through (not
 * queued behind), so a dense upgrader camp still can't wall the input off. And a
 * hold is bounded by {@link QUEUE_PATIENCE}: after that many consecutive held ticks
 * the creep gives up waiting and delegates to {@link travelToBypass}, whose
 * creep-aware fallback fans it around the blocker - so even a mis-detected
 * blocker or a head-on stall (two lines meeting nose to nose) can never freeze
 * it permanently.
 *
 * Use this only for one-directional APPROACHES to a shared drop-off/refill spot;
 * use travelToBypass for the return leg (a queued approach meeting a force-swapping
 * departure resolves; two queues meeting head-on would rely on the patience break).
 */
const QUEUE_PATIENCE = 3;

export function travelToQueued(creep: Creep, target: MoveTarget, opts?: MoveToOpts): ScreepsReturnCode {
  const pos = targetPos(target);
  const range = opts?.range ?? 0;
  if (creep.pos.roomName === pos.roomName && creep.pos.getRangeTo(pos) > range) {
    const path = creep.room.findPath(creep.pos, pos, { range, ignoreCreeps: true, maxRooms: 1 });
    if (path.length > 0) {
      const step = path[0];
      const next = new RoomPosition(step.x, step.y, creep.pos.roomName);
      const blocker = next.lookFor(LOOK_CREEPS).find(c => c.name !== creep.name);
      const mem = creep.memory as CreepMemory & { queueHeld?: number };
      const held = mem.queueHeld ?? 0;
      if (blocker && held < QUEUE_PATIENCE && shouldQueueBehind(blocker, creep.pos.getRangeTo(pos), pos)) {
        mem.queueHeld = held + 1;
        return OK; // hold our tile - this is the queue
      }
    }
  }
  // Moving (or forcing) this tick - reset the hold clock.
  delete (creep.memory as CreepMemory & { queueHeld?: number }).queueHeld;
  return travelToBypass(creep, target, opts);
}

/**
 * Standing workers prefer to stand OFF roads (owner 2026-07-22): an idle
 * creep parked on a road plugs the delivery lane for everything moving
 * through - roads decay per STEP, not per standing tick, so the cost of
 * squatting one is congestion, not wear. When the creep is idle ON a road,
 * step to an adjacent tile that keeps its work range to `anchor`: not a
 * wall, not a road, structure-free (a container is somebody's post - a
 * harvest spot, the controller input, the depot), and unoccupied. Plain
 * beats swamp (entering swamp costs fatigue; standing is free either way).
 * Nothing legal -> stay put: work range always beats lane-clearing.
 * Returns true when it issued the step. Costs nothing off-road (one look).
 */
const OFF_ROAD_NEIGHBORS: Array<[number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1]
];

export function stepOffRoad(creep: Creep, anchor: { x: number; y: number }, range: number): boolean {
  const room = creep.room;
  if (typeof room?.lookForAt !== "function" || typeof room?.getTerrain !== "function") return false;
  const onRoad = room
    .lookForAt(LOOK_STRUCTURES, creep.pos.x, creep.pos.y)
    .some(s => s.structureType === STRUCTURE_ROAD);
  if (!onRoad) return false;

  const terrain = room.getTerrain();
  let best: { x: number; y: number } | null = null;
  let bestSwamp = true;
  for (const [dx, dy] of OFF_ROAD_NEIGHBORS) {
    const x = creep.pos.x + dx;
    const y = creep.pos.y + dy;
    if (x < 1 || x > 48 || y < 1 || y > 48) continue;
    if (Math.max(Math.abs(x - anchor.x), Math.abs(y - anchor.y)) > range) continue;
    const t = terrain.get(x, y);
    if (t === TERRAIN_MASK_WALL) continue;
    if (room.lookForAt(LOOK_STRUCTURES, x, y).length > 0) continue;
    if (room.lookForAt(LOOK_CREEPS, x, y).length > 0) continue;
    const swamp = t === TERRAIN_MASK_SWAMP;
    if (best === null || (bestSwamp && !swamp)) {
      best = { x, y };
      bestSwamp = swamp;
      if (!swamp) break; // first plain tile in neighbor order wins
    }
  }
  if (!best) return false;
  creep.moveTo(new RoomPosition(best.x, best.y, room.name));
  return true;
}
