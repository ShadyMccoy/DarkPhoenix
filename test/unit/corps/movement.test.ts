/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { shouldQueueBehind, travelTo, travelToBypass, travelToQueued } from "../../../src/corps/movement";

// Screeps direction constants (globals in-game).
const DIRS: Record<string, number> = {
  TOP: 1, TOP_RIGHT: 2, RIGHT: 3, BOTTOM_RIGHT: 4, BOTTOM: 5, BOTTOM_LEFT: 6, LEFT: 7, TOP_LEFT: 8,
};

/** dx,dy in {-1,0,1} -> Screeps direction constant, matching stepDirection in movement.ts. */
function dirOf(dx: number, dy: number): number {
  const map: Record<string, number> = {
    "0,-1": DIRS.TOP, "1,-1": DIRS.TOP_RIGHT, "1,0": DIRS.RIGHT, "1,1": DIRS.BOTTOM_RIGHT,
    "0,1": DIRS.BOTTOM, "-1,1": DIRS.BOTTOM_LEFT, "-1,0": DIRS.LEFT, "-1,-1": DIRS.TOP_LEFT,
  };
  return map[`${dx},${dy}`];
}

function pos(x: number, y: number, roomName: string) {
  return {
    x, y, roomName,
    isEqualTo(t: any) {
      return t.x === x && t.y === y && (t.roomName === undefined || t.roomName === roomName);
    },
  };
}

/** A creep stub that records whether move() (raw step) or moveTo() (pathfinder) was called. */
function creepAt(x: number, y: number, roomName: string) {
  const calls = { move: undefined as number | undefined, moveTo: undefined as any };
  return {
    pos: pos(x, y, roomName),
    move(dir: number) { calls.move = dir; return 0; },
    moveTo(target: any, _opts: any) { calls.moveTo = target; return 0; },
    calls,
  };
}

describe("travelTo (border-bounce-safe movement)", () => {
  before(() => {
    for (const [name, val] of Object.entries(DIRS)) (global as any)[name] = val;
  });

  it("steps INWARD (raw move, no pathfinder) when stuck on the target room's west exit", () => {
    // On x=0 of W1N0 with the target inside W1N0: the pathfinder would bounce us
    // back across the border, so we step east (inward) with a raw move instead.
    const creep = creepAt(0, 25, "W1N0");
    travelTo(creep as any, pos(25, 25, "W1N0") as any);
    expect(creep.calls.move, "raw inward step").to.equal(DIRS.RIGHT);
    expect(creep.calls.moveTo, "pathfinder NOT used on the exit").to.equal(undefined);
  });

  it("steps inward from each edge (east, north, south) and the corners", () => {
    const east = creepAt(49, 25, "W1N0");
    travelTo(east as any, pos(25, 25, "W1N0") as any);
    expect(east.calls.move).to.equal(DIRS.LEFT);

    const north = creepAt(25, 0, "W1N0");
    travelTo(north as any, pos(25, 25, "W1N0") as any);
    expect(north.calls.move).to.equal(DIRS.BOTTOM);

    const south = creepAt(25, 49, "W1N0");
    travelTo(south as any, pos(25, 25, "W1N0") as any);
    expect(south.calls.move).to.equal(DIRS.TOP);

    const corner = creepAt(0, 0, "W1N0"); // top-left corner -> step toward bottom-right
    travelTo(corner as any, pos(25, 25, "W1N0") as any);
    expect(corner.calls.move).to.equal(DIRS.BOTTOM_RIGHT);
  });

  it("biases the inward step toward the target so it lands DIAGONALLY onto the road", () => {
    // The bug this fixes (owner 2026-07-22): a creep entering on the north edge
    // whose road/target sits to the south-west used to step straight SOUTH, off
    // the road, then pay an extra move-fatigue tick to slide onto it. The free
    // (non-border) axis now points at the target, so the step is SW.
    const nwTarget = creepAt(25, 0, "W1N0"); // north edge, target to the SW
    travelTo(nwTarget as any, pos(10, 30, "W1N0") as any);
    expect(nwTarget.calls.move, "north edge, target SW -> BOTTOM_LEFT").to.equal(DIRS.BOTTOM_LEFT);

    const neTarget = creepAt(25, 0, "W1N0"); // north edge, target to the SE
    travelTo(neTarget as any, pos(40, 30, "W1N0") as any);
    expect(neTarget.calls.move, "north edge, target SE -> BOTTOM_RIGHT").to.equal(DIRS.BOTTOM_RIGHT);

    const westTarget = creepAt(0, 25, "W1N0"); // west edge, target to the NE
    travelTo(westTarget as any, pos(30, 10, "W1N0") as any);
    expect(westTarget.calls.move, "west edge, target NE -> TOP_RIGHT").to.equal(DIRS.TOP_RIGHT);
  });

  it("does NOT bias the step onto an adjacent exit tile (that would re-arm a crossing)", () => {
    // Near the top-left corner on the north edge (1,0): the target is due west,
    // so the free-axis bias points at x=0 - an exit tile. The guard drops the
    // bias and we step straight inward instead of re-crossing.
    const nearCorner = creepAt(1, 0, "W1N0");
    travelTo(nearCorner as any, pos(0, 30, "W1N0") as any);
    expect(nearCorner.calls.move, "bias to x=0 is dropped -> straight BOTTOM").to.equal(DIRS.BOTTOM);
  });

  it("uses normal pathfinding when NOT on an exit tile", () => {
    const creep = creepAt(25, 25, "W1N0");
    const target = pos(40, 40, "W1N0");
    travelTo(creep as any, target as any);
    expect(creep.calls.moveTo, "delegates to moveTo off the edge").to.equal(target);
    expect(creep.calls.move).to.equal(undefined);
  });

  it("lets moveTo carry the creep ACROSS a border (target in a different room)", () => {
    // On the east edge of W0N0 heading to W1N0: this is a real crossing, not a
    // bounce - moveTo should step it over, so we do NOT force an inward step.
    const creep = creepAt(49, 25, "W0N0");
    const target = pos(10, 25, "W1N0");
    travelTo(creep as any, target as any);
    expect(creep.calls.moveTo).to.equal(target);
    expect(creep.calls.move).to.equal(undefined);
  });

  it("does not step inward when already on the exact target tile (even on an exit)", () => {
    // Standing on the target that happens to be an exit tile: no forced inward step
    // (that would walk us off our destination); delegate to moveTo (a no-op in-game).
    const creep = creepAt(0, 25, "W1N0");
    travelTo(creep as any, pos(0, 25, "W1N0") as any);
    expect(creep.calls.move, "no inward step off the target").to.equal(undefined);
  });

  it("accepts a target with a .pos (structure/source), not just a bare position", () => {
    const creep = creepAt(0, 25, "W1N0");
    travelTo(creep as any, { pos: pos(25, 25, "W1N0") } as any);
    expect(creep.calls.move).to.equal(DIRS.RIGHT);
  });
});

describe("travelToBypass (force-swap through a boxed-in blocker)", () => {
  const ROOM = "W1N0";

  // A registry of creeps by tile so a mocked RoomPosition.lookFor(LOOK_CREEPS)
  // can report who stands on the next path step.
  let occupants: Record<string, any>;

  // Mocked RoomPosition: travelToBypass does `new RoomPosition(x, y, room).lookFor(...)`.
  class MockPos {
    constructor(public x: number, public y: number, public roomName: string) {}
    getRangeTo(t: any) { return Math.max(Math.abs(this.x - t.x), Math.abs(this.y - t.y)); }
    getDirectionTo(t: any) { return dirOf(Math.sign(t.x - this.x), Math.sign(t.y - this.y)); }
    isEqualTo(t: any) { return t.x === this.x && t.y === this.y; }
    lookFor(_type: string) {
      const c = occupants[`${this.x},${this.y}`];
      return c ? [c] : [];
    }
  }

  let prevRoomPosition: any;
  before(() => {
    for (const [name, val] of Object.entries(DIRS)) (global as any)[name] = val;
    (global as any).LOOK_CREEPS = "creep";
    (global as any).OK = 0;
    prevRoomPosition = (global as any).RoomPosition;
    (global as any).RoomPosition = MockPos;
  });
  after(() => { (global as any).RoomPosition = prevRoomPosition; });

  beforeEach(() => { occupants = {}; });

  // A one-step path straight up (target directly north). The requester sits at
  // (25,20); its next step (25,19) is where the blocker stands.
  function requesterWith(blocker: any) {
    const calls = { move: undefined as number | undefined, moveTo: undefined as any };
    const creep = {
      name: "req",
      pos: new MockPos(25, 20, ROOM),
      memory: {} as any,
      room: {
        findPath: () => [{ x: 25, y: 19, dx: 0, dy: -1, direction: DIRS.TOP }],
      },
      move(dir: number) { calls.move = dir; return 0; },
      moveTo(t: any) { calls.moveTo = t; return 0; },
      calls,
    };
    if (blocker) occupants["25,19"] = blocker;
    return creep;
  }

  function blockerAt(over: any) {
    const bcalls = { move: undefined as number | undefined };
    return {
      name: "blk",
      my: true,
      spawning: false,
      fatigue: 0,
      pos: new MockPos(25, 19, ROOM),
      move(dir: number) { bcalls.move = dir; return 0; },
      bcalls,
      ...over,
    };
  }

  it("swaps through a YIELDING parked upgrader: both step onto each other's tile", () => {
    // The ring-bypass: a parked upgrader on its cached tile issues no move intent
    // of its own, so the swap command sticks - and it walks straight back next
    // tick. This is the ONLY creep the swap rule may displace.
    const upgrader = blockerAt({ memory: { workType: "upgrade", upgradeSpot: { x: 25, y: 19 } } });
    const creep = requesterWith(upgrader);

    travelToBypass(creep as any, new MockPos(25, 8, ROOM) as any, { range: 0 } as any);

    // We advance toward the target (north)...
    expect(creep.calls.move, "requester steps into the upgrader's tile").to.equal(DIRS.TOP);
    // ...and the upgrader is commanded onto OUR tile (south) - the mutual swap.
    expect(upgrader.bcalls.move, "the upgrader steps onto our tile").to.equal(DIRS.BOTTOM);
    // No fallback pathfinding was used.
    expect(creep.calls.moveTo).to.equal(undefined);
  });

  it("does NOT command a non-yielding sibling; falls back to creep-aware pathing", () => {
    // Commanding a moving creep overwrites the step it chose (the park-settle
    // counter-command livelock); commanding a seated one knocks it off its work
    // (the #97 regression). Either way: route around, never through.
    const blocker = blockerAt({ memory: { workType: "haul" } });
    const creep = requesterWith(blocker);

    travelToBypass(creep as any, new MockPos(25, 8, ROOM) as any, { range: 0 } as any);

    expect(blocker.bcalls.move, "the sibling is left alone").to.equal(undefined);
    expect(creep.calls.move, "no raw swap step").to.equal(undefined);
    expect(creep.calls.moveTo, "falls back to creep-aware pathing").to.not.equal(undefined);
  });

  it("does NOT command an upgrader that is not yet on its assigned tile", () => {
    const walking = blockerAt({ memory: { workType: "upgrade", upgradeSpot: { x: 25, y: 18 } } });
    const creep = requesterWith(walking);

    travelToBypass(creep as any, new MockPos(25, 8, ROOM) as any, { range: 0 } as any);

    expect(walking.bcalls.move, "an in-transit upgrader keeps its own intent").to.equal(undefined);
    expect(creep.calls.moveTo, "falls back to moveTo").to.not.equal(undefined);
  });

  it("does NOT command a foreign blocker; falls back to creep-aware pathing", () => {
    const blocker = blockerAt({ my: false, memory: { workType: "upgrade", upgradeSpot: { x: 25, y: 19 } } });
    const creep = requesterWith(blocker);

    travelToBypass(creep as any, new MockPos(25, 8, ROOM) as any, { range: 0 } as any);

    expect(blocker.bcalls.move, "cannot move a creep we don't own").to.equal(undefined);
    expect(creep.calls.moveTo, "falls back to moveTo").to.not.equal(undefined);
  });

  it("does NOT force through a fatigued yielding upgrader (its tile would never clear)", () => {
    const blocker = blockerAt({ fatigue: 2, memory: { workType: "upgrade", upgradeSpot: { x: 25, y: 19 } } });
    const creep = requesterWith(blocker);

    travelToBypass(creep as any, new MockPos(25, 8, ROOM) as any, { range: 0 } as any);

    expect(blocker.bcalls.move).to.equal(undefined);
    expect(creep.calls.moveTo, "falls back to moveTo").to.not.equal(undefined);
  });

  it("returns OK without moving when already within range of the target", () => {
    const creep = requesterWith(null);
    const r = travelToBypass(creep as any, new MockPos(25, 20, ROOM) as any, { range: 1 } as any);
    expect(r).to.equal(0);
    expect(creep.calls.move).to.equal(undefined);
    expect(creep.calls.moveTo).to.equal(undefined);
  });

  // travelToQueued shares the same geometry: creep (25,20), next step (25,19),
  // target (25,8). A blocker on (25,19) is range 11 from the target, the creep is
  // range 12 - so the blocker is strictly AHEAD in line.
  describe("travelToQueued (single-file, no swarm)", () => {
    it("HOLDS behind a transient creep ahead in line (no move, no swap)", () => {
      const ahead = blockerAt({ memory: { workType: "haul" } }); // ours, movable, not yielding, closer
      const creep = requesterWith(ahead);

      const r = travelToQueued(creep as any, new MockPos(25, 8, ROOM) as any, { range: 0 } as any);

      expect(r, "holds its tile").to.equal(0);
      expect(creep.calls.move, "does not swap past the creep ahead").to.equal(undefined);
      expect(creep.calls.moveTo, "does not fan out around it").to.equal(undefined);
      expect(ahead.bcalls.move, "the creep ahead is left alone").to.equal(undefined);
    });

    it("does NOT queue behind a yielding upgrader - force-swaps through it", () => {
      // A parked upgrader ringing the target is a permanent resident; waiting for it
      // would starve the spot, so travelToQueued delegates to the force-swap.
      const upgrader = blockerAt({ memory: { workType: "upgrade", upgradeSpot: { x: 25, y: 19 } } });
      const creep = requesterWith(upgrader);

      travelToQueued(creep as any, new MockPos(25, 8, ROOM) as any, { range: 0 } as any);

      expect(creep.calls.move, "threads through the ring").to.equal(DIRS.TOP);
      expect(upgrader.bcalls.move, "the upgrader steps onto our tile").to.equal(DIRS.BOTTOM);
    });

    it("the FRONT creep (no one ahead) advances normally", () => {
      const creep = requesterWith(null); // nothing on the next tile
      travelToQueued(creep as any, new MockPos(25, 8, ROOM) as any, { range: 0 } as any);
      // No blocker -> delegates to travelToBypass -> travelTo -> moveTo toward target.
      expect(creep.calls.moveTo, "the head of the line keeps moving").to.not.equal(undefined);
    });

    it("breaks a stall: after QUEUE_PATIENCE held ticks it fans AROUND the blocker", () => {
      // The creep ahead is not clearing (servicing the spot, or a head-on line).
      // Patience runs out, then we stop waiting and path creep-aware around it -
      // never commanding it aside (the #97 regression / counter-command livelock).
      const ahead = blockerAt({ memory: { workType: "haul" } });
      const creep = requesterWith(ahead);
      const target = new MockPos(25, 8, ROOM) as any;

      // Ticks 1-3: holds in line, incrementing the hold clock, never swapping.
      for (let t = 0; t < 3; t++) {
        travelToQueued(creep as any, target, { range: 0 } as any);
        expect(creep.calls.move, `tick ${t + 1} holds`).to.equal(undefined);
        expect(ahead.bcalls.move, `tick ${t + 1} leaves the creep ahead alone`).to.equal(undefined);
      }
      expect(creep.memory.queueHeld).to.equal(3);

      // Tick 4: patience exhausted -> creep-aware fallback, hold clock reset.
      travelToQueued(creep as any, target, { range: 0 } as any);
      expect(ahead.bcalls.move, "the blocker is never commanded").to.equal(undefined);
      expect(creep.calls.move, "no raw swap step").to.equal(undefined);
      expect(creep.calls.moveTo, "fans around via creep-aware pathing").to.not.equal(undefined);
      expect(creep.memory.queueHeld, "hold clock reset").to.equal(undefined);
    });
  });
});

describe("shouldQueueBehind (queue gate)", () => {
  function posAt(x: number, y: number) {
    return { x, y, getRangeTo: (t: any) => Math.max(Math.abs(x - t.x), Math.abs(y - t.y)) };
  }
  const target = posAt(25, 8);
  // The creep deciding whether to queue sits at (25,20): range 12 from the target.
  const CREEP_RANGE = 12;
  const make = (over: any) => ({
    my: true,
    spawning: false,
    fatigue: 0,
    pos: posAt(25, 19), // range 11 - strictly closer than the creep
    memory: { workType: "haul" },
    ...over
  });

  it("queues behind a movable, non-yielding creep that is closer to the target", () => {
    expect(shouldQueueBehind(make({}) as any, CREEP_RANGE, target as any)).to.equal(true);
  });

  it("does NOT queue behind a creep at the same distance (would be a mutual stalemate)", () => {
    expect(shouldQueueBehind(make({ pos: posAt(24, 20) }) as any, CREEP_RANGE, target as any)).to.equal(false);
  });

  it("does NOT queue behind a creep FURTHER from the target (it is not ahead)", () => {
    expect(shouldQueueBehind(make({ pos: posAt(25, 21) }) as any, CREEP_RANGE, target as any)).to.equal(false);
  });

  it("does NOT queue behind a yielding parked upgrader (force-swap it instead)", () => {
    const upg = make({ memory: { workType: "upgrade", upgradeSpot: { x: 25, y: 19 } } });
    expect(shouldQueueBehind(upg as any, CREEP_RANGE, target as any)).to.equal(false);
  });

  it("does NOT queue behind a foreign creep (cannot be commanded, may never move)", () => {
    expect(shouldQueueBehind(make({ my: false }) as any, CREEP_RANGE, target as any)).to.equal(false);
  });

  it("does NOT queue behind a fatigued/spawning creep (handed to the force-swap gate)", () => {
    expect(shouldQueueBehind(make({ fatigue: 2 }) as any, CREEP_RANGE, target as any)).to.equal(false);
    expect(shouldQueueBehind(make({ spawning: true }) as any, CREEP_RANGE, target as any)).to.equal(false);
  });
});

/**
 * Road-lane travel for haul legs (owner 2026-07-21: "pathfind with ignoring
 * creeps. so they stay on the road. the creeps can just bypass each other as
 * necessary"). Pathing AROUND transient creeps steps the loaded leg off the
 * pavement - at the 2:1 road body that tile is HALF speed - so the lane paths
 * creep-blind and holds the road. Opposing lane traffic resolves itself (two
 * creeps moving into each other's tiles swap through, the engine's
 * mutual-move rule); only a STANDING blocker defeats that, so after
 * LANE_PATIENCE stuck ticks one creep-aware repath detours around it.
 */
describe("travelToLane (haul legs hold the road; standing blockers get one detour)", () => {
  const { travelToLane } = require("../../../src/corps/movement");

  function laneCreep(x: number, y: number) {
    const calls: any[] = [];
    return {
      name: "h1",
      pos: pos(x, y, "W1N0"),
      fatigue: 0,
      memory: {} as any,
      move: () => 0,
      moveTo(_t: any, opts: any) {
        calls.push(opts ?? {});
        return 0;
      },
      calls
    };
  }

  beforeEach(() => {
    (global as any).Game = { time: 100 };
  });

  it("paths IGNORING creeps with a long reuse - the road is the lane", () => {
    const c = laneCreep(10, 10);
    travelToLane(c as any, pos(30, 10, "W1N0") as any);
    expect(c.calls[0].ignoreCreeps).to.equal(true);
    expect(c.calls[0].reusePath, "stable lane, cheap CPU").to.be.greaterThan(5);
  });

  it("head-on traffic needs no detour: a MOVING creep never trips the patience", () => {
    const c = laneCreep(10, 10);
    for (let t = 0; t < 6; t++) {
      (global as any).Game.time = 100 + t;
      travelToLane(c as any, pos(30, 10, "W1N0") as any);
      (c.pos as any).x += 1; // it moved (swapped through the oncoming creep)
    }
    expect(c.calls.every((o: any) => o.ignoreCreeps === true)).to.equal(true);
  });

  it("a STANDING blocker trips ONE creep-aware detour once patience runs out", () => {
    const c = laneCreep(10, 10);
    for (let t = 0; t < 4; t++) {
      (global as any).Game.time = 100 + t;
      travelToLane(c as any, pos(30, 10, "W1N0") as any); // never moves
    }
    const last = c.calls[c.calls.length - 1];
    expect(last.ignoreCreeps, "the detour sees creeps").to.equal(false);
    expect(last.reusePath, "fresh path, not the cached lane").to.equal(0);
    expect(
      c.calls.slice(0, -1).every((o: any) => o.ignoreCreeps === true),
      "the lane held until patience ran out"
    ).to.equal(true);
    // the detour resets the clock: the next call is back on the lane
    (global as any).Game.time = 104;
    travelToLane(c as any, pos(30, 10, "W1N0") as any);
    expect(c.calls[c.calls.length - 1].ignoreCreeps).to.equal(true);
  });

  it("fatigue is rest, not a jam: a fatigued creep never trips the detour", () => {
    const c = laneCreep(10, 10);
    c.fatigue = 4;
    for (let t = 0; t < 6; t++) {
      (global as any).Game.time = 100 + t;
      travelToLane(c as any, pos(30, 10, "W1N0") as any);
    }
    expect(c.calls.every((o: any) => o.ignoreCreeps === true)).to.equal(true);
  });

  it("a gap in calls (loading at the container) resets the patience", () => {
    const c = laneCreep(10, 10);
    for (const t of [100, 101, 102]) {
      (global as any).Game.time = t;
      travelToLane(c as any, pos(30, 10, "W1N0") as any);
    }
    (global as any).Game.time = 110; // stood loading for 8 ticks, no travel calls
    travelToLane(c as any, pos(30, 10, "W1N0") as any);
    (global as any).Game.time = 111;
    travelToLane(c as any, pos(30, 10, "W1N0") as any);
    expect(c.calls.every((o: any) => o.ignoreCreeps === true)).to.equal(true);
  });

  it("caller opts ride along (range, visuals) but never the lane keys", () => {
    const c = laneCreep(10, 10);
    travelToLane(c as any, pos(30, 10, "W1N0") as any, { range: 1 });
    expect(c.calls[0].range).to.equal(1);
    expect(c.calls[0].ignoreCreeps).to.equal(true);
  });
});

describe("travelToLane EMPTY LANE (outbound off the pavement; loaded leg keeps it)", () => {
  const { travelToLane, isFatigueFreeWhenEmpty } = require("../../../src/corps/movement");

  function haulerStub(loaded: number, body: string[] = ["carry", "move"]) {
    const calls: any[] = [];
    return {
      name: "h2",
      pos: pos(10, 10, "W1N0"),
      fatigue: 0,
      memory: {} as any,
      store: { getUsedCapacity: () => loaded },
      body: body.map(type => ({ type })),
      move: () => 0,
      moveTo(_t: any, opts: any) {
        calls.push(opts ?? {});
        return 0;
      },
      calls
    };
  }

  beforeEach(() => {
    (global as any).Game = { time: 200, rooms: {} };
  });

  it("an EMPTY pure hauler paths terrain-blind (swamp = plain = 1), roads penalized", () => {
    const c = haulerStub(0);
    travelToLane(c as any, pos(30, 10, "W1N0") as any);
    const o = c.calls[0];
    expect(o.plainCost).to.equal(1);
    expect(o.swampCost).to.equal(1);
    expect(o.ignoreCreeps, "the lane still ignores creeps").to.equal(true);
    expect(typeof o.costCallback, "roads raised via the matrix").to.equal("function");
  });

  it("a LOADED hauler keeps the road-preferring defaults (no terrain-blind costs)", () => {
    const c = haulerStub(100);
    travelToLane(c as any, pos(30, 10, "W1N0") as any);
    const o = c.calls[0];
    expect(o.plainCost).to.equal(undefined);
    expect(o.swampCost).to.equal(undefined);
    expect(o.ignoreCreeps).to.equal(true);
    // ...but it DOES carry a costCallback so it routes around parked upgraders.
    expect(typeof o.costCallback, "loaded leg penalizes upgrader tiles").to.equal("function");
  });

  it("a WORK-carrying creep never rides the empty lane (its WORK always weighs)", () => {
    expect(isFatigueFreeWhenEmpty({ store: { getUsedCapacity: () => 0 }, body: [{ type: "work" }, { type: "move" }] })).to.equal(false);
    expect(isFatigueFreeWhenEmpty({ store: { getUsedCapacity: () => 0 }, body: [{ type: "carry" }, { type: "move" }] })).to.equal(true);
    expect(isFatigueFreeWhenEmpty({ store: { getUsedCapacity: () => 50 }, body: [{ type: "carry" }, { type: "move" }] })).to.equal(false);
  });
});

/**
 * Haul legs give a live upgrader-in-position an unfavorable cost so the lane
 * routes AROUND it instead of pathing straight through and force-swapping it
 * off its post (owner 2026-07-25: haulers "kick the upgraders off their spots,
 * although they don't really have to, they just happen to path through
 * sometimes"). The penalty is a preference, never a wall - a target genuinely
 * ringed by upgraders stays reachable.
 */
describe("penalizeUpgraderTiles (haul legs route around parked upgraders)", () => {
  const { penalizeUpgraderTiles, UPGRADER_TILE_COST } = require("../../../src/corps/movement");

  // A CostMatrix stub recording the highest value stamped on each tile.
  function matrixStub() {
    const cells: Record<string, number> = {};
    return {
      get: (x: number, y: number) => cells[`${x},${y}`] ?? 0,
      set: (x: number, y: number, v: number) => {
        cells[`${x},${y}`] = v;
      },
      cells
    };
  }

  function upgrader(x: number, y: number, spot: { x: number; y: number }) {
    return { my: true, pos: { x, y }, memory: { workType: "upgrade", upgradeSpot: spot } };
  }

  before(() => {
    (global as any).FIND_MY_CREEPS = "myCreeps";
  });

  beforeEach(() => {
    (global as any).Game = { time: 300, rooms: {} };
  });

  it("stamps the penalty on the tile of an upgrader SITTING ON its assigned spot", () => {
    const creep = upgrader(25, 19, { x: 25, y: 19 });
    (global as any).Game.rooms.W1N0 = { find: (_t: any) => [creep] };
    const m = matrixStub();
    penalizeUpgraderTiles("W1N0", m as any);
    expect(m.get(25, 19)).to.equal(UPGRADER_TILE_COST);
    expect(UPGRADER_TILE_COST, "a preference, not a wall").to.be.lessThan(255);
  });

  it("leaves an in-transit upgrader (not yet on its spot) alone", () => {
    const creep = upgrader(25, 18, { x: 25, y: 19 }); // walking toward its spot
    (global as any).Game.rooms.W1N0 = { find: (_t: any) => [creep] };
    const m = matrixStub();
    penalizeUpgraderTiles("W1N0", m as any);
    expect(m.get(25, 18)).to.equal(0);
  });

  it("never lowers an existing blocker cost (only raises)", () => {
    const creep = upgrader(25, 19, { x: 25, y: 19 });
    (global as any).Game.rooms.W1N0 = { find: (_t: any) => [creep] };
    const m = matrixStub();
    m.set(25, 19, 255); // already a wall
    penalizeUpgraderTiles("W1N0", m as any);
    expect(m.get(25, 19), "a wall stays a wall").to.equal(255);
  });

  it("is a no-op in a room with no vision (find unavailable)", () => {
    const m = matrixStub();
    expect(() => penalizeUpgraderTiles("W9N9", m as any)).to.not.throw();
  });
});

/**
 * HOSTILE-AWARE CROSS-ROOM TRAVEL (the stronghold-grinder incident,
 * t72972253): the walker is the third lens of the route decision, and it was
 * the naive one - miners born at W43N24 walked findRoute's default corridor
 * [W44N24, W45N24] straight into live-marked stronghold rooms and died at a
 * ~150-tick cadence. travelTo now steers cross-room legs along
 * safeRouteRooms' hostile-free corridor when one exists (stepping room by
 * room, the buster's own travel pattern); with no marks, or no safe
 * corridor, or an in-room target, behavior is bit-identical to before.
 */
describe("travelTo (hostile-aware cross-room steering, t72972253)", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any };
  let savedGame: unknown;
  let savedMemory: unknown;
  let time = 95_000;

  before(() => {
    for (const [name, val] of Object.entries(DIRS)) (global as any)[name] = val;
  });
  beforeEach(() => {
    savedGame = g.Game;
    savedMemory = g.Memory;
  });
  afterEach(() => {
    g.Game = savedGame;
    g.Memory = savedMemory;
  });

  /** Two-corridor world (NORTH default, SOUTH detour), engine-faithful callback. */
  function installWorld(marks: Record<string, number>): void {
    time += 1;
    const roomIntel: Record<string, any> = {};
    for (const room of Object.keys(marks)) {
      roomIntel[room] = { lastVisit: 1, hostileUntil: marks[room] };
    }
    const NORTH = ["W44N24", "W45N24"];
    const SOUTH = ["W43N23", "W44N23"];
    g.Memory = { roomIntel };
    g.Game = {
      time,
      rooms: {},
      map: {
        findRoute: (_from: string, to: string, opts?: any) => {
          const cost = (r: string): number => (opts?.routeCallback ? opts.routeCallback(r, "") : 1);
          const usable = (c: string[]): boolean => c.every(r => cost(r) !== Infinity);
          const corridor = usable(NORTH) ? NORTH : usable(SOUTH) ? SOUTH : null;
          if (!corridor) return -2;
          return [...corridor, to].map(room => ({ room, exit: 1 }));
        }
      }
    };
    (global as any).RoomPosition = function (this: any, x: number, y: number, roomName: string) {
      this.x = x;
      this.y = y;
      this.roomName = roomName;
      this.isEqualTo = (t: any) => t.x === x && t.y === y && (t.roomName === undefined || t.roomName === roomName);
    };
  }

  it("steers a cross-room leg to the safe corridor's next room instead of the naive path", () => {
    installWorld({ W44N24: time + 1400, W45N24: time + 1400 });
    const creep = creepAt(35, 27, "W43N24");
    travelTo(creep as any, pos(20, 16, "W45N23") as any);
    expect(creep.calls.moveTo, "pathfinder used").to.not.equal(undefined);
    expect(creep.calls.moveTo.roomName, "next hop is the SOUTH detour, not the stronghold").to.equal("W43N23");
  });

  it("keeps the original target when no marks exist (fast path, bit-identical)", () => {
    installWorld({});
    const creep = creepAt(35, 27, "W43N24");
    const target = pos(20, 16, "W45N23");
    travelTo(creep as any, target as any);
    expect(creep.calls.moveTo.roomName).to.equal("W45N23");
    expect(creep.calls.moveTo.x).to.equal(20);
  });

  it("falls back to the naive target when NO hostile-free corridor exists (funding gates own it)", () => {
    installWorld({ W44N24: time + 1400, W45N24: time + 1400, W44N23: time + 1400, W43N23: time + 1400 });
    const creep = creepAt(35, 27, "W43N24");
    travelTo(creep as any, pos(20, 16, "W45N23") as any);
    expect(creep.calls.moveTo.roomName, "no safe route - unchanged naive behavior").to.equal("W45N23");
  });

  it("does not steer the final leg (creep already in the target room)", () => {
    installWorld({ W44N24: time + 1400 });
    const creep = creepAt(10, 10, "W45N23");
    travelTo(creep as any, pos(20, 16, "W45N23") as any);
    expect(creep.calls.moveTo.roomName).to.equal("W45N23");
    expect(creep.calls.moveTo.x, "real target, not a room-center waypoint").to.equal(20);
  });
});
