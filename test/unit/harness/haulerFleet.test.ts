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

  it("a route beyond one body splits across haulers sized to the remaining need", () => {
    // 12 CARRY at 800 capacity caps each body at 8 CARRY (1:1, 800/100), so it
    // takes one 8-CARRY hauler plus a 4-CARRY hauler for the remainder.
    const fleet = simulateHaulerFleet({ energyCapacity: 800, carryParts: 12 });
    expect(fleet.shape, fleet.shape).to.equal("8 CARRY + 4 CARRY");
    expect(fleet.carryParts).to.deep.equal([8, 4]);
  });

  it("a clean split sizes both haulers usefully (no runt)", () => {
    // 8 CARRY at 550 (max 5/body) splits 5 + 3 - both >= the 3-CARRY floor.
    expect(simulateHaulerFleet({ energyCapacity: 550, carryParts: 8 }).carryParts).to.deep.equal([5, 3]);
  });

  it("small routes are not inflated to the 3-CARRY floor", () => {
    // The floor is min(desiredCarry, 3): a route that only needs 1-2 CARRY gets
    // a 1-2 CARRY hauler, not a padded 3-CARRY one.
    expect(simulateHaulerFleet({ energyCapacity: 550, carryParts: 2 }).carryParts).to.deep.equal([2]);
    expect(simulateHaulerFleet({ energyCapacity: 800, carryParts: 1 }).carryParts).to.deep.equal([1]);
  });

  it("hauler ratio is plumbed through: 1:2 (swamp) trades CARRY for MOVE", () => {
    // Same route + budget, different ratio: the swamp body spends more of each
    // 100 energy on MOVE, so it carries fewer CARRY parts per hauler than 1:1.
    const plains = simulateHaulerFleet({ energyCapacity: 550, carryParts: 8, haulerRatio: "1:1" });
    const swamp = simulateHaulerFleet({ energyCapacity: 550, carryParts: 8, haulerRatio: "1:2" });
    const roads = simulateHaulerFleet({ energyCapacity: 550, carryParts: 8, haulerRatio: "2:1" });
    expect(swamp.carryParts[0], "swamp lead hauler carries less than plains").to.be.lessThan(plains.carryParts[0]);
    expect(roads.carryParts[0], "road lead hauler carries more than plains").to.be.greaterThan(plains.carryParts[0]);
  });

  describe("the cold-start runt tail (hauler analog of the 2x2 miner split)", () => {
    it("a 300-energy spawn leaves a 1-CARRY runt on the tail hauler", () => {
      // At 300 capacity a body caps at 3 CARRY, so a 4-CARRY route takes two
      // haulers - and the tail covers just the 1 remaining CARRY. The 3-CARRY
      // floor only floors a hauler at min(desiredCarry, 3), so when the REMAINDER
      // is 1 the tail is a 1-CARRY runt: it moves 50 energy a round trip yet
      // holds a fleet slot for its whole life. This is the hauler counterpart of
      // the miner 2x2 cold-start split (see miner-fleet harness); freezing it
      // here makes the fix (on the hauler-sizing branch) a visible diff.
      const fleet = simulateHaulerFleet({ energyCapacity: 300, carryParts: 4 });
      expect(fleet.shape, fleet.shape).to.equal("3 CARRY + 1 CARRY");
      expect(fleet.carryParts).to.deep.equal([3, 1]);
    });
  });
});
