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
