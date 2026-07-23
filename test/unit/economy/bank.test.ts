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
  bankToTransientSource
} from "../../../src/economy/bank";
import { EXPANSION_CAPEX, EXPANSION_SAFETY_RESERVE } from "../../../src/economy/expansion";

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
    it("caps the draw so a 100k bank doesn't ask for an absurd consumer fleet", () => {
      expect(bankSurplusRate(BASE_RESERVE + 100_000, BASE_RESERVE)).to.equal(MAX_SURPLUS_DRAW);
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
      expect(bankSurplusRate(BASE_RESERVE + 150, BASE_RESERVE)).to.be.closeTo(1, 1e-9);
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
