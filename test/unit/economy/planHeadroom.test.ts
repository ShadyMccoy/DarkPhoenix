import { expect } from "chai";
import {
  MINING_BUDGET_FRACTION,
  SPAWN_PARTS_PER_TICK,
  SPAWN_PLAN_FRACTION,
  miningBudgetPerSpawn,
  plannableSpawnParts
} from "../../../src/economy/primitives";

/**
 * SPAWN PLANNING HEADROOM (owner 2026-07-30: "90% of theoretical spawn
 * capacity is available for planning. So everything is like before, we're
 * just planning on an economy that's 10% smaller in terms of bodies").
 *
 * WHY: the planner has been planning to the PHYSICAL ceiling. Measured at
 * t72676360: plan-implied 0.89-0.95x of 0.667 p/t, spawn utilization 0.97,
 * queue depth 8, blocking demands stacked behind a saturated build pipe. A
 * plan at 100% of physical leaves zero slack for what execution actually
 * spends parts on: EOL replacement overlap (deliveryLeadTime starts
 * successors early - double-staffing is the DESIGNED behavior), invader
 * churn rebuilds (X5 measured 18% remote), and runt upsizes. Every one of
 * those competes with the plan's own fleets at the spawn door.
 *
 * The fix is a MARGIN, not a mechanism: the planner sees a spawn that is 10%
 * smaller, everywhere, through ONE lens (plannableSpawnParts). Execution
 * still owns the full physical spawn - the reserved 10% is what absorbs
 * churn instead of the queue absorbing it.
 */
describe("spawn planning headroom (plan on 90% of the physical ceiling)", () => {
  it("plannableSpawnParts = spawnCount x physical rate x SPAWN_PLAN_FRACTION", () => {
    expect(plannableSpawnParts(1)).to.be.closeTo(SPAWN_PARTS_PER_TICK * SPAWN_PLAN_FRACTION, 1e-12);
    expect(plannableSpawnParts(2)).to.be.closeTo(2 * SPAWN_PARTS_PER_TICK * SPAWN_PLAN_FRACTION, 1e-12);
  });

  it("the fraction is 0.9 - a margin, not a throttle", () => {
    // 10% is sized to the measured churn classes it must absorb (EOL overlap
    // + invader rebuilds), not to halve the economy. A fraction drifting far
    // from 0.9 needs an owner decision, so pin it.
    expect(SPAWN_PLAN_FRACTION).to.equal(0.9);
  });

  it("two spawns at 90% still out-plan one spawn at 100% (the margin never inverts growth)", () => {
    expect(plannableSpawnParts(2)).to.be.greaterThan(SPAWN_PARTS_PER_TICK * 1.0);
  });

  it("zero spawns plan zero parts", () => {
    expect(plannableSpawnParts(0)).to.equal(0);
  });

  it("the mining tranche derives from the PLANNABLE rate, not the physical one", () => {
    // "Everything is like before, just 10% smaller": the 0.6 mining fraction
    // composes with the headroom - mining sees 0.9 x 0.6 of a spawn, so the
    // whole plan shrinks uniformly instead of only the sink fill shrinking.
    expect(miningBudgetPerSpawn()).to.be.closeTo(plannableSpawnParts(1) * MINING_BUDGET_FRACTION, 1e-12);
    expect(miningBudgetPerSpawn()).to.be.closeTo(SPAWN_PARTS_PER_TICK * SPAWN_PLAN_FRACTION * 0.6, 1e-12);
  });
});
