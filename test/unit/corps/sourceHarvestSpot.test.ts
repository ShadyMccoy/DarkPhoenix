/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, FIND_STRUCTURES, FIND_SOURCES, FIND_MINERALS, STRUCTURE_CONTAINER } from "../mock";
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
  occupied?: { x: number; y: number }[];
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
  const occupiedStructures = (opts.occupied ?? []).map(o => ({ pos: { x: o.x, y: o.y, roomName } }));
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

  it("does not pick near-border tiles (1/48) the engine rejects for non-road structures", () => {
    // W43N23 2026-07-19 live: the source-link candidate (48,13) drew -7
    // (near-exit rule) every 10t cooldown forever, eating every rung below.
    // Same class as the source-tile loop above, different engine rule; the
    // generator stays conservative: core infra never belongs on 1/48 anyway.
    const room = roomWith({});
    const spawnPos = { x: 48, y: 13, roomName: "W0N0" } as any; // pulls the pick east
    const tile = bestAdjacentTile(room, { x: 47, y: 13 } as any, 1, spawnPos)!;
    expect(tile.x).to.be.at.most(47);
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
