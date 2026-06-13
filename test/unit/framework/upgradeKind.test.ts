/**
 * UpgradingCorp ported onto the corp framework - proof ladder rungs 1-4
 * (docs/specs/00-corp-framework.md). The CONSUME solver-backed kind: its
 * commissions come from the central planner (one per controller sink), so
 * propose() returns []. The load-bearing proofs: (rung 2) the consume
 * commission now carries its serving spawn (ConsumeAssignment), and (rung 3)
 * materialize reconstructs the exact flowAdapter SinkAllocation, binds that
 * spawn, and preserves the legacy `upgrading-${room}` id. Rung 5 (combined
 * cutover) is a separate commit.
 */

import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { Position } from "../../../src/types/Position";
import { ColonyProblem, CommissionedSink, DEFAULT_SINK_VALUE } from "../../../src/economy/CorpPlanner";
import { ConsumeAssignment } from "../../../src/economy/commissionPlan";
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
import { UpgradingCorp } from "../../../src/corps/UpgradingCorp";
import { upgradeKind, sinkAllocationFromCommissioned } from "../../../src/corps/kinds/upgradeKind";
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

const world: ColonyProblem = {
  spawns: [{ id: "spawn1", pos: at(0) }],
  sources: [{ id: "srcA", nodeId: "node-A", pos: at(20), rate: 10, maxMiners: 1 }],
  sinks: [
    { id: "sink-spawn", kind: "spawn", pos: at(0), value: DEFAULT_SINK_VALUE.spawn, capacity: 4 },
    { id: "sink-ctrl", kind: "controller", pos: at(40), value: DEFAULT_SINK_VALUE.controller, capacity: 1000, reserve: 2 }
  ],
  dist: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
};

/** A hand-built CommissionedSink (controller) the way commissionsFromPlan carries it. */
const sink: CommissionedSink = {
  sinkId: "sink-ctrl",
  kind: "controller",
  value: DEFAULT_SINK_VALUE.controller,
  demand: 12,
  allocated: 9,
  sources: [{ sourceId: "source-abcd1234", amount: 9, distance: 40 }]
};

const upgradeCommission = {
  corpId: "upgrade-sink-ctrl",
  kind: "upgrade",
  shape: "consume" as const,
  consumes: { energyRate: 9, at: at(40), spawnPartsPerTick: 0 },
  produces: { valuePerTick: 9 * DEFAULT_SINK_VALUE.controller, at: at(40) },
  assignment: { sink, spawnId: "spawn1" } as ConsumeAssignment
};

function resetWorld(): void {
  installGlobals();
  Game.creeps = {};
  Game.rooms = {};
  Game.time = 12345;
  Game.getObjectById = () => null;
  (Memory as Record<string, unknown>).creeps = {};
}

describe("upgrade kind on the corp framework (rungs 2-4)", () => {
  beforeEach(() => {
    resetCorpKinds();
    resetWorld();
    registerCorpKind(upgradeKind as never);
  });
  after(() => {
    resetCorpKinds();
    resetWorld();
  });

  it("rung 2 - PLAN: the SOLVER emits the consume commission, carrying its serving spawn", () => {
    expect(upgradeKind.propose(world, [])).to.deep.equal([]);
    const { commissions } = planCommissions(world);
    const upgrade = commissions.filter(c => c.kind === "upgrade");
    expect(upgrade).to.have.length(1);
    expect(upgrade[0].shape).to.equal("consume");
    expect(upgrade[0].corpId).to.equal("upgrade-sink-ctrl");
    const a = upgrade[0].assignment as ConsumeAssignment;
    expect(a.spawnId).to.equal("spawn1"); // serving spawn carried in the commission
    expect(a.sink.kind).to.equal("controller");
  });

  it("rung 3 - BIND: reconstructs the exact flowAdapter SinkAllocation and binds the spawn", () => {
    const store: CorpStore = new Map();
    materializeCommissions([upgradeCommission], store);
    const corp = store.get("upgrade-sink-ctrl")!.corp as UpgradingCorp;
    expect(corp.getSinkAllocation()).to.deep.equal({
      sinkId: "sink-ctrl",
      sinkType: "controller",
      allocated: 9,
      demand: 12,
      unmet: 3,
      priority: DEFAULT_SINK_VALUE.controller,
      sourceFlows: [{ sourceId: "source-abcd1234", amount: 9, distance: 40 }]
    });
    expect(corp.getSpawnId()).to.equal("spawn1");
  });

  it("rung 3 - BIND: preserves the legacy `upgrading-${room}` id", () => {
    const store: CorpStore = new Map();
    materializeCommissions([upgradeCommission], store);
    const corp = store.get("upgrade-sink-ctrl")!.corp as UpgradingCorp;
    expect(corp.id).to.equal("upgrading-W1N1-upgrading");
  });

  it("rung 3 - BIND: re-materialize updates the SAME instance with a fresh allocation", () => {
    const store: CorpStore = new Map();
    materializeCommissions([upgradeCommission], store);
    const first = store.get("upgrade-sink-ctrl")!.corp;
    const updated = {
      ...upgradeCommission,
      assignment: { sink: { ...sink, allocated: 4 }, spawnId: "spawn1" } as ConsumeAssignment
    };
    materializeCommissions([updated], store);
    const second = store.get("upgrade-sink-ctrl")!.corp as UpgradingCorp;
    expect(second).to.equal(first);
    expect(second.getSinkAllocation()!.allocated).to.equal(4);
  });

  it("rung 3 - EXECUTE/PERSIST: run() never throws with no vision; store round-trips allocation", () => {
    const store: CorpStore = new Map();
    materializeCommissions([upgradeCommission], store);
    expect(() => runCommissionedCorps(store, Game.time)).to.not.throw();

    const restored = deserializeStore(JSON.parse(JSON.stringify(serializeStore(store))));
    const back = restored.get("upgrade-sink-ctrl")!.corp as UpgradingCorp;
    expect(back.id).to.equal("upgrading-W1N1-upgrading");
    expect(back.getSinkAllocation()).to.deep.equal(sinkAllocationFromCommissioned(sink));
  });

  it("rung 4 - COMPOSE: produce(10) -> transport(20) -> consume(30) run in chain order", async () => {
    const { harvestKind } = await import("../../../src/corps/kinds/harvestKind");
    const { carryKind } = await import("../../../src/corps/kinds/carryKind");
    registerCorpKind(harvestKind as never);
    registerCorpKind(carryKind as never);
    const order: string[] = [];
    const wrap = (k: { kind: string; run: (c: never, t: number) => void }) => {
      const real = k.run.bind(k);
      k.run = (c, t) => {
        order.push(k.kind);
        real(c, t);
      };
      return () => {
        k.run = real;
      };
    };
    const restores = [upgradeKind, harvestKind, carryKind].map(k => wrap(k as never));
    try {
      const store: CorpStore = new Map();
      materializeCommissions(
        [
          upgradeCommission,
          {
            corpId: "harvest-source-abcd1234",
            kind: "harvest",
            shape: "produce",
            consumes: { spawnPartsPerTick: 0.3 },
            produces: { energyRate: 10, at: at(20) },
            assignment: { sourceId: "source-abcd1234", nodeId: "node-A", spawnId: "spawn-game1", distance: 20, rate: 10, spawnParts: 0.3, netEnergy: 9, efficiency: 90, maxMiners: 1 }
          },
          {
            corpId: "carry-source-abcd1234",
            kind: "carry",
            shape: "transport",
            consumes: { energyRate: 10, at: at(20), spawnPartsPerTick: 1.1 },
            produces: { energyRate: 10 },
            assignment: [{ sourceId: "source-abcd1234", sinkId: "sink-ctrl", spawnId: "spawn-game1", distance: 40, flowRate: 9, carryParts: 10, spawnParts: 0.7 }]
          }
        ],
        store
      );
      runCommissionedCorps(store, Game.time);
    } finally {
      restores.forEach(r => r());
    }
    expect(order).to.deep.equal(["harvest", "carry", "upgrade"]);
  });
});

describe("upgrade kind rung 1", () => {
  beforeEach(resetWorld);
  describeCorpKindConformance(upgradeKind as never, {
    problem: world,
    commission: upgradeCommission,
    expectedSpawnPartsPerTick: 0 // consumer build-time not yet budgeted by the solver
  });
});
