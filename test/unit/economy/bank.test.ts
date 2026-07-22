import { expect } from "chai";
import {
  WARCHEST_TARGET,
  SURPLUS_DRAIN_TICKS,
  MAX_SURPLUS_DRAW,
  STORAGE_UPGRADE_TARGET,
  spendableBankSurplus,
  bankSurplusRate,
  feederRelayRate,
  bankSourceId,
  bankToTransientSource
} from "../../../src/economy/bank";
import { EXPANSION_CAPEX, EXPANSION_SAFETY_RESERVE } from "../../../src/economy/expansion";

// Spec 03 (storage draw-down), the SURPLUS half: once the bank holds the
// expansion warchest, everything above it is spendable on the controller.
// These are exact-value pins on the pure primitives every consumer (planner
// adapter, feeder, upgrader sizing) must derive from - one home, no drift.
describe("economy/bank - the surplus spend primitives", () => {
  describe("WARCHEST_TARGET", () => {
    it("sits ABOVE the expansion capital trigger, derived from its constants", () => {
      // A drain floor below EXPANSION_CAPEX + EXPANSION_SAFETY_RESERVE would
      // permanently disable expansion (the pre-#98 STORAGE_BANK=10k failure
      // mode). The target must be derived, never a second hardcoded number.
      expect(WARCHEST_TARGET).to.be.greaterThan(EXPANSION_CAPEX + EXPANSION_SAFETY_RESERVE);
    });
  });

  describe("spendableBankSurplus", () => {
    it("is zero at or below the warchest target", () => {
      expect(spendableBankSurplus(0)).to.equal(0);
      expect(spendableBankSurplus(WARCHEST_TARGET)).to.equal(0);
      expect(spendableBankSurplus(WARCHEST_TARGET - 1)).to.equal(0);
    });
    it("is exactly the stock above the target", () => {
      expect(spendableBankSurplus(WARCHEST_TARGET + 4000)).to.equal(4000);
    });
  });

  describe("bankSurplusRate", () => {
    it("draws nothing while the warchest is still filling", () => {
      expect(bankSurplusRate(WARCHEST_TARGET)).to.equal(0);
      expect(bankSurplusRate(10_000)).to.equal(0);
    });
    it("drains the surplus over the target horizon", () => {
      expect(bankSurplusRate(WARCHEST_TARGET + 1500)).to.be.closeTo(1500 / SURPLUS_DRAIN_TICKS, 1e-9);
    });
    it("caps the draw so a 100k bank doesn't ask for an absurd consumer fleet", () => {
      expect(bankSurplusRate(WARCHEST_TARGET + 100_000)).to.equal(MAX_SURPLUS_DRAW);
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
      expect(bankSurplusRate(WARCHEST_TARGET + 150)).to.be.closeTo(1, 1e-9);
    });
  });

  describe("feederRelayRate", () => {
    it("relays exactly the save-regime upgrade target while the warchest fills", () => {
      expect(feederRelayRate(10_000)).to.equal(STORAGE_UPGRADE_TARGET);
    });
    it("adds the surplus draw on top once the warchest is full", () => {
      expect(feederRelayRate(WARCHEST_TARGET + 3000)).to.be.closeTo(
        STORAGE_UPGRADE_TARGET + bankSurplusRate(WARCHEST_TARGET + 3000),
        1e-9
      );
    });
  });

  describe("bankToTransientSource", () => {
    const pos = { x: 24, y: 24, roomName: "W1N1" };

    it("emits nothing while the warchest is still filling", () => {
      expect(bankToTransientSource("W1N1", pos, WARCHEST_TARGET)).to.equal(null);
      expect(bankToTransientSource("W1N1", pos, 5000)).to.equal(null);
    });

    it("emits a miner-less transient source at the storage, sized to the surplus draw", () => {
      const banked = WARCHEST_TARGET + 3000;
      const src = bankToTransientSource("W1N1", pos, banked)!;
      expect(src).to.not.equal(null);
      expect(src.id).to.equal(bankSourceId("W1N1"));
      expect(src.id).to.equal("bank-W1N1");
      expect(src.pos).to.deep.equal(pos);
      expect(src.rate).to.be.closeTo(bankSurplusRate(banked), 1e-9);
      expect(src.maxMiners).to.equal(0);
      expect(src.transient).to.equal(true);
    });
  });
});
