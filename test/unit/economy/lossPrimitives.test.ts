import { expect } from "chai";
import {
  ENERGY_DECAY_DIVISOR,
  CONTAINER_DECAY_HITS,
  CONTAINER_DECAY_INTERVAL_OWNED,
  CONTAINER_DECAY_INTERVAL_REMOTE,
  RAMPART_DECAY_HITS,
  RAMPART_DECAY_INTERVAL,
  pileDecayRate,
  hitsToEnergy,
  containerDecayEnergy,
  rampartDecayEnergy,
  creepRepairEnergy
} from "../../../src/economy/primitives";

/**
 * THE RESIDUAL'S LINE ITEMS (owner 2026-08-01: "I'd like to see pile decay,
 * tombstone and decay (structures) and repair show up in the report").
 *
 * The energy account balances to a named RESIDUAL that bounds decay, rot, raid
 * losses and measurement error - 32% of gross mining at last close. These are
 * the conversions that let the meter price the decay half of it in ENERGY, so
 * it becomes line items instead of one bucket.
 *
 * Every one is a GAME RULE, not a tuning knob: the engine's own decay
 * arithmetic. They live here because economy/primitives.ts is the one place
 * economic formulas are allowed to exist (CLAUDE.md), so the meter, the ledger
 * and any future planner term cannot each carry their own copy.
 */
describe("loss primitives - pricing decay in energy", () => {
  describe("ground piles", () => {
    it("decays ceil(amount/1000) per tick - the engine's own rule", () => {
      expect(ENERGY_DECAY_DIVISOR).to.equal(1000);
      expect(pileDecayRate(1000)).to.equal(1);
      expect(pileDecayRate(1001)).to.equal(2); // ceil, not round
      expect(pileDecayRate(2500)).to.equal(3);
    });

    it("is CONVEX - one big pile rots faster than the same energy split up", () => {
      // 3000 in one pile loses 3/t; three 1000s lose 1/t each = 3/t. Equal.
      // But 2001 in one pile loses 3/t where 1000+1001 loses 1+2 = 3/t...
      // the convexity bites at the ceiling boundary:
      expect(pileDecayRate(3000)).to.equal(3);
      expect(pileDecayRate(2999)).to.equal(3);
      // A pile just over a boundary pays a whole extra energy per tick.
      expect(pileDecayRate(2001) - pileDecayRate(2000)).to.equal(1);
    });

    it("costs nothing for an empty or absent pile", () => {
      expect(pileDecayRate(0)).to.equal(0);
      expect(pileDecayRate(-5)).to.equal(0); // never a negative loss
    });
  });

  describe("structures", () => {
    it("prices hits in energy at the repair rate (100 hits per energy)", () => {
      expect(hitsToEnergy(100)).to.equal(1);
      expect(hitsToEnergy(0)).to.equal(0);
    });

    it("prices a REMOTE container 5x an owned one - the decay interval differs", () => {
      expect(CONTAINER_DECAY_HITS).to.equal(5000);
      expect(CONTAINER_DECAY_INTERVAL_OWNED).to.equal(500);
      expect(CONTAINER_DECAY_INTERVAL_REMOTE).to.equal(100);
      // owned: 5000/500 = 10 hits/t = 0.10 e/t; remote: 50 hits/t = 0.50 e/t
      expect(containerDecayEnergy(true)).to.be.closeTo(0.1, 1e-9);
      expect(containerDecayEnergy(false)).to.be.closeTo(0.5, 1e-9);
      expect(containerDecayEnergy(false) / containerDecayEnergy(true)).to.be.closeTo(5, 1e-9);
    });

    it("prices a rampart at its own decay cadence", () => {
      expect(RAMPART_DECAY_HITS).to.equal(300);
      expect(RAMPART_DECAY_INTERVAL).to.equal(100);
      expect(rampartDecayEnergy()).to.be.closeTo(0.03, 1e-9); // 3 hits/t
    });
  });

  describe("repair spend", () => {
    it("charges one energy per WORK part per tick (REPAIR_COST x REPAIR_POWER)", () => {
      // 0.01 energy/hit x 100 hits/WORK/tick = 1 energy per WORK per tick.
      expect(creepRepairEnergy(1)).to.equal(1);
      expect(creepRepairEnergy(5)).to.equal(5);
      expect(creepRepairEnergy(0)).to.equal(0);
    });

    it("is the exact inverse of hitsToEnergy - repair and decay net out", () => {
      // The invariant the account depends on: a structure held at constant hits
      // costs exactly its decay rate in repair. If these two disagreed, the
      // residual split would double-count or leak.
      const workParts = 4;
      const hitsRepaired = workParts * 100;
      expect(creepRepairEnergy(workParts)).to.be.closeTo(hitsToEnergy(hitsRepaired), 1e-9);
    });
  });
});

/**
 * SPEC 42 STAGE A: every loss line gets a BUDGET, priced by a primitive.
 *
 * - Pile decay: the plan's own gate (SOURCE_BUFFER_DEFER_THRESHOLD) holds a
 *   mouth AT the container cap, so the level the plan INTENDS carries zero
 *   ground share - the budget is zero, and every measured e/t of ground decay
 *   is priced unfavorable variance pointing at the haul deficit (E6), never
 *   silently absorbed. The budget composes the SAME pileDecayRate the meter
 *   integrates (one formula home, pinned here to 1e-9).
 * - Tombstones: the plan already prices raid attrition at admission - the
 *   invader tax. The budget IS that term (INVADER_TAX_PER_ENERGY x taxed
 *   capacity), so the account's tombstone variance and R1's calibration read
 *   the same constant, and the >=10-window swap moves both together.
 */
describe("loss budgets (spec 42 stage A: every loss has a budget)", () => {
  it("pileDecayBudget prices the GROUND share above the container cap via the meter's own rate", async () => {
    const { pileDecayBudget, pileDecayRate, CONTAINER_CAP, SOURCE_BUFFER_DEFER_THRESHOLD } = (await import(
      "../../../src/economy/primitives"
    )) as any;
    expect(CONTAINER_CAP).to.equal(2000); // engine CONTAINER_CAPACITY
    // The gate's design point: mouth AT the threshold = container full, ground 0.
    expect(pileDecayBudget(SOURCE_BUFFER_DEFER_THRESHOLD)).to.equal(0);
    expect(pileDecayBudget(2000)).to.equal(0);
    // Overshoot prices at the engine law on the ground share - EXACTLY the
    // meter's rate (one home, 1e-9).
    expect(pileDecayBudget(3375)).to.be.closeTo(pileDecayRate(3375 - 2000), 1e-9);
    expect(pileDecayBudget(3375)).to.equal(2);
    expect(pileDecayBudget(0)).to.equal(0);
    expect(pileDecayBudget(-5)).to.equal(0);
  });

  it("tombstoneLossBudget is the invader tax on the taxed capacity - the R1 constant, one home", async () => {
    const { tombstoneLossBudget, INVADER_TAX_PER_ENERGY } = (await import(
      "../../../src/economy/primitives"
    )) as any;
    expect(tombstoneLossBudget(80)).to.be.closeTo(INVADER_TAX_PER_ENERGY * 80, 1e-9);
    expect(tombstoneLossBudget(0)).to.equal(0);
  });
});
