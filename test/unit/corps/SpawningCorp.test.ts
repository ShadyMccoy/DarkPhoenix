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

  describe("projectSpawning", () => {
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

    it("should return sell offer for work-ticks", () => {
      const state = createSpawningState("spawning-1", "node1", defaultPosition);
      const { sells } = projectSpawning(state, 0);

      // SpawningCorp sells both work-ticks and haul-demand
      expect(sells).to.have.length(2);
      const workTicksOffer = sells.find(s => s.resource === "work-ticks");
      expect(workTicksOffer).to.exist;
      expect(workTicksOffer!.type).to.equal("sell");
      expect(workTicksOffer!.resource).to.equal("work-ticks");
      expect(workTicksOffer!.location).to.deep.equal(defaultPosition);
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
