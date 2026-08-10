import { expect } from "chai";
import {
  SPAWN_EMERGENCE_MIN,
  SPAWN_LIMITS,
  TOWER_LIMITS,
  TOWER_TARGET_PER_ROOM,
  emergenceTileCount,
  wantsAnotherSpawn,
  wantsAnotherTower
} from "../../../src/corps/constructionPlacement";
import { buildRank } from "../../../src/corps/repair";

/**
 * ADDITIONAL SPAWNS AS RCL ALLOWS (owner 2026-07-29: "lets take a look at
 * placing the additional spawns as rcl allows").
 *
 * The colony's hardest physical ceiling is spawn throughput:
 * `spawnCount * SPAWN_PARTS_PER_TICK`. Measured live t72663189-t72665987:
 * Spawn1 ran 0.87-0.97 utilization with queueDepth 4-6 while RCL7 permits TWO
 * spawns - and STRUCTURE_SPAWN was placed NOWHERE in the codebase except
 * ExpansionCampaign (a NEW colony's founding spawn), so an owned room could
 * never add its second. A second spawn DOUBLES the ceiling to 0.667 p/t, and
 * the rate-matched tender model then auto-sizes up to feed it.
 *
 * PLACEMENT RULE (owner-discussed): score by the EXTENSION-GRID cohesion
 * function (findGridPosition), NOT spawnSiteValue. siteValue answers "where
 * would a NEW economy run best" - the wrong question for a developed room
 * whose economy is already planned and routed. The marginal value of spawn #2
 * is THROUGHPUT, which is position-independent: the engine's _charge-energy
 * draws from ALL room extensions nearest-first with no range limit (verified in
 * @screeps/engine). Position only moves two much smaller terms - the tender's
 * refill walk (refillCircuit includes spawns, so a distant spawn lengthens the
 * circuit and can force another tender: the DOMINANT term) and creep travel via
 * effectiveLife (~1%).
 *
 * The one predicate neither existing scorer has: newborns need somewhere to
 * STEP OUT. findGridPosition packs extensions densely because extensions do not
 * care; a spawn walled in by its own grid would strand every creep it builds.
 */
describe("spawn rung: additional spawns as RCL allows", () => {
  describe("SPAWN_LIMITS / wantsAnotherSpawn", () => {
    it("mirrors CONTROLLER_STRUCTURES: one spawn until RCL7, two at 7, three at 8", () => {
      for (const rcl of [1, 2, 3, 4, 5, 6]) expect(SPAWN_LIMITS[rcl], `rcl ${rcl}`).to.equal(1);
      expect(SPAWN_LIMITS[7]).to.equal(2);
      expect(SPAWN_LIMITS[8]).to.equal(3);
    });

    it("wants a second spawn at RCL7 with one built and none pending", () => {
      expect(wantsAnotherSpawn(7, 1, 0)).to.equal(true);
    });

    it("does NOT want one below RCL7", () => {
      expect(wantsAnotherSpawn(6, 1, 0)).to.equal(false);
    });

    it("COUNTS PENDING SITES - never double-places while one is building", () => {
      // A 15k spawn site takes a long time to finish; re-placing every
      // cooldown would spam ERR_INVALID_TARGET and (worse) hide the real rung.
      expect(wantsAnotherSpawn(7, 1, 1)).to.equal(false);
    });

    it("stops at the limit (RCL7 with two built)", () => {
      expect(wantsAnotherSpawn(7, 2, 0)).to.equal(false);
    });

    it("allows a third at RCL8", () => {
      expect(wantsAnotherSpawn(8, 2, 0)).to.equal(true);
    });

    it("treats an unknown RCL as one spawn (never over-places on bad input)", () => {
      expect(wantsAnotherSpawn(0, 1, 0)).to.equal(false);
      expect(wantsAnotherSpawn(99, 3, 0)).to.equal(false);
    });
  });

  describe("emergenceTileCount - newborns must have somewhere to step", () => {
    // isBlocked lens: true = wall or a movement-blocking structure.
    const openRoom = () => () => false;
    const allBlocked = () => () => true;

    it("counts all 8 neighbours in the open", () => {
      expect(emergenceTileCount(openRoom(), 25, 25)).to.equal(8);
    });

    it("returns 0 when every neighbour is blocked (a spawn walled into the grid)", () => {
      expect(emergenceTileCount(allBlocked(), 25, 25)).to.equal(0);
    });

    it("counts only the open neighbours in a dense grid", () => {
      // Only (24,25) and (26,25) free - exactly the minimum.
      const isBlocked = (x: number, y: number) => !((x === 24 && y === 25) || (x === 26 && y === 25));
      expect(emergenceTileCount(isBlocked, 25, 25)).to.equal(2);
      expect(emergenceTileCount(isBlocked, 25, 25)).to.be.at.least(SPAWN_EMERGENCE_MIN);
    });

    it("does not count the tile itself", () => {
      const isBlocked = (x: number, y: number) => !(x === 25 && y === 25); // only the centre free
      expect(emergenceTileCount(isBlocked, 25, 25)).to.equal(0);
    });

    it("treats room-edge tiles as blocked (0,y and 49,y are never walkable posts)", () => {
      // A spawn at x=1 has neighbours at x=0 - the room border, unusable.
      expect(emergenceTileCount(openRoom(), 1, 25)).to.equal(5); // 8 minus the three at x=0
    });

    it("requires at least SPAWN_EMERGENCE_MIN to be a viable spawn tile", () => {
      expect(SPAWN_EMERGENCE_MIN).to.be.at.least(2);
    });
  });

  describe("buildRank - a spawn site outranks everything else", () => {
    it("builds a spawn before containers, extensions and roads", () => {
      expect(buildRank("spawn")).to.be.lessThan(buildRank("container"));
      expect(buildRank("spawn")).to.be.lessThan(buildRank("extension"));
      expect(buildRank("spawn")).to.be.lessThan(buildRank("road"));
    });

    it("keeps the rest of the ladder's order intact", () => {
      expect(buildRank("container")).to.be.lessThan(buildRank("extension"));
      expect(buildRank("extension")).to.be.lessThan(buildRank("storage"));
      expect(buildRank("storage")).to.be.at.most(buildRank("link"));
      expect(buildRank("link")).to.be.lessThan(buildRank("road"));
    });
  });
});

describe("TOWER_LIMITS / wantsAnotherTower (RCL8 build-out, owner 2026-08-09)", () => {
  // Owner: "RCL8 we can build a few buildings like a 3rd spawn. Another
  // tower. More links." The tower rung was hard-coded to ONE tower (any
  // tower at all silenced it - built at RCL3, never another). It now mirrors
  // the spawn rung's shape: an engine-limit table plus a COLONY TARGET that
  // deliberately stops below the RCL8 engine cap of six - every standing
  // tower is idle capital plus refill overhead (tower burn is the account's
  // unmetered residual), so growing past "another tower" is a decision, not
  // a default. One constant to raise when the owner wants more.
  it("mirrors CONTROLLER_STRUCTURES: 1 at RCL3, 2 at RCL5, 3 at RCL7, 6 at RCL8", () => {
    expect(TOWER_LIMITS[3]).to.equal(1);
    expect(TOWER_LIMITS[5]).to.equal(2);
    expect(TOWER_LIMITS[7]).to.equal(3);
    expect(TOWER_LIMITS[8]).to.equal(6);
  });

  it("wants the second tower at RCL5+ with one built (the owner's 'another tower')", () => {
    expect(wantsAnotherTower(5, 1, 0)).to.equal(true);
    expect(wantsAnotherTower(8, 1, 0)).to.equal(true);
  });

  it("the colony target stops at TWO even where the engine allows six", () => {
    expect(TOWER_TARGET_PER_ROOM).to.equal(2);
    expect(wantsAnotherTower(8, 2, 0)).to.equal(false);
  });

  it("COUNTS PENDING SITES - never double-places while one is building", () => {
    expect(wantsAnotherTower(8, 1, 1)).to.equal(false);
  });

  it("the engine cap still binds below the target (RCL3/4: one tower only)", () => {
    expect(wantsAnotherTower(3, 1, 0)).to.equal(false);
    expect(wantsAnotherTower(4, 1, 0)).to.equal(false);
  });

  it("no towers below RCL3", () => {
    expect(wantsAnotherTower(2, 0, 0)).to.equal(false);
  });
});
