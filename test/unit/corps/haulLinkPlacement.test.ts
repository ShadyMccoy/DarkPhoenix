/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import {
  bestHaulLinkTile,
  APPROACH_FALLBACK_FLOW,
  HAUL_LINK_MIN_SAVING,
  HaulLinkSiting,
  PortApproach
} from "../../../src/corps/constructionPlacement";
import { LINK_CAPACITY, SOURCE_RATE, portTenderHaulEquivalent } from "../../../src/economy/primitives";
import { resetGovernor } from "../../../src/execution/CpuGovernor";

/**
 * HAUL LINKS - one election for every link that is not the core or the
 * controller link (owner 2026-08-10: *"Do we have to distinguish between
 * 'edge' links? Besides core and upgrader seems like placing links in general
 * where they most efficiently replace haul fleet size is ideal."*).
 *
 * Born as the RCL8 edge-link rung (spec 47's third blocker, owner 2026-08-06
 * *"Let's build the edge links then"*), then unified: home-source mouths join
 * the approach set at SOURCE_RATE, the source lens stops being an exclusion
 * zone (a link beside a mouth is just a haul link whose tender is free and
 * whose fire rate carries its source), and rung priority dissolves into one
 * L-ranking. The single surviving distinction is a PRICE: a candidate no
 * standing miner can feed pays the port tender's body
 * (`portTenderHaulEquivalent`) out of its saving.
 *
 * Objective: maximize flow x marginal saving vs each approach's current best
 * deposit. Constraint (endogenous): the tile's ROUTED catchment sets F and
 * `depositPortHeadroom(range, ownSourceRate) > F` must hold strictly - an
 * adjacent mouth's rate rides the ownSourceRate side, never both.
 */
describe("bestHaulLinkTile (unified link election)", () => {
  const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const open = (): ((x: number, y: number) => boolean) => () => false;
  const free = (): ((x: number, y: number) => boolean) => () => false;

  const from = (x: number, y: number, flowRate = 1): PortApproach => ({ from: { x, y }, flowRate });

  /** A room whose hub sits center-east: approaches from the west have a long
   *  baseline to beat, which is a haul link's whole reason to exist. */
  const base = (over: Partial<HaulLinkSiting> = {}): HaulLinkSiting => ({
    corePos: { x: 30, y: 25 },
    storagePos: { x: 31, y: 26 },
    approaches: [from(1, 25, 30)],
    existingPorts: [],
    ...over
  });

  it("meets the flow at the door: a west approach elects a tile toward the west exit", () => {
    const t = bestHaulLinkTile(base(), open(), free());
    expect(t, "a long unserved approach must elect a tile").to.not.equal(null);
    expect(t!.x, `expected west of the hub, got ${JSON.stringify(t)}`).to.be.lessThan(20);
    const baseline = cheb({ x: 1, y: 25 }, { x: 31, y: 26 });
    expect(baseline - cheb({ x: 1, y: 25 }, t!)).to.be.at.least(HAUL_LINK_MIN_SAVING);
  });

  it("obeys the reach rule: the link's fire rate strictly EXCEEDS its catchment's flow", () => {
    const t30 = bestHaulLinkTile(base(), open(), free())!;
    expect(LINK_CAPACITY / cheb(t30, { x: 30, y: 25 })).to.be.greaterThan(30);
    const t60 = bestHaulLinkTile(base({ approaches: [from(1, 25, 60)] }), open(), free())!;
    expect(cheb(t60, { x: 30, y: 25 }), "60 e/t must be caught close to the core").to.be.at.most(13);
    expect(cheb(t30, { x: 30, y: 25 }), "30 e/t reaches farther out").to.be.greaterThan(cheb(t60, { x: 30, y: 25 }));
  });

  it("the catchment SUMS every approach that would divert - two west routes tighten the ring together", () => {
    const t = bestHaulLinkTile(
      base({ approaches: [from(1, 20, 30), from(1, 30, 25)] }),
      open(),
      free()
    )!;
    expect(t, "two heavy routes still get a port").to.not.equal(null);
    expect(cheb(t, { x: 30, y: 25 }), "the ring binds on the SUM").to.be.at.most(14);
    expect(LINK_CAPACITY / cheb(t, { x: 30, y: 25 })).to.be.greaterThan(55);
  });

  it("...but flow that would NOT divert here does not tighten it", () => {
    const t = bestHaulLinkTile(
      base({
        approaches: [from(1, 25, 30), from(48, 25, 60)],
        existingPorts: [{ x: 46, y: 25 }]
      }),
      open(),
      free()
    )!;
    expect(t.x, "the west approach is the one being served").to.be.lessThan(20);
    expect(cheb(t, { x: 30, y: 25 })).to.be.greaterThan(Math.floor(LINK_CAPACITY / 90));
    expect(LINK_CAPACITY / cheb(t, { x: 30, y: 25 })).to.be.greaterThan(30);
  });

  it("scores MARGINAL saving: an approach already served by an existing port elects nothing", () => {
    const t = bestHaulLinkTile(base({ existingPorts: [{ x: 5, y: 25 }] }), open(), free());
    expect(t).to.equal(null);
  });

  it("serves the UNSERVED approach when another is already ported", () => {
    const north = from(25, 1, 30);
    const west = from(1, 25, 30);
    const t = bestHaulLinkTile(
      base({ approaches: [north, west], existingPorts: [{ x: 25, y: 5 }] }),
      open(),
      free()
    )!;
    expect(t, "the west approach still wants a port").to.not.equal(null);
    expect(t.x, `expected a west tile, got ${JSON.stringify(t)}`).to.be.lessThan(20);
    expect(t.y, "not the already-served north edge").to.be.greaterThan(10);
  });

  it("weights by flowRate: the fatter approach wins the slot", () => {
    const heavyNorth = bestHaulLinkTile(
      base({ approaches: [from(25, 1, 30), from(1, 25, 10)] }),
      open(),
      free()
    )!;
    expect(heavyNorth.y, "30 e/t north outranks 10 e/t west").to.be.lessThan(15);
    const heavyWest = bestHaulLinkTile(
      base({ approaches: [from(25, 1, 10), from(1, 25, 30)] }),
      open(),
      free()
    )!;
    expect(heavyWest.x, "and the pull flips with the flow").to.be.lessThan(15);
  });

  it("never lands inside the CORE or CONTROLLER lens; a source's neighbourhood is fair game", () => {
    // The structural lenses stay identity guards. The source lens does NOT -
    // only the source's exact tile (nothing builds on a source) and the
    // miner's post (a link there evicts the standing miner) are barred.
    const t = bestHaulLinkTile(
      base({
        controllerPos: { x: 5, y: 25 },
        sourcePositions: [{ x: 11, y: 25 }]
      }),
      open(),
      free()
    )!;
    expect(t, "guards move the tile, they must not kill the election").to.not.equal(null);
    expect(cheb(t, { x: 5, y: 25 }), "outside the controller-link lens").to.be.greaterThan(3);
    expect(cheb(t, { x: 31, y: 26 }), "outside the core-link lens").to.be.greaterThan(2);
    expect(t.x === 11 && t.y === 25, "never ON the source tile").to.equal(false);
  });

  it("a home-source mouth is just another approach: elected beside the mouth, fed by the standing miner", () => {
    // The old source-link rung as the unified election's degenerate case: one
    // unlinked far mouth, its miner posted beside it. The winner must sit
    // where the miner can feed it (debit-free) - within 1 of the post - and
    // never ON the mouth or the post.
    const mouth = { x: 5, y: 25 };
    const post = { x: 6, y: 25 };
    const t = bestHaulLinkTile(
      base({
        approaches: [from(mouth.x, mouth.y, SOURCE_RATE)],
        sourcePositions: [mouth],
        minerPosts: [post]
      }),
      open(),
      free()
    )!;
    expect(t, "a far unlinked mouth earns a link").to.not.equal(null);
    expect(cheb(t, mouth), "beside the mouth (the saving is the whole haul)").to.be.at.most(2);
    expect(cheb(t, post), "where the standing miner can feed it").to.be.at.most(1);
    expect(t.x === mouth.x && t.y === mouth.y, "never on the source").to.equal(false);
    expect(t.x === post.x && t.y === post.y, "never on the miner's post").to.equal(false);
  });

  it("the tender is a PRICE: the same marginal geometry places with a miner and refuses without one", () => {
    // A mouth 11 tiles from storage: max saving 10 x SOURCE_RATE = 100
    // tile-e/t, exactly the tender's body equivalent. With a post the link is
    // free-tended and worth it; without one the tender eats the whole saving
    // and the slot correctly stays free.
    const mouth = { x: 20, y: 25 };
    const world = (posts: { x: number; y: number }[]): HaulLinkSiting =>
      base({
        approaches: [from(mouth.x, mouth.y, SOURCE_RATE)],
        sourcePositions: [mouth],
        minerPosts: posts
      });
    expect(portTenderHaulEquivalent(), "the debit this test is built around").to.equal(100);
    expect(bestHaulLinkTile(world([{ x: 21, y: 25 }]), open(), free()), "miner-fed: worth it").to.not.equal(null);
    expect(bestHaulLinkTile(world([]), open(), free()), "tender eats the saving: refused").to.equal(null);
  });

  it("rung priority is dissolved: a heavier remote confluence outbids a farther source mouth", () => {
    // The old ladder placed source links unconditionally first. Under one
    // L-ranking the 30 e/t remote (L ~ 800) beats the 10 e/t mouth (L ~ 180)
    // for the scarce slot - and once the remote is served, the NEXT election
    // picks the mouth. (The mouth sits in the OPPOSITE corner: on a shared
    // axis the optimizer legitimately elects one middle tile serving both,
    // which is the unified model's point, not this test's subject.)
    const mouth = { x: 40, y: 45 };
    const post = { x: 41, y: 45 };
    const siting = (ports: { x: number; y: number }[]): HaulLinkSiting =>
      base({
        approaches: [from(1, 25, 30), from(mouth.x, mouth.y, SOURCE_RATE)],
        existingPorts: ports,
        sourcePositions: [mouth],
        minerPosts: [post]
      });
    const first = bestHaulLinkTile(siting([]), open(), free())!;
    expect(cheb(first, mouth), "the remote wins the first slot").to.be.greaterThan(2);
    expect(first.x, "toward the west approach, not the mouth").to.be.lessThan(20);
    const second = bestHaulLinkTile(siting([first]), open(), free())!;
    expect(cheb(second, post), "the mouth takes the next slot, miner-fed").to.be.at.most(1);
  });

  it("an adjacent mouth rides the ownSourceRate side of the headroom law, never the routed catchment", () => {
    // Core at the far east wall, mouth at the far west: range ~46 leaves fire
    // rate 800/46 = 17.4, minus the source's own 10 = 7.4 e/t of routed
    // headroom. The mouth's flow must NOT also count as routed catchment -
    // double-booking it (10 > 7.4) would refuse the very link that serves it.
    const t = bestHaulLinkTile(
      {
        corePos: { x: 48, y: 25 },
        storagePos: { x: 47, y: 26 },
        approaches: [from(2, 25, SOURCE_RATE)],
        existingPorts: [],
        sourcePositions: [{ x: 2, y: 25 }],
        minerPosts: [{ x: 3, y: 25 }]
      },
      open(),
      free()
    );
    expect(t, "the mouth's own supply is miner-fed, not hauled in").to.not.equal(null);
    expect(cheb(t!, { x: 3, y: 25 })).to.be.at.most(1);
  });

  it("skips occupied tiles and takes the next-best", () => {
    const winner = bestHaulLinkTile(base(), open(), free())!;
    const occupied = (x: number, y: number): boolean => x === winner.x && y === winner.y;
    const t = bestHaulLinkTile(base(), open(), occupied)!;
    expect(t, "an occupied winner yields to the runner-up").to.not.equal(null);
    expect(t.x === winner.x && t.y === winner.y).to.equal(false);
  });

  it("refuses a sub-bar saving: a hub already near the exit elects nothing", () => {
    const t = bestHaulLinkTile(
      base({ corePos: { x: 5, y: 25 }, storagePos: { x: 6, y: 25 } }),
      open(),
      free()
    );
    expect(t).to.equal(null);
  });

  it("returns null with no approaches, and under full blockage", () => {
    expect(bestHaulLinkTile(base({ approaches: [] }), open(), free())).to.equal(null);
    expect(bestHaulLinkTile(base(), () => true, free())).to.equal(null);
  });

  it("is deterministic: the same world elects the same tile", () => {
    const a = bestHaulLinkTile(base(), open(), free());
    const b = bestHaulLinkTile(base(), open(), free());
    expect(a).to.deep.equal(b);
  });
});

/**
 * THE RUNG: `findMissingLink` step 2 (unified). RCL 8 lifts the table to six;
 * the structural rungs (core, controller + swap) stay, and every remaining
 * slot goes through ONE election over funded-remote entries and unlinked
 * home mouths (`portApproaches` + the source lens; the plan's durable
 * signals, never creep positions).
 */
describe("findMissingLink: the unified haul-link election at RCL 8 slots", () => {
  const FIND_SOURCES = 105;
  const FIND_MY_STRUCTURES = 108;
  const FIND_MY_SPAWNS = 112;
  const FIND_MY_CONSTRUCTION_SITES = 114;
  const FIND_CONSTRUCTION_SITES = 111;
  const FIND_MINERALS = 116;
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
    g.FIND_CONSTRUCTION_SITES = FIND_CONSTRUCTION_SITES;
    g.FIND_MINERALS = FIND_MINERALS;
    g.FIND_STRUCTURES = 107;
    g.RoomPosition = function (this: any, x: number, y: number, roomName: string) {
      this.x = x;
      this.y = y;
      this.roomName = roomName;
    };
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
    (Memory as any).fundedRemoteFlows = { W44N23: 30 };
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
   * sources each already link-served - the structural rungs and both mouths
   * are satisfied, two table slots are free. One funded remote to the WEST,
   * its mined rate published (Memory.fundedRemoteFlows) as the plan does
   * live; `flowsAbsent` stages the deploy-boundary window before the first
   * publishing solve.
   */
  const world = (
    opts: { rcl?: number; linkSites?: { x: number; y: number }[]; remotes?: string[]; flowsAbsent?: boolean } = {}
  ): any => {
    (Memory as any).fundedRemoteRooms = opts.remotes ?? ["W44N23"];
    if (opts.flowsAbsent) delete (Memory as any).fundedRemoteFlows;
    else (Memory as any).fundedRemoteFlows = { W44N23: 30 };
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
        if (type === FIND_MY_CONSTRUCTION_SITES || type === FIND_CONSTRUCTION_SITES) {
          return o?.filter ? sites.filter(o.filter) : sites;
        }
        if (type === FIND_MINERALS) return [];
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
    for (const s of sources) {
      (s as any).room = room;
      (s.pos as any).findInRange = scanFrom(s.pos);
    }
    Game.rooms = { [ROOM]: room } as any;
    return room;
  };

  const corp = (): any => {
    const { ConstructionCorp } = require("../../../src/corps/ConstructionCorp");
    return new ConstructionCorp(`${ROOM}-construction`, "spawn1") as any;
  };

  it("RCL 8 with free slots and a funded west remote: elects a west haul-link tile", () => {
    const room = world();
    const tile = corp().findMissingLink(room, 8);
    expect(tile, "two slots are free and a long approach is unserved").to.not.equal(null);
    expect(tile.x, `expected a west tile, got ${JSON.stringify(tile)}`).to.be.lessThan(20);
    expect(800 / cheb(tile, { x: 35, y: 25 }), "fire rate strictly exceeds the routed 30 e/t").to.be.greaterThan(30);
    expect(cheb(tile, { x: 36, y: 26 }), "not the core's tile-space").to.be.greaterThan(2);
    expect(cheb(tile, { x: 40, y: 32 }), "not the controller link").to.be.greaterThan(3);
  });

  it("unpublished flows (one deploy-boundary solve): the fallback errs HIGH and still places", () => {
    const room = world({ flowsAbsent: true });
    const tile = corp().findMissingLink(room, 8);
    expect(tile, "the pre-publication window must not stall the rung").to.not.equal(null);
    expect(tile.x, "still a west tile").to.be.lessThan(20);
    expect(800 / cheb(tile, { x: 35, y: 25 })).to.be.greaterThan(APPROACH_FALLBACK_FLOW);
  });

  it("RCL 7: the table is full at four - the wall holds, no haul link", () => {
    const room = world({ rcl: 7 });
    expect(corp().findMissingLink(room, 7)).to.equal(null);
  });

  it("no funded remotes and both mouths linked: nothing to serve, no link", () => {
    const room = world({ remotes: [] });
    expect(corp().findMissingLink(room, 8)).to.equal(null);
  });

  it("a pending haul-link SITE serves its approach: no double placement", () => {
    // The site sits where the previous election landed; the approach's
    // baseline is now 9-10 tiles and the 800/30 ring blocks anything
    // meaningfully closer to the exit, so the second slot stays free rather
    // than buying a twin. (Sites count against the table AND in the baseline.)
    const room = world({ linkSites: [{ x: 9, y: 24 }] });
    expect(corp().findMissingLink(room, 8)).to.equal(null);
  });
});
