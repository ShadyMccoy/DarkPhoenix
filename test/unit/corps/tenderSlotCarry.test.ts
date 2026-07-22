import { expect } from "chai";
import "../../../src/types/Memory";
import { tenderSlotCarry } from "../../../src/corps/ExtensionTenderCorp";

/**
 * Per-slot tender sizing, EQUAL SHARE (owner 2026-07-22: "split the same
 * amount of body parts across two or three creeps - that's gonna help with
 * the rates while still alleviating the spawn capacity"). Every slot gets
 * an equal share of ONE full bank wave, so the fleet's combined carry
 * covers a whole drain and raising the count splits the same total across
 * more coverage points instead of inflating it. History pinned: sizing
 * every body to the BIGGEST cluster fielded 3x46p = 138p for a 2300 bank
 * (t72459426, the first P4 FAIL); the later per-cluster slot term
 * re-inflated bodies whenever a cluster was large - a specific cluster's
 * coverage is the route's job, not the body's.
 */
describe("tenderSlotCarry (equal-share split of one bank wave)", () => {
  // Live shape: clusters 22/9/9 extensions, bank 2300, maxCarry 23.
  const CLUSTERS = [22, 9, 9];
  const BANK = 2300;
  const MAX = 23;

  it("every slot gets the equal share - cluster size never inflates a body", () => {
    // ceil(2300 / 3 / 50) = 16 carry each, big cluster or small.
    expect(tenderSlotCarry(CLUSTERS, 0, 3, BANK, MAX)).to.equal(16);
    expect(tenderSlotCarry(CLUSTERS, 1, 3, BANK, MAX)).to.equal(16);
    expect(tenderSlotCarry(CLUSTERS, 2, 3, BANK, MAX)).to.equal(16);
  });

  it("combined fleet still covers a full bank drain in one wave", () => {
    const total = [0, 1, 2].reduce((s, k) => s + tenderSlotCarry(CLUSTERS, k, 3, BANK, MAX), 0);
    expect(total * 50).to.be.at.least(BANK);
  });

  it("SAME TOTAL at any count: 2 slots carry ~what 3 slots carry, split differently", () => {
    const at2 = [0, 1].reduce((s, k) => s + tenderSlotCarry(CLUSTERS, k, 2, BANK, MAX), 0);
    const at3 = [0, 1, 2].reduce((s, k) => s + tenderSlotCarry(CLUSTERS, k, 3, BANK, MAX), 0);
    // 2x23 = 46 vs 3x16 = 48 - within one body's rounding of each other.
    expect(Math.abs(at3 - at2)).to.be.at.most(2);
  });

  it("never exceeds maxCarry and never goes below 1", () => {
    expect(tenderSlotCarry([40], 0, 1, 2300, 23)).to.equal(23);
    expect(tenderSlotCarry([], 0, 1, 300, 4)).to.be.at.least(1);
  });
});
