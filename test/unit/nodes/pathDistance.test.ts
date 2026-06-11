import { expect } from "chai";
import {
  pathDistance,
  clearPathDistanceCache,
  estimateWalkingDistance
} from "../../../src/nodes/NodeNavigator";
import { Position } from "../../../src/types/Position";

const at = (x: number, y: number, roomName = "W0N0"): Position => ({ x, y, roomName });

// pathDistance() is the seam that feeds real walls/swamps into the remote-mining
// profitability gate. These tests pin its contract against a stub PathFinder:
// trust a completed path's step count, otherwise fall back to the analytic
// estimate, and only ever search a given endpoint pair once.
describe("pathDistance", () => {
  const g = globalThis as unknown as { PathFinder?: unknown; RoomPosition?: unknown };
  let savedPF: unknown;
  let savedRP: unknown;

  beforeEach(() => {
    savedPF = g.PathFinder;
    savedRP = g.RoomPosition;
    clearPathDistanceCache();
    // Minimal RoomPosition so pathDistance can build origin/goal.
    g.RoomPosition = function (this: Position, x: number, y: number, roomName: string) {
      this.x = x;
      this.y = y;
      this.roomName = roomName;
    };
  });

  afterEach(() => {
    g.PathFinder = savedPF;
    g.RoomPosition = savedRP;
    clearPathDistanceCache();
  });

  it("uses the real PathFinder step count when a path completes", () => {
    // A walled detour: the real path is far longer than the crow-flies estimate.
    const detour = new Array(40).fill({});
    g.PathFinder = { search: () => ({ path: detour, ops: 100, cost: 80, incomplete: false }) };

    const from = at(5, 5);
    const to = at(8, 5);
    expect(estimateWalkingDistance(from, to)).to.equal(3); // crow-flies says "cheap"
    expect(pathDistance(from, to)).to.equal(40); // real detour says "expensive"
  });

  it("falls back to the analytic estimate when the path is incomplete", () => {
    g.PathFinder = { search: () => ({ path: [], ops: 4000, cost: 0, incomplete: true }) };
    const from = at(5, 5);
    const to = at(8, 5);
    expect(pathDistance(from, to)).to.equal(estimateWalkingDistance(from, to));
  });

  it("falls back when PathFinder returns an empty path (e.g. the unit-test mock)", () => {
    g.PathFinder = { search: () => ({ path: [], ops: 0, cost: 0, incomplete: false }) };
    const from = at(5, 5);
    const to = at(12, 5);
    expect(pathDistance(from, to)).to.equal(estimateWalkingDistance(from, to));
  });

  it("falls back when PathFinder is unavailable", () => {
    g.PathFinder = undefined;
    const from = at(5, 5);
    const to = at(20, 5);
    expect(pathDistance(from, to)).to.equal(estimateWalkingDistance(from, to));
  });

  it("caches by endpoint so PathFinder is searched only once per pair", () => {
    let calls = 0;
    g.PathFinder = {
      search: () => {
        calls++;
        return { path: new Array(10).fill({}), ops: 1, cost: 1, incomplete: false };
      }
    };
    const from = at(1, 1);
    const to = at(9, 9);
    pathDistance(from, to);
    pathDistance(from, to);
    pathDistance(from, to);
    expect(calls).to.equal(1);
  });
});
