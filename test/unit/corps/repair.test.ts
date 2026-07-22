import { expect } from "chai";
import {
  pickRepairTarget,
  pickCriticalRepairTarget,
  wantsCriticalRecovery,
  wantsMaintenanceBuilder,
  nextRepairTarget,
  REPAIR_TO,
  REPAIR_SPAWN_BELOW,
  REPAIR_CRITICAL,
} from "../../../src/corps/repair";

const c = (hits: number, hitsMax = 250000) => ({ hits, hitsMax });
const cid = (id: string, hits: number, hitsMax = 250000) => ({ id, hits, hitsMax });

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

  describe("nextRepairTarget (finish-one-before-the-next latch)", () => {
    it("with no latch, picks the most-decayed structure", () => {
      const worst = cid("a", 100000);
      expect(nextRepairTarget([cid("b", 200000), worst], undefined)).to.equal(worst);
    });
    it("stays on the latched target even after it stops being the most decayed", () => {
      // 'a' started worst (50%), and we've repaired it up to 60% - now 'b' (55%)
      // is the lowest fraction, but the latch keeps the builder finishing 'a'.
      const latched = cid("a", Math.floor(250000 * 0.6));
      const rival = cid("b", Math.floor(250000 * 0.55));
      expect(nextRepairTarget([rival, latched], "a")).to.equal(latched);
    });
    it("releases the latch and moves on once the target reaches the ceiling", () => {
      const done = cid("a", 250000); // fully repaired
      const next = cid("b", Math.floor(250000 * 0.55));
      expect(nextRepairTarget([next, done], "a")).to.equal(next);
    });
    it("re-picks the most decayed when the latched structure is gone (decayed away)", () => {
      const next = cid("b", 100000);
      expect(nextRepairTarget([next, cid("c", 240000)], "missing")).to.equal(next);
    });
    it("returns null once everything is at the ceiling", () => {
      expect(nextRepairTarget([cid("a", 250000), cid("b", 250000)], "a")).to.equal(null);
    });
  });

  describe("repair efficiency (WORK spent repairing, not commuting)", () => {
    // A builder that re-picks the lowest-fraction target EVERY tick ping-pongs
    // between two similarly-decayed structures: it repairs the worst a little,
    // that lifts it past its rival, so the rival becomes worst and the builder
    // walks off to it - abandoning a structure still below the ceiling and
    // burning ticks (and its WORK parts) on the commute. This drives a tiny
    // deterministic sim through nextRepairTarget and measures the waste, so a
    // regression back to per-tick re-picking trips these assertions.
    interface SimStruct {
      id: string;
      hits: number;
      hitsMax: number;
      pos: number; // 1-D position; the builder walks one tile/tick between them
    }
    const REPAIR_POWER = 5000; // large so the sim is short; the latch is scale-free

    function simulate(structs: SimStruct[], start: number, maxTicks = 1000) {
      let pos = start;
      let latched: string | undefined;
      let prevId: string | undefined;
      let repairTicks = 0;
      let moveTicks = 0;
      let abandonments = 0;
      for (let t = 0; t < maxTicks; t++) {
        const target = nextRepairTarget(structs, latched);
        if (!target) break; // everything at the ceiling
        // Abandonment: we switched targets while the previous one was still below
        // the ceiling - the exact waste the latch exists to prevent.
        const prev = prevId ? structs.find(s => s.id === prevId) : undefined;
        if (prev && prev.id !== target.id && prev.hits < prev.hitsMax * REPAIR_TO) {
          abandonments++;
        }
        prevId = target.id;
        latched = target.id;
        if (pos === target.pos) {
          target.hits = Math.min(target.hitsMax, target.hits + REPAIR_POWER);
          repairTicks++;
        } else {
          pos += Math.sign(target.pos - pos);
          moveTicks++;
        }
      }
      return { repairTicks, moveTicks, abandonments, utilization: repairTicks / (repairTicks + moveTicks) };
    }

    it("never abandons a below-ceiling structure to go work on another", () => {
      const structs: SimStruct[] = [
        { id: "a", hits: 125000, hitsMax: 250000, pos: 0 }, // 50%
        { id: "b", hits: 137500, hitsMax: 250000, pos: 12 } // 55%, far away
      ];
      expect(simulate(structs, 0).abandonments).to.equal(0);
    });

    it("spends its WORK parts repairing, not commuting (one traversal, not a ping-pong)", () => {
      const structs: SimStruct[] = [
        { id: "a", hits: 125000, hitsMax: 250000, pos: 0 },
        { id: "b", hits: 137500, hitsMax: 250000, pos: 12 }
      ];
      const { moveTicks, utilization } = simulate(structs, 0);
      // Finishing 'a' before starting 'b' costs exactly ONE 12-tile walk. A
      // per-tick re-pick would cross that gap dozens of times.
      expect(moveTicks).to.be.at.most(12);
      // Effective WORK: the fraction of ticks the builder's WORK parts actually
      // repair rather than commute. Ping-ponging drags this toward zero; finishing
      // one structure at a time keeps the parts effective.
      expect(utilization).to.be.greaterThan(0.75);
    });
  });

  describe("wantsCriticalRecovery (divert hysteresis, both sides explicit)", () => {
    // The 2026-07-19 concurrent-cell finding: implemented one-sided (release
    // band only), a routine 43% container read as "critical" and the
    // last-builder guard's emergency exception held the lone builder on
    // maintenance for 240 ticks while a site sat untouched. The hysteresis
    // needs the in-diversion state as an INPUT: start at REPAIR_CRITICAL,
    // hold-to-REPAIR_SPAWN_BELOW only once genuinely started.
    it("does NOT start for a routine maintenance-band dip (the measured false-critical)", () => {
      const routineDip = c(107500); // 43% - the staged cell's container A
      expect(wantsCriticalRecovery([routineDip], false)).to.equal(false);
    });
    it("starts only below the critical gate", () => {
      const critical = c(Math.floor(250000 * REPAIR_CRITICAL) - 1);
      expect(wantsCriticalRecovery([critical], false)).to.equal(true);
      const justAbove = c(Math.floor(250000 * REPAIR_CRITICAL) + 1);
      expect(wantsCriticalRecovery([justAbove], false)).to.equal(false);
    });
    it("holds a STARTED diversion until nothing remains in the idle-maintenance band", () => {
      // Repaired past the critical gate but still under the idle start gate -> keep going.
      const stillLow = c(Math.floor(250000 * REPAIR_SPAWN_BELOW) - 1);
      expect(wantsCriticalRecovery([stillLow], true)).to.equal(true);
      // Once clear of the idle band, release the diversion and resume building.
      const recovered = c(Math.floor(250000 * REPAIR_SPAWN_BELOW) + 1);
      expect(wantsCriticalRecovery([recovered], true)).to.equal(false);
    });
  });
});
