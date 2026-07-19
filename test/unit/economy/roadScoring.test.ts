import { expect } from "chai";
import {
  PLAIN_FATIGUE,
  ROAD_FATIGUE,
  RoadScoreMap,
  SWAMP_FATIGUE,
  countFatigueParts,
  decayScores,
  packTile,
  recordStep,
  stepScore,
  topScoredTiles,
  unpackTile
} from "../../../src/economy/roadScoring";

/**
 * The EMPIRICAL road model. A tile's score per creep-step is the move-fatigue a
 * road there would have removed: fatigueParts * (terrainFatigue - ROAD_FATIGUE),
 * which is 1x on plain (2 -> 1) and 9x on swamp (10 -> 1). Empty haulers and
 * all-MOVE bodies generate no fatigue, so their steps buy nothing and score 0.
 * This is the same fatigue currency roadEconomics prices in energy/spawn-parts.
 */
describe("economy/roadScoring", () => {
  describe("countFatigueParts", () => {
    it("MOVE parts never charge fatigue", () => {
      expect(countFatigueParts([{ type: MOVE }, { type: MOVE }], 0)).to.equal(0);
    });

    it("non-MOVE non-CARRY parts always charge", () => {
      expect(countFatigueParts([{ type: WORK }, { type: WORK }, { type: MOVE }], 0)).to.equal(2);
    });

    it("empty CARRY parts charge nothing; loaded ones charge in proportion to the load", () => {
      const body = [{ type: CARRY }, { type: CARRY }, { type: MOVE }];
      expect(countFatigueParts(body, 0)).to.equal(0); // empty hauler
      expect(countFatigueParts(body, 50)).to.equal(1); // one full CARRY worth
      expect(countFatigueParts(body, 51)).to.equal(2); // rounds up
      expect(countFatigueParts(body, 100)).to.equal(2); // full, capped at CARRY count
    });

    it("mixes heavy and loaded-carry parts", () => {
      const body = [{ type: WORK }, { type: CARRY }, { type: CARRY }, { type: MOVE }];
      expect(countFatigueParts(body, 50)).to.equal(2); // 1 WORK + 1 loaded CARRY
    });

    it("skips disabled (hits 0) parts", () => {
      const body = [
        { type: WORK, hits: 0 },
        { type: WORK, hits: 100 },
        { type: MOVE }
      ];
      expect(countFatigueParts(body, 0)).to.equal(1);
    });
  });

  describe("stepScore", () => {
    it("plain scores the fatigue a road saves: 1 per fatigue-part", () => {
      expect(stepScore(0, 2)).to.equal(2 * (PLAIN_FATIGUE - ROAD_FATIGUE));
      expect(stepScore(0, 2)).to.equal(2);
    });

    it("swamp scores 9x plain (10 -> 1 fatigue)", () => {
      expect(stepScore(TERRAIN_MASK_SWAMP, 2)).to.equal(2 * (SWAMP_FATIGUE - ROAD_FATIGUE));
      expect(stepScore(TERRAIN_MASK_SWAMP, 2)).to.equal(18);
    });

    it("walls have no unpaved baseline: score 0", () => {
      expect(stepScore(TERRAIN_MASK_WALL, 5)).to.equal(0);
    });

    it("fatigue-free steps score 0", () => {
      expect(stepScore(0, 0)).to.equal(0);
      expect(stepScore(TERRAIN_MASK_SWAMP, 0)).to.equal(0);
    });
  });

  describe("packTile / unpackTile", () => {
    it("round-trips every corner", () => {
      for (const [x, y] of [
        [0, 0],
        [49, 49],
        [0, 49],
        [49, 0],
        [23, 41]
      ]) {
        expect(unpackTile(packTile(x, y))).to.deep.equal({ x, y });
      }
    });
  });

  describe("recordStep", () => {
    it("accumulates and ignores non-positive increments", () => {
      const map: RoadScoreMap = {};
      recordStep(map, 5, 5, 3);
      recordStep(map, 5, 5, 2);
      recordStep(map, 5, 5, 0);
      recordStep(map, 5, 5, -4);
      expect(map[packTile(5, 5)]).to.equal(5);
    });
  });

  describe("decayScores", () => {
    it("multiplies by the factor and prunes tiles below the floor", () => {
      const map: RoadScoreMap = { [packTile(1, 1)]: 100, [packTile(2, 2)]: 3 };
      decayScores(map, 0.5, 2);
      expect(map[packTile(1, 1)]).to.equal(50);
      expect(map[packTile(2, 2)]).to.be.undefined; // 1.5 < floor 2
    });
  });

  describe("topScoredTiles", () => {
    it("returns tiles descending by score, filtered by min and capped by limit", () => {
      const map: RoadScoreMap = {
        [packTile(1, 1)]: 10,
        [packTile(2, 2)]: 50,
        [packTile(3, 3)]: 5,
        [packTile(4, 4)]: 30
      };
      const top = topScoredTiles(map, { min: 8, limit: 2 });
      expect(top).to.deep.equal([
        { x: 2, y: 2, score: 50 },
        { x: 4, y: 4, score: 30 }
      ]);
    });

    it("breaks ties by packed index for determinism", () => {
      const map: RoadScoreMap = { [packTile(3, 0)]: 7, [packTile(1, 0)]: 7 };
      const top = topScoredTiles(map);
      expect(top.map(t => t.x)).to.deep.equal([1, 3]); // lower packed index first
    });
  });
});
