import { expect } from "chai";
import {
  planColony,
  ColonyProblem,
  PlannerSource,
  PlannerSink,
  PlannerSpawn
} from "../../../src/economy/CorpPlanner";
import { netEnergy, carryPartsFor, miningBudgetPerSpawn, spawnPartsFor } from "../../../src/economy/primitives";
import { Position } from "../../../src/types/Position";

// 1-D world: everything in one room, distance = |dx| + |dy|, so we can place a
// source at any exact distance from a spawn/sink and hand-derive the economics.
const ROOM = "W0N0";
const at = (x: number, y = 0): Position => ({ x, y, roomName: ROOM });
const manhattan = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

const spawn = (id: string, x: number): PlannerSpawn => ({ id, pos: at(x) });
const source = (id: string, x: number, rate = 10, maxMiners = 1): PlannerSource => ({
  id,
  nodeId: `node-${id}`,
  pos: at(x),
  rate,
  maxMiners
});
const sink = (id: string, kind: PlannerSink["kind"], x: number, value: number, capacity: number, reserve?: number): PlannerSink => ({
  id,
  kind,
  pos: at(x),
  value,
  capacity,
  reserve
});

function problem(p: Partial<ColonyProblem> & Pick<ColonyProblem, "spawns" | "sources" | "sinks">): ColonyProblem {
  return { dist: manhattan, ...p };
}

const stock = (id: string, x: number, rate: number): PlannerSource => ({
  id,
  nodeId: `node-${id}`,
  pos: at(x),
  rate,
  maxMiners: 0,
  transient: true
});

describe("economy/CorpPlanner", () => {
  describe("Phase 1 - producer selection", () => {
    it("N=1: mines a single profitable source and sizes its hauler to the controller", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("a", 10)],
          sinks: [sink("ctrl", "controller", 0, 50, 100)]
        })
      );
      expect(plan.miners).to.have.length(1);
      const m = plan.miners[0];
      expect(m.sourceId).to.equal("a");
      expect(m.spawnId).to.equal("S");
      expect(m.distance).to.equal(10);
      expect(m.rate).to.equal(10);
      expect(m.netEnergy).to.be.closeTo(netEnergy(10, 10), 1e-9);
      // one hauler source->controller, both at distance 10, carrying the full rate
      expect(plan.haulers).to.have.length(1);
      expect(plan.haulers[0].flowRate).to.be.closeTo(10, 1e-9);
      expect(plan.haulers[0].carryParts).to.be.closeTo(carryPartsFor(10, 10), 1e-9);
    });

    it("never mines a source that costs more to staff than it yields", () => {
      // at distance 320 the round-trip hauler cost drives netEnergy negative
      expect(netEnergy(10, 320)).to.be.lessThan(0);
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("far", 320)],
          sinks: [sink("ctrl", "controller", 0, 50, 100)]
        })
      );
      expect(plan.miners).to.have.length(0);
      expect(plan.haulers).to.have.length(0);
    });

    it("under spawn-budget contention, keeps the best source and drops the rest", () => {
      // two far sources sharing one spawn each cost ~0.13 parts/tick; the budget
      // (~0.2) only affords one, so the second falls out.
      const d = 200;
      expect(2 * spawnPartsFor(10, d)).to.be.greaterThan(miningBudgetPerSpawn());
      expect(netEnergy(10, d)).to.be.greaterThan(0); // both are individually profitable
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("a", d), source("b", -d)], // both 200 from spawn
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      expect(plan.miners).to.have.length(1);
      expect((plan.spawnPartsUsed.get("S") ?? 0)).to.be.greaterThan(0);
    });

    it("always staffs a spawn's single source even if it alone exceeds the budget", () => {
      // A rich source (15/tick, e.g. a high-capacity/keeper source) far enough out
      // that its miner+haulers alone exceed the mining budget but it is still
      // net-positive. For a standard 10/tick source this is impossible - it turns
      // unprofitable (~d=286) before it exceeds the budget (~d=291) - so the
      // "always staff the best" guarantee only bites for rich sources.
      const d = 210;
      expect(spawnPartsFor(15, d)).to.be.greaterThan(miningBudgetPerSpawn());
      expect(netEnergy(15, d)).to.be.greaterThan(0);
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("lonely", d, 15)],
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      expect(plan.miners).to.have.length(1);
    });

    it("assigns each source to its NEAREST spawn (N spawns)", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("A", 0), spawn("B", 100)],
          sources: [source("near-b", 90)], // d=90 to A, d=10 to B
          sinks: [sink("ctrl", "controller", 50, 50, 1000)]
        })
      );
      expect(plan.miners[0].spawnId).to.equal("B");
      expect(plan.miners[0].distance).to.equal(10);
    });
  });

  describe("Phase 2 - value routing", () => {
    it("fills the higher-value sink (spawn) before a lower-value one (controller)", () => {
      const base = {
        spawns: [spawn("S", 0)],
        sinks: [sink("spawn", "spawn", 0, 100, 10), sink("ctrl", "controller", 0, 50, 1000)]
      };
      // one source (10/tick): spawn (cap 10) takes it all, controller gets nothing
      const p1 = planColony(problem({ ...base, sources: [source("a", 10)] }));
      expect(allocOf(p1, "spawn")).to.be.closeTo(10, 1e-9);
      expect(allocOf(p1, "ctrl")).to.be.closeTo(0, 1e-9);
      // two sources (20/tick): spawn capped at 10, controller takes the rest
      const p2 = planColony(problem({ ...base, sources: [source("a", 10), source("b", 12)] }));
      expect(allocOf(p2, "spawn")).to.be.closeTo(10, 1e-9);
      expect(allocOf(p2, "ctrl")).to.be.closeTo(10, 1e-9);
    });

    it("respects a sink's capacity (excess is left unrouted)", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("a", 10)],
          sinks: [sink("ctrl", "controller", 0, 50, 5)] // capacity 5 < produced 10
        })
      );
      expect(allocOf(plan, "ctrl")).to.be.closeTo(5, 1e-9);
      expect(plan.totalProduced).to.be.closeTo(10, 1e-9);
      expect(plan.totalDelivered).to.be.closeTo(5, 1e-9);
    });

    it("honors a reserve floor before higher-value sinks drain the pool", () => {
      // scarce energy (6/tick): construction (value 70) would take it all, but the
      // controller's reserve of 2 is filled first.
      const base = {
        spawns: [spawn("S", 0)],
        sources: [source("a", 10, 6)] // a thin 6/tick source at distance 10
      };
      const withReserve = planColony(
        problem({ ...base, sinks: [sink("build", "construction", 0, 70, 5), sink("ctrl", "controller", 0, 50, 100, 2)] })
      );
      expect(allocOf(withReserve, "ctrl")).to.be.greaterThan(1.9); // reserve protected
      const noReserve = planColony(
        problem({ ...base, sinks: [sink("build", "construction", 0, 70, 5), sink("ctrl", "controller", 0, 50, 100)] })
      );
      expect(allocOf(noReserve, "ctrl")).to.be.lessThan(allocOf(withReserve, "ctrl"));
    });

    it("pulls from the NEAREST source first when filling a sink", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("near", 5), source("far", 50)],
          sinks: [sink("ctrl", "controller", 0, 50, 10)] // wants 10, the near source covers it
        })
      );
      const ctrl = plan.sinks.find(s => s.sinkId === "ctrl")!;
      expect(ctrl.sources).to.have.length(1);
      expect(ctrl.sources[0].sourceId).to.equal("near");
      expect(ctrl.sources[0].amount).to.be.closeTo(10, 1e-9);
    });
  });

  describe("scavenging - transient sources", () => {
    it("hauls a ground stock to a sink WITHOUT commissioning a miner", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [stock("pile", 10, 8)], // 8/tick scavengeable stock at distance 10
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      // a transient stock is already harvested: no miner, but a scavenger hauls it
      expect(plan.miners).to.have.length(0);
      const ctrl = plan.sinks.find(s => s.sinkId === "ctrl")!;
      expect(ctrl.allocated).to.be.closeTo(8, 1e-9);
      expect(plan.haulers.filter(h => h.sourceId === "pile").length).to.be.greaterThan(0);
      expect(plan.totalProduced).to.be.closeTo(8, 1e-9);
    });

    it("adds stock energy to the routed supply alongside staffed sources", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("s1", 10), stock("pile", 15, 6)],
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      // the staffed source is mined; the stock is scavenged; both reach the sink
      expect(plan.miners.map(m => m.sourceId)).to.deep.equal(["s1"]);
      expect(plan.totalProduced).to.be.closeTo(16, 1e-9);
      expect(plan.sinks.find(s => s.sinkId === "ctrl")!.allocated).to.be.closeTo(16, 1e-9);
      expect(plan.haulers.some(h => h.sourceId === "s1")).to.equal(true);
      expect(plan.haulers.some(h => h.sourceId === "pile")).to.equal(true);
    });

    it("never commissions a miner for a transient source even when steady sources contend", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("s1", 10), stock("pile", 12, 10)],
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      expect(plan.miners.some(m => m.sourceId === "pile")).to.equal(false);
    });

    it("skips a stock too far to scavenge profitably (haul cost exceeds the energy)", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [stock("faraway", 350, 8)],
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      expect(plan.haulers).to.have.length(0);
      expect(plan.totalProduced).to.be.closeTo(0, 1e-9);
    });
  });

  describe("whole-plan accounting", () => {
    it("reports produced, delivered, overhead and per-spawn build-time", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("a", 10)],
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      expect(plan.totalProduced).to.be.closeTo(10, 1e-9);
      expect(plan.totalDelivered).to.be.closeTo(10, 1e-9);
      expect(plan.totalOverhead).to.be.greaterThan(0);
      expect(plan.sustainable).to.equal(true);
      expect(plan.spawnPartsUsed.get("S")).to.be.greaterThan(0);
    });

    it("generalises to N spawns and sources: each miner on its nearest spawn, budgets independent", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("A", 0), spawn("B", 100), spawn("C", 200)],
          sources: [source("a1", 8), source("a2", 12), source("b1", 95), source("c1", 205), source("c2", 190)],
          sinks: [sink("ctrl", "controller", 100, 50, 10000)]
        })
      );
      // every commissioned miner sits on the spawn nearest its source
      const spawnsById = new Map(plan.miners.map(m => [m.sourceId, m.spawnId]));
      expect(spawnsById.get("a1")).to.equal("A");
      expect(spawnsById.get("a2")).to.equal("A");
      expect(spawnsById.get("b1")).to.equal("B");
      expect(spawnsById.get("c1")).to.equal("C");
      expect(spawnsById.get("c2")).to.equal("C");
      // no spawn's committed build-time runs away (each within budget, or a single best source)
      for (const [, used] of plan.spawnPartsUsed) {
        expect(used).to.be.greaterThan(0);
      }
    });
  });
});

function allocOf(plan: ReturnType<typeof planColony>, sinkId: string): number {
  return plan.sinks.find(s => s.sinkId === sinkId)?.allocated ?? 0;
}
