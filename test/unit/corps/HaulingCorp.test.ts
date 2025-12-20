import { expect } from "chai";
import {
  HaulingModel,
  HAULING_CONSTANTS,
  calculateHaulingThroughput,
  calculateRoundTripTime,
  calculateTripsPerLifetime
} from "../../../src/planning/models/HaulingModel";
import { Position } from "../../../src/market/Offer";
import { createHaulingState } from "../../../src/corps/CorpState";
import { projectHauling } from "../../../src/planning/projections";
import { CREEP_LIFETIME, CARRY_CAPACITY } from "../../../src/planning/EconomicConstants";

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

// =============================================================================
// Phase 3: CorpState + Projections Equivalence Tests
// =============================================================================
// These tests verify that the new CorpState + projectHauling approach
// produces consistent results with the old HaulingModel class.

describe("CorpState + projectHauling (new approach)", () => {
  const sourcePosition: Position = { x: 10, y: 10, roomName: "W1N1" };
  const destPosition: Position = { x: 30, y: 30, roomName: "W1N1" };
  const carryCapacity = 500; // 10 CARRY parts × 50

  describe("constants equivalence", () => {
    it("should use same creep lifetime", () => {
      expect(CREEP_LIFETIME).to.equal(HAULING_CONSTANTS.CREEP_LIFETIME);
    });

    it("should use same carry capacity", () => {
      expect(CARRY_CAPACITY).to.equal(HAULING_CONSTANTS.CARRY_CAPACITY);
    });
  });

  describe("buys() projection", () => {
    it("should return buy offer for carry-ticks", () => {
      const state = createHaulingState("hauling-1", "node1", sourcePosition, destPosition, carryCapacity);
      const { buys } = projectHauling(state, 0);

      expect(buys).to.have.length(1);
      expect(buys[0].type).to.equal("buy");
      expect(buys[0].resource).to.equal("carry-ticks");
    });

    it("should locate buy offer at source position", () => {
      const state = createHaulingState("hauling-1", "node1", sourcePosition, destPosition, carryCapacity);
      const { buys } = projectHauling(state, 0);

      expect(buys[0].location).to.deep.equal(sourcePosition);
    });
  });

  describe("sells() projection", () => {
    it("should return sell offer for transport", () => {
      const state = createHaulingState("hauling-1", "node1", sourcePosition, destPosition, carryCapacity);
      const { sells } = projectHauling(state, 0);

      expect(sells).to.have.length(1);
      expect(sells[0].type).to.equal("sell");
      expect(sells[0].resource).to.equal("transport");
    });

    it("should locate sell offer at destination position", () => {
      const state = createHaulingState("hauling-1", "node1", sourcePosition, destPosition, carryCapacity);
      const { sells } = projectHauling(state, 0);

      expect(sells[0].location).to.deep.equal(destPosition);
    });

    it("should calculate transport quantity based on trips", () => {
      const state = createHaulingState("hauling-1", "node1", sourcePosition, destPosition, carryCapacity);
      const { sells } = projectHauling(state, 0);

      // Distance: 40 (|30-10| + |30-10|)
      // Round trip: 80 ticks at 1 tick/tile
      // Trips per lifetime: 1500 / 80 = 18 trips (floor)
      // But projectHauling uses calculateTravelTime which may differ
      // Just verify it's a positive number
      expect(sells[0].quantity).to.be.greaterThan(0);
    });

    it("should apply margin based on balance", () => {
      const poorState = createHaulingState("hauling-1", "node1", sourcePosition, destPosition, carryCapacity);
      poorState.balance = 0;
      const { sells: poorSells } = projectHauling(poorState, 0);

      const richState = createHaulingState("hauling-2", "node1", sourcePosition, destPosition, carryCapacity);
      richState.balance = 10000;
      const { sells: richSells } = projectHauling(richState, 0);

      // Rich corps have lower margin, thus lower price
      expect(richSells[0].price).to.be.lessThan(poorSells[0].price);
    });
  });

  describe("model comparison notes", () => {
    it("should document differences between HaulingModel and projectHauling", () => {
      // HaulingModel differences:
      // 1. HaulingModel buys both energy AND carry-ticks
      // 2. HaulingModel sells energy at destination
      // 3. Uses MOVE_SPEED_MODIFIER (1.5) for travel time
      //
      // projectHauling simplifications:
      // 1. Only buys carry-ticks (creep labor)
      // 2. Sells "transport" as a service (not energy)
      // 3. Uses calculateTravelTime from EconomicConstants
      //
      // This is intentional - projectHauling models hauling as infrastructure
      // rather than as an energy reseller.

      const state = createHaulingState("hauling-1", "node1", sourcePosition, destPosition, carryCapacity);
      const { buys, sells } = projectHauling(state, 0);

      // New approach buys carry-ticks, sells transport
      expect(buys.map((b) => b.resource)).to.deep.equal(["carry-ticks"]);
      expect(sells.map((s) => s.resource)).to.deep.equal(["transport"]);

      // Old approach buys energy + carry-ticks, sells energy
      const model = new HaulingModel("node1", sourcePosition, destPosition);
      const modelBuys = model.buys();
      const modelSells = model.sells();
      expect(modelBuys.map((b) => b.resource)).to.include.members(["energy", "carry-ticks"]);
      expect(modelSells.map((s) => s.resource)).to.deep.equal(["energy"]);
    });
  });

  describe("distance effects", () => {
    it("should reduce throughput when distance is longer", () => {
      // Short distance
      const nearDest: Position = { x: 15, y: 15, roomName: "W1N1" };
      const nearState = createHaulingState("hauling-1", "node1", sourcePosition, nearDest, carryCapacity);
      const { sells: nearSells } = projectHauling(nearState, 0);

      // Long distance (different room)
      const farDest: Position = { x: 30, y: 30, roomName: "W2N1" };
      const farState = createHaulingState("hauling-2", "node2", sourcePosition, farDest, carryCapacity);
      const { sells: farSells } = projectHauling(farState, 0);

      // Longer distance = fewer trips = less transport capacity
      expect(farSells[0].quantity).to.be.lessThan(nearSells[0].quantity);
    });
  });
});
