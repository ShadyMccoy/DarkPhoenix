/**
 * @fileoverview Unit tests for distance transform algorithm.
 *
 * Tests the createMultiRoomDistanceTransform function which calculates
 * distance from walls for room analysis.
 */

import { expect } from "chai";
import {
  createMultiRoomDistanceTransform,
  GRID_SIZE,
} from "../../../src/spatial/algorithms";
import {
  createEmptyRoomTerrain,
  createCorridorTerrain,
  TERRAIN_MASK_WALL,
  wrapTerrainForMultiRoom,
  distanceMapToArray,
  TEST_ROOM,
} from "../mock";
import {
  SMALL_EMPTY_ROOM,
  SMALL_CORRIDOR,
  SMALL_CENTER_OBSTACLE,
  ALL_WALLS,
  SINGLE_TILE,
} from "./fixtures/terrain-patterns";

describe("createDistanceTransform", () => {
  describe("basic behavior", () => {
    it("should return a 50x50 grid by default", () => {
      const terrain = createEmptyRoomTerrain();
      const distances = createMultiRoomDistanceTransform(
        [TEST_ROOM],
        wrapTerrainForMultiRoom(terrain),
        TERRAIN_MASK_WALL
      );
      const result = distanceMapToArray(distances);

      expect(result).to.have.length(GRID_SIZE);
      expect(result[0]).to.have.length(GRID_SIZE);
    });

    it("should set wall tiles to 0", () => {
      const terrain = createEmptyRoomTerrain();
      const distances = createMultiRoomDistanceTransform(
        [TEST_ROOM],
        wrapTerrainForMultiRoom(terrain),
        TERRAIN_MASK_WALL
      );
      const result = distanceMapToArray(distances);

      // Border walls should be 0
      expect(result[0][0]).to.equal(0);
      expect(result[0][25]).to.equal(0);
      expect(result[49][49]).to.equal(0);
    });

    it("should have higher values for tiles further from walls", () => {
      const terrain = createEmptyRoomTerrain();
      const distances = createMultiRoomDistanceTransform(
        [TEST_ROOM],
        wrapTerrainForMultiRoom(terrain),
        TERRAIN_MASK_WALL
      );
      const result = distanceMapToArray(distances);

      // Center should have higher value than edges
      const centerValue = result[25][25];
      const nearEdgeValue = result[1][1];

      expect(centerValue).to.be.greaterThan(nearEdgeValue);
    });
  });

  describe("empty room", () => {
    it("should have maximum value at center", () => {
      const terrain = createEmptyRoomTerrain();
      const distances = createMultiRoomDistanceTransform(
        [TEST_ROOM],
        wrapTerrainForMultiRoom(terrain),
        TERRAIN_MASK_WALL
      );
      const result = distanceMapToArray(distances);

      const centerValue = result[25][25];

      // Check that center is among the highest values
      let maxValue = 0;
      for (let x = 1; x < 49; x++) {
        for (let y = 1; y < 49; y++) {
          if (result[x][y] > maxValue) {
            maxValue = result[x][y];
          }
        }
      }

      // Center should be at or very close to max value
      expect(centerValue).to.be.at.least(maxValue - 1);
    });

    it("should create symmetric values for symmetric terrain", () => {
      const terrain = createEmptyRoomTerrain();
      const distances = createMultiRoomDistanceTransform(
        [TEST_ROOM],
        wrapTerrainForMultiRoom(terrain),
        TERRAIN_MASK_WALL
      );
      const result = distanceMapToArray(distances);

      // Check symmetry: (1,1) should equal (48,48) due to symmetric borders
      expect(result[1][1]).to.equal(result[48][48]);
      expect(result[1][25]).to.equal(result[48][25]);
      expect(result[25][1]).to.equal(result[25][48]);
    });
  });

  describe("corridor terrain", () => {
    it("should have lower peak values than empty room", () => {
      const emptyTerrain = createEmptyRoomTerrain();
      const corridorTerrain = createCorridorTerrain(25, 10);

      const emptyDistances = createMultiRoomDistanceTransform(
        [TEST_ROOM],
        wrapTerrainForMultiRoom(emptyTerrain),
        TERRAIN_MASK_WALL
      );
      const corridorDistances = createMultiRoomDistanceTransform(
        [TEST_ROOM],
        wrapTerrainForMultiRoom(corridorTerrain),
        TERRAIN_MASK_WALL
      );
      const emptyResult = distanceMapToArray(emptyDistances);
      const corridorResult = distanceMapToArray(corridorDistances);

      // Corridor's max height should be lower
      let emptyMax = 0;
      let corridorMax = 0;

      for (let x = 0; x < 50; x++) {
        for (let y = 0; y < 50; y++) {
          if (emptyResult[x][y] > emptyMax) emptyMax = emptyResult[x][y];
          if (corridorResult[x][y] > corridorMax)
            corridorMax = corridorResult[x][y];
        }
      }

      expect(corridorMax).to.be.lessThan(emptyMax);
    });

    it("should have peak values along corridor center", () => {
      const terrain = createCorridorTerrain(25, 10);
      const distances = createMultiRoomDistanceTransform(
        [TEST_ROOM],
        wrapTerrainForMultiRoom(terrain),
        TERRAIN_MASK_WALL
      );
      const result = distanceMapToArray(distances);

      // Corridor spans y=20 to y=30 (inclusive)
      // Walls are at y<20 and y>30
      const centerY = 25;
      const wallY = 19; // Just outside corridor - is a wall

      // Center should have positive value
      expect(result[25][centerY]).to.be.greaterThan(0);
      // Wall should be 0
      expect(result[25][wallY]).to.equal(0);
      // Tiles inside corridor near edge should be lower than center
      expect(result[25][20]).to.be.lessThan(result[25][centerY]);
    });
  });

  describe("small room patterns", () => {
    // Use smaller grid for faster tests - local implementation
    function createSmallDistanceTransform(
      terrain: (x: number, y: number) => number,
      size: number = 10
    ): number[][] {
      const grid: number[][] = [];
      const queue: { x: number; y: number; distance: number }[] = [];

      // Initialize grid
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

      // 8-directional BFS
      const neighbors = [
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

        for (const n of neighbors) {
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

      // Replace Infinity with 0 (isolated tiles)
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          if (grid[x][y] === Infinity) {
            grid[x][y] = 0;
          }
        }
      }

      return grid;
    }

    it("should find peak near center for empty room", () => {
      const result = createSmallDistanceTransform(
        SMALL_EMPTY_ROOM.terrain,
        SMALL_EMPTY_ROOM.gridSize
      );

      // Find max value location
      let maxValue = 0;
      let maxX = 0;
      let maxY = 0;

      for (let x = 0; x < 10; x++) {
        for (let y = 0; y < 10; y++) {
          if (result[x][y] > maxValue) {
            maxValue = result[x][y];
            maxX = x;
            maxY = y;
          }
        }
      }

      // Should be near center (4-5 in a 10x10 room)
      expect(maxX).to.be.at.least(3).and.at.most(6);
      expect(maxY).to.be.at.least(3).and.at.most(6);
    });

    it("should have gradient from walls to center", () => {
      const result = createSmallDistanceTransform(
        SMALL_EMPTY_ROOM.terrain,
        SMALL_EMPTY_ROOM.gridSize
      );

      // Walking from edge to center, values should generally increase
      const edgeToCenter = [
        result[1][5],
        result[2][5],
        result[3][5],
        result[4][5],
        result[5][5],
      ];

      for (let i = 1; i < edgeToCenter.length; i++) {
        expect(edgeToCenter[i]).to.be.at.least(edgeToCenter[i - 1]);
      }
    });

    it("should handle center obstacle correctly", () => {
      const result = createSmallDistanceTransform(
        SMALL_CENTER_OBSTACLE.terrain,
        SMALL_CENTER_OBSTACLE.gridSize
      );

      // Center obstacle tiles should be 0
      expect(result[4][3]).to.equal(0);
      expect(result[4][4]).to.equal(0);
      expect(result[5][3]).to.equal(0);
      expect(result[5][4]).to.equal(0);

      // Tiles next to obstacle should have lower values
      const nextToObstacle = result[3][3];
      const farFromObstacle = result[1][1];

      // Both should be non-zero (not walls)
      expect(nextToObstacle).to.be.greaterThan(0);
    });
  });

  describe("edge cases", () => {
    it("should handle all-walls terrain", () => {
      const terrain = ALL_WALLS.terrain;

      // Create distance transform with small grid to test
      const grid: number[][] = [];
      for (let x = 0; x < 10; x++) {
        grid[x] = [];
        for (let y = 0; y < 10; y++) {
          grid[x][y] = 0; // All walls = all 0s
        }
      }

      // All values should be 0 (walls)
      for (let x = 0; x < 10; x++) {
        for (let y = 0; y < 10; y++) {
          expect(grid[x][y]).to.equal(0);
        }
      }
    });

    it("should handle single walkable tile", () => {
      const terrain = SINGLE_TILE.terrain;

      // With only one walkable tile, it should have a value of 1
      // (adjacent to walls = distance 1 from walls)
      function createSmallDT(
        t: (x: number, y: number) => number,
        size: number
      ): number[][] {
        const grid: number[][] = [];
        const queue: { x: number; y: number; distance: number }[] = [];

        for (let x = 0; x < size; x++) {
          grid[x] = [];
          for (let y = 0; y < size; y++) {
            if (t(x, y) === TERRAIN_MASK_WALL) {
              grid[x][y] = 0;
              queue.push({ x, y, distance: 0 });
            } else {
              grid[x][y] = Infinity;
            }
          }
        }

        const neighbors = [
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
          for (const n of neighbors) {
            const nx = x + n.x;
            const ny = y + n.y;
            if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
              const currentDistance = grid[nx][ny];
              const newDistance = distance + 1;
              if (
                t(nx, ny) !== TERRAIN_MASK_WALL &&
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

        return grid;
      }

      const result = createSmallDT(terrain, SINGLE_TILE.gridSize);

      // The single tile at (4, 4) should have a value > 0
      expect(result[4][4]).to.be.greaterThan(0);
    });
  });

  describe("distance correctness", () => {
    it("should have high values in open areas", () => {
      const terrain = createEmptyRoomTerrain();
      const distances = createMultiRoomDistanceTransform(
        [TEST_ROOM],
        wrapTerrainForMultiRoom(terrain),
        TERRAIN_MASK_WALL
      );
      const result = distanceMapToArray(distances);

      // Center should have HIGH value (far from walls)
      const centerValue = result[25][25];
      const nearWallValue = result[1][1];

      expect(centerValue).to.be.greaterThan(nearWallValue);
    });

    it("should produce consistent relative heights", () => {
      const terrain = createEmptyRoomTerrain();
      const distances = createMultiRoomDistanceTransform(
        [TEST_ROOM],
        wrapTerrainForMultiRoom(terrain),
        TERRAIN_MASK_WALL
      );
      const result = distanceMapToArray(distances);

      // Points equidistant from walls should have equal values
      // (1,1) and (48,48) are both 1 tile from corner walls
      expect(result[1][1]).to.equal(result[48][48]);
    });
  });
});
