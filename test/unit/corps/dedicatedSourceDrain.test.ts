import { expect } from "chai";
import "../../../src/types/Memory";
import { shouldDrainDedicatedSource } from "../../../src/corps/CarryCorp";

// The fix for "a hauler stands idle next to a growing ground pile": a hauler on the
// build-reserved source must RESUME hauling once energy backs up - whether that
// surplus sits in a container OR on the ground (a bare-pile source, which the old
// container-only check missed entirely).
describe("CarryCorp.shouldDrainDedicatedSource", () => {
  it("yields (no drain) while a container is below the drain fill and no ground pile", () => {
    expect(shouldDrainDedicatedSource(900, 2000, 0)).to.equal(false); // 45% < 50%
  });

  it("drains once the container passes the drain fill", () => {
    expect(shouldDrainDedicatedSource(1000, 2000, 0)).to.equal(true); // 50%
    expect(shouldDrainDedicatedSource(1500, 2000, 0)).to.equal(true);
  });

  it("drains a bare ground pile once it is substantial (no container)", () => {
    // the screenshot case: no container, big pile under the miner, hauler must work
    expect(shouldDrainDedicatedSource(null, 0, 300)).to.equal(true);
    expect(shouldDrainDedicatedSource(null, 0, 1500)).to.equal(true);
  });

  it("keeps yielding for a small ground pile the builder can still absorb", () => {
    expect(shouldDrainDedicatedSource(null, 0, 100)).to.equal(false);
    expect(shouldDrainDedicatedSource(null, 0, 0)).to.equal(false);
  });

  it("drains when EITHER the container or the ground pile is backing up", () => {
    // container low but a pile has formed beside it -> still drain
    expect(shouldDrainDedicatedSource(200, 2000, 400)).to.equal(true);
    // both low -> yield
    expect(shouldDrainDedicatedSource(200, 2000, 50)).to.equal(false);
  });
});
