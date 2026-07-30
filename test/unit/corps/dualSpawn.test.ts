/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * DUAL / TRI-SPAWN assumptions (RCL7 = 2 spawns, RCL8 = 3 spawns).
 *
 * A room stays single-spawn from RCL1 through RCL6, so a pile of code grew up
 * assuming "the spawn" (singular) and "50 energy per extension". At RCL7 the
 * room gains a SECOND spawn and 100-cap extensions; at RCL8 a THIRD and 200-cap.
 * These tests pin the cross-cutting places those assumptions surface, so the
 * N-spawn / any-RCL generalizations don't silently regress:
 *
 *   1. ExtensionTenderCorp sizes its refill fleet from the WHOLE bank - every
 *      spawn's 300 plus each extension's real capacity - not `300 + 50*N`.
 *   2. Spawn distribution is POOLED, not per-spawn: the SpawnDirector collects
 *      a room's whole demand pool across ALL its spawns (not one spawn's slice),
 *      and assigns each buy to the free spawn nearest that demand's work site -
 *      so two spawns self-balance across two distinct demands per tick instead
 *      of spawn[0] owning every consumer.
 */

import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game } from "../mock";
import { ExtensionTenderCorp } from "../../../src/corps/ExtensionTenderCorp";
import { HarvestCorp } from "../../../src/corps/HarvestCorp";
import { createCorpRegistry } from "../../../src/execution/CorpRunner";
import { collectDemands, collectDemandsMatching, pickNearestSpawn } from "../../../src/execution/SpawnDirector";
import { resetCommissionHost, seedCommissionStoreForTest } from "../../../src/execution/CommissionHost";
import { SpawnDemand, SpawnDemandContext } from "../../../src/spawn/SpawnScheduler";
import { Position } from "../../../src/types/Position";

const FIND_MY_SPAWNS = 112;
const FIND_STRUCTURES = 107;
const FIND_MY_STRUCTURES = 108;

// ===========================================================================
// 1. ExtensionTenderCorp: fleet sized from the ACTUAL bank (N spawns, RCL cap)
// ===========================================================================

/**
 * A tender room with `spawnCount` spawns (300 cap each) and `extensions`
 * extensions of `extCapacity` each, packed tight so extensionClusters() reads
 * a single spatial cluster (the fleet target then follows bank COVERAGE, not
 * layout). A stocked depot container sits by the first spawn.
 */
function tenderRoom(opts: { spawnCount: number; extensions: number; extCapacity: number }): {
  room: any;
  boundSpawnId: string;
} {
  const depot = { structureType: "container", pos: { x: 24, y: 25 }, store: { energy: 2000 } };
  const spawns = Array.from({ length: opts.spawnCount }, (_, i) => ({
    id: `spawn${i}`,
    pos: {
      x: 25 + i,
      y: 25,
      roomName: "W0N0",
      findInRange: (type: number) => (type === FIND_STRUCTURES ? [depot] : [])
    },
    structureType: "spawn",
    store: { getFreeCapacity: () => 0, getCapacity: () => 300 }
  }));
  // Tight block: 8 per row starting at (18,22), spawns at y25 - everything
  // chains within CLUSTER_LINK_RANGE (4), so extensionClusters() -> 1 cluster.
  const extensions = Array.from({ length: opts.extensions }, (_, i) => ({
    structureType: "extension",
    pos: { x: 18 + (i % 8), y: 22 + Math.floor(i / 8), roomName: "W0N0" },
    store: { getFreeCapacity: () => opts.extCapacity, getCapacity: () => opts.extCapacity }
  }));
  const room: any = {
    name: "W0N0",
    memory: {},
    find: (type: number, o?: any) => {
      if (type === FIND_MY_SPAWNS) return spawns;
      if (type === FIND_MY_STRUCTURES) {
        const all = [...spawns, ...extensions];
        return o?.filter ? all.filter(o.filter) : all;
      }
      return [];
    },
    _spawns: spawns
  };
  return { room, boundSpawnId: "spawn0" };
}

describe("dual/tri-spawn: ExtensionTenderCorp sizes from the whole bank", () => {
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
  afterEach(() => {
    Game.getObjectById = () => null;
    Game.creeps = {};
  });

  function corpFor(r: { room: any; boundSpawnId: string }): ExtensionTenderCorp {
    Game.getObjectById = (id: string) =>
      (id === r.boundSpawnId ? { ...r.room._spawns[0], room: r.room } : null) as any;
    Game.creeps = {
      m1: { room: { name: "W0N0" }, memory: { workType: "harvest", corpId: "mining-x" } } as any
    };
    return new ExtensionTenderCorp("W0N0-tender", r.boundSpawnId);
  }

  it("counts BOTH RCL7 spawns and 100-cap extensions (not 300 + 50*N), now RATE-MATCHED", () => {
    // RCL7: 2 spawns (600) + 20 extensions x 100 (2000) = 2600 real bank, and
    // the per-slot body still divides that REAL wave (the retired hardcode read
    // 300 + 50*20 = 1300 and sized a fleet for half the real drain).
    //
    // The COUNT is no longer "refill the whole bank in one trip" - owner
    // 2026-07-29 rate-matched it to what the spawns can actually consume:
    // 2 spawns want ~66.7 e/t, a 25-carry tender over 100-cap extensions
    // sustains ~53 e/t, so TWO tenders cover it (the old formula asked for 3).
    const corp = corpFor(tenderRoom({ spawnCount: 2, extensions: 20, extCapacity: 100 }));
    const demand = corp.getSpawnDemand({ energyCapacity: 5600, tick: 100 } as any);
    const sizing = (corp as any).lastSizing;
    expect(sizing.target, "2 spawns' appetite / one tender's rate").to.equal(2);
    expect(demand[0].bodyParam, "body still sized from the REAL bank wave").to.equal(25);
  });

  it("needs MORE tenders on 50-cap extensions than 100-cap ones (capacity is throughput)", () => {
    // The owner's third point as a live pin: thinner extensions cap each
    // transfer, lengthening the unload leg, so the same appetite needs more
    // creeps. Same spawn count, same bank shape - only capacity differs.
    const fat = corpFor(tenderRoom({ spawnCount: 2, extensions: 20, extCapacity: 100 }));
    fat.getSpawnDemand({ energyCapacity: 5600, tick: 100 } as any);
    const thin = corpFor(tenderRoom({ spawnCount: 2, extensions: 40, extCapacity: 50 }));
    thin.getSpawnDemand({ energyCapacity: 5600, tick: 100 } as any);
    expect((thin as any).lastSizing.target).to.be.at.least((fat as any).lastSizing.target);
  });

  it("counts ALL THREE RCL8 spawns and 200-cap extensions", () => {
    // RCL8: 3 spawns (900) + 10 extensions x 200 (2000) = 2900 real bank.
    // maxCarry at 800 cap = 8. forCoverage = ceil(2900/(8*50)) = 8 -> target
    // caps at 3; body = ceil(2900/3/50) capped at 8 = 8. The hardcode read
    // 300 + 50*10 = 800: forCoverage 2, target 2 - it dropped the two extra
    // spawns AND the 200-cap extensions.
    const corp = corpFor(tenderRoom({ spawnCount: 3, extensions: 10, extCapacity: 200 }));
    corp.getSpawnDemand({ energyCapacity: 800, tick: 100 } as any);
    const sizing = (corp as any).lastSizing;
    expect(sizing.target, "2900 bank over 400-carry bodies -> 3 (capped) coverage points").to.equal(3);
  });

  it("reads the same REAL bank as the old hardcode for a single RCL6 spawn", () => {
    // 1 spawn (300) + 20 extensions x 50 (1000) = 1300 == old 300 + 50*20, so
    // the BANK read is unchanged here. The COUNT is now rate-matched (owner
    // 2026-07-29): one spawn wants ~33 e/t and an 8-carry tender over 50-cap
    // extensions sustains ~21 e/t, so TWO cover it where the retired
    // one-trip-refill formula asked for three.
    const corp = corpFor(tenderRoom({ spawnCount: 1, extensions: 20, extCapacity: 50 }));
    corp.getSpawnDemand({ energyCapacity: 800, tick: 100 } as any);
    const sizing = (corp as any).lastSizing;
    expect(sizing.target).to.equal(2);
  });

  it("COLD START keeps its 3-tender floor (the RCL2-3 lost-deadline incident)", () => {
    // Measured incident (pipeline t=1553): at RCL2-3 "the lone tender's second
    // trip lost the deadline" while a big miner drained 650+ into the spawn.
    // Rate-matching must NOT weaken that: a 550-cap room affords only a
    // 5-carry tender (~16 e/t over 50-cap extensions) against the same ~33 e/t
    // appetite, so the model still demands three. Pinned explicitly rather
    // than trusted.
    const corp = corpFor(tenderRoom({ spawnCount: 1, extensions: 5, extCapacity: 50 }));
    corp.getSpawnDemand({ energyCapacity: 550, tick: 100 } as any);
    expect((corp as any).lastSizing.target).to.equal(3);
  });
});

// ===========================================================================
// 2a. The demand pool spans the whole room, not one spawn
// ===========================================================================

describe("dual-spawn: the SpawnDirector pools a room's demand across its spawns", () => {
  const ROOM = "W1N1";
  const CTX: SpawnDemandContext = { energyCapacity: 5600, tick: 100 };

  beforeEach(() => {
    setupGlobals();
    resetCommissionHost();
  });
  afterEach(() => resetCommissionHost());

  function canned(buyerCorpId: string): SpawnDemand {
    return { buyerCorpId, role: "tanker", value: 90, blocking: false, producesIncome: false, desiredCost: 300, minCost: 200, since: 0 };
  }

  it("collectDemandsMatching gathers demand from EVERY spawn in the room's pool", () => {
    // Two corps anchored to different spawns of the same room. The pool (the
    // room's whole spawn set) must surface BOTH - distribution is no longer
    // pinned to one spawn - while the single-spawn view still slices to one.
    const tenderA = new ExtensionTenderCorp(`${ROOM}-tenderA`, "spawnA");
    const tenderB = new ExtensionTenderCorp(`${ROOM}-tenderB`, "spawnB");
    (tenderA as any).getSpawnDemand = () => [canned(tenderA.id)];
    (tenderB as any).getSpawnDemand = () => [canned(tenderB.id)];
    seedCommissionStoreForTest(`tender-${ROOM}-A`, "tender", tenderA);
    seedCommissionStoreForTest(`tender-${ROOM}-B`, "tender", tenderB);
    createCorpRegistry();

    const roomSpawns = new Set(["spawnA", "spawnB"]);
    const pool = collectDemandsMatching(id => roomSpawns.has(id), CTX);
    expect(pool.map(d => d.buyerCorpId).sort()).to.deep.equal([tenderA.id, tenderB.id].sort());

    // The per-spawn view (a building block, used by the decision harness) still
    // slices the pool to a single spawn - the pool is the union of these.
    expect(collectDemands(createCorpRegistry(), "spawnA", CTX).map(d => d.buyerCorpId)).to.deep.equal([tenderA.id]);
    expect(collectDemands(createCorpRegistry(), "spawnB", CTX).map(d => d.buyerCorpId)).to.deep.equal([tenderB.id]);
  });
});

// ===========================================================================
// 2b. Each buy goes to the free spawn nearest its work site (distance term)
// ===========================================================================

describe("dual/tri-spawn: pickNearestSpawn assigns a buy to the nearest free spawn", () => {
  const spawnAt = (id: string, x: number, y: number, roomName = "W0N0"): any => ({
    id,
    pos: { x, y, roomName }
  });
  const pos = (x: number, y: number, roomName = "W0N0"): Position => ({ x, y, roomName });

  it("TWO spawns: the controller-side spawn takes a controller-side demand", () => {
    // Spawn1 by the sources (5,25), Spawn2 by the controller (44,40). An
    // upgrader's work site is the controller (44,42) -> Spawn2 is nearest, so
    // the pool builds the upgrader THERE, not across the room at Spawn1.
    const s1 = spawnAt("s1", 5, 25);
    const s2 = spawnAt("s2", 44, 40);
    expect(pickNearestSpawn([s1, s2], pos(44, 42)).id).to.equal("s2");
    // ...and a source-side demand (a miner at 8,25) goes to Spawn1.
    expect(pickNearestSpawn([s1, s2], pos(8, 25)).id).to.equal("s1");
  });

  it("THREE spawns (RCL8): picks the closest of the three", () => {
    const spawns = [spawnAt("a", 5, 5), spawnAt("b", 25, 25), spawnAt("c", 45, 45)];
    expect(pickNearestSpawn(spawns, pos(24, 26)).id).to.equal("b");
  });

  it("prefers an in-room spawn over one in another room", () => {
    const home = spawnAt("home", 40, 40, "W0N0");
    const other = spawnAt("other", 1, 1, "W1N1");
    // Work in W0N0 near neither exact tile: the same-room spawn still wins over
    // the cross-room one (room-distance penalty dominates raw tile distance).
    expect(pickNearestSpawn([other, home], pos(10, 10, "W0N0")).id).to.equal("home");
  });

  it("keeps the first spawn when the demand has no resolvable work site", () => {
    const s1 = spawnAt("s1", 5, 25);
    const s2 = spawnAt("s2", 44, 40);
    expect(pickNearestSpawn([s1, s2], undefined).id).to.equal("s1");
  });
});

// ===========================================================================
// 2c. Cross-room PRODUCTION: a home room's pool builds the workforce for
//     OTHER rooms (mine room B, deliver to room C, spawned from room A).
//     This is distinct from a cross-room EXTENSION-energy pool (not wanted):
//     the ENERGY bank stays per-room, but PRODUCTION is global - a corp is
//     collected by its home SPAWN anchor, wherever its work happens to be.
// ===========================================================================

describe("cross-room production: the home pool builds the workforce for other rooms", () => {
  const HOME = "W1N1";
  const REMOTE = "W1N2";
  const CTX: SpawnDemandContext = { energyCapacity: 5600, tick: 100 };

  beforeEach(() => {
    setupGlobals();
    resetCommissionHost();
    (Game as any).getObjectById = () => null; // force HarvestCorp.getPosition down the intel-parse path
  });
  afterEach(() => resetCommissionHost());

  function canned(buyerCorpId: string): SpawnDemand {
    return { buyerCorpId, role: "miner", value: 140, blocking: true, producesIncome: true, desiredCost: 550, minCost: 300, since: 0 };
  }

  it("collects a home-anchored miner whose SOURCE is in another room (mine B, spawn from A)", () => {
    // Miner anchored to a HOME spawn but working a source in the REMOTE room -
    // exactly "room A spawns a miner that mines room B". The pool is keyed by
    // the spawn ANCHOR, not the work site, so the home room builds it.
    const miner = new HarvestCorp(`${HOME}-mining-remote`, "homeSpawn1", `intel-${REMOTE}-25-25`);
    (miner as any).getSpawnDemand = () => [canned(miner.id)];
    seedCommissionStoreForTest(`harvest-${REMOTE}-src`, "harvest", miner);
    createCorpRegistry();

    // The corp's WORK is remote, its ANCHOR is home.
    expect(miner.getPosition().roomName, "works the remote room").to.equal(REMOTE);
    expect(miner.getSpawnId(), "anchored to a home spawn").to.equal("homeSpawn1");

    const homeSpawns = new Set(["homeSpawn1", "homeSpawn2"]);
    const pool = collectDemandsMatching(id => homeSpawns.has(id), CTX);
    expect(pool.map(d => d.buyerCorpId)).to.deep.equal([miner.id]);
  });

  it("routes the remote miner to a HOME spawn (built at home, not stranded)", () => {
    const miner = new HarvestCorp(`${HOME}-mining-remote`, "homeSpawn1", `intel-${REMOTE}-25-25`);
    const home1 = { id: "homeSpawn1", pos: { x: 10, y: 25, roomName: HOME } } as any;
    const home2 = { id: "homeSpawn2", pos: { x: 40, y: 25, roomName: HOME } } as any;
    // Both home spawns are cross-room to the remote work, so either is a valid
    // builder; the point is the creep is produced AT HOME, never stranded for
    // want of a spawn in the (spawnless) remote room.
    expect(pickNearestSpawn([home1, home2], miner.getPosition()).pos.roomName).to.equal(HOME);
  });
});
