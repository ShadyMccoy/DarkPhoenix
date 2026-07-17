import { expect } from "chai";
import { pickTowerTarget } from "../../../src/execution/TowerRunner";

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
