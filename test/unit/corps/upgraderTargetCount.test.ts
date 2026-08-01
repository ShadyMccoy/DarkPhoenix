import { expect } from "chai";
import "../../../src/types/Memory";
import {
  bankBehindFeeder,
  upgraderAllocation,
  upgraderFleetSatisfied,
  upgraderSizing,
  upgraderTargetCount
} from "../../../src/corps/UpgradingCorp";
import { CONTROLLER_STARVE_FLOOR } from "../../../src/corps/haulPolicy";
import { BASE_RESERVE, STORAGE_UPGRADE_TARGET, feederRelayRate } from "../../../src/economy/bank";
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
    expect(upgraderAllocation(12, null, null, BASE_RESERVE)).to.equal(12);
  });

  it("save regime: sips from the local stock while the warchest fills", () => {
    // 2000 staged at the input, bank below target behind the feeder: the
    // pinned pre-surplus behavior - 2 + 2000/1500 ~ 3.33, NOT the plan's 15.
    expect(upgraderAllocation(15, 2000, 10_000, BASE_RESERVE)).to.be.closeTo(sustainableConsumptionRate(2000, 2), 1e-9);
  });

  it("save regime: no feeder relay behind the stock behaves identically", () => {
    expect(upgraderAllocation(15, 2000, null, BASE_RESERVE)).to.be.closeTo(sustainableConsumptionRate(2000, 2), 1e-9);
  });

  it("surplus regime: sized from ACTUALS - the plan is not a cap (prod t72448020)", () => {
    const banked = BASE_RESERVE + 100_000;
    // The old pin let the plan cap the surplus fleet; live, a
    // parts-exhausted fill pinned planAllocated at the reserve 2 while
    // stock 2000 + relay + 234k banked stood ready - the goal-plan cap
    // held the burn at 2 e/t forever. Macro doctrine: consumers are sized
    // from actual stock at the work site, never from the goal plan; the
    // NOW-walk arbitrates spawn feasibility. In surplus BOTH calls now
    // return the shared-primitives actuals formula, plan number ignored.
    const actuals = sustainableConsumptionRate(2000, feederRelayRate(banked, BASE_RESERVE));
    expect(upgraderAllocation(30, 2000, banked, BASE_RESERVE)).to.be.closeTo(actuals, 1e-9);
    expect(upgraderAllocation(999, 2000, banked, BASE_RESERVE)).to.be.closeTo(actuals, 1e-9);
  });

  it("never sizes below the anti-downgrade floor", () => {
    expect(upgraderAllocation(15, 0, null, BASE_RESERVE)).to.equal(2);
  });

  it("surplus + a build-out that absorbs the whole draw: the plan is the cap again (owner 2026-07-21)", () => {
    // "Construction is going to be an investment in our future upgrading
    // abilities" - when the standing sites can genuinely EAT the surplus
    // (constructionAbsorb >= the draw), the surplus belongs to the build
    // set and upgraders eat the plan's residual (min(plan, sustainable)),
    // exactly the save-regime shape. Same absorb lens as the feeder
    // (buildPoolAbsorbRate), so the chain cannot fight itself.
    const banked = BASE_RESERVE + 100_000;
    const surplusDraw = feederRelayRate(banked, BASE_RESERVE);
    const clamped = upgraderAllocation(12, 2000, banked, BASE_RESERVE, surplusDraw + 10);
    expect(clamped).to.be.at.most(12);
    // and without construction the unclamped actuals still rule:
    expect(upgraderAllocation(12, 2000, banked, BASE_RESERVE, 0)).to.be.greaterThan(12);
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
    const banked = BASE_RESERVE + 446_493; // prod t72478939
    const poolAbsorb = 5; // 12 road sites, 3225 work remaining
    const share = feederRelayRate(banked, BASE_RESERVE) - poolAbsorb; // 110
    const { allocated, inflow } = upgraderSizing(2, 1607, banked, BASE_RESERVE, poolAbsorb);
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
    expect(upgraderSizing(2, 1607, BASE_RESERVE + 163_513, BASE_RESERVE, 0).surplus).to.equal(true);
    expect(upgraderSizing(2, 1607, 10_000, BASE_RESERVE, 0).surplus, "warchest still filling: save regime").to.equal(
      false
    );
    expect(upgraderSizing(2, 1607, null, BASE_RESERVE, 0).surplus, "no active feeder relay").to.equal(false);
    expect(
      upgraderSizing(2, null, null, BASE_RESERVE, 0).surplus,
      "unmeasurable stock trusts the plan, no hold"
    ).to.equal(false);
  });
});

/**
 * DURABLE feeder-relay verdict (incident t72571505). The `bankedBehindFeeder`
 * term fed to upgraderSizing is derived at the corp call site from the room's
 * feeder state. Gating it SOLELY on the transient `controllerFeederActive`
 * flag (true only while a feeder creep is alive THIS tick) tore the upgrader
 * body down to the anti-downgrade floor on EVERY feeder death and rebuilt it
 * on every respawn: measured live the upgrader `inflow` flapped 2<->115 and
 * the body flapped w49<->w3 for 170k+ ticks, ~3 excess upgrader respawns per
 * 2808t on a spawn-bound (0.97 util) colony. This mirrors CarryCorp's
 * shouldBankControllerLoad fix for the same single, non-blocking feeder: the
 * maintained controller buffer is the DURABLE evidence the relay is operating
 * (haulers deliver directly across a feeder gap), so ride the gap out - one
 * lens, two readers.
 */
describe("bankBehindFeeder (durable feeder-relay verdict, incident t72571505)", () => {
  const SURPLUS = 61134; // measured storage energy at the capture

  it("no owned storage -> null (there is no bank to draw from)", () => {
    expect(bankBehindFeeder({ storageEnergy: null, feederActive: true, controllerInputStock: 800 })).to.equal(null);
  });

  it("a feeder is alive -> the bank is available to the fleet", () => {
    expect(bankBehindFeeder({ storageEnergy: SURPLUS, feederActive: true, controllerInputStock: 0 })).to.equal(SURPLUS);
  });

  it("feeder momentarily dead but the controller buffer still holds -> the bank STAYS available (rides the gap)", () => {
    // 793 was the measured controllerStock in every flapped-down capture; the
    // buffer is refilled by direct hauler delivery while the single feeder
    // respawns, so the relay is effectively operating - do NOT tear the body down.
    expect(bankBehindFeeder({ storageEnergy: SURPLUS, feederActive: false, controllerInputStock: 793 })).to.equal(
      SURPLUS
    );
  });

  it("feeder dead AND the buffer has genuinely run down -> null (real starvation, anti-downgrade fallback)", () => {
    expect(bankBehindFeeder({ storageEnergy: SURPLUS, feederActive: false, controllerInputStock: 10 })).to.equal(null);
  });

  it("uses the same starve floor as the hauler redirect (shouldBankControllerLoad)", () => {
    expect(
      bankBehindFeeder({ storageEnergy: SURPLUS, feederActive: false, controllerInputStock: CONTROLLER_STARVE_FLOOR })
    ).to.equal(SURPLUS);
    expect(
      bankBehindFeeder({
        storageEnergy: SURPLUS,
        feederActive: false,
        controllerInputStock: CONTROLLER_STARVE_FLOOR - 1
      })
    ).to.equal(null);
  });

  it("closes the flap: a transient feeder gap no longer collapses the upgrader body", () => {
    // The exact incident numbers: planAllocated 56.4, stock 793, banked 61134,
    // no construction. OLD path (feeder momentarily dead -> bankedBehindFeeder
    // null) recycled the upgrader to the sip floor; NEW durable verdict holds it.
    const stock = 793;
    const banked = 61134;
    const reserve = 56000; // the dynamic warchest reserve at the capture
    const collapsed = upgraderSizing(56.4, stock, null, reserve, 0).allocated;
    expect(collapsed, "old: recycled to the anti-downgrade sip").to.be.lessThan(5);
    const held = bankBehindFeeder({ storageEnergy: banked, feederActive: false, controllerInputStock: stock });
    const sustained = upgraderSizing(56.4, stock, held, reserve, 0).allocated;
    // relayRate = feederRelayRate(61134, 56000): the save-floor plus the
    // surplus draw at the lifetime horizon (owner 2026-07-29 damping - was
    // ~49.2 at the old 150t horizon, ~18.4 now; the anti-flap intent is
    // unchanged: the durable verdict must keep the surplus term, never
    // collapse to the sip).
    expect(sustained, "new: sized to the surplus relay, no teardown").to.be.closeTo(
      feederRelayRate(banked, reserve) + stock / 1500,
      1e-6
    );
    expect(sustained, "and above the bare save-floor - the surplus term held").to.be.greaterThan(STORAGE_UPGRADE_TARGET);
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
