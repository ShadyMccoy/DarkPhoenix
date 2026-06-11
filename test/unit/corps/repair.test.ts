import { expect } from "chai";
import { pickRepairTarget, wantsMaintenanceBuilder, REPAIR_TO, REPAIR_SPAWN_BELOW } from "../../../src/corps/repair";

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
});
