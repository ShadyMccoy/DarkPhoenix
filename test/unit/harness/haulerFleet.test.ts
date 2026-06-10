import { expect } from "chai";
import "../../../src/types/Memory";
import { simulateHaulerFleet } from "./haulerHarness";

/**
 * Pins down what hauler fleet the live spawn pipeline actually builds for a
 * source's carry route, using the real CarryCorp + scheduler +
 * SpawningCorp.buildBodyForRole. The sibling of minerFleet.test - same purpose:
 * make the emergent sizing legible, and lock current behavior in so a change
 * (the hauler-sizing work happening on another branch) shows up here as an
 * explicit, reviewable diff rather than a silent shift.
 *
 * Capacities: RCL2 pre-extensions = 300, RCL2 full = 550, RCL3 full = 800.
 * `carryParts` is the route's total CARRY need from the flow solution.
 */
describe("hauler fleet (spawn harness)", () => {
  it("full-capacity room, modest route: ONE right-sized hauler", () => {
    // 4 CARRY fits in a single body at 550+ (400 energy), so the route fields
    // exactly one hauler sized to it - no split.
    expect(simulateHaulerFleet({ energyCapacity: 550, carryParts: 4 }).carryParts).to.deep.equal([4]);
    expect(simulateHaulerFleet({ energyCapacity: 800, carryParts: 4 }).carryParts).to.deep.equal([4]);
  });

  it("a route beyond one body splits EVENLY across the haulers it needs", () => {
    // 12 CARRY at 800 capacity caps each body at 8 CARRY (1:1, 800/100), so it
    // takes two haulers - split evenly into 6 + 6 rather than a greedy 8 + 4.
    // Same hauler count and total CARRY, but balanced (and never a runt tail).
    const fleet = simulateHaulerFleet({ energyCapacity: 800, carryParts: 12 });
    expect(fleet.shape, fleet.shape).to.equal("2 x 6 CARRY");
    expect(fleet.carryParts).to.deep.equal([6, 6]);
  });

  it("a two-hauler route splits evenly (no runt)", () => {
    // 8 CARRY at 550 (max 5/body) needs two haulers: an even 4 + 4, not 5 + 3.
    expect(simulateHaulerFleet({ energyCapacity: 550, carryParts: 8 }).carryParts).to.deep.equal([4, 4]);
  });

  it("small routes are not inflated to the 3-CARRY floor", () => {
    // The floor is min(desiredCarry, 3): a route that only needs 1-2 CARRY gets
    // a 1-2 CARRY hauler, not a padded 3-CARRY one.
    expect(simulateHaulerFleet({ energyCapacity: 550, carryParts: 2 }).carryParts).to.deep.equal([2]);
    expect(simulateHaulerFleet({ energyCapacity: 800, carryParts: 1 }).carryParts).to.deep.equal([1]);
  });

  it("hauler ratio is plumbed through: 1:2 (swamp) trades CARRY for MOVE", () => {
    // A single right-sized hauler (5-CARRY route fits one body at 550), so the
    // ratio's effect on CARRY-per-body is visible directly rather than masked by an
    // even fleet split: the swamp body spends more of each unit on MOVE (and is
    // budget-capped), carrying fewer CARRY than 1:1, while the road body packs more.
    const plains = simulateHaulerFleet({ energyCapacity: 550, carryParts: 5, haulerRatio: "1:1" });
    const swamp = simulateHaulerFleet({ energyCapacity: 550, carryParts: 5, haulerRatio: "1:2" });
    const roads = simulateHaulerFleet({ energyCapacity: 550, carryParts: 5, haulerRatio: "2:1" });
    expect(swamp.carryParts[0], "swamp lead hauler carries less than plains").to.be.lessThan(plains.carryParts[0]);
    expect(roads.carryParts[0], "road lead hauler carries more than plains").to.be.greaterThan(plains.carryParts[0]);
  });

  describe("the cold-start runt tail is split away (hauler analog of the 2x2 miner split)", () => {
    it("a 300-energy spawn splits a 4-CARRY route EVENLY, with no 1-CARRY runt", () => {
      // At 300 capacity a body caps at 3 CARRY, so a 4-CARRY route takes two
      // haulers. A greedy "max each body" split would build 3 + 1 - and that
      // 1-CARRY tail moves only 50 energy a round trip yet holds a fleet slot for
      // its whole life. The even split fields the same two haulers as a balanced
      // 2 + 2 instead, so neither is a runt. (The miner harness still freezes the
      // analogous 2x2 miner wart; only hauler sizing is fixed here.)
      const fleet = simulateHaulerFleet({ energyCapacity: 300, carryParts: 4 });
      expect(fleet.shape, fleet.shape).to.equal("2 x 2 CARRY");
      expect(fleet.carryParts).to.deep.equal([2, 2]);
    });
  });
});
