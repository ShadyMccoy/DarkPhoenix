import { expect } from "chai";
import {
  pickTowerTarget,
  pickTowerRepairTarget,
  TOWER_REPAIR_RANGE,
} from "../../../src/execution/TowerRunner";
import { REPAIR_TO } from "../../../src/corps/repair";

/**
 * Spec 07 unit acceptance: the tower fire decision as a pure helper. No
 * hostiles means no intent (no energy spent); otherwise the closest hostile,
 * with ties broken to the lower index for determinism.
 */
describe("pickTowerTarget (spec 07 tower fire decision)", () => {
  it("returns null with no hostiles (no intent, no energy spent)", () => {
    expect(pickTowerTarget([])).to.equal(null);
  });

  it("picks the closer of two hostiles", () => {
    expect(pickTowerTarget([{ range: 15 }, { range: 4 }])).to.equal(1);
    expect(pickTowerTarget([{ range: 3 }, { range: 12 }])).to.equal(0);
  });

  it("breaks ties to the lower index (determinism)", () => {
    expect(pickTowerTarget([{ range: 7 }, { range: 7 }, { range: 7 }])).to.equal(0);
  });
});

/**
 * Peace-time repair decision (owner directive 2026-07-19): the most-decayed
 * in-range structure below the REPAIR_TO ceiling, by hits FRACTION so roads and
 * containers of different hitsMax rank fairly, ties to the lower index.
 */
describe("pickTowerRepairTarget (peace-time road/container repair)", () => {
  it("returns null when there is nothing to repair", () => {
    expect(pickTowerRepairTarget([])).to.equal(null);
  });

  it("ignores structures already at the REPAIR_TO ceiling", () => {
    // A full road (hits == hitsMax) and one exactly at the ceiling: no repair.
    expect(
      pickTowerRepairTarget([
        { range: 3, hits: 5000, hitsMax: 5000 },
        { range: 3, hits: Math.ceil(5000 * REPAIR_TO), hitsMax: 5000 },
      ])
    ).to.equal(null);
  });

  it("gates on range: a decayed structure past TOWER_REPAIR_RANGE is skipped", () => {
    expect(
      pickTowerRepairTarget([{ range: TOWER_REPAIR_RANGE + 1, hits: 100, hitsMax: 5000 }])
    ).to.equal(null);
    // ...but exactly at the range boundary is still eligible.
    expect(
      pickTowerRepairTarget([{ range: TOWER_REPAIR_RANGE, hits: 100, hitsMax: 5000 }])
    ).to.equal(0);
  });

  it("picks the lowest hits FRACTION, not the lowest absolute hits", () => {
    // A 90% road (4500/5000) has far fewer absolute hits than a 55% container
    // (137500/250000) but a healthier fraction - the container must win.
    expect(
      pickTowerRepairTarget([
        { range: 4, hits: 4500, hitsMax: 5000 }, // road, 90%, lowest ABSOLUTE
        { range: 4, hits: 137500, hitsMax: 250000 }, // container, 55%, worst FRACTION
      ])
    ).to.equal(1);
  });

  it("breaks fraction ties to the lower index (determinism)", () => {
    expect(
      pickTowerRepairTarget([
        { range: 6, hits: 2500, hitsMax: 5000 },
        { range: 2, hits: 2500, hitsMax: 5000 },
      ])
    ).to.equal(0);
  });

  it("skips an out-of-range wreck in favour of a healthier in-range one", () => {
    // The 20% road is out of range; the 70% container is in range - the tower
    // repairs what it can reach, leaving the far wreck to the builder fleet.
    expect(
      pickTowerRepairTarget([
        { range: 15, hits: 1000, hitsMax: 5000 }, // 20%, OUT of range
        { range: 5, hits: 175000, hitsMax: 250000 }, // 70%, in range
      ])
    ).to.equal(1);
  });
});
