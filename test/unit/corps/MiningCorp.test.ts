import { expect } from "chai";
import { Position } from "../../../src/market/Offer";
import { createMiningState } from "../../../src/corps/CorpState";
import { projectMining } from "../../../src/planning/projections";
import {
  HARVEST_RATE,
  CREEP_LIFETIME,
  SOURCE_ENERGY_CAPACITY,
  calculateOptimalWorkParts,
  designMiningCreep,
  calculateBodyCost
} from "../../../src/planning/EconomicConstants";

describe("MiningCorp projections", () => {
  const defaultPosition: Position = { x: 10, y: 10, roomName: "W1N1" };
  const defaultSourceCapacity = SOURCE_ENERGY_CAPACITY; // 3000
  // Dependency IDs (for clean operation architecture)
  const sourceCorpId = "source-1";
  const spawningCorpId = "spawning-1";

  describe("projectMining", () => {
    it("should buy spawn-capacity for miners", () => {
      // MiningCorp needs creeps continuously supplied from SpawningCorp
      const state = createMiningState("mining-1", "node1", sourceCorpId, spawningCorpId, defaultPosition, defaultSourceCapacity);
      const { buys } = projectMining(state, 0);

      expect(buys).to.have.length(1);
      expect(buys[0].type).to.equal("buy");
      expect(buys[0].resource).to.equal("spawn-capacity");

      // Quantity = energy cost of miner body
      const workParts = calculateOptimalWorkParts(defaultSourceCapacity);
      const body = designMiningCreep(workParts);
      const expectedCost = calculateBodyCost(body);
      expect(buys[0].quantity).to.equal(expectedCost);
    });

    it("should return sell offer for energy", () => {
      const state = createMiningState("mining-1", "node1", sourceCorpId, spawningCorpId, defaultPosition, defaultSourceCapacity);
      const { sells } = projectMining(state, 0);

      expect(sells).to.have.length(1);
      expect(sells[0].type).to.equal("sell");
      expect(sells[0].resource).to.equal("energy");
      expect(sells[0].quantity).to.equal(15000); // 5 work × 2 harvest × 1500 ticks
      expect(sells[0].location).to.deep.equal(defaultPosition);
    });

    it("should calculate energy based on optimal work parts", () => {
      const state = createMiningState("mining-1", "node1", sourceCorpId, spawningCorpId, defaultPosition, defaultSourceCapacity);
      const { sells } = projectMining(state, 0);

      // Source rate: 3000/300 = 10 energy/tick
      // 5 WORK parts: 5×2 = 10 energy/tick (harvest power)
      // Over 1500 ticks: 10×1500 = 15000 energy
      const optimalWorkParts = calculateOptimalWorkParts(defaultSourceCapacity);
      const expectedOutput = optimalWorkParts * HARVEST_RATE * CREEP_LIFETIME;
      expect(sells[0].quantity).to.equal(expectedOutput);
    });

    it("should apply margin based on balance", () => {
      const poorState = createMiningState("mining-1", "node1", sourceCorpId, spawningCorpId, defaultPosition, defaultSourceCapacity);
      poorState.balance = 0;
      const { sells: poorSells } = projectMining(poorState, 0);

      const richState = createMiningState("mining-2", "node1", sourceCorpId, spawningCorpId, defaultPosition, defaultSourceCapacity);
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
      const nearState = createMiningState("mining-1", "node1", sourceCorpId, spawningCorpId, defaultPosition, defaultSourceCapacity, spawnPos);
      const { sells: nearSells } = projectMining(nearState, 0);

      // Remote source (different room)
      const remotePos: Position = { x: 25, y: 25, roomName: "W2N1" };
      const farState = createMiningState("mining-2", "node2", sourceCorpId, spawningCorpId, remotePos, defaultSourceCapacity, spawnPos);
      const { sells: farSells } = projectMining(farState, 0);

      // Remote mining should produce less energy due to travel time
      expect(farSells[0].quantity).to.be.lessThan(nearSells[0].quantity);
    });
  });

  describe("economic constants", () => {
    it("should use correct harvest rate", () => {
      expect(HARVEST_RATE).to.equal(2);
    });

    it("should use correct creep lifetime", () => {
      expect(CREEP_LIFETIME).to.equal(1500);
    });

    it("should calculate optimal work parts correctly", () => {
      // Source rate: 3000/300 = 10/tick
      // Need 5 WORK parts (2 harvest power each) to saturate
      expect(calculateOptimalWorkParts(3000)).to.equal(5);
    });
  });
});
