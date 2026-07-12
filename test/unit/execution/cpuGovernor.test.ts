import { expect } from "chai";
import {
  AUSTERE_BUCKET,
  FULL_SOLVE_INTERVAL,
  LEAN_BUCKET,
  STRETCHED_BUCKET,
  SURVIVAL_BUCKET,
  governorPlan,
  resetGovernor,
  runGovernor
} from "../../../src/execution/CpuGovernor";
import { reset as resetBlackBox, rows } from "../../../src/telemetry/BlackBox";

/**
 * Spec 09 phase 5: the degradation ORDER is a unit-tested fact (stubbed
 * clock; the real effect is verified on the live server only). Shedding
 * order: telemetry -> solve cadence -> construction/paving -> scouting.
 */
describe("CpuGovernor", () => {
  it("full operation above the lean threshold", () => {
    const p = governorPlan(LEAN_BUCKET);
    expect(p.level).to.equal("full");
    expect(p.skipTelemetry).to.equal(false);
    expect(p.solveInterval).to.equal(FULL_SOLVE_INTERVAL);
    expect(p.pauseConstruction).to.equal(false);
    expect(p.freezeScouting).to.equal(false);
  });

  it("sheds telemetry FIRST (lean)", () => {
    const p = governorPlan(LEAN_BUCKET - 1);
    expect(p.level).to.equal("lean");
    expect(p.skipTelemetry).to.equal(true);
    expect(p.solveInterval).to.equal(FULL_SOLVE_INTERVAL); // cadence untouched
    expect(p.pauseConstruction).to.equal(false);
  });

  it("stretches the solve cadence SECOND (stretched)", () => {
    const p = governorPlan(STRETCHED_BUCKET - 1);
    expect(p.level).to.equal("stretched");
    expect(p.skipTelemetry).to.equal(true);
    expect(p.solveInterval).to.be.greaterThan(FULL_SOLVE_INTERVAL);
    expect(p.pauseConstruction).to.equal(false);
  });

  it("pauses investment THIRD (austere)", () => {
    const p = governorPlan(AUSTERE_BUCKET - 1);
    expect(p.level).to.equal("austere");
    expect(p.pauseConstruction).to.equal(true);
    expect(p.freezeScouting).to.equal(false); // intel still runs
  });

  it("freezes scouting LAST (survival)", () => {
    const p = governorPlan(SURVIVAL_BUCKET - 1);
    expect(p.level).to.equal("survival");
    expect(p.skipTelemetry).to.equal(true);
    expect(p.pauseConstruction).to.equal(true);
    expect(p.freezeScouting).to.equal(true);
  });

  it("each level keeps all milder sheds (monotonic degradation)", () => {
    const buckets = [10000, LEAN_BUCKET - 1, STRETCHED_BUCKET - 1, AUSTERE_BUCKET - 1, SURVIVAL_BUCKET - 1];
    const sheds = buckets.map(b => {
      const p = governorPlan(b);
      return Number(p.skipTelemetry) + Number(p.solveInterval > FULL_SOLVE_INTERVAL) + Number(p.pauseConstruction) + Number(p.freezeScouting);
    });
    for (let i = 1; i < sheds.length; i++) expect(sheds[i]).to.be.greaterThan(sheds[i - 1]);
  });

  it("runs DRY unless Memory.cpuGovernor is 'on' (sims stay deterministic)", () => {
    resetGovernor();
    (global as any).Memory = {}; // a Memory WITHOUT the arming flag = dry run
    try {
      const applied = runGovernor(SURVIVAL_BUCKET - 1, 1);
      expect(applied.level, "would-be level computed, nothing shed").to.equal("full");
      (global as any).Memory = { cpuGovernor: "on" };
      const armedPlan = runGovernor(SURVIVAL_BUCKET - 1, 2);
      expect(armedPlan.level).to.equal("survival");
      expect(armedPlan.freezeScouting).to.equal(true);
    } finally {
      delete (global as any).Memory;
      resetGovernor();
    }
  });

  it("logs level TRANSITIONS to the black box (not steady state)", () => {
    resetGovernor();
    resetBlackBox();
    runGovernor(10000, 1); // initial level: no row (nothing to transition from)
    runGovernor(10000, 2); // steady: no row
    runGovernor(AUSTERE_BUCKET - 1, 3); // transition: one row
    runGovernor(AUSTERE_BUCKET - 1, 4); // steady again: no row
    const govRows = rows().filter(r => r.k === "gov");
    expect(govRows).to.have.length(1);
    expect(govRows[0].d.level).to.equal("austere");
    expect(govRows[0].t).to.equal(3);
  });
});
