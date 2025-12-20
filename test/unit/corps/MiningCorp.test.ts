import { expect } from "chai";
import {
  MiningModel,
  MINING_CONSTANTS,
  calculateExpectedOutput,
  calculateOptimalWorkParts,
  calculateMiningEfficiency
} from "../../../src/planning/models/MiningModel";
import { Position } from "../../../src/market/Offer";
import { createMiningState } from "../../../src/corps/CorpState";
import { projectMining } from "../../../src/planning/projections";
import {
  HARVEST_RATE,
  CREEP_LIFETIME,
  SOURCE_ENERGY_CAPACITY,
  calculateOptimalWorkParts as calcOptimalWorkParts
} from "../../../src/planning/EconomicConstants";

describe("MiningModel", () => {
  const defaultPosition: Position = { x: 10, y: 10, roomName: "W1N1" };
  const defaultSourceCapacity = 3000;

  describe("constructor", () => {
    it("should create a mining corp with correct properties", () => {
      const corp = new MiningModel(
        "node1",
        defaultPosition,
        defaultSourceCapacity
      );

      expect(corp.type).to.equal("mining");
      expect(corp.nodeId).to.equal("node1");
      expect(corp.sourceId).to.equal("source-node1");
      expect(corp.getPosition()).to.deep.equal(defaultPosition);
      expect(corp.getSourceCapacity()).to.equal(defaultSourceCapacity);
    });

    it("should use default source capacity if not specified", () => {
      const corp = new MiningModel("node1", defaultPosition);
      expect(corp.getSourceCapacity()).to.equal(MINING_CONSTANTS.SOURCE_CAPACITY);
    });
  });

  describe("calculateExpectedOutput()", () => {
    it("should calculate expected energy output", () => {
      const corp = new MiningModel(
        "node1",
        defaultPosition,
        defaultSourceCapacity
      );

      // Source rate: 3000/300 = 10 energy/tick
      // 5 WORK parts: 5×2 = 10 energy/tick (harvest power)
      // Over 1500 ticks: 10×1500 = 15000 energy
      const output = corp.calculateExpectedOutput(5);
      expect(output).to.equal(15000);
    });

    it("should cap at source rate", () => {
      const corp = new MiningModel(
        "node1",
        defaultPosition,
        defaultSourceCapacity
      );

      // 10 WORK parts: 10×2 = 20 energy/tick, but source only provides 10
      // Should cap at source rate: 10×1500 = 15000
      const output = corp.calculateExpectedOutput(10);
      expect(output).to.equal(15000);
    });
  });

  describe("calculateRequiredWorkTicks()", () => {
    it("should calculate work ticks needed for optimal harvesting", () => {
      const corp = new MiningModel("node1", defaultPosition);

      // 5 WORK parts × 1500 ticks = 7500 work-ticks
      const workTicks = corp.calculateRequiredWorkTicks();
      expect(workTicks).to.equal(7500);
    });
  });

  describe("buys()", () => {
    it("should return buy offer for work-ticks", () => {
      const corp = new MiningModel("node1", defaultPosition);

      const offers = corp.buys();
      expect(offers).to.have.length(1);

      const workOffer = offers[0];
      expect(workOffer.type).to.equal("buy");
      expect(workOffer.resource).to.equal("work-ticks");
      expect(workOffer.quantity).to.equal(7500);
      expect(workOffer.location).to.deep.equal(defaultPosition);
    });
  });

  describe("sells()", () => {
    it("should return sell offer for energy", () => {
      const corp = new MiningModel("node1", defaultPosition);

      const offers = corp.sells();
      expect(offers).to.have.length(1);

      const energyOffer = offers[0];
      expect(energyOffer.type).to.equal("sell");
      expect(energyOffer.resource).to.equal("energy");
      expect(energyOffer.quantity).to.equal(15000);
      expect(energyOffer.location).to.deep.equal(defaultPosition);
    });

    it("should apply margin to price when input cost is set", () => {
      const corp = new MiningModel("node1", defaultPosition);
      corp.setInputCost(100);

      const offers = corp.sells();
      // With 10% margin: 100 × 1.10 = 110
      expect(offers[0].price).to.be.closeTo(110, 0.01);
    });
  });

  describe("assignWorkParts()", () => {
    it("should set assigned work parts", () => {
      const corp = new MiningModel("node1", defaultPosition);

      corp.assignWorkParts(5);
      expect(corp.getAssignedWorkParts()).to.equal(5);
    });

    it("should not allow negative work parts", () => {
      const corp = new MiningModel("node1", defaultPosition);

      corp.assignWorkParts(-3);
      expect(corp.getAssignedWorkParts()).to.equal(0);
    });
  });

  describe("getCurrentHarvestRate()", () => {
    it("should return 0 when no work parts assigned", () => {
      const corp = new MiningModel("node1", defaultPosition);
      expect(corp.getCurrentHarvestRate()).to.equal(0);
    });

    it("should calculate rate based on work parts", () => {
      const corp = new MiningModel("node1", defaultPosition);
      corp.assignWorkParts(3);

      // 3 × 2 = 6 energy/tick
      expect(corp.getCurrentHarvestRate()).to.equal(6);
    });

    it("should cap at source rate", () => {
      const corp = new MiningModel("node1", defaultPosition);
      corp.assignWorkParts(10);

      // 10 × 2 = 20, but source only provides 10/tick
      expect(corp.getCurrentHarvestRate()).to.equal(10);
    });
  });

  describe("work()", () => {
    it("should update stats when work parts assigned", () => {
      const corp = new MiningModel("node1", defaultPosition);
      corp.assignWorkParts(5);

      corp.work(100);

      const stats = corp.getStats();
      expect(stats.harvestedThisTick).to.equal(10);
      expect(stats.totalHarvested).to.equal(10);
      expect(stats.activeTicks).to.equal(1);
    });

    it("should accumulate harvested over multiple ticks", () => {
      const corp = new MiningModel("node1", defaultPosition);
      corp.assignWorkParts(5);

      corp.work(100);
      corp.work(101);
      corp.work(102);

      const stats = corp.getStats();
      expect(stats.totalHarvested).to.equal(30);
      expect(stats.activeTicks).to.equal(3);
    });
  });

  describe("isOptimallyMined()", () => {
    it("should return false when under-assigned", () => {
      const corp = new MiningModel("node1", defaultPosition);
      corp.assignWorkParts(3);
      expect(corp.isOptimallyMined()).to.be.false;
    });

    it("should return true when optimally assigned", () => {
      const corp = new MiningModel("node1", defaultPosition);
      corp.assignWorkParts(5);
      expect(corp.isOptimallyMined()).to.be.true;
    });
  });

  describe("getEfficiency()", () => {
    it("should return 0 when no active ticks", () => {
      const corp = new MiningModel("node1", defaultPosition);
      expect(corp.getEfficiency()).to.equal(0);
    });

    it("should return 1 when harvesting at source rate", () => {
      const corp = new MiningModel("node1", defaultPosition);
      corp.assignWorkParts(5);
      corp.work(100);

      expect(corp.getEfficiency()).to.equal(1);
    });

    it("should return less than 1 when under-assigned", () => {
      const corp = new MiningModel("node1", defaultPosition);
      corp.assignWorkParts(2);
      corp.work(100);

      // 4/10 = 0.4 efficiency
      expect(corp.getEfficiency()).to.be.closeTo(0.4, 0.01);
    });
  });
});

describe("MiningCorp pure functions", () => {
  describe("calculateExpectedOutput()", () => {
    it("should calculate output correctly", () => {
      expect(calculateExpectedOutput(5, 3000, 1500)).to.equal(15000);
      expect(calculateExpectedOutput(3, 3000, 1500)).to.equal(9000);
    });

    it("should cap at source rate", () => {
      expect(calculateExpectedOutput(10, 3000, 1500)).to.equal(15000);
    });
  });

  describe("calculateOptimalWorkParts()", () => {
    it("should calculate optimal work parts", () => {
      // Source rate: 3000/300 = 10/tick
      // Need 5 WORK parts (2 harvest power each) to saturate
      expect(calculateOptimalWorkParts(3000)).to.equal(5);
    });
  });

  describe("calculateMiningEfficiency()", () => {
    it("should calculate efficiency correctly", () => {
      expect(calculateMiningEfficiency(10000, 1000, 3000)).to.equal(1);
      expect(calculateMiningEfficiency(5000, 1000, 3000)).to.be.closeTo(0.5, 0.01);
    });

    it("should return 0 for no active ticks", () => {
      expect(calculateMiningEfficiency(100, 0, 3000)).to.equal(0);
    });
  });
});

// =============================================================================
// Phase 2: CorpState + Projections Equivalence Tests
// =============================================================================
// These tests verify that the new CorpState + projectMining approach produces
// equivalent results to the old MiningModel class.

describe("CorpState + projectMining (new approach)", () => {
  const defaultPosition: Position = { x: 10, y: 10, roomName: "W1N1" };
  const defaultSourceCapacity = SOURCE_ENERGY_CAPACITY; // 3000

  describe("equivalence with MiningModel", () => {
    it("should produce same work-ticks quantity as MiningModel.buys()", () => {
      // Old approach
      const model = new MiningModel("node1", defaultPosition, defaultSourceCapacity);
      const modelBuys = model.buys();

      // New approach
      const state = createMiningState("mining-1", "node1", defaultPosition, defaultSourceCapacity);
      const { buys } = projectMining(state, 0);

      expect(buys[0].quantity).to.equal(modelBuys[0].quantity);
      expect(buys[0].resource).to.equal(modelBuys[0].resource);
    });

    it("should produce same energy quantity as MiningModel.sells()", () => {
      // Old approach
      const model = new MiningModel("node1", defaultPosition, defaultSourceCapacity);
      const modelSells = model.sells();

      // New approach
      const state = createMiningState("mining-1", "node1", defaultPosition, defaultSourceCapacity);
      const { sells } = projectMining(state, 0);

      expect(sells[0].quantity).to.equal(modelSells[0].quantity);
      expect(sells[0].resource).to.equal(modelSells[0].resource);
    });

    it("should use same optimal work parts calculation", () => {
      // MINING_CONSTANTS approach
      const oldOptimal = MINING_CONSTANTS.OPTIMAL_WORK_PARTS;

      // EconomicConstants approach
      const newOptimal = calcOptimalWorkParts(defaultSourceCapacity);

      expect(newOptimal).to.equal(oldOptimal);
    });

    it("should use same creep lifetime", () => {
      expect(CREEP_LIFETIME).to.equal(MINING_CONSTANTS.CREEP_LIFETIME);
    });

    it("should use same harvest rate", () => {
      expect(HARVEST_RATE).to.equal(MINING_CONSTANTS.HARVEST_POWER);
    });
  });

  describe("buys() projection", () => {
    it("should return buy offer for work-ticks", () => {
      const state = createMiningState("mining-1", "node1", defaultPosition, defaultSourceCapacity);
      const { buys } = projectMining(state, 0);

      expect(buys).to.have.length(1);
      expect(buys[0].type).to.equal("buy");
      expect(buys[0].resource).to.equal("work-ticks");
      expect(buys[0].quantity).to.equal(7500); // 5 work parts × 1500 ticks
      expect(buys[0].location).to.deep.equal(defaultPosition);
    });
  });

  describe("sells() projection", () => {
    it("should return sell offer for energy", () => {
      const state = createMiningState("mining-1", "node1", defaultPosition, defaultSourceCapacity);
      const { sells } = projectMining(state, 0);

      expect(sells).to.have.length(1);
      expect(sells[0].type).to.equal("sell");
      expect(sells[0].resource).to.equal("energy");
      expect(sells[0].quantity).to.equal(15000); // 5 work × 2 harvest × 1500 ticks
      expect(sells[0].location).to.deep.equal(defaultPosition);
    });

    it("should apply margin based on balance", () => {
      const poorState = createMiningState("mining-1", "node1", defaultPosition, defaultSourceCapacity);
      poorState.balance = 0;
      const { sells: poorSells } = projectMining(poorState, 0);

      const richState = createMiningState("mining-2", "node1", defaultPosition, defaultSourceCapacity);
      richState.balance = 10000;
      const { sells: richSells } = projectMining(richState, 0);

      // Rich corps have lower margin, thus lower price
      expect(richSells[0].price).to.be.lessThan(poorSells[0].price);
    });
  });

  describe("travel time effects", () => {
    it("should reduce output when spawn is far from source", () => {
      const spawnPos: Position = { x: 25, y: 25, roomName: "W1N1" };

      // Near source (same room, moderate distance)
      const nearState = createMiningState("mining-1", "node1", defaultPosition, defaultSourceCapacity, spawnPos);
      const { sells: nearSells } = projectMining(nearState, 0);

      // Remote source (different room)
      const remotePos: Position = { x: 25, y: 25, roomName: "W2N1" };
      const farState = createMiningState("mining-2", "node2", remotePos, defaultSourceCapacity, spawnPos);
      const { sells: farSells } = projectMining(farState, 0);

      // Remote mining should produce less energy due to travel time
      expect(farSells[0].quantity).to.be.lessThan(nearSells[0].quantity);
    });
  });
});
