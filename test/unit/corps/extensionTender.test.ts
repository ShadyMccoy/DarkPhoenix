/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game } from "../mock";
import { ExtensionTenderCorp } from "../../../src/corps/ExtensionTenderCorp";

const FIND_MY_SPAWNS = 112;
const FIND_STRUCTURES = 107;
const FIND_MY_STRUCTURES = 108;

/**
 * The extension tender (a local mover) only asks for a creep once there's a depot
 * to draw from and extensions to fill, and it runs exactly one (oversized) tender
 * per room. Without a depot the haulers still fill the network themselves, so no
 * tender is wanted.
 */
function room(opts: { depot?: boolean; extensions?: number; scattered?: boolean }): any {
  const spawnPos = {
    x: 25, y: 25, roomName: "W0N0",
    findInRange: (type: number) =>
      type === FIND_STRUCTURES && opts.depot ? [{ structureType: "container", pos: { x: 24, y: 25 } }] : []
  };
  const spawn = { id: "spawn1", pos: spawnPos, store: { getFreeCapacity: () => 0 } };
  // Default: one tight row (a single spatial cluster). scattered: three
  // well-separated groups - the legacy-layout shape the fleet count serves.
  const groupAnchor = (i: number): { x: number; y: number } =>
    i % 3 === 0 ? { x: 10, y: 10 } : i % 3 === 1 ? { x: 40, y: 10 } : { x: 25, y: 40 };
  const extensions = Array.from({ length: opts.extensions ?? 0 }, (_, i) => ({
    structureType: "extension",
    pos: opts.scattered
      ? { x: groupAnchor(i).x + Math.floor(i / 3), y: groupAnchor(i).y }
      : { x: 20 + i, y: 20 },
    store: { getFreeCapacity: () => 50 }
  }));
  return {
    name: "W0N0",
    find: (type: number, o?: any) => {
      if (type === FIND_MY_SPAWNS) return [spawn];
      if (type === FIND_MY_STRUCTURES) {
        const all = [spawn, ...extensions];
        return o?.filter ? all.filter(o.filter) : all;
      }
      return [];
    },
    _spawn: spawn
  };
}

describe("ExtensionTenderCorp spawn demand (local mover)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).FIND_MY_SPAWNS = FIND_MY_SPAWNS;
    (global as any).FIND_STRUCTURES = FIND_STRUCTURES;
    (global as any).FIND_MY_STRUCTURES = FIND_MY_STRUCTURES;
    (global as any).STRUCTURE_EXTENSION = "extension";
    (global as any).STRUCTURE_SPAWN = "spawn";
    (global as any).STRUCTURE_CONTAINER = "container";
    Game.creeps = {};
  });

  // corpFor mutates the shared mock Game.getObjectById; restore it (and creeps) so
  // later test files (e.g. getSpawnDemand.test.ts) don't inherit a room without
  // .memory. The mock Game is a singleton, so setupGlobals alone won't reset it.
  afterEach(() => {
    Game.getObjectById = () => null;
    Game.creeps = {};
  });

  const ctx = { energyCapacity: 800, tick: 100 };

  function corpFor(r: any): ExtensionTenderCorp {
    Game.getObjectById = (id: string) => (id === "spawn1" ? { ...r._spawn, room: r } : null) as any;
    return new ExtensionTenderCorp("W0N0-tender", "spawn1");
  }

  it("asks for NOTHING when there is no depot (haulers still fill the network)", () => {
    const corp = corpFor(room({ depot: false, extensions: 5 }));
    expect(corp.getSpawnDemand(ctx as any)).to.have.length(0);
  });

  it("asks for NOTHING when there are no extensions to fill", () => {
    const corp = corpFor(room({ depot: true, extensions: 0 }));
    expect(corp.getSpawnDemand(ctx as any)).to.have.length(0);
  });

  it("FLEET OF 3 SMALL (owner 2026-07-22): a 40-extension room targets three EQUAL-SHARE tenders", () => {
    // "Split the same amount of body parts across two or three creeps" -
    // the cap returns to 3 but tenderSlotCarry's equal share keeps the
    // TOTAL at one bank wave (~the cap-2 ratchet's parts budget), so the
    // scattered legacy layout gets three coverage points, not the old
    // 72-part fleet back.
    const r = room({ depot: true, extensions: 40, scattered: true });
    const corp = corpFor(r);
    Game.creeps = {
      m1: { room: { name: "W0N0" }, memory: { workType: "harvest", corpId: "mining-x" } } as any
    };
    const demand = corp.getSpawnDemand({ energyCapacity: 2300, tick: 100 } as any);
    const sizing = (corp as any).lastSizing;
    expect(sizing.target, "three coverage points on scatter").to.equal(3);
    // Equal share: ceil(2300/3/50) = 16 carry -> a ~32-part 1:1 body request.
    expect(demand[0]?.bodyParam, "equal-share body, not cluster-inflated").to.equal(16);
  });

  it("stamps the transfer-duty meter into lastSizing (the ratchet's verification instrument)", () => {
    const r = room({ depot: true, extensions: 10 });
    const corp = corpFor(r);
    Game.creeps = {
      m1: { room: { name: "W0N0" }, memory: { workType: "harvest", corpId: "mining-x" } } as any
    };
    (corp as any).dutyTransfers = 30;
    (corp as any).dutyAlive = 100;
    (corp as any).dutySince = 50;
    corp.getSpawnDemand({ energyCapacity: 2300, tick: 100 } as any);
    const sizing = (corp as any).lastSizing;
    expect(sizing.duty, "duty = transfers per alive tender tick").to.equal(0.3);
    expect(sizing.meterTicks).to.equal(50);
    // Round-trips: a global reset mid-window must not read as a collapse.
    const back = new ExtensionTenderCorp("W0N0-tender", "spawn1");
    back.deserialize(JSON.parse(JSON.stringify(corp.serialize())));
    expect((back as any).dutyTransfers).to.equal(30);
  });

  it("REFILL BOOTSTRAP (owner, live t72490325): a DARK post with a stocked bank outbids all income and blocks", () => {
    // Zero tenders + banked energy = every spawn tick without a tender
    // buys runts from an unfillable room. Emergency value 150 beats miners
    // (100-146) and haulers (90-110); one live tender ends the emergency.
    const r = room({ depot: true, extensions: 40, scattered: true });
    (r as any).storage = { my: true, store: { energy: 173_000 } };
    const corp = corpFor(r);
    Game.creeps = {
      m1: { room: { name: "W0N0" }, memory: { workType: "harvest", corpId: "mining-x" } } as any
    };
    const dark = corp.getSpawnDemand({ energyCapacity: 2300, tick: 100 } as any);
    expect(dark[0].value, "emergency: above the whole income range").to.equal(150);
    expect(dark[0].blocking, "value wins the rank; never freeze the spawn (W2N6 scar)").to.equal(false);
    expect(dark[0].minCost, "a scaled tender fields on the next walk").to.equal(200);

    // One live tender: back to ordinary infrastructure priority.
    Game.creeps.t1 = {
      memory: { corpId: (corp as any).id, workType: "tank" },
      body: { length: 8 },
      ticksToLive: 1400,
      room: { name: "W0N0" }
    } as any;
    const staffedOne = corp.getSpawnDemand({ energyCapacity: 2300, tick: 100 } as any);
    expect(staffedOne[0].value, "one alive: ordinary priority for the top-up").to.equal(96);
    expect(staffedOne[0].blocking).to.equal(false);
  });

  it("asks for NOTHING before the room has a miner (income before infrastructure)", () => {
    const corp = corpFor(room({ depot: true, extensions: 5 }));
    Game.creeps = {}; // no miner yet
    expect(corp.getSpawnDemand(ctx as any)).to.have.length(0);
  });

  it("asks for ONE non-blocking, oversized tender when a depot, extensions and a miner exist", () => {
    const r = room({ depot: true, extensions: 5 });
    const corp = corpFor(r);
    Game.creeps = { m1: { room: { name: "W0N0" }, memory: { corpId: "mining-abc", workType: "harvest" }, spawning: false } } as any;
    const demand = corp.getSpawnDemand(ctx as any);
    expect(demand).to.have.length(1);
    expect(demand[0].role).to.equal("tanker");
    expect(demand[0].blocking, "infrastructure, must not hold the spawn ahead of producers").to.equal(false);
    expect(demand[0].bodyParam, "sized to refill the whole extension set (+spawn)").to.equal(6);
  });

  // SLA fleet sizing (commit 540289d): the target is max(clusters, coverage) —
  // in this world 2 (the spawn sits in its own cluster, and a 550 bank over a
  // 400-carry body needs two tenders to cover a full drain in one wave).
  it("asks for a second tender while SLA coverage is short", () => {
    const r = room({ depot: true, extensions: 5 });
    const corp = corpFor(r);
    Game.creeps = {
      m1: { room: { name: "W0N0" }, memory: { corpId: "mining-abc", workType: "harvest" }, spawning: false },
      t1: { room: { name: "W0N0" }, memory: { corpId: corp.id, workType: "tank" }, spawning: false }
    } as any;
    expect(corp.getSpawnDemand(ctx as any)).to.have.length(1);
  });

  it("asks for nothing once the SLA fleet is fielded", () => {
    const r = room({ depot: true, extensions: 5 });
    const corp = corpFor(r);
    Game.creeps = {
      m1: { room: { name: "W0N0" }, memory: { corpId: "mining-abc", workType: "harvest" }, spawning: false },
      t1: { room: { name: "W0N0" }, memory: { corpId: corp.id, workType: "tank" }, spawning: false },
      t2: { room: { name: "W0N0" }, memory: { corpId: corp.id, workType: "tank" }, spawning: false }
    } as any;
    expect(corp.getSpawnDemand(ctx as any)).to.have.length(0);
  });
});

/**
 * Spec 07 "feed" acceptance: towers join the tender's fill circuit below half
 * charge (keep the war chest loaded) and stay OUT of it above (don't top off
 * a mid-fight trickle). Sorted by range like any other non-spawn target.
 */
describe("ExtensionTenderCorp feeds towers (spec 07)", () => {
  beforeEach(() => {
    (global as any).FIND_MY_STRUCTURES = FIND_MY_STRUCTURES;
    (global as any).STRUCTURE_EXTENSION = "extension";
    (global as any).STRUCTURE_SPAWN = "spawn";
    (global as any).STRUCTURE_TOWER = "tower";
    (global as any).RESOURCE_ENERGY = "energy";
  });

  const from = { x: 25, y: 25, getRangeTo: (p: any) => Math.max(Math.abs(p.x - 25), Math.abs(p.y - 25)) };

  function roomWith(towerEnergy: number): any {
    const ext = {
      structureType: "extension",
      pos: { x: 20, y: 25 }, // range 5
      store: { getFreeCapacity: () => 50, energy: 0, getCapacity: () => 50 }
    };
    const tower = {
      structureType: "tower",
      pos: { x: 27, y: 25 }, // range 2 - closer than the extension
      store: {
        getFreeCapacity: () => 1000 - towerEnergy,
        getCapacity: () => 1000,
        energy: towerEnergy
      }
    };
    return {
      name: "W0N0",
      find: (type: number, o?: any) => {
        if (type === FIND_MY_STRUCTURES) {
          const all = [ext, tower];
          return o?.filter ? all.filter(o.filter) : all;
        }
        return [];
      }
    };
  }

  it("includes a 40% tower, sorted by range like any other target", () => {
    const corp = new ExtensionTenderCorp("W0N0-tender", "spawn1");
    const targets = (corp as any).fillTargets(roomWith(400), from);
    expect(targets.map((t: any) => t.structureType)).to.deep.equal(["tower", "extension"]);
  });

  it("excludes an 80% tower (don't top off the mid-fight trickle)", () => {
    const corp = new ExtensionTenderCorp("W0N0-tender", "spawn1");
    const targets = (corp as any).fillTargets(roomWith(800), from);
    expect(targets.map((t: any) => t.structureType)).to.deep.equal(["extension"]);
  });
});
