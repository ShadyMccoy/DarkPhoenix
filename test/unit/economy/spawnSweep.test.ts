import { expect } from "chai";
import {
  SWEEP_MAX_PCT,
  SWEEP_MONTH_TICKS,
  SWEEP_STEP_PCT_FAST,
  currentHandicapPct,
  isMonthBoundary,
  shouldAccelerate
} from "../../../src/economy/spawnSweep";
// Arming/advancing live in the ADAPTER (spec 17 purity: the pure sweep may not
// touch Memory), so the experiment is driven from there in these tests too.
import { armSweep, disarmSweep, getSweep, onTick, resetFiscalArchive } from "../../../src/telemetry/fiscalArchive";
import { RawMemory as MockRawMemory, setupGlobals } from "../mock";
import {
  MINING_BUDGET_FRACTION,
  SPAWN_PARTS_PER_TICK,
  SPAWN_PLAN_FRACTION,
  miningBudgetPerSpawn,
  plannableSpawnParts,
  spawnPlanFraction
} from "../../../src/economy/primitives";

/**
 * THE HANDICAP SWEEP (owner 2026-08-06). The planner's spawn-capacity margin
 * walks 0%..20% one step per fiscal month so each month's income statement
 * describes exactly one handicap, then wraps and runs again.
 *
 * The safety property under test everywhere below: UNARMED IS 0.9. The sweep is
 * an experiment bolted onto a colony that already works, and every path that
 * does not explicitly arm it - grid cell, sim, unit test, wiped live Memory -
 * must land on the measured-good margin, never on the 1.0 that overheated the
 * colony on 2026-08-04 (utilization 0.97-0.98, forgone mining to 44.5 e/t).
 */
describe("spawn handicap sweep", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).RawMemory = MockRawMemory;
    MockRawMemory.segments = {};
    // The boundary hook is idempotent PER BOUNDARY, so a leftover pending tick
    // from a previous test would swallow this one's first step.
    resetFiscalArchive();
  });
  afterEach(() => disarmSweep());

  describe("unarmed - the fail-safe", () => {
    it("resolves to the static SPAWN_PLAN_FRACTION when no sweep exists", () => {
      disarmSweep();
      expect(currentHandicapPct()).to.equal(undefined);
      expect(spawnPlanFraction()).to.equal(SPAWN_PLAN_FRACTION);
      expect(spawnPlanFraction()).to.equal(0.9);
    });

    it("leaves the whole plan-capacity lens exactly where it was", () => {
      disarmSweep();
      expect(plannableSpawnParts(1)).to.be.closeTo(SPAWN_PARTS_PER_TICK * 0.9, 1e-12);
      expect(miningBudgetPerSpawn()).to.be.closeTo(SPAWN_PARTS_PER_TICK * 0.9 * MINING_BUDGET_FRACTION, 1e-12);
    });

    it("advanceSweep is inert - the bot never self-arms the experiment", () => {
      disarmSweep();
      onTick(3000, {});
      expect(getSweep()).to.equal(undefined);
      expect(spawnPlanFraction()).to.equal(0.9);
    });
  });

  describe("armed - the margin follows the sweep", () => {
    it("0% handicap plans the full physical rate", () => {
      armSweep(0);
      expect(spawnPlanFraction()).to.equal(1);
      expect(plannableSpawnParts(1)).to.be.closeTo(SPAWN_PARTS_PER_TICK, 1e-12);
    });

    it("20% handicap plans four fifths of it", () => {
      armSweep(20);
      expect(spawnPlanFraction()).to.be.closeTo(0.8, 1e-12);
      expect(plannableSpawnParts(2)).to.be.closeTo(2 * SPAWN_PARTS_PER_TICK * 0.8, 1e-12);
    });

    it("the mining tranche shrinks with it - the whole plan, not one tranche", () => {
      armSweep(15);
      expect(miningBudgetPerSpawn()).to.be.closeTo(plannableSpawnParts(1) * MINING_BUDGET_FRACTION, 1e-12);
      expect(miningBudgetPerSpawn()).to.be.closeTo(SPAWN_PARTS_PER_TICK * 0.85 * MINING_BUDGET_FRACTION, 1e-12);
    });

    it("10% reproduces the retired constant exactly - the sweep passes THROUGH the old value", () => {
      armSweep(10);
      expect(spawnPlanFraction()).to.be.closeTo(SPAWN_PLAN_FRACTION, 1e-12);
    });
  });

  describe("the calendar", () => {
    it("a month boundary is the absolute 1500-tick clock (same one the fiscal close uses)", () => {
      expect(SWEEP_MONTH_TICKS).to.equal(1500);
      expect(isMonthBoundary(72_823_500)).to.equal(true);
      expect(isMonthBoundary(72_823_501)).to.equal(false);
    });

    it("steps 1% per month boundary and holds the value BETWEEN boundaries", () => {
      armSweep(0);
      onTick(1500, {});
      expect(currentHandicapPct()).to.equal(1);
      // Mid-month ticks must not move it: a month's income statement has to
      // describe exactly one handicap or the experiment measures nothing.
      onTick(1501, {});
      onTick(2999, {});
      expect(currentHandicapPct()).to.equal(1);
      onTick(3000, {});
      expect(currentHandicapPct()).to.equal(2);
    });

    it("is idempotent per boundary - a retried tick cannot double-step", () => {
      armSweep(5);
      onTick(1500, {});
      expect(currentHandicapPct()).to.equal(6);
      onTick(1500, {});
      onTick(1500, {});
      expect(currentHandicapPct()).to.equal(6);
    });

    it("walks 0..20 and then WRAPS to 0, counting the cycle", () => {
      armSweep(0);
      const seen: number[] = [0];
      for (let i = 1; i <= 21; i++) {
        onTick(i * 1500, {});
        seen.push(currentHandicapPct()!);
      }
      // 0,1,2,...,20 then back to 0 - 21 distinct handicaps per cycle.
      expect(seen.slice(0, 21)).to.deep.equal(Array.from({ length: 21 }, (_, i) => i));
      expect(seen[21]).to.equal(0);
      expect(getSweep()!.cycle).to.equal(1);
    });

    it("never leaves the legal band even from a hand-set value", () => {
      armSweep(999);
      expect(currentHandicapPct()).to.equal(SWEEP_MAX_PCT);
      armSweep(-4);
      expect(currentHandicapPct()).to.equal(0);
    });
  });

  describe("acceleration - the owner's 'if necessary'", () => {
    // "RCL 8 may hit before then - so if necessary let's plan to accelerate
    // that with 2% per month." Necessary means RCL 8 lands before the ramp
    // finishes: the controller caps at 15 e/t there, so income statements
    // either side of it are not comparable.
    const state = (pct: number, lastProgress?: number) => ({
      pct,
      step: 1,
      lastBoundary: 0,
      cycle: 0,
      lastProgress
    });

    it("does NOT accelerate at the rate measured t72823437 (RCL 8 is ~65 months out)", () => {
      // Measured: 7,282,074 of 10,935,000 toward RCL 8, gaining ~37.4/tick =
      // ~56,100 per fiscal month. 3.65M remaining projects ~97,700 ticks; the
      // ramp from 0% is 21 months = 31,500. A 3x margin - keep the resolution.
      const s = state(0, 7_282_074 - 56_100);
      expect(
        shouldAccelerate(s, { tick: 1500, rcl: 7, rclProgress: 7_282_074, rclProgressTotal: 10_935_000 })
      ).to.equal(false);
    });

    it("accelerates when the measured rate projects RCL 8 INSIDE the remaining ramp", () => {
      // Same room, controller running ~10x faster (560k/month): 3.65M remaining
      // is ~6.5 months against 21 months of ramp left.
      const s = state(0, 7_282_074 - 561_000);
      expect(
        shouldAccelerate(s, { tick: 1500, rcl: 7, rclProgress: 7_282_074, rclProgressTotal: 10_935_000 })
      ).to.equal(true);
      const armed = armSweep(0);
      armed.lastProgress = 7_282_074 - 561_000;
      onTick(1500, { rcl: 7, rclProgress: 7_282_074, rclProgressTotal: 10_935_000 });
      expect(getSweep()!.step).to.equal(SWEEP_STEP_PCT_FAST);
      expect(currentHandicapPct()).to.equal(2);
    });

    it("only a level-7 room races RCL 8 - an RCL 8 colony is already past the transition", () => {
      const s = state(0, 0);
      expect(
        shouldAccelerate(s, { tick: 1500, rcl: 8, rclProgress: 9_000_000, rclProgressTotal: 10_935_000 })
      ).to.equal(false);
    });

    it("degrades to the FINER sweep with no rate sample (first boundary after arming)", () => {
      const s = state(0, undefined);
      expect(
        shouldAccelerate(s, { tick: 1500, rcl: 7, rclProgress: 7_282_074, rclProgressTotal: 10_935_000 })
      ).to.equal(false);
    });

    it("survives a level-up resetting progress (a negative sample is no sample)", () => {
      const s = state(0, 9_000_000);
      expect(shouldAccelerate(s, { tick: 1500, rcl: 7, rclProgress: 12_000, rclProgressTotal: 10_935_000 })).to.equal(
        false
      );
    });
  });
});
