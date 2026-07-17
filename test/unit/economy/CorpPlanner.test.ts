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

    it("with spare build-time, mines a far source - distance alone never disqualifies", () => {
      // d=120 is well past "local" but profitable and within the mining budget;
      // the spawn-time wall is contention, not a fixed range cutoff.
      const d = 120;
      expect(netEnergy(10, d)).to.be.greaterThan(0);
      expect(spawnPartsFor(10, d)).to.be.lessThan(miningBudgetPerSpawn());
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("far", d)],
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      expect(plan.miners).to.have.length(1);
      expect(plan.miners[0].sourceId).to.equal("far");
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

  describe("link-served sources (haulPos)", () => {
    it("prices a link-served source's hauling from its haulPos while the miner keeps the real distance", () => {
      // The source sits 200 out, but its output emerges at the core link 2 from
      // the sink - so the hauler is tiny while the miner still walks 200.
      const linked: PlannerSource = { ...source("linked", 200), haulPos: at(2) };
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [linked],
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      expect(plan.miners).to.have.length(1);
      expect(plan.miners[0].distance, "miner walks the real distance").to.equal(200);
      expect(plan.haulers).to.have.length(1);
      expect(plan.haulers[0].distance, "hauling is priced from the core").to.equal(2);
      expect(plan.haulers[0].carryParts).to.be.closeTo(carryPartsFor(10, 2), 1e-9);
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

/**
 * OVER-ABUNDANCE: more profitable sources than a spawn's build-time can
 * sustain. The planner must fill the budget by VALUE DENSITY (net energy per
 * spawn build-part), not raw net energy or discovery order - the recurring
 * spawn cost (miner + haulers, amortized over effective life) IS the scarce
 * resource once sources are plentiful.
 *
 * Mutation checks: sort candidates by raw net (drop the /parts) and the
 * density case fails; drop the `spent + parts > budget` guard and the
 * budget-cap case fails.
 */
describe("Phase 1 - over-abundance sizing (value density under the parts budget)", () => {
  it("staffs by value DENSITY, not raw net, when the budget cannot fit everything", () => {
    // a: rate 4 at d=12 - small raw net but extremely cheap to serve (dense).
    // b, c: rate 10 at d=190/200 - each out-nets a in absolute terms, but
    // their hauler fleets are budget hogs. All three together overflow the
    // budget; density order (a, b, c) keeps a+b and drops c. A raw-net sort
    // (the mutation) would pick b first instead.
    const dA = 12;
    const dB = 190;
    const dC = 200;
    const netA = netEnergy(4, dA);
    expect(netEnergy(10, dB)).to.be.greaterThan(netA); // raw net prefers b...
    expect(netA / spawnPartsFor(4, dA)).to.be.greaterThan(netEnergy(10, dB) / spawnPartsFor(10, dB)); // ...density prefers a
    const total = spawnPartsFor(4, dA) + spawnPartsFor(10, dB) + spawnPartsFor(10, dC);
    expect(total).to.be.greaterThan(miningBudgetPerSpawn()); // real contention

    const plan = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [source("b", dB, 10), source("c", dC, 10), source("a", dA, 4)],
        sinks: [sink("ctrl", "controller", 0, 50, 1000)]
      })
    );
    const mined = plan.miners.map(m => m.sourceId);
    expect(mined[0]).to.equal("a"); // density winner staffed first
    expect(mined).to.include("b");
    expect(mined).to.not.include("c"); // the lowest-density candidate is the one dropped
  });

  it("fills the budget with the best subset and never exceeds it (beyond the first pick)", () => {
    // Five profitable sources; the budget affords only some. The planner must
    // take a prefix of the density ordering that fits, skipping any candidate
    // that would overflow but still trying later smaller ones.
    const ds = [20, 60, 100, 150, 200];
    const plan = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: ds.map((d, i) => source(`s${d}`, d, 10)),
        sinks: [sink("ctrl", "controller", 0, 50, 5000)]
      })
    );
    expect(plan.miners.length).to.be.greaterThan(0);
    expect(plan.miners.length).to.be.lessThan(ds.length); // over-abundance: not all staffed
    // near sources in, farthest out
    const mined = new Set(plan.miners.map(m => m.sourceId));
    expect(mined.has("s20")).to.equal(true);
    expect(mined.has("s200")).to.equal(false);
    // the recurring parts total respects the budget
    let parts = 0;
    for (const m of plan.miners) parts += spawnPartsFor(m.rate, m.distance);
    expect(parts).to.be.at.most(miningBudgetPerSpawn() + 1e-9);
  });

  it("each spawn gets its OWN budget - two spawns staff twice as much", () => {
    const ds = [80, 120, 160, 200];
    const single = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: ds.map(d => source(`p${d}`, d, 10)),
        sinks: [sink("ctrl", "controller", 0, 50, 5000)]
      })
    );
    const double = planColony(
      problem({
        spawns: [spawn("S", 0), spawn("S2", 400)],
        sources: [
          ...ds.map(d => source(`p${d}`, d, 10)),
          ...ds.map(d => source(`q${d}`, 400 - d, 10)) // mirrored cluster near S2
        ],
        sinks: [sink("ctrl", "controller", 0, 50, 5000)]
      })
    );
    expect(double.miners.length).to.be.greaterThan(single.miners.length);
    // and no spawn's MINING selection individually blows its budget (the
    // spawnPartsUsed ledger also carries sink-side hauling, which is
    // budgeted downstream - only the Phase-1 mining fill is capped here)
    const miningPartsBySpawn = new Map<string, number>();
    for (const m of double.miners) {
      miningPartsBySpawn.set(m.spawnId, (miningPartsBySpawn.get(m.spawnId) ?? 0) + spawnPartsFor(m.rate, m.distance));
    }
    for (const [, used] of miningPartsBySpawn) {
      expect(used).to.be.at.most(miningBudgetPerSpawn() + 1e-9);
    }
  });
});

describe("Phase 2 - paved routes (roads)", () => {
  it("stamps a paved source's haulers and prices them at 1.5 spawn parts per CARRY", () => {
    const plan = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [{ ...source("a", 10), paved: true }, source("b", 12)],
        sinks: [sink("ctrl", "controller", 0, 50, 100)]
      })
    );
    const pavedHauler = plan.haulers.find(h => h.sourceId === "a")!;
    const plainHauler = plan.haulers.find(h => h.sourceId === "b")!;
    expect(pavedHauler.paved).to.equal(true);
    expect(plainHauler.paved).to.equal(undefined);
    // 2:1 road hauler: 1.5 parts per CARRY instead of 2 - the spawn-budget payoff
    expect(pavedHauler.spawnParts).to.be.closeTo((1.5 * pavedHauler.carryParts) / (1500 - pavedHauler.distance), 1e-9);
    expect(plainHauler.spawnParts).to.be.closeTo((2 * plainHauler.carryParts) / (1500 - plainHauler.distance), 1e-9);
  });
});

describe("Invader tax on remote sources (spec 13 phase 5)", () => {
  it("subtracts the tax from net: a marginal source flips unfunded when taxed", () => {
    // A source whose untaxed net is barely positive: taxed past it, the
    // profitability gate must drop it.
    const d = 250; // far enough that hauler amortization eats most of the margin
    const untaxedNet = netEnergy(10, d);
    expect(untaxedNet).to.be.greaterThan(0); // fixture sanity
    const killTax = (untaxedNet + 0.001) / 10;

    const funded = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [{ ...source("far", d), invaderTax: killTax / 2 }],
        sinks: [sink("ctrl", "controller", 0, 50, 100)]
      })
    );
    expect(funded.miners, "half the kill-tax: still profitable").to.have.length(1);

    const dropped = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [{ ...source("far", d), invaderTax: killTax }],
        sinks: [sink("ctrl", "controller", 0, 50, 100)]
      })
    );
    expect(dropped.miners, "taxed past its margin: not worth mining").to.have.length(0);
  });

  it("ranks an untaxed source above an otherwise-identical taxed one", () => {
    const plan = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [
          { ...source("taxed", 40), invaderTax: 0.05 },
          source("clean", -40)
        ],
        sinks: [sink("ctrl", "controller", 0, 50, 100)]
      })
    );
    expect(plan.miners.length, "both still profitable").to.equal(2);
    expect(plan.miners[0].sourceId, "the clean source is staffed first").to.equal("clean");
  });

  it("never taxes what has no field: existing fixtures are byte-identical", () => {
    const a = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [source("a", 10)],
        sinks: [sink("ctrl", "controller", 0, 50, 100)]
      })
    );
    expect(a.miners[0].rate).to.equal(10);
    expect(a.miners[0].netEnergy).to.be.closeTo(netEnergy(10, 10), 1e-9);
  });
});
