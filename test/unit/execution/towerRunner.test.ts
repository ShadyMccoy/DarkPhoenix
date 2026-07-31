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

/**
 * THE REFILL/REPAIR DEADLOCK (owner 2026-07-30: "the tower should repair the
 * nearby roads anyways as well" - it largely was not).
 *
 * Two thresholds were the SAME number by coincidence, with mutually exclusive
 * comparisons, leaving a dead point the tower converges on exactly:
 *   - runTowers repairs only while `energy > TOWER_REPAIR_RESERVE` (500);
 *   - towerNeedsFill refilled only while `energy < capacity * 0.5` (also 500,
 *     since TOWER_CAPACITY is 1000).
 * A repair action costs exactly TOWER_ENERGY_COST (10), so a full tower walks
 * 1000 -> 990 -> ... -> EXACTLY 500 and then can neither repair (500 is not
 * > 500) nor be refilled (500 is not < 500). It is not a probabilistic stall:
 * the arithmetic lands on the dead point every time. Only a raid - which
 * spends 10/shot and pushes it below 500 - ever unsticks it, which is why the
 * tower appeared to work intermittently while roads decayed to the builder.
 *
 * The fix is the COUPLING, not either number: the refill threshold must sit
 * strictly ABOVE the defensive reserve, so that draining to the reserve
 * triggers a refill and peace-time repair always has budget above it.
 */
describe("tower refill/repair coupling (the 500/500 dead point)", () => {
  const { towerNeedsFill } = require("../../../src/corps/ExtensionTenderCorp");
  const { TOWER_REPAIR_RESERVE } = require("../../../src/execution/TowerRunner");
  const { towerRefillBelow } = require("../../../src/economy/primitives");
  const CAP = 1000; // TOWER_CAPACITY

  it("REFILLS a tower sitting exactly at the repair reserve (the dead point)", () => {
    expect(towerNeedsFill(TOWER_REPAIR_RESERVE, CAP)).to.equal(true);
  });

  it("the refill threshold sits strictly ABOVE the defensive reserve", () => {
    // This is the invariant that makes the deadlock unrepresentable: if the
    // two ever coincide again, the tower parks at the crossing point.
    expect(towerRefillBelow(CAP)).to.be.greaterThan(TOWER_REPAIR_RESERVE);
  });

  it("leaves a non-zero repair budget after a refill", () => {
    // Refilled to capacity, the energy ABOVE the reserve is what peace-time
    // repair may spend - it must buy more than a single action.
    const budget = CAP - TOWER_REPAIR_RESERVE;
    expect(budget).to.be.greaterThan(10); // TOWER_ENERGY_COST
  });

  it("still refills a nearly-empty tower, and never a full one", () => {
    expect(towerNeedsFill(0, CAP)).to.equal(true);
    expect(towerNeedsFill(CAP, CAP)).to.equal(false);
  });

  it("never asks to fill above capacity on a small tower", () => {
    // A capacity below the reserve must not make the threshold exceed it.
    expect(towerRefillBelow(200)).to.be.at.most(200);
  });
});
