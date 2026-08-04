import { expect } from "chai";
import { carryPartsFor, operationSpawnLoad, effectiveLife, vectorSupplyParts } from "../../../src/economy/primitives";
import {
  effectiveOneWayTiles,
  tankerCarryNeededFor,
  vectorSupplyPartsGait
} from "../../../src/economy/roadEconomics";

/**
 * VECTOR-GAIT FOLLOW-UP B (spec 34, flagged 2026-07-28; the F1 term the plan
 * still under-priced).
 *
 * The RUNTIME sizes the construction supply vector gait- and road-aware
 * (tankerCarryNeededFor: the 3C:1M body's REAL loaded leg over the route's
 * paved fraction, x1.5 transfer margin) - that landed with the owner's "the
 * sizing formula should be made to be correct regardless of the carry:move
 * ratio" ruling. But the PLAN's price for the same vector (vectorSupplyParts
 * inside operationSpawnLoad -> the commission's all-in spawnPartsPerTick)
 * kept the 1:1-laden-both-ways model - so every build campaign fields a
 * bigger tanker fleet than its commission declares, and F1 books the
 * difference as an unexplained breach. One formula, one home: the sizing
 * moves from ConstructionCorp into economy/roadEconomics (beside the gait
 * lens it reads), and the commission's price feeds through
 * operationSpawnLoad's `parts` field.
 */
describe("vector gait: the plan prices the body the runtime actually fields", () => {
  it("tankerCarryNeededFor keeps the runtime's exact arithmetic in the formula home", () => {
    const expected = Math.ceil(carryPartsFor(10, effectiveOneWayTiles(20, 0, 3)) * 1.5);
    expect(tankerCarryNeededFor(10, 20, 0, 3)).to.equal(expected);
  });

  it("prices a 3:1 unpaved vector ABOVE the 1:1 model (the under-pricing dies)", () => {
    const naive = 2 * carryPartsFor(10, 20);
    expect(vectorSupplyPartsGait(10, 20, 0, 3)).to.be.greaterThan(naive);
  });

  it("prices the gait vector as the runtime's carry plus its MOVE share", () => {
    const carry = tankerCarryNeededFor(10, 20, 0, 3);
    expect(vectorSupplyPartsGait(10, 20, 0, 3)).to.equal(carry + Math.ceil(carry / 3));
  });

  it("operationSpawnLoad amortizes a precomputed gait vector through `parts`", () => {
    const parts = vectorSupplyPartsGait(10, 20, 0, 3);
    expect(operationSpawnLoad(0.01, [{ rate: 10, distance: 20, parts }])).to.be.closeTo(
      0.01 + parts / effectiveLife(20),
      1e-9
    );
  });

  it("stays bit-identical to the old model when no gait is given (nothing moves elsewhere)", () => {
    expect(vectorSupplyParts(10, 20)).to.equal(2 * carryPartsFor(10, 20));
    expect(operationSpawnLoad(0.5, [{ rate: 3, distance: 7 }])).to.be.closeTo(
      0.5 + (2 * carryPartsFor(3, 7)) / effectiveLife(7),
      1e-9
    );
  });
});
