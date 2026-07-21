/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, Game } from "../mock";
import { ConstructionCorp } from "../../../src/corps/ConstructionCorp";
import { resetGovernor } from "../../../src/execution/CpuGovernor";

/**
 * Remote source containers (owner 2026-07-21: "some of the remote source
 * don't have containers built. or partially built ... It's a similar paradigm
 * to building a road from the remote end, with no hauling. especially if
 * energy is laying there anyways already").
 *
 * The remote rung existed - pile-gated placement, built from that same pile -
 * but three defects starved it:
 *  1. the placement gate counted ALL sites, so the trunk program's standing
 *     ROAD sites in the remote room blocked the container forever;
 *  2. the one-build-pool change zeroed remote corps' builders, so the
 *     pile-funded local build lost its crew (the home pool crew visits only
 *     when the home queue empties - the "partially built" shape);
 *  3. work()'s remote branch ran everyone through runBuilder and never
 *     dispatched the repair detail, so a BUILT remote container decayed
 *     unrepaired (the other "partially built" shape).
 */

const FIND_MY_CONSTRUCTION_SITES = 114;
const FIND_CONSTRUCTION_SITES = 111;
const FIND_DROPPED_RESOURCES = 118;
const FIND_TOMBSTONES = 119;
const FIND_RUINS = 120;

interface WorldOpts {
  pile?: number;
  roadSites?: boolean;
  containerSite?: boolean;
  container?: { hits: number };
}

function remoteWorld(opts: WorldOpts): { room: any; source: any } {
  const cheb = (a: any, b: any): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const sites: any[] = [];
  if (opts.roadSites) {
    // the trunk's segment through this room: road sites strung mid-route
    sites.push(
      { structureType: "road", pos: { x: 30, y: 30, roomName: "W2N1" } },
      { structureType: "road", pos: { x: 31, y: 30, roomName: "W2N1" } }
    );
  }
  if (opts.containerSite) {
    sites.push({ structureType: "container", pos: { x: 21, y: 20, roomName: "W2N1" } });
  }
  const structures: any[] = [];
  if (opts.container) {
    structures.push({
      id: "cont1",
      structureType: "container",
      hits: opts.container.hits,
      hitsMax: 250_000,
      store: { energy: 500, getFreeCapacity: () => 1500 },
      pos: { x: 21, y: 20, roomName: "W2N1" }
    });
  }
  const drops: any[] =
    opts.pile && opts.pile > 0
      ? [{ resourceType: "energy", amount: opts.pile, pos: { x: 21, y: 20, roomName: "W2N1" } }]
      : [];

  const sourcePos: any = new (global as any).RoomPosition(20, 20, "W2N1");
  sourcePos.findInRange = (type: number, range: number, o?: any) => {
    const all =
      type === FIND_DROPPED_RESOURCES
        ? drops
        : type === (global as any).FIND_STRUCTURES
        ? structures
        : type === FIND_MY_CONSTRUCTION_SITES
        ? sites
        : [];
    const near = all.filter((e: any) => cheb(e.pos, sourcePos) <= range);
    return o?.filter ? near.filter(o.filter) : near;
  };

  const source: any = { id: "src1", pos: sourcePos };
  const room: any = {
    name: "W2N1",
    memory: {},
    storage: undefined,
    controller: { my: false, pos: { x: 5, y: 5, roomName: "W2N1" } }, // reserved, not ours
    getTerrain: () => ({ get: () => 0 }),
    find: (type: number, o?: any) => {
      const all =
        type === (global as any).FIND_SOURCES
          ? [source]
          : type === (global as any).FIND_STRUCTURES
          ? structures
          : type === FIND_MY_CONSTRUCTION_SITES || type === FIND_CONSTRUCTION_SITES
          ? sites
          : [];
      return o?.filter ? all.filter(o.filter) : all;
    }
  };
  source.room = room;
  return { room, source };
}

function mkCorp(): ConstructionCorp {
  return new ConstructionCorp("W2N1-construction", "spawn1");
}

describe("remote source containers (owner 2026-07-21: build from the remote end, no hauling)", () => {
  beforeEach(() => {
    setupGlobals();
    resetGovernor();
    (global as any).FIND_MY_CONSTRUCTION_SITES = FIND_MY_CONSTRUCTION_SITES;
    (global as any).FIND_CONSTRUCTION_SITES = FIND_CONSTRUCTION_SITES;
    (global as any).FIND_DROPPED_RESOURCES = FIND_DROPPED_RESOURCES;
    (global as any).FIND_TOMBSTONES = FIND_TOMBSTONES;
    (global as any).FIND_RUINS = FIND_RUINS;
    (global as any).RESOURCE_ENERGY = "energy";
    Game.creeps = {};
    Game.rooms = {};
    (Game as any).time = 5000;
    Game.getObjectById = (() => ({
      pos: new (global as any).RoomPosition(25, 25, "W1N1"),
      room: { name: "W1N1" }
    })) as never;
  });

  describe("placement: trunk ROAD sites must not block the container rung", () => {
    it("places the container despite standing road sites (the live blocker)", () => {
      const { room, source } = remoteWorld({ pile: 300, roadSites: true });
      const spot = (mkCorp() as any).remoteContainerSiteWanted(room);
      expect(spot, "the pile-gated container is still wanted").to.not.equal(null);
      expect(Math.max(Math.abs(spot.x - source.pos.x), Math.abs(spot.y - source.pos.y)), "adjacent to the source").to.equal(1);
    });

    it("one container project at a time: a standing CONTAINER site closes the rung", () => {
      const { room } = remoteWorld({ pile: 300, containerSite: true });
      expect((mkCorp() as any).remoteContainerSiteWanted(room)).to.equal(null);
    });

    it("no pile, no container: the demand signal stays the pile threshold", () => {
      const { room } = remoteWorld({ pile: 100, roadSites: true });
      expect((mkCorp() as any).remoteContainerSiteWanted(room)).to.equal(null);
    });

    it("a built container settles the source (nothing wanted)", () => {
      const { room } = remoteWorld({ pile: 300, container: { hits: 250_000 } });
      expect((mkCorp() as any).remoteContainerSiteWanted(room)).to.equal(null);
    });
  });

  describe("demand: the pile-funded local crew (no hauling - the owner's road-end paradigm)", () => {
    const ctx: any = { energyCapacity: 550 };

    it("fields ONE local builder while the container project stands (site placed)", () => {
      const { room } = remoteWorld({ containerSite: true });
      Game.rooms = { W2N1: room } as any;
      const demands = mkCorp().getSpawnDemand(ctx);
      expect(demands.length, "exactly one builder demand").to.equal(1);
      expect(demands[0].role).to.equal("builder");
    });

    it("fields the builder from the pile signal alone (before the site lands)", () => {
      const { room } = remoteWorld({ pile: 300, roadSites: true });
      Game.rooms = { W2N1: room } as any;
      expect(mkCorp().getSpawnDemand(ctx).length).to.equal(1);
    });

    it("stands down when the source is settled (container built and healthy)", () => {
      const { room } = remoteWorld({ container: { hits: 250_000 } });
      Game.rooms = { W2N1: room } as any;
      expect(mkCorp().getSpawnDemand(ctx).length).to.equal(0);
    });

    it("a decayed remote container still fields the repair detail (not a build crew)", () => {
      const { room } = remoteWorld({ container: { hits: 40_000 } });
      Game.rooms = { W2N1: room } as any;
      const demands = mkCorp().getSpawnDemand(ctx);
      expect(demands.length, "one member: the standing repair detail").to.equal(1);
    });
  });

  describe("work(): the remote branch dispatches the repair detail (it ran everyone as builders)", () => {
    it("a repair-detail member REPAIRS the decayed container instead of idling", () => {
      const { room } = remoteWorld({ container: { hits: 40_000 } });
      Game.rooms = { W2N1: room } as any;
      const corp = mkCorp();
      const repaired: string[] = [];
      const creep: any = {
        name: "b1",
        spawning: false,
        memory: { corpId: corp.id, workType: "build", repairDetail: true },
        room,
        pos: new (global as any).RoomPosition(22, 20, "W2N1"),
        store: { energy: 50, getFreeCapacity: () => 0 },
        repair: (t: any) => {
          repaired.push(t.id);
          return 0;
        },
        moveTo: () => 0,
        say: () => 0
      };
      creep.store["energy"] = 50;
      Game.creeps = { b1: creep } as any;
      corp.work(6000);
      expect(repaired, "the detail repaired the container").to.deep.equal(["cont1"]);
    });
  });
});
