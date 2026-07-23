/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import {
  setupGlobals,
  FIND_STRUCTURES,
  FIND_SOURCES,
  FIND_MINERALS,
  STRUCTURE_CONTAINER,
  STRUCTURE_LINK,
} from "../mock";
import { sourceHarvestSpot, bestAdjacentTile } from "../../../src/corps/nodeEnergy";

const FIND_MY_CONSTRUCTION_SITES = 114;
const FIND_CONSTRUCTION_SITES = 111;

/**
 * sourceHarvestSpot is the ONE tile a source's miner stands on, the container is
 * built on, and the haulers collect from - the convergence that stops a miner
 * dropping energy on a tile the haulers never visit (the un-hauled pile bug).
 */
function sourceWith(opts: {
  sx: number; sy: number;
  roomName?: string;
  containers?: { x: number; y: number }[];
  sites?: { x: number; y: number }[];
  walls?: Set<string>;
  occupied?: { x: number; y: number; structureType?: string }[];
}): any {
  const roomName = opts.roomName ?? "W0N0";
  const containers = (opts.containers ?? []).map(c => ({
    structureType: STRUCTURE_CONTAINER,
    pos: { x: c.x, y: c.y, roomName },
  }));
  const sites = (opts.sites ?? []).map(c => ({
    structureType: STRUCTURE_CONTAINER,
    pos: { x: c.x, y: c.y, roomName },
  }));
  const occupiedStructures = (opts.occupied ?? []).map(o => ({ structureType: o.structureType, pos: { x: o.x, y: o.y, roomName } }));
  const within1 = (px: number, py: number, arr: any[]) =>
    arr.filter(s => Math.max(Math.abs(s.pos.x - px), Math.abs(s.pos.y - py)) <= 1);

  const room = {
    name: roomName,
    getTerrain: () => ({ get: (x: number, y: number) => (opts.walls?.has(`${x},${y}`) ? 1 : 0) }),
    find: (type: number) => {
      if (type === FIND_STRUCTURES) return [...containers, ...occupiedStructures];
      if (type === FIND_CONSTRUCTION_SITES) return sites;
      return [];
    },
  };
  return {
    pos: {
      x: opts.sx, y: opts.sy, roomName,
      findInRange: (type: number, _range: number, o: any) => {
        const list = type === FIND_STRUCTURES ? containers : type === FIND_MY_CONSTRUCTION_SITES ? sites : [];
        const filtered = o?.filter ? list.filter(o.filter) : list;
        return within1(opts.sx, opts.sy, filtered);
      },
    },
    room,
  };
}

describe("sourceHarvestSpot (miner / container / pickup converge on one tile)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).FIND_MY_CONSTRUCTION_SITES = FIND_MY_CONSTRUCTION_SITES;
    (global as any).FIND_CONSTRUCTION_SITES = FIND_CONSTRUCTION_SITES;
  });

  it("with no container, returns the adjacent tile nearest the spawn (deterministic)", () => {
    // Source at (10,10); spawn to the SE at (40,40) - the nearest adjacent tile is
    // the bottom-right (11,11).
    const source = sourceWith({ sx: 10, sy: 10 });
    const spot = sourceHarvestSpot(source, { x: 40, y: 40, roomName: "W0N0" } as any);
    expect({ x: spot.x, y: spot.y }).to.deep.equal({ x: 11, y: 11 });
  });

  it("matches bestAdjacentTile - the SAME tile construction places the container on", () => {
    const source = sourceWith({ sx: 10, sy: 10 });
    const spawnPos = { x: 40, y: 40, roomName: "W0N0" } as any;
    const minerSpot = sourceHarvestSpot(source, spawnPos);
    const containerTile = bestAdjacentTile(source.room, source.pos, 1, spawnPos)!;
    expect({ x: minerSpot.x, y: minerSpot.y }).to.deep.equal({ x: containerTile.x, y: containerTile.y });
  });

  it("stands ON a built source container when one is adjacent", () => {
    const source = sourceWith({ sx: 10, sy: 10, containers: [{ x: 9, y: 10 }] });
    const spot = sourceHarvestSpot(source, { x: 40, y: 40, roomName: "W0N0" } as any);
    expect({ x: spot.x, y: spot.y }).to.deep.equal({ x: 9, y: 10 });
  });

  it("pre-positions on the container CONSTRUCTION SITE before it is built", () => {
    // The site is placed at the harvest tile; the miner stands there now so it is
    // already on the container the moment it finishes - no relocation, no stray pile.
    const source = sourceWith({ sx: 10, sy: 10, sites: [{ x: 11, y: 9 }] });
    const spot = sourceHarvestSpot(source, { x: 40, y: 40, roomName: "W0N0" } as any);
    expect({ x: spot.x, y: spot.y }).to.deep.equal({ x: 11, y: 9 });
  });

  it("USES a paved harvest tile - a container is legal on a road (prod W44N23)", () => {
    // The trunk paved the only open source neighbour. A road never blocks a
    // container (engine checkConstructionSite exempts roads) and creeps walk on
    // roads, so the harvest/container tile must be that road tile - NOT skipped
    // as "occupied", which left the container looping -7 on the source tile.
    const source = sourceWith({
      sx: 10, sy: 10,
      walls: new Set(["9,9", "10,9", "11,9", "9,10", "11,10", "9,11", "10,11"]), // all but (11,11)
      occupied: [{ x: 11, y: 11, structureType: (global as any).STRUCTURE_ROAD }] as any
    });
    const spot = sourceHarvestSpot(source, { x: 40, y: 40, roomName: "W0N0" } as any);
    expect({ x: spot.x, y: spot.y }, "the paved neighbour is used, not the source tile").to.deep.equal({ x: 11, y: 11 });
  });

  it("skips walls and occupied tiles when choosing the harvest tile", () => {
    // Block the natural nearest tile (11,11) and an alternative, so it must pick the
    // next-nearest walkable, unoccupied adjacent tile.
    const source = sourceWith({
      sx: 10, sy: 10,
      walls: new Set(["11,11"]),
      occupied: [{ x: 11, y: 10 }],
    });
    const spot = sourceHarvestSpot(source, { x: 40, y: 40, roomName: "W0N0" } as any);
    // (11,11) walled, (11,10) occupied -> next nearest to the SE spawn is (10,11).
    expect({ x: spot.x, y: spot.y }).to.deep.equal({ x: 10, y: 11 });
  });
});

/**
 * A BUILT road never blocks a container (engine checkConstructionSite exempts
 * existing roads for every type) and creeps walk on roads, so bestAdjacentTile
 * must place containers / pick stand tiles ON roads. Only OBSTACLE structures
 * (links/towers/storage) shun roads - an unwalkable building plugs the lane.
 */
describe("bestAdjacentTile (roads are walkable - containers may sit on them, obstacles may not)", () => {
  beforeEach(() => setupGlobals());

  function roomWithRoad(roadAt: { x: number; y: number }): any {
    const roads = [{ structureType: STRUCTURE_ROAD, pos: { x: roadAt.x, y: roadAt.y, roomName: "W0N0" } }];
    return {
      name: "W0N0",
      getTerrain: () => ({ get: () => 0 }),
      find: (type: number) => (type === FIND_STRUCTURES ? roads : [])
    };
  }

  it("places a CONTAINER on a road tile (the paved harvest tile converges with the miner)", () => {
    const room = roomWithRoad({ x: 11, y: 11 }); // the SE-nearest neighbour toward the spawn
    const spawnPos = { x: 40, y: 40, roomName: "W0N0" } as any;
    const tile = bestAdjacentTile(room, { x: 10, y: 10 } as any, 1, spawnPos, undefined, STRUCTURE_CONTAINER)!;
    expect({ x: tile.x, y: tile.y }).to.deep.equal({ x: 11, y: 11 });
  });

  it("a bare STAND tile (no structure type) may also sit on a road", () => {
    const room = roomWithRoad({ x: 11, y: 11 });
    const spawnPos = { x: 40, y: 40, roomName: "W0N0" } as any;
    const tile = bestAdjacentTile(room, { x: 10, y: 10 } as any, 1, spawnPos)!;
    expect({ x: tile.x, y: tile.y }).to.deep.equal({ x: 11, y: 11 });
  });

  it("an OBSTACLE structure (link) shuns the road tile and takes the next-best", () => {
    const room = roomWithRoad({ x: 11, y: 11 });
    const spawnPos = { x: 40, y: 40, roomName: "W0N0" } as any;
    const tile = bestAdjacentTile(room, { x: 10, y: 10 } as any, 1, spawnPos, undefined, STRUCTURE_LINK)!;
    expect({ x: tile.x, y: tile.y }, "a link on the road would block the lane").to.not.deep.equal({ x: 11, y: 11 });
  });
});

/**
 * bestAdjacentTile must never return a source or mineral tile: no buildable
 * structure fits there (createConstructionSite -> ERR_INVALID_TARGET). This bit
 * source-link placement, which asks for a tile ADJACENT to the harvest spot -
 * range that includes the source's own tile - and looped on -7 forever because
 * the source never moves. (Sources/minerals aren't FIND_STRUCTURES, so the
 * structure/site scans miss them.)
 */
describe("bestAdjacentTile (excludes source and mineral tiles)", () => {
  beforeEach(() => setupGlobals());

  function roomWith(opts: { sources?: { x: number; y: number }[]; minerals?: { x: number; y: number }[] }): any {
    const sources = (opts.sources ?? []).map(s => ({ pos: { x: s.x, y: s.y, roomName: "W0N0" } }));
    const minerals = (opts.minerals ?? []).map(m => ({ pos: { x: m.x, y: m.y, roomName: "W0N0" } }));
    return {
      name: "W0N0",
      getTerrain: () => ({ get: () => 0 }),
      find: (type: number) => {
        if (type === FIND_SOURCES) return sources;
        if (type === FIND_MINERALS) return minerals;
        return []; // no structures or sites
      },
    };
  }

  it("does not pick the source tile even when it is the nearest-spawn candidate", () => {
    // Source at (10,10); ask for a tile adjacent to the harvest spot (11,10). The
    // source tile (10,10) is in range and nearest the western spawn - it must be
    // rejected in favour of another walkable neighbour.
    const room = roomWith({ sources: [{ x: 10, y: 10 }] });
    const spawnPos = { x: 1, y: 10, roomName: "W0N0" } as any;
    const tile = bestAdjacentTile(room, { x: 11, y: 10 } as any, 1, spawnPos)!;
    expect({ x: tile.x, y: tile.y }).to.not.deep.equal({ x: 10, y: 10 });
  });

  it("does not pick a mineral tile", () => {
    const room = roomWith({ minerals: [{ x: 10, y: 10 }] });
    const spawnPos = { x: 1, y: 10, roomName: "W0N0" } as any;
    const tile = bestAdjacentTile(room, { x: 11, y: 10 } as any, 1, spawnPos)!;
    expect({ x: tile.x, y: tile.y }).to.not.deep.equal({ x: 10, y: 10 });
  });

  it("keeps clear of caller-marked positions (unwalkable structures beside a spawn lock in units)", () => {
    // Owner 2026-07-19: a tower/storage/link on a spawn-adjacent tile can trap
    // freshly spawned creeps. Generators for unwalkable structures pass the
    // room's spawn positions; tiles within range 1 of any are never proposed.
    const room = roomWith({});
    const spawnPos = { x: 10, y: 10, roomName: "W0N0" } as any;
    const tile = bestAdjacentTile(room, spawnPos, 2, spawnPos, [spawnPos])!;
    expect(
      Math.max(Math.abs(tile.x - 10), Math.abs(tile.y - 10)),
      "no tile within range 1 of the avoided spawn"
    ).to.be.greaterThan(1);
  });

  it("does not pick a tile placement already proved dead (-7 blacklist in room memory)", () => {
    // placeSite records permanently-invalid tiles (ERR_INVALID_TARGET) in
    // room.memory.deadTiles; the generator must stop proposing them or the
    // ladder retries the same tile forever.
    const room = roomWith({});
    (room as any).memory = { deadTiles: { "12,10": 1 } };
    const spawnPos = { x: 13, y: 10, roomName: "W0N0" } as any; // (12,10) is nearest otherwise
    const tile = bestAdjacentTile(room, { x: 11, y: 10 } as any, 1, spawnPos)!;
    expect({ x: tile.x, y: tile.y }).to.not.deep.equal({ x: 12, y: 10 });
  });
});

/**
 * Engine rule (checkConstructionSite): a tile one step from the room edge
 * (x or y == 1 or 48) can host most structures ONLY when all three edge tiles
 * beside it are natural walls - an open exit tile there makes placement fail
 * with ERR_INVALID_TARGET. Roads and containers are exempt. A picker that
 * ignores this re-picks the SAME illegal tile every cooldown, so the structure
 * never places (the W43N23 incident: a source pocketed against an open east
 * exit, "[Construction] Failed to place link at W43N23 (48, 13): -7" forever).
 */
describe("bestAdjacentTile (exit-restricted structures shun the open-exit buffer)", () => {
  beforeEach(() => setupGlobals());

  /** Bare room: chosen walls, everything else plain - edge cols/rows open (exits). */
  function roomWithWalls(walls: string[]): any {
    const wallSet = new Set(walls);
    return {
      name: "W0N0",
      getTerrain: () => ({ get: (x: number, y: number) => (wallSet.has(`${x},${y}`) ? 1 : 0) }),
      find: () => [],
    };
  }

  // The W43N23 pocket: spot at (47,13), every neighbour walled except the
  // x=48 column, open exit tiles behind it at x=49.
  const POCKET = ["46,12", "46,13", "46,14", "47,12", "47,14"];

  it("returns null for a LINK when the only candidates sit beside an open exit (W43N23 repro)", () => {
    const room = roomWithWalls(POCKET);
    const spawnPos = { x: 25, y: 25, roomName: "W0N0" } as any;
    const tile = bestAdjacentTile(room, { x: 47, y: 13 } as any, 1, spawnPos, undefined, STRUCTURE_LINK);
    expect(tile).to.equal(null);
  });

  it("still allows x=48 for a LINK when the edge tiles behind it are natural walls", () => {
    // Same pocket, but the east edge is walled - no exit, so the engine allows it.
    const room = roomWithWalls([...POCKET, "49,11", "49,12", "49,13", "49,14", "49,15"]);
    const spawnPos = { x: 25, y: 25, roomName: "W0N0" } as any;
    const tile = bestAdjacentTile(room, { x: 47, y: 13 } as any, 1, spawnPos, undefined, STRUCTURE_LINK)!;
    expect({ x: tile.x, y: tile.y }).to.deep.equal({ x: 48, y: 12 });
  });

  it("skips the nearer buffer tile and picks the next-best LEGAL tile", () => {
    // (47,12) open as an alternative; spawn placed so the buffer tile (48,14)
    // is strictly nearest - the old picker chose it and looped on -7.
    const room = roomWithWalls(["46,12", "46,13", "46,14", "47,14"]);
    const spawnPos = { x: 48, y: 40, roomName: "W0N0" } as any;
    const tile = bestAdjacentTile(room, { x: 47, y: 13 } as any, 1, spawnPos, undefined, STRUCTURE_LINK)!;
    expect({ x: tile.x, y: tile.y }).to.deep.equal({ x: 47, y: 12 });
  });

  it("containers are exempt - the engine allows them beside exits", () => {
    const room = roomWithWalls(POCKET);
    const spawnPos = { x: 25, y: 25, roomName: "W0N0" } as any;
    const tile = bestAdjacentTile(room, { x: 47, y: 13 } as any, 1, spawnPos, undefined, STRUCTURE_CONTAINER)!;
    expect({ x: tile.x, y: tile.y }).to.deep.equal({ x: 48, y: 12 });
  });

  it("stand-tile queries (no structure type) are unchanged - creeps may stand in the buffer", () => {
    const room = roomWithWalls(POCKET);
    const spawnPos = { x: 25, y: 25, roomName: "W0N0" } as any;
    const tile = bestAdjacentTile(room, { x: 47, y: 13 } as any, 1, spawnPos)!;
    expect({ x: tile.x, y: tile.y }).to.deep.equal({ x: 48, y: 12 });
  });

  it("applies the same rule on the y side (bottom edge)", () => {
    const room = roomWithWalls(["12,46", "13,46", "14,46", "12,47", "14,47"]);
    const spawnPos = { x: 25, y: 25, roomName: "W0N0" } as any;
    const tile = bestAdjacentTile(room, { x: 13, y: 47 } as any, 1, spawnPos, undefined, STRUCTURE_LINK);
    expect(tile).to.equal(null);
  });
});

/**
 * Swamp-favored building placement (owner 2026-07-21: "build buildings
 * slightly more favorably on swamps. leave the plains available for walking
 * on ... build the buildings on a swamp adjacent to a plain ... 'waste' a
 * non-walkable tile on a swamp"). An unwalkable building blots out its tile
 * either way, so at EQUAL distance it takes the swamp and leaves the plain
 * as a walking lane; among swamps one with an adjacent plain wins (the
 * servicing creep parks on the plain - standing creeps pay no fatigue, only
 * the approach does). Distance still rules: the preference is a tie-break,
 * never a longer walk for every future servicing trip. Roads and containers
 * are walkable, so they stay terrain-neutral - a container on swamp would
 * tax every visitor 5x fatigue.
 */
describe("bestAdjacentTile (unwalkable buildings blot swamps, not plains)", () => {
  beforeEach(() => setupGlobals());

  /** Bare room with chosen swamp tiles (2), optional walls (1), else plain. */
  function roomWithSwamps(swamps: string[], walls: string[] = []): any {
    const swampSet = new Set(swamps);
    const wallSet = new Set(walls);
    return {
      name: "W0N0",
      getTerrain: () => ({
        get: (x: number, y: number) => (wallSet.has(`${x},${y}`) ? 1 : swampSet.has(`${x},${y}`) ? 2 : 0)
      }),
      find: () => []
    };
  }

  // Target at (10,10), spawn due east at (40,10): ring tiles (11,9), (11,10),
  // (11,11) all tie at chebyshev 29 - the tie the preference resolves.
  const target = { x: 10, y: 10, roomName: "W0N0" } as any;
  const spawnPos = { x: 40, y: 10, roomName: "W0N0" } as any;

  it("an UNWALKABLE building takes the swamp at equal distance (plain stays a lane)", () => {
    const room = roomWithSwamps(["11,10"]);
    const tile = bestAdjacentTile(room, target, 1, spawnPos, undefined, STRUCTURE_LINK)!;
    expect({ x: tile.x, y: tile.y }).to.deep.equal({ x: 11, y: 10 });
  });

  it("never pays extra walking distance for a swamp (nearest-to-spawn still rules)", () => {
    // The only swamp is a ring tile FARTHER from the spawn - the building
    // stays on the nearest plain; every servicing trip would pay the extra
    // tiles forever.
    const room = roomWithSwamps(["9,10"]);
    const tile = bestAdjacentTile(room, target, 1, spawnPos, undefined, STRUCTURE_LINK)!;
    expect({ x: tile.x, y: tile.y }).to.deep.equal({ x: 11, y: 9 });
  });

  it("among tied swamps, prefers one ADJACENT TO A PLAIN (the servicing stand)", () => {
    // (11,9) and (11,10) both swamp at d=29, but every neighbour of (11,9)
    // is swamp/wall while (11,10) has plains below it - the serviceable
    // swamp wins even though (11,9) is seen first.
    const room = roomWithSwamps(
      ["11,9", "11,10", "10,8", "11,8", "12,8", "10,9", "12,9", "12,10"],
      ["10,10"] // the target tile itself (sources sit on walls)
    );
    const tile = bestAdjacentTile(room, target, 1, spawnPos, undefined, STRUCTURE_LINK)!;
    expect({ x: tile.x, y: tile.y }).to.deep.equal({ x: 11, y: 10 });
  });

  it("containers stay terrain-neutral (walkable - swamp would tax every visitor)", () => {
    const room = roomWithSwamps(["11,10"]);
    const tile = bestAdjacentTile(room, target, 1, spawnPos, undefined, STRUCTURE_CONTAINER)!;
    expect({ x: tile.x, y: tile.y }).to.deep.equal({ x: 11, y: 9 });
  });

  it("stand-tile queries (no structure type) are unchanged", () => {
    const room = roomWithSwamps(["11,10"]);
    const tile = bestAdjacentTile(room, target, 1, spawnPos)!;
    expect({ x: tile.x, y: tile.y }).to.deep.equal({ x: 11, y: 9 });
  });
});
