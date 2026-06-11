import { expect } from "chai";
import "../../../src/types/Memory";
import { simulateUpgraderFleet } from "./upgraderHarness";

/**
 * Pins what upgrader fleet the live spawn pipeline staffs for a controller's
 * energy allocation, using the real UpgradingCorp + scheduler +
 * SpawningCorp.buildBodyForRole. The third sibling of the miner- and hauler-fleet
 * harnesses. It locks in the two subtle, recently-added behaviors that are easy
 * to regress: the #59 supply-before-demand gate (no flow upgrader until a hauler
 * is delivering) and the #62 scale-down of upgrading while a source is dedicated
 * to an active build.
 *
 * Capacities: RCL2 full = 550, RCL3 full = 800. `allocated` is the controller
 * energy/tick the plan routed to upgrading (1 e/tick consumed per WORK part).
 */
describe("upgrader fleet (spawn harness)", () => {
  it("staffs total WORK equal to the controller's allocation", () => {
    // The fleet exists to consume the allocation: 1 WORK per e/tick allocated.
    expect(simulateUpgraderFleet({ energyCapacity: 550, allocated: 2 }).totalWork).to.equal(2);
    expect(simulateUpgraderFleet({ energyCapacity: 550, allocated: 10 }).totalWork).to.equal(10);
    expect(simulateUpgraderFleet({ energyCapacity: 800, allocated: 20 }).totalWork).to.equal(20);
  });

  it("fields fewer, bigger upgraders as capacity rises (same allocation)", () => {
    // A bigger room builds bigger bodies, so the same 10 e/tick allocation is
    // covered by fewer upgraders - 5 x 2 WORK at 550, but 3 (4+4+2) at 800.
    const small = simulateUpgraderFleet({ energyCapacity: 550, allocated: 10 });
    const big = simulateUpgraderFleet({ energyCapacity: 800, allocated: 10 });
    expect(small.workParts).to.deep.equal([2, 2, 2, 2, 2]);
    expect(big.count).to.be.lessThan(small.count);
    expect(big.totalWork, "still consumes the whole allocation").to.equal(10);
  });

  it("does not over-spawn for a tiny allocation", () => {
    // A 2 e/tick allocation gets a single 2-WORK upgrader, not a swarm.
    const fleet = simulateUpgraderFleet({ energyCapacity: 550, allocated: 2 });
    expect(fleet.count).to.equal(1);
    expect(fleet.workParts).to.deep.equal([2]);
  });

  describe("the #59 supply-before-demand gate", () => {
    it("stands the upgraders DOWN until a hauler is delivering", () => {
      // No flow hauler in the room -> the gate emits no demand, so the controller
      // allocation staffs zero upgraders (the energy is reserved for the hauler
      // that closes the delivery loop). With a hauler present it staffs normally.
      expect(simulateUpgraderFleet({ energyCapacity: 550, allocated: 10, hauler: false }).count).to.equal(0);
      expect(simulateUpgraderFleet({ energyCapacity: 550, allocated: 10, hauler: true }).count).to.be.greaterThan(0);
    });
  });

  describe("the #62 active-build rebalance", () => {
    it("scales the upgrader fleet DOWN while a source is dedicated to a build", () => {
      // With one of two sources dedicated to an active build, the upgrader
      // allocation drops to the share of the sources still feeding the core
      // ((total-1)/total = 1/2 here), so upgrading is throttled to ~half while the
      // build runs - the build gets its source's energy instead of the controller.
      const normal = simulateUpgraderFleet({ energyCapacity: 550, allocated: 10, sources: 2 });
      const building = simulateUpgraderFleet({ energyCapacity: 550, allocated: 10, sources: 2, dedicatedBuild: true });
      expect(normal.totalWork).to.equal(10);
      expect(building.totalWork).to.equal(5);
      expect(building.totalWork).to.be.lessThan(normal.totalWork);
    });

    it("keeps a minimal upgrader alive even when the only source is dedicated to the build", () => {
      // A single-source room dedicating its one source to a build scales the
      // allocation to 0 - but the controller must not be abandoned, so a minimal
      // 1-WORK upgrader is still fielded to hold off downgrade.
      const fleet = simulateUpgraderFleet({ energyCapacity: 550, allocated: 10, sources: 1, dedicatedBuild: true });
      expect(fleet.count).to.equal(1);
      expect(fleet.totalWork).to.equal(1);
    });
  });
});
