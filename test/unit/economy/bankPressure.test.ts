import { expect } from "chai";
import {
  bankPressure,
  bankSurplusRate,
  MAX_SURPLUS_DRAW,
  SURPLUS_DRAIN_TICKS
} from "../../../src/economy/bank";
import { CREEP_LIFETIME, storageAbsorbRate } from "../../../src/economy/primitives";
import { planColony, ColonyProblem, PlannerSink, PlannerSource, PlannerSpawn } from "../../../src/economy/CorpPlanner";
import { Position } from "../../../src/types/Position";

/**
 * THE BANK AS A SOURCE/SINK PAIR (owner 2026-08-05: "model the energy in the
 * storage as a source and the ullage as a sink (although obviously they can't
 * be applied to each other)").
 *
 * The two halves already existed - bankSurplusRate on the stock side, spec
 * 46's storageAbsorbRate on the ullage side - but in different modules, with
 * different offsets and nothing tying them together. `bankPressure` makes
 * them ONE object read from ONE storage read, so the pair cannot drift and
 * the invariants below have a home.
 *
 * These scenarios are the contract: the pressure metaphor made testable
 * (complementarity, monotonicity, the saturation knees), the anti-pump proved
 * across the WHOLE bank sweep rather than at one staged point, and the
 * empty->full economy arc that the RCL8 consumption-constrained regime sits
 * at the end of.
 */

// Screeps' storage is 1M whatever the RCL; a mid-colony reserve target.
const CAPACITY = 1_000_000;
const TARGET = 30_000;

describe("economy/bank - bankPressure: the storage as a source AND a sink", () => {
  describe("the pair, from first principles", () => {
    it("the SOURCE half is the spendable surplus over one creep generation", () => {
      const p = bankPressure(TARGET + 9_000, CAPACITY - TARGET - 9_000, TARGET);
      expect(p.source).to.be.closeTo(9_000 / CREEP_LIFETIME, 1e-9);
      expect(p.source).to.be.closeTo(6, 1e-9);
    });

    it("the SINK half is the ullage over one creep generation", () => {
      const p = bankPressure(CAPACITY - 9_000, 9_000, TARGET);
      expect(p.sink).to.be.closeTo(9_000 / CREEP_LIFETIME, 1e-9);
      expect(p.sink).to.be.closeTo(6, 1e-9);
    });

    it("ONE law, both directions: the same quantity of energy and of ROOM price identically", () => {
      // The claim that makes this a pair rather than two coincidences.
      const surplusSide = bankPressure(TARGET + 9_000, 500_000, TARGET).source;
      const ullageSide = bankPressure(500_000, 9_000, TARGET).sink;
      expect(surplusSide).to.be.closeTo(ullageSide, 1e-9);
      // ...and it is the SAME horizon on both sides, not two constants that
      // happen to be equal today.
      expect(SURPLUS_DRAIN_TICKS).to.equal(CREEP_LIFETIME);
    });
  });

  describe("complementarity: the bank is never BOTH dry and full (the deadlock invariant)", () => {
    // The property that makes the pair safe to plan against: whatever the bank
    // level, it can always take energy or always give energy (usually both).
    // A bank that could do neither would strand the colony with income it
    // cannot bank and savings it cannot spend.
    it("holds across the whole sweep, empty to full", () => {
      for (let stock = 0; stock <= CAPACITY; stock += CAPACITY / 40) {
        const p = bankPressure(stock, CAPACITY - stock, TARGET);
        expect(p.source > 0 || p.sink > 0, `bank at ${stock} can neither give nor take`).to.equal(true);
      }
    });

    it("FULL: gives at the guard rate, takes nothing (the consumption-constrained end)", () => {
      const p = bankPressure(CAPACITY, 0, TARGET);
      expect(p.sink, "no room, no absorb").to.equal(0);
      expect(p.source, "a full bank is all surplus - it offers the guard rate").to.equal(MAX_SURPLUS_DRAW);
    });

    it("EMPTY: takes at the full ullage rate, gives nothing (the production-constrained end)", () => {
      const p = bankPressure(0, CAPACITY, TARGET);
      expect(p.source, "nothing above the reserve is spendable").to.equal(0);
      expect(p.sink).to.be.closeTo(CAPACITY / CREEP_LIFETIME, 1e-9);
    });

    it("AT the reserve target the source is exactly zero - the taper meets the floor, no step", () => {
      expect(bankPressure(TARGET, CAPACITY - TARGET, TARGET).source).to.equal(0);
      expect(bankPressure(TARGET - 1, CAPACITY - TARGET + 1, TARGET).source).to.equal(0);
      expect(bankPressure(TARGET + 1500, CAPACITY, TARGET).source).to.be.closeTo(1, 1e-9);
    });
  });

  describe("monotone pressure (the vessel property made precise)", () => {
    it("the source RISES and the sink FALLS with the stock - never both the same way", () => {
      let prevSource = -1;
      let prevSink = Infinity;
      for (let stock = 0; stock <= CAPACITY; stock += CAPACITY / 50) {
        const p = bankPressure(stock, CAPACITY - stock, TARGET);
        expect(p.source, `source fell at ${stock}`).to.be.at.least(prevSource - 1e-9);
        expect(p.sink, `sink rose at ${stock}`).to.be.at.most(prevSink + 1e-9);
        prevSource = p.source;
        prevSink = p.sink;
      }
    });

    it("neither half can go negative (a degenerate read is clamped, never a negative sink)", () => {
      const over = bankPressure(CAPACITY + 5_000, -5_000, TARGET);
      expect(over.sink).to.equal(0);
      expect(over.source).to.be.greaterThan(0);
    });
  });

  describe("the saturation map: where the pressure actually BREATHES", () => {
    // Both halves saturate, so the bank behaves as a pure buffer across most
    // of its range and as a regulator only near the two ends. Worth pinning:
    // it is why nothing forced the sink half to be right until an RCL8 room
    // with a full storage turned up.
    it("the SOURCE knee sits at reserve + guard x horizon; above it the draw is flat", () => {
      const knee = TARGET + MAX_SURPLUS_DRAW * SURPLUS_DRAIN_TICKS;
      expect(bankPressure(knee, CAPACITY - knee, TARGET).source).to.be.closeTo(MAX_SURPLUS_DRAW, 1e-9);
      expect(bankPressure(knee - 1500, CAPACITY, TARGET).source).to.be.lessThan(MAX_SURPLUS_DRAW);
      expect(bankPressure(knee + 200_000, 0, TARGET).source).to.equal(MAX_SURPLUS_DRAW);
    });

    it("the SINK knee sits at ullage = supply x horizon; above it the absorb clears supply", () => {
      const supply = 40;
      const knee = supply * CREEP_LIFETIME; // 60,000 of room at 40 e/t
      expect(bankPressure(CAPACITY - knee, knee, TARGET).sink).to.be.closeTo(supply, 1e-9);
      // more room than the knee: the absorb rate exceeds supply, so the sink
      // capacity min() picks supply and the old "soak excess" behavior holds
      expect(bankPressure(CAPACITY - knee * 2, knee * 2, TARGET).sink).to.be.greaterThan(supply);
      // less room: the absorb rate BINDS below supply - the taper
      expect(bankPressure(CAPACITY - knee / 2, knee / 2, TARGET).sink).to.be.lessThan(supply);
    });

    it("between the knees BOTH are saturated: the bank is a pure buffer there", () => {
      const supply = 40;
      for (const stock of [200_000, 400_000, 600_000, 800_000]) {
        const p = bankPressure(stock, CAPACITY - stock, TARGET);
        expect(p.source, `source not saturated at ${stock}`).to.equal(MAX_SURPLUS_DRAW);
        expect(p.sink, `sink not saturated at ${stock}`).to.be.greaterThan(supply);
      }
    });
  });

  describe("anti-drift: bankPressure IS the two halves, not a third opinion", () => {
    it("reproduces bankSurplusRate and storageAbsorbRate exactly, across the sweep", () => {
      for (let stock = 0; stock <= CAPACITY; stock += CAPACITY / 25) {
        const ullage = CAPACITY - stock;
        const p = bankPressure(stock, ullage, TARGET);
        expect(p.source).to.equal(bankSurplusRate(stock, TARGET));
        expect(p.sink).to.equal(storageAbsorbRate(ullage));
      }
    });

    it("an unknown ullage (no live storage) leaves the sink uncapped, the source unaffected", () => {
      const p = bankPressure(TARGET + 15_000, Infinity, TARGET);
      expect(p.sink, "harness paths keep the uncapped soak").to.equal(Infinity);
      expect(p.source).to.be.closeTo(10, 1e-9);
    });
  });
});

// ---------------------------------------------------------------------------
// The pair IN THE PLAN: a colony whose bank sweeps empty -> full.
// ---------------------------------------------------------------------------

const ROOM = "W0N0";
const at = (x: number, y = 0): Position => ({ x, y, roomName: ROOM });
const manhattan = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const spawnAt = (id: string, x: number): PlannerSpawn => ({ id, pos: at(x) });
const mine = (id: string, x: number, rate = 10): PlannerSource => ({
  id,
  nodeId: `node-${id}`,
  pos: at(x),
  rate,
  maxMiners: 1
});
const sinkAt = (id: string, kind: PlannerSink["kind"], x: number, value: number, capacity: number): PlannerSink => ({
  id,
  kind,
  pos: at(x),
  value,
  capacity
});

/** Total mined supply of the sweep world (4 sources x 10 e/t). */
const SUPPLY = 40;

/**
 * The owner's model, assembled literally: the storage's ENERGY is the bank
 * source's rate and its ULLAGE is the storage sink's capacity, both from ONE
 * bankPressure read - exactly what the adapter now does off a live storage.
 * An RCL8 controller (15 e/t game cap) and the spawn's overhead are the only
 * other consumption.
 */
function colonyAtBank(stock: number): ColonyProblem {
  const p = bankPressure(stock, CAPACITY - stock, TARGET);
  const bank: PlannerSource = {
    id: "bank-W0N0",
    nodeId: "W0N0-bank",
    pos: at(2),
    rate: p.source,
    maxMiners: 0,
    transient: true
  };
  return {
    dist: manhattan,
    spawns: [spawnAt("S", 0)],
    sources: [mine("m1", 10), mine("m2", 20), mine("m3", 30), mine("m4", 40), bank],
    sinks: [
      sinkAt("spawn-S", "spawn", 0, 100, 10),
      sinkAt("ctrl", "controller", 5, 50, 15), // the RCL8 game cap
      // the adapter's sink capacity: min(totalSupply, absorb) - the ONE place
      // the ullage becomes a rate
      sinkAt("store", "storage", 2, 1, Math.min(SUPPLY, p.sink))
    ]
  };
}

describe("economy/bank - the pressure pair IN THE PLAN (empty -> full sweep)", () => {
  const LEVELS = [0, 300_000, 700_000, 900_000, 970_000, CAPACITY];

  it("THE ANTI-PUMP HOLDS AT EVERY BANK LEVEL - the bank never fills its own store", () => {
    // The owner's caveat ("obviously they can't be applied to each other") is
    // structural, not tuned: routeToSinks gives the bank a non-deposit ROLE,
    // so bank->storage is unrepresentable. Proved across the whole sweep -
    // including the mid-range where the bank offers 100 e/t of source AND
    // hundreds of e/t of sink simultaneously, which is where a value-greedy
    // router would most want to circulate.
    for (const stock of LEVELS) {
      const plan = planColony(colonyAtBank(stock));
      expect(
        plan.haulers.some(h => h.sourceId === "bank-W0N0" && h.sinkId === "store"),
        `bank pumped into its own store at ${stock}`
      ).to.equal(false);
      const store = plan.sinks.find(s => s.sinkId === "store");
      expect(
        store?.sources.find(s => s.sourceId === "bank-W0N0")?.amount ?? 0,
        `bank credited into its own store at ${stock}`
      ).to.equal(0);
    }
  });

  it("the economy contracts MONOTONICALLY as the bank fills (production- -> consumption-constrained)", () => {
    const arc = LEVELS.map(stock => {
      const plan = planColony(colonyAtBank(stock));
      return {
        stock,
        miners: plan.miners.length,
        banked: plan.sinks.find(s => s.sinkId === "store")?.allocated ?? 0,
        upgrade: plan.sinks.find(s => s.sinkId === "ctrl")?.allocated ?? 0
      };
    });
    for (let i = 1; i < arc.length; i++) {
      expect(arc[i].miners, `miners rose from ${arc[i - 1].stock} to ${arc[i].stock}`).to.be.at.most(arc[i - 1].miners);
      expect(arc[i].banked, `deposits rose from ${arc[i - 1].stock} to ${arc[i].stock}`).to.be.at.most(
        arc[i - 1].banked + 1e-6
      );
    }
    // the two ends are the regimes themselves
    expect(arc[0].miners, "empty bank: every profitable source runs").to.equal(4);
    expect(arc[0].banked, "and all of it banks").to.be.closeTo(SUPPLY, 1e-6);
    expect(arc[arc.length - 1].miners, "full bank: nothing to mine for").to.equal(0);
    expect(arc[arc.length - 1].banked, "nothing banks").to.equal(0);
    // ...and consumption is unaffected throughout: the controller keeps its
    // RCL8 cap on the bank's dime at every level
    for (const a of arc) expect(a.upgrade, `upgrade moved at ${a.stock}`).to.be.closeTo(15, 1e-6);
  });

  it("the contraction is SOURCE BY SOURCE in the taper, not a cliff (the spec 46 property, via the pair)", () => {
    // 970k banked -> 30k of room -> 20 e/t of absorb against 40 e/t of mining:
    // the two nearest sources keep their routes, the two farthest lose theirs
    // and demote. A cliff would drop all four at once (the pre-spec-46 shape).
    const plan = planColony(colonyAtBank(970_000));
    expect(plan.miners.map(m => m.sourceId).sort()).to.deep.equal(["m1", "m2"]);
    expect(plan.sinks.find(s => s.sinkId === "store")!.allocated).to.be.closeTo(20, 1e-6);
    for (const id of ["m3", "m4"]) {
      const v = plan.sourceVerdicts.find(x => x.sourceId === id)!;
      expect(["unrouted", "no-sink"], `${id} is stamped`).to.include(v.verdict);
    }
  });

  it("EVERY hauler has a source AND a sink that admitted it, at every bank level", () => {
    for (const stock of LEVELS) {
      const world = colonyAtBank(stock);
      const plan = planColony(world);
      const sourceIds = new Set(world.sources.map(s => s.id));
      for (const h of plan.haulers) {
        expect(h.flowRate, `empty route ${h.sourceId}->${h.sinkId} @${stock}`).to.be.greaterThan(1e-9);
        expect(sourceIds.has(h.sourceId), `orphan source ${h.sourceId} @${stock}`).to.equal(true);
        const acc = plan.sinks.find(s => s.sinkId === h.sinkId);
        expect(acc, `orphan sink ${h.sinkId} @${stock}`).to.not.equal(undefined);
        expect(acc!.allocated + 1e-6, `sink ${h.sinkId} did not admit its flow @${stock}`).to.be.at.least(h.flowRate);
      }
    }
  });
});
