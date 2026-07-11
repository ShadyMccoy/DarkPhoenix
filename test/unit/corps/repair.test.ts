import { expect } from "chai";
import {
  pickRepairTarget,
  pickCriticalRepairTarget,
  wantsCriticalRecovery,
  wantsMaintenanceBuilder,
  REPAIR_TO,
  REPAIR_SPAWN_BELOW,
  REPAIR_CRITICAL,
} from "../../../src/corps/repair";

const c = (hits: number, hitsMax = 250000) => ({ hits, hitsMax });

describe("corps/repair", () => {
  describe("pickRepairTarget", () => {
    it("returns null when every structure is above the threshold", () => {
      expect(pickRepairTarget([c(250000), c(200000)], 0.66)).to.equal(null);
    });
    it("picks the most-decayed structure below the threshold", () => {
      const worst = c(100000);
      const target = pickRepairTarget([c(250000), c(160000), worst], 0.66);
      expect(target).to.equal(worst);
    });
    it("ignores structures at exactly the threshold (only strictly below)", () => {
      // 0.66 * 250000 = 165000; a container at exactly that is not yet due
      expect(pickRepairTarget([c(165000)], 0.66)).to.equal(null);
      expect(pickRepairTarget([c(164999)], 0.66)).to.not.equal(null);
    });
    it("ranks by fraction, not absolute hits, across mixed hitsMax scales", () => {
      // A 55% container has far MORE absolute hits than a 60% plain road -
      // fraction ordering picks the container; absolute ordering would not.
      const container = c(137500); // 55% of 250k
      const road = { hits: 3000, hitsMax: 5000 }; // 60%
      expect(pickRepairTarget([road, container], REPAIR_TO)).to.equal(container);
      // A tunnel road at a critical 60% outranks a plain road at 90% even
      // though the tunnel holds 450k hits and the plain road only 4.5k.
      const tunnel = { hits: 450000, hitsMax: 750000 }; // 60%
      const plainRoad = { hits: 4500, hitsMax: 5000 }; // 90%
      expect(pickRepairTarget([plainRoad, tunnel], REPAIR_TO)).to.equal(tunnel);
    });
  });

  describe("wantsMaintenanceBuilder (hysteresis)", () => {
    it("does not field a builder while all containers are near full", () => {
      expect(wantsMaintenanceBuilder([c(250000)], false)).to.equal(false);
    });
    it("starts a builder only once a container is genuinely low (< spawn threshold)", () => {
      const justBelowCeiling = c(Math.floor(250000 * REPAIR_TO) - 1); // below REPAIR_TO but above spawn
      // no builder yet + not low enough -> don't start (avoids flapping)
      expect(wantsMaintenanceBuilder([justBelowCeiling], false)).to.equal(false);
      const low = c(Math.floor(250000 * REPAIR_SPAWN_BELOW) - 1);
      expect(wantsMaintenanceBuilder([low], false)).to.equal(true);
    });
    it("keeps an existing builder repairing until everything reaches the ceiling", () => {
      const midRepair = c(Math.floor(250000 * 0.8)); // above spawn threshold, below ceiling
      // builder exists -> keep going (don't retire at the spawn threshold)
      expect(wantsMaintenanceBuilder([midRepair], true)).to.equal(true);
      // once at the ceiling, retire even with a builder present
      expect(wantsMaintenanceBuilder([c(250000)], true)).to.equal(false);
    });
  });

  describe("pickCriticalRepairTarget (emergency divert gate)", () => {
    it("is null while everything is healthier than the critical gate", () => {
      const justAbove = c(Math.ceil(250000 * REPAIR_CRITICAL) + 1); // just above 30%
      expect(pickCriticalRepairTarget([justAbove, c(200000)])).to.equal(null);
    });
    it("returns the most-decayed structure once one crosses the critical gate", () => {
      const critical = c(20000); // 8% - about to expire
      const dipped = c(Math.floor(250000 * REPAIR_SPAWN_BELOW) - 1); // ~60%, below idle gate but not critical
      expect(pickCriticalRepairTarget([dipped, critical])).to.equal(critical);
    });
    it("ranks by fraction across mixed scales (a critical road outranks a dipped container)", () => {
      const road = { hits: 1000, hitsMax: 5000 }; // 20% - critical
      const container = c(100000); // 40% - not critical
      expect(pickCriticalRepairTarget([container, road])).to.equal(road);
    });
  });

  describe("wantsCriticalRecovery (divert hysteresis)", () => {
    it("holds the diversion until nothing remains in the idle-maintenance band", () => {
      // Repaired past the critical gate but still under the idle start gate -> keep going.
      const stillLow = c(Math.floor(250000 * REPAIR_SPAWN_BELOW) - 1);
      expect(wantsCriticalRecovery([stillLow])).to.equal(true);
      // Once clear of the idle band, release the diversion and resume building.
      const recovered = c(Math.floor(250000 * REPAIR_SPAWN_BELOW) + 1);
      expect(wantsCriticalRecovery([recovered])).to.equal(false);
    });
  });
});
