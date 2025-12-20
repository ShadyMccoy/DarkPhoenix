import { expect } from "chai";
import {
  UpgradingModel,
  UPGRADING_CONSTANTS,
  calculateExpectedUpgradeOutput,
  calculateUpgradeEnergyNeeded,
  calculateUpgradeEfficiency
} from "../../../src/planning/models/UpgradingModel";
import { Position } from "../../../src/market/Offer";

describe("UpgradingModel", () => {
  const controllerPosition: Position = { x: 25, y: 25, roomName: "W1N1" };

  describe("constructor", () => {
    it("should create an upgrading corp with correct properties", () => {
      const corp = new UpgradingModel(
        "node1",
        controllerPosition,
        3
      );

      expect(corp.type).to.equal("upgrading");
      expect(corp.nodeId).to.equal("node1");
      expect(corp.controllerId).to.equal("controller-node1");
      expect(corp.getPosition()).to.deep.equal(controllerPosition);
      expect(corp.getControllerLevel()).to.equal(3);
    });

    it("should default to level 1", () => {
      const corp = new UpgradingModel("node1", controllerPosition);
      expect(corp.getControllerLevel()).to.equal(1);
    });
  });

  describe("setControllerLevel()", () => {
    it("should update controller level", () => {
      const corp = new UpgradingModel("node1", controllerPosition);

      corp.setControllerLevel(5);
      expect(corp.getControllerLevel()).to.equal(5);
    });

    it("should clamp to valid range", () => {
      const corp = new UpgradingModel("node1", controllerPosition);

      corp.setControllerLevel(0);
      expect(corp.getControllerLevel()).to.equal(1);

      corp.setControllerLevel(10);
      expect(corp.getControllerLevel()).to.equal(8);
    });
  });

  describe("calculateUpgradeRate()", () => {
    it("should calculate rate based on work parts", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 3);

      // 10 WORK × 1 upgrade power = 10 points/tick
      expect(corp.calculateUpgradeRate(10)).to.equal(10);
    });

    it("should cap at RCL 8 limit", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 8);

      // At RCL 8, max is 15 points/tick
      expect(corp.calculateUpgradeRate(20)).to.equal(15);
    });
  });

  describe("calculateExpectedOutput()", () => {
    it("should calculate output over lifetime", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 3);

      // 15 WORK × 1500 ticks = 22500 points
      expect(corp.calculateExpectedOutput(15)).to.equal(22500);
    });

    it("should cap at RCL 8", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 8);

      // 15 points/tick max × 1500 = 22500
      expect(corp.calculateExpectedOutput(20)).to.equal(22500);
    });
  });

  describe("calculateEnergyNeeded()", () => {
    it("should calculate energy for expected output", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 3);

      // 1 energy per upgrade point
      expect(corp.calculateEnergyNeeded(15)).to.equal(22500);
    });
  });

  describe("buys()", () => {
    it("should return buy offers for energy and work-ticks", () => {
      const corp = new UpgradingModel("node1", controllerPosition);

      const offers = corp.buys();
      expect(offers).to.have.length(2);

      const resources = offers.map((o) => o.resource);
      expect(resources).to.include("energy");
      expect(resources).to.include("work-ticks");
    });

    it("should locate offers at controller", () => {
      const corp = new UpgradingModel("node1", controllerPosition);

      const offers = corp.buys();
      for (const offer of offers) {
        expect(offer.location).to.deep.equal(controllerPosition);
      }
    });
  });

  describe("sells()", () => {
    it("should return sell offer for rcl-progress", () => {
      const corp = new UpgradingModel("node1", controllerPosition);

      const offers = corp.sells();
      expect(offers).to.have.length(1);

      const progressOffer = offers[0];
      expect(progressOffer.type).to.equal("sell");
      expect(progressOffer.resource).to.equal("rcl-progress");
    });

    it("should set correct quantity", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 3);

      const offers = corp.sells();
      expect(offers[0].quantity).to.equal(22500);
    });

    it("should apply margin to price", () => {
      const corp = new UpgradingModel("node1", controllerPosition);
      corp.setInputCosts(100, 100);

      const offers = corp.sells();
      // Total input: 200, with 10% margin: 220
      expect(offers[0].price).to.be.closeTo(220, 0.01);
    });
  });

  describe("assignWorkParts()", () => {
    it("should set assigned work parts", () => {
      const corp = new UpgradingModel("node1", controllerPosition);

      corp.assignWorkParts(15);
      expect(corp.getAssignedWorkParts()).to.equal(15);
    });

    it("should not allow negative parts", () => {
      const corp = new UpgradingModel("node1", controllerPosition);

      corp.assignWorkParts(-5);
      expect(corp.getAssignedWorkParts()).to.equal(0);
    });
  });

  describe("work()", () => {
    it("should update stats when work parts assigned", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 3);
      corp.assignWorkParts(10);

      corp.work(100);

      const stats = corp.getStats();
      expect(stats.upgradePointsThisTick).to.equal(10);
      expect(stats.totalUpgradePoints).to.equal(10);
      expect(stats.totalEnergyConsumed).to.equal(10);
      expect(stats.activeTicks).to.equal(1);
    });

    it("should accumulate over multiple ticks", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 3);
      corp.assignWorkParts(10);

      corp.work(100);
      corp.work(101);
      corp.work(102);

      const stats = corp.getStats();
      expect(stats.totalUpgradePoints).to.equal(30);
      expect(stats.activeTicks).to.equal(3);
    });

    it("should respect RCL 8 cap", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 8);
      corp.assignWorkParts(20);

      corp.work(100);

      expect(corp.getStats().upgradePointsThisTick).to.equal(15);
    });
  });

  describe("getUpgradeWorkThisTick()", () => {
    it("should return upgrade points from last tick", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 3);
      corp.assignWorkParts(10);
      corp.work(100);

      expect(corp.getUpgradeWorkThisTick()).to.equal(10);
    });

    it("should return 0 when no work parts assigned", () => {
      const corp = new UpgradingModel("node1", controllerPosition);
      corp.work(100);

      expect(corp.getUpgradeWorkThisTick()).to.equal(0);
    });
  });

  describe("getEfficiency()", () => {
    it("should return 0 when no active ticks", () => {
      const corp = new UpgradingModel("node1", controllerPosition);
      expect(corp.getEfficiency()).to.equal(0);
    });

    it("should calculate efficiency correctly", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 3);
      corp.assignWorkParts(10);
      corp.work(100);

      expect(corp.getEfficiency()).to.equal(1);
    });
  });

  describe("isAtMaxCapacity()", () => {
    it("should return false before RCL 8", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 7);
      corp.assignWorkParts(20);
      expect(corp.isAtMaxCapacity()).to.be.false;
    });

    it("should return true at RCL 8 with enough work parts", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 8);
      corp.assignWorkParts(15);
      expect(corp.isAtMaxCapacity()).to.be.true;
    });

    it("should return false at RCL 8 with insufficient work parts", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 8);
      corp.assignWorkParts(10);
      expect(corp.isAtMaxCapacity()).to.be.false;
    });
  });

  describe("getOptimalWorkParts()", () => {
    it("should return standard optimal before RCL 8", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 5);
      expect(corp.getOptimalWorkParts()).to.equal(UPGRADING_CONSTANTS.OPTIMAL_WORK_PARTS);
    });

    it("should return capped value at RCL 8", () => {
      const corp = new UpgradingModel("node1", controllerPosition, 8);
      expect(corp.getOptimalWorkParts()).to.equal(15);
    });
  });
});

describe("UpgradingCorp pure functions", () => {
  describe("calculateExpectedUpgradeOutput()", () => {
    it("should calculate output correctly", () => {
      expect(calculateExpectedUpgradeOutput(10, 3, 1500)).to.equal(15000);
      expect(calculateExpectedUpgradeOutput(15, 3, 1500)).to.equal(22500);
    });

    it("should cap at RCL 8", () => {
      expect(calculateExpectedUpgradeOutput(20, 8, 1500)).to.equal(22500);
    });
  });

  describe("calculateUpgradeEnergyNeeded()", () => {
    it("should calculate energy correctly", () => {
      expect(calculateUpgradeEnergyNeeded(10, 3, 1500)).to.equal(15000);
    });

    it("should respect RCL 8 cap", () => {
      expect(calculateUpgradeEnergyNeeded(20, 8, 1500)).to.equal(22500);
    });
  });

  describe("calculateUpgradeEfficiency()", () => {
    it("should calculate efficiency correctly", () => {
      expect(calculateUpgradeEfficiency(10000, 1000, 10, 3)).to.equal(1);
      expect(calculateUpgradeEfficiency(5000, 1000, 10, 3)).to.be.closeTo(0.5, 0.01);
    });

    it("should return 0 for no active ticks", () => {
      expect(calculateUpgradeEfficiency(100, 0, 10, 3)).to.equal(0);
    });

    it("should account for RCL 8 cap", () => {
      // At RCL 8, 20 work parts still only produces 15/tick
      expect(calculateUpgradeEfficiency(15000, 1000, 20, 8)).to.equal(1);
    });
  });
});
