import { expect } from "chai";
import { isSpawnNetworkCritical } from "../../../src/corps/CarryCorp";

/**
 * The controller-starve fix (grid cells haul-t1-circuit-split /
 * plan-t1-single-source-loop): "critically low" must account for energy
 * already aboard fleet-mates committed to the spawn this trip. The raw
 * store-only 50% gate diverted the controller-homed hauler on EVERY flip
 * during buildout (the bank lives below 50% while spawning), so the flow
 * solver's controller allocation - including the 2 e/t anti-downgrade
 * reserve - was never physically delivered: controller progress measured at
 * ZERO for 700+ ticks at realistic source distance.
 *
 * Mutation check: revert spawnNetworkCritical to `used / cap < 0.5` (ignore
 * inbound) and exactly the inbound-coverage cases below fail.
 */
describe("isSpawnNetworkCritical (controller-starve guard)", () => {
  it("true emergency: bank low and nothing inbound diverts", () => {
    expect(isSpawnNetworkCritical(100, 300, 0)).to.equal(true);
    expect(isSpawnNetworkCritical(0, 300, 0)).to.equal(true);
  });

  it("not critical once inbound committed cargo covers the deficit", () => {
    // The diag-circuit trace: bank at 55/300 but two spawn-circuit haulers
    // inbound with 400 aboard - diverting the controller hauler adds nothing.
    expect(isSpawnNetworkCritical(55, 300, 400)).to.equal(false);
    // Exactly reaching the 50% line is NOT critical (strict less-than).
    expect(isSpawnNetworkCritical(100, 300, 50)).to.equal(false);
  });

  it("still critical when inbound only partially covers", () => {
    expect(isSpawnNetworkCritical(50, 300, 60)).to.equal(true); // 110/300 < 0.5
  });

  it("a comfortable bank never diverts regardless of inbound", () => {
    expect(isSpawnNetworkCritical(200, 300, 0)).to.equal(false);
    expect(isSpawnNetworkCritical(300, 300, 0)).to.equal(false);
  });

  it("degenerate capacity is never critical", () => {
    expect(isSpawnNetworkCritical(0, 0, 0)).to.equal(false);
  });
});
