import { expect } from "chai";
import { Position } from "../../../src/market/Offer";
import { createSpawningState } from "../../../src/corps/CorpState";
import { projectSpawning } from "../../../src/planning/projections";
import {
  CREEP_LIFETIME,
  BODY_PART_COST
} from "../../../src/planning/EconomicConstants";

describe("SpawningCorp projections", () => {
  const defaultPosition: Position = { x: 25, y: 25, roomName: "W1N1" };
  const defaultEnergyCapacity = 300;

  describe("projectSpawning", () => {
    it("should buy delivered-energy for extensions refill", () => {
      // SpawningCorp buys delivered-energy to compete for hauler services
      // This models spawn/extensions needing to be filled
      const state = createSpawningState("spawning-1", "node1", defaultPosition, defaultEnergyCapacity);
      const { buys } = projectSpawning(state, 0);

      expect(buys).to.have.length(1);
      expect(buys[0].type).to.equal("buy");
      expect(buys[0].resource).to.equal("delivered-energy");
      expect(buys[0].quantity).to.equal(defaultEnergyCapacity);
    });

    it("should return sell offer for spawn-capacity", () => {
      const state = createSpawningState("spawning-1", "node1", defaultPosition, defaultEnergyCapacity);
      const { sells } = projectSpawning(state, 0);

      expect(sells).to.have.length(1);
      expect(sells[0].type).to.equal("sell");
      expect(sells[0].resource).to.equal("spawn-capacity");
      expect(sells[0].location).to.deep.equal(defaultPosition);
    });

    it("should sell spawn-capacity equal to energy capacity", () => {
      const state = createSpawningState("spawning-1", "node1", defaultPosition, defaultEnergyCapacity);
      const { sells } = projectSpawning(state, 0);

      // Spawn capacity = how much energy worth of creep can be spawned
      expect(sells[0].quantity).to.equal(defaultEnergyCapacity);
    });

    it("should not offer capacity when spawn is busy", () => {
      const state = createSpawningState("spawning-1", "node1", defaultPosition, defaultEnergyCapacity, 0, true);
      const { sells } = projectSpawning(state, 0);

      expect(sells).to.have.length(0);
    });

    it("should not offer capacity when queue is full", () => {
      const state = createSpawningState("spawning-1", "node1", defaultPosition, defaultEnergyCapacity, 10, false);
      const { sells } = projectSpawning(state, 0);

      expect(sells).to.have.length(0);
    });

    it("should apply margin based on balance", () => {
      const poorState = createSpawningState("spawning-1", "node1", defaultPosition, defaultEnergyCapacity);
      poorState.balance = 0;
      const { sells: poorSells } = projectSpawning(poorState, 0);

      const richState = createSpawningState("spawning-2", "node1", defaultPosition, defaultEnergyCapacity);
      richState.balance = 10000;
      const { sells: richSells } = projectSpawning(richState, 0);

      // Rich corps have lower margin, thus lower price
      expect(richSells[0].price).to.be.lessThan(poorSells[0].price);
    });
  });

  describe("economic constants", () => {
    it("should use correct creep lifetime", () => {
      expect(CREEP_LIFETIME).to.equal(1500);
    });

    it("should use correct body part costs", () => {
      expect(BODY_PART_COST.work).to.equal(100);
      expect(BODY_PART_COST.carry).to.equal(50);
      expect(BODY_PART_COST.move).to.equal(50);
    });
  });
});
