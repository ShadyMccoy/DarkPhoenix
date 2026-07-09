import { expect } from "chai";
import { pickSpawnSpot, walkDistance } from "../../../src/spatial/spawnPlacement";

const open = (): string[] => {
  const rows = Array.from({ length: 50 }, () => ".".repeat(50));
  rows[0] = "#".repeat(50);
  rows[49] = "#".repeat(50);
  return rows.map((r, y) => (y === 0 || y === 49 ? r : `#${r.slice(1, 49)}#`));
};

const setTile = (rows: string[], x: number, y: number, c: string): void => {
  rows[y] = rows[y].slice(0, x) + c + rows[y].slice(x + 1);
};

describe("spatial/spawnPlacement", () => {
  describe("pickSpawnSpot", () => {
    it("lands near the anchor centroid on an open room", () => {
      const spot = pickSpawnSpot(open(), [{ x: 10, y: 25 }, { x: 40, y: 25 }, { x: 25, y: 10 }])!;
      // centroid (25, 20); the spot is open-plain and close to it
      expect(Math.abs(spot.x - 25)).to.be.at.most(3);
      expect(Math.abs(spot.y - 20)).to.be.at.most(3);
    });

    it("keeps 2+ tiles clear of the objects themselves", () => {
      const spot = pickSpawnSpot(open(), [{ x: 25, y: 25 }])!;
      expect(Math.max(Math.abs(spot.x - 25), Math.abs(spot.y - 25))).to.be.at.least(2);
    });

    it("refuses tiles whose 8-neighbourhood is not fully plain", () => {
      const rows = open();
      // wall off the centroid region except one swamp-adjacent pocket
      for (let x = 20; x <= 30; x++) for (let y = 20; y <= 30; y++) setTile(rows, x, y, "#");
      const spot = pickSpawnSpot(rows, [{ x: 25, y: 25 }])!;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          expect(rows[spot.y + dy][spot.x + dx]).to.equal(".");
        }
      }
    });

    it("returns null when no open plain tile exists", () => {
      const rows = Array.from({ length: 50 }, () => "#".repeat(50));
      expect(pickSpawnSpot(rows, [{ x: 25, y: 25 }])).to.equal(null);
    });
  });

  describe("walkDistance", () => {
    it("is chebyshev-like on open ground (8-directional)", () => {
      expect(walkDistance(open(), { x: 10, y: 25 }, { x: 20, y: 25 })).to.equal(9); // range 1
    });

    it("routes around walls", () => {
      const rows = open();
      for (let y = 1; y <= 40; y++) setTile(rows, 25, y, "#");
      const direct = walkDistance(open(), { x: 20, y: 10 }, { x: 30, y: 10 });
      const detour = walkDistance(rows, { x: 20, y: 10 }, { x: 30, y: 10 });
      expect(detour).to.be.greaterThan(direct + 20);
    });

    it("returns Infinity for a sealed target (tunnel-candidate signal)", () => {
      const rows = open();
      for (const [x, y] of [[29, 9], [30, 9], [31, 9], [29, 10], [31, 10], [29, 11], [30, 11], [31, 11]]) {
        setTile(rows, x, y, "#");
      }
      expect(walkDistance(rows, { x: 10, y: 10 }, { x: 30, y: 10 })).to.equal(Infinity);
    });
  });
});
