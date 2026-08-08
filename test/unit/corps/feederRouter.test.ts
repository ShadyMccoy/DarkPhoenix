/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { LinkCorp } from "../../../src/corps/LinkCorp";

/**
 * The feeder is the SOLE bidirectional operator of the core link (spec 02
 * feeder-router, owner 2026-07-26). runFeeder must LOAD storage -> core to feed
 * the controller relay AND DRAIN core -> storage to bank source-link income and
 * keep the core open for volleys. The old code only ever LOADED - the missing
 * empty direction was done by a walking hauler that fought the feeder for the
 * core (the storage->core->storage thrash, t72595372). And its body must be
 * sized to actually move the core drain, or the core backs up (spec-26 gridlock).
 */

const CORP_ID = "moving-W1N1-controllerFeeder";

function mkGlobals(): void {
  const g = global as any;
  g.RESOURCE_ENERGY = "energy";
  g.FIND_MY_STRUCTURES = 108;
  g.FIND_MY_SPAWNS = 112;
  g.FIND_SOURCES = 105;
  g.FIND_MY_CONSTRUCTION_SITES = 114;
  g.FIND_STRUCTURES = 107;
  g.STRUCTURE_LINK = "link";
  g.STRUCTURE_CONTAINER = "container";
  g.STRUCTURE_STORAGE = "storage";
  g.WORK = "work";
  g.CARRY = "carry";
  g.MOVE = "move";
  g.OK = 0;
  g.ERR_NOT_IN_RANGE = -9;
}

const cheby = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function mkPos(x: number, y: number) {
  return {
    x,
    y,
    roomName: "W1N1",
    getRangeTo: (p: any) => cheby({ x, y }, p.pos ? p.pos : p),
    isEqualTo: (p: any) => x === p.x && y === p.y,
    isNearTo: (p: any) => cheby({ x, y }, p.pos ? p.pos : p) <= 1
  };
}

function mkLink(id: string, x: number, y: number, energy: number, free: number) {
  return {
    id,
    structureType: "link",
    pos: mkPos(x, y),
    store: { energy, getFreeCapacity: () => free } as any
  };
}

interface WorldOpts {
  coreEnergy: number;
  coreFree?: number;
  ctrlFree: number;
  creepEnergy: number;
  creepCap?: number;
  creepPos?: { x: number; y: number };
  linkMode?: "load" | "drain";
  storageFree?: number;
}

function mkWorld(o: WorldOpts) {
  mkGlobals();
  const cap = o.creepCap ?? 400;
  const core = mkLink("core", 26, 25, o.coreEnergy, o.coreFree ?? 800 - o.coreEnergy);
  const ctrl = mkLink("ctrl", 28, 26, 0, o.ctrlFree);
  const storage: any = {
    my: true,
    id: "storage",
    pos: {
      ...mkPos(25, 25),
      findInRange: (t: number, _r: number, opts?: any) => {
        const list = t === 108 ? [core] : [];
        return opts?.filter ? list.filter(opts.filter) : list;
      }
    },
    store: { energy: 500_000, getFreeCapacity: () => o.storageFree ?? 1_000_000 } as any
  };
  const controller: any = {
    my: true,
    pos: {
      ...mkPos(27, 26),
      findInRange: (t: number, range: number, opts?: any) => {
        const near = [ctrl, core].filter(l => cheby({ x: 27, y: 26 }, l.pos) <= range);
        return opts?.filter ? near.filter(opts.filter) : near;
      }
    }
  };
  const actions = { withdraw: [] as any[], transfer: [] as any[] };
  const cpos = o.creepPos ?? { x: 25, y: 26 }; // range 1 to storage(25,25) AND core(26,25)
  let energy = o.creepEnergy;
  const creep: any = {
    name: "feeder1",
    spawning: false,
    memory: { corpId: CORP_ID, workType: "feed", ...(o.linkMode ? { linkMode: o.linkMode } : {}) },
    pos: mkPos(cpos.x, cpos.y),
    store: {
      get energy() {
        return energy;
      },
      getFreeCapacity: () => cap - energy,
      getUsedCapacity: () => energy,
      getCapacity: () => cap
    },
    withdraw: (target: any, _res: string, amt?: number) => {
      actions.withdraw.push({ id: target.id, amt });
      energy = Math.min(cap, energy + (amt ?? cap - energy));
      return 0;
    },
    transfer: (target: any, _res: string, amt?: number) => {
      actions.transfer.push({ id: target.id, amt });
      energy = Math.max(0, energy - (amt ?? energy));
      return 0;
    }
  };
  const room: any = {
    name: "W1N1",
    memory: {},
    storage,
    controller,
    find: (t: number) => (t === 105 ? [] : t === 114 ? [] : t === 112 ? [spawn] : [])
  };
  creep.room = room;
  const spawn: any = { id: "spawn1", pos: mkPos(25, 24), room };
  const g = global as any;
  g.Game = { time: 1000, creeps: { feeder1: creep }, getObjectById: (id: string) => (id === "spawn1" ? spawn : null), rooms: { W1N1: room } };
  g.Memory = { creeps: {} };
  return { core, ctrl, storage, creep, actions, room, controller, get energy() { return energy; } };
}

// Don't leak the mocked Game/Memory into later test files (mocha runs one
// process): restore the base default from setup-mocha.js that other files'
// corps read when they don't set their own.
function cleanupGlobals(): void {
  (global as any).Game = {
    creeps: {},
    rooms: {},
    spawns: {},
    time: 0,
    map: { getRoomTerrain: () => ({ get: () => 0 }) },
    getObjectById: () => null
  };
  (global as any).Memory = { creeps: {}, rooms: {} };
}

describe("LinkCorp bidirectional link router (spec 02)", () => {
  afterEach(cleanupGlobals);
  it("feederRouter.empty: core OVER target + controller sated -> feeder WITHDRAWS from the core (not storage)", () => {
    // core 600, controller nearly full (free 50): target 50, drain 550. The old
    // load-only feeder (empty, working=false) would reload from STORAGE; the
    // router pulls the surplus from the CORE to bank it.
    const w = mkWorld({ coreEnergy: 600, ctrlFree: 50, creepEnergy: 0 });
    const corp = new LinkCorp("W1N1-controllerFeeder", "spawn1");
    corp.work(1000);
    expect(w.creep.memory.linkMode, "commits to draining").to.equal("drain");
    expect(w.actions.withdraw.map(a => a.id), "withdraws from the CORE, never storage").to.deep.equal(["core"]);
    expect(w.actions.transfer, "nothing loaded into the core this tick").to.have.length(0);
  });

  it("feederRouter.empty: pulls only the EXCESS above target (no over-drain self-thrash)", () => {
    const w = mkWorld({ coreEnergy: 600, ctrlFree: 50, creepEnergy: 0, creepCap: 2000 });
    const corp = new LinkCorp("W1N1-controllerFeeder", "spawn1");
    corp.work(1000);
    // target 50 -> drain 550; the withdraw is capped at the excess, not the whole core.
    expect(w.actions.withdraw[0].amt).to.equal(550);
  });

  it("feederRouter.drain: carrying in drain mode -> deposits into STORAGE (banks the income)", () => {
    const w = mkWorld({ coreEnergy: 600, ctrlFree: 50, creepEnergy: 300, linkMode: "drain" });
    const corp = new LinkCorp("W1N1-controllerFeeder", "spawn1");
    corp.work(1000);
    expect(w.actions.transfer.map(a => a.id)).to.deep.equal(["storage"]);
    expect(w.actions.withdraw, "does not also pull more this tick").to.have.length(0);
  });

  it("feederRouter.load: core BELOW target + controller hungry -> loads storage->core (unchanged)", () => {
    // core 0, controller drained (free 400): target 400, loadRoom 400, drain 0.
    const empty = mkWorld({ coreEnergy: 0, ctrlFree: 400, creepEnergy: 0 });
    const corp = new LinkCorp("W1N1-controllerFeeder", "spawn1");
    corp.work(1000);
    expect(empty.creep.memory.linkMode).to.equal("load");
    expect(empty.actions.withdraw.map(a => a.id), "fills from storage first").to.deep.equal(["storage"]);

    // Now carrying: it transfers into the core (up to loadRoom).
    const carrying = mkWorld({ coreEnergy: 0, ctrlFree: 400, creepEnergy: 300, linkMode: "load" });
    const corp2 = new LinkCorp("W1N1-controllerFeeder", "spawn1");
    corp2.work(1000);
    expect(carrying.actions.transfer.map(a => a.id), "loads into the core").to.deep.equal(["core"]);
  });

  it("feederRouter: at target exactly -> holds (no load, no drain)", () => {
    // core == target (ctrlFree 400 -> target 400, core 400): nothing to do.
    const w = mkWorld({ coreEnergy: 400, ctrlFree: 400, creepEnergy: 0 });
    const corp = new LinkCorp("W1N1-controllerFeeder", "spawn1");
    corp.work(1000);
    expect(w.actions.withdraw, "no drain at target").to.have.length(0);
    expect(w.actions.transfer, "no load at target").to.have.length(0);
  });
});

/**
 * The feeder BODY drain-floor: the sole operator must be sized to move the core
 * inflow (link-served source income + spec-26 deposit headroom), or the core
 * backs up (the spec-26 gridlock). Old code sized the link-fed body to the
 * controller relay only (~1 CARRY), which cannot drain multiple source links.
 */
function mkSizingWorld(sourceLinkCount: number, banked: number) {
  mkGlobals();
  const core = mkLink("core", 26, 25, 0, 800);
  const ctrl = mkLink("ctrl", 28, 26, 0, 400);
  const sources = Array.from({ length: 2 }, (_v, i) => {
    const sx = 10 + i * 20;
    const srcLink = i < sourceLinkCount ? mkLink(`slink${i}`, sx + 1, 12, 0, 800) : null;
    return {
      id: `src${i}`,
      pos: {
        ...mkPos(sx, 12),
        findInRange: (t: number, _r: number, opts?: any) => {
          const list = t === 108 && srcLink ? [srcLink] : [];
          return opts?.filter ? list.filter(opts.filter) : list;
        }
      }
    };
  });
  const storage: any = {
    my: true,
    id: "storage",
    pos: {
      ...mkPos(25, 25),
      findInRange: (t: number, _r: number, opts?: any) => {
        const list = t === 108 ? [core] : [];
        return opts?.filter ? list.filter(opts.filter) : list;
      }
    },
    store: { energy: banked, getFreeCapacity: () => 1_000_000 } as any
  };
  const controller: any = {
    my: true,
    progressTotal: 1000,
    progress: 0,
    pos: {
      ...mkPos(27, 26),
      findInRange: (t: number, range: number, opts?: any) => {
        const near = [ctrl, core].filter(l => cheby({ x: 27, y: 26 }, l.pos) <= range);
        return opts?.filter ? near.filter(opts.filter) : near;
      }
    }
  };
  const room: any = {
    name: "W1N1",
    memory: {},
    storage,
    controller,
    energyCapacityAvailable: 1800,
    find: (t: number) => (t === 105 ? sources : t === 114 ? [] : t === 112 ? [] : [])
  };
  const spawn: any = { id: "spawn1", pos: mkPos(25, 24), room };
  const miner: any = { name: "m1", spawning: false, room: { name: "W1N1" }, memory: { workType: "harvest", corpId: "mining-src0" } };
  const g = global as any;
  g.Game = { time: 1000, creeps: { m1: miner }, getObjectById: (id: string) => (id === "spawn1" ? spawn : null), rooms: { W1N1: room } };
  g.Memory = { creeps: {}, warchestTarget: undefined };
  return { room };
}

describe("LinkCorp body drain-floor sizing (spec 02 anti-collapse)", () => {
  afterEach(cleanupGlobals);
  it("sizes the link-fed body to the core drain, DERIVED from each link's range", () => {
    mkSizingWorld(2, 5000); // banked < reserve: save regime, relay ~15 e/t
    const corp = new LinkCorp("W1N1-controllerFeeder", "spawn1");
    corp.getSpawnDemand({ tick: 1000, energyCapacity: 1800 } as any);
    const s = corp.lastSizing as any;
    // NO COPIED CONSTANT (2026-08-06). This read `2 * (10 + 30) = 80` from a
    // literal the feeder was documented to "keep in sync" with the planner by
    // hand - a coupling that went stale the moment the flat deposit cap was
    // retired for the link's real fire rate. Per link the drain is now exactly
    // what that link can PUSH: its own source's 10 e/t plus the deposit
    // headroom on top, which is LINK_CAPACITY/range by construction.
    //   slink0 (11,12) -> core (26,25): chebyshev 15 -> 800/15 = 53.33
    //   slink1 (31,12) -> core (26,25): chebyshev 13 -> 800/13 = 61.54
    expect(s.coreDrain, "sum of both links' fire rates").to.be.closeTo(800 / 15 + 800 / 13, 1e-9);
    expect(s.coreDrain, "and strictly above the constant it replaced").to.be.greaterThan(80);
    // The body still follows the drain, and the spec-45 volley floor still
    // dominates it - the point of the change is that the number is derived,
    // not that the feeder gets bigger.
    expect(s.neededCarry).to.be.at.least(Math.ceil((800 / 15 + 800 / 13) * (2 / 50)));
  });

  it("no source links -> no drain floor, the body is unchanged (relay only)", () => {
    mkSizingWorld(0, 5000);
    const corp = new LinkCorp("W1N1-controllerFeeder", "spawn1");
    corp.getSpawnDemand({ tick: 1000, energyCapacity: 1800 } as any);
    const s = corp.lastSizing as any;
    expect(s.coreDrain, "no core inflow to drain").to.equal(undefined);
    expect(s.neededCarry, "relay-sized (~1 CARRY) as before").to.equal(1);
  });
});
