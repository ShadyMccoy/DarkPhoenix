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

    describe("DEPOT-LESS one-wave floor (the plan-t5 refill tail, t=554)", () => {
      // Measured (grid plan-t5, three runs after the fuel fixes): a lone
      // 7-carry tender (350e) against a 400e extension wave loses the SLA by
      // the mid-sweep reload round-trip - loaded, 2 tiles from the LAST short
      // extension, 1-2 ticks late, every draw. Throughput rate-matching
      // covers the AVERAGE appetite but not the WAVE: with no depot the
      // reload leg is pile-dependent, so the fleet's combined carry must
      // cover one full extension wave. Scoped to depot-less rooms ONLY - a
      // storage-adjacent tender multi-trips legally (instant reload, long
      // high-RCL builds), which is the measured t72663189 over-provision the
      // rate-match fixed; the floor must not re-open it.
      const t5 = {
        spawnCount: 1,
        extensionCapacity: 50,
        maxCarry: 7,
        walkTicks: 1,
        clusters: 1,
        extensionCapacityTotal: 400,
        hasDepot: false
      };

      it("fields a SECOND tender when one body cannot cover the extension wave (plan-t5 shape)", () => {
        expect(tenderFleetTarget(t5)).to.equal(2);
      });

      it("a depot silences the floor - reload is instant there (the t72663189 pin's world)", () => {
        expect(tenderFleetTarget({ ...t5, hasDepot: true })).to.equal(1);
      });

      it("a body that covers the wave alone needs no second tender", () => {
        expect(tenderFleetTarget({ ...t5, maxCarry: 8 })).to.equal(1); // 400/400 - exactly one wave
      });

      it("the RCL7 storage room is untouched (hasDepot: the over-provision fix holds)", () => {
        expect(
          tenderFleetTarget({
            spawnCount: 1,
            extensionCapacity: 100,
            maxCarry: 25,
            walkTicks: 5,
            clusters: 1,
            extensionCapacityTotal: 6000,
            hasDepot: true
          })
        ).to.equal(1);
      });

      it("the fleet cap still binds over the wave floor", () => {
        expect(tenderFleetTarget({ ...t5, maxCarry: 1, extensionCapacityTotal: 1000 })).to.be.at.most(3);
      });
    });

    describe("OUTPOST rotation partners (fid-t4-preramped t=164)", () => {
      // A cluster 16 tiles from the reload point: its courier's away window
      // (~2x the leg) exceeds the ~18-27-tick refill deadlines, so a drain
      // landing mid-reload structurally loses. Each outpost cluster adds ONE
      // partner - parked loaded while the courier reloads.
      const twoClusters = { spawnCount: 1, extensionCapacity: 50, maxCarry: 8, walkTicks: 2, clusters: 2 };

      it("an outpost cluster fields a rotation partner (2 clusters + 1 outpost -> 3)", () => {
        expect(tenderFleetTarget({ ...twoClusters, outpostClusters: 1 })).to.equal(3);
      });

      it("near clusters stay single-covered (no outposts -> the cluster floor alone)", () => {
        expect(tenderFleetTarget({ ...twoClusters, outpostClusters: 0 })).to.equal(2);
      });

      it("the fleet cap binds over outpost partners too", () => {
        expect(tenderFleetTarget({ ...twoClusters, clusters: 3, outpostClusters: 3 })).to.equal(3);
      });
    });
  });
});

describe("tender runt floor (the post-second-spawn runt spiral, t72672921)", () => {
  // MEASURED: the second spawn doubled demand, the network drained to
  // energyAvailable 25, and the tender was bought at its minCost of 200 - a
  // 2-CARRY/4-part runt. 100 energy per trip cannot refill a 5600 network, so
  // BOTH spawns sat energy-starved 25% of the window (idle.bank 146/152) while
  // storage ballooned to 250k. A drained network then buys the NEXT tender as a
  // runt too: a self-sustaining spiral, and exactly the class the MINER runt
  // floor exists to prevent ("the whole economy collapses to one-useful-part
  // creeps"). Half a tender still moves real energy; a 2-carry one does not.
  const { tenderMinCarry } = require("../../../src/corps/ExtensionTenderCorp");

  it("floors a normal purchase at HALF the needed carry, not 2", () => {
    expect(tenderMinCarry(25, false)).to.equal(13); // ceil(25/2)
    expect(tenderMinCarry(25, false)).to.be.greaterThan(2);
  });

  it("keeps the 2-carry BOOTSTRAP escape (a dark post must restart cheaply)", () => {
    // The dark-post emergency (incident t72499165) still buys instantly - a
    // hard floor there would deadlock the very outage it must fix.
    expect(tenderMinCarry(25, true)).to.equal(2);
  });

  it("never asks for more than the desired body", () => {
    expect(tenderMinCarry(1, false)).to.equal(1);
    expect(tenderMinCarry(3, false)).to.equal(2); // ceil(3/2)
  });

  it("scales down with a poor room, so a cold room can still afford its floor", () => {
    // At RCL2 the desired carry is small, so half of it stays affordable -
    // the floor never outruns what the room can build.
    expect(tenderMinCarry(4, false)).to.equal(2);
  });
});
