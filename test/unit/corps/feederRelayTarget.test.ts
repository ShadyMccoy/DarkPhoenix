import { expect } from "chai";
import "../../../src/types/Memory";
import { feederRelayTarget } from "../../../src/corps/ControllerFeederCorp";
import { WARCHEST_TARGET, bankSurplusRate, feederRelayRate } from "../../../src/economy/bank";

/**
 * The feeder's relay sizing across the two bank regimes (prod t72455355).
 *
 * SURPLUS: consumers size from ACTUALS, never the goal plan (macro doctrine -
 * the upgrader half landed at daec503; this is its SUPPLY LINE). Live shape:
 * 340k banked, plan controller allocation 2 (partsLeft exhausted before the
 * controller sink), feeder clamped to relay 7 while the upgraders' sizing
 * assumed the surplus 115 - stock drained 1520 -> 60 and burn ran 11 of a
 * possible 115. In surplus the plan is NOT a cap on the relay.
 *
 * NON-SURPLUS: the plan clamp STAYS (owner t72421124: while construction
 * preempts the bank the controller legitimately floors at ~2 e/t, and a
 * feeder sized to the raw surplus formula is 90+ wasted parts). The regimes
 * are discriminated by bankSurplusRate, the same primitive the upgraders and
 * the bank draw use - one lens, no drift.
 */
describe("feederRelayTarget (the relay serves actuals in surplus, the plan otherwise)", () => {
  const PLAN_FLOOR = 2; // the exhausted-ledger controller allocation, live shape

  it("SURPLUS: ignores the plan clamp - the relay delivers the inflow the upgraders assume", () => {
    const banked = WARCHEST_TARGET + 312_715; // prod t72455355
    expect(bankSurplusRate(banked), "precondition: this IS the surplus regime").to.be.greaterThan(0);
    const surplusRate = feederRelayRate(banked);
    expect(feederRelayTarget(surplusRate, PLAN_FLOOR, banked)).to.equal(surplusRate);
  });

  it("SURPLUS + a build-out that absorbs the whole draw: the plan clamp returns (owner 2026-07-21: upgrading is secondary to construction)", () => {
    // "When construction is around ... funnel energy to construction.
    // Upgrading is secondary" - with sites standing that can genuinely EAT
    // the surplus (constructionAbsorb >= the draw), the plan's controller
    // allocation IS the post-construction residual and the relay serves
    // exactly that. The plan already ranks construction (70) above the
    // mid-grind controller (~44 at RCL6), so honoring planFlow is the
    // aggressive-construction doctrine end to end.
    const banked = WARCHEST_TARGET + 312_715;
    const surplusRate = feederRelayRate(banked);
    const absorbsEverything = surplusRate + 10;
    expect(feederRelayTarget(surplusRate, PLAN_FLOOR, banked, absorbsEverything)).to.equal(
      Math.min(surplusRate, PLAN_FLOOR + 5)
    );
  });

  it("SURPLUS + construction that absorbs only a trickle: the relay serves the REST of the surplus (prod t72478939)", () => {
    // The boolean form of this clamp treated 12 road sites (pool absorb ~5
    // e/t) exactly like a 100k build-out: relay clamped to planFlow+5 = 7
    // while surplus 115 stood - burn collapsed to 1 e/t, build ran 0.47
    // e/t, and the difference BANKED (+20.18/t at 474k, 17x target).
    // Construction-first means the build set eats what it CAN absorb
    // (projectAbsorbRate - the same lens that sizes the crew and the
    // plan's construction sink); the controller side gets the remainder,
    // floored at the plan residual. It never means the remainder banks.
    const banked = WARCHEST_TARGET + 446_493; // prod t72478939
    const surplusRate = feederRelayRate(banked); // 115
    const poolAbsorb = 5; // 12 road sites, 3225 work remaining, ~2-room travel
    expect(feederRelayTarget(surplusRate, PLAN_FLOOR, banked, poolAbsorb)).to.equal(surplusRate - poolAbsorb);
    // the plan residual is the floor, not the ceiling:
    expect(feederRelayTarget(surplusRate, PLAN_FLOOR, banked, poolAbsorb)).to.be.greaterThan(PLAN_FLOOR + 5);
  });

  it("SURPLUS + construction, no known allocation (old commission): stays unclamped, exactly as before", () => {
    const banked = WARCHEST_TARGET + 446_493;
    const surplusRate = feederRelayRate(banked);
    expect(feederRelayTarget(surplusRate, undefined, banked, 5)).to.equal(surplusRate);
  });

  it("NON-SURPLUS: keeps the plan clamp (t72421124 - no 90-part feeder into a full stock)", () => {
    const banked = 10_000; // below the warchest target: save regime
    expect(bankSurplusRate(banked), "precondition: not surplus").to.equal(0);
    const surplusRate = feederRelayRate(banked);
    // planFlow + FEEDER_STOCK_HEADROOM (5) clamps the relay
    expect(feederRelayTarget(surplusRate, PLAN_FLOOR, banked)).to.equal(Math.min(surplusRate, PLAN_FLOOR + 5));
  });

  it("no known allocation (old commission): unclamped in either regime", () => {
    expect(feederRelayTarget(feederRelayRate(10_000), undefined, 10_000)).to.equal(feederRelayRate(10_000));
    const banked = WARCHEST_TARGET + 100_000;
    expect(feederRelayTarget(feederRelayRate(banked), undefined, banked)).to.equal(feederRelayRate(banked));
  });
});
