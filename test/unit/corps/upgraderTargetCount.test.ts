import { expect } from "chai";
import "../../../src/types/Memory";
import { upgraderTargetCount } from "../../../src/corps/UpgradingCorp";

/**
 * The upgrader COUNT ceiling. Sized to consume the controller allocation, but
 * capped tightly at RCL <= 2 so a swarm of upgraders can't starve the tiny spawn
 * network into the runt death-spiral that stalls RCL2 (validated in the cold-start
 * harness: uncapped the controller gets 0 cp/tick; capped it ramps).
 */
describe("upgraderTargetCount", () => {
  const PARKING = 8; // plenty of ring tiles - not the binding constraint here

  it("sizes to the allocation at the affordable body size", () => {
    // 10 e/tick allocated, 2 WORK affordable -> 5 upgraders (RCL3+, no RCL cap).
    expect(upgraderTargetCount(10, 2, PARKING, 3)).to.equal(5);
  });

  it("caps the count at RCL <= 2 even when the allocation wants more", () => {
    // Same 10/2 = 5 demand, but at RCL2 the ceiling is 3 (the spiral fix).
    expect(upgraderTargetCount(10, 2, PARKING, 2)).to.equal(3);
    expect(upgraderTargetCount(10, 2, PARKING, 1)).to.equal(3);
  });

  it("does not impose an RCL ceiling when the controller level is unknown", () => {
    // No controller in view (the unit harness) -> allocation alone drives it.
    expect(upgraderTargetCount(10, 2, PARKING, undefined)).to.equal(5);
  });

  it("never exceeds the hard safety cap", () => {
    expect(upgraderTargetCount(1000, 1, PARKING, 5)).to.equal(8);
  });

  it("never exceeds the available parking ring", () => {
    expect(upgraderTargetCount(10, 2, 2, 5)).to.equal(2); // only 2 ring tiles
  });

  it("always fields at least one upgrader so the controller is never abandoned", () => {
    expect(upgraderTargetCount(0, 2, PARKING, 2)).to.equal(1);
  });
});
