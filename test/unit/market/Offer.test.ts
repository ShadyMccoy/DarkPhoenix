import { expect } from "chai";
import {
  Offer,
  Position,
  perTick,
  unitPrice,
  manhattanDistance,
  parseRoomName,
  effectivePrice,
  landedCostForCreep,
  creepProductivityFactor,
  rawQuantityForEffectiveWork,
  effectiveQuantityFromCreep,
  canMatch,
  createOfferId,
  sortByEffectivePrice,
  estimateCrossRoomDistance
} from "../../../src/market/Offer";

describe("Offer", () => {
  describe("perTick()", () => {
    it("should calculate per-tick rate correctly", () => {
      const offer: Offer = {
        id: "test",
        corpId: "corp1",
        type: "sell",
        resource: "energy",
        quantity: 1500,
        price: 100,
        duration: 150
      };
      expect(perTick(offer)).to.equal(10);
    });

    it("should return 0 for zero duration", () => {
      const offer: Offer = {
        id: "test",
        corpId: "corp1",
        type: "sell",
        resource: "energy",
        quantity: 100,
        price: 50,
        duration: 0
      };
      expect(perTick(offer)).to.equal(0);
    });
  });

  describe("unitPrice()", () => {
    it("should calculate unit price correctly", () => {
      const offer: Offer = {
        id: "test",
        corpId: "corp1",
        type: "sell",
        resource: "energy",
        quantity: 100,
        price: 50,
        duration: 100
      };
      expect(unitPrice(offer)).to.equal(0.5);
    });

    it("should return 0 for zero quantity", () => {
      const offer: Offer = {
        id: "test",
        corpId: "corp1",
        type: "sell",
        resource: "energy",
        quantity: 0,
        price: 50,
        duration: 100
      };
      expect(unitPrice(offer)).to.equal(0);
    });
  });

  describe("manhattanDistance()", () => {
    it("should calculate same-room distance", () => {
      const a: Position = { x: 10, y: 10, roomName: "W1N1" };
      const b: Position = { x: 15, y: 20, roomName: "W1N1" };
      expect(manhattanDistance(a, b)).to.equal(15); // |15-10| + |20-10|
    });

    it("should return 0 for same position", () => {
      const a: Position = { x: 25, y: 25, roomName: "W1N1" };
      expect(manhattanDistance(a, a)).to.equal(0);
    });
  });

  describe("parseRoomName()", () => {
    it("should parse W1N1 correctly", () => {
      const coords = parseRoomName("W1N1");
      expect(coords).to.deep.equal({ x: -1, y: 1 });
    });

    it("should parse E2S3 correctly", () => {
      const coords = parseRoomName("E2S3");
      expect(coords).to.deep.equal({ x: 2, y: -3 });
    });

    it("should parse W10N20 correctly", () => {
      const coords = parseRoomName("W10N20");
      expect(coords).to.deep.equal({ x: -10, y: 20 });
    });

    it("should return null for invalid room name", () => {
      expect(parseRoomName("invalid")).to.be.null;
      expect(parseRoomName("")).to.be.null;
    });
  });

  describe("estimateCrossRoomDistance()", () => {
    it("should estimate distance across rooms", () => {
      const a: Position = { x: 25, y: 25, roomName: "W1N1" };
      const b: Position = { x: 25, y: 25, roomName: "W2N1" };
      // 1 room = 50 tiles, same y position
      expect(estimateCrossRoomDistance(a, b)).to.equal(50);
    });

    it("should add in-room distances", () => {
      const a: Position = { x: 10, y: 10, roomName: "W1N1" };
      const b: Position = { x: 40, y: 40, roomName: "W2N2" };
      // 2 rooms distance (W->E and N->S) = 100 tiles + in-room offset
      const distance = estimateCrossRoomDistance(a, b);
      expect(distance).to.be.greaterThan(100);
    });

    it("should return Infinity for invalid room names", () => {
      const a: Position = { x: 10, y: 10, roomName: "invalid" };
      const b: Position = { x: 20, y: 20, roomName: "W1N1" };
      expect(estimateCrossRoomDistance(a, b)).to.equal(Infinity);
    });
  });

  describe("creepProductivityFactor()", () => {
    it("should return 1.0 at same location", () => {
      const spawnPos: Position = { x: 25, y: 25, roomName: "W1N1" };
      const workPos: Position = { x: 25, y: 25, roomName: "W1N1" };
      expect(creepProductivityFactor(spawnPos, workPos)).to.equal(1);
    });

    it("should return 0.5 when travel takes half the lifetime", () => {
      const spawnPos: Position = { x: 10, y: 10, roomName: "W1N1" };
      const workPos: Position = { x: 760, y: 10, roomName: "W1N1" }; // 750 tiles away
      expect(creepProductivityFactor(spawnPos, workPos)).to.equal(0.5);
    });

    it("should return 0 for unreachable locations", () => {
      const spawnPos: Position = { x: 10, y: 10, roomName: "W1N1" };
      const workPos: Position = { x: 10, y: 10, roomName: "invalid" };
      expect(creepProductivityFactor(spawnPos, workPos)).to.equal(0);
    });

    it("should return 0 when travel exceeds lifetime", () => {
      const spawnPos: Position = { x: 10, y: 10, roomName: "W1N1" };
      const workPos: Position = { x: 1510, y: 10, roomName: "W1N1" }; // 1500+ tiles away
      expect(creepProductivityFactor(spawnPos, workPos)).to.equal(0);
    });
  });

  describe("rawQuantityForEffectiveWork()", () => {
    it("should return same quantity at same location", () => {
      const spawnPos: Position = { x: 25, y: 25, roomName: "W1N1" };
      const workPos: Position = { x: 25, y: 25, roomName: "W1N1" };
      expect(rawQuantityForEffectiveWork(10000, spawnPos, workPos)).to.equal(10000);
    });

    it("should double purchase when productivity is 50%", () => {
      const spawnPos: Position = { x: 10, y: 10, roomName: "W1N1" };
      const workPos: Position = { x: 760, y: 10, roomName: "W1N1" }; // 750 tiles, 50% productivity
      // Need 10,000 effective, must buy 20,000 raw
      expect(rawQuantityForEffectiveWork(10000, spawnPos, workPos)).to.equal(20000);
    });

    it("should return Infinity for unreachable locations", () => {
      const spawnPos: Position = { x: 10, y: 10, roomName: "W1N1" };
      const workPos: Position = { x: 10, y: 10, roomName: "invalid" };
      expect(rawQuantityForEffectiveWork(10000, spawnPos, workPos)).to.equal(Infinity);
    });
  });

  describe("effectiveQuantityFromCreep()", () => {
    it("should return same quantity at same location", () => {
      const spawnPos: Position = { x: 25, y: 25, roomName: "W1N1" };
      const workPos: Position = { x: 25, y: 25, roomName: "W1N1" };
      expect(effectiveQuantityFromCreep(10000, spawnPos, workPos)).to.equal(10000);
    });

    it("should halve effective quantity when productivity is 50%", () => {
      const spawnPos: Position = { x: 10, y: 10, roomName: "W1N1" };
      const workPos: Position = { x: 760, y: 10, roomName: "W1N1" }; // 750 tiles, 50% productivity
      // Buy 20,000 raw, receive 10,000 effective
      expect(effectiveQuantityFromCreep(20000, spawnPos, workPos)).to.equal(10000);
    });

    it("should return 0 for unreachable locations", () => {
      const spawnPos: Position = { x: 10, y: 10, roomName: "W1N1" };
      const workPos: Position = { x: 10, y: 10, roomName: "invalid" };
      expect(effectiveQuantityFromCreep(10000, spawnPos, workPos)).to.equal(0);
    });
  });

  describe("landedCostForCreep()", () => {
    it("should return base price when at same location", () => {
      const spawnPos: Position = { x: 25, y: 25, roomName: "W1N1" };
      const workPos: Position = { x: 25, y: 25, roomName: "W1N1" };
      expect(landedCostForCreep(100, spawnPos, workPos)).to.equal(100);
    });

    it("should scale price based on travel time penalty", () => {
      const spawnPos: Position = { x: 10, y: 10, roomName: "W1N1" };
      const workPos: Position = { x: 110, y: 10, roomName: "W1N1" }; // 100 tiles away
      // Travel time = 100, effective work time = 1500 - 100 = 1400
      // Multiplier = 1500 / 1400 ≈ 1.071
      const result = landedCostForCreep(100, spawnPos, workPos);
      expect(result).to.be.closeTo(107.14, 0.1);
    });

    it("should double price when travel takes half the lifetime", () => {
      const spawnPos: Position = { x: 10, y: 10, roomName: "W1N1" };
      const workPos: Position = { x: 760, y: 10, roomName: "W1N1" }; // 750 tiles away
      // Travel time = 750, effective work time = 1500 - 750 = 750
      // Multiplier = 1500 / 750 = 2.0
      const result = landedCostForCreep(100, spawnPos, workPos);
      expect(result).to.equal(200);
    });

    it("should return Infinity for unreachable locations", () => {
      const spawnPos: Position = { x: 10, y: 10, roomName: "W1N1" };
      const workPos: Position = { x: 10, y: 10, roomName: "invalid" };
      expect(landedCostForCreep(100, spawnPos, workPos)).to.equal(Infinity);
    });

    it("should handle cross-room distance", () => {
      const spawnPos: Position = { x: 25, y: 25, roomName: "W1N1" };
      const workPos: Position = { x: 25, y: 25, roomName: "W2N1" }; // 50 tiles (1 room)
      // Travel time = 50, effective work time = 1500 - 50 = 1450
      // Multiplier = 1500 / 1450 ≈ 1.034
      const result = landedCostForCreep(100, spawnPos, workPos);
      expect(result).to.be.closeTo(103.45, 0.1);
    });
  });

  describe("effectivePrice()", () => {
    it("should return base price when no location", () => {
      const offer: Offer = {
        id: "test",
        corpId: "corp1",
        type: "sell",
        resource: "energy",
        quantity: 100,
        price: 50,
        duration: 100
      };
      const buyerPos: Position = { x: 25, y: 25, roomName: "W1N1" };
      expect(effectivePrice(offer, buyerPos)).to.equal(50);
    });

    it("should add distance penalty for physical resources", () => {
      const offer: Offer = {
        id: "test",
        corpId: "corp1",
        type: "sell",
        resource: "energy",
        quantity: 100,
        price: 50,
        duration: 100,
        location: { x: 10, y: 10, roomName: "W1N1" }
      };
      const buyerPos: Position = { x: 20, y: 10, roomName: "W1N1" };
      // Distance = 10, hauling cost = 10 * 0.01 * 100 = 10
      expect(effectivePrice(offer, buyerPos)).to.equal(60);
    });

    it("should use custom hauling cost", () => {
      const offer: Offer = {
        id: "test",
        corpId: "corp1",
        type: "sell",
        resource: "energy",
        quantity: 100,
        price: 50,
        duration: 100,
        location: { x: 10, y: 10, roomName: "W1N1" }
      };
      const buyerPos: Position = { x: 20, y: 10, roomName: "W1N1" };
      // Distance = 10, hauling cost = 10 * 0.05 * 100 = 50
      expect(effectivePrice(offer, buyerPos, 0.05)).to.equal(100);
    });

    it("should use travel time penalty for spawn-capacity", () => {
      const offer: Offer = {
        id: "test",
        corpId: "spawn1",
        type: "sell",
        resource: "spawn-capacity",
        quantity: 300, // Energy cost of creep body
        price: 300,
        duration: 1500,
        location: { x: 10, y: 10, roomName: "W1N1" } // Spawn location
      };
      const workPos: Position = { x: 110, y: 10, roomName: "W1N1" }; // 100 tiles away
      // Should use travel time penalty, not hauling cost
      // Travel time = 100, effective work time = 1500 - 100 = 1400
      // Multiplier = 1500 / 1400 ≈ 1.071
      const result = effectivePrice(offer, workPos);
      expect(result).to.be.closeTo(321.43, 0.1);
    });

    it("should not add penalty for abstract resources like spawning", () => {
      const offer: Offer = {
        id: "test",
        corpId: "corp1",
        type: "sell",
        resource: "spawning",
        quantity: 1000,
        price: 100,
        duration: 1500,
        location: { x: 10, y: 10, roomName: "W1N1" }
      };
      const buyerPos: Position = { x: 110, y: 10, roomName: "W1N1" }; // 100 tiles away
      // Abstract resources have no distance penalty
      expect(effectivePrice(offer, buyerPos)).to.equal(100);
    });
  });

  describe("canMatch()", () => {
    it("should return true for matching buy/sell offers", () => {
      const buy: Offer = {
        id: "buy1",
        corpId: "corp1",
        type: "buy",
        resource: "energy",
        quantity: 100,
        price: 50,
        duration: 100
      };
      const sell: Offer = {
        id: "sell1",
        corpId: "corp2",
        type: "sell",
        resource: "energy",
        quantity: 100,
        price: 60,
        duration: 100
      };
      expect(canMatch(buy, sell)).to.be.true;
    });

    it("should return false for different resources", () => {
      const buy: Offer = {
        id: "buy1",
        corpId: "corp1",
        type: "buy",
        resource: "energy",
        quantity: 100,
        price: 50,
        duration: 100
      };
      const sell: Offer = {
        id: "sell1",
        corpId: "corp2",
        type: "sell",
        resource: "spawning",
        quantity: 100,
        price: 60,
        duration: 100
      };
      expect(canMatch(buy, sell)).to.be.false;
    });

    it("should return false for same offer types", () => {
      const buy1: Offer = {
        id: "buy1",
        corpId: "corp1",
        type: "buy",
        resource: "energy",
        quantity: 100,
        price: 50,
        duration: 100
      };
      const buy2: Offer = {
        id: "buy2",
        corpId: "corp2",
        type: "buy",
        resource: "energy",
        quantity: 100,
        price: 60,
        duration: 100
      };
      expect(canMatch(buy1, buy2)).to.be.false;
    });
  });

  describe("createOfferId()", () => {
    it("should create unique IDs", () => {
      const id1 = createOfferId("corp1", "energy", 1000);
      const id2 = createOfferId("corp1", "spawning", 1000);
      const id3 = createOfferId("corp1", "energy", 1001);

      expect(id1).to.not.equal(id2);
      expect(id1).to.not.equal(id3);
    });
  });

  describe("sortByEffectivePrice()", () => {
    it("should sort offers by effective price", () => {
      const buyerPos: Position = { x: 25, y: 25, roomName: "W1N1" };
      const offers: Offer[] = [
        {
          id: "o1",
          corpId: "corp1",
          type: "sell",
          resource: "energy",
          quantity: 100,
          price: 100,
          duration: 100,
          location: { x: 25, y: 25, roomName: "W1N1" } // Distance 0
        },
        {
          id: "o2",
          corpId: "corp2",
          type: "sell",
          resource: "energy",
          quantity: 100,
          price: 50,
          duration: 100,
          location: { x: 25, y: 25, roomName: "W1N1" } // Distance 0
        },
        {
          id: "o3",
          corpId: "corp3",
          type: "sell",
          resource: "energy",
          quantity: 100,
          price: 75,
          duration: 100,
          location: { x: 25, y: 25, roomName: "W1N1" } // Distance 0
        }
      ];

      const sorted = sortByEffectivePrice(offers, buyerPos);
      expect(sorted[0].price).to.equal(50);
      expect(sorted[1].price).to.equal(75);
      expect(sorted[2].price).to.equal(100);
    });
  });
});
