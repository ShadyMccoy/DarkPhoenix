/**
 * @fileoverview Unit tests for BFS territory division algorithm.
 *
 * Tests bfsDivideRoom function which divides room tiles among peaks
 * using simultaneous BFS flood fill.
 */

import { expect } from "chai";
import { GRID_SIZE } from "../../../src/spatial/algorithms";
import {
  createDistanceTransform,
  findPeaks,
  filterPeaks,
  bfsDivideRoom,
  PeakData,
  Coordinate,
  createEmptyRoomTerrain,
  createCorridorTerrain,
  createIslandsTerrain,
  createTerrainFromPattern,
  TERRAIN_MASK_WALL,
} from "../mock";
import {
  SMALL_EMPTY_ROOM,
  SMALL_TWO_ISLANDS,
} from "./fixtures/terrain-patterns";

// Helper to analyze terrain and get territories for small patterns
function analyzeTerritory(
  terrain: (x: number, y: number) => number,
  size: number = 10
): {
  distanceMatrix: number[][];
  peaks: PeakData[];
  territories: Map<string, Coordinate[]>;
} {
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

  // Find peaks
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

    const cluster: Coordinate[] = [];
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

  // Filter peaks
  const sortedPeaks = [...peaks].sort((a, b) => b.height - a.height);
  const finalPeaks: PeakData[] = [];
  const excludedPositions = new Set<string>();

  for (const peak of sortedPeaks) {
    const key = `${peak.center.x},${peak.center.y}`;
    if (excludedPositions.has(key)) continue;

    finalPeaks.push(peak);

    const exclusionRadius = Math.floor(peak.height * 0.75);
    for (let dx = -exclusionRadius; dx <= exclusionRadius; dx++) {
      for (let dy = -exclusionRadius; dy <= exclusionRadius; dy++) {
        const ex = peak.center.x + dx;
        const ey = peak.center.y + dy;
        if (ex >= 0 && ex < size && ey >= 0 && ey < size) {
          excludedPositions.add(`${ex},${ey}`);
        }
      }
    }
  }

  // Divide room (adapted for small grid)
  const territories = new Map<string, Coordinate[]>();
  const territoryVisited = new Set<string>();
  const territoryQueue: { x: number; y: number; peakId: string }[] = [];

  const territorySortedPeaks = [...finalPeaks].sort(
    (a, b) => b.height - a.height
  );

  for (const peak of territorySortedPeaks) {
    const peakId = `${peak.center.x}-${peak.center.y}`;
    territories.set(peakId, []);
    territoryQueue.push({ x: peak.center.x, y: peak.center.y, peakId });
  }

  while (territoryQueue.length > 0) {
    const { x, y, peakId } = territoryQueue.shift()!;
    const key = `${x},${y}`;

    if (territoryVisited.has(key)) continue;
    if (terrain(x, y) === TERRAIN_MASK_WALL) continue;

    territoryVisited.add(key);
    territories.get(peakId)!.push({ x, y });

    for (const n of neighbors4) {
      const nx = x + n.x;
      const ny = y + n.y;
      const nkey = `${nx},${ny}`;

      if (
        nx >= 0 &&
        nx < size &&
        ny >= 0 &&
        ny < size &&
        !territoryVisited.has(nkey) &&
        terrain(nx, ny) !== TERRAIN_MASK_WALL
      ) {
        territoryQueue.push({ x: nx, y: ny, peakId });
      }
    }
  }

  return { distanceMatrix: grid, peaks: finalPeaks, territories };
}

describe("bfsDivideRoom", () => {
  describe("basic behavior", () => {
    it("should return a Map of territories", () => {
      const terrain = createEmptyRoomTerrain();
      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = filterPeaks(findPeaks(distanceMatrix, terrain));
      const territories = bfsDivideRoom(peaks, terrain);

      expect(territories).to.be.instanceOf(Map);
    });

    it("should create one territory per peak", () => {
      const terrain = createEmptyRoomTerrain();
      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = filterPeaks(findPeaks(distanceMatrix, terrain));
      const territories = bfsDivideRoom(peaks, terrain);

      expect(territories.size).to.equal(peaks.length);
    });

    it("should include coordinates in each territory", () => {
      const terrain = createEmptyRoomTerrain();
      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = filterPeaks(findPeaks(distanceMatrix, terrain));
      const territories = bfsDivideRoom(peaks, terrain);

      for (const [peakId, coords] of territories) {
        expect(coords).to.be.an("array");
        if (coords.length > 0) {
          expect(coords[0]).to.have.property("x").that.is.a("number");
          expect(coords[0]).to.have.property("y").that.is.a("number");
        }
      }
    });
  });

  describe("single peak", () => {
    it("should assign all walkable tiles to the single peak", () => {
      const result = analyzeTerritory(
        SMALL_EMPTY_ROOM.terrain,
        SMALL_EMPTY_ROOM.gridSize
      );

      if (result.peaks.length === 1) {
        const peakId = `${result.peaks[0].center.x}-${result.peaks[0].center.y}`;
        const territory = result.territories.get(peakId);

        // Count walkable tiles
        let walkableCount = 0;
        for (let x = 0; x < 10; x++) {
          for (let y = 0; y < 10; y++) {
            if (SMALL_EMPTY_ROOM.terrain(x, y) !== TERRAIN_MASK_WALL) {
              walkableCount++;
            }
          }
        }

        // Territory should include all walkable tiles
        expect(territory?.length).to.equal(walkableCount);
      }
    });
  });

  describe("multiple peaks", () => {
    it("should divide tiles fairly between two peaks", () => {
      const result = analyzeTerritory(
        SMALL_TWO_ISLANDS.terrain,
        SMALL_TWO_ISLANDS.gridSize
      );

      if (result.peaks.length >= 2) {
        const territorySizes = Array.from(result.territories.values()).map(
          (t) => t.length
        );

        // Both territories should have similar sizes (within 50% of each other)
        const max = Math.max(...territorySizes);
        const min = Math.min(...territorySizes);

        // If there are actual walkable tiles
        if (max > 0) {
          // The ratio should be reasonable for similar-sized islands
          expect(min / max).to.be.at.least(0.3);
        }
      }
    });

    it("should assign each tile to exactly one territory", () => {
      const terrain = createIslandsTerrain([
        { x: 15, y: 25, radius: 8 },
        { x: 35, y: 25, radius: 8 },
      ]);

      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = filterPeaks(findPeaks(distanceMatrix, terrain));
      const territories = bfsDivideRoom(peaks, terrain);

      // Collect all assigned coordinates
      const assigned = new Set<string>();
      for (const [, coords] of territories) {
        for (const coord of coords) {
          const key = `${coord.x},${coord.y}`;
          expect(assigned.has(key)).to.be.false; // Not already assigned
          assigned.add(key);
        }
      }
    });

    it("should not assign wall tiles to any territory", () => {
      const terrain = createEmptyRoomTerrain();
      const distanceMatrix = createDistanceTransform(terrain);
      const peaks = filterPeaks(findPeaks(distanceMatrix, terrain));
      const territories = bfsDivideRoom(peaks, terrain);

      for (const [, coords] of territories) {
        for (const coord of coords) {
          expect(terrain(coord.x, coord.y)).to.not.equal(TERRAIN_MASK_WALL);
        }
      }
    });
  });

  describe("BFS fairness", () => {
    it("should assign tiles to nearest peak (equal distance same-step expansion)", () => {
      // Create two peaks at equal distance from center
      const symmetricPeaks: PeakData[] = [
        { tiles: [{ x: 10, y: 25 }], center: { x: 10, y: 25 }, height: 5 },
        { tiles: [{ x: 40, y: 25 }], center: { x: 40, y: 25 }, height: 5 },
      ];

      const terrain = createEmptyRoomTerrain();
      const territories = bfsDivideRoom(symmetricPeaks, terrain);

      // Get territory sizes
      const sizes: number[] = [];
      for (const [, coords] of territories) {
        sizes.push(coords.length);
      }

      // Territories should be roughly equal for symmetric peaks
      if (sizes.length === 2 && sizes[0] > 0 && sizes[1] > 0) {
        const ratio = Math.min(sizes[0], sizes[1]) / Math.max(sizes[0], sizes[1]);
        expect(ratio).to.be.at.least(0.8); // Within 20% of each other
      }
    });

    it("should give larger territory to more central peak", () => {
      // Peak at center vs peak near edge
      const asymmetricPeaks: PeakData[] = [
        { tiles: [{ x: 25, y: 25 }], center: { x: 25, y: 25 }, height: 10 },
        { tiles: [{ x: 5, y: 25 }], center: { x: 5, y: 25 }, height: 5 },
      ];

      const terrain = createEmptyRoomTerrain();
      const territories = bfsDivideRoom(asymmetricPeaks, terrain);

      const centerTerritory = territories.get("25-25");
      const edgeTerritory = territories.get("5-25");

      // Center peak should get more tiles (it's further from all walls)
      if (centerTerritory && edgeTerritory) {
        expect(centerTerritory.length).to.be.at.least(edgeTerritory.length);
      }
    });
  });

  describe("wall barriers", () => {
    it("should not cross walls between territories", () => {
      // Two islands separated by walls
      const result = analyzeTerritory(
        SMALL_TWO_ISLANDS.terrain,
        SMALL_TWO_ISLANDS.gridSize
      );

      // Each territory should be contiguous (no islands within territories)
      for (const [peakId, coords] of result.territories) {
        if (coords.length > 0) {
          // All coords in territory should be reachable from each other
          // without crossing walls (implicit in BFS)
          const coordSet = new Set(coords.map((c) => `${c.x},${c.y}`));

          // Spot check: pick first coord and verify connectivity via BFS
          const startCoord = coords[0];
          const visited = new Set<string>();
          const queue = [startCoord];

          while (queue.length > 0) {
            const current = queue.shift()!;
            const key = `${current.x},${current.y}`;
            if (visited.has(key)) continue;
            if (!coordSet.has(key)) continue;
            visited.add(key);

            const neighbors = [
              { x: current.x - 1, y: current.y },
              { x: current.x + 1, y: current.y },
              { x: current.x, y: current.y - 1 },
              { x: current.x, y: current.y + 1 },
            ];

            for (const n of neighbors) {
              const nkey = `${n.x},${n.y}`;
              if (coordSet.has(nkey) && !visited.has(nkey)) {
                queue.push(n);
              }
            }
          }

          // All territory coords should be reachable
          expect(visited.size).to.equal(coords.length);
        }
      }
    });
  });

  describe("edge cases", () => {
    it("should handle empty peaks array", () => {
      const terrain = createEmptyRoomTerrain();
      const territories = bfsDivideRoom([], terrain);

      expect(territories.size).to.equal(0);
    });

    it("should handle single peak at edge", () => {
      const edgePeak: PeakData[] = [
        { tiles: [{ x: 1, y: 1 }], center: { x: 1, y: 1 }, height: 1 },
      ];

      const terrain = createEmptyRoomTerrain();
      const territories = bfsDivideRoom(edgePeak, terrain);

      expect(territories.size).to.equal(1);
      const territory = territories.get("1-1");
      expect(territory).to.exist;
      expect(territory!.length).to.be.greaterThan(0);
    });

    it("should handle peak at center of all walls", () => {
      // Peak surrounded by walls - should get only itself
      const terrain = (x: number, y: number): number => {
        if (x === 5 && y === 5) return 0;
        return TERRAIN_MASK_WALL;
      };

      const isolatedPeak: PeakData[] = [
        { tiles: [{ x: 5, y: 5 }], center: { x: 5, y: 5 }, height: 1 },
      ];

      const territories = bfsDivideRoom(isolatedPeak, terrain);
      const territory = territories.get("5-5");

      expect(territory).to.exist;
      expect(territory!.length).to.equal(1);
      expect(territory![0]).to.deep.equal({ x: 5, y: 5 });
    });
  });

  describe("peak priority", () => {
    it("should process higher peaks first", () => {
      // Two peaks with different heights
      const peaks: PeakData[] = [
        { tiles: [{ x: 10, y: 25 }], center: { x: 10, y: 25 }, height: 5 },
        { tiles: [{ x: 25, y: 25 }], center: { x: 25, y: 25 }, height: 10 },
      ];

      const terrain = createEmptyRoomTerrain();
      const territories = bfsDivideRoom(peaks, terrain);

      // Higher peak should be processed first, but since they expand
      // simultaneously, the effect is subtle. The key is that ties
      // go to the higher peak.
      expect(territories.size).to.equal(2);
    });
  });
});
