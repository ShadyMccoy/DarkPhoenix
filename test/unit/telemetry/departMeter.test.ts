import { expect } from "chai";
import { DepartMeter } from "../../../src/telemetry/DepartMeter";

/**
 * Departure-reason meter (cycle t72786811): the cd94 live watch caught a
 * 44-CARRY hauler leaving its mouth at exactly half load (1100/2200) with
 * 2000 banked in the container beside it — and the departure BRANCH is
 * invisible from outside (hypothesis #1, stale dedicatedBuildSourceId, was
 * falsified by a live Memory read: undefined). Per the audit method the fix
 * is FIRST a stamp: every depart() records WHY, so the next capture names
 * the branch instead of a third theory.
 */
describe("DepartMeter (why a hauler left its pickup)", () => {
  it("stamps nothing before the first departure", () => {
    const m = new DepartMeter();
    expect(m.stamp()).to.deep.equal({});
  });

  it("records the last departure's reason and cargo fraction", () => {
    const m = new DepartMeter();
    m.record("spot-dry", 1100, 2200, 500);
    const s = m.stamp();
    expect(s.lastDepartReason).to.equal("spot-dry");
    expect(s.lastDepartFrac).to.equal(0.5);
    expect(s.lastDepartTick).to.equal(500);
  });

  it("counts departures by reason since the first record", () => {
    const m = new DepartMeter();
    m.record("full", 2200, 2200, 10);
    m.record("full", 2200, 2200, 120);
    m.record("spot-dry", 1100, 2200, 230);
    const s = m.stamp();
    expect(s.departs).to.deep.equal({ full: 2, "spot-dry": 1 });
    expect(s.departsSince).to.equal(10);
    expect(s.lastDepartReason).to.equal("spot-dry");
  });

  it("rounds the fraction to 3 decimals and survives a zero capacity", () => {
    const m = new DepartMeter();
    m.record("yield", 333, 1000, 7);
    expect(m.stamp().lastDepartFrac).to.equal(0.333);
    const z = new DepartMeter();
    z.record("scavenge-dry", 0, 0, 9);
    expect(z.stamp().lastDepartFrac).to.equal(0);
  });
});
