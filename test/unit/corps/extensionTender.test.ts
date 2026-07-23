/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game } from "../mock";
import {
  ExtensionTenderCorp,
  tenderBootstrapPierce,
  TENDER_BOOTSTRAP_ABUNDANT_STOCK
} from "../../../src/corps/ExtensionTenderCorp";

const FIND_MY_SPAWNS = 112;
const FIND_STRUCTURES = 107;
const FIND_MY_STRUCTURES = 108;

/**
 * The extension tender (a local mover) only asks for a creep once there's a depot
 * to draw from and extensions to fill, and it runs exactly one (oversized) tender
 * per room. Without a depot the haulers still fill the network themselves, so no
 * tender is wanted.
 */
function room(opts: { depot?: boolean; extensions?: number; scattered?: boolean; depotEnergy?: number }): any {
  const spawnPos = {
    x: 25, y: 25, roomName: "W0N0",
    findInRange: (type: number) =>
      type === FIND_STRUCTURES && opts.depot
        ? [{ structureType: "container", pos: { x: 24, y: 25 }, store: { energy: opts.depotEnergy ?? 0 } }]
        : []
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
    memory: {},
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

/**
 * tenderBootstrapPierce (pure): the spawn-wall pierce decision, unit-pinned so
 * the scheduler-deadlock fix (spec-26 collapse aftermath) has cheap coverage.
 * Two emergencies pierce; a normal ramp must not.
 */
describe("tenderBootstrapPierce (pure wall-pierce decision)", () => {
  it("PIERCES a dark post (staffing 0) with a stocked depot - the original rule", () => {
    expect(tenderBootstrapPierce(0, 3, 300)).to.equal(true);
    expect(tenderBootstrapPierce(0, 1, 300)).to.equal(true);
  });

  it("does NOT pierce a dark post with a dry depot (nothing stranded)", () => {
    expect(tenderBootstrapPierce(0, 3, 0)).to.equal(false);
    expect(tenderBootstrapPierce(0, 3, 299)).to.equal(false);
  });

  it("PIERCES a death spiral: below target AND depot abundant (spec-26 collapse fix)", () => {
    // One tender alive, fleet short of target, and the depot is hoarding stock
    // the fleet can't drain fast enough - the exact scheduler-wedge signature.
    expect(tenderBootstrapPierce(1, 3, TENDER_BOOTSTRAP_ABUNDANT_STOCK)).to.equal(true);
    expect(tenderBootstrapPierce(2, 3, 61_000)).to.equal(true);
  });

  it("does NOT pierce below target on a NORMAL ramp (stock below the abundant line)", () => {
    // The whole point of the high gate: an ordinary cold-start ramp banks far
    // less than TENDER_BOOTSTRAP_ABUNDANT_STOCK before its first tender, so the
    // broadened pierce never recreates the W2N6 blocking-stream hold.
    expect(tenderBootstrapPierce(1, 3, 300)).to.equal(false);
    expect(tenderBootstrapPierce(1, 3, TENDER_BOOTSTRAP_ABUNDANT_STOCK - 1)).to.equal(false);
  });

  it("does NOT pierce once the fleet is at/above target (emergency over)", () => {
    expect(tenderBootstrapPierce(3, 3, 61_000)).to.equal(false);
    expect(tenderBootstrapPierce(4, 3, 61_000)).to.equal(false);
  });
});

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

  it("COVERED STAMP (owner accountability ruling): depot + extensions marks the room tender-covered, tender alive or not", () => {
    // The structural flag the haulers key off: extension duty belongs to THIS
    // corp wherever a depot and extensions exist. It must NOT flap with tender
    // deaths (that liveness signal is extensionTenderActive, kept for the
    // depot-reserve nuances) - a dead tender means the bootstrap re-fields
    // one, never that haulers resume fanning.
    const r = room({ depot: true, extensions: 10 });
    const corp = corpFor(r);
    Game.creeps = {}; // no tender alive - the exact dead-tender window
    corp.work(100);
    expect(r.memory.extensionTenderCovered, "structural: depot + extensions").to.equal(true);
    expect(r.memory.extensionTenderActive, "liveness: no tender alive").to.equal(false);

    const bare = room({ depot: false, extensions: 10 });
    const corp2 = corpFor(bare);
    corp2.work(100);
    expect(bare.memory.extensionTenderCovered, "no depot: haulers still own the network").to.equal(false);
  });

  it("REFILL BOOTSTRAP covers CONTAINER depots too: haulers no longer bridge, so any stocked depot with a dark post is the emergency", () => {
    // With fan-fill retired, depot stock is UNREACHABLE for the network while
    // no tender lives - in a container-depot room (RCL2-3, no storage) an
    // ordinary 96 can lose to income (100-146) for thousands of ticks. One
    // spawn volley of stranded stock (>=300) triggers the same 150 rank.
    const r = room({ depot: true, extensions: 10, depotEnergy: 400 });
    const corp = corpFor(r);
    Game.creeps = {
      m1: { room: { name: "W0N0" }, memory: { workType: "harvest", corpId: "mining-x" } } as any
    };
    const demand = corp.getSpawnDemand({ energyCapacity: 800, tick: 100 } as any);
    expect(demand[0].value, "stranded container stock: same emergency rank").to.equal(150);
    expect(demand[0].blocking).to.equal(false);
  });

  it("no bootstrap from a DRY depot: a tender with nothing to move is ordinary infrastructure", () => {
    const r = room({ depot: true, extensions: 10, depotEnergy: 0 });
    const corp = corpFor(r);
    Game.creeps = {
      m1: { room: { name: "W0N0" }, memory: { workType: "harvest", corpId: "mining-x" } } as any
    };
    const demand = corp.getSpawnDemand({ energyCapacity: 800, tick: 100 } as any);
    expect(demand[0].value, "empty depot: nothing stranded, no emergency").to.equal(96);
  });

  it("REFILL BOOTSTRAP (owner, live t72490325): a DARK post with a stocked bank outbids all income and blocks", () => {
    // Zero tenders + banked energy = every spawn tick without a tender
    // buys runts from an unfillable room. Emergency value 150 beats miners
    // (100-146) and haulers (90-110). With an ABUNDANT bank (173k) the
    // emergency ends only when the fleet REACHES TARGET (spec-26 death-spiral
    // fix): one surviving tender against a hoarding depot is still the wedge.
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
    expect(dark[0].infrastructure, "the emergency ALSO pierces holds/walls (incident t72499165)").to.equal(true);

    // Fleet at TARGET (staffing 3): emergency over - no demand at all.
    for (const n of ["t1", "t2", "t3"]) {
      Game.creeps[n] = {
        memory: { corpId: (corp as any).id, workType: "tank" },
        body: { length: 8 },
        ticksToLive: 1400,
        room: { name: "W0N0" },
        spawning: false
      } as any;
    }
    expect(corp.getSpawnDemand({ energyCapacity: 2300, tick: 100 } as any), "at target: no demand").to.have.length(0);
  });

  it("DEATH SPIRAL (spec-26 collapse): one tender alive, fleet short, depot hoarding -> emergency pierce", () => {
    // The scheduler-wedge signature: a mustFund income demand walls the drained
    // network; one surviving tender can't drain the abundant depot fast enough
    // to fund the wall. The tender must pierce to top the fleet back up from the
    // stranded stock (proven live via the manual rescue-console bootstrap).
    const r = room({ depot: true, extensions: 40, scattered: true, depotEnergy: 61_000 });
    const corp = corpFor(r);
    Game.creeps = {
      m1: { room: { name: "W0N0" }, memory: { workType: "harvest", corpId: "mining-x" } } as any,
      t1: { room: { name: "W0N0" }, memory: { corpId: (corp as any).id, workType: "tank" }, spawning: false } as any
    };
    const demand = corp.getSpawnDemand({ energyCapacity: 2300, tick: 100 } as any);
    const sizing = (corp as any).lastSizing;
    expect(sizing.staffing, "one tender alive").to.equal(1);
    expect(sizing.target, "three coverage points on scatter").to.equal(3);
    expect(demand[0].value, "abundant stranded stock: emergency rank").to.equal(150);
    expect(demand[0].infrastructure, "pierces the mustFund wall to refill the fleet").to.equal(true);
    expect(demand[0].blocking, "still never freezes the spawn").to.equal(false);
  });

  it("no death-spiral pierce on a normal ramp: below target but depot below the abundant line", () => {
    // Same shape but modest stock (a cold-start ramp): the pierce must NOT fire,
    // or it recreates the W2N6 blocking-stream hold the high gate exists to avoid.
    const r = room({ depot: true, extensions: 40, scattered: true, depotEnergy: 800 });
    const corp = corpFor(r);
    Game.creeps = {
      m1: { room: { name: "W0N0" }, memory: { workType: "harvest", corpId: "mining-x" } } as any,
      t1: { room: { name: "W0N0" }, memory: { corpId: (corp as any).id, workType: "tank" }, spawning: false } as any
    };
    const demand = corp.getSpawnDemand({ energyCapacity: 2300, tick: 100 } as any);
    expect(demand[0].value, "modest stock: ordinary top-up priority").to.equal(96);
    expect(demand[0].infrastructure ?? false, "no wall pierce on a normal ramp").to.equal(false);
  });

  it("a DRY-depot dark post does not pierce walls either (cold start keeps its exact old ordering)", () => {
    // The unconditional lane recreated the W2N6 stream in the cold-start
    // trio: tender-fleet buys pierced the first-hauler wall three times
    // (tanker@310/369/419, hauler@498, hand-off probe red). No stranded
    // stock -> no emergency -> no pierce.
    const r = room({ depot: true, extensions: 10, depotEnergy: 0 });
    const corp = corpFor(r);
    Game.creeps = {
      m1: { room: { name: "W0N0" }, memory: { workType: "harvest", corpId: "mining-x" } } as any
    };
    const demand = corp.getSpawnDemand({ energyCapacity: 800, tick: 100 } as any);
    expect(demand[0].infrastructure ?? false).to.equal(false);
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
