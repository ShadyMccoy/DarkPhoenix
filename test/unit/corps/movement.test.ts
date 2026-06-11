/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { travelTo } from "../../../src/corps/movement";

// Screeps direction constants (globals in-game).
const DIRS: Record<string, number> = {
  TOP: 1, TOP_RIGHT: 2, RIGHT: 3, BOTTOM_RIGHT: 4, BOTTOM: 5, BOTTOM_LEFT: 6, LEFT: 7, TOP_LEFT: 8,
};

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
