import { expect } from "chai";
import {
  POST_STAFFED_FRACTION,
  declaredStandingParts,
  isUnderDeclared,
  replacementDeficit
} from "../../../src/economy/replacementSchedule";
import { CREEP_LIFETIME, feederSpawnLoad, tenderSpawnLoad } from "../../../src/economy/primitives";

/**
 * SPEC 39 PHASE 3 - the plan schedules replacements instead of auctioning them.
 *
 * The measured shape this is written against (t72851251):
 *
 *   tender   declared 48 parts (tenderSpawnLoad x 1500)   fielded 34   → SHORT
 *   feeder   declared 32 parts (feederSpawnLoad x ~1500)  fielded 100  → OVER
 *
 * Both are failures of the same missing check, and they need OPPOSITE
 * responses: the tender needs the heartbeat lane so its replacement is bought
 * from a full network, and the feeder needs nothing from this module at all -
 * an overage is a PRICING problem, and reading it as a scheduling one would
 * promote the colony's most expensive corp.
 */
describe("spec 39 phase 3: the replacement schedule reads PARTS, not counts", () => {
  describe("declaredStandingParts", () => {
    it("converts the commission's replacement RATE into the standing body it pays for", () => {
      expect(declaredStandingParts(tenderSpawnLoad())).to.equal(48);
      expect(declaredStandingParts(0.02)).to.equal(30);
    });

    it("reads an absent or zero price as zero, never as a deficit", () => {
      expect(declaredStandingParts(undefined)).to.equal(0);
      expect(declaredStandingParts(0)).to.equal(0);
      expect(declaredStandingParts(-1)).to.equal(0);
    });

    it("is the CREEP_LIFETIME conversion, so the account and the scheduler agree", () => {
      expect(declaredStandingParts(1 / CREEP_LIFETIME)).to.equal(1);
    });
  });

  describe("replacementDeficit", () => {
    it("is the live tender's shortfall: 48 declared, 34 standing", () => {
      expect(replacementDeficit(48, 34)).to.equal(14);
    });

    it("is ZERO for an overage - the feeder's 100 against 32 is not a refill problem", () => {
      expect(replacementDeficit(32, 100)).to.equal(0);
    });

    it("treats a dark post as its whole body, and an unpriced post as nothing", () => {
      expect(replacementDeficit(48, 0)).to.equal(48);
      expect(replacementDeficit(0, 0)).to.equal(0);
    });
  });

  describe("isUnderDeclared - THE promotion predicate", () => {
    it("promotes the live tender (34 of 48 = 0.71)", () => {
      expect(isUnderDeclared(48, 34)).to.equal(true);
    });

    it("does NOT promote the live feeder - it is over its price, not under", () => {
      const feederParts = declaredStandingParts(feederSpawnLoad(53, true));
      expect(isUnderDeclared(feederParts, 100)).to.equal(false);
    });

    it("does NOT promote a post inside body-rounding slack - the W2N6 guard", () => {
      // An unconditional lift measurably recreated the W2N6 stream in the
      // cold-start trio. A correctly-sized post must read false and keep its
      // ordinary rung, or the lane is unconditional by another name.
      expect(isUnderDeclared(48, 48), "exactly on price").to.equal(false);
      expect(isUnderDeclared(48, 44), "one pair light of a continuous price").to.equal(false);
      expect(isUnderDeclared(48, 100), "over").to.equal(false);
    });

    it("opens exactly at the staffed fraction, and closes again above it", () => {
      const boundary = 48 * POST_STAFFED_FRACTION; // 40.8
      expect(isUnderDeclared(48, Math.ceil(boundary))).to.equal(false);
      expect(isUnderDeclared(48, Math.floor(boundary))).to.equal(true);
    });

    it("a DARK post is under-declared - the count-gated case still fires", () => {
      expect(isUnderDeclared(48, 0)).to.equal(true);
    });

    it("an UNPRICED corp is never promoted - unknown is not a deficit", () => {
      // Auxiliary kinds still off-budget (construction, scout, coreBuster) and
      // every harness path with no commission declare nothing. Fabricating a
      // deficit here would put all of them in the heartbeat lane.
      expect(isUnderDeclared(undefined, 0)).to.equal(false);
      expect(isUnderDeclared(0, 0)).to.equal(false);
    });
  });
});
