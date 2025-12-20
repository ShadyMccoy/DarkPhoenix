import { expect } from "chai";
import { OfferCollector } from "../../../src/planning/OfferCollector";
import { Node } from "../../../src/nodes/Node";
import { Offer, Position } from "../../../src/market/Offer";
import { Corp, CorpType } from "../../../src/corps/Corp";

/**
 * Simple test corp for OfferCollector tests
 */
class MockCorp extends Corp {
  private _sells: Offer[] = [];
  private _buys: Offer[] = [];
  private _position: Position;

  constructor(id: string, type: CorpType, nodeId: string, position: Position) {
    super(type, nodeId);
    (this as any).id = id; // Override readonly id for testing
    this._position = position;
  }

  sells(): Offer[] { return this._sells; }
  buys(): Offer[] { return this._buys; }
  work(): void {}
  getPosition(): Position { return this._position; }

  setSells(offers: Offer[]): void { this._sells = offers; }
  setBuys(offers: Offer[]): void { this._buys = offers; }
}

describe("OfferCollector", () => {
  let collector: OfferCollector;

  beforeEach(() => {
    collector = new OfferCollector();
  });

  const createTestOffer = (
    id: string,
    type: "buy" | "sell",
    resource: string,
    overrides: Partial<Offer> = {}
  ): Offer => ({
    id,
    corpId: "corp1",
    type,
    resource,
    quantity: 100,
    price: 50,
    duration: 100,
    ...overrides
  });

  describe("addOffer()", () => {
    it("should add sell offers to sell index", () => {
      const offer = createTestOffer("o1", "sell", "energy");
      collector.addOffer(offer);

      expect(collector.getSellOffers("energy")).to.have.length(1);
      expect(collector.getBuyOffers("energy")).to.have.length(0);
    });

    it("should add buy offers to buy index", () => {
      const offer = createTestOffer("o1", "buy", "energy");
      collector.addOffer(offer);

      expect(collector.getBuyOffers("energy")).to.have.length(1);
      expect(collector.getSellOffers("energy")).to.have.length(0);
    });

    it("should separate offers by resource type", () => {
      collector.addOffer(createTestOffer("o1", "sell", "energy"));
      collector.addOffer(createTestOffer("o2", "sell", "work-ticks"));

      expect(collector.getSellOffers("energy")).to.have.length(1);
      expect(collector.getSellOffers("work-ticks")).to.have.length(1);
    });
  });

  describe("collect()", () => {
    it("should collect offers from all corps in nodes", () => {
      const pos: Position = { x: 25, y: 25, roomName: "W1N1" };

      const corp1 = new MockCorp("corp1", "mining", "node1", pos);
      corp1.setSells([createTestOffer("o1", "sell", "energy", { corpId: "corp1" })]);

      const corp2 = new MockCorp("corp2", "spawning", "node1", pos);
      corp2.setSells([createTestOffer("o2", "sell", "work-ticks", { corpId: "corp2" })]);
      corp2.setBuys([createTestOffer("o3", "buy", "energy", { corpId: "corp2" })]);

      const nodes: Node[] = [{
        id: "node1",
        peakPosition: pos,
        roomName: "W1N1",
        territorySize: 1,
        spansRooms: ["W1N1"],
        corps: [corp1, corp2],
        resources: [],
        createdAt: 0
      }];

      collector.collect(nodes);

      expect(collector.getAllOffers()).to.have.length(3);
      expect(collector.getSellOffers("energy")).to.have.length(1);
      expect(collector.getSellOffers("work-ticks")).to.have.length(1);
      expect(collector.getBuyOffers("energy")).to.have.length(1);
    });

    it("should clear previous offers on collect", () => {
      collector.addOffer(createTestOffer("old", "sell", "energy"));
      collector.collect([]); // Empty nodes

      expect(collector.getAllOffers()).to.have.length(0);
    });
  });

  describe("collectFromCorps()", () => {
    it("should collect from flat corp list", () => {
      const pos: Position = { x: 25, y: 25, roomName: "W1N1" };

      const corp1 = new MockCorp("corp1", "mining", "node1", pos);
      corp1.setSells([createTestOffer("o1", "sell", "energy", { corpId: "corp1" })]);

      const corp2 = new MockCorp("corp2", "upgrading", "node2", pos);
      corp2.setBuys([createTestOffer("o2", "buy", "energy", { corpId: "corp2" })]);

      collector.collectFromCorps([corp1, corp2]);

      expect(collector.getAllOffers()).to.have.length(2);
    });
  });

  describe("getCheapestSellOffers()", () => {
    it("should sort by effective price", () => {
      const buyerPos: Position = { x: 25, y: 25, roomName: "W1N1" };

      collector.addOffer(createTestOffer("expensive", "sell", "energy", {
        price: 100,
        location: buyerPos
      }));
      collector.addOffer(createTestOffer("cheap", "sell", "energy", {
        price: 50,
        location: buyerPos
      }));
      collector.addOffer(createTestOffer("medium", "sell", "energy", {
        price: 75,
        location: buyerPos
      }));

      const sorted = collector.getCheapestSellOffers("energy", buyerPos);
      expect(sorted[0].id).to.equal("cheap");
      expect(sorted[1].id).to.equal("medium");
      expect(sorted[2].id).to.equal("expensive");
    });
  });

  describe("getAvailableResources()", () => {
    it("should list all resource types with sell offers", () => {
      collector.addOffer(createTestOffer("o1", "sell", "energy"));
      collector.addOffer(createTestOffer("o2", "sell", "work-ticks"));
      collector.addOffer(createTestOffer("o3", "buy", "carry-ticks"));

      const available = collector.getAvailableResources();
      expect(available).to.include("energy");
      expect(available).to.include("work-ticks");
      expect(available).to.not.include("carry-ticks");
    });
  });

  describe("getRequestedResources()", () => {
    it("should list all resource types with buy offers", () => {
      collector.addOffer(createTestOffer("o1", "sell", "energy"));
      collector.addOffer(createTestOffer("o2", "buy", "work-ticks"));
      collector.addOffer(createTestOffer("o3", "buy", "carry-ticks"));

      const requested = collector.getRequestedResources();
      expect(requested).to.not.include("energy");
      expect(requested).to.include("work-ticks");
      expect(requested).to.include("carry-ticks");
    });
  });

  describe("getTotalSellQuantity()", () => {
    it("should sum sell quantities for resource", () => {
      collector.addOffer(createTestOffer("o1", "sell", "energy", { quantity: 100 }));
      collector.addOffer(createTestOffer("o2", "sell", "energy", { quantity: 200 }));

      expect(collector.getTotalSellQuantity("energy")).to.equal(300);
    });

    it("should return 0 for unknown resource", () => {
      expect(collector.getTotalSellQuantity("unknown")).to.equal(0);
    });
  });

  describe("getTotalBuyQuantity()", () => {
    it("should sum buy quantities for resource", () => {
      collector.addOffer(createTestOffer("o1", "buy", "energy", { quantity: 50 }));
      collector.addOffer(createTestOffer("o2", "buy", "energy", { quantity: 150 }));

      expect(collector.getTotalBuyQuantity("energy")).to.equal(200);
    });
  });

  describe("hasSellOffers()", () => {
    it("should return true when sell offers exist", () => {
      collector.addOffer(createTestOffer("o1", "sell", "energy"));
      expect(collector.hasSellOffers("energy")).to.be.true;
    });

    it("should return false when no sell offers", () => {
      collector.addOffer(createTestOffer("o1", "buy", "energy"));
      expect(collector.hasSellOffers("energy")).to.be.false;
    });
  });

  describe("hasBuyOffers()", () => {
    it("should return true when buy offers exist", () => {
      collector.addOffer(createTestOffer("o1", "buy", "energy"));
      expect(collector.hasBuyOffers("energy")).to.be.true;
    });

    it("should return false when no buy offers", () => {
      collector.addOffer(createTestOffer("o1", "sell", "energy"));
      expect(collector.hasBuyOffers("energy")).to.be.false;
    });
  });

  describe("getCorpOffers()", () => {
    it("should filter offers by corp ID", () => {
      collector.addOffer(createTestOffer("o1", "sell", "energy", { corpId: "corp1" }));
      collector.addOffer(createTestOffer("o2", "sell", "energy", { corpId: "corp2" }));
      collector.addOffer(createTestOffer("o3", "buy", "work-ticks", { corpId: "corp1" }));

      const corp1Offers = collector.getCorpOffers("corp1");
      expect(corp1Offers).to.have.length(2);
      expect(corp1Offers.every(o => o.corpId === "corp1")).to.be.true;
    });
  });

  describe("getStats()", () => {
    it("should return comprehensive statistics", () => {
      collector.addOffer(createTestOffer("o1", "sell", "energy", { quantity: 100 }));
      collector.addOffer(createTestOffer("o2", "sell", "energy", { quantity: 200 }));
      collector.addOffer(createTestOffer("o3", "buy", "energy", { quantity: 50 }));
      collector.addOffer(createTestOffer("o4", "sell", "work-ticks", { quantity: 500 }));

      const stats = collector.getStats();

      expect(stats.totalOffers).to.equal(4);
      expect(stats.sellOffers).to.equal(3);
      expect(stats.buyOffers).to.equal(1);
      expect(stats.resourceCount).to.equal(2);
      expect(stats.resources["energy"].sellCount).to.equal(2);
      expect(stats.resources["energy"].buyCount).to.equal(1);
      expect(stats.resources["energy"].sellQuantity).to.equal(300);
      expect(stats.resources["energy"].buyQuantity).to.equal(50);
    });
  });

  describe("clear()", () => {
    it("should remove all offers", () => {
      collector.addOffer(createTestOffer("o1", "sell", "energy"));
      collector.addOffer(createTestOffer("o2", "buy", "work-ticks"));

      collector.clear();

      expect(collector.getAllOffers()).to.have.length(0);
      expect(collector.getSellOffers("energy")).to.have.length(0);
      expect(collector.getBuyOffers("work-ticks")).to.have.length(0);
    });
  });
});
