/**
 * @fileoverview Tests for pure projection functions.
 *
 * These tests verify that CorpState + projection functions produce
 * the same results as the old Model classes, validating the refactoring.
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

  describe("projectMining", () => {
    it("should be a leaf node with no buy offers", () => {
      // Mining is a leaf node in the supply chain - it produces energy
      // from sources without supply chain dependencies
      const state = createMiningState("mining-1", "node-1", sourcePos, SOURCE_ENERGY_CAPACITY);
      const { buys } = projectMining(state, 0);

      expect(buys).to.have.length(0);
    });

    it("should produce sell offer for energy", () => {
      const state = createMiningState("mining-1", "node-1", sourcePos, SOURCE_ENERGY_CAPACITY);
      const { sells } = projectMining(state, 0);

      expect(sells).to.have.length(1);
      expect(sells[0].resource).to.equal("energy");
      expect(sells[0].type).to.equal("sell");
    });

    it("should calculate energy output based on optimal work parts", () => {
      const state = createMiningState("mining-1", "node-1", sourcePos, SOURCE_ENERGY_CAPACITY);
      const { sells } = projectMining(state, 0);

      const expectedWorkParts = calculateOptimalWorkParts(SOURCE_ENERGY_CAPACITY);
      // Without spawn position, uses full lifetime
      const expectedEnergy = expectedWorkParts * HARVEST_RATE * CREEP_LIFETIME;

      expect(sells[0].quantity).to.equal(expectedEnergy);
    });

    it("should reduce energy output when spawn position is far", () => {
      const nearState = createMiningState("mining-1", "node-1", sourcePos, SOURCE_ENERGY_CAPACITY, spawnPos);
      const { sells: nearSells } = projectMining(nearState, 0);

      // Remote source - longer travel time
      const remoteSource: Position = { x: 25, y: 25, roomName: "W2N1" };
      const farState = createMiningState("mining-2", "node-2", remoteSource, SOURCE_ENERGY_CAPACITY, spawnPos);
      const { sells: farSells } = projectMining(farState, 0);

      // Far source should have less output due to travel time
      expect(farSells[0].quantity).to.be.lessThan(nearSells[0].quantity);
    });

    it("should include location in sell offers", () => {
      const state = createMiningState("mining-1", "node-1", sourcePos, SOURCE_ENERGY_CAPACITY);
      const { sells } = projectMining(state, 0);

      expect(sells[0].location).to.deep.equal(sourcePos);
    });

    it("should set duration to creep lifetime", () => {
      // Mining is a leaf node - only check sells duration
      const state = createMiningState("mining-1", "node-1", sourcePos, SOURCE_ENERGY_CAPACITY);
      const { sells } = projectMining(state, 0);

      expect(sells[0].duration).to.equal(CREEP_LIFETIME);
    });
  });

  describe("projectSpawning", () => {
    it("should produce buy offer for energy", () => {
      const state = createSpawningState("spawning-1", "node-1", spawnPos);
      const { buys } = projectSpawning(state, 0);

      expect(buys).to.have.length(1);
      expect(buys[0].resource).to.equal("energy");
      expect(buys[0].type).to.equal("buy");
    });

    it("should produce sell offer for work-ticks", () => {
      const state = createSpawningState("spawning-1", "node-1", spawnPos);
      const { sells } = projectSpawning(state, 0);

      expect(sells).to.have.length(1);
      expect(sells[0].resource).to.equal("work-ticks");
      expect(sells[0].type).to.equal("sell");
    });

    it("should sell work-ticks for creep lifetime", () => {
      const state = createSpawningState("spawning-1", "node-1", spawnPos);
      const { sells } = projectSpawning(state, 0);

      expect(sells[0].quantity).to.equal(CREEP_LIFETIME);
    });

    it("should buy energy equal to worker body cost", () => {
      const state = createSpawningState("spawning-1", "node-1", spawnPos);
      const { buys } = projectSpawning(state, 0);

      const workerCost = BODY_PART_COST.work + BODY_PART_COST.carry + BODY_PART_COST.move;
      expect(buys[0].quantity).to.equal(workerCost);
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
    it("should buy both energy and work-ticks", () => {
      const state = createUpgradingState("upgrading-1", "node-1", controllerPos, 1);
      const { buys } = projectUpgrading(state, 0);

      expect(buys).to.have.length(2);
      const resources = buys.map(b => b.resource);
      expect(resources).to.include("energy");
      expect(resources).to.include("work-ticks");
    });

    it("should sell rcl-progress", () => {
      const state = createUpgradingState("upgrading-1", "node-1", controllerPos, 1);
      const { sells } = projectUpgrading(state, 0);

      expect(sells).to.have.length(1);
      expect(sells[0].resource).to.equal("rcl-progress");
    });

    it("should have zero price for rcl-progress (mints credits)", () => {
      const state = createUpgradingState("upgrading-1", "node-1", controllerPos, 1);
      const { sells } = projectUpgrading(state, 0);

      expect(sells[0].price).to.equal(0);
    });
  });

  describe("projectHauling", () => {
    const destPos: Position = { x: 25, y: 30, roomName: "W1N1" };

    it("should buy carry-ticks", () => {
      const state = createHaulingState("hauling-1", "node-1", sourcePos, destPos, 100);
      const { buys } = projectHauling(state, 0);

      expect(buys).to.have.length(1);
      expect(buys[0].resource).to.equal("carry-ticks");
    });

    it("should sell transport service", () => {
      const state = createHaulingState("hauling-1", "node-1", sourcePos, destPos, 100);
      const { sells } = projectHauling(state, 0);

      expect(sells).to.have.length(1);
      expect(sells[0].resource).to.equal("transport");
    });

    it("should have source position for buy offer", () => {
      const state = createHaulingState("hauling-1", "node-1", sourcePos, destPos, 100);
      const { buys } = projectHauling(state, 0);

      expect(buys[0].location).to.deep.equal(sourcePos);
    });

    it("should have destination position for sell offer", () => {
      const state = createHaulingState("hauling-1", "node-1", sourcePos, destPos, 100);
      const { sells } = projectHauling(state, 0);

      expect(sells[0].location).to.deep.equal(destPos);
    });
  });

  describe("project (dispatcher)", () => {
    it("should dispatch to projectMining for mining state", () => {
      const state = createMiningState("mining-1", "node-1", sourcePos, SOURCE_ENERGY_CAPACITY);
      const projection = project(state, 0);

      expect(projection.sells[0].resource).to.equal("energy");
    });

    it("should dispatch to projectSpawning for spawning state", () => {
      const state = createSpawningState("spawning-1", "node-1", spawnPos);
      const projection = project(state, 0);

      expect(projection.sells[0].resource).to.equal("work-ticks");
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
        lastActivityTick: 0
      };
      const projection = project(state, 0);

      expect(projection.buys).to.have.length(0);
      expect(projection.sells).to.have.length(0);
    });
  });

  describe("projectAll", () => {
    it("should project multiple states", () => {
      const states = [
        createMiningState("mining-1", "node-1", sourcePos, SOURCE_ENERGY_CAPACITY),
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

  describe("comparison with MiningModel", () => {
    it("should differ from MiningModel: projectMining is a leaf node (no buys)", () => {
      // MiningModel buys work-ticks (work-ticks = OPTIMAL_WORK_PARTS × CREEP_LIFETIME)
      // But projectMining is a LEAF NODE - it produces energy without supply chain dependencies
      // Work-ticks dependency is handled via labor allocation, not supply chain
      const state = createMiningState("mining-1", "node-1", sourcePos, SOURCE_ENERGY_CAPACITY);
      const { buys, sells } = projectMining(state, 0);

      // Mining is a leaf node - no buy offers
      expect(buys).to.have.length(0);

      // But still produces energy based on optimal work parts
      const expectedWorkParts = calculateOptimalWorkParts(SOURCE_ENERGY_CAPACITY);
      const expectedEnergy = expectedWorkParts * HARVEST_RATE * CREEP_LIFETIME;
      expect(sells[0].quantity).to.equal(expectedEnergy);
    });

    it("should use EconomicConstants instead of duplicated MINING_CONSTANTS", () => {
      // Verify we're using the single source of truth
      expect(HARVEST_RATE).to.equal(2);
      expect(CREEP_LIFETIME).to.equal(1500);
      expect(SOURCE_ENERGY_CAPACITY).to.equal(3000);

      // These should match the old MINING_CONSTANTS values
      const optimalWorkParts = calculateOptimalWorkParts(SOURCE_ENERGY_CAPACITY);
      expect(optimalWorkParts).to.equal(5); // ceil(3000/300/2) = ceil(5) = 5
    });
  });
});
