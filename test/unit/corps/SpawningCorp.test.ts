import { expect } from "chai";
import {
  SpawningCorp,
  CreepBody,
  SPAWN_CONSTANTS,
  calculateBodyEnergyCost,
  calculateWorkTicks,
  calculateCarryTicks,
  calculateSpawnTime
} from "../../../src/corps/SpawningCorp";
import { Position } from "../../../src/market/Offer";

describe("SpawningCorp", () => {
  const defaultPosition: Position = { x: 25, y: 25, roomName: "W1N1" };
  const defaultBody: CreepBody = { work: 2, carry: 2, move: 2 };

  describe("constructor", () => {
    it("should create a spawning corp with correct properties", () => {
      const corp = new SpawningCorp("node1", defaultPosition);

      expect(corp.type).to.equal("spawning");
      expect(corp.nodeId).to.equal("node1");
      expect(corp.spawnId).to.equal("spawn-node1");
      expect(corp.getPosition()).to.deep.equal(defaultPosition);
    });
  });

  describe("calculateBodyEnergyCost()", () => {
    it("should calculate energy cost correctly", () => {
      const corp = new SpawningCorp("node1", defaultPosition);

      // 2 WORK (100 each) + 2 CARRY (50 each) + 2 MOVE (50 each) = 400
      const cost = corp.calculateBodyEnergyCost(defaultBody);
      expect(cost).to.equal(400);
    });

    it("should handle different body configurations", () => {
      const corp = new SpawningCorp("node1", defaultPosition);

      const bigBody: CreepBody = { work: 5, carry: 5, move: 5 };
      // 5×100 + 5×50 + 5×50 = 1000
      expect(corp.calculateBodyEnergyCost(bigBody)).to.equal(1000);
    });
  });

  describe("calculateSpawnTime()", () => {
    it("should calculate spawn time correctly", () => {
      const corp = new SpawningCorp("node1", defaultPosition);

      // 6 parts × 3 ticks each = 18 ticks
      expect(corp.calculateSpawnTime(defaultBody)).to.equal(18);
    });
  });

  describe("calculateWorkTicks()", () => {
    it("should calculate work ticks over lifetime", () => {
      const corp = new SpawningCorp("node1", defaultPosition);

      // 2 WORK × 1500 ticks = 3000 work-ticks
      expect(corp.calculateWorkTicks(defaultBody)).to.equal(3000);
    });
  });

  describe("calculateCarryTicks()", () => {
    it("should calculate carry ticks over lifetime", () => {
      const corp = new SpawningCorp("node1", defaultPosition);

      // 2 CARRY × 1500 ticks = 3000 carry-ticks
      expect(corp.calculateCarryTicks(defaultBody)).to.equal(3000);
    });
  });

  describe("buys()", () => {
    it("should return buy offer for energy", () => {
      const corp = new SpawningCorp("node1", defaultPosition);
      corp.setStandardBody(defaultBody);

      const offers = corp.buys();
      expect(offers).to.have.length(1);

      const energyOffer = offers[0];
      expect(energyOffer.type).to.equal("buy");
      expect(energyOffer.resource).to.equal("energy");
      expect(energyOffer.quantity).to.equal(400); // Body energy cost
      expect(energyOffer.location).to.deep.equal(defaultPosition);
    });
  });

  describe("sells()", () => {
    it("should return sell offers for work-ticks, carry-ticks, move-ticks", () => {
      const corp = new SpawningCorp("node1", defaultPosition);
      corp.setStandardBody(defaultBody);

      const offers = corp.sells();
      expect(offers).to.have.length(3);

      const resources = offers.map((o) => o.resource);
      expect(resources).to.include("work-ticks");
      expect(resources).to.include("carry-ticks");
      expect(resources).to.include("move-ticks");
    });

    it("should have correct quantities in sell offers", () => {
      const corp = new SpawningCorp("node1", defaultPosition);
      corp.setStandardBody(defaultBody);

      const offers = corp.sells();
      const workOffer = offers.find((o) => o.resource === "work-ticks")!;
      const carryOffer = offers.find((o) => o.resource === "carry-ticks")!;

      expect(workOffer.quantity).to.equal(3000);
      expect(carryOffer.quantity).to.equal(3000);
    });

    it("should apply margin to prices", () => {
      const corp = new SpawningCorp("node1", defaultPosition);
      corp.setStandardBody(defaultBody);

      const offers = corp.sells();
      for (const offer of offers) {
        expect(offer.price).to.be.greaterThan(0);
      }
    });
  });

  describe("addSpawnRequest()", () => {
    it("should add a request to the spawn queue", () => {
      const corp = new SpawningCorp("node1", defaultPosition);

      corp.addSpawnRequest("buyer1", defaultBody, 500);
      const queue = corp.getSpawnQueue();

      expect(queue).to.have.length(1);
      expect(queue[0].buyerCorpId).to.equal("buyer1");
      expect(queue[0].agreedPrice).to.equal(500);
    });
  });

  describe("work()", () => {
    it("should update lastActivityTick", () => {
      const corp = new SpawningCorp("node1", defaultPosition);
      corp.work(1000);

      expect(corp.lastActivityTick).to.equal(1000);
    });

    it("should process completed spawn requests", () => {
      const corp = new SpawningCorp("node1", defaultPosition);

      // Add a request at tick 0
      corp.work(0);
      corp.addSpawnRequest("buyer1", defaultBody, 500);

      // Spawn takes 18 ticks for 6-part body
      // Run work at tick 20 (after spawn completes)
      corp.work(20);

      expect(corp.getSpawnQueue()).to.have.length(0);
      expect(corp.balance).to.equal(500); // Revenue recorded
    });
  });

  describe("isSpawning()", () => {
    it("should return false when queue is empty", () => {
      const corp = new SpawningCorp("node1", defaultPosition);
      expect(corp.isSpawning()).to.be.false;
    });

    it("should return true when queue has requests", () => {
      const corp = new SpawningCorp("node1", defaultPosition);
      corp.addSpawnRequest("buyer1", defaultBody, 500);
      expect(corp.isSpawning()).to.be.true;
    });
  });
});

describe("SpawningCorp pure functions", () => {
  describe("calculateBodyEnergyCost()", () => {
    it("should calculate correctly", () => {
      expect(calculateBodyEnergyCost({ work: 1, carry: 1, move: 1 })).to.equal(200);
      expect(calculateBodyEnergyCost({ work: 5, carry: 0, move: 0 })).to.equal(500);
      expect(calculateBodyEnergyCost({ work: 0, carry: 10, move: 10 })).to.equal(1000);
    });
  });

  describe("calculateWorkTicks()", () => {
    it("should calculate correctly", () => {
      expect(calculateWorkTicks({ work: 1, carry: 0, move: 0 })).to.equal(1500);
      expect(calculateWorkTicks({ work: 5, carry: 0, move: 0 })).to.equal(7500);
    });
  });

  describe("calculateCarryTicks()", () => {
    it("should calculate correctly", () => {
      expect(calculateCarryTicks({ work: 0, carry: 1, move: 0 })).to.equal(1500);
      expect(calculateCarryTicks({ work: 0, carry: 10, move: 0 })).to.equal(15000);
    });
  });

  describe("calculateSpawnTime()", () => {
    it("should calculate correctly", () => {
      expect(calculateSpawnTime({ work: 1, carry: 1, move: 1 })).to.equal(9);
      expect(calculateSpawnTime({ work: 5, carry: 5, move: 5 })).to.equal(45);
    });
  });
});
