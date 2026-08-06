import { expect } from "chai";
import { worthABody } from "../../../src/corps/recycle";
import "../../../src/types/Memory";
import {
  bankBehindFeeder,
  upgraderAllocation,
  upgraderFleetSatisfied,
  upgraderSwarmCap,
  upgraderWorthABody,
  upgraderSizing,
  upgraderTargetCount
} from "../../../src/corps/UpgradingCorp";
import { CONTROLLER_STARVE_FLOOR } from "../../../src/corps/haulPolicy";
import { BASE_RESERVE } from "../../../src/economy/bank";
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

  it("a ZERO allocation fields ZERO upgraders - the danger-gated floor re-arms it via the plan (owner 2026-08-04)", () => {
    expect(upgraderTargetCount(0, 2, PARKING, 2)).to.equal(0);
    // ...and a danger-armed allocation (the sip) fields exactly one again.
    expect(upgraderTargetCount(2, 2, PARKING, 2)).to.equal(1);
  });
});

/**
 * THE PLAN ALLOCATION IS THE VALVE (owner 2026-08-02: *"it seems like at one
 * point we had a valve for the upgrader consumer sizing that was independent
 * of the plan allocation. However, realized that the plan allocation IS the
 * valve. That other valve might've been good in the short term, but it should
 * be removed entirely and consolidated behind the plan."*).
 *
 * The removed valve sized the fleet from the work-site stock drained over a
 * creep generation, with `feederRelayRate` as its inflow term - a SECOND drain
 * rate, computed independently of the controller allocation the solver routed.
 * It was introduced because the plan under-stated (prod t72448020: planAllocated
 * pinned at the reserve 2 by a parts-exhausted fill while 234k sat banked), and
 * bypassing the plan was the short-term fix.
 *
 * By 2026-08-02 it had INVERTED, and was throttling below a plan that no longer
 * under-states - the exact failure it was built to prevent, with the sign
 * flipped:
 *
 *     tick          plan says   valve allowed
 *     t72717545       79.11         2.00
 *     t72721419       66.31        40.46
 *     t72722670       81.19        47.70
 *
 * That is the CLAUDE.md trap by the letter: the second patch on a mechanism
 * means the mechanism is the bug. Sizing is now the plan and nothing else; if
 * the plan is wrong, the fix belongs in the plan, where one number can be
 * audited instead of two disagreeing quietly.
 *
 * The BANK lens survives for one job only, and it is not sizing: financing.
 * Whether the spawn walk can afford a full-size body (`surplus` -> holdToFund,
 * incident t72503018) is a different question from how much the fleet should
 * burn, and conflating them is what produced two valves in the first place.
 */
describe("upgraderSizing - consolidated behind the plan", () => {
  it("sizes to the PLAN allocation, full stop", () => {
    expect(upgraderAllocation(12)).to.equal(12);
    expect(upgraderAllocation(79.11)).to.be.closeTo(79.11, 1e-9);
  });

  it("no longer throttles below the plan - the live inversion cannot recur", () => {
    // The three measured shapes above: every one must now pass the plan through.
    for (const plan of [79.11, 66.31, 81.19]) {
      expect(upgraderAllocation(plan), `plan ${plan}`).to.be.closeTo(plan, 1e-9);
    }
  });

  it("passes a zeroed plan through as ZERO - the anti-downgrade response is the PLAN's danger-gated floor (owner 2026-08-04)", () => {
    // The runtime clamp that turned 0 into 2 was the constant trickle the
    // owner retired ("Not the constant trickle"). When the downgrade timer
    // actually runs low, the PLAN's floor arms (controllerFloorRate(ticks))
    // and this allocation rises through the normal chain - one valve.
    expect(upgraderAllocation(0)).to.equal(0);
    expect(upgraderAllocation(1)).to.equal(1);
  });

  it("reports the plan as the inflow - there is no second rate to report", () => {
    const { allocated, inflow } = upgraderSizing(40);
    expect(allocated).to.equal(40);
    expect(inflow).to.equal(40);
  });

  /**
   * FINANCING, not sizing. `surplus` gates holdToFund - whether the spawn walk
   * should wait to afford a full-size body rather than buy a runt - and it is
   * the one thing the bank still answers here.
   */
  describe("surplus (a FINANCING verdict, never a sizing one)", () => {
    it("is true only when the bank is genuinely in surplus behind a live feeder", () => {
      expect(upgraderSizing(2, { bankedBehindFeeder: BASE_RESERVE + 163_513, reserveTarget: BASE_RESERVE }).surplus).to.equal(true);
      expect(
        upgraderSizing(2, { bankedBehindFeeder: 10_000, reserveTarget: BASE_RESERVE }).surplus,
        "warchest still filling: save regime"
      ).to.equal(false);
      expect(
        upgraderSizing(2, { bankedBehindFeeder: null, reserveTarget: BASE_RESERVE }).surplus,
        "no active feeder relay"
      ).to.equal(false);
      expect(upgraderSizing(2).surplus, "no financing context at all").to.equal(false);
    });

    it("does NOT change the allocation - that is the whole point", () => {
      const rich = upgraderSizing(30, { bankedBehindFeeder: BASE_RESERVE + 200_000, reserveTarget: BASE_RESERVE });
      const poor = upgraderSizing(30, { bankedBehindFeeder: null, reserveTarget: BASE_RESERVE });
      expect(rich.allocated).to.equal(poor.allocated);
      expect(rich.allocated).to.equal(30);
    });
  });
});

/**
 * FLEET SATISFACTION: count is not enough (production audit 2026-08-01,
 * t72706408).
 *
 * Live shape: the upgrade corp stamped `allocated 75.098`, `targetCount 2`,
 * `staffing 3`, `demand "staffed"` - and stood at **41 WORK**. Three bodies
 * built in the trough (when the allocation was the anti-downgrade sip of 2)
 * satisfied the COUNT gate forever, so no full-size body was ever ordered
 * while the valve sat wide open at 74.64 e/t, the plan asked for 140, the
 * spawn idled 14% of the window (55% of it "no demand") and the bank climbed
 * +25.88 e/t to 159,463. P7 read 0.22x.
 *
 * CarryCorp has carried the correct invariant since the runt-fleet fix -
 * `current >= targetHaulers && fieldedCarry >= carryNeeded` - and its comment
 * states the reason exactly: "The count alone is not enough: under energy
 * pressure haulers spawn at the runt floor, so the planned count can be
 * reached while the fielded CARRY still falls short." The upgrader is the same
 * post with the same failure mode and only half the test. This restores the
 * symmetry (CLAUDE.md: every consumer of "how many creeps does this post have"
 * must use the SAME lens).
 */
describe("upgraderFleetSatisfied (count AND capacity - the runt-fleet invariant)", () => {
  it("is NOT satisfied when the count is met but the fielded WORK falls short", () => {
    // The live t72706408 shape: 3 small bodies, 41 WORK, 75.1 e/t allocated.
    expect(upgraderFleetSatisfied(3, 2, 41, 75.098)).to.equal(false);
  });

  it("is satisfied only when BOTH the count and the WORK are covered", () => {
    expect(upgraderFleetSatisfied(2, 2, 76, 75.098)).to.equal(true);
    // count short, work covered -> still not satisfied (a lone over-sized body
    // cannot stand on every parking tile)
    expect(upgraderFleetSatisfied(1, 2, 80, 75.098)).to.equal(false);
  });

  it("treats a fleet at or above its allocation as done regardless of rounding", () => {
    expect(upgraderFleetSatisfied(2, 2, 75, 75)).to.equal(true);
  });
});

/**
 * THE SWARM-CAP DEADLOCK (measured live t72804439, the first clean
 * month-cadence window).
 *
 * The count-vs-capacity drift the `upgraderFleetSatisfied` fix caught at the
 * SATISFACTION gate has a twin one line below it, at the swarm cap - and the
 * twin is worse, because it does not merely fail to notice the gap, it makes
 * the gap unclosable:
 *
 *   allocated 60.21, affordableWork ~30 (a 5600-capacity body)
 *   -> targetCount = ceil(60.21/30) = 2
 *   but bodies are actually built at ~14.5 WORK (energy AVAILABLE, not
 *   capacity - "recycled why: runt-upsize 83%" in the same window)
 *   -> 4 creeps x 14.5 = 58 WORK < 60.21 allocated  => NOT satisfied
 *   -> but getCreepCount() 4 >= targetCount*2 = 4   => "swarm-cap", no demand
 *
 * The fleet is permanently one body short of its own allocation with parking
 * for 8, the controller takes 27.32 e/t of a 60.21 budget (P7 0.66x), and
 * the residual banks at +14.83 e/t (G1 under-spending, E4 surplus 87,348).
 *
 * The cap's own doc says what it is for: "replacement overlap may field one
 * extra body per expiring incumbent, never more - PARKING TILES ARE FEW". So
 * the bound it wants is the PHYSICAL one. When the fleet is WORK-SHORT, extra
 * bodies are not a swarm - they are the compensation for undersized bodies -
 * and the honest ceiling is the parking ring, which targetCount is already
 * bounded by.
 */
describe("upgraderSwarmCap (a WORK-short fleet is bounded by PARKING, not headcount)", () => {
  it("the live deadlock: 4 bodies, 58 of 60.21 WORK, parking 8 - one more body is allowed", () => {
    expect(upgraderSwarmCap(2, 8, 58, 60.21)).to.be.greaterThan(4);
    expect(upgraderSwarmCap(2, 8, 58, 60.21), "...but never past the parking ring").to.equal(8);
  });

  it("a fleet whose WORK covers the allocation keeps the tight overlap cap", () => {
    // Not work-short: the 2x overlap allowance is the whole story, and a
    // stale/huge allocation still cannot buy a swarm.
    expect(upgraderSwarmCap(2, 8, 61, 60.21)).to.equal(4);
  });

  it("ONLY EVER RELAXES: a parking ring tighter than the overlap allowance keeps the allowance", () => {
    // Deliberately NOT a tightening. The cap's job is to bound a swarm, and
    // the overlap allowance is what makes replacement possible at all - a
    // room whose ring is narrower than 2x its target would strand its own
    // replacements if this returned parking. targetCount is already
    // parking-bounded, so the relaxed branch can never exceed the ring by
    // more than that same allowance.
    expect(upgraderSwarmCap(2, 3, 10, 60.21)).to.equal(4);
  });

  it("a degenerate parking read (0 = unknown) never strands replacement", () => {
    expect(upgraderSwarmCap(2, 0, 10, 60.21)).to.equal(4);
  });
});

/**
 * A WORK SLIVER IS NOT WORTH A BODY (owner 2026-08-05: "With the amount of
 * work why do we even need 8 spots at all? We can make creeps big enough to
 * avoid that constraint").
 *
 * The owner is right on the arithmetic and it reframes the swarm cap above
 * as a symptom. At RCL7 capacity (5600) a containerFed upgrader packs
 * **39 WORK for 4,450e in 50 parts** - one body covers 39 e/t, so a 60.21
 * allocation wants TWO bodies (39 + 21) and `targetCount` computes exactly
 * 2. The parking ring is irrelevant at that size.
 *
 * What actually stood at t72804439 was 4 bodies carrying 58 WORK - one big
 * (~39) and three ~6-WORK slivers - because the order size is the REMAINING
 * gap with no floor: once the fleet is near its allocation the gap is 2-6
 * WORK and the corp buys a runt for it, which then occupies a parking slot
 * for its whole 1500-tick life ("recycled why: runt-upsize 83%" in the same
 * window). That is the upgrader's version of the even-share treadmill the
 * haulers were cured of on 2026-08-03 - and the cure is the same predicate:
 * corps/recycle.worthABody, a deficit under HALF a body share is not worth a
 * spawn purchase, it rides to EOL which re-sizes for free.
 *
 * Sizing to the GAP stays (it is what makes the second body 21 and not a
 * wasteful 39); only the sliver purchase goes.
 */
describe("upgraderWorthABody (the big-body rule - owner 2026-08-05)", () => {
  it("the live sliver: 2.2 WORK short of a 39-WORK share is NOT worth a body", () => {
    expect(upgraderWorthABody(60.21 - 58, 39)).to.equal(false);
  });

  it("a real gap IS worth a body - and sizing to the gap keeps it honest (39 + 21, not 39 + 39)", () => {
    // Second body of a fresh 60.21 fleet: 21.21 remaining of a 39 share.
    expect(upgraderWorthABody(60.21 - 39, 39)).to.equal(true);
  });

  it("exactly half a share is worth it (the boundary is inclusive, as for haulers)", () => {
    expect(upgraderWorthABody(19.5, 39)).to.equal(true);
    expect(upgraderWorthABody(19.4, 39)).to.equal(false);
  });

  it("the FIRST body is always worth it (a cold controller must start upgrading)", () => {
    // Whole allocation outstanding: trivially past half a share.
    expect(upgraderWorthABody(60.21, 39)).to.equal(true);
    // ...and at a tiny RCL2 body share the same rule still fields the starter.
    expect(upgraderWorthABody(5, 4)).to.equal(true);
  });

  it("mirrors corps/recycle.worthABody exactly (ONE doctrine, both posts)", () => {
    expect(upgraderWorthABody(10, 20)).to.equal(worthABody(10, 20));
    expect(upgraderWorthABody(9, 20)).to.equal(worthABody(9, 20));
  });

  it("BOOTSTRAP is exempt - a pre-storage room closes every gap (escape velocity, the hauler doctrine)", () => {
    // At 800 capacity a body affords 6 WORK, so a 20 e/t allocation leaves a
    // 2-WORK tail. Mature: not worth a body. Bootstrap: buy it - early RCL
    // progress is what buys the capacity that makes big bodies possible, and
    // abandoning ~10% of the allocation there is a worse trade than the runt.
    expect(upgraderWorthABody(2, 6, true), "mature: the tail rides to EOL").to.equal(false);
    expect(upgraderWorthABody(2, 6, false), "bootstrap: every crank").to.equal(true);
  });
});
