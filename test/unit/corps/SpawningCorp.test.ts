import { expect } from "chai";
import {
  SpawningModel,
  CreepBody,
  SPAWN_CONSTANTS,
  calculateBodyEnergyCost,
  calculateWorkTicks,
  calculateCarryTicks,
  calculateSpawnTime
} from "../../../src/planning/models/SpawningModel";
import { Position } from "../../../src/market/Offer";
import { createSpawningState } from "../../../src/corps/CorpState";
import { projectSpawning } from "../../../src/planning/projections";
import {
  CREEP_LIFETIME,
  BODY_PART_COST
} from "../../../src/planning/EconomicConstants";

describe("SpawningModel", () => {
  const defaultPosition: Position = { x: 25, y: 25, roomName: "W1N1" };
  const defaultBody: CreepBody = { work: 2, carry: 2, move: 2 };

  describe("constructor", () => {
    it("should create a spawning corp with correct properties", () => {
      const corp = new SpawningModel("node1", defaultPosition);

      expect(corp.type).to.equal("spawning");
      expect(corp.nodeId).to.equal("node1");
      expect(corp.spawnId).to.equal("spawn-node1");
      expect(corp.getPosition()).to.deep.equal(defaultPosition);
    });
  });

  describe("calculateBodyEnergyCost()", () => {
    it("should calculate energy cost correctly", () => {
      const corp = new SpawningModel("node1", defaultPosition);

      // 2 WORK (100 each) + 2 CARRY (50 each) + 2 MOVE (50 each) = 400
      const cost = corp.calculateBodyEnergyCost(defaultBody);
      expect(cost).to.equal(400);
    });

    it("should handle different body configurations", () => {
      const corp = new SpawningModel("node1", defaultPosition);

      const bigBody: CreepBody = { work: 5, carry: 5, move: 5 };
      // 5×100 + 5×50 + 5×50 = 1000
      expect(corp.calculateBodyEnergyCost(bigBody)).to.equal(1000);
    });
  });

  describe("calculateSpawnTime()", () => {
    it("should calculate spawn time correctly", () => {
      const corp = new SpawningModel("node1", defaultPosition);

      // 6 parts × 3 ticks each = 18 ticks
      expect(corp.calculateSpawnTime(defaultBody)).to.equal(18);
    });
  });

  describe("calculateWorkTicks()", () => {
    it("should calculate work ticks over lifetime", () => {
      const corp = new SpawningModel("node1", defaultPosition);

      // 2 WORK × 1500 ticks = 3000 work-ticks
      expect(corp.calculateWorkTicks(defaultBody)).to.equal(3000);
    });
  });

  describe("calculateCarryTicks()", () => {
    it("should calculate carry ticks over lifetime", () => {
      const corp = new SpawningModel("node1", defaultPosition);

      // 2 CARRY × 1500 ticks = 3000 carry-ticks
      expect(corp.calculateCarryTicks(defaultBody)).to.equal(3000);
    });
  });

  describe("buys()", () => {
    it("should return buy offer for energy", () => {
      const corp = new SpawningModel("node1", defaultPosition);
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
      const corp = new SpawningModel("node1", defaultPosition);
      corp.setStandardBody(defaultBody);

      const offers = corp.sells();
      expect(offers).to.have.length(3);

      const resources = offers.map((o) => o.resource);
      expect(resources).to.include("work-ticks");
      expect(resources).to.include("carry-ticks");
      expect(resources).to.include("move-ticks");
    });

    it("should have correct quantities in sell offers", () => {
      const corp = new SpawningModel("node1", defaultPosition);
      corp.setStandardBody(defaultBody);

      const offers = corp.sells();
      const workOffer = offers.find((o) => o.resource === "work-ticks")!;
      const carryOffer = offers.find((o) => o.resource === "carry-ticks")!;

      expect(workOffer.quantity).to.equal(3000);
      expect(carryOffer.quantity).to.equal(3000);
    });

    it("should apply margin to prices", () => {
      const corp = new SpawningModel("node1", defaultPosition);
      corp.setStandardBody(defaultBody);

      const offers = corp.sells();
      for (const offer of offers) {
        expect(offer.price).to.be.greaterThan(0);
      }
    });
  });

  describe("addSpawnRequest()", () => {
    it("should add a request to the spawn queue", () => {
      const corp = new SpawningModel("node1", defaultPosition);

      corp.addSpawnRequest("buyer1", defaultBody, 500);
      const queue = corp.getSpawnQueue();

      expect(queue).to.have.length(1);
      expect(queue[0].buyerCorpId).to.equal("buyer1");
      expect(queue[0].agreedPrice).to.equal(500);
    });
  });

  describe("work()", () => {
    it("should update lastActivityTick", () => {
      const corp = new SpawningModel("node1", defaultPosition);
      corp.work(1000);

      expect(corp.lastActivityTick).to.equal(1000);
    });

    it("should process completed spawn requests", () => {
      const corp = new SpawningModel("node1", defaultPosition);

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
      const corp = new SpawningModel("node1", defaultPosition);
      expect(corp.isSpawning()).to.be.false;
    });

    it("should return true when queue has requests", () => {
      const corp = new SpawningModel("node1", defaultPosition);
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

// =============================================================================
// Phase 3: CorpState + Projections Equivalence Tests
// =============================================================================
// These tests verify that the new CorpState + projectSpawning approach
// produces consistent results with the old SpawningModel class.

describe("CorpState + projectSpawning (new approach)", () => {
  const defaultPosition: Position = { x: 25, y: 25, roomName: "W1N1" };

  describe("constants equivalence", () => {
    it("should use same creep lifetime", () => {
      expect(CREEP_LIFETIME).to.equal(SPAWN_CONSTANTS.CREEP_LIFETIME);
    });

    it("should use same body part costs", () => {
      expect(BODY_PART_COST.work).to.equal(SPAWN_CONSTANTS.WORK_COST);
      expect(BODY_PART_COST.carry).to.equal(SPAWN_CONSTANTS.CARRY_COST);
      expect(BODY_PART_COST.move).to.equal(SPAWN_CONSTANTS.MOVE_COST);
    });
  });

  describe("buys() projection", () => {
    it("should return buy offer for energy", () => {
      const state = createSpawningState("spawning-1", "node1", defaultPosition);
      const { buys } = projectSpawning(state, 0);

      expect(buys).to.have.length(1);
      expect(buys[0].type).to.equal("buy");
      expect(buys[0].resource).to.equal("energy");
      expect(buys[0].location).to.deep.equal(defaultPosition);
    });

    it("should buy energy equal to worker body cost", () => {
      const state = createSpawningState("spawning-1", "node1", defaultPosition);
      const { buys } = projectSpawning(state, 0);

      // Standard worker: WORK + CARRY + MOVE = 100 + 50 + 50 = 200
      const workerCost = BODY_PART_COST.work + BODY_PART_COST.carry + BODY_PART_COST.move;
      expect(buys[0].quantity).to.equal(workerCost);
    });
  });

  describe("sells() projection", () => {
    it("should return sell offer for work-ticks", () => {
      const state = createSpawningState("spawning-1", "node1", defaultPosition);
      const { sells } = projectSpawning(state, 0);

      expect(sells).to.have.length(1);
      expect(sells[0].type).to.equal("sell");
      expect(sells[0].resource).to.equal("work-ticks");
      expect(sells[0].location).to.deep.equal(defaultPosition);
    });

    it("should sell work-ticks for full creep lifetime", () => {
      const state = createSpawningState("spawning-1", "node1", defaultPosition);
      const { sells } = projectSpawning(state, 0);

      // 1 WORK part × 1500 ticks = 1500 work-ticks
      expect(sells[0].quantity).to.equal(CREEP_LIFETIME);
    });

    it("should apply margin based on balance", () => {
      const poorState = createSpawningState("spawning-1", "node1", defaultPosition);
      poorState.balance = 0;
      const { sells: poorSells } = projectSpawning(poorState, 0);

      const richState = createSpawningState("spawning-2", "node1", defaultPosition);
      richState.balance = 10000;
      const { sells: richSells } = projectSpawning(richState, 0);

      // Rich corps have lower margin, thus lower price
      expect(richSells[0].price).to.be.lessThan(poorSells[0].price);
    });
  });

  describe("model comparison notes", () => {
    it("should document differences between SpawningModel and projectSpawning", () => {
      // SpawningModel differences:
      // 1. SpawningModel sells work-ticks, carry-ticks, AND move-ticks (3 offers)
      // 2. SpawningModel uses configurable body (standardBody)
      // 3. SpawningModel includes SPAWN_TIME_COST in pricing
      //
      // projectSpawning simplifications:
      // 1. Only sells work-ticks (simplified for mining chain focus)
      // 2. Uses fixed worker body (1 WORK + 1 CARRY + 1 MOVE)
      // 3. Simpler pricing model
      //
      // This is intentional - projectSpawning is designed for chain planning
      // where the primary need is work-ticks for mining/upgrading.

      const state = createSpawningState("spawning-1", "node1", defaultPosition);
      const { sells } = projectSpawning(state, 0);

      // New approach only sells work-ticks
      expect(sells.map((s) => s.resource)).to.deep.equal(["work-ticks"]);

      // Old approach sells 3 types (with default body)
      const model = new SpawningModel("node1", defaultPosition);
      model.setStandardBody({ work: 1, carry: 1, move: 1 });
      const modelSells = model.sells();
      expect(modelSells.map((s) => s.resource)).to.include.members([
        "work-ticks",
        "carry-ticks",
        "move-ticks"
      ]);
    });
  });
});
