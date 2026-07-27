import { expect } from "chai";
import {
  BUSTER,
  CLAIM,
  FEEDER,
  FEEDER_DRAINED,
  FEEDER_LINCHPIN,
  GUARD,
  RESERVATION_TOPUP,
  RESERVER,
  TENDER,
  TENDER_BOOTSTRAP
} from "../../../src/spawn/demandLadder";

/**
 * THE spawn-demand value-ladder ordering pin (spec 32 phase D, audit finding
 * corps-rest/9): the relative order that used to live only as cross-referencing
 * prose in six corp files ("above the miner band", "below the reserver's
 * 115"). Complements - does not replace - the corp-level pins that check each
 * demand carries its rung with the right flags (raidGuard.test.ts "hauler
 * floor 90 < guard 105 < reserver 115", coreBuster.test.ts "miners 100 <
 * buster 104 < guard 105 < reserver 115", the tender/feeder/claim demand
 * tests). Values are measured and incident-derived - never nudge one rung in
 * isolation (the 90-vs-85 sink-ladder founding incident's lesson, applied to
 * the spawn ladder).
 */
describe("demandLadder (the one spawn-value ladder home)", () => {
  // The COMPUTED bands the rungs are calibrated against (formulas live in the
  // corps; these literals are the ladder's documented shape, not new policy):
  const MINER_BASE = 100; // HarvestCorp: 100 + efficiency*0.5
  const MINER_TOP = 150; // efficiency < 100 -> miners top out just under 150
  const HAULER_FLOOR = 90; // CarryCorp: 90 + min(carryNeeded, 20)
  const HAULER_CEILING = 110;
  const CONSTRUCTION_BUILDER = 95; // ConstructionCorp builder squad
  const CONSTRUCTION_TANKER = 94; // ConstructionCorp tanker squad

  it("pins the full strict order of the named rungs", () => {
    expect(RESERVATION_TOPUP).to.be.lessThan(CLAIM);
    expect(CLAIM).to.be.lessThan(FEEDER_DRAINED);
    expect(FEEDER_DRAINED).to.be.lessThan(FEEDER);
    expect(FEEDER).to.be.lessThan(TENDER);
    expect(TENDER).to.be.lessThan(BUSTER);
    expect(BUSTER).to.be.lessThan(GUARD);
    expect(GUARD).to.be.lessThan(RESERVER);
    expect(RESERVER).to.be.lessThan(TENDER_BOOTSTRAP);
    expect(TENDER_BOOTSTRAP).to.equal(FEEDER_LINCHPIN); // the two 150 emergencies share the top
  });

  it("pins the rungs against the computed miner/hauler bands (the scattered cross-references, in one place)", () => {
    // Drained feeder yields to income: at (not above) the hauler floor, below miners.
    expect(FEEDER_DRAINED).to.be.at.most(HAULER_FLOOR);
    expect(FEEDER_DRAINED).to.be.lessThan(MINER_BASE);
    // Claim never outbids the economy that pays for it.
    expect(CLAIM).to.be.lessThan(HAULER_FLOOR);
    // Tender/feeder infra tier: above the construction crew, below mining.
    expect(FEEDER).to.be.at.least(CONSTRUCTION_BUILDER);
    expect(TENDER).to.be.greaterThan(CONSTRUCTION_BUILDER);
    expect(TENDER).to.be.greaterThan(CONSTRUCTION_TANKER);
    expect(TENDER).to.be.lessThan(MINER_BASE);
    // Mission/optimisation tier: above the miner base, inside the hauler band's
    // top half, below the reserver (raidGuard.test.ts:139's pin, table form).
    expect(BUSTER).to.be.greaterThan(MINER_BASE);
    expect(GUARD).to.be.greaterThan(HAULER_FLOOR);
    expect(GUARD).to.be.lessThan(RESERVER);
    // The reserver outbids every scaling hauler outright.
    expect(RESERVER).to.be.greaterThan(HAULER_CEILING);
    // The two emergencies top the whole computed range: every miner
    // (efficiency < 100) and every hauler loses to them on value.
    expect(TENDER_BOOTSTRAP).to.be.at.least(MINER_TOP);
    expect(FEEDER_LINCHPIN).to.be.at.least(MINER_TOP);
  });

  it("pins the exact table (values are measured; per-corp tests pin each demand carries its rung)", () => {
    expect({
      FEEDER_LINCHPIN,
      TENDER_BOOTSTRAP,
      RESERVER,
      GUARD,
      BUSTER,
      TENDER,
      FEEDER,
      FEEDER_DRAINED,
      CLAIM,
      RESERVATION_TOPUP
    }).to.deep.equal({
      FEEDER_LINCHPIN: 150,
      TENDER_BOOTSTRAP: 150,
      RESERVER: 115,
      GUARD: 105,
      BUSTER: 104,
      TENDER: 96,
      FEEDER: 95,
      FEEDER_DRAINED: 90,
      CLAIM: 80,
      RESERVATION_TOPUP: 5
    });
  });
});
