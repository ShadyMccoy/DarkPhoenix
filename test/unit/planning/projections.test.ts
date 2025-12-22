/**
 * @fileoverview Tests for pure projection functions.
 *
 * Tests verify that CorpState + projection functions correctly compute
 * buy/sell offers for each corp type (mining, spawning, upgrading, hauling).
 */

import { expect } from "chai";
import {
  createMiningState,
  createSpawningState,
  createUpgradingState,
  createHaulingState,
  MiningCorpState,
  SpawningCorpState
} from "../../../src/corps/CorpState";
import {
  projectMining,
  projectSpawning,
  projectUpgrading,
  projectHauling,
  project,
  projectAll,
  collectBuys,
  collectSells,
  CorpProjection
} from "../../../src/planning/projections";
import {
  HARVEST_RATE,
  CREEP_LIFETIME,
  SOURCE_ENERGY_CAPACITY,
  BODY_PART_COST,
  calculateOptimalWorkParts,
  calculateEffectiveWorkTime
} from "../../../src/planning/EconomicConstants";
import { Position } from "../../../src/market/Offer";

describe("projections", () => {
  const spawnPos: Position = { x: 25, y: 25, roomName: "W1N1" };
  const sourcePos: Position = { x: 10, y: 10, roomName: "W1N1" };
  const controllerPos: Position = { x: 40, y: 40, roomName: "W1N1" };
  // Dependency IDs (for clean operation architecture)
  const sourceCorpId = "source-1";
  const spawningCorpId = "spawning-1";
  const miningCorpId = "mining-1";

  describe("projectMining", () => {
    it("should buy spawn-capacity for miners", () => {
      // Mining buys spawn-capacity to get miners continuously supplied
      const state = createMiningState("mining-1", "node-1", sourceCorpId, spawningCorpId, sourcePos, SOURCE_ENERGY_CAPACITY);
      const { buys } = projectMining(state, 0);

      expect(buys).to.have.length(1);
      expect(buys[0].resource).to.equal("spawn-capacity");
      expect(buys[0].type).to.equal("buy");
    });

    it("should produce sell offer for energy", () => {
      const state = createMiningState("mining-1", "node-1", sourceCorpId, spawningCorpId, sourcePos, SOURCE_ENERGY_CAPACITY);
      const { sells } = projectMining(state, 0);

      expect(sells).to.have.length(1);
      expect(sells[0].resource).to.equal("energy");
      expect(sells[0].type).to.equal("sell");
    });

    it("should calculate energy output based on optimal work parts", () => {
      const state = createMiningState("mining-1", "node-1", sourceCorpId, spawningCorpId, sourcePos, SOURCE_ENERGY_CAPACITY);
      const { sells } = projectMining(state, 0);

      const expectedWorkParts = calculateOptimalWorkParts(SOURCE_ENERGY_CAPACITY);
      // Without spawn position, uses full lifetime
      const expectedEnergy = expectedWorkParts * HARVEST_RATE * CREEP_LIFETIME;

      expect(sells[0].quantity).to.equal(expectedEnergy);
    });

    it("should reduce energy output when spawn position is far", () => {
      const nearState = createMiningState("mining-1", "node-1", sourceCorpId, spawningCorpId, sourcePos, SOURCE_ENERGY_CAPACITY, spawnPos);
      const { sells: nearSells } = projectMining(nearState, 0);

      // Remote source - longer travel time
      const remoteSource: Position = { x: 25, y: 25, roomName: "W2N1" };
      const farState = createMiningState("mining-2", "node-2", sourceCorpId, spawningCorpId, remoteSource, SOURCE_ENERGY_CAPACITY, spawnPos);
      const { sells: farSells } = projectMining(farState, 0);

      // Far source should have less output due to travel time
      expect(farSells[0].quantity).to.be.lessThan(nearSells[0].quantity);
    });

    it("should include location in sell offers", () => {
      const state = createMiningState("mining-1", "node-1", sourceCorpId, spawningCorpId, sourcePos, SOURCE_ENERGY_CAPACITY);
      const { sells } = projectMining(state, 0);

      expect(sells[0].location).to.deep.equal(sourcePos);
    });

    it("should set duration to creep lifetime", () => {
      // Mining is a leaf node - only check sells duration
      const state = createMiningState("mining-1", "node-1", sourceCorpId, spawningCorpId, sourcePos, SOURCE_ENERGY_CAPACITY);
      const { sells } = projectMining(state, 0);

      expect(sells[0].duration).to.equal(CREEP_LIFETIME);
    });
  });

  describe("projectSpawning", () => {
    it("should not produce buy offers (energy delivered by haulers)", () => {
      const state = createSpawningState("spawning-1", "node-1", spawnPos);
      const { buys } = projectSpawning(state, 0);

      expect(buys).to.have.length(0);
    });

    it("should produce sell offer for spawn-capacity", () => {
      const state = createSpawningState("spawning-1", "node-1", spawnPos);
      const { sells } = projectSpawning(state, 0);

      expect(sells).to.have.length(1);
      expect(sells[0].resource).to.equal("spawn-capacity");
      expect(sells[0].type).to.equal("sell");
    });

    it("should sell spawn-capacity equal to energy capacity", () => {
      const energyCapacity = 550;
      const state = createSpawningState("spawning-1", "node-1", spawnPos, energyCapacity);
      const { sells } = projectSpawning(state, 0);

      expect(sells[0].quantity).to.equal(energyCapacity);
    });

    it("should not offer capacity when spawning", () => {
      const state = createSpawningState("spawning-1", "node-1", spawnPos, 300, 0, true);
      const { sells } = projectSpawning(state, 0);

      expect(sells).to.have.length(0);
    });

    it("should not offer capacity when queue is full", () => {
      const state = createSpawningState("spawning-1", "node-1", spawnPos, 300, 10, false);
      const { sells } = projectSpawning(state, 0);

      expect(sells).to.have.length(0);
    });

    it("should have lower margin with higher balance", () => {
      const poorState = createSpawningState("spawning-1", "node-1", spawnPos);
      poorState.balance = 0;
      const { sells: poorSells } = projectSpawning(poorState, 0);

      const richState = createSpawningState("spawning-2", "node-1", spawnPos);
      richState.balance = 10000;
      const { sells: richSells } = projectSpawning(richState, 0);

      // Rich corp should have lower price (lower margin)
      expect(richSells[0].price).to.be.lessThan(poorSells[0].price);
    });
  });

  describe("projectUpgrading", () => {
    it("should buy both delivered-energy and spawn-capacity", () => {
      const state = createUpgradingState("upgrading-1", "node-1", spawningCorpId, controllerPos, 1);
      const { buys } = projectUpgrading(state, 0);

      expect(buys).to.have.length(2);
      const resources = buys.map(b => b.resource);
      expect(resources).to.include("delivered-energy");
      expect(resources).to.include("spawn-capacity");
    });

    it("should sell rcl-progress", () => {
      const state = createUpgradingState("upgrading-1", "node-1", spawningCorpId, controllerPos, 1);
      const { sells } = projectUpgrading(state, 0);

      expect(sells).to.have.length(1);
      expect(sells[0].resource).to.equal("rcl-progress");
    });

    it("should have zero price for rcl-progress (mints credits)", () => {
      const state = createUpgradingState("upgrading-1", "node-1", spawningCorpId, controllerPos, 1);
      const { sells } = projectUpgrading(state, 0);

      expect(sells[0].price).to.equal(0);
    });
  });

  describe("projectHauling", () => {
    const destPos: Position = { x: 25, y: 30, roomName: "W1N1" };

    it("should buy spawn-capacity", () => {
      const state = createHaulingState("hauling-1", "node-1", miningCorpId, spawningCorpId, sourcePos, destPos, 100);
      const { buys } = projectHauling(state, 0);

      expect(buys).to.have.length(1);
      expect(buys[0].resource).to.equal("spawn-capacity");
    });

    it("should sell delivered-energy", () => {
      const state = createHaulingState("hauling-1", "node-1", miningCorpId, spawningCorpId, sourcePos, destPos, 100);
      const { sells } = projectHauling(state, 0);

      expect(sells).to.have.length(1);
      expect(sells[0].resource).to.equal("delivered-energy");
    });

    it("should have source position for buy offer", () => {
      const state = createHaulingState("hauling-1", "node-1", miningCorpId, spawningCorpId, sourcePos, destPos, 100);
      const { buys } = projectHauling(state, 0);

      expect(buys[0].location).to.deep.equal(sourcePos);
    });

    it("should have destination position for sell offer", () => {
      const state = createHaulingState("hauling-1", "node-1", miningCorpId, spawningCorpId, sourcePos, destPos, 100);
      const { sells } = projectHauling(state, 0);

      expect(sells[0].location).to.deep.equal(destPos);
    });
  });

  describe("project (dispatcher)", () => {
    it("should dispatch to projectMining for mining state", () => {
      const state = createMiningState("mining-1", "node-1", sourceCorpId, spawningCorpId, sourcePos, SOURCE_ENERGY_CAPACITY);
      const projection = project(state, 0);

      expect(projection.sells[0].resource).to.equal("energy");
    });

    it("should dispatch to projectSpawning for spawning state", () => {
      const state = createSpawningState("spawning-1", "node-1", spawnPos);
      const projection = project(state, 0);

      expect(projection.sells[0].resource).to.equal("spawn-capacity");
    });

    it("should return empty projection for scout state", () => {
      const state = {
        id: "scout-1",
        type: "scout" as const,
        nodeId: "node-1",
        position: sourcePos,
        balance: 0,
        totalRevenue: 0,
        totalCost: 0,
        createdAt: 0,
        isActive: false,
        lastActivityTick: 0,
        unitsProduced: 0,
        expectedUnitsProduced: 0,
        unitsConsumed: 0,
        acquisitionCost: 0,
        committedWorkTicks: 0,
        committedEnergy: 0,
        committedDeliveredEnergy: 0,
        lastPlannedTick: 0
      };
      const projection = project(state, 0);

      expect(projection.buys).to.have.length(0);
      expect(projection.sells).to.have.length(0);
    });
  });

  describe("projectAll", () => {
    it("should project multiple states", () => {
      const states = [
        createMiningState("mining-1", "node-1", sourceCorpId, spawningCorpId, sourcePos, SOURCE_ENERGY_CAPACITY),
        createSpawningState("spawning-1", "node-1", spawnPos)
      ];

      const projections = projectAll(states, 0);

      expect(projections).to.have.length(2);
    });
  });

  describe("collectBuys/collectSells", () => {
    it("should collect all buy offers from projections", () => {
      const projections: CorpProjection[] = [
        { buys: [{ id: "1", corpId: "c1", type: "buy", resource: "energy", quantity: 100, price: 0, duration: 100 }], sells: [] },
        { buys: [{ id: "2", corpId: "c2", type: "buy", resource: "work-ticks", quantity: 200, price: 0, duration: 100 }], sells: [] }
      ];

      const buys = collectBuys(projections);

      expect(buys).to.have.length(2);
      expect(buys[0].id).to.equal("1");
      expect(buys[1].id).to.equal("2");
    });

    it("should collect all sell offers from projections", () => {
      const projections: CorpProjection[] = [
        { buys: [], sells: [{ id: "1", corpId: "c1", type: "sell", resource: "energy", quantity: 100, price: 10, duration: 100 }] },
        { buys: [], sells: [{ id: "2", corpId: "c2", type: "sell", resource: "work-ticks", quantity: 200, price: 20, duration: 100 }] }
      ];

      const sells = collectSells(projections);

      expect(sells).to.have.length(2);
    });

    it("should handle empty projections", () => {
      const projections: CorpProjection[] = [
        { buys: [], sells: [] },
        { buys: [], sells: [] }
      ];

      expect(collectBuys(projections)).to.have.length(0);
      expect(collectSells(projections)).to.have.length(0);
    });
  });

  describe("mining corp behavior", () => {
    it("should buy spawn-capacity and sell energy", () => {
      // Mining buys spawn-capacity to get miners, sells energy
      const state = createMiningState("mining-1", "node-1", sourceCorpId, spawningCorpId, sourcePos, SOURCE_ENERGY_CAPACITY);
      const { buys, sells } = projectMining(state, 0);

      // Mining buys spawn-capacity for creeps
      expect(buys).to.have.length(1);
      expect(buys[0].resource).to.equal("spawn-capacity");

      // And still produces energy based on optimal work parts
      const expectedWorkParts = calculateOptimalWorkParts(SOURCE_ENERGY_CAPACITY);
      const expectedEnergy = expectedWorkParts * HARVEST_RATE * CREEP_LIFETIME;
      expect(sells[0].quantity).to.equal(expectedEnergy);
    });

    it("should use EconomicConstants for calculations", () => {
      // Verify we're using the single source of truth
      expect(HARVEST_RATE).to.equal(2);
      expect(CREEP_LIFETIME).to.equal(1500);
      expect(SOURCE_ENERGY_CAPACITY).to.equal(3000);

      // Optimal work parts calculation
      const optimalWorkParts = calculateOptimalWorkParts(SOURCE_ENERGY_CAPACITY);
      expect(optimalWorkParts).to.equal(5); // ceil(3000/300/2) = ceil(5) = 5
    });
  });
});
