import { expect } from "chai";
import "../../../src/types/Memory";
import { tankerCarryNeededFor } from "../../../src/corps/ConstructionCorp";
import { CARRY_CAPACITY } from "../../../src/economy/primitives";

// The gait-correct, road-aware tanker sizing (owner 2026-07-28: "the sizing
// formula should be made to be correct regardless of the carry:move ratio.
// Also, it should be road-aware."). The old formula assumed a 1:1 body's
// symmetric round trip (2d+2) while the fleet is BUILT at 3C:1M (loaded leg
// 3 ticks/tile on plain, 2 on road) - the fleet under-delivered its own
// vector by ~2x on unpaved routes. Every number here is hand-derived from
// effectiveOneWayTiles' gait model: eff = (d_empty + d*loadedTicksPerTile)/2,
// RT = 2*eff + 2, carry = rate*RT/50 * 1.5 (transfer margin), ceil'd.
describe("ConstructionCorp.tankerCarryNeededFor (gait + road aware)", () => {
  const rate = 10; // e/t consumption

  it("1:1 body on any paving is the old identity (2d+2)", () => {
    // eff = d for carryPerMove 1 regardless of paving; RT = 2*10+2 = 22
    const expected = Math.ceil(((rate * 22) / CARRY_CAPACITY) * 1.5);
    expect(tankerCarryNeededFor(rate, 10, 0, 1)).to.equal(expected);
    expect(tankerCarryNeededFor(rate, 10, 1, 1)).to.equal(expected);
  });

  it("3:1 body fully unpaved doubles the effective distance (real RT 4d+2)", () => {
    // loaded 3 t/tile on plain: eff = (10 + 30)/2 = 20; RT = 42
    const expected = Math.ceil(((rate * 42) / CARRY_CAPACITY) * 1.5);
    expect(tankerCarryNeededFor(rate, 10, 0, 3)).to.equal(expected);
  });

  it("3:1 body fully paved walks loaded at 2 t/tile (RT 3d+2)", () => {
    // loaded 2 t/tile on road: eff = (10 + 20)/2 = 15; RT = 32
    const expected = Math.ceil(((rate * 32) / CARRY_CAPACITY) * 1.5);
    expect(tankerCarryNeededFor(rate, 10, 1, 3)).to.equal(expected);
  });

  it("partial paving interpolates between the two", () => {
    // f=0.5: loaded = 5*2 + 5*3 = 25; eff = (10+25)/2 = 17.5; RT = 37
    const expected = Math.ceil(((rate * 37) / CARRY_CAPACITY) * 1.5);
    expect(tankerCarryNeededFor(rate, 10, 0.5, 3)).to.equal(expected);
  });

  it("more paving never asks for more carry (monotone)", () => {
    for (let f = 0; f < 1; f += 0.25) {
      expect(tankerCarryNeededFor(20, 15, f + 0.25, 3)).to.be.at.most(tankerCarryNeededFor(20, 15, f, 3));
    }
  });

  it("the unpaved 3:1 fleet is ~2x the old 1:1-assumption fleet at distance", () => {
    const honest = tankerCarryNeededFor(20, 20, 0, 3);
    const oldFormula = Math.ceil(((20 * (2 * 20 + 2)) / CARRY_CAPACITY) * 1.5);
    expect(honest / oldFormula).to.be.greaterThan(1.8);
  });
});
