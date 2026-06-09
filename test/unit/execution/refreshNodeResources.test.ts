import { expect } from "chai";
import "../../../src/types/Memory"; // load the Memory type augmentation
import { Game as MockGame } from "../mock";
import { Colony } from "../../../src/colony/Colony";
import { createNode } from "../../../src/nodes/Node";
import { refreshNodeResources } from "../../../src/execution/IncrementalAnalysis";
import { MultiRoomAnalysisResult } from "../../../src/spatial/RoomMap";

/**
 * Mining is room-agnostic: a node claims and mines a source by position, and it
 * never mattered which room that position is in - only that the source is known
 * (live vision or scouted intel) and inside the node's territory. The one thing
 * that broke this was timing: a node's resources were populated once, during the
 * initial terrain pass, before a neighbouring room had been scouted. This test
 * pins down the fix - refreshing a node's resources later picks up a source that
 * only appeared in intel after the node was built, so it gets mined like any
 * other.
 */

/** Minimal intel for a room with one source at (sx, sy), unowned (no controller). */
function intelWithSource(tick: number, sx: number, sy: number): unknown {
  return {
    lastVisit: tick,
    sourceCount: 1,
    sourcePositions: [{ x: sx, y: sy }],
    mineralType: null,
    mineralPos: null,
    controllerLevel: 0,
    controllerPos: null,
    controllerOwner: null,
    controllerReservation: null,
    hostileCreepCount: 0,
    hostileStructureCount: 0,
    isSafe: true,
  };
}

/** A result whose single node owns `positions` as its territory. */
function resultWith(nodeId: string, positions: { x: number; y: number; roomName: string }[]): MultiRoomAnalysisResult {
  return {
    peaks: [],
    territories: new Map([[nodeId, positions]]),
    distances: new Map(),
  };
}

describe("refreshNodeResources (room-agnostic source claiming)", () => {
  beforeEach(() => {
    // A bot that owns nothing in the remote room: a spawn (for the username
    // ownership probe) but no vision of and no controller in the remote room.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Game = { ...MockGame, creeps: {}, rooms: {}, spawns: { Spawn1: { owner: { username: "me" } } }, time: 100 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Memory = { creeps: {}, rooms: {}, roomIntel: {} };
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Game = { ...MockGame, creeps: {}, rooms: {}, spawns: {}, time: 100 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Memory = { creeps: {}, rooms: {} };
  });

  it("claims a source in an unowned, scouted room into the node spanning it", () => {
    const colony = new Colony();
    const node = createNode("n-remote", "W1N0", { x: 25, y: 25, roomName: "W1N0" }, 4, ["W1N0"], 100);
    colony.addNode(node);

    // The node's territory covers the source tile (25,25) in the remote room.
    const result = resultWith("n-remote", [
      { x: 25, y: 25, roomName: "W1N0" },
      { x: 24, y: 25, roomName: "W1N0" },
      { x: 26, y: 25, roomName: "W1N0" },
    ]);

    // The source was discovered by scouting (intel), not live vision.
    Memory.roomIntel!["W1N0"] = intelWithSource(100, 25, 25) as never;

    refreshNodeResources(colony, result);

    const sources = node.resources.filter((r) => r.type === "source");
    expect(sources, "remote source should be claimed from intel").to.have.length(1);
    expect(sources[0].position.roomName).to.equal("W1N0");
    // Unowned room: a source there regenerates only 1500 (not 3000) - the
    // economics the planner already prices in.
    expect(sources[0].capacity).to.equal(1500);
  });

  it("does not claim a source outside the node's territory", () => {
    const colony = new Colony();
    const node = createNode("n-remote", "W1N0", { x: 5, y: 5, roomName: "W1N0" }, 1, ["W1N0"], 100);
    colony.addNode(node);

    // Territory is a far corner; the source at (25,25) is not in it.
    const result = resultWith("n-remote", [{ x: 5, y: 5, roomName: "W1N0" }]);
    Memory.roomIntel!["W1N0"] = intelWithSource(100, 25, 25) as never;

    refreshNodeResources(colony, result);

    expect(node.resources.filter((r) => r.type === "source")).to.have.length(0);
  });

  it("claims nothing when the territory map is empty (the post-reset failure mode)", () => {
    // After a global reset only a territory-LESS visualization cache is restored,
    // so the refresh runs with empty territories and silently claims nothing -
    // which is why main forces a fresh terrain pass to rebuild them. This pins the
    // failure mode: empty territories => no claim, even though the source is in intel.
    const colony = new Colony();
    const node = createNode("n-remote", "W1N0", { x: 25, y: 25, roomName: "W1N0" }, 4, ["W1N0"], 100);
    colony.addNode(node);
    Memory.roomIntel!["W1N0"] = intelWithSource(100, 25, 25) as never;

    // Empty territories - the node id has no positions (the viz cache shape).
    refreshNodeResources(colony, { peaks: [], territories: new Map(), distances: new Map() } as MultiRoomAnalysisResult);

    expect(node.resources.filter((r) => r.type === "source")).to.have.length(0);
  });
});
