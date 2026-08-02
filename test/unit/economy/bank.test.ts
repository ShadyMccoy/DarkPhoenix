import { expect } from "chai";
import {
  BASE_RESERVE,
  RESERVE_COVERAGE_TICKS,
  SURPLUS_DRAIN_TICKS,
  MAX_SURPLUS_DRAW,
  STORAGE_UPGRADE_TARGET,
  warchestTarget,
  resolveReserveTarget,
  spendableBankSurplus,
  bankSurplusRate,
  feederRelayRate,
  bankSourceId,
  bankToTransientSource,
  controllerFloorRate
} from "../../../src/economy/bank";
import { EXPANSION_CAPEX, EXPANSION_SAFETY_RESERVE } from "../../../src/economy/expansion";
import { ANTI_DOWNGRADE_RESERVE, CREEP_LIFETIME } from "../../../src/economy/primitives";

// Spec 03 (storage draw-down), the SURPLUS half: once the bank holds the
// liquidity reserve, everything above it is spendable on the controller. The
// reserve target is now the plan-measured warchestTarget (income x coverage),
// not a flat constant - these pin the pure primitives every consumer (planner
// adapter, feeder, upgrader sizing) must derive from, one home, no drift.
describe("economy/bank - the surplus spend primitives", () => {
  describe("warchestTarget (the liquidity reserve, sized from income)", () => {
    it("never drops below the expansion-safety floor - a leaner floor would strand expansion", () => {
      // A drain floor below EXPANSION_CAPEX + EXPANSION_SAFETY_RESERVE would
      // permanently disable expansion (the pre-#98 STORAGE_BANK=10k failure).
      expect(BASE_RESERVE).to.equal(EXPANSION_CAPEX + EXPANSION_SAFETY_RESERVE);
      expect(warchestTarget(0)).to.equal(BASE_RESERVE);
      expect(warchestTarget(5)).to.equal(BASE_RESERVE); // tiny income -> floor still binds
    });

    it("covers RESERVE_COVERAGE_TICKS ticks of income once that exceeds the floor", () => {
      const richIncome = 80; // ~8 sources
      expect(warchestTarget(richIncome)).to.equal(RESERVE_COVERAGE_TICKS * richIncome);
      expect(warchestTarget(richIncome)).to.be.greaterThan(BASE_RESERVE);
    });

    it("BREATHES with colony size - a richer colony keeps a bigger buffer", () => {
      // The whole point: the flat lump did not scale, this does. Lean floors,
      // rich holds more in proportion to what it has to lose.
      const lean = warchestTarget(20);
      const mid = warchestTarget(40);
      const rich = warchestTarget(80);
      expect(lean).to.equal(BASE_RESERVE); // lean colony floors, freeing capital
      expect(mid).to.be.greaterThan(lean);
      expect(rich).to.be.greaterThan(mid);
    });

    it("reproduces roughly the old flat warchest at a mid colony (near-no-op calibration)", () => {
      // Old flat target was EXPANSION_CAPEX + 2*SAFETY. A mid ~40 e/t colony
      // should land within ~25% of it so existing behavior barely moves.
      const oldFlat = EXPANSION_CAPEX + 2 * EXPANSION_SAFETY_RESERVE;
      const mid = warchestTarget(40);
      expect(mid).to.be.closeTo(oldFlat, oldFlat * 0.25);
    });
  });

  describe("resolveReserveTarget (the shared fallback)", () => {
    it("uses the plan-persisted value when present", () => {
      expect(resolveReserveTarget(50_000)).to.equal(50_000);
    });
    it("falls back to the hard floor before the first solve publishes one", () => {
      expect(resolveReserveTarget(undefined)).to.equal(BASE_RESERVE);
    });
  });

  describe("spendableBankSurplus", () => {
    it("is zero at or below the reserve target", () => {
      expect(spendableBankSurplus(0, BASE_RESERVE)).to.equal(0);
      expect(spendableBankSurplus(BASE_RESERVE, BASE_RESERVE)).to.equal(0);
      expect(spendableBankSurplus(BASE_RESERVE - 1, BASE_RESERVE)).to.equal(0);
    });
    it("is exactly the stock above the target", () => {
      expect(spendableBankSurplus(BASE_RESERVE + 4000, BASE_RESERVE)).to.equal(4000);
    });
    it("tracks the target it is given - a bigger reserve leaves less spendable", () => {
      const banked = 60_000;
      expect(spendableBankSurplus(banked, 30_000)).to.equal(30_000);
      expect(spendableBankSurplus(banked, 50_000)).to.equal(10_000);
    });
  });

  describe("bankSurplusRate", () => {
    it("draws nothing while the reserve is still filling", () => {
      expect(bankSurplusRate(BASE_RESERVE, BASE_RESERVE)).to.equal(0);
      expect(bankSurplusRate(10_000, BASE_RESERVE)).to.equal(0);
    });
    it("drains the surplus over the target horizon", () => {
      expect(bankSurplusRate(BASE_RESERVE + 1500, BASE_RESERVE)).to.be.closeTo(1500 / SURPLUS_DRAIN_TICKS, 1e-9);
    });
    it("caps the draw so a runaway bank doesn't ask for an absurd consumer fleet", () => {
      // The cap binds only past MAX_SURPLUS_DRAW x SURPLUS_DRAIN_TICKS of
      // surplus (150k at the lifetime horizon) - a degenerate-bank guard,
      // never a pacer on ordinary surpluses.
      const runaway = MAX_SURPLUS_DRAW * SURPLUS_DRAIN_TICKS + 50_000;
      expect(bankSurplusRate(BASE_RESERVE + runaway, BASE_RESERVE)).to.equal(MAX_SURPLUS_DRAW);
    });
    it("the cap is a runaway GUARD above the physical absorption ceiling, never a pacer (owner doctrine: FOCUS energy - surge the current objective)", () => {
      // Controller-side absorption tops out well under 100 e/t at mid-game
      // (parking tiles x per-body WORK). The guard bounds degenerate fleet
      // math (a 570k bank must not commission a 100-feeder relay), but must
      // never be the binding term against physics. Measured incident: at 20
      // it capped the relay at 35 e/t while the plan allocated 105 - pacing
      // the exact focus the bot exists to deliver.
      expect(MAX_SURPLUS_DRAW).to.be.at.least(100);
    });
    it("tapers to zero approaching the target (no flapping at the boundary)", () => {
      expect(bankSurplusRate(BASE_RESERVE + SURPLUS_DRAIN_TICKS, BASE_RESERVE)).to.be.closeTo(1, 1e-9);
    });
  });

  describe("feederRelayRate", () => {
    it("relays exactly the save-regime upgrade target while the reserve fills", () => {
      expect(feederRelayRate(10_000, BASE_RESERVE)).to.equal(STORAGE_UPGRADE_TARGET);
    });
    it("adds the surplus draw on top once the reserve is full", () => {
      expect(feederRelayRate(BASE_RESERVE + 3000, BASE_RESERVE)).to.be.closeTo(
        STORAGE_UPGRADE_TARGET + bankSurplusRate(BASE_RESERVE + 3000, BASE_RESERVE),
        1e-9
      );
    });
  });

  describe("bankToTransientSource", () => {
    const pos = { x: 24, y: 24, roomName: "W1N1" };

    it("emits nothing while the reserve is still filling", () => {
      expect(bankToTransientSource("W1N1", pos, BASE_RESERVE, BASE_RESERVE)).to.equal(null);
      expect(bankToTransientSource("W1N1", pos, 5000, BASE_RESERVE)).to.equal(null);
    });

    it("emits a miner-less transient source at the storage, sized to the surplus draw", () => {
      const banked = BASE_RESERVE + 3000;
      const src = bankToTransientSource("W1N1", pos, banked, BASE_RESERVE)!;
      expect(src).to.not.equal(null);
      expect(src.id).to.equal(bankSourceId("W1N1"));
      expect(src.id).to.equal("bank-W1N1");
      expect(src.pos).to.deep.equal(pos);
      expect(src.rate).to.be.closeTo(bankSurplusRate(banked, BASE_RESERVE), 1e-9);
      expect(src.maxMiners).to.equal(0);
      expect(src.transient).to.equal(true);
    });

    it("holds a larger reserve back before releasing surplus (the risk-smoothing knob)", () => {
      // Same banked energy, a bigger reserve target -> emits nothing yet.
      const banked = 40_000;
      expect(bankToTransientSource("W1N1", pos, banked, 30_000)).to.not.equal(null);
      expect(bankToTransientSource("W1N1", pos, banked, 50_000)).to.equal(null);
    });
  });
});

describe("surplus drain horizon (owner 2026-07-29: size upgraders to the equilibrium)", () => {
  it("drains the surplus over >= one CREEP_LIFETIME - bodies never outlive their fuel", () => {
    // Measured swing t72645498->t72652682 at 150: a ~21k surplus sized two
    // 4350e upgraders to a 100 e/t draw that self-extinguished in ~200t;
    // the standing fleet then burned the bank BELOW reserve for its
    // remaining ~1200t (slope -1.66/t), EOL'd at the floor, and the refill
    // re-armed the swing. Consumer fleets are SIZED to this draw
    // (feederRelayRate -> upgrader inflow), so the horizon must cover the
    // lifetime of the bodies it sizes. Mirrors sustainableConsumptionRate's
    // stock/CREEP_LIFETIME: one drain law at every stock.
    expect(SURPLUS_DRAIN_TICKS).to.be.at.least(CREEP_LIFETIME);
  });
});

/**
 * THE t72455355 PIN (spec 38's regression test, landed ahead of the refactor).
 *
 * The incident: 340k banked against a ~70k reserve while the PLAN's controller
 * allocation read ~2 e/t - obeying the plan starved the relay to 7 e/t with a
 * full warchest standing. The consumer-side override (feederRelayRate reading
 * the BANK, not the plan) is what kept upgrading alive, and spec 38 warns that
 * a naive clamp to the plan re-opens exactly this hole.
 *
 * This pin encodes the OUTCOME, not the mechanism: however phase 4 moves the
 * floor into the solver and kills the +15 side-channel, a bank deep in surplus
 * must still drive a large drain. If this test breaks, the refactor re-created
 * the incident - stop and re-read spec 38 section "the override is
 * incident-backed".
 */
describe("t72455355 pin: a full bank NEVER starves the relay (spec 38 guard)", () => {
  it("drives a large drain at incident-shaped stocks, whatever the plan says", () => {
    // 340k banked, 70k reserve: surplus 270k -> drain capped at MAX_SURPLUS_DRAW.
    const rate = feederRelayRate(340_000, 70_000);
    expect(rate).to.be.at.least(100, "the relay the incident needed was ~115 e/t; 7 e/t starved it");
    expect(rate).to.equal(STORAGE_UPGRADE_TARGET + MAX_SURPLUS_DRAW);
  });

  it("still relays the save-regime floor when the bank sits AT reserve", () => {
    expect(feederRelayRate(70_000, 70_000)).to.equal(STORAGE_UPGRADE_TARGET);
  });
});

/**
 * SPEC 38 PHASE A - the controller floor moves INSIDE the plan.
 *
 * The runtime's feederRelayRate carries a +STORAGE_UPGRADE_TARGET constant
 * the solver never modeled (P12 read 3.30x divergence on the non-bank term
 * at FY4849-M03). Phase A gives the plan the floor as a SINK RESERVE, priced
 * by the one drain law: the bank funds a floor it can sustain for a creep
 * generation - never more than the save target, and a cold storage room
 * floors at the anti-downgrade trickle so a thin economy's spawn is never
 * out-reserved by its own controller.
 */
describe("controllerFloorRate (spec 38 phase A: the plan's own floor)", () => {
  it("caps at the save-regime target once the bank can sustain it", () => {
    expect(controllerFloorRate(340_000)).to.equal(STORAGE_UPGRADE_TARGET); // t72455355's bank
    expect(controllerFloorRate(STORAGE_UPGRADE_TARGET * CREEP_LIFETIME)).to.equal(STORAGE_UPGRADE_TARGET);
  });

  it("scales with what the bank can actually sustain below the target", () => {
    expect(controllerFloorRate(7500)).to.be.closeTo(5, 1e-9); // 7500/1500
  });

  it("floors at the anti-downgrade trickle on an empty bank", () => {
    expect(controllerFloorRate(0)).to.equal(ANTI_DOWNGRADE_RESERVE);
    expect(controllerFloorRate(1000)).to.equal(ANTI_DOWNGRADE_RESERVE); // 0.67 < trickle
  });
});
