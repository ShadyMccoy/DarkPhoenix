import { expect } from "chai";
import { infraSpawnEnergy, infraSpawnLoad } from "../../../src/economy/primitives";

/**
 * The two-pass solve (2026-08-01) prices the plan's standing fleet AFTER pass 1
 * and makes the spawn sink demand it in pass 2. `infraSpawnEnergy` is the
 * energy twin of `infraSpawnLoad`; the pair must stay structurally locked.
 */
describe("infraSpawnEnergy (energy twin of infraSpawnLoad)", () => {
  it("prices the SAME three details, per-class, never one averaged rate", () => {
    // Reservers are CLAIM+MOVE (325 e/part); feeder+tender are CARRY+MOVE (50).
    // A remote-only colony must therefore price far above a depot-only one of
    // the same PARTS - the whole reason a flat rate would be wrong.
    const remoteOnlyParts = infraSpawnLoad(0, 0, 4, 0);
    const remoteOnlyEnergy = infraSpawnEnergy(0, 0, 4, 0);
    expect(remoteOnlyEnergy / remoteOnlyParts).to.be.closeTo(325, 1e-6);

    const depotOnlyParts = infraSpawnLoad(0, 1, 0, 0);
    const depotOnlyEnergy = infraSpawnEnergy(0, 1, 0, 0);
    expect(depotOnlyEnergy / depotOnlyParts).to.be.closeTo(50, 1e-6);
  });

  it("is zero exactly where the parts twin is zero (no phantom infra)", () => {
    expect(infraSpawnLoad(0, 0, 0, 0)).to.equal(0);
    expect(infraSpawnEnergy(0, 0, 0, 0)).to.equal(0);
  });

  it("tracks the parts twin's link-fed feeder shrink", () => {
    const walking = infraSpawnEnergy(60, 1, 0, 0);
    const linkFed = infraSpawnEnergy(60, 1, 0, 1);
    expect(linkFed).to.be.lessThan(walking);
    // same direction and same cause as the parts side
    expect(infraSpawnLoad(60, 1, 0, 1)).to.be.lessThan(infraSpawnLoad(60, 1, 0, 0));
  });
});
