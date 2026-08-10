/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import {
  bestEdgeLinkTile,
  EDGE_LINK_MIN_SAVING,
  EdgeLinkSiting,
  PortApproach
} from "../../../src/corps/constructionPlacement";
import { LINK_CAPACITY, DEPOSIT_PORT_UNKNOWN_RANGE_FALLBACK } from "../../../src/economy/primitives";
import { resetGovernor } from "../../../src/execution/CpuGovernor";

/**
 * EDGE LINKS (owner 2026-08-06: *"Let's build the edge links then"*, unblocked
 * by RCL 8's 6-link table).
 *
 * Spec 47 named three blockers: RCL 8 (arrived), the relay (shipped as the
 * LinkCorp's port tender, spec 54), and SITING - *"an edge LINK wants the same
 * treatment against the same approach lens, minus the range-2 constraint. Not
 * built."* This file is that siting, red-first.
 *
 * The election is spec 26 stage 5's metric made a rung: maximize the
 * flow-weighted MARGINAL haul saving against the approaches' current best
 * deposit (storage or an existing port), subject to the reach rule - a link's
 * fire rate is LINK_CAPACITY/range, so the tile must keep
 * `depositPortHeadroom(range, 0) >= routedFlow` ("push the link as far toward
 * the flow as its 800/F ring allows, then it is optimal").
 */
describe("bestEdgeLinkTile (spec 47 edge links, spec 26 stage 5 reach rule)", () => {
  const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const open = (): ((x: number, y: number) => boolean) => () => false;
  const free = (): ((x: number, y: number) => boolean) => () => false;

  const from = (x: number, y: number, flowRate = 1): PortApproach => ({ from: { x, y }, flowRate });

  /** A room whose hub sits center-east: approaches from the west have a long
   *  baseline to beat, which is the edge link's whole reason to exist. */
  const base = (over: Partial<EdgeLinkSiting> = {}): EdgeLinkSiting => ({
    corePos: { x: 30, y: 25 },
    storagePos: { x: 31, y: 26 },
    approaches: [from(1, 25)],
    existingPorts: [],
    routedFlow: DEPOSIT_PORT_UNKNOWN_RANGE_FALLBACK,
    ...over
  });

  it("meets the flow at the door: a west approach elects a tile toward the west exit", () => {
    const t = bestEdgeLinkTile(base(), open(), free());
    expect(t, "a long unserved approach must elect a tile").to.not.equal(null);
    expect(t!.x, `expected west of the hub, got ${JSON.stringify(t)}`).to.be.lessThan(20);
    // And it saves real route: the approach's walk to the tile beats its walk
    // to storage by at least the placement bar.
    const baseline = cheb({ x: 1, y: 25 }, { x: 31, y: 26 });
    expect(baseline - cheb({ x: 1, y: 25 }, t!)).to.be.at.least(EDGE_LINK_MIN_SAVING);
  });

  it("obeys the reach rule: never beyond the 800/F ring of the core", () => {
    // routedFlow 30 -> ring 800/30 = 26.67: the elected tile must fire at
    // least as fast as the flow routed to it.
    const t30 = bestEdgeLinkTile(base(), open(), free())!;
    expect(LINK_CAPACITY / cheb(t30, { x: 30, y: 25 })).to.be.at.least(30);
    // A heavier assumed flow pulls the ring IN (range* <= 800/F): at 60 e/t
    // the same approach gets a tile at range <= 13, not the far-west tile.
    const t60 = bestEdgeLinkTile(base({ routedFlow: 60 }), open(), free())!;
    expect(cheb(t60, { x: 30, y: 25 }), "60 e/t must be caught close to the core").to.be.at.most(13);
    expect(cheb(t30, { x: 30, y: 25 }), "30 e/t reaches farther out").to.be.greaterThan(cheb(t60, { x: 30, y: 25 }));
  });

  it("scores MARGINAL saving: an approach already served by an existing port elects nothing", () => {
    // A port 4 tiles in from the west exit: the approach's baseline is 4, so
    // no legal tile can save EDGE_LINK_MIN_SAVING more - null, not a twin.
    const t = bestEdgeLinkTile(base({ existingPorts: [{ x: 5, y: 25 }] }), open(), free());
    expect(t).to.equal(null);
  });

  it("serves the UNSERVED approach when another is already ported", () => {
    const north = from(25, 1);
    const west = from(1, 25);
    const t = bestEdgeLinkTile(
      base({ approaches: [north, west], existingPorts: [{ x: 25, y: 5 }] }),
      open(),
      free()
    )!;
    expect(t, "the west approach still wants a port").to.not.equal(null);
    expect(t.x, `expected a west tile, got ${JSON.stringify(t)}`).to.be.lessThan(20);
    expect(t.y, "not the already-served north edge").to.be.greaterThan(10);
  });

  it("weights by flowRate: the fatter approach wins the slot", () => {
    const heavyNorth = bestEdgeLinkTile(
      base({ approaches: [from(25, 1, 30), from(1, 25, 10)] }),
      open(),
      free()
    )!;
    expect(heavyNorth.y, "30 e/t north outranks 10 e/t west").to.be.lessThan(15);
    const heavyWest = bestEdgeLinkTile(
      base({ approaches: [from(25, 1, 10), from(1, 25, 30)] }),
      open(),
      free()
    )!;
    expect(heavyWest.x, "and the pull flips with the flow").to.be.lessThan(15);
  });

  it("never lands where a link would be misread as core, controller or source link", () => {
    // The classification lenses are identity, not preference: a link within 2
    // of storage IS the core link (coreLink), within 3 of the controller IS
    // the controller link (controllerLink), within 2 of a source IS that
    // source's link (sourceLink). An edge link on those tiles would change
    // owners the moment it stood.
    const t = bestEdgeLinkTile(
      base({
        controllerPos: { x: 5, y: 25 },
        sourcePositions: [{ x: 11, y: 25 }]
      }),
      open(),
      free()
    )!;
    expect(t, "guards move the tile, they must not kill the election").to.not.equal(null);
    expect(cheb(t, { x: 5, y: 25 }), "outside the controller-link lens").to.be.greaterThan(3);
    expect(cheb(t, { x: 11, y: 25 }), "outside the source-link lens").to.be.greaterThan(2);
    expect(cheb(t, { x: 31, y: 26 }), "outside the core-link lens").to.be.greaterThan(2);
  });

  it("skips occupied tiles and takes the next-best", () => {
    const winner = bestEdgeLinkTile(base(), open(), free())!;
    const occupied = (x: number, y: number): boolean => x === winner.x && y === winner.y;
    const t = bestEdgeLinkTile(base(), open(), occupied)!;
    expect(t, "an occupied winner yields to the runner-up").to.not.equal(null);
    expect(t.x === winner.x && t.y === winner.y).to.equal(false);
  });

  it("refuses a sub-bar saving: a hub already near the exit elects nothing", () => {
    // Storage 5 tiles from the approach: nothing an edge link could save is
    // worth one of six slots plus a 5000e build.
    const t = bestEdgeLinkTile(
      base({ corePos: { x: 5, y: 25 }, storagePos: { x: 6, y: 25 } }),
      open(),
      free()
    );
    expect(t).to.equal(null);
  });

  it("returns null with no approaches, and under full blockage", () => {
    expect(bestEdgeLinkTile(base({ approaches: [] }), open(), free())).to.equal(null);
    expect(bestEdgeLinkTile(base(), () => true, free())).to.equal(null);
  });

  it("is deterministic: the same world elects the same tile", () => {
    const a = bestEdgeLinkTile(base(), open(), free());
    const b = bestEdgeLinkTile(base(), open(), free());
    expect(a).to.deep.equal(b);
  });
});

/**
 * THE RUNG: `findMissingLink` step 3. RCL 8 lifts the table to six and the
 * existing ladder (core, controller, home-source links) tops out at four in the
 * live room - the two remaining slots were unreachable by construction. The
 * rung elects an edge-link tile from the SAME approach lens the port container
 * uses (`portApproaches` - funded remotes' entry exits; the plan's durable
 * signal, never creep positions).
 */
describe("findMissingLink rung 3: edge links at RCL 8 slots", () => {
  const FIND_SOURCES = 105;
  const FIND_MY_STRUCTURES = 108;
  const FIND_MY_SPAWNS = 112;
  const FIND_MY_CONSTRUCTION_SITES = 114;
  const FIND_EXIT_LEFT = 7;
  const ROOM = "W43N23";

  const cheb = (a: any, b: any): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

  beforeEach(() => {
    setupGlobals();
    resetGovernor();
    Game.time = 500;
    const g = global as any;
    g.OK = 0;
    g.FIND_SOURCES = FIND_SOURCES;
    g.FIND_MY_STRUCTURES = FIND_MY_STRUCTURES;
    g.FIND_MY_SPAWNS = FIND_MY_SPAWNS;
    g.FIND_MY_CONSTRUCTION_SITES = FIND_MY_CONSTRUCTION_SITES;
    g.FIND_STRUCTURES = 107;
    g.LOOK_STRUCTURES = "structure";
    g.LOOK_CONSTRUCTION_SITES = "site";
    g.STRUCTURE_CONTAINER = "container";
    g.STRUCTURE_LINK = "link";
    g.STRUCTURE_ROAD = "road";
    g.RESOURCE_ENERGY = "energy";
    g.TERRAIN_MASK_WALL = 1;
    Game.creeps = {};
    (Memory as any).creeps = {};
    (Memory as any).fundedRemoteRooms = ["W44N23"];
  });

  const posOf = (x: number, y: number): any => ({
    x,
    y,
    roomName: ROOM,
    getRangeTo(o: any) {
      return cheb(this, o.pos ?? o);
    },
    inRangeTo(o: any, r: number) {
      return cheb(this, o.pos ?? o) <= r;
    }
  });

  /**
   * The live-room shape at RCL 8: storage+core, controller+link, two far home
   * sources each already link-served - the ladder's first four links stand and
   * two table slots are free. One funded remote to the WEST.
   */
  const world = (opts: { rcl?: number; linkSites?: { x: number; y: number }[]; remotes?: string[] } = {}): any => {
    (Memory as any).fundedRemoteRooms = opts.remotes ?? ["W44N23"];
    const linkTiles = [
      { x: 35, y: 25 }, // core (storage at 36,26)
      { x: 41, y: 30 }, // controller link (controller at 40,32)
      { x: 45, y: 12 }, // source link for s1 (44,12)
      { x: 43, y: 38 } // source link for s2 (43,39)
    ];
    const structures: any[] = linkTiles.map((p, i) => ({
      structureType: "link",
      id: `link${i}`,
      my: true,
      pos: posOf(p.x, p.y)
    }));
    const sites: any[] = (opts.linkSites ?? []).map((p, i) => ({
      structureType: "link",
      id: `site${i}`,
      my: true,
      pos: posOf(p.x, p.y)
    }));
    const sources = [
      { id: "s1", pos: posOf(44, 12) },
      { id: "s2", pos: posOf(43, 39) }
    ];
    const scanFrom =
      (self: any) =>
      (_t: number, range: number, o?: any): any[] => {
        const near = structures.filter(x => cheb(x.pos, self) <= range);
        return o?.filter ? near.filter(o.filter) : near;
      };
    const room: any = {
      name: ROOM,
      memory: {},
      getTerrain: () => ({ get: () => 0 }),
      lookForAt: (what: string, x: number, y: number) => {
        if (what === "structure") return structures.filter(s => s.pos.x === x && s.pos.y === y);
        if (what === "site") return sites.filter(s => s.pos.x === x && s.pos.y === y);
        return [];
      },
      findExitTo: (toRoom: string) => (toRoom === "W44N23" ? FIND_EXIT_LEFT : -2),
      find: (type: number, o?: any) => {
        if (type === FIND_SOURCES) return sources;
        if (type === FIND_MY_SPAWNS) return [{ id: "spawn1", pos: posOf(33, 24) }];
        if (type === FIND_MY_CONSTRUCTION_SITES) {
          return o?.filter ? sites.filter(o.filter) : sites;
        }
        if (type === FIND_EXIT_LEFT) {
          const run: any[] = [];
          for (let y = 20; y <= 28; y++) run.push({ x: 0, y, roomName: ROOM });
          return run;
        }
        const list = type === FIND_MY_STRUCTURES ? structures : structures;
        return o?.filter ? list.filter(o.filter) : list;
      },
      storage: { my: true, pos: posOf(36, 26), store: { energy: 200000 } },
      controller: { my: true, level: opts.rcl ?? 8, pos: posOf(40, 32) }
    };
    room.controller.room = room;
    room.storage.pos.findInRange = scanFrom(room.storage.pos);
    room.controller.pos.findInRange = scanFrom(room.controller.pos);
    for (const s of structures) {
      s.room = room;
      s.pos.findInRange = scanFrom(s.pos);
    }
    for (const s of sources) (s.pos as any).findInRange = scanFrom(s.pos);
    Game.rooms = { [ROOM]: room } as any;
    return room;
  };

  const corp = (): any => {
    const { ConstructionCorp } = require("../../../src/corps/ConstructionCorp");
    return new ConstructionCorp(`${ROOM}-construction`, "spawn1") as any;
  };

  it("RCL 8 with free slots and a funded west remote: elects a west edge-link tile", () => {
    const room = world();
    const tile = corp().findMissingLink(room, 8);
    expect(tile, "two slots are free and a long approach is unserved").to.not.equal(null);
    expect(tile.x, `expected a west tile, got ${JSON.stringify(tile)}`).to.be.lessThan(20);
    // Reach rule against the core at (35,25), at the conservative routed flow.
    expect(cheb(tile, { x: 35, y: 25 })).to.be.at.most(Math.floor(800 / DEPOSIT_PORT_UNKNOWN_RANGE_FALLBACK));
    // Classification guards: the new link must stay itself.
    expect(cheb(tile, { x: 36, y: 26 }), "not the core's tile-space").to.be.greaterThan(2);
    expect(cheb(tile, { x: 40, y: 32 }), "not the controller link").to.be.greaterThan(3);
    expect(cheb(tile, { x: 44, y: 12 }), "not s1's link").to.be.greaterThan(2);
    expect(cheb(tile, { x: 43, y: 39 }), "not s2's link").to.be.greaterThan(2);
  });

  it("RCL 7: the table is full at four - the wall holds, no edge link", () => {
    const room = world({ rcl: 7 });
    expect(corp().findMissingLink(room, 7)).to.equal(null);
  });

  it("no funded remotes: no approaches, no edge link", () => {
    const room = world({ remotes: [] });
    expect(corp().findMissingLink(room, 8)).to.equal(null);
  });

  it("a pending edge-link SITE serves its approach: no double placement", () => {
    // The site sits where the previous election landed; the approach's
    // baseline is now 9-10 tiles and the ring blocks anything meaningfully
    // closer to the exit, so the second slot stays free rather than buying a
    // twin. (Sites count against the table AND in the baseline.)
    const room = world({ linkSites: [{ x: 9, y: 24 }] });
    expect(corp().findMissingLink(room, 8)).to.equal(null);
  });
});
