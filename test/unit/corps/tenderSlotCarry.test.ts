import { expect } from "chai";
import "../../../src/types/Memory";
import { tenderSlotCarry } from "../../../src/corps/ExtensionTenderCorp";

/**
 * Per-slot tender sizing (P4 tip, t72459426): sizing EVERY tender to the
 * BIGGEST cluster fielded 3x46p = 138p (0.092 parts/t) for a 2300 bank and
 * pushed the plan to 1.05x the spawn ceiling - the first P4 FAIL since the
 * ledger existed. Slot k is sized for the cluster it will serve
 * (runTenders assigns clusters[i % len] in the same order), floored at an
 * equal share of one full bank wave so combined carry still covers a full
 * drain (the RCL2-3 coverage incident, pipeline t=1553).
 */
describe("tenderSlotCarry (per-cluster bodies, one-wave coverage floor)", () => {
  // Live shape: clusters 22/9/9 extensions, bank 2300, maxCarry 23, target 3.
  const CLUSTERS = [22, 9, 9];
  const BANK = 2300;
  const MAX = 23;

  it("slot 0 carries its (biggest) cluster in one trip", () => {
    expect(tenderSlotCarry(CLUSTERS, 0, 3, BANK, MAX)).to.equal(23); // 22+1 at the cap
  });

  it("small-cluster slots get small bodies, floored at the equal share of one wave", () => {
    // cluster 9 -> 10 carry, but the one-wave share floor is ceil(2300/3/50)=16.
    expect(tenderSlotCarry(CLUSTERS, 1, 3, BANK, MAX)).to.equal(16);
    expect(tenderSlotCarry(CLUSTERS, 2, 3, BANK, MAX)).to.equal(16);
  });

  it("combined fleet still covers a full bank drain in one wave", () => {
    const total = [0, 1, 2].reduce((s, k) => s + tenderSlotCarry(CLUSTERS, k, 3, BANK, MAX), 0);
    expect(total * 50).to.be.at.least(BANK);
  });

  it("never exceeds maxCarry and never goes below 1", () => {
    expect(tenderSlotCarry([40], 0, 1, 2300, 23)).to.equal(23);
    expect(tenderSlotCarry([], 0, 1, 300, 4)).to.be.at.least(1);
  });
});
