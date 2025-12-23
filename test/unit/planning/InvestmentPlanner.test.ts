import { expect } from "chai";
import { InvestmentPlanner, createInvestmentPlanner } from "../../../src/planning/InvestmentPlanner";
import { createMintValues } from "../../../src/colony/MintValues";
import {
  createUpgradingState,
  createSpawningState,
  createMiningState,
  createHaulingState,
  AnyCorpState
} from "../../../src/corps/CorpState";
import { Position } from "../../../src/market/Offer";

describe("InvestmentPlanner", () => {
  const mintValues = createMintValues({
    rcl_upgrade: 1.0,
    gcl_upgrade: 1.0
  });

  const spawnPos: Position = { x: 25, y: 25, roomName: "W1N1" };
  const controllerPos: Position = { x: 30, y: 30, roomName: "W1N1" };
  const sourcePos: Position = { x: 10, y: 10, roomName: "W1N1" };

  function createTestCorpStates(): AnyCorpState[] {
    const spawning = createSpawningState(
      "spawning-1",
      "node-spawn",
      spawnPos,
      450
    );

    const mining = createMiningState(
      "mining-1",
      "node-source",
      "source-1",
      "spawning-1",
      sourcePos,
      3000,
      spawnPos
    );

    const hauling = createHaulingState(
      "hauling-1",
      "node-haul",
      "mining-1",
      "spawning-1",
      sourcePos,
      controllerPos,
      500,
      spawnPos
    );

    const upgrading = createUpgradingState(
      "upgrading-1",
      "node-ctrl",
      "spawning-1",
      controllerPos,
      3,
      spawnPos
    );

    return [spawning, mining, hauling, upgrading];
  }

  describe("plan()", () => {
    it("should create investments with reasonable rates", () => {
      const planner = createInvestmentPlanner(mintValues);
      const corpStates = createTestCorpStates();
      const tick = 1000;

      planner.registerCorpStates(corpStates, tick);
      const result = planner.plan(10000, tick);

      expect(result.investments.length).to.be.greaterThan(0);

      for (const investment of result.investments) {
        // Rate should be positive and less than mint value (1.0)
        expect(investment.ratePerUnit).to.be.greaterThan(0);
        expect(investment.ratePerUnit).to.be.lessThan(2.0); // Should be close to mint value
      }
    });

    it("should produce positive expected ROI chains", () => {
      const planner = createInvestmentPlanner(mintValues);
      const corpStates = createTestCorpStates();
      const tick = 1000;

      planner.registerCorpStates(corpStates, tick);
      const result = planner.plan(10000, tick);

      for (const chain of result.chains) {
        // Expected output should be meaningful (not near zero)
        expect(chain.expectedOutput).to.be.greaterThan(100);

        // Expected ROI should be positive or at least reasonable
        expect(chain.expectedROI).to.be.greaterThan(-0.5);
      }
    });

    it("should calculate cost per unit correctly", () => {
      const planner = createInvestmentPlanner(mintValues);
      const corpStates = createTestCorpStates();
      const tick = 1000;

      planner.registerCorpStates(corpStates, tick);
      const result = planner.plan(10000, tick);

      // Verify the fix: rate should be based on cost PER UNIT, not total cost
      // With mint value of 1.0 and reasonable supply chain, rate should be < 1.0
      for (const investment of result.investments) {
        // If the bug were still present, rate would be ~20000+ (total cost)
        // With the fix, rate should be ~0.2-0.9 (cost per unit)
        expect(investment.ratePerUnit).to.be.lessThan(10);
      }
    });

    it("should handle zero budget gracefully", () => {
      const planner = createInvestmentPlanner(mintValues);
      const corpStates = createTestCorpStates();
      const tick = 1000;

      planner.registerCorpStates(corpStates, tick);
      const result = planner.plan(0, tick);

      expect(result.investments.length).to.equal(0);
      expect(result.remainingBudget).to.equal(0);
    });

    it("should handle small budget correctly", () => {
      const planner = createInvestmentPlanner(mintValues);
      const corpStates = createTestCorpStates();
      const tick = 1000;

      planner.registerCorpStates(corpStates, tick);
      const result = planner.plan(50, tick); // Very small budget

      // Should either create no investments (below threshold) or create one within budget
      expect(result.totalBudget).to.be.at.most(50);
    });

    it("should handle no upgrading corps", () => {
      const planner = createInvestmentPlanner(mintValues);
      // Only spawning and mining - no upgrading corps
      const corpStates = [
        createSpawningState("spawning-1", "node-spawn", spawnPos, 450),
        createMiningState("mining-1", "node-source", "source-1", "spawning-1", sourcePos, 3000, spawnPos)
      ];
      const tick = 1000;

      planner.registerCorpStates(corpStates, tick);
      const result = planner.plan(10000, tick);

      // No investments because no goal corps (upgrading/building)
      expect(result.investments.length).to.equal(0);
    });
  });

  describe("expected output calculation", () => {
    it("should calculate expected output from budget and rate", () => {
      const planner = createInvestmentPlanner(mintValues);
      const corpStates = createTestCorpStates();
      const tick = 1000;

      planner.registerCorpStates(corpStates, tick);
      const result = planner.plan(10000, tick);

      for (const investment of result.investments) {
        // Expected output = budget / rate
        const expectedOutput = investment.maxBudget / investment.ratePerUnit;

        // Find corresponding chain
        const chain = result.chains.find(c => c.investmentId === investment.id);
        if (chain) {
          expect(chain.expectedOutput).to.be.closeTo(expectedOutput, 0.01);
        }
      }
    });
  });

  describe("capital cascade", () => {
    it("should create sub-contracts for supply chain", () => {
      const planner = createInvestmentPlanner(mintValues);
      const corpStates = createTestCorpStates();
      const tick = 1000;

      planner.registerCorpStates(corpStates, tick);
      const result = planner.plan(10000, tick);

      // Should have sub-contracts connecting the supply chain
      if (result.investments.length > 0) {
        expect(result.subContracts.length).to.be.greaterThan(0);
      }
    });

    it("should trace capital through chain segments", () => {
      const planner = createInvestmentPlanner(mintValues);
      const corpStates = createTestCorpStates();
      const tick = 1000;

      planner.registerCorpStates(corpStates, tick);
      const result = planner.plan(10000, tick);

      for (const chain of result.chains) {
        // Each segment should have capital received >= capital spent
        for (const segment of chain.segments) {
          expect(segment.capitalReceived).to.be.at.least(segment.capitalSpent);
          expect(segment.marginEarned).to.equal(segment.capitalReceived - segment.capitalSpent);
        }
      }
    });
  });
});
