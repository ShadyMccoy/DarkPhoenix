/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { ConstructionCorp } from "../../../src/corps/ConstructionCorp";
import { resetGovernor } from "../../../src/execution/CpuGovernor";

/**
 * Builder-corp sizing is sized to the SUM OF ITS PROJECTS (owner 2026-07-19:
 * "size up the builder corp by the sum total of all its projects" - a
 * construction project is a finite tile list with a computable total cost, so
 * a nearly-finished room should field a small crew and a work-heavy room a big
 * one, at the SAME allocation and fuel). Before this, builderPlan sized purely
 * to the flow allocation (supply), work-blind: a room with 500 energy of work
 * left fielded the same crew as one with 30k.
 */
describe("ConstructionCorp builder sizing is work-aware (sum of projects)", () => {
  beforeEach(() => {
    setupGlobals();
    resetGovernor();
    const g = global as any;
    g.FIND_MY_CONSTRUCTION_SITES = 114;
    g.FIND_STRUCTURES = 107;
    g.FIND_DROPPED_RESOURCES = 106;
    g.STRUCTURE_CONTAINER = "container";
    g.STRUCTURE_STORAGE = "storage";
    g.RESOURCE_ENERGY = "energy";
    Game.creeps = {};
    Game.getObjectById = () => null;
    (Memory as any).creeps = {};
  });

  const site = (remaining: number): any => ({
    progressTotal: remaining,
    progress: 0,
    // buildSideStock scans around the first site; no local energy here so the
    // 600k storage surplus below is the (non-binding, large) fuel.
    pos: { findInRange: () => [] }
  });

  const mkRoom = (sites: any[]): any => ({
    name: "W1N1",
    controller: { my: true }, // owned: not a remote pile-fed room
    storage: { my: true, store: { energy: 600_000 } },
    memory: {},
    find: (type: number) => (type === 114 ? sites : [])
  });

  const planFor = (remaining: number): any => {
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    corp.setConstructionAllocations([
      { sinkId: "s", sinkType: "construction", allocated: 100, demand: 100, unmet: 0, priority: 50, sourceFlows: [] }
    ] as any);
    return (corp as any).builderPlan(1300, mkRoom([site(remaining)]));
  };

  it("census counts the WHOLE corp: builders AND the tanker detail (X3, countMismatch t72446096)", () => {
    // The tankers carry this corp's id but were invisible to getCreepCount
    // (builders squad only) - the census read "untracked 3" for a day while
    // every creep's corpId resolved. Squad.members() scans Game.creeps by
    // corpId+workType, so the pin just stages one of each.
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    const cid = (corp as any).id;
    Game.creeps = {
      b1: { memory: { corpId: cid, workType: "build" }, spawning: false } as any,
      t1: { memory: { corpId: cid, workType: "tank" }, spawning: false } as any,
      other: { memory: { corpId: "someone-else", workType: "tank" }, spawning: false } as any
    };
    expect(corp.getCreepCount(), "builder + tanker both counted; strangers not").to.equal(2);
  });

  it("fields a SMALLER crew for a nearly-finished project than a work-heavy one at the same allocation", () => {
    const heavy = planFor(30_000); // a fresh extension/storage set
    const light = planFor(400); // one road tile's worth of work left
    expect(light.partsNeeded, "little work left -> small crew").to.be.lessThan(heavy.partsNeeded);
    expect(light.partsNeeded, "a ~400-energy tail never fields a big crew").to.be.at.most(2);
  });

  it("LIFETIME-COMPLETION sizing (owner 2026-07-20): finish within the buffered effective life", () => {
    // Horizon = 2/3 of effective life ("aim for around 1,000 ... a bit of a
    // buffer. We don't want it 99% finished"): 30k / 1000t = 30 e/t = 6 WORK.
    // The 100 e/t allocation is NOT the binding cap; the ~70 e/t residual
    // flows back to upgrading in the planner (the value pass hands the
    // controller what construction's capacity does not claim).
    const heavy = planFor(30_000);
    expect(heavy.partsNeeded, "30k project -> 6 WORK (done in ~2/3 of a life)").to.equal(6);
  });
});

/**
 * SPEC 25 PHASE 3 (owner: "there shouldn't be any residual we can just make
 * a bigger builder if we need to consume all the energy from the source mine
 * during that time"): the commission's poolAllocatedRate - the summed
 * source-local cluster allocations of the SPAWNLESS rooms this spawn staffs,
 * priced at the SOURCE'S rate by the adapter - lifts the pool crew's horizon
 * cap. The crew works ONE project at a time (pool-head order), so it sizes to
 * the MAX of the funding tracks, never their sum (owner: "body parts standing
 * around, unable to do their job is one form of waste").
 */
describe("SPEC 25 PHASE 3: pool crew sizes up to the plan's source-funded cluster rate", () => {
  beforeEach(() => {
    setupGlobals();
    resetGovernor();
    const g = global as any;
    g.FIND_MY_CONSTRUCTION_SITES = 114;
    g.FIND_STRUCTURES = 107;
    g.FIND_DROPPED_RESOURCES = 106;
    g.STRUCTURE_CONTAINER = "container";
    g.STRUCTURE_STORAGE = "storage";
    g.RESOURCE_ENERGY = "energy";
    Game.creeps = {};
    (Memory as any).creeps = {};
    // The HOME branch of builderPlan: the corp's spawn stands in the room it
    // plans for, and the build pool spans Game.rooms.
    Game.getObjectById = (() => ({
      id: "spawn1",
      pos: { x: 25, y: 25, roomName: "W1N1", getRangeTo: () => 0 }
    })) as any;
  });

  afterEach(() => {
    // The mock Game is a SHARED module singleton: leaving a resolving
    // getObjectById behind poisons later files (CarryCorp reads .room off
    // whatever this returns). Restore the mock default.
    Game.getObjectById = () => null;
    Game.rooms = {} as any;
  });

  const site = (remaining: number): any => ({
    progressTotal: remaining,
    progress: 0,
    pos: { x: 30, y: 30, findInRange: () => [] }
  });

  const mkRoom = (name: string, sites: any[]): any => ({
    name,
    controller: { my: name === "W1N1" }, // home owned; the cluster room is not
    storage: name === "W1N1" ? { my: true, store: { energy: 600_000 } } : undefined,
    memory: {},
    find: (type: number) => (type === 114 ? sites : [])
  });

  // remoteSites null = the cluster room is BLIND (no vision): the plan still
  // knows its sites (intel), so poolAllocatedRate arrives while buildPool
  // cannot see the work - a real live shape, not a mock artifact.
  const planFor = (ownAllocated: number, poolRate: number, homeSites: any[], remoteSites: any[] | null): any => {
    Game.rooms = { W1N1: mkRoom("W1N1", homeSites) } as any;
    if (remoteSites) (Game.rooms as any).W2N1 = mkRoom("W2N1", remoteSites);
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    if (ownAllocated > 0) {
      corp.setConstructionAllocations([
        {
          sinkId: "s",
          sinkType: "construction",
          allocated: ownAllocated,
          demand: ownAllocated,
          unmet: 0,
          priority: 50,
          sourceFlows: []
        }
      ] as any);
    }
    corp.setPoolAllocatedRate(poolRate);
    return (corp as any).builderPlan(1300, Game.rooms.W1N1);
  };

  it("a source-funded cluster fields a BIGGER builder than the horizon rate alone (no residual)", () => {
    // No home sites, no own allocation: all the pool's work is a remote
    // cluster the plan funds at the source's 10 e/t. Without the pool rate
    // the crew floors at 5 e/t (1 WORK); with it, the crew eats the mine.
    const without = planFor(0, 0, [], [site(3000)]);
    const withRate = planFor(0, 10, [], [site(3000)]);
    expect(without.partsNeeded, "no pool rate: floored crew").to.equal(1);
    expect(withRate.partsNeeded, "source-funded: 10 e/t -> 2 WORK, the whole mine consumed").to.equal(2);
  });

  it("MAX of the funding tracks, never the sum: a cluster under the horizon cap adds no parts", () => {
    // A 30k home build-out absorbs 30 e/t (6 WORK, the lifetime-completion
    // pin above); a 10 e/t cluster on top must NOT field 8 WORK - the crew
    // is serial, so whichever project it stands at bounds its useful size.
    // The cluster room is blind here: the plan's rate arrives via the
    // commission regardless of vision.
    const bankOnly = planFor(100, 0, [site(30_000)], null);
    const bankPlusCluster = planFor(100, 10, [site(30_000)], null);
    expect(bankOnly.partsNeeded).to.equal(6);
    expect(bankPlusCluster.partsNeeded, "summing would idle parts; MAX holds the crew at 6").to.equal(6);
  });

  it("survives serialization: the pool rate round-trips (commission-owned but reset-safe)", () => {
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    corp.setPoolAllocatedRate(10);
    const back = new ConstructionCorp("W1N1-construction", "spawn1");
    back.deserialize(JSON.parse(JSON.stringify(corp.serialize())));
    expect((back as any).poolAllocatedRate).to.equal(10);
  });
});

/**
 * Link-superseded containers leave the maintenance rolls (owner 2026-07-20:
 * "we keep repairing the container even though we don't use it anymore"):
 * once a source feeds its link, its legacy container is neither repaired
 * (decays to dust for free) nor re-placed.
 */
describe("ConstructionCorp ignores link-superseded source containers", () => {
  beforeEach(() => {
    setupGlobals();
    resetGovernor();
    const g = global as any;
    g.FIND_STRUCTURES = 107;
    g.FIND_MY_STRUCTURES = 108;
    g.FIND_SOURCES = 105;
    g.STRUCTURE_CONTAINER = "container";
    g.STRUCTURE_ROAD = "road";
    g.STRUCTURE_LINK = "link";
  });

  function linkedRoom(hasSourceLink: boolean): any {
    const coreL = { id: "core-link", structureType: "link" };
    const srcL = { id: "src-link", structureType: "link" };
    const container = {
      structureType: "container",
      hits: 100_000,
      hitsMax: 250_000,
      pos: { x: 10, y: 10 }
    };
    const source = {
      pos: {
        x: 10,
        y: 10,
        findInRange: (find: number) => (find === 108 && hasSourceLink ? [srcL] : [])
      }
    };
    return {
      name: "W1N1",
      storage: { my: true, pos: { findInRange: (find: number) => (find === 108 ? [coreL] : []) } },
      find: (t: number) => (t === 105 ? [source] : t === 107 ? [container] : [])
    };
  }

  it("a container at a LINK-FED source is not repairable; the same container without a link is", () => {
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    expect((corp as any).roomRepairables(linkedRoom(true)), "superseded: off the rolls").to.have.length(0);
    expect((corp as any).roomRepairables(linkedRoom(false)), "no link: still maintained").to.have.length(1);
  });

  /** A controller container the input election migrated OFF (spec 24 rung 1)
   * decays to dust like a link-superseded one; the election WINNER stays
   * maintained. Open terrain: a range-3 container's park ring (5) loses to
   * the fresh range-2 best (8), so it is displaced; a range-2 container's
   * ring ties the best and it holds the input. */
  function controllerRoom(containerX: number): any {
    const container = {
      structureType: "container",
      hits: 100_000,
      hitsMax: 250_000,
      pos: { x: containerX, y: 25, roomName: "W1N1" }
    };
    const room: any = {
      name: "W1N1",
      getTerrain: () => ({ get: () => 0 }),
      find: (t: number) => (t === 107 ? [container] : [])
    };
    room.controller = {
      my: true,
      room,
      pos: {
        x: 25,
        y: 25,
        roomName: "W1N1",
        findInRange: (_t: number, range: number) =>
          Math.abs(containerX - 25) <= range ? [container] : []
      }
    };
    return room;
  }

  it("a DISPLACED controller container (input migrated to a better ring) leaves the rolls", () => {
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    expect((corp as any).roomRepairables(controllerRoom(28)), "range-3 clipped ring: displaced").to.have.length(0);
    expect((corp as any).roomRepairables(controllerRoom(27)), "range-2 full ring: still the input").to.have.length(1);
  });
});
