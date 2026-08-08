import { expect } from "chai";
import { scavengeOutflowSplit } from "../../../scripts/waste-ledger";

/**
 * THE PILE'S OUTFLOW SPLIT (audit cycle t72866607).
 *
 * L1's top line is ground pile decay: 18.68 e/t against a budget of 0.00, 16% of
 * the colony's whole mining capacity. The SCAV row judges each scavenger on
 * net-energy-per-spawn-part against the marginal funded route — and pile DECAY
 * appears nowhere in that comparison, so the row read `ok` while four stocks of
 * 1,896-3,992 energy sat under 1-4 CARRY of planned drain.
 *
 * A ground pile is a WASTING asset: the engine takes `ceil(amount/1000)` every
 * tick regardless of what we do. So the decision-facing number is not "is this
 * scavenger efficient" but "of everything leaving this pile, how much do we
 * catch and how much does the engine take". That is a split of one outflow, and
 * it is what this instrument publishes.
 *
 * Measured on the live stocks: the current `scavengeRate` law (amount/2 over a
 * full creep life) plans 0.68-1.38 e/t against decay of 2-4 e/t — it concedes
 * 62% of every pile, which is why `recycled why: eol-tail 100%` and not
 * `scavenge-drained`: the scavengers age out, the piles never clear.
 */
describe("scavengeOutflowSplit - decay is a term in the pile's economics", () => {
  it("splits the pile's outflow between what we collect and what the engine takes", () => {
    // 3452e standing decays at ceil(3452/1000) = 4 e/t; the law plans ~1.19 e/t.
    const s = scavengeOutflowSplit(3452, 1.19);
    expect(s.decayRate).to.equal(4);
    expect(s.drainRate).to.equal(1.19);
    expect(s.collectedShare).to.be.closeTo(1.19 / (1.19 + 4), 1e-9);
    expect(s.concededShare).to.be.closeTo(4 / (1.19 + 4), 1e-9);
    // The headline: the engine is taking the majority of this pile.
    expect(s.losing).to.equal(true);
  });

  it("is not losing once the drain outpaces the decay", () => {
    const s = scavengeOutflowSplit(3452, 12);
    expect(s.losing).to.equal(false);
    expect(s.collectedShare).to.be.greaterThan(0.5);
  });

  it("uses the ENGINE's ceil rule, not a linear 1/1000 - the floor is what makes small piles expensive", () => {
    // 1e standing still costs a full 1 e/t: ceil(1/1000) = 1. Eleven such piles
    // are 11 e/t of pure floor, which is the spec-44 focus-fire census point.
    expect(scavengeOutflowSplit(1, 0).decayRate).to.equal(1);
    expect(scavengeOutflowSplit(1000, 0).decayRate).to.equal(1);
    expect(scavengeOutflowSplit(1001, 0).decayRate).to.equal(2);
  });

  it("a fully drained pile has no outflow to split (guards the 0/0)", () => {
    const s = scavengeOutflowSplit(0, 0);
    expect(s.decayRate).to.equal(0);
    expect(s.collectedShare).to.equal(0);
    expect(s.concededShare).to.equal(0);
    expect(s.losing).to.equal(false);
  });

  it("credits the whole outflow to collection when nothing is decaying", () => {
    const s = scavengeOutflowSplit(0, 5);
    expect(s.collectedShare).to.equal(1);
    expect(s.concededShare).to.equal(0);
  });
});
