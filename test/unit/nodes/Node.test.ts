import { expect } from "chai";
import {
  Node,
  NodeResource,
  createNodeId,
  createNode,
  collectNodeOffers,
  getCorpsByType,
  getResourcesByType,
  hasResourceType,
  getTotalBalance,
  getActiveCorps,
  pruneDead,
  isPositionInNode,
  distanceToPeak
} from "../../../src/nodes/Node";
import { Corp, CorpType } from "../../../src/corps/Corp";
import { Offer, Position } from "../../../src/market/Offer";

/**
 * Test Corp implementation
 */
class TestCorp extends Corp {
  private position: Position;
  private _sells: Offer[] = [];
  private _buys: Offer[] = [];

  constructor(type: CorpType, nodeId: string, position?: Position) {
    super(type, nodeId);
    this.position = position ?? { x: 25, y: 25, roomName: "W1N1" };
  }

  sells(): Offer[] {
    return this._sells;
  }

  buys(): Offer[] {
    return this._buys;
  }

  work(tick: number): void {
    this.lastActivityTick = tick;
  }

  getPosition(): Position {
    return this.position;
  }

  setSellOffers(offers: Offer[]): void {
    this._sells = offers;
  }

  setBuyOffers(offers: Offer[]): void {
    this._buys = offers;
  }
}

describe("Node", () => {
  const peakPosition: Position = { x: 25, y: 25, roomName: "W1N1" };

  describe("createNodeId()", () => {
    it("should create ID from room and position", () => {
      const id = createNodeId("W1N1", { x: 25, y: 30, roomName: "W1N1" });
      expect(id).to.equal("W1N1-25-30");
    });
  });

  describe("createNode()", () => {
    it("should create an empty node", () => {
      const node = createNode("node1", "W1N1", peakPosition, [], 100);

      expect(node.id).to.equal("node1");
      expect(node.roomName).to.equal("W1N1");
      expect(node.peakPosition).to.deep.equal(peakPosition);
      expect(node.corps).to.have.length(0);
      expect(node.resources).to.have.length(0);
      expect(node.createdAt).to.equal(100);
    });

    it("should include positions", () => {
      const positions = [
        { x: 24, y: 24, roomName: "W1N1" },
        { x: 25, y: 25, roomName: "W1N1" },
        { x: 26, y: 26, roomName: "W1N1" }
      ];
      const node = createNode("node1", "W1N1", peakPosition, positions);

      expect(node.positions).to.have.length(3);
    });
  });

  describe("collectNodeOffers()", () => {
    it("should collect offers from all corps", () => {
      const node = createNode("node1", "W1N1", peakPosition);

      const corp1 = new TestCorp("mining", "node1");
      corp1.setSellOffers([
        {
          id: "offer1",
          corpId: corp1.id,
          type: "sell",
          resource: "energy",
          quantity: 100,
          price: 10,
          duration: 1500
        }
      ]);

      const corp2 = new TestCorp("spawning", "node1");
      corp2.setBuyOffers([
        {
          id: "offer2",
          corpId: corp2.id,
          type: "buy",
          resource: "energy",
          quantity: 50,
          price: 0,
          duration: 1500
        }
      ]);

      node.corps.push(corp1, corp2);

      const offers = collectNodeOffers(node);
      expect(offers).to.have.length(2);

      const types = offers.map((o) => o.type);
      expect(types).to.include("sell");
      expect(types).to.include("buy");
    });

    it("should return empty array for empty node", () => {
      const node = createNode("node1", "W1N1", peakPosition);
      expect(collectNodeOffers(node)).to.have.length(0);
    });
  });

  describe("getCorpsByType()", () => {
    it("should filter corps by type", () => {
      const node = createNode("node1", "W1N1", peakPosition);
      node.corps.push(
        new TestCorp("mining", "node1"),
        new TestCorp("mining", "node1"),
        new TestCorp("spawning", "node1"),
        new TestCorp("upgrading", "node1")
      );

      const miners = getCorpsByType(node, "mining");
      expect(miners).to.have.length(2);

      const spawners = getCorpsByType(node, "spawning");
      expect(spawners).to.have.length(1);

      const haulers = getCorpsByType(node, "hauling");
      expect(haulers).to.have.length(0);
    });
  });

  describe("getResourcesByType()", () => {
    it("should filter resources by type", () => {
      const node = createNode("node1", "W1N1", peakPosition);
      node.resources.push(
        { type: "source", id: "s1", position: peakPosition },
        { type: "source", id: "s2", position: peakPosition },
        { type: "controller", id: "c1", position: peakPosition }
      );

      const sources = getResourcesByType(node, "source");
      expect(sources).to.have.length(2);

      const controllers = getResourcesByType(node, "controller");
      expect(controllers).to.have.length(1);
    });
  });

  describe("hasResourceType()", () => {
    it("should return true if resource type exists", () => {
      const node = createNode("node1", "W1N1", peakPosition);
      node.resources.push({ type: "source", id: "s1", position: peakPosition });

      expect(hasResourceType(node, "source")).to.be.true;
      expect(hasResourceType(node, "controller")).to.be.false;
    });
  });

  describe("getTotalBalance()", () => {
    it("should sum all corp balances", () => {
      const node = createNode("node1", "W1N1", peakPosition);

      const corp1 = new TestCorp("mining", "node1");
      corp1.balance = 500;

      const corp2 = new TestCorp("spawning", "node1");
      corp2.balance = 300;

      node.corps.push(corp1, corp2);

      expect(getTotalBalance(node)).to.equal(800);
    });

    it("should handle negative balances", () => {
      const node = createNode("node1", "W1N1", peakPosition);

      const corp1 = new TestCorp("mining", "node1");
      corp1.balance = 500;

      const corp2 = new TestCorp("spawning", "node1");
      corp2.balance = -200;

      node.corps.push(corp1, corp2);

      expect(getTotalBalance(node)).to.equal(300);
    });
  });

  describe("getActiveCorps()", () => {
    it("should return only active corps", () => {
      const node = createNode("node1", "W1N1", peakPosition);

      const corp1 = new TestCorp("mining", "node1");
      corp1.isActive = true;

      const corp2 = new TestCorp("spawning", "node1");
      corp2.isActive = false;

      const corp3 = new TestCorp("upgrading", "node1");
      corp3.isActive = true;

      node.corps.push(corp1, corp2, corp3);

      const active = getActiveCorps(node);
      expect(active).to.have.length(2);
    });
  });

  describe("pruneDead()", () => {
    it("should remove bankrupt corps", () => {
      const node = createNode("node1", "W1N1", peakPosition);

      const corp1 = new TestCorp("mining", "node1");
      corp1.balance = 500;
      corp1.createdAt = 0;

      const corp2 = new TestCorp("spawning", "node1");
      corp2.balance = -200;
      corp2.createdAt = 0;

      node.corps.push(corp1, corp2);

      const pruned = pruneDead(node, 2000);

      expect(node.corps).to.have.length(1);
      expect(pruned).to.have.length(1);
      expect(pruned[0].type).to.equal("spawning");
    });

    it("should keep active corps even if balance is low", () => {
      const node = createNode("node1", "W1N1", peakPosition);

      const corp = new TestCorp("mining", "node1");
      corp.balance = 5;
      corp.isActive = true;
      corp.createdAt = 0;

      node.corps.push(corp);

      pruneDead(node, 2000);

      expect(node.corps).to.have.length(1);
    });

    it("should respect grace period for new corps", () => {
      const node = createNode("node1", "W1N1", peakPosition);

      const corp = new TestCorp("mining", "node1");
      corp.balance = 5;
      corp.createdAt = 1000;

      node.corps.push(corp);

      // Tick 1500 is within grace period (1500 ticks)
      pruneDead(node, 1500);
      expect(node.corps).to.have.length(1);

      // Tick 3000 is past grace period
      pruneDead(node, 3000);
      expect(node.corps).to.have.length(0);
    });
  });

  describe("isPositionInNode()", () => {
    it("should return true for position in node territory", () => {
      const node = createNode("node1", "W1N1", peakPosition, [
        { x: 24, y: 24, roomName: "W1N1" },
        { x: 25, y: 25, roomName: "W1N1" },
        { x: 26, y: 26, roomName: "W1N1" }
      ]);

      expect(isPositionInNode(node, { x: 25, y: 25, roomName: "W1N1" })).to.be
        .true;
      expect(isPositionInNode(node, { x: 30, y: 30, roomName: "W1N1" })).to.be
        .false;
    });

    it("should return false for different room", () => {
      const node = createNode("node1", "W1N1", peakPosition, [
        { x: 25, y: 25, roomName: "W1N1" }
      ]);

      expect(isPositionInNode(node, { x: 25, y: 25, roomName: "W2N1" })).to.be
        .false;
    });
  });

  describe("distanceToPeak()", () => {
    it("should calculate Manhattan distance to peak", () => {
      const node = createNode("node1", "W1N1", peakPosition);

      expect(distanceToPeak(node, { x: 25, y: 25, roomName: "W1N1" })).to.equal(
        0
      );
      expect(distanceToPeak(node, { x: 30, y: 30, roomName: "W1N1" })).to.equal(
        10
      );
      expect(distanceToPeak(node, { x: 20, y: 20, roomName: "W1N1" })).to.equal(
        10
      );
    });

    it("should return Infinity for different room", () => {
      const node = createNode("node1", "W1N1", peakPosition);

      expect(distanceToPeak(node, { x: 25, y: 25, roomName: "W2N1" })).to.equal(
        Infinity
      );
    });
  });
});
