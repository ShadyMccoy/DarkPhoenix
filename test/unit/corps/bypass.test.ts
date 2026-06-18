/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals } from "../mock";
import { isYielding } from "../../../src/corps/movement";

/**
 * isYielding is the swap rule's gate: ONLY a parked upgrader sitting on its own
 * assigned tile is safe to swap through (it has no move intent and walks back
 * next tick). A hauler, a miner, or an upgrader not yet on its tile must never be
 * yanked aside.
 */
describe("isYielding (bypass swap gate)", () => {
  beforeEach(() => setupGlobals());

  const make = (over: any) => ({
    my: true,
    pos: { x: 10, y: 10 },
    memory: { workType: "upgrade", upgradeSpot: { x: 10, y: 10 } },
    ...over
  });

  it("yields for a parked upgrader on its own upgrade tile", () => {
    expect(isYielding(make({}))).to.equal(true);
  });

  it("does not yield for an upgrader not yet on its assigned tile", () => {
    expect(isYielding(make({ pos: { x: 11, y: 10 } }))).to.equal(false);
  });

  it("does not yield for an upgrader with no assigned tile", () => {
    expect(isYielding(make({ memory: { workType: "upgrade" } }))).to.equal(false);
  });

  it("does not yield for a hauler (different workType)", () => {
    expect(isYielding(make({ memory: { workType: "haul", upgradeSpot: { x: 10, y: 10 } } }))).to.equal(false);
  });

  it("does not yield for an enemy creep on its tile", () => {
    expect(isYielding(make({ my: false }))).to.equal(false);
  });
});
