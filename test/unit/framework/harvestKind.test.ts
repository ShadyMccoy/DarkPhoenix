/**
 * HarvestCorp ported onto the corp framework - proof ladder rungs 1-4
 * (docs/specs/00-corp-framework.md). The FIRST solver-backed kind: its
 * commissions come from the central planner (commissionsFromPlan), not from
 * propose(), so the interesting proofs are (rung 2) that the planner's harvest
 * commission carries a CommissionedMiner the kind can bind, and (rung 3) that
 * materialize reconstructs the exact MinerAssignment the live flowAdapter
 * produces AND preserves the legacy runtime corp id. Rung 5 (live cutover) is
 * a separate commit.
 */

import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { Position } from "../../../src/types/Position";
import { ColonyProblem, CommissionedMiner, DEFAULT_SINK_VALUE } from "../../../src/economy/CorpPlanner";
import { minerOverhead } from "../../../src/economy/primitives";
import {
  CorpStore,
  deserializeStore,
  materializeCommissions,
  registerCorpKind,
  resetCorpKinds,
  runCommissionedCorps,
  serializeStore
} from "../../../src/economy/CorpKind";
import { planCommissions } from "../../../src/economy/commissionPlan";
import { HarvestCorp } from "../../../src/corps/HarvestCorp";
import { harvestKind, minerAssignmentFromCommissioned } from "../../../src/corps/kinds/harvestKind";
import { describeCorpKindConformance } from "./conformance";

const ROOM = "W1N1";

function installGlobals(): void {
  setupGlobals();
  (Game as { map: unknown }).map = { getRoomTerrain: () => ({ get: () => 0 }) };
  const g = global as unknown as Record<string, unknown>;
  g.WORK = "work";
  g.MOVE = "move";
  g.CARRY = "carry";
}
installGlobals();

const at = (x: number, y = 25): Position => ({ x, y, roomName: ROOM });

/** A world with one spawn, one source 20 away, a spawn sink and a controller. */
const world: ColonyProblem = {
  spawns: [{ id: "spawn1", pos: at(0) }],
  sources: [{ id: "srcA", nodeId: "node-A", pos: at(20), rate: 10, maxMiners: 1 }],
  sinks: [
    { id: "sink-spawn", kind: "spawn", pos: at(0), value: DEFAULT_SINK_VALUE.spawn, capacity: 4 },
    { id: "sink-ctrl", kind: "controller", pos: at(40), value: DEFAULT_SINK_VALUE.controller, capacity: 1000, reserve: 2 }
  ],
  dist: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
};

/** A hand-built CommissionedMiner, the kind of payload commissionsFromPlan carries. */
const miner: CommissionedMiner = {
  sourceId: "abcd1234",
  nodeId: "node-A",
  spawnId: "spawn-game1", // flow-prefixed, as the planner emits
  distance: 20,
  rate: 10,
  spawnParts: 0.3,
  netEnergy: 9,
  efficiency: 90,
  maxMiners: 1
};

const harvestCommission = {
  corpId: "harvest-abcd1234",
  kind: "harvest",
  shape: "produce" as const,
  consumes: { spawnPartsPerTick: miner.spawnParts },
  produces: { energyRate: 10, at: at(20) },
  assignment: miner
};

function resetWorld(): void {
  installGlobals();
  Game.creeps = {};
  Game.rooms = {};
  Game.time = 12345;
  Game.getObjectById = () => null;
  (Memory as Record<string, unknown>).creeps = {};
}

describe("harvest kind on the corp framework (rungs 2-4)", () => {
  beforeEach(() => {
    resetCorpKinds();
    resetWorld();
    registerCorpKind(harvestKind as never);
  });
  after(() => {
    resetCorpKinds();
    resetWorld();
  });

  it("rung 2 - PLAN: the SOLVER (not propose) emits the harvest commission; the kind proposes none", () => {
    expect(harvestKind.propose(world, [])).to.deep.equal([]);
    const { commissions } = planCommissions(world);
    const harvest = commissions.filter(c => c.kind === "harvest");
    expect(harvest).to.have.length(1);
    expect(harvest[0].shape).to.equal("produce");
    expect(harvest[0].corpId).to.equal("harvest-srcA");
    // economics carried through from the planner (no private formula)
    const m = harvest[0].assignment as CommissionedMiner;
    expect(harvest[0].consumes.spawnPartsPerTick).to.be.closeTo(m.spawnParts, 1e-9);
    expect(harvest[0].produces.energyRate).to.be.greaterThan(0);
  });

  it("rung 3 - BIND: reconstructs the exact flowAdapter MinerAssignment", () => {
    const store: CorpStore = new Map();
    materializeCommissions([harvestCommission], store);
    const corp = store.get("harvest-abcd1234")!.corp as HarvestCorp;
    const got = corp.getMinerAssignment();
    expect(got).to.deep.equal({
      sourceId: "abcd1234",
      nodeId: "node-A",
      spawnId: "spawn-game1",
      spawnDistance: 20,
      harvestRate: 10,
      spawnCostPerTick: minerOverhead(20),
      maxMiners: 1,
      efficiency: 90
    });
  });

  it("rung 3 - BIND: preserves the legacy runtime corp id (live miners stay attached)", () => {
    const store: CorpStore = new Map();
    materializeCommissions([harvestCommission], store);
    const corp = store.get("harvest-abcd1234")!.corp as HarvestCorp;
    // mining-${roomName}-harvest-${sourceId.slice(-4)} - what createHarvestCorp/
    // FlowMaterializer generate, so memory.corpId still resolves post-port.
    expect(corp.id).to.equal("mining-W1N1-harvest-1234");
    // setMinerAssignment strips the flow "spawn-" prefix to the real game id
    expect(corp.getSpawnId()).to.equal("game1");
  });

  it("rung 3 - BIND: re-materialize updates the SAME instance with a fresh assignment", () => {
    const store: CorpStore = new Map();
    materializeCommissions([harvestCommission], store);
    const first = store.get("harvest-abcd1234")!.corp;
    const updated = { ...harvestCommission, assignment: { ...miner, rate: 8, efficiency: 80 } };
    materializeCommissions([updated], store);
    const second = store.get("harvest-abcd1234")!.corp as HarvestCorp;
    expect(second).to.equal(first);
    expect(second.getMinerAssignment()!.harvestRate).to.equal(8);
  });

  it("rung 3 - EXECUTE/PERSIST: run() never throws with no vision; store round-trips with assignment", () => {
    const store: CorpStore = new Map();
    materializeCommissions([harvestCommission], store);
    expect(() => runCommissionedCorps(store, Game.time)).to.not.throw();

    const restored = deserializeStore(JSON.parse(JSON.stringify(serializeStore(store))));
    const back = restored.get("harvest-abcd1234")!.corp as HarvestCorp;
    expect(back.id).to.equal("mining-W1N1-harvest-1234");
    expect(back.getMinerAssignment()).to.deep.equal(
      minerAssignmentFromCommissioned(miner)
    );
  });

  it("rung 4 - COMPOSE: harvest (runOrder 10) runs before an auxiliary (runOrder 40)", async () => {
    const { scoutKind } = await import("../../../src/corps/kinds/scoutKind");
    registerCorpKind(scoutKind as never);
    const order: string[] = [];
    const realHarvest = harvestKind.run.bind(harvestKind);
    const realScout = scoutKind.run.bind(scoutKind);
    (harvestKind as { run: typeof harvestKind.run }).run = (c, t) => {
      order.push("harvest");
      realHarvest(c, t);
    };
    (scoutKind as { run: typeof scoutKind.run }).run = (c, t) => {
      order.push("scout");
      realScout(c, t);
    };
    try {
      const store: CorpStore = new Map();
      materializeCommissions(
        [
          harvestCommission,
          {
            corpId: "scout-W1N1",
            kind: "scout",
            shape: "auxiliary",
            consumes: { spawnPartsPerTick: 0 },
            produces: { valuePerTick: 0 },
            assignment: { roomName: ROOM, spawnId: "spawn1" }
          }
        ],
        store
      );
      runCommissionedCorps(store, Game.time);
    } finally {
      (harvestKind as { run: typeof harvestKind.run }).run = realHarvest;
      (scoutKind as { run: typeof scoutKind.run }).run = realScout;
    }
    expect(order).to.deep.equal(["harvest", "scout"]);
  });
});

describe("harvest kind rung 1", () => {
  beforeEach(resetWorld);
  describeCorpKindConformance(harvestKind as never, {
    problem: world,
    commission: harvestCommission
    // expectedSpawnPartsPerTick omitted: a producer's build-time is set by the
    // planner (carried in the commission), not derived by the kind - the rung-2
    // test asserts the planner's value flows through.
  });
});
