/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals } from "../mock";
import { stepOffRoad } from "../../../src/corps/movement";

/**
 * Standing workers prefer to stand OFF roads (owner 2026-07-22): an idle
 * creep parked on a road plugs the delivery lane for everyone moving through.
 * stepOffRoad fires only when the creep is idle ON a road and a legal
 * alternative exists: an adjacent tile still within `range` of the work
 * anchor, not a wall, not a road, structure-free (containers are somebody's
 * post - a harvest spot, the controller input, the depot), and unoccupied.
 * Plain terrain beats swamp; nothing legal means stay put (never give up the
 * work range just to clear a lane).
 */
describe("stepOffRoad (idle creeps clear the delivery lanes)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).STRUCTURE_ROAD = "road";
    (global as any).TERRAIN_MASK_WALL = 1;
    (global as any).TERRAIN_MASK_SWAMP = 2;
  });

  function world(opts: {
    creepAt: { x: number; y: number };
    roads?: Set<string>;
    walls?: Set<string>;
    swamps?: Set<string>;
    occupied?: Set<string>;
  }): { creep: any; movedTo: () => { x: number; y: number } | null } {
    let moved: { x: number; y: number } | null = null;
    const room = {
      name: "W0N0",
      getTerrain: () => ({
        get: (x: number, y: number) =>
          opts.walls?.has(`${x},${y}`) ? 1 : opts.swamps?.has(`${x},${y}`) ? 2 : 0
      }),
      lookForAt: (type: string, x: number, y: number) => {
        if (type === (global as any).LOOK_STRUCTURES)
          return opts.roads?.has(`${x},${y}`) ? [{ structureType: "road" }] : [];
        if (type === (global as any).LOOK_CREEPS) return opts.occupied?.has(`${x},${y}`) ? [{}] : [];
        return [];
      }
    };
    const creep = {
      pos: { x: opts.creepAt.x, y: opts.creepAt.y, roomName: "W0N0" },
      room,
      moveTo: (p: any) => {
        moved = { x: p.x, y: p.y };
        return 0;
      }
    };
    return { creep, movedTo: () => moved };
  }

  const anchor = (x: number, y: number): any => ({ x, y, roomName: "W0N0" });

  it("steps from a road onto an adjacent plain tile still in range of the anchor", () => {
    // Tanker staged on the road at (20,20) beside its builder at (20,19).
    const w = world({
      creepAt: { x: 20, y: 20 },
      roads: new Set(["20,20"]),
      occupied: new Set(["20,19"]) // the builder itself
    });
    expect(stepOffRoad(w.creep, anchor(20, 19), 1)).to.equal(true);
    const dest = w.movedTo()!;
    expect(dest, "moved somewhere").to.not.equal(null);
    expect(Math.max(Math.abs(dest.x - 20), Math.abs(dest.y - 19)), "still within range 1 of the builder").to.be.at.most(1);
    expect(`${dest.x},${dest.y}`).to.not.equal("20,20");
  });

  it("does nothing when not standing on a road (the common case costs nothing)", () => {
    const w = world({ creepAt: { x: 20, y: 20 } });
    expect(stepOffRoad(w.creep, anchor(20, 19), 1)).to.equal(false);
    expect(w.movedTo()).to.equal(null);
  });

  it("stays put when every legal tile is road, wall, or occupied - range beats lane-clearing", () => {
    const w = world({
      creepAt: { x: 20, y: 20 },
      roads: new Set(["20,20", "19,19", "21,19", "19,20", "21,20"]),
      occupied: new Set(["20,19"]),
      walls: new Set(["19,21", "20,21", "21,21"])
    });
    expect(stepOffRoad(w.creep, anchor(20, 20), 1)).to.equal(false);
    expect(w.movedTo()).to.equal(null);
  });

  it("never steps onto a container tile (that is somebody's post)", () => {
    const w = world({ creepAt: { x: 20, y: 20 }, roads: new Set(["20,20"]) });
    // Make every neighbor a container except one plain tile.
    (w.creep.room as any).lookForAt = (type: string, x: number, y: number) => {
      if (type !== (global as any).LOOK_STRUCTURES) return [];
      if (`${x},${y}` === "20,20") return [{ structureType: "road" }];
      if (`${x},${y}` === "21,21") return [];
      return [{ structureType: "container" }];
    };
    expect(stepOffRoad(w.creep, anchor(20, 20), 1)).to.equal(true);
    expect(w.movedTo()).to.deep.equal({ x: 21, y: 21 });
  });

  it("prefers plain over swamp (parking is free; swamp entry fatigue is not)", () => {
    const w = world({
      creepAt: { x: 20, y: 20 },
      roads: new Set(["20,20"]),
      swamps: new Set(["20,19", "21,19", "19,19", "19,20", "19,21", "20,21", "21,21"]) // all but (21,20)
    });
    expect(stepOffRoad(w.creep, anchor(20, 20), 1)).to.equal(true);
    expect(w.movedTo()).to.deep.equal({ x: 21, y: 20 });
  });
});
