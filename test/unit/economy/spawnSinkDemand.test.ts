import { expect } from "chai";
import { fleetEnergyPerPart, spawnSinkDemand } from "../../../src/economy/flowAdapter";
import { spawnEnergyCeiling } from "../../../src/economy/primitives";

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

  /**
   * THE PHYSICAL CEILING (P12 plan-side unification, t72773737). The engine
   * assembles at most SPAWN_PARTS_PER_TICK (1/3) parts per spawn per tick,
   * each paid at the fleet's own mean energy-per-part - so a spawn sink can
   * CONVERT at most ~e/p / 3 energy/tick into bodies, ever. The funding rate
   * knows no such bound: hold-to-fund queued 5,100e of full-share bodies,
   * FUND_HORIZON (50) turned that into a 102 e/t claim on a spawn that
   * physically converts ~25, the solver (spawn = top of the value ladder)
   * dutifully fed it from a 156.61 e/t gross bank draw, 101.45 round-tripped
   * back to storage on paper, and the published controller allocation sat at
   * 39.64 against its own bankFedControllerRate cap of 59.04. The claim must
   * be capped at what the spawn can physically convert - the network's own
   * stock (thousands of energy at RCL7) is the pre-fund buffer for any single
   * big body; a CONTINUOUS super-physical claim is never real.
   */
  describe("the physical conversion ceiling (t72773737: claim 102 vs convertible ~25)", () => {
    it("caps the funding-rate claim at the spawn's conversion ceiling", () => {
      // fleet mix 76 e/p -> ceiling 76/3 = 25.33; the 102 e/t claim is paper.
      expect(spawnSinkDemand(10, 11, 102, spawnEnergyCeiling(76))).to.be.closeTo(25.33, 0.01);
    });

    it("does not bind ordinary claims below the ceiling", () => {
      // ceiling 100/3 = 33.3: a real 32 e/t banking wave passes untouched.
      expect(spawnSinkDemand(10, 25.12, 32, spawnEnergyCeiling(100))).to.equal(32);
    });

    it("caps even the fleet charge - a super-physical charge is a P4 infeasibility, not a bigger claim", () => {
      // A converged charge of 40 e/t against a 25.33 ceiling describes a fleet
      // this spawn cannot maintain; routing 40 anyway parks the excess in the
      // network (the t72773737 shape). The sink claims physics; P4 flags the plan.
      expect(spawnSinkDemand(10, 40, 0, spawnEnergyCeiling(76))).to.be.closeTo(25.33, 0.01);
    });

    it("no ceiling given = legacy behavior (cold start before the first solve publishes e/p)", () => {
      expect(spawnSinkDemand(10, 11, 102)).to.equal(102);
    });

    it("spawnEnergyCeiling floors the mix at the cheapest part so a degenerate e/p never zeroes a sink", () => {
      expect(spawnEnergyCeiling(0)).to.be.closeTo(50 / 3, 0.01);
      expect(spawnEnergyCeiling(76)).to.be.closeTo(76 / 3, 0.01);
    });
  });

  /**
   * The e/p the ceiling prices is the PLAN'S OWN fleet mix - fleet energy
   * (converged charge x spawns) over the parts ledger's planned parts - and
   * it threads solve-to-solve through Memory exactly like the charge itself
   * (Memory.lastFleetCharge): unknown on a cold start (undefined -> no cap,
   * legacy behavior for exactly one solve), known ever after.
   */
  describe("fleetEnergyPerPart (the ceiling's mix input)", () => {
    it("divides fleet energy by the parts ledger's planned parts", () => {
      // t72773737 shape: ~22.15 e/t of fleet over ~0.29 p/t -> ~76 e/p.
      expect(fleetEnergyPerPart(22.15, { minerLoad: 0.055, infra: 0.027, spent: 0.209 })).to.be.closeTo(76.1, 0.5);
    });

    it("returns undefined without a ledger or with degenerate totals (no cap rather than a wrong one)", () => {
      expect(fleetEnergyPerPart(22.15, undefined)).to.equal(undefined);
      expect(fleetEnergyPerPart(0, { minerLoad: 0.1, infra: 0, spent: 0 })).to.equal(undefined);
      expect(fleetEnergyPerPart(22.15, { minerLoad: 0, infra: 0, spent: 0 })).to.equal(undefined);
    });
  });
});
