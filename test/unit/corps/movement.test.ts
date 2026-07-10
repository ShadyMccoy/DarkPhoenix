/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { travelTo, travelToBypass } from "../../../src/corps/movement";

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

  it("swaps through a NON-yielding sibling: both step onto each other's tile", () => {
    const blocker = blockerAt({ memory: { workType: "haul" } }); // not a parked upgrader
    const creep = requesterWith(blocker);

    travelToBypass(creep as any, new MockPos(25, 8, ROOM) as any, { range: 0 } as any);

    // We advance toward the target (north)...
    expect(creep.calls.move, "requester steps into the blocker's tile").to.equal(DIRS.TOP);
    // ...and the blocker is commanded onto OUR tile (south) - the mutual swap.
    expect(blocker.bcalls.move, "blocker steps onto our tile").to.equal(DIRS.BOTTOM);
    // No fallback pathfinding was used.
    expect(creep.calls.moveTo).to.equal(undefined);
  });

  it("does NOT command a foreign blocker; falls back to creep-aware pathing", () => {
    const blocker = blockerAt({ my: false, memory: { workType: "haul" } });
    const creep = requesterWith(blocker);

    travelToBypass(creep as any, new MockPos(25, 8, ROOM) as any, { range: 0 } as any);

    expect(blocker.bcalls.move, "cannot move a creep we don't own").to.equal(undefined);
    expect(creep.calls.moveTo, "falls back to moveTo").to.not.equal(undefined);
  });

  it("does NOT force through a fatigued blocker (its tile would never clear)", () => {
    const blocker = blockerAt({ fatigue: 2, memory: { workType: "haul" } });
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
});
