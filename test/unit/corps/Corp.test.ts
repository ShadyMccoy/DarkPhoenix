import { expect } from "chai";
import {
  Corp,
  CorpType,
  calculateMargin,
  calculatePrice,
  calculateROI
} from "../../../src/corps/Corp";
import { Offer, Position } from "../../../src/market/Offer";

/**
 * Concrete Corp implementation for testing
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

describe("Corp", () => {
  describe("getMargin()", () => {
    it("should return 10% when balance is 0", () => {
      const corp = new TestCorp("mining", "node1");
      expect(corp.getMargin()).to.equal(0.1);
    });

    it("should return 5% when balance is at threshold", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = 10000;
      expect(corp.getMargin()).to.equal(0.05);
    });

    it("should return 7.5% at half threshold", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = 5000;
      expect(corp.getMargin()).to.be.closeTo(0.075, 0.0001);
    });

    it("should cap at 5% for very high balance", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = 50000;
      expect(corp.getMargin()).to.equal(0.05);
    });
  });

  describe("getPrice()", () => {
    it("should apply margin to input cost", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = 0; // 10% margin
      expect(corp.getPrice(100)).to.be.closeTo(110, 0.001);
    });

    it("should apply lower margin for wealthy corp", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = 10000; // 5% margin
      expect(corp.getPrice(100)).to.be.closeTo(105, 0.001);
    });

    it("should return 0 for non-positive input cost", () => {
      const corp = new TestCorp("mining", "node1");
      expect(corp.getPrice(0)).to.equal(0);
      expect(corp.getPrice(-100)).to.equal(0);
    });
  });

  describe("recordRevenue()", () => {
    it("should increase balance", () => {
      const corp = new TestCorp("mining", "node1");
      corp.recordRevenue(500);
      expect(corp.balance).to.equal(500);
    });

    it("should track total revenue", () => {
      const corp = new TestCorp("mining", "node1");
      corp.recordRevenue(500);
      corp.recordRevenue(300);
      expect(corp.totalRevenue).to.equal(800);
    });

    it("should ignore non-positive amounts", () => {
      const corp = new TestCorp("mining", "node1");
      corp.recordRevenue(0);
      corp.recordRevenue(-100);
      expect(corp.balance).to.equal(0);
      expect(corp.totalRevenue).to.equal(0);
    });
  });

  describe("recordCost()", () => {
    it("should decrease balance", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = 1000;
      corp.recordCost(300);
      expect(corp.balance).to.equal(700);
    });

    it("should track total cost", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = 1000;
      corp.recordCost(200);
      corp.recordCost(100);
      expect(corp.totalCost).to.equal(300);
    });

    it("should allow negative balance", () => {
      const corp = new TestCorp("mining", "node1");
      corp.recordCost(500);
      expect(corp.balance).to.equal(-500);
    });

    it("should ignore non-positive amounts", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = 100;
      corp.recordCost(0);
      corp.recordCost(-50);
      expect(corp.balance).to.equal(100);
    });
  });

  describe("getActualROI()", () => {
    it("should calculate ROI correctly", () => {
      const corp = new TestCorp("mining", "node1");
      corp.totalRevenue = 150;
      corp.totalCost = 100;
      expect(corp.getActualROI()).to.equal(0.5); // (150-100)/100
    });

    it("should return 0 when no costs", () => {
      const corp = new TestCorp("mining", "node1");
      corp.totalRevenue = 100;
      corp.totalCost = 0;
      expect(corp.getActualROI()).to.equal(0);
    });

    it("should return negative for losing corp", () => {
      const corp = new TestCorp("mining", "node1");
      corp.totalRevenue = 50;
      corp.totalCost = 100;
      expect(corp.getActualROI()).to.equal(-0.5);
    });
  });

  describe("getProfit()", () => {
    it("should calculate profit correctly", () => {
      const corp = new TestCorp("mining", "node1");
      corp.totalRevenue = 500;
      corp.totalCost = 300;
      expect(corp.getProfit()).to.equal(200);
    });

    it("should return negative for loss", () => {
      const corp = new TestCorp("mining", "node1");
      corp.totalRevenue = 100;
      corp.totalCost = 300;
      expect(corp.getProfit()).to.equal(-200);
    });
  });

  describe("isBankrupt()", () => {
    it("should return false for positive balance", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = 100;
      expect(corp.isBankrupt()).to.be.false;
    });

    it("should return false for small negative balance", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = -50;
      expect(corp.isBankrupt()).to.be.false;
    });

    it("should return true for large negative balance", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = -150;
      expect(corp.isBankrupt()).to.be.true;
    });
  });

  describe("isDormant()", () => {
    it("should return false for recently active corp", () => {
      const corp = new TestCorp("mining", "node1");
      corp.lastActivityTick = 1000;
      expect(corp.isDormant(1500)).to.be.false;
    });

    it("should return true for inactive corp", () => {
      const corp = new TestCorp("mining", "node1");
      corp.lastActivityTick = 1000;
      expect(corp.isDormant(3000)).to.be.true;
    });

    it("should return false for new corp without activity", () => {
      const corp = new TestCorp("mining", "node1");
      expect(corp.isDormant(1000)).to.be.false;
    });
  });

  describe("shouldPrune()", () => {
    it("should return true if bankrupt", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = -200;
      expect(corp.shouldPrune(100)).to.be.true;
    });

    it("should return true if dormant", () => {
      const corp = new TestCorp("mining", "node1");
      corp.lastActivityTick = 100;
      expect(corp.shouldPrune(2000)).to.be.true;
    });

    it("should return false for healthy corp", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = 500;
      corp.lastActivityTick = 900;
      expect(corp.shouldPrune(1000)).to.be.false;
    });
  });

  describe("applyTax()", () => {
    it("should reduce balance by percentage", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = 1000;
      const taxed = corp.applyTax(0.1);
      expect(taxed).to.equal(100);
      expect(corp.balance).to.equal(900);
    });

    it("should return 0 for zero balance", () => {
      const corp = new TestCorp("mining", "node1");
      const taxed = corp.applyTax(0.1);
      expect(taxed).to.equal(0);
    });

    it("should return 0 for negative balance", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = -100;
      const taxed = corp.applyTax(0.1);
      expect(taxed).to.equal(0);
    });
  });

  describe("activate/deactivate", () => {
    it("should set isActive and lastActivityTick", () => {
      const corp = new TestCorp("mining", "node1");
      corp.activate(1000);
      expect(corp.isActive).to.be.true;
      expect(corp.lastActivityTick).to.equal(1000);
    });

    it("should clear isActive on deactivate", () => {
      const corp = new TestCorp("mining", "node1");
      corp.activate(1000);
      corp.deactivate();
      expect(corp.isActive).to.be.false;
    });
  });

  describe("serialize/deserialize", () => {
    it("should serialize and restore state", () => {
      const corp = new TestCorp("mining", "node1");
      corp.balance = 500;
      corp.totalRevenue = 1000;
      corp.totalCost = 500;
      corp.createdAt = 100;
      corp.isActive = true;
      corp.lastActivityTick = 900;

      const data = corp.serialize();
      const newCorp = new TestCorp("mining", "node1");
      newCorp.deserialize(data);

      expect(newCorp.balance).to.equal(500);
      expect(newCorp.totalRevenue).to.equal(1000);
      expect(newCorp.totalCost).to.equal(500);
      expect(newCorp.createdAt).to.equal(100);
      expect(newCorp.isActive).to.be.true;
      expect(newCorp.lastActivityTick).to.equal(900);
    });
  });
});

describe("Corp pure functions", () => {
  describe("calculateMargin()", () => {
    it("should calculate margin with defaults", () => {
      expect(calculateMargin(0)).to.be.closeTo(0.1, 0.0001);
      expect(calculateMargin(5000)).to.be.closeTo(0.075, 0.0001);
      expect(calculateMargin(10000)).to.be.closeTo(0.05, 0.0001);
    });

    it("should use custom parameters", () => {
      expect(calculateMargin(500, 0.2, 0.1, 1000)).to.be.closeTo(0.15, 0.0001);
    });
  });

  describe("calculatePrice()", () => {
    it("should apply margin correctly", () => {
      expect(calculatePrice(100, 0.1)).to.be.closeTo(110, 0.001);
      expect(calculatePrice(100, 0.05)).to.be.closeTo(105, 0.001);
    });

    it("should return 0 for non-positive input", () => {
      expect(calculatePrice(0, 0.1)).to.equal(0);
      expect(calculatePrice(-100, 0.1)).to.equal(0);
    });
  });

  describe("calculateROI()", () => {
    it("should calculate ROI correctly", () => {
      expect(calculateROI(150, 100)).to.equal(0.5);
      expect(calculateROI(50, 100)).to.equal(-0.5);
    });

    it("should return 0 for zero cost", () => {
      expect(calculateROI(100, 0)).to.equal(0);
    });
  });
});
