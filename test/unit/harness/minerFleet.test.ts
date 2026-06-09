import { expect } from "chai";
import "../../../src/types/Memory";
import { simulateMinerFleet, simulateColdThenWarm } from "./spawnHarness";

/**
 * Pins down what miner fleet the live spawn pipeline actually builds for a given
 * room + source, using the real HarvestCorp + scheduler + body builder. Written
 * to settle "why are remote mines 2 x 2 WORK?" - and to lock the answer in so a
 * future change that re-introduces the runt-split fails here loudly.
 *
 * Capacities: RCL2 pre-extensions = 300, RCL2 full = 550, RCL3 full = 800.
 * Remote (unowned) source = 5 e/tick; owned source = 10 e/tick.
 */
describe("miner fleet (spawn harness)", () => {
  it("RCL3 full extensions, remote source: ONE 3-WORK miner (NOT a 2x2 split)", () => {
    const fleet = simulateMinerFleet({ energyCapacity: 800, harvestRate: 5, maxMiners: 2 });
    expect(fleet.shape, fleet.shape).to.equal("1 x 3 WORK");
    expect(fleet.workParts).to.deep.equal([3]);
  });

  it("RCL2 full extensions, remote source: still ONE 3-WORK miner", () => {
    const fleet = simulateMinerFleet({ energyCapacity: 550, harvestRate: 5, maxMiners: 2 });
    expect(fleet.workParts).to.deep.equal([3]);
  });

  it("owned source at RCL3: ONE 5-WORK miner", () => {
    const fleet = simulateMinerFleet({ energyCapacity: 800, harvestRate: 10, maxMiners: 2 });
    expect(fleet.workParts).to.deep.equal([5]);
  });

  it("ONLY a ~300-energy spawn produces the 2x2 split (the cold-start window)", () => {
    // This is the one situation the demand logic splits a remote into runts:
    // at 300 capacity buildMinerBody caps at 2 WORK, so covering the source's
    // 3-WORK need takes two bodies. Above ~400 capacity it never splits.
    const fleet = simulateMinerFleet({ energyCapacity: 300, harvestRate: 5, maxMiners: 2 });
    expect(fleet.shape, fleet.shape).to.equal("2 x 2 WORK");
  });

  it("a full-capacity room never over-splits a remote, regardless of spots", () => {
    // Even with lots of mining spots, full capacity => 1 miner (count is sized
    // to the source's rate, not to the number of open tiles).
    const fleet = simulateMinerFleet({ energyCapacity: 800, harvestRate: 5, maxMiners: 6 });
    expect(fleet.workParts).to.deep.equal([3]);
  });

  describe("the cold-start 2x2 is frozen in once the room grows", () => {
    it("spawns 2x2 cold, then the demand path neither consolidates nor grows it", () => {
      // A remote claimed at the RCL2 transition (300) splits into 2x2. After the
      // home room fills its extensions (800) it could build one 3-WORK miner, but
      // the demand path now wants ZERO miners (current 2 >= target 1), so the
      // over-split fleet just persists. THIS is why the 2x2 survives at RCL3:
      // not the demand sizing at RCL3, but a cold-start split that never heals.
      const t = simulateColdThenWarm({ coldCapacity: 300, warmCapacity: 800, harvestRate: 5, maxMiners: 2 });
      expect(t.cold.shape, "cold fleet").to.equal("2 x 2 WORK");
      expect(t.newDemandWhenWarm, "no new/consolidating demand once warm").to.equal(0);
      expect(t.warm.shape, "still 2x2 after warming").to.equal("2 x 2 WORK");
    });
  });
});
