/**
 * CarryCorp ported onto the corp framework - proof ladder rungs 1-4
 * (docs/specs/00-corp-framework.md). The TRANSPORT solver-backed kind: its
 * commissions come from the central planner (one per source, aggregating that
 * source's routes), so propose() returns []. The load-bearing proof is rung 3:
 * materialize reconstructs the exact flowAdapter HaulerAssignment[] and the
 * legacy `hauling-${room}-hauling-${suffix}` id. Rung 5 (combined cutover) is
 * a separate commit.
 */

import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { Position } from "../../../src/types/Position";
import { ColonyProblem, CommissionedHauler, DEFAULT_SINK_VALUE } from "../../../src/economy/CorpPlanner";
import { haulerOverhead } from "../../../src/economy/primitives";
import { createEdgeId } from "../../../src/flow/FlowTypes";
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
import { CarryCorp } from "../../../src/corps/CarryCorp";
import { carryKind, haulerAssignmentFromCommissioned } from "../../../src/corps/kinds/carryKind";
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

/** Two hand-built routes for one source (spawn + controller), as the planner emits. */
const routes: CommissionedHauler[] = [
  { sourceId: "source-abcd1234", sinkId: "spawn-game1", spawnId: "spawn-game1", distance: 20, flowRate: 4, carryParts: 6, spawnParts: 0.4 },
  { sourceId: "source-abcd1234", sinkId: "ctrl-9", spawnId: "spawn-game1", distance: 40, flowRate: 6, carryParts: 10, spawnParts: 0.7 }
];

const carryCommission = {
  corpId: "carry-source-abcd1234",
  kind: "carry",
  shape: "transport" as const,
  consumes: { energyRate: 10, at: at(20), spawnPartsPerTick: 1.1 },
  produces: { energyRate: 10 },
  assignment: routes
};

function resetWorld(): void {
  installGlobals();
  Game.creeps = {};
  Game.rooms = {};
  Game.time = 12345;
  Game.getObjectById = () => null;
  (Memory as Record<string, unknown>).creeps = {};
}

describe("carry kind on the corp framework (rungs 2-4)", () => {
  beforeEach(() => {
    resetCorpKinds();
    resetWorld();
    registerCorpKind(carryKind as never);
  });
  after(() => {
    resetCorpKinds();
    resetWorld();
  });

  it("rung 2 - PLAN: the SOLVER (not propose) emits the carry commission; the kind proposes none", () => {
    expect(carryKind.propose(world, [])).to.deep.equal([]);
    const { commissions } = planCommissions(world);
    const carry = commissions.filter(c => c.kind === "carry");
    expect(carry).to.have.length(1);
    expect(carry[0].shape).to.equal("transport");
    expect(carry[0].corpId).to.equal("carry-srcA");
    expect(Array.isArray(carry[0].assignment)).to.equal(true);
    expect((carry[0].assignment as CommissionedHauler[]).length).to.be.greaterThan(0);
  });

  it("rung 3 - BIND: reconstructs the exact flowAdapter HaulerAssignment[]", () => {
    const store: CorpStore = new Map();
    materializeCommissions([carryCommission], store);
    const corp = store.get("carry-source-abcd1234")!.corp as CarryCorp;
    const got = corp.getHaulerAssignments();
    expect(got).to.have.length(2);
    expect(got[0]).to.deep.equal({
      edgeId: createEdgeId("source-abcd1234", "spawn-game1"),
      fromId: "source-abcd1234",
      toId: "spawn-game1",
      distance: 20,
      carryParts: 6,
      flowRate: 4,
      spawnCostPerTick: haulerOverhead(6, 20),
      spawnId: "spawn-game1"
    });
    expect(got[1].toId).to.equal("ctrl-9");
    expect(got[1].spawnCostPerTick).to.be.closeTo(haulerOverhead(10, 40), 1e-9);
  });

  it("rung 3 - BIND: preserves the legacy id and strips the spawn prefix", () => {
    const store: CorpStore = new Map();
    materializeCommissions([carryCommission], store);
    const corp = store.get("carry-source-abcd1234")!.corp as CarryCorp;
    // hauling-${room}-hauling-${sourceId.slice(-4)} - FlowMaterializer's format
    expect(corp.id).to.equal("hauling-W1N1-hauling-1234");
    expect(corp.getSpawnId()).to.equal("game1"); // "spawn-" stripped
  });

  it("rung 3 - BIND: re-materialize updates the SAME instance with fresh routes", () => {
    const store: CorpStore = new Map();
    materializeCommissions([carryCommission], store);
    const first = store.get("carry-source-abcd1234")!.corp;
    const updated = {
      ...carryCommission,
      assignment: [{ ...routes[0], flowRate: 9, carryParts: 12 }]
    };
    materializeCommissions([updated], store);
    const second = store.get("carry-source-abcd1234")!.corp as CarryCorp;
    expect(second).to.equal(first);
    expect(second.getHaulerAssignments()).to.have.length(1);
    expect(second.getHaulerAssignments()[0].flowRate).to.equal(9);
  });

  it("rung 3 - EXECUTE/PERSIST: run() never throws with no vision; store round-trips routes", () => {
    const store: CorpStore = new Map();
    materializeCommissions([carryCommission], store);
    expect(() => runCommissionedCorps(store, Game.time)).to.not.throw();

    const restored = deserializeStore(JSON.parse(JSON.stringify(serializeStore(store))));
    const back = restored.get("carry-source-abcd1234")!.corp as CarryCorp;
    expect(back.id).to.equal("hauling-W1N1-hauling-1234");
    expect(back.getHaulerAssignments()).to.deep.equal(routes.map(haulerAssignmentFromCommissioned));
  });

  it("rung 4 - COMPOSE: produce(10) -> transport(20) -> auxiliary(40) run in order", async () => {
    const { harvestKind } = await import("../../../src/corps/kinds/harvestKind");
    const { scoutKind } = await import("../../../src/corps/kinds/scoutKind");
    registerCorpKind(harvestKind as never);
    registerCorpKind(scoutKind as never);
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
    const restores = [carryKind, harvestKind, scoutKind].map(k => wrap(k as never));
    try {
      const store: CorpStore = new Map();
      materializeCommissions(
        [
          carryCommission,
          {
            corpId: "harvest-source-abcd1234",
            kind: "harvest",
            shape: "produce",
            consumes: { spawnPartsPerTick: 0.3 },
            produces: { energyRate: 10, at: at(20) },
            assignment: { sourceId: "source-abcd1234", nodeId: "node-A", spawnId: "spawn-game1", distance: 20, rate: 10, spawnParts: 0.3, netEnergy: 9, efficiency: 90, maxMiners: 1 }
          },
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
      restores.forEach(r => r());
    }
    expect(order).to.deep.equal(["harvest", "carry", "scout"]);
  });
});

describe("carry kind rung 1", () => {
  beforeEach(resetWorld);
  describeCorpKindConformance(carryKind as never, {
    problem: world,
    commission: carryCommission
    // expectedSpawnPartsPerTick omitted: a transport kind's build-time is set by
    // the planner (carried in the commission), not derived by the kind.
  });
});
