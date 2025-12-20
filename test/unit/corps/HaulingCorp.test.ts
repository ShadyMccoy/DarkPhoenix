import { expect } from "chai";
import {
  HaulingModel,
  HAULING_CONSTANTS,
  calculateHaulingThroughput,
  calculateRoundTripTime,
  calculateTripsPerLifetime
} from "../../../src/planning/models/HaulingModel";
import { Position } from "../../../src/market/Offer";

describe("HaulingModel", () => {
  const sourcePosition: Position = { x: 10, y: 10, roomName: "W1N1" };
  const destPosition: Position = { x: 30, y: 30, roomName: "W1N1" };
  // Distance: |30-10| + |30-10| = 40

  describe("constructor", () => {
    it("should create a hauling corp with correct properties", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);

      expect(corp.type).to.equal("hauling");
      expect(corp.nodeId).to.equal("node1");
      expect(corp.getFromLocation()).to.deep.equal(sourcePosition);
      expect(corp.getToLocation()).to.deep.equal(destPosition);
      expect(corp.getDistance()).to.equal(40);
    });

    it("should set primary position to destination", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);
      expect(corp.getPosition()).to.deep.equal(destPosition);
    });
  });

  describe("calculateRoundTripTime()", () => {
    it("should calculate round trip time correctly", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);

      // Distance: 40, round trip: 80
      // At 1.5 ticks/tile: ceil(80 × 1.5) = 120 ticks
      expect(corp.calculateRoundTripTime()).to.equal(120);
    });

    it("should use custom move speed", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);

      // At 1 tick/tile (roads): ceil(80 × 1) = 80 ticks
      expect(corp.calculateRoundTripTime(1)).to.equal(80);
    });
  });

  describe("calculateTripsPerLifetime()", () => {
    it("should calculate trips per lifetime", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);

      // 1500 ticks / 120 ticks per trip = 12 trips
      expect(corp.calculateTripsPerLifetime()).to.equal(12);
    });
  });

  describe("calculateThroughput()", () => {
    it("should calculate total throughput", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);

      // 10 CARRY × 50 capacity = 500 per trip
      // 12 trips × 500 = 6000 energy
      expect(corp.calculateThroughput(10)).to.equal(6000);
    });

    it("should scale with carry parts", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);

      // 20 CARRY × 50 = 1000 per trip × 12 = 12000
      expect(corp.calculateThroughput(20)).to.equal(12000);
    });
  });

  describe("buys()", () => {
    it("should return buy offers for energy and carry-ticks", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);

      const offers = corp.buys();
      expect(offers).to.have.length(2);

      const resources = offers.map((o) => o.resource);
      expect(resources).to.include("energy");
      expect(resources).to.include("carry-ticks");
    });

    it("should locate energy buy at source", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);

      const energyOffer = corp.buys().find((o) => o.resource === "energy")!;
      expect(energyOffer.location).to.deep.equal(sourcePosition);
    });

    it("should request correct energy quantity", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);

      const energyOffer = corp.buys().find((o) => o.resource === "energy")!;
      expect(energyOffer.quantity).to.equal(corp.calculateThroughput());
    });
  });

  describe("sells()", () => {
    it("should return sell offer for energy at destination", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);

      const offers = corp.sells();
      expect(offers).to.have.length(1);

      const energyOffer = offers[0];
      expect(energyOffer.type).to.equal("sell");
      expect(energyOffer.resource).to.equal("energy");
      expect(energyOffer.location).to.deep.equal(destPosition);
    });

    it("should apply margin to price", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);
      corp.setInputCosts(100, 50);

      const offers = corp.sells();
      // Total input: 150, with 10% margin: 165
      expect(offers[0].price).to.be.closeTo(165, 0.01);
    });
  });

  describe("assignCarryParts()", () => {
    it("should set assigned carry parts", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);

      corp.assignCarryParts(15);
      expect(corp.getAssignedCarryParts()).to.equal(15);
    });

    it("should not allow negative parts", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);

      corp.assignCarryParts(-5);
      expect(corp.getAssignedCarryParts()).to.equal(0);
    });
  });

  describe("getCurrentCapacity()", () => {
    it("should calculate capacity based on carry parts", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);

      corp.assignCarryParts(10);
      expect(corp.getCurrentCapacity()).to.equal(500);
    });
  });

  describe("recordDelivery()", () => {
    it("should update stats and record revenue", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);

      corp.recordDelivery(500, 100);

      const stats = corp.getStats();
      expect(stats.totalTransported).to.equal(500);
      expect(stats.tripCount).to.equal(1);
      expect(corp.balance).to.equal(100);
    });

    it("should track multiple deliveries", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);

      corp.recordDelivery(500, 100);
      corp.recordDelivery(500, 100);
      corp.recordDelivery(500, 100);

      const stats = corp.getStats();
      expect(stats.totalTransported).to.equal(1500);
      expect(stats.tripCount).to.equal(3);
      expect(stats.averagePerTrip).to.equal(500);
    });
  });

  describe("getEfficiency()", () => {
    it("should return 0 with no trips", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);
      expect(corp.getEfficiency()).to.equal(0);
    });

    it("should calculate efficiency correctly", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);
      corp.assignCarryParts(10);

      // Full capacity trip
      corp.recordDelivery(500, 100);
      expect(corp.getEfficiency()).to.equal(1);

      // Half capacity trip
      corp.recordDelivery(250, 50);
      expect(corp.getEfficiency()).to.be.closeTo(0.75, 0.01);
    });
  });

  describe("isProfitable()", () => {
    it("should return true when destination value exceeds costs", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);
      corp.setInputCosts(60, 30);

      // Source: 0.01/energy, Dest: 0.02/energy (2x value)
      expect(corp.isProfitable(0.02, 0.01)).to.be.true;
    });

    it("should return false when costs exceed value", () => {
      const corp = new HaulingModel("node1", sourcePosition, destPosition);
      corp.setInputCosts(100, 100);

      // Source and dest same value - transport cost makes it unprofitable
      expect(corp.isProfitable(0.01, 0.01)).to.be.false;
    });
  });
});

describe("HaulingModel pure functions", () => {
  describe("calculateHaulingThroughput()", () => {
    it("should calculate throughput correctly", () => {
      // 10 carry × 50 = 500 capacity
      // Distance 40, round trip 80 × 1.5 = 120 ticks
      // 1500 / 120 = 12 trips
      // 12 × 500 = 6000
      expect(calculateHaulingThroughput(10, 40)).to.equal(6000);
    });

    it("should scale with carry parts", () => {
      expect(calculateHaulingThroughput(20, 40)).to.equal(12000);
    });

    it("should handle zero distance", () => {
      // Same location means instant transfers
      expect(calculateHaulingThroughput(10, 0)).to.equal(500 * 1500);
    });
  });

  describe("calculateRoundTripTime()", () => {
    it("should calculate correctly", () => {
      expect(calculateRoundTripTime(40)).to.equal(120);
      expect(calculateRoundTripTime(40, 1)).to.equal(80);
    });
  });

  describe("calculateTripsPerLifetime()", () => {
    it("should calculate correctly", () => {
      expect(calculateTripsPerLifetime(40)).to.equal(12);
      expect(calculateTripsPerLifetime(40, 1)).to.equal(18);
    });
  });
});
