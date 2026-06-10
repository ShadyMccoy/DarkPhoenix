import { expect } from "chai";
import "../../../src/types/Memory";
import { pickRuntToRecycle } from "../../../src/corps/recycle";
import { simulateMinerFleet } from "../harness/spawnHarness";
import { simulateHaulerFleet } from "../harness/haulerHarness";

/**
 * Which stuck runts actually get recycled?
 *
 * Runt recycling (HarvestCorp.flagMinerRuntForRecycling /
 * CarryCorp.flagRuntForRecycling) retires the smallest sub-max creep so its corp
 * respawns it full size - but only via pickRuntToRecycle, which fires *only when
 * the fleet's total useful parts are below what the plan needs*. That heals a
 * genuinely under-capacity fleet, but it leaves an OVER-SPLIT yet adequate fleet
 * alone: the cold-start splits the spawn harnesses build (a 2x2 miner, a [3,1]
 * hauler) already meet their total need, so they are never recycled. Combined
 * with the demand path (which also won't touch an at-target fleet, see the
 * miner-fleet harness), that means the cold-start over-split is *permanently
 * stuck* - it never heals, even after the room grows. These tests pin that.
 */
describe("runt recycling: which runts heal?", () => {
  it("recycles a genuinely UNDER-capacity fleet (heals)", () => {
    // One 2-WORK miner on a source that needs 5 WORK: total 2 < 5 -> recycle it,
    // and the corp respawns a full 5-WORK miner.
    expect(pickRuntToRecycle([2], 5, 5)).to.equal(0);
    // One 3-CARRY hauler on a route that needs 8 CARRY: total 3 < 8 -> recycle.
    expect(pickRuntToRecycle([3], 8, 8)).to.equal(0);
  });

  it("does NOT recycle the cold-start 2x2 miner split (stuck even once the room grows)", () => {
    const fleet = simulateMinerFleet({ energyCapacity: 300, harvestRate: 5, maxMiners: 2 });
    expect(fleet.workParts, fleet.shape).to.deep.equal([2, 2]); // the cold-start over-split

    const needWork = 3; // ceil(5 e/tick / 2): a 3-WORK miner saturates this remote source
    const maxWorkWarm = 3; // after the room fills its extensions it could build a 3-WORK miner
    // total (4) already >= need (3), so the fleet is left alone - the over-split
    // never heals even though one 3-WORK miner would free a mining spot and cost
    // less upkeep than two 2-WORK bodies.
    expect(pickRuntToRecycle(fleet.workParts, needWork, maxWorkWarm)).to.equal(null);
  });

  it("does NOT recycle the cold-start [3,1] hauler runt tail (stuck even once the room grows)", () => {
    const fleet = simulateHaulerFleet({ energyCapacity: 300, carryParts: 4 });
    expect(fleet.carryParts, fleet.shape).to.deep.equal([3, 1]); // the cold-start runt tail

    const needCarry = 4; // the route's total CARRY need
    const maxCarryWarm = 8; // a warmed-up room (800) could build an 8-CARRY hauler
    // total (4) already >= need (4): the 1-CARRY runt is never retired, so it
    // holds a fleet slot moving 50 energy per round trip for its whole life.
    expect(pickRuntToRecycle(fleet.carryParts, needCarry, maxCarryWarm)).to.equal(null);
  });
});
