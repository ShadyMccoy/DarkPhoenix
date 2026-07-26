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
 *   2. Consumers (upgraders/builders) bind to the NEAREST same-room spawn, so
 *      both/all spawns build consumer bodies instead of every consumer piling
 *      onto spawn[0].
 *   3. SpawnDirector.collectDemands partitions demand by spawn: with two spawns
 *      each sees only its own corps' demands (no cross-feed, no double-count).
 */

import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game } from "../mock";
import { ExtensionTenderCorp } from "../../../src/corps/ExtensionTenderCorp";
import { planColony, ColonyProblem, PlannerSource, PlannerSink, PlannerSpawn } from "../../../src/economy/CorpPlanner";
import { commissionsFromPlan, ConsumeAssignment } from "../../../src/economy/commissionPlan";
import { createCorpRegistry } from "../../../src/execution/CorpRunner";
import { collectDemands } from "../../../src/execution/SpawnDirector";
import { resetCommissionHost, seedCommissionStoreForTest } from "../../../src/execution/CommissionHost";
import { SpawnDemand, SpawnDemandContext } from "../../../src/spawn/SpawnScheduler";

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
// 2. Consumers bind to the NEAREST same-room spawn
// ===========================================================================

describe("dual/tri-spawn: consumers bind to the nearest same-room spawn", () => {
  const ROOM = "W0N0";
  const at = (x: number): { x: number; y: number; roomName: string } => ({ x, y: 0, roomName: ROOM });
  const manhattan = (a: any, b: any): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const spawn = (id: string, x: number): PlannerSpawn => ({ id, pos: at(x) });
  const source = (id: string, x: number, rate = 10): PlannerSource => ({
    id,
    nodeId: `node-${id}`,
    pos: at(x),
    rate,
    maxMiners: 1
  });
  const sink = (id: string, kind: PlannerSink["kind"], x: number, value: number, capacity: number): PlannerSink => ({
    id,
    kind,
    pos: at(x),
    value,
    capacity
  });
  const problem = (p: Partial<ColonyProblem> & Pick<ColonyProblem, "spawns" | "sources" | "sinks">): ColonyProblem => ({
    dist: manhattan,
    ...p
  });

  function upgradeSpawnId(prob: ColonyProblem): string | null {
    const plan = planColony(prob);
    const commissions = commissionsFromPlan(prob, plan);
    const upgrade = commissions.find(c => c.shape === "consume" && c.kind === "upgrade");
    expect(upgrade, "an upgrade consume commission was produced").to.not.equal(undefined);
    return (upgrade!.assignment as ConsumeAssignment).spawnId;
  }

  it("TWO spawns: the controller's upgraders spawn from the spawn nearest the controller", () => {
    // Spawns A@0 and B@100 share the room; the controller sits at 90 (d=10 to
    // B, 90 to A). The pre-fix `spawns.find(sameRoom)` returned A (first), so
    // every upgrader walked in from across the room and spawn B never built one.
    const id = upgradeSpawnId(
      problem({
        spawns: [spawn("A", 0), spawn("B", 100)],
        sources: [source("s", 95)],
        sinks: [sink("ctrl", "controller", 90, 50, 1000)]
      })
    );
    expect(id).to.equal("B");
  });

  it("THREE spawns (RCL8): binds to the closest of the three", () => {
    const id = upgradeSpawnId(
      problem({
        spawns: [spawn("A", 0), spawn("B", 50), spawn("C", 100)],
        sources: [source("s", 95)],
        sinks: [sink("ctrl", "controller", 95, 50, 1000)]
      })
    );
    expect(id).to.equal("C");
  });

  it("still binds the sole spawn when the room has one (no regression)", () => {
    const id = upgradeSpawnId(
      problem({
        spawns: [spawn("S", 0)],
        sources: [source("s", 20)],
        sinks: [sink("ctrl", "controller", 10, 50, 1000)]
      })
    );
    expect(id).to.equal("S");
  });
});

// ===========================================================================
// 3. collectDemands partitions demand across the two spawns
// ===========================================================================

describe("dual-spawn: SpawnDirector.collectDemands partitions demand by spawn", () => {
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

  it("each spawn sees only the corps bound to it - no cross-feed, no double-count", () => {
    // Two tender corps, one per spawn in a 2-spawn room. Each corp's demand
    // must appear at ITS spawn and NOWHERE else, or the second spawn either
    // starves (never asked) or double-buys (both spawns build the same corp's
    // creep). Patch getSpawnDemand so this pins ONLY the spawn partitioning.
    const tenderA = new ExtensionTenderCorp(`${ROOM}-tenderA`, "spawnA");
    const tenderB = new ExtensionTenderCorp(`${ROOM}-tenderB`, "spawnB");
    (tenderA as any).getSpawnDemand = () => [canned(tenderA.id)];
    (tenderB as any).getSpawnDemand = () => [canned(tenderB.id)];
    seedCommissionStoreForTest(`tender-${ROOM}-A`, "tender", tenderA);
    seedCommissionStoreForTest(`tender-${ROOM}-B`, "tender", tenderB);

    const registry = createCorpRegistry();
    const atA = collectDemands(registry, "spawnA", CTX);
    const atB = collectDemands(registry, "spawnB", CTX);

    expect(atA.map(d => d.buyerCorpId)).to.deep.equal([tenderA.id]);
    expect(atB.map(d => d.buyerCorpId)).to.deep.equal([tenderB.id]);
  });
});
