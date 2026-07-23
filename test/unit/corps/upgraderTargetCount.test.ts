import { expect } from "chai";
import "../../../src/types/Memory";
import { upgraderAllocation, upgraderSizing, upgraderTargetCount } from "../../../src/corps/UpgradingCorp";
import { WARCHEST_TARGET, feederRelayRate } from "../../../src/economy/bank";
import { sustainableConsumptionRate } from "../../../src/economy/primitives";

/**
 * The upgrader COUNT ceiling. Sized to consume the controller allocation, but
 * capped tightly at RCL <= 2 so a swarm of upgraders can't starve the tiny spawn
 * network into the runt death-spiral that stalls RCL2 (validated in the cold-start
 * harness: uncapped the controller gets 0 cp/tick; capped it ramps).
 */
describe("upgraderTargetCount", () => {
  const PARKING = 8; // plenty of ring tiles - not the binding constraint here

  it("sizes to the allocation at the affordable body size", () => {
    // 10 e/tick allocated, 2 WORK affordable -> 5 upgraders (RCL3+, no RCL cap).
    expect(upgraderTargetCount(10, 2, PARKING, 3)).to.equal(5);
  });

  it("caps the count at RCL <= 2 even when the allocation wants more", () => {
    // Same 10/2 = 5 demand, but at RCL2 the ceiling is 3 (the spiral fix).
    expect(upgraderTargetCount(10, 2, PARKING, 2)).to.equal(3);
    expect(upgraderTargetCount(10, 2, PARKING, 1)).to.equal(3);
  });

  it("does not impose an RCL ceiling when the controller level is unknown", () => {
    // No controller in view (the unit harness) -> allocation alone drives it.
    expect(upgraderTargetCount(10, 2, PARKING, undefined)).to.equal(5);
  });

  it("never exceeds the hard safety cap", () => {
    expect(upgraderTargetCount(1000, 1, PARKING, 5)).to.equal(8);
  });

  it("never exceeds the available parking ring", () => {
    expect(upgraderTargetCount(10, 2, 2, 5)).to.equal(2); // only 2 ring tiles
  });

  it("always fields at least one upgrader so the controller is never abandoned", () => {
    expect(upgraderTargetCount(0, 2, PARKING, 2)).to.equal(1);
  });
});

/**
 * The upgrader ENERGY allocation (stock-grounded sizing, spec 03 surplus half).
 * The plan says what SHOULD flow to the controller; the work-site stock says
 * what DID. While the warchest fills, upgraders sip (floor trickle inflow) so
 * the bank actually accumulates; once the bank is in SURPLUS and a feeder
 * relays it, the relay rate is real measured-shape inflow and the fleet scales
 * up to planAllocated - that is what spends a 100k bank on the controller.
 */
describe("upgraderAllocation", () => {
  it("trusts the plan when the stock is unmeasurable (no controller in view)", () => {
    expect(upgraderAllocation(12, null, null)).to.equal(12);
  });

  it("save regime: sips from the local stock while the warchest fills", () => {
    // 2000 staged at the input, bank below target behind the feeder: the
    // pinned pre-surplus behavior - 2 + 2000/1500 ~ 3.33, NOT the plan's 15.
    expect(upgraderAllocation(15, 2000, 10_000)).to.be.closeTo(sustainableConsumptionRate(2000, 2), 1e-9);
  });

  it("save regime: no feeder relay behind the stock behaves identically", () => {
    expect(upgraderAllocation(15, 2000, null)).to.be.closeTo(sustainableConsumptionRate(2000, 2), 1e-9);
  });

  it("surplus regime: sized from ACTUALS - the plan is not a cap (prod t72448020)", () => {
    const banked = WARCHEST_TARGET + 100_000;
    // The old pin let the plan cap the surplus fleet; live, a
    // parts-exhausted fill pinned planAllocated at the reserve 2 while
    // stock 2000 + relay + 234k banked stood ready - the goal-plan cap
    // held the burn at 2 e/t forever. Macro doctrine: consumers are sized
    // from actual stock at the work site, never from the goal plan; the
    // NOW-walk arbitrates spawn feasibility. In surplus BOTH calls now
    // return the shared-primitives actuals formula, plan number ignored.
    const actuals = sustainableConsumptionRate(2000, feederRelayRate(banked));
    expect(upgraderAllocation(30, 2000, banked)).to.be.closeTo(actuals, 1e-9);
    expect(upgraderAllocation(999, 2000, banked)).to.be.closeTo(actuals, 1e-9);
  });

  it("never sizes below the anti-downgrade floor", () => {
    expect(upgraderAllocation(15, 0, null)).to.equal(2);
  });

  it("surplus + a build-out that absorbs the whole draw: the plan is the cap again (owner 2026-07-21)", () => {
    // "Construction is going to be an investment in our future upgrading
    // abilities" - when the standing sites can genuinely EAT the surplus
    // (constructionAbsorb >= the draw), the surplus belongs to the build
    // set and upgraders eat the plan's residual (min(plan, sustainable)),
    // exactly the save-regime shape. Same absorb lens as the feeder
    // (buildPoolAbsorbRate), so the chain cannot fight itself.
    const banked = WARCHEST_TARGET + 100_000;
    const surplusDraw = feederRelayRate(banked);
    const clamped = upgraderAllocation(12, 2000, banked, surplusDraw + 10);
    expect(clamped).to.be.at.most(12);
    // and without construction the unclamped actuals still rule:
    expect(upgraderAllocation(12, 2000, banked, 0)).to.be.greaterThan(12);
  });

  it("surplus + construction absorbing only a trickle: the fleet eats the REST of the surplus (prod t72478939)", () => {
    // The boolean form of this clamp treated 12 road sites (pool absorb
    // ~5 e/t) exactly like a 100k build-out: allocated pinned at the plan
    // residual 2 while surplus 115 stood and the build side ran 0.47 e/t
    // measured - the freed energy BANKED (+20.18/t at 474k, 17x target).
    // Construction-first, absorb-bounded: the build set eats what it CAN
    // (the same projectAbsorbRate lens that sizes the crew and the plan's
    // construction sink); the upgraders are sized to the remaining share
    // as their inflow - the same relay the feeder will actually run.
    const banked = WARCHEST_TARGET + 446_493; // prod t72478939
    const poolAbsorb = 5; // 12 road sites, 3225 work remaining
    const share = feederRelayRate(banked) - poolAbsorb; // 110
    const { allocated, inflow } = upgraderSizing(2, 1607, banked, poolAbsorb);
    expect(inflow, "inflow = the feeder's absorb-bounded relay").to.be.closeTo(share, 1e-9);
    expect(allocated).to.be.closeTo(sustainableConsumptionRate(1607, share), 1e-9);
    // never again the incident shape: allocated 2 with 110 e/t of unabsorbed surplus
    expect(allocated).to.be.greaterThan(100);
  });

  it("exports its surplus verdict, the same lens the demand's holdToFund reads (incident t72503018)", () => {
    // One computation, two readers (the staffsPost symmetry rule): the sizing
    // that scales the fleet up under a bank surplus and the demand flag that
    // lets those scaling bodies actually FUND at the spawn must read the same
    // verdict, or the corp demands a fleet the walk never finances - measured
    // 2026-07-22: allocated 110.5 / targetCount 6 with staffing frozen at 2
    // for 2600+ ticks, 191k idle (6.9x target), delivery 0.39x plan.
    expect(upgraderSizing(2, 1607, WARCHEST_TARGET + 163_513, 0).surplus).to.equal(true);
    expect(upgraderSizing(2, 1607, 10_000, 0).surplus, "warchest still filling: save regime").to.equal(false);
    expect(upgraderSizing(2, 1607, null, 0).surplus, "no active feeder relay").to.equal(false);
    expect(upgraderSizing(2, null, null, 0).surplus, "unmeasurable stock trusts the plan, no hold").to.equal(false);
  });
});
