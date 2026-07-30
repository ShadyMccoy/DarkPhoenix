import { expect } from "chai";
import {
  spawnConsumptionCeiling,
  tenderDeliveryRate,
  tenderFleetTarget
} from "../../../src/corps/ExtensionTenderCorp";
import { BODY_COSTS, SPAWN_TIME_PER_PART } from "../../../src/economy/primitives";

/**
 * TENDER RATE-MATCHING (owner 2026-07-29: "it should be based on the extension
 * grid, but also, limited on the spawn capacity. don't need to tender faster
 * than we can spawn after all. And the fatter extensions help with the refill
 * because of a single tick a single tender can transfer more energy").
 *
 * The v1 sizing solved the WRONG problem: `forCoverage = bankCapacity /
 * (maxCarry*50)` asked "how many tenders refill the whole network in ONE
 * trip", which grows with the bank and ignores what the spawn can actually
 * burn. Measured live t72663189: the spawn consumed **27.6 e/t** (77750e over
 * 2817t across 69 spawns) at 0.936 utilization - a hard ceiling near 29.5 e/t
 * - while the fleet carried 3 creeps / 75 carry / 102 parts (~20% of the
 * colony's whole 0.333 p/t spawn ceiling) and stamped duty **0.066**.
 * Over-provisioned ~4x against the only consumer it serves.
 *
 * Two physical facts drive the correct model:
 *  - a spawn converts energy at SPAWN_PARTS_PER_TICK, so its energy appetite is
 *    bounded by (energy per part)/SPAWN_TIME_PER_PART per spawn;
 *  - a tender unloads ONE transfer per tick, each capped by the target
 *    extension's capacity - so FATTER extensions (100 at RCL7 vs 50 below)
 *    halve the unload ticks and RAISE throughput per tender, meaning fewer
 *    tenders, not more. The v1 formula had this backwards.
 */
describe("tender rate-matching (spawn appetite, not bank size)", () => {
  describe("spawnConsumptionCeiling", () => {
    it("bounds appetite by parts/tick x energy-per-part, per spawn", () => {
      expect(spawnConsumptionCeiling(1)).to.be.closeTo(BODY_COSTS.WORK / SPAWN_TIME_PER_PART, 1e-9);
    });

    it("scales with spawn count (a 2nd spawn doubles the appetite)", () => {
      expect(spawnConsumptionCeiling(2)).to.be.closeTo(2 * spawnConsumptionCeiling(1), 1e-9);
    });

    it("brackets the MEASURED live burn (27.6 e/t at 0.936 utilization, one spawn)", () => {
      // The bound must not sit BELOW what a single spawn was observed to eat,
      // or the fleet would be sized under the real requirement.
      expect(spawnConsumptionCeiling(1)).to.be.at.least(27.6);
      expect(spawnConsumptionCeiling(1)).to.be.at.most(60); // and not absurdly above it
    });
  });

  describe("tenderDeliveryRate - fatter extensions raise throughput", () => {
    it("RISES when extension capacity doubles (the owner's point: more per tick)", () => {
      const thin = tenderDeliveryRate(25, 50, 5);
      const fat = tenderDeliveryRate(25, 100, 5);
      expect(fat).to.be.greaterThan(thin);
    });

    it("a maxed tender at RCL7 (100-cap) covers a single spawn's whole appetite", () => {
      expect(tenderDeliveryRate(25, 100, 5)).to.be.greaterThan(spawnConsumptionCeiling(1));
    });

    it("falls as the walk lengthens (cycle overhead is real)", () => {
      expect(tenderDeliveryRate(25, 100, 15)).to.be.lessThan(tenderDeliveryRate(25, 100, 2));
    });

    it("is positive for a 1-carry runt (no divide-by-zero, no negative rate)", () => {
      expect(tenderDeliveryRate(1, 100, 5)).to.be.greaterThan(0);
    });
  });

  describe("tenderFleetTarget", () => {
    const rcl7 = { spawnCount: 1, extensionCapacity: 100, maxCarry: 25, walkTicks: 5, clusters: 1 };

    it("fields ONE tender at RCL7 with one spawn - the measured over-provision is gone", () => {
      // 3 tenders / 102 parts served a 27.6 e/t consumer. One maxed tender at
      // 100-cap extensions delivers more than the spawn can eat.
      expect(tenderFleetTarget(rcl7)).to.equal(1);
    });

    it("adds a tender when a SECOND spawn doubles the appetite", () => {
      expect(tenderFleetTarget({ ...rcl7, spawnCount: 2 })).to.be.greaterThan(tenderFleetTarget(rcl7));
    });

    it("needs MORE tenders on thin (50-cap) extensions than fat ones", () => {
      const thin = tenderFleetTarget({ ...rcl7, extensionCapacity: 50, maxCarry: 8, spawnCount: 2 });
      const fat = tenderFleetTarget({ ...rcl7, extensionCapacity: 100, maxCarry: 8, spawnCount: 2 });
      expect(thin).to.be.at.least(fat);
    });

    it("never drops below CLUSTER COVERAGE - separated groups each need a server", () => {
      // Rate alone would say 1; three scattered clusters cannot be served by one
      // creep within their drain deadlines (the legacy-layout rationale).
      expect(tenderFleetTarget({ ...rcl7, clusters: 3 })).to.equal(3);
    });

    it("keeps the fleet cap (never an unbounded swarm)", () => {
      expect(tenderFleetTarget({ ...rcl7, spawnCount: 9, clusters: 9 })).to.be.at.most(3);
    });

    it("a cold room with a tiny body still fields at least one tender", () => {
      expect(tenderFleetTarget({ spawnCount: 1, extensionCapacity: 50, maxCarry: 1, walkTicks: 8, clusters: 1 })).to.be.at.least(1);
    });
  });
});
