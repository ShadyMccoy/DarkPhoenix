import { expect } from "chai";
import "../../../src/types/Memory"; // load the Memory type augmentation
import { Game as MockGame, FIND_SOURCES } from "../mock";
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
    // The live-vision branch calls room.find with the bare FIND_* globals; make
    // them resolve so the mock room's find matches FIND_SOURCES (105).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).FIND_SOURCES = FIND_SOURCES;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).FIND_MINERALS = 106;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).FIND_MY_SPAWNS = 112;
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
    // No controller in this intel (controllerPos null), so it can't be reserved -
    // the source regenerates only the unreserved 1500.
    expect(sources[0].capacity).to.equal(1500);
  });

  it("values a reservable scouted room's source as RESERVED (3000) once a reserver is affordable", () => {
    // Home is RCL3 (800 >= the 650 reserver body) and the remote room has a
    // controller we could reserve (unowned, unreserved), so the planner values its
    // source at the reserved 3000 - the rate it becomes once the ReservationCorp
    // holds it. Without this the remote looks like 5 e/tick and may never be opened.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Game.spawns = { Spawn1: { owner: { username: "me" }, room: { energyCapacityAvailable: 800 } } };
    const colony = new Colony();
    const node = createNode("n-remote", "W1N0", { x: 25, y: 25, roomName: "W1N0" }, 4, ["W1N0"], 100);
    colony.addNode(node);
    const result = resultWith("n-remote", [
      { x: 25, y: 25, roomName: "W1N0" }, { x: 24, y: 25, roomName: "W1N0" }, { x: 26, y: 25, roomName: "W1N0" }
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const intel = intelWithSource(100, 25, 25) as any;
    intel.controllerPos = { x: 10, y: 10 }; // a controller we could reserve
    Memory.roomIntel!["W1N0"] = intel as never;

    refreshNodeResources(colony, result);
    expect(node.resources.filter((r) => r.type === "source")[0].capacity).to.equal(3000);
  });

  it("stays unreserved (1500) when a reserver is unaffordable (below RCL3)", () => {
    // Same reservable room, but home is RCL1 (300 < 650) - it cannot build a
    // reserver, so the source is valued at the unreserved 1500. No RCL gate: the
    // affordability floor produces the cutoff.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Game.spawns = { Spawn1: { owner: { username: "me" }, room: { energyCapacityAvailable: 300 } } };
    const colony = new Colony();
    const node = createNode("n-remote", "W1N0", { x: 25, y: 25, roomName: "W1N0" }, 4, ["W1N0"], 100);
    colony.addNode(node);
    const result = resultWith("n-remote", [
      { x: 25, y: 25, roomName: "W1N0" }, { x: 24, y: 25, roomName: "W1N0" }, { x: 26, y: 25, roomName: "W1N0" }
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const intel = intelWithSource(100, 25, 25) as any;
    intel.controllerPos = { x: 10, y: 10 };
    Memory.roomIntel!["W1N0"] = intel as never;

    refreshNodeResources(colony, result);
    expect(node.resources.filter((r) => r.type === "source")[0].capacity).to.equal(1500);
  });

  it("keeps a visible reservable remote's source at the reserved 3000 (no collapse on vision)", () => {
    // The valuation must not discontinue across the visibility boundary. Once a
    // miner reaches a remote we get LIVE vision of it, and a live source reads its
    // raw energyCapacity (1500 while unreserved) - so without the same couldReserve
    // lift the live branch applies, the remote's worth would collapse 3000 -> 1500
    // the instant we commit to it, making the planner thrash on a remote that is
    // only worthwhile reserved. Home is RCL3 (800 >= 650), the live controller is
    // unowned/unreserved, so the visible source stays valued at 3000.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Game.spawns = { Spawn1: { owner: { username: "me" }, room: { energyCapacityAvailable: 800 } } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Game.rooms = {
      W1N0: {
        name: "W1N0",
        controller: { pos: { x: 10, y: 10 }, owner: undefined, reservation: undefined },
        find: (type: number) =>
          type === FIND_SOURCES
            ? [{ id: "live-src", pos: { x: 25, y: 25 }, energyCapacity: 1500 }]
            : []
      }
    };
    const colony = new Colony();
    const node = createNode("n-remote", "W1N0", { x: 25, y: 25, roomName: "W1N0" }, 4, ["W1N0"], 100);
    colony.addNode(node);
    const result = resultWith("n-remote", [
      { x: 25, y: 25, roomName: "W1N0" }, { x: 24, y: 25, roomName: "W1N0" }, { x: 26, y: 25, roomName: "W1N0" }
    ]);

    refreshNodeResources(colony, result);
    expect(node.resources.filter((r) => r.type === "source")[0].capacity).to.equal(3000);
  });

  it("does not lift a visible remote already reserved by someone else (stays 1500)", () => {
    // A live remote whose controller is reserved by a RIVAL cannot be lifted - we
    // can't reserve it, so its source is worth only the raw unreserved 1500.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Game.spawns = { Spawn1: { owner: { username: "me" }, room: { energyCapacityAvailable: 800 } } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Game.rooms = {
      W1N0: {
        name: "W1N0",
        controller: { pos: { x: 10, y: 10 }, owner: undefined, reservation: { username: "rival" } },
        find: (type: number) =>
          type === FIND_SOURCES
            ? [{ id: "live-src", pos: { x: 25, y: 25 }, energyCapacity: 1500 }]
            : []
      }
    };
    const colony = new Colony();
    const node = createNode("n-remote", "W1N0", { x: 25, y: 25, roomName: "W1N0" }, 4, ["W1N0"], 100);
    colony.addNode(node);
    const result = resultWith("n-remote", [
      { x: 25, y: 25, roomName: "W1N0" }, { x: 24, y: 25, roomName: "W1N0" }, { x: 26, y: 25, roomName: "W1N0" }
    ]);

    refreshNodeResources(colony, result);
    expect(node.resources.filter((r) => r.type === "source")[0].capacity).to.equal(1500);
  });

  it("registers an intel source under its REAL game id when intel recorded one", () => {
    // Source identity must be STABLE across vision loss. The intel fallback used
    // to mint a positional id (`intel-ROOM-X-Y`), so a mined remote that lost
    // vision (e.g. an invader wiped its creeps and the defunding gate kept
    // replacements home) re-registered as a DIFFERENT flow source. The commission
    // corpId follows the source id, so the re-solve materialized a second harvest
    // corp for the same physical source - and each corp spawned its own miner
    // (the duplicate-miner-after-an-invader incident). With the real id recorded
    // in intel, the id - and the corp - survives the vision flip.
    const colony = new Colony();
    const node = createNode("n-remote", "W1N0", { x: 25, y: 25, roomName: "W1N0" }, 4, ["W1N0"], 100);
    colony.addNode(node);
    const result = resultWith("n-remote", [
      { x: 25, y: 25, roomName: "W1N0" },
      { x: 24, y: 25, roomName: "W1N0" },
      { x: 26, y: 25, roomName: "W1N0" },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const intel = intelWithSource(100, 25, 25) as any;
    intel.sourceIds = ["5bbcadc99099fc012e6342cc"]; // captured while the room was visible
    Memory.roomIntel!["W1N0"] = intel as never;

    refreshNodeResources(colony, result);

    const sources = node.resources.filter((r) => r.type === "source");
    expect(sources).to.have.length(1);
    expect(sources[0].id, "intel source keeps its real game id").to.equal("5bbcadc99099fc012e6342cc");
  });

  it("falls back to the positional intel id only when no real id was recorded (legacy intel)", () => {
    const colony = new Colony();
    const node = createNode("n-remote", "W1N0", { x: 25, y: 25, roomName: "W1N0" }, 4, ["W1N0"], 100);
    colony.addNode(node);
    const result = resultWith("n-remote", [
      { x: 25, y: 25, roomName: "W1N0" },
      { x: 24, y: 25, roomName: "W1N0" },
      { x: 26, y: 25, roomName: "W1N0" },
    ]);

    // Pre-sourceIds intel entry (old Memory): no ids recorded.
    Memory.roomIntel!["W1N0"] = intelWithSource(100, 25, 25) as never;

    refreshNodeResources(colony, result);

    const sources = node.resources.filter((r) => r.type === "source");
    expect(sources).to.have.length(1);
    expect(sources[0].id).to.equal("intel-W1N0-25-25");
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
