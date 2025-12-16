import { expect } from "chai";
import {
  Offer,
  Position,
  perTick,
  unitPrice,
  manhattanDistance,
  parseRoomName,
  effectivePrice,
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

    it("should add distance penalty", () => {
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
        resource: "work-ticks",
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
      const id2 = createOfferId("corp1", "work-ticks", 1000);
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
