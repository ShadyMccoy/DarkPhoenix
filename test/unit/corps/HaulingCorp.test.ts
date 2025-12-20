import { expect } from "chai";
import { Position } from "../../../src/market/Offer";
import { createHaulingState } from "../../../src/corps/CorpState";
import { projectHauling } from "../../../src/planning/projections";
import { CREEP_LIFETIME, CARRY_CAPACITY } from "../../../src/planning/EconomicConstants";

describe("HaulingCorp projections", () => {
  const sourcePosition: Position = { x: 10, y: 10, roomName: "W1N1" };
  const destPosition: Position = { x: 30, y: 30, roomName: "W1N1" };
  const carryCapacity = 500; // 10 CARRY parts × 50

  describe("projectHauling", () => {
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

      // Verify it's a positive number based on distance and capacity
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

  describe("economic constants", () => {
    it("should use correct creep lifetime", () => {
      expect(CREEP_LIFETIME).to.equal(1500);
    });

    it("should use correct carry capacity", () => {
      expect(CARRY_CAPACITY).to.equal(50);
    });
  });
});
