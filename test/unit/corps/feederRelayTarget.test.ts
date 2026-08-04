import { expect } from "chai";
import { parkedRelayCarry, carryPartsFor } from "../../../src/economy/primitives";

/**
 * The link-fed feeder is a PARKED post (owner 2026-07-22: "The feeder doesn't
 * move at all. it's adjacent to the storage and the link both") - its cycle is
 * withdraw tick + transfer tick, zero travel. carryPartsFor(rate, 1) charges
 * roundTripTicks(1) = 4 (two travel ticks that never happen), doubling the body.
 */
describe("parkedRelayCarry (the stationary relay cycle - no phantom travel)", () => {
  it("carry = rate * 2 / 50 (withdraw tick + transfer tick)", () => {
    expect(parkedRelayCarry(60)).to.equal(2.4);
    expect(parkedRelayCarry(110)).to.equal(4.4);
  });
  it("halves the link-fed body vs the trip model (live shape: bodyRate 60 -> 3 carry, not 6)", () => {
    expect(Math.ceil(parkedRelayCarry(60) * 1.2)).to.equal(3);
    expect(Math.ceil(carryPartsFor(60, 1) * 1.2)).to.equal(6); // the model this replaces
  });
});

import "../../../src/types/Memory";
import { feederRelayTarget, FEEDER_STOCK_HEADROOM } from "../../../src/corps/ControllerFeederCorp";
import { bankFedControllerRate, BASE_RESERVE } from "../../../src/economy/bank";

/**
 * THE PLAN ALLOCATION IS THE VALVE - the feeder half (spec 38 phase B; owner
 * 2026-07-31: "incorporate the actual into the plan ... a single consistent
 * framework", and 2026-08-02 for the upgrader half: "the plan allocation IS
 * the valve").
 *
 * What died here: the SURPLUS-REGIME OVERRIDE ("consumers size from actuals,
 * never the goal plan") that returned the raw surplus formula and ignored the
 * plan's controller allocation. It was born at prod t72455355 - the plan's
 * parts ledger exhausted before the controller sink (allocated 2) while 340k
 * stood banked, and obeying that artifact starved the relay to 7 e/t against
 * upgraders sized to 115. Spec 38 phase A moved that floor INSIDE the plan
 * (controllerFloorRate as the controller SINK RESERVE, won by the reserve
 * pre-pass before value greed or ledger exhaustion), so the override's
 * precondition - a full bank behind a starved allocation - can no longer
 * occur. The staged solve proving it lives in test/unit/economy/bank.test.ts
 * ("spec 38 acceptance: the staged t72455355 state").
 *
 * The constructionAbsorb clamp died WITH the override: it existed to net
 * construction's claim out of the raw surplus formula, but the plan's
 * controller allocation is already the post-construction residual - the
 * solver routes construction as a competing sink in the SAME solve (the
 * ladder ranks them), so netting it again would double-count.
 *
 * Measured shape this closes (t72681617, P12's 3.30x): plan controller 50.02,
 * runtime relay 89.69 - the feeder fielded a fleet the plan never priced.
 */
describe("feederRelayTarget (the plan allocation is the valve - spec 38 phase B)", () => {
  it("SURPLUS regime: relays the plan's controller allocation + stock headroom, NOT the raw surplus formula (t72681617: plan 50.02, formula 94.69)", () => {
    const surplusFormula = 94.694; // 15 + bankSurplusRate live at t72681617
    const planFlow = 50.02;
    expect(feederRelayTarget(surplusFormula, planFlow)).to.be.closeTo(planFlow + FEEDER_STOCK_HEADROOM, 1e-9);
  });

  it("NON-SURPLUS regime: same law (t72421124 pin - plan floors at ~2, no 90-part feeder into a full stock)", () => {
    expect(feederRelayTarget(15, 2)).to.equal(2 + FEEDER_STOCK_HEADROOM);
  });

  it("ONE law, no regime branch: the result reads the plan, not the bank", () => {
    // The old contract branched on bankSurplusRate(banked) and returned
    // different rates for the same allocation. Now the surplus formula is
    // dead weight whenever an allocation is known - any formula value, same
    // relay.
    expect(feederRelayTarget(115, 50)).to.equal(feederRelayTarget(15, 50));
  });

  it("no known allocation (old commission, pre-first-solve): the surplus formula stands as the fallback", () => {
    const filling = bankFedControllerRate(10_000, BASE_RESERVE);
    expect(feederRelayTarget(filling, undefined)).to.equal(filling);
    const surplus = bankFedControllerRate(BASE_RESERVE + 100_000, BASE_RESERVE);
    expect(feederRelayTarget(surplus, undefined)).to.equal(surplus);
  });
});
