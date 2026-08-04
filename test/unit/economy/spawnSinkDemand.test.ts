import { expect } from "chai";
import { spawnSinkDemand } from "../../../src/economy/flowAdapter";

/**
 * THE SPAWN SINK'S DEMAND: ONE upkeep estimate, never a sum (t72749493).
 *
 * Two terms both estimate "energy/tick the spawn must receive": the
 * fixed-point FLEET CHARGE (spawnMaintenance - steady-state upkeep of the
 * plan's fleet) and the AGENDA FUNDING RATE (queued must-fund bodies
 * amortized over FUND_HORIZON - the same upkeep seen as cash-flow timing:
 * the bodies in the queue ARE the replacements the charge prices). Summing
 * them double-claims the flow. Pre-hold-to-fund the double-count was
 * dribble-sized (minCost-300 entries kept fundingNeed small); full-share
 * holds made it 58 e/t: measured at t72749493, spawn sinks routed 108.25
 * e/t (charge 50.29 + funding 57.96) against 41.5 actually spent, and the
 * controller allocation sat starved at 16.56 for 1500+ ticks while the
 * standing 75-WORK fleet decayed toward it - the plan locked in a wrong
 * equilibrium by its own accounting fiction.
 *
 * The MAX is the honest combinator: a holds-heavy moment claims the funding
 * rate (it exceeds the steady charge exactly when a purchase wave is
 * banking), steady state claims the charge, and the flow is never claimed
 * twice.
 */
describe("spawnSinkDemand (one upkeep estimate - max, never sum)", () => {
  it("steady state: the fleet charge wins over the base overhead", () => {
    expect(spawnSinkDemand(10, 25.12, 0)).to.equal(25.12);
  });

  it("a holds-heavy moment: the funding rate wins WITHOUT stacking on the charge (the t72749493 lock)", () => {
    // charge 25.12, funding 32 (fundingNeed 1600 / 50): the old sum claimed
    // 57.12; the demand is 32 - the banking wave IS the upkeep arriving.
    expect(spawnSinkDemand(10, 25.12, 32)).to.equal(32);
  });

  it("a small funding dribble under the charge adds NOTHING (was: every dribble stacked)", () => {
    expect(spawnSinkDemand(10, 25.12, 6)).to.equal(25.12);
  });

  it("floors at the base overhead demand and never below 1", () => {
    expect(spawnSinkDemand(10, 0, 0)).to.equal(10);
    expect(spawnSinkDemand(0, 0, 0)).to.equal(1);
  });
});
