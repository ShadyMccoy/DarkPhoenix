import { expect } from "chai";
import { Position } from "../../../src/market/Offer";
import { createUpgradingState } from "../../../src/corps/CorpState";
import { projectUpgrading } from "../../../src/planning/projections";
import { CREEP_LIFETIME } from "../../../src/planning/EconomicConstants";

describe("UpgradingCorp projections", () => {
  const controllerPosition: Position = { x: 25, y: 25, roomName: "W1N1" };

  describe("projectUpgrading", () => {
    it("should return buy offers for energy and work-ticks", () => {
      const state = createUpgradingState("upgrading-1", "node1", controllerPosition, 1);
      const { buys } = projectUpgrading(state, 0);

      expect(buys).to.have.length(2);
      const resources = buys.map((o) => o.resource);
      expect(resources).to.include("energy");
      expect(resources).to.include("work-ticks");
    });

    it("should locate offers at controller", () => {
      const state = createUpgradingState("upgrading-1", "node1", controllerPosition, 1);
      const { buys } = projectUpgrading(state, 0);

      for (const offer of buys) {
        expect(offer.location).to.deep.equal(controllerPosition);
      }
    });

    it("should return sell offer for rcl-progress", () => {
      const state = createUpgradingState("upgrading-1", "node1", controllerPosition, 1);
      const { sells } = projectUpgrading(state, 0);

      expect(sells).to.have.length(1);
      expect(sells[0].type).to.equal("sell");
      expect(sells[0].resource).to.equal("rcl-progress");
      expect(sells[0].location).to.deep.equal(controllerPosition);
    });

    it("should have zero price for rcl-progress (mints credits)", () => {
      const state = createUpgradingState("upgrading-1", "node1", controllerPosition, 1);
      const { sells } = projectUpgrading(state, 0);

      // RCL progress is the terminal value sink - it mints credits
      expect(sells[0].price).to.equal(0);
    });
  });

  describe("travel time effects", () => {
    it("should reduce output when spawn is far from controller", () => {
      const spawnPos: Position = { x: 10, y: 10, roomName: "W1N1" };

      // Near controller (same room)
      const nearState = createUpgradingState("upgrading-1", "node1", controllerPosition, 1, spawnPos);
      const { sells: nearSells } = projectUpgrading(nearState, 0);

      // Remote controller (different room)
      const remoteControllerPos: Position = { x: 25, y: 25, roomName: "W2N1" };
      const farState = createUpgradingState("upgrading-2", "node2", remoteControllerPos, 1, spawnPos);
      const { sells: farSells } = projectUpgrading(farState, 0);

      // Remote upgrading should produce less RCL progress due to travel time
      expect(farSells[0].quantity).to.be.lessThan(nearSells[0].quantity);
    });
  });

  describe("economic constants", () => {
    it("should use correct creep lifetime", () => {
      expect(CREEP_LIFETIME).to.equal(1500);
    });
  });
});
