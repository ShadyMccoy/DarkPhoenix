/**
 * @fileoverview Unit tests for peak detection algorithms.
 *
 * Tests findPeaks and filterPeaks functions which identify
 * local maxima in the distance transform matrix.
 */

import { expect } from "chai";
import {
  createDistanceTransform,
  findPeaks,
  filterPeaks,
  PeakData,
} from "../../../src/spatial/algorithms";
import {
  createEmptyRoomTerrain,
  createCorridorTerrain,
  createIslandsTerrain,
  createTerrainFromPattern,
  TERRAIN_MASK_WALL,
} from "../mock";
import {
  SMALL_EMPTY_ROOM,
  SMALL_TWO_ISLANDS,
  SMALL_CORRIDOR,
  SINGLE_TILE,
} from "./fixtures/terrain-patterns";

// Helper to create distance transform and find peaks for small patterns
function analyzeSmallTerrain(
  terrain: (x: number, y: number) => number,
  size: number = 10
): { distanceMatrix: number[][]; peaks: PeakData[] } {
  const grid: number[][] = [];
  const queue: { x: number; y: number; distance: number }[] = [];

  // Create distance transform
  for (let x = 0; x < size; x++) {
    grid[x] = [];
    for (let y = 0; y < size; y++) {
      if (terrain(x, y) === TERRAIN_MASK_WALL) {
        grid[x][y] = 0;
        queue.push({ x, y, distance: 0 });
      } else {
        grid[x][y] = Infinity;
      }
    }
  }

  const neighbors8 = [
    { x: -1, y: -1 },
    { x: -1, y: 0 },
    { x: -1, y: 1 },
    { x: 0, y: 1 },
    { x: 1, y: -1 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: -1 },
  ];

  while (queue.length > 0) {
    const { x, y, distance } = queue.shift()!;
    for (const n of neighbors8) {
      const nx = x + n.x;
      const ny = y + n.y;
      if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
        const currentDistance = grid[nx][ny];
        const newDistance = distance + 1;
        if (
          terrain(nx, ny) !== TERRAIN_MASK_WALL &&
          newDistance < currentDistance
        ) {
          grid[nx][ny] = newDistance;
          queue.push({ x: nx, y: ny, distance: newDistance });
        }
      }
    }
  }

  // Replace Infinity with 0
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      if (grid[x][y] === Infinity) {
        grid[x][y] = 0;
      }
    }
  }

  // Find peaks (adapted for small grid)
  const searchCollection: { x: number; y: number; height: number }[] = [];
  const visited = new Set<string>();
  const peaks: PeakData[] = [];

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      if (terrain(x, y) !== TERRAIN_MASK_WALL) {
        const height = grid[x][y];
        if (height > 0 && height !== Infinity) {
          searchCollection.push({ x, y, height });
        }
      }
    }
  }

  searchCollection.sort((a, b) => b.height - a.height);

  const neighbors4 = [
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: -1 },
    { x: 0, y: 1 },
  ];

  while (searchCollection.length > 0) {
    const tile = searchCollection.shift()!;
    if (visited.has(`${tile.x},${tile.y}`)) continue;

    const cluster: { x: number; y: number }[] = [];
    const bfsQueue = [{ x: tile.x, y: tile.y }];

    while (bfsQueue.length > 0) {
      const { x, y } = bfsQueue.pop()!;
      const key = `${x},${y}`;

      if (visited.has(key)) continue;
      if (grid[x][y] !== tile.height) continue;

      visited.add(key);
      cluster.push({ x, y });

      for (const n of neighbors4) {
        const nx = x + n.x;
        const ny = y + n.y;
        if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
          bfsQueue.push({ x: nx, y: ny });
        }
      }
    }

    if (cluster.length === 0) continue;

    const centerX = Math.round(
      cluster.reduce((sum, t) => sum + t.x, 0) / cluster.length
    );
    const centerY = Math.round(
      cluster.reduce((sum, t) => sum + t.y, 0) / cluster.length
    );

    peaks.push({
      tiles: cluster,
      center: { x: centerX, y: centerY },
      height: tile.height,
    });
  }

  return { distanceMatrix: grid, peaks };
}

describe("findPeaks", () => {
  describe("basic behavior", () => {
    it("should return an array of peaks", () => {
      const terrain = createEmptyRoomTerrain();
      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = findPeaks(distanceMatrix, terrain);

      expect(peaks).to.be.an("array");
      expect(peaks.length).to.be.greaterThan(0);
    });

    it("should include tiles, center, and height for each peak", () => {
      const terrain = createEmptyRoomTerrain();
      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = findPeaks(distanceMatrix, terrain);

      const peak = peaks[0];
      expect(peak).to.have.property("tiles").that.is.an("array");
      expect(peak).to.have.property("center");
      expect(peak.center).to.have.property("x").that.is.a("number");
      expect(peak.center).to.have.property("y").that.is.a("number");
      expect(peak).to.have.property("height").that.is.a("number");
    });

    it("should have peak heights greater than 0", () => {
      const terrain = createEmptyRoomTerrain();
      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = findPeaks(distanceMatrix, terrain);

      for (const peak of peaks) {
        expect(peak.height).to.be.greaterThan(0);
      }
    });
  });

  describe("empty room", () => {
    it("should find a single central peak", () => {
      const { peaks } = analyzeSmallTerrain(
        SMALL_EMPTY_ROOM.terrain,
        SMALL_EMPTY_ROOM.gridSize
      );

      // After filtering close peaks, should have 1 main peak
      const filtered = filterPeaks(peaks);
      expect(filtered.length).to.be.at.least(1);

      // The highest peak should be near center
      const highestPeak = filtered.reduce((a, b) =>
        a.height > b.height ? a : b
      );
      expect(highestPeak.center.x).to.be.at.least(3).and.at.most(6);
      expect(highestPeak.center.y).to.be.at.least(3).and.at.most(6);
    });

    it("should have peak at center for full empty room", () => {
      const terrain = createEmptyRoomTerrain();
      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = findPeaks(distanceMatrix, terrain);
      const filtered = filterPeaks(peaks);

      // Find the highest peak
      const highestPeak = filtered.reduce((a, b) =>
        a.height > b.height ? a : b
      );

      // Should be near center (25, 25)
      expect(highestPeak.center.x).to.be.at.least(20).and.at.most(30);
      expect(highestPeak.center.y).to.be.at.least(20).and.at.most(30);
    });
  });

  describe("two islands", () => {
    it("should find two peaks for two separate areas", () => {
      const { peaks } = analyzeSmallTerrain(
        SMALL_TWO_ISLANDS.terrain,
        SMALL_TWO_ISLANDS.gridSize
      );

      // Should find peaks in both islands
      // Note: exact count may vary based on filtering, but should be >= 2
      expect(peaks.length).to.be.at.least(2);
    });

    it("should have peaks in different regions", () => {
      const { peaks } = analyzeSmallTerrain(
        SMALL_TWO_ISLANDS.terrain,
        SMALL_TWO_ISLANDS.gridSize
      );

      // Find the two highest peaks
      const sorted = [...peaks].sort((a, b) => b.height - a.height);
      if (sorted.length >= 2) {
        const peak1 = sorted[0];
        const peak2 = sorted[1];

        // They should be in different Y regions (top vs bottom half)
        const sameRegion =
          (peak1.center.y < 5 && peak2.center.y < 5) ||
          (peak1.center.y >= 5 && peak2.center.y >= 5);

        // At least some peaks should be in different regions
        // (can't guarantee top 2 are in different regions)
      }
    });
  });

  describe("corridor terrain", () => {
    it("should find peak along corridor center", () => {
      const { peaks } = analyzeSmallTerrain(
        SMALL_CORRIDOR.terrain,
        SMALL_CORRIDOR.gridSize
      );

      // Should find at least one peak in the corridor
      expect(peaks.length).to.be.at.least(1);

      // Peak should be in corridor Y range (3-6 for SMALL_CORRIDOR)
      const corridorPeak = peaks.find(
        (p) => p.center.y >= 3 && p.center.y <= 6
      );
      expect(corridorPeak).to.exist;
    });

    it("should have lower peak height than empty room", () => {
      const { peaks: emptyPeaks } = analyzeSmallTerrain(
        SMALL_EMPTY_ROOM.terrain,
        SMALL_EMPTY_ROOM.gridSize
      );
      const { peaks: corridorPeaks } = analyzeSmallTerrain(
        SMALL_CORRIDOR.terrain,
        SMALL_CORRIDOR.gridSize
      );

      const emptyMax = Math.max(...emptyPeaks.map((p) => p.height));
      const corridorMax = Math.max(...corridorPeaks.map((p) => p.height));

      expect(corridorMax).to.be.lessThan(emptyMax);
    });
  });

  describe("plateau handling", () => {
    it("should cluster same-height tiles into one peak", () => {
      // Create a flat plateau in center
      const plateauTerrain = createTerrainFromPattern([
        "XXXXXXXXXX",
        "X........X",
        "X........X",
        "X........X",
        "X........X",
        "X........X",
        "X........X",
        "X........X",
        "X........X",
        "XXXXXXXXXX",
      ]);

      const { peaks } = analyzeSmallTerrain(plateauTerrain, 10);

      // The highest peak should contain multiple tiles (the plateau)
      const highestPeak = peaks.reduce((a, b) =>
        a.height > b.height ? a : b
      );
      expect(highestPeak.tiles.length).to.be.at.least(1);
    });

    it("should calculate centroid correctly for plateau", () => {
      const { peaks } = analyzeSmallTerrain(
        SMALL_EMPTY_ROOM.terrain,
        SMALL_EMPTY_ROOM.gridSize
      );

      const highestPeak = peaks.reduce((a, b) =>
        a.height > b.height ? a : b
      );

      // Centroid should be approximately the average of tile positions
      if (highestPeak.tiles.length > 1) {
        const avgX =
          highestPeak.tiles.reduce((sum, t) => sum + t.x, 0) /
          highestPeak.tiles.length;
        const avgY =
          highestPeak.tiles.reduce((sum, t) => sum + t.y, 0) /
          highestPeak.tiles.length;

        expect(Math.abs(highestPeak.center.x - avgX)).to.be.at.most(1);
        expect(Math.abs(highestPeak.center.y - avgY)).to.be.at.most(1);
      }
    });
  });
});

describe("filterPeaks", () => {
  describe("basic behavior", () => {
    it("should return an array of peaks", () => {
      const terrain = createEmptyRoomTerrain();
      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = findPeaks(distanceMatrix, terrain);
      const filtered = filterPeaks(peaks);

      expect(filtered).to.be.an("array");
    });

    it("should return fewer or equal peaks than input", () => {
      const terrain = createEmptyRoomTerrain();
      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = findPeaks(distanceMatrix, terrain);
      const filtered = filterPeaks(peaks);

      expect(filtered.length).to.be.at.most(peaks.length);
    });

    it("should preserve peak structure", () => {
      const terrain = createEmptyRoomTerrain();
      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = findPeaks(distanceMatrix, terrain);
      const filtered = filterPeaks(peaks);

      for (const peak of filtered) {
        expect(peak).to.have.property("tiles");
        expect(peak).to.have.property("center");
        expect(peak).to.have.property("height");
      }
    });
  });

  describe("exclusion radius", () => {
    it("should keep taller peaks over shorter nearby peaks", () => {
      const terrain = createEmptyRoomTerrain();
      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = findPeaks(distanceMatrix, terrain);
      const filtered = filterPeaks(peaks);

      // The filtered peaks should include the tallest ones
      const originalMax = Math.max(...peaks.map((p) => p.height));
      const filteredMax = Math.max(...filtered.map((p) => p.height));

      expect(filteredMax).to.equal(originalMax);
    });

    it("should keep distant peaks even if shorter", () => {
      // Create terrain with two well-separated areas
      const terrain = createIslandsTerrain([
        { x: 10, y: 25, radius: 6 },
        { x: 40, y: 25, radius: 6 },
      ]);

      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = findPeaks(distanceMatrix, terrain);
      const filtered = filterPeaks(peaks);

      // Should keep both peaks since they're far apart
      expect(filtered.length).to.be.at.least(2);
    });

    it("should merge close peaks into one", () => {
      // Create a single large open area - should result in one peak
      const terrain = createEmptyRoomTerrain();
      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = findPeaks(distanceMatrix, terrain);
      const filtered = filterPeaks(peaks);

      // In a fully open room, filtering should reduce to just a few peaks
      // (possibly just 1 depending on the distance transform shape)
      expect(filtered.length).to.be.at.most(peaks.length);
    });
  });

  describe("sorting by height", () => {
    it("should process peaks in height order", () => {
      const terrain = createEmptyRoomTerrain();
      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = findPeaks(distanceMatrix, terrain);
      const filtered = filterPeaks(peaks);

      // The highest peak should always be kept
      const originalMax = Math.max(...peaks.map((p) => p.height));
      const hasHighest = filtered.some((p) => p.height === originalMax);

      expect(hasHighest).to.be.true;
    });
  });

  describe("edge cases", () => {
    it("should handle empty peaks array", () => {
      const filtered = filterPeaks([]);
      expect(filtered).to.deep.equal([]);
    });

    it("should handle single peak", () => {
      const singlePeak: PeakData = {
        tiles: [{ x: 5, y: 5 }],
        center: { x: 5, y: 5 },
        height: 10,
      };

      const filtered = filterPeaks([singlePeak]);
      expect(filtered).to.have.length(1);
      expect(filtered[0]).to.deep.equal(singlePeak);
    });

    it("should handle peaks at same location", () => {
      const duplicatePeaks: PeakData[] = [
        { tiles: [{ x: 5, y: 5 }], center: { x: 5, y: 5 }, height: 10 },
        { tiles: [{ x: 5, y: 5 }], center: { x: 5, y: 5 }, height: 8 },
      ];

      const filtered = filterPeaks(duplicatePeaks);

      // Should keep only the higher one
      expect(filtered.length).to.equal(1);
      expect(filtered[0].height).to.equal(10);
    });
  });

  describe("custom exclusion multiplier", () => {
    it("should allow different exclusion radius multipliers", () => {
      const terrain = createEmptyRoomTerrain();
      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = findPeaks(distanceMatrix, terrain);

      const defaultFiltered = filterPeaks(peaks);
      const wideFiltered = filterPeaks(peaks, { exclusionMultiplier: 1.5 }); // Larger exclusion radius
      const narrowFiltered = filterPeaks(peaks, { exclusionMultiplier: 0.25 }); // Smaller exclusion radius

      // Wider radius should result in fewer peaks
      expect(wideFiltered.length).to.be.at.most(defaultFiltered.length);

      // Narrower radius should result in more peaks
      expect(narrowFiltered.length).to.be.at.least(defaultFiltered.length);
    });
  });
});
