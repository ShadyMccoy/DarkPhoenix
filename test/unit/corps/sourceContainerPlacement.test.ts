/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { ConstructionCorp } from "../../../src/corps/ConstructionCorp";
import { resetGovernor } from "../../../src/execution/CpuGovernor";

/**
 * SOURCE CONTAINER ON THE SOURCE TILE (prod W44N23, "[Construction] Failed to
 * place container at W44N23 (33, 29): -7" looping forever). The harvest tile got
 * paved over (the trunk road ran through it), so every walkable neighbour of the
 * source was occupied and bestAdjacentTile returned null. sourceHarvestSpot then
 * fell back to the source's OWN tile, and findMissingSourceContainer proposed a
 * container there - a source tile can never host one, so createConstructionSite
 * returned ERR_INVALID_TARGET every cooldown. The fallback bypasses the deadTiles
 * blacklist entirely: bestAdjacentTile already excludes the source tile, so
 * recording it does nothing, and the generator re-proposes it forever. The fix:
 * when the only spot is the source tile, there is nowhere to put the container -
 * skip the source instead of looping.
 */
describe("findMissingSourceContainer (never proposes the source's own tile)", () => {
  const FIND_SOURCES = 105;
  const FIND_MINERALS = 116;
  const FIND_STRUCTURES = 107;
  const FIND_CONSTRUCTION_SITES = 111;
  const FIND_MY_CONSTRUCTION_SITES = 114;
  const FIND_DROPPED_RESOURCES = 106;

  beforeEach(() => {
    setupGlobals();
    resetGovernor();
    Game.time = 100;
    const g = global as any;
    g.OK = 0;
    g.ERR_INVALID_TARGET = -7;
    g.LOOK_STRUCTURES = "structure";
    g.STRUCTURE_ROAD = "road";
    g.FIND_SOURCES = FIND_SOURCES;
    g.FIND_MINERALS = FIND_MINERALS;
    g.FIND_STRUCTURES = FIND_STRUCTURES;
    g.FIND_CONSTRUCTION_SITES = FIND_CONSTRUCTION_SITES;
    g.FIND_MY_CONSTRUCTION_SITES = FIND_MY_CONSTRUCTION_SITES;
    g.FIND_DROPPED_RESOURCES = FIND_DROPPED_RESOURCES;
    g.STRUCTURE_CONTAINER = "container";
    g.RESOURCE_ENERGY = "energy";
    g.TERRAIN_MASK_WALL = 1;
    g.RoomPosition = function (this: any, x: number, y: number, roomName: string) {
      this.x = x;
      this.y = y;
      this.roomName = roomName;
    };
    Game.creeps = {};
    Game.getObjectById = () => ({ pos: { x: 40, y: 40, roomName: "W44N23" } }) as never; // the spawn
    (Memory as any).creeps = {};
  });

  /** A room with one source at (sx,sy) holding a big drop pile and no containers.
   *  `walls` marks tiles the terrain reports as natural wall. */
  const roomWith = (sx: number, sy: number, walls: Set<string>): any => {
    const source: any = {
      pos: {
        x: sx,
        y: sy,
        roomName: "W44N23",
        findInRange: (type: number, _range: number, o?: any) => {
          if (type === FIND_DROPPED_RESOURCES) {
            const list = [{ resourceType: "energy", amount: 500, pos: { x: sx, y: sy } }];
            return o?.filter ? list.filter(o.filter) : list;
          }
          return []; // no adjacent container / site
        }
      }
    };
    const room: any = {
      name: "W44N23",
      storage: undefined, // coreLink -> null, so no link-fed skip
      memory: {},
      getTerrain: () => ({ get: (x: number, y: number) => (walls.has(`${x},${y}`) ? 1 : 0) }),
      find: (type: number) => (type === FIND_SOURCES ? [source] : []) // no structures/sites/minerals
    };
    source.room = room;
    return room;
  };

  const neighbours = (sx: number, sy: number): Set<string> => {
    const s = new Set<string>();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      s.add(`${sx + dx},${sy + dy}`);
    }
    return s;
  };

  it("returns null when every tile adjacent to the source is walled/paved (no fallback to the source tile)", () => {
    const corp = new ConstructionCorp("W44N23-construction", "spawn1");
    const room = roomWith(33, 29, neighbours(33, 29)); // all 8 neighbours are wall
    const spot = (corp as any).findMissingSourceContainer(room);
    expect(spot, "no buildable neighbour -> skip the source, never propose (33,29)").to.equal(null);
  });

  it("still proposes a real adjacent tile when one is buildable", () => {
    const corp = new ConstructionCorp("W44N23-construction", "spawn1");
    // Wall every neighbour EXCEPT (34,29): the container lands there, not on the source.
    const walls = neighbours(33, 29);
    walls.delete("34,29");
    const room = roomWith(33, 29, walls);
    const spot = (corp as any).findMissingSourceContainer(room);
    expect(spot).to.deep.equal({ x: 34, y: 29 });
  });

  it("deletes the redundant road under a freshly placed container (owner 2026-07-23)", () => {
    // A container is legal on a road, but the road under it is dead weight: the
    // miner stands there statically and haulers stop to load, so the road saves
    // no fatigue and just decay-taxes us forever. placeSite removes it.
    const corp = new ConstructionCorp("W44N23-construction", "spawn1");
    let destroyed = false;
    const road = { structureType: "road", destroy: () => ((destroyed = true), 0) };
    const room: any = {
      name: "W44N23",
      memory: {},
      createConstructionSite: () => 0, // OK
      lookForAt: (type: string) => (type === "structure" ? [road] : [])
    };
    (corp as any).placeSite(room, 11, 11, "container");
    expect(destroyed, "the road under the new container is removed").to.equal(true);
  });

  it("leaves a road in place when the placed structure is NOT a container", () => {
    const corp = new ConstructionCorp("W44N23-construction", "spawn1");
    let destroyed = false;
    const road = { structureType: "road", destroy: () => ((destroyed = true), 0) };
    const room: any = {
      name: "W44N23",
      memory: {},
      createConstructionSite: () => 0, // OK
      lookForAt: (type: string) => (type === "structure" ? [road] : [])
    };
    (corp as any).placeSite(room, 11, 11, "link");
    expect(destroyed, "a link/tower/road placement must not destroy roads").to.equal(false);
  });
});
