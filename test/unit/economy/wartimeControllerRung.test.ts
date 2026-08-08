import { expect } from "chai";
import { controllerRoutingCapacity } from "../../../src/economy/flowAdapter";
import { DEFAULT_VALUATION } from "../../../src/economy/goals";
import { controllerFloorRate } from "../../../src/economy/bank";

/**
 * WARTIME RELEGATION IS AN OFF SWITCH, AND THAT IS THE OWNER'S RULING — NOT A
 * BUG. (Audit t72868738; this file exists to stop the next session "fixing" it,
 * because this one nearly did.)
 *
 * What a capture shows, and why it looks like a defect:
 *
 *   controller sink   demand 0   allocated 0   workParts 0
 *   storage sink      allocated 106.69 e/t
 *   bank              +25.68 e/t -> 234,972  (154,472 ABOVE reserve)
 *   construction      budget 10.06, BUILT 5.11
 *   E4  FAIL  "equilibrium past the absorbable knee - income the spend path cannot use"
 *   G1  WARN  "25.68 pts/t of capacity BANKED instead of delivered"
 *   P12 FAIL  "0x of the law's cap (published 0.00 vs bankFedControllerRate 100.00)"
 *
 * The mechanism is real: `controllerRoutingCapacity` returns `controllerFloor`
 * in wartime, and `controllerFloorRate` is 0 unless the downgrade timer is low —
 * so a HEALTHY controller's DEMAND goes to zero, it occupies no rung, and the
 * surplus construction cannot absorb falls past it to storage (value 1). The
 * ladder's `controllerMin: 40` rung (CLAUDE.md's "controller floor 40", which
 * sits strictly between construction 70 and storage 1) is never used for this.
 *
 * The tempting fix — relegate by VALUE, keep the demand, so the residual reaches
 * the controller instead of the bank — was written, went green, and was REVERTED
 * on reading the directive it reverses:
 *
 *   Owner 2026-08-05: *"I WANT construction to be the primary consumer over
 *   controller if we have a construction project. **Banking excess it can't
 *   consume is fine.**"*
 *
 * "Banking excess it can't consume is fine" is exactly this situation, decided.
 * `flowAdapter.test.ts` already pins it ("the residual BANKS"). So the behaviour
 * stays, and this file pins WHY, with the numbers, so the shape below reads as
 * intent rather than as an unnoticed leak.
 *
 * The one thing that IS wrong is documentation: the comment at the wartime
 * branch claims *"Relegated != off - the anti-downgrade floor still holds"*.
 * For a healthy controller the floor is 0, so relegated IS off. The assertions
 * below state the true contract.
 *
 * STILL OPEN for the owner (spec 14 cycle t72868738 carries the numbers): the
 * ruling and the ledger disagree about whether this is a leak. E4 ranks it the
 * colony's top line at 154k idle and +25.68 e/t, and construction converts half
 * its budget. That is a decision, not a bug — do not resolve it in code.
 */
describe("wartime controller relegation - the contract, and why it is not a bug", () => {
  const sink = { position: { x: 25, y: 25, roomName: "W1N1" } };
  const wartime = new Set(["W1N1"]);

  it("the floor wartime relegates TO is 0 for a healthy controller", () => {
    expect(controllerFloorRate(undefined)).to.equal(0);
    expect(controllerFloorRate(50_000)).to.equal(0);
    expect(controllerFloorRate(100)).to.be.greaterThan(0); // armed only in danger
  });

  it("so wartime zeroes a healthy controller's DEMAND - relegated IS off", () => {
    // Reads as a defect and is not: see the owner ruling in the header.
    expect(controllerRoutingCapacity(sink, 200, 80, wartime, 60, 0)).to.equal(0);
  });

  it("and the armed anti-downgrade floor is the ONLY thing that survives wartime", () => {
    expect(controllerRoutingCapacity(sink, 200, 80, wartime, 60, 2)).to.equal(2);
  });

  it("relegation is per-room: a peacetime room still mops up the surplus", () => {
    expect(controllerRoutingCapacity(sink, 200, 80, new Set(), 60, 0)).to.equal(60);
  });

  it("the ladder's controllerMin rung EXISTS but wartime never reaches it (dead for this purpose)", () => {
    // Kept as a pin on the ladder's ordering: if a future owner ruling switches
    // relegation from demand-zeroing to value-relegation, THIS is the rung it
    // lands on, and these are the orderings that make it meaningful.
    expect(DEFAULT_VALUATION.controllerMin).to.be.lessThan(DEFAULT_VALUATION.construction);
    expect(DEFAULT_VALUATION.controllerMin).to.be.greaterThan(DEFAULT_VALUATION.storage);
  });
});
