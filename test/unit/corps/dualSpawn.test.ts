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

  it("counts BOTH RCL7 spawns and 100-cap extensions in the bank (not 300 + 50*N)", () => {
    // RCL7: 2 spawns (600) + 20 extensions x 100 (2000) = 2600 real bank.
    // maxCarry at 5600 cap = 25. forCoverage = ceil(2600 / (25*50)) = 3, so the
    // fleet targets 3 coverage points and each body carries ceil(2600/3/50)=18.
    // The retired hardcode read 300 + 50*20 = 1300: forCoverage 2, body 13 -
    // a fleet sized for half the real drain.
    const corp = corpFor(tenderRoom({ spawnCount: 2, extensions: 20, extCapacity: 100 }));
    const demand = corp.getSpawnDemand({ energyCapacity: 5600, tick: 100 } as any);
    const sizing = (corp as any).lastSizing;
    expect(sizing.target, "full 2600 bank -> 3 coverage points").to.equal(3);
    expect(demand[0].bodyParam, "body carries a third of the REAL bank wave").to.equal(18);
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

  it("stays identical to the old formula for a single RCL6 spawn (no regression)", () => {
    // 1 spawn (300) + 20 extensions x 50 (1000) = 1300 == old 300 + 50*20.
    const corp = corpFor(tenderRoom({ spawnCount: 1, extensions: 20, extCapacity: 50 }));
    corp.getSpawnDemand({ energyCapacity: 800, tick: 100 } as any);
    const sizing = (corp as any).lastSizing;
    // maxCarry 8, forCoverage ceil(1300/400)=4 -> target 3 (same as before).
    expect(sizing.target).to.equal(3);
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
