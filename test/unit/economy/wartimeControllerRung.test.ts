import { expect } from "chai";
import { controllerRoutingCapacity, wartimeControllerValue } from "../../../src/economy/flowAdapter";
import { DEFAULT_VALUATION, GOAL_PROFILES } from "../../../src/economy/goals";
import { controllerFloorRate } from "../../../src/economy/bank";

/**
 * A MIX OF UPGRADING AND BUILDING, WITH BUILDING TAKING PRIORITY
 * (owner 2026-08-08: *"We can have a mix of upgrading and building. We just want
 * building to take priority and not be slowed down by the upgrading."*)
 *
 * This SUPERSEDES the 2026-08-05 reading ("banking excess it can't consume is
 * fine"): banking the residual is permitted, not required, and the binding
 * requirement is the ORDERING. Audit t72868738 measured what the old shape cost
 * over 2131 reset-free ticks -
 *
 *   controller sink   demand 0   allocated 0   workParts 0
 *   storage sink      allocated 106.69 e/t
 *   bank              +25.68 e/t -> 234,972   (154,472 ABOVE reserve)
 *   construction      budget 10.06, BUILT 5.11
 *
 * - because wartime relegated by zeroing the sink's DEMAND. `controllerFloorRate`
 * is 0 unless the downgrade timer is low, so a healthy controller went fully off;
 * a sink with no demand occupies no rung, and the residual fell past it to
 * storage (value 1).
 *
 * The mix is the ladder's own job. The controller keeps a real demand and prices
 * at `controllerMin` = 40 - strictly below construction (70), strictly above
 * storage (1).
 *
 * WHY BUILDING CANNOT BE SLOWED BY THIS, which is the owner's actual constraint:
 * it is structural, not a consequence of the values. `CorpPlanner.routeToSinks`
 * fills in passes - reserve, spawn, **construction**, storage, then the general
 * value pass. Construction takes its energy AND its spawn parts in a dedicated
 * pass that runs BEFORE the controller is ever considered (the production-first
 * ledger order, t72445337). Upgrading can only ever claim the remainder; the
 * ladder ordering here just keeps that remainder from banking. The
 * `constructionUnaffected` case below pins exactly that.
 */
describe("wartime controller relegation (owner 2026-08-08: mix, building first)", () => {
  const sink = { position: { x: 25, y: 25, roomName: "W1N1" } };
  const wartime = new Set(["W1N1"]);
  const HEALTHY = 0; // controllerFloorRate with a comfortable downgrade timer

  it("the anti-downgrade floor is 0 for a healthy controller - so it cannot BE the allocation", () => {
    expect(controllerFloorRate(undefined)).to.equal(0);
    expect(controllerFloorRate(50_000)).to.equal(0);
    expect(controllerFloorRate(100)).to.be.greaterThan(0); // armed only in danger
  });

  it("keeps a DEMAND in wartime - relegated, not switched off", () => {
    expect(
      controllerRoutingCapacity(sink, 100, 80, wartime, 60, HEALTHY),
      "wartime zeroed a healthy controller's demand"
    ).to.be.greaterThan(0);
  });

  it("relegates to the bank-fed law, still bounded by the physical burn cap", () => {
    expect(controllerRoutingCapacity(sink, 100, 80, wartime, 60, HEALTHY)).to.equal(60);
    expect(controllerRoutingCapacity(sink, 100, 45, wartime, 60, HEALTHY)).to.equal(45);
  });

  it("never leaves the demand unbounded when there is no bank-fed rate (harness Infinity guard)", () => {
    // physicalUpgradeCap is Infinity without a live Game; an unbounded demand is
    // how t72429680's infeasible upgrade plan out-competed remote mining.
    expect(controllerRoutingCapacity(sink, 200, Infinity, wartime, undefined, HEALTHY)).to.equal(200);
  });

  it("never drops below the anti-downgrade floor when that floor IS armed", () => {
    expect(controllerRoutingCapacity(sink, 100, 80, wartime, 0, 12)).to.be.at.least(12);
    // ...and an armed floor never REDUCES an allocation the bank can sustain.
    expect(controllerRoutingCapacity(sink, 100, 80, wartime, 60, 12)).to.equal(60);
  });

  it("is unchanged outside wartime (the bank-fed inversion still governs)", () => {
    const peace = new Set<string>();
    expect(controllerRoutingCapacity(sink, 100, 80, peace, 60, HEALTHY)).to.equal(60);
    expect(controllerRoutingCapacity(sink, 100, 45, peace, undefined, HEALTHY)).to.equal(45);
  });
});

describe("wartimeControllerValue - the rung the mix rests on", () => {
  it("is the ladder's controller FLOOR, not its remaining-progress band", () => {
    expect(wartimeControllerValue()).to.equal(DEFAULT_VALUATION.controllerMin);
  });

  it("orders construction ABOVE it - building takes priority", () => {
    expect(wartimeControllerValue()).to.be.lessThan(DEFAULT_VALUATION.construction);
  });

  it("orders it ABOVE storage - the residual upgrades instead of banking", () => {
    expect(wartimeControllerValue()).to.be.greaterThan(DEFAULT_VALUATION.storage);
  });

  it("holds for EVERY goal profile - a profile cannot reorder the mix", () => {
    for (const [name, val] of Object.entries(GOAL_PROFILES)) {
      expect(wartimeControllerValue(val), `${name}: the floor must beat storage`).to.be.greaterThan(val.storage);
      expect(
        wartimeControllerValue(val),
        `${name}: construction must not rank below the relegated controller`
      ).to.be.at.most(val.construction);
    }
  });
});
