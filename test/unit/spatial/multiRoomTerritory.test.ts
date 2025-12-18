/**
 * @fileoverview Unit tests for multi-room BFS territory division.
 *
 * Tests bfsDivideMultiRoom and related functions that handle
 * territory assignment across room boundaries.
 *
 * BUG UNDER INVESTIGATION:
 * Territories can grow excessively large (spanning 3-4 rooms) when a peak
 * is near a room corner and there are no competing peaks in adjacent rooms.
 * The BFS floods into adjacent rooms uncontested.
 */

import { expect } from "chai";
import {
  bfsDivideMultiRoom,
  getAdjacentRoomPosition,
  createMultiRoomDistanceTransform,
  findMultiRoomPeaks,
  filterMultiRoomPeaks,
  WorldPeakData,
  WorldCoordinate,
  MultiRoomTerrainCallback,
  GRID_SIZE,
} from "../../../src/spatial/algorithms";
import { TERRAIN_MASK_WALL } from "../mock";
import {
  E75N8_TERRAIN,
  E74N8_TERRAIN,
  countWalkableTiles,
} from "./fixtures/real-room-terrain";

// ============================================================================
// Multi-Room Terrain Helpers
// ============================================================================

/**
 * Creates a multi-room terrain callback from a map of room terrains.
 * Each room terrain is a function (x, y) => terrainMask.
 */
function createMultiRoomTerrain(
  roomTerrains: Map<string, (x: number, y: number) => number>,
  defaultTerrain: (x: number, y: number) => number = () => TERRAIN_MASK_WALL
): MultiRoomTerrainCallback {
  return (roomName: string, x: number, y: number): number => {
    const terrain = roomTerrains.get(roomName);
    if (terrain) {
      return terrain(x, y);
    }
    return defaultTerrain(x, y);
  };
}

/**
 * Creates a terrain callback from a string pattern.
 * 'X' = wall, '.' = plain, 'E' = exit (plain at edge)
 */
function terrainFromPattern(pattern: string[]): (x: number, y: number) => number {
  return (x: number, y: number): number => {
    if (y < 0 || y >= pattern.length) return TERRAIN_MASK_WALL;
    if (x < 0 || x >= pattern[y].length) return TERRAIN_MASK_WALL;
    const char = pattern[y][x];
    return char === 'X' ? TERRAIN_MASK_WALL : 0;
  };
}

/**
 * Creates an empty 50x50 room terrain with border walls and optional exits.
 */
function createEmptyRoomWithExits(exits: {
  top?: boolean;
  bottom?: boolean;
  left?: boolean;
  right?: boolean;
} = {}): (x: number, y: number) => number {
  return (x: number, y: number): number => {
    // Room edges
    if (y === 0) {
      // Top edge - exit if specified and in middle area
      if (exits.top && x >= 20 && x <= 30) return 0;
      return TERRAIN_MASK_WALL;
    }
    if (y === 49) {
      // Bottom edge
      if (exits.bottom && x >= 20 && x <= 30) return 0;
      return TERRAIN_MASK_WALL;
    }
    if (x === 0) {
      // Left edge
      if (exits.left && y >= 20 && y <= 30) return 0;
      return TERRAIN_MASK_WALL;
    }
    if (x === 49) {
      // Right edge
      if (exits.right && y >= 20 && y <= 30) return 0;
      return TERRAIN_MASK_WALL;
    }
    return 0; // Plain interior
  };
}

/**
 * Counts how many rooms a territory spans.
 */
function countRoomsInTerritory(territory: WorldCoordinate[]): Set<string> {
  const rooms = new Set<string>();
  for (const coord of territory) {
    rooms.add(coord.roomName);
  }
  return rooms;
}

/**
 * Gets total tile count across all territories.
 */
function getTotalTerritorySize(territories: Map<string, WorldCoordinate[]>): number {
  let total = 0;
  for (const [, coords] of territories) {
    total += coords.length;
  }
  return total;
}

// ============================================================================
// Tests for getAdjacentRoomPosition
// ============================================================================

describe("getAdjacentRoomPosition", () => {
  describe("basic room transitions", () => {
    it("should return west room when exiting left (x=0)", () => {
      const result = getAdjacentRoomPosition("E75N8", 0, 25);
      expect(result).to.not.be.null;
      expect(result!.roomName).to.equal("E74N8");
      expect(result!.x).to.equal(49);
      expect(result!.y).to.equal(25);
    });

    it("should return east room when exiting right (x=49)", () => {
      const result = getAdjacentRoomPosition("E75N8", 49, 25);
      expect(result).to.not.be.null;
      expect(result!.roomName).to.equal("E76N8");
      expect(result!.x).to.equal(0);
      expect(result!.y).to.equal(25);
    });

    it("should return north room when exiting top (y=0)", () => {
      const result = getAdjacentRoomPosition("E75N8", 25, 0);
      expect(result).to.not.be.null;
      expect(result!.roomName).to.equal("E75N9");
      expect(result!.x).to.equal(25);
      expect(result!.y).to.equal(49);
    });

    it("should return south room when exiting bottom (y=49)", () => {
      const result = getAdjacentRoomPosition("E75N8", 25, 49);
      expect(result).to.not.be.null;
      expect(result!.roomName).to.equal("E75N7");
      expect(result!.x).to.equal(25);
      expect(result!.y).to.equal(0);
    });

    it("should return null for non-exit positions", () => {
      const result = getAdjacentRoomPosition("E75N8", 25, 25);
      expect(result).to.be.null;
    });
  });

  describe("E/W boundary crossing", () => {
    it("should handle E0 to W0 transition", () => {
      const result = getAdjacentRoomPosition("E0N5", 0, 25);
      expect(result).to.not.be.null;
      expect(result!.roomName).to.equal("W0N5");
      expect(result!.x).to.equal(49);
    });

    it("should handle W0 to E0 transition", () => {
      const result = getAdjacentRoomPosition("W0N5", 49, 25);
      expect(result).to.not.be.null;
      expect(result!.roomName).to.equal("E0N5");
      expect(result!.x).to.equal(0);
    });
  });

  describe("N/S boundary crossing", () => {
    it("should handle N0 to S0 transition", () => {
      const result = getAdjacentRoomPosition("E5N0", 25, 49);
      expect(result).to.not.be.null;
      expect(result!.roomName).to.equal("E5S0");
      expect(result!.y).to.equal(0);
    });

    it("should handle S0 to N0 transition", () => {
      const result = getAdjacentRoomPosition("E5S0", 25, 0);
      expect(result).to.not.be.null;
      expect(result!.roomName).to.equal("E5N0");
      expect(result!.y).to.equal(49);
    });
  });

  describe("corner positions", () => {
    it("should handle corner exit (0,0) - goes to diagonal room", () => {
      // At corner (0,0), the function handles BOTH x=0 and y=0
      const result = getAdjacentRoomPosition("E75N8", 0, 0);
      expect(result).to.not.be.null;
      // Should transition to northwest diagonal room
      expect(result!.roomName).to.equal("E74N9");
      expect(result!.x).to.equal(49);
      expect(result!.y).to.equal(49);
    });
  });
});

// ============================================================================
// Tests for bfsDivideMultiRoom
// ============================================================================

describe("bfsDivideMultiRoom", () => {
  describe("single room behavior", () => {
    it("should work like single-room BFS when peaks are in one room", () => {
      const roomTerrains = new Map<string, (x: number, y: number) => number>();
      roomTerrains.set("E75N8", createEmptyRoomWithExits());

      const terrainCallback = createMultiRoomTerrain(roomTerrains);

      const peaks: WorldPeakData[] = [
        {
          tiles: [{ x: 25, y: 25, roomName: "E75N8" }],
          center: { x: 25, y: 25, roomName: "E75N8" },
          height: 10,
        },
      ];

      const territories = bfsDivideMultiRoom(peaks, terrainCallback, TERRAIN_MASK_WALL, 1);

      expect(territories.size).to.equal(1);
      const territory = territories.get("E75N8-25-25");
      expect(territory).to.exist;
      // Should claim interior tiles (not walls)
      expect(territory!.length).to.be.greaterThan(0);
    });

    it("should divide room between two peaks", () => {
      const roomTerrains = new Map<string, (x: number, y: number) => number>();
      roomTerrains.set("E75N8", createEmptyRoomWithExits());

      const terrainCallback = createMultiRoomTerrain(roomTerrains);

      const peaks: WorldPeakData[] = [
        {
          tiles: [{ x: 15, y: 25, roomName: "E75N8" }],
          center: { x: 15, y: 25, roomName: "E75N8" },
          height: 8,
        },
        {
          tiles: [{ x: 35, y: 25, roomName: "E75N8" }],
          center: { x: 35, y: 25, roomName: "E75N8" },
          height: 8,
        },
      ];

      const territories = bfsDivideMultiRoom(peaks, terrainCallback, TERRAIN_MASK_WALL, 1);

      expect(territories.size).to.equal(2);

      // Both territories should be roughly equal
      const sizes = Array.from(territories.values()).map(t => t.length);
      const ratio = Math.min(...sizes) / Math.max(...sizes);
      expect(ratio).to.be.at.least(0.7); // Within 30% of each other
    });
  });

  describe("multi-room expansion", () => {
    it("should expand into adjacent rooms that have peaks", () => {
      const roomTerrains = new Map<string, (x: number, y: number) => number>();
      // Two rooms connected by exits on their shared edge
      roomTerrains.set("E75N8", createEmptyRoomWithExits({ right: true }));
      roomTerrains.set("E76N8", createEmptyRoomWithExits({ left: true }));

      const terrainCallback = createMultiRoomTerrain(roomTerrains);

      // Peaks in BOTH rooms - expansion is allowed between rooms with peaks
      const peaks: WorldPeakData[] = [
        {
          tiles: [{ x: 25, y: 25, roomName: "E75N8" }],
          center: { x: 25, y: 25, roomName: "E75N8" },
          height: 10,
        },
        {
          tiles: [{ x: 25, y: 25, roomName: "E76N8" }],
          center: { x: 25, y: 25, roomName: "E76N8" },
          height: 10,
        },
      ];

      const territories = bfsDivideMultiRoom(peaks, terrainCallback, TERRAIN_MASK_WALL, 2);

      const t1 = territories.get("E75N8-25-25");
      const t2 = territories.get("E76N8-25-25");
      expect(t1).to.exist;
      expect(t2).to.exist;

      // Both peaks should claim territory - they compete at the boundary
      expect(t1!.length).to.be.greaterThan(0);
      expect(t2!.length).to.be.greaterThan(0);
    });

    it("should NOT expand into adjacent rooms without peaks", () => {
      const roomTerrains = new Map<string, (x: number, y: number) => number>();
      // Two rooms connected by exits on their shared edge
      roomTerrains.set("E75N8", createEmptyRoomWithExits({ right: true }));
      roomTerrains.set("E76N8", createEmptyRoomWithExits({ left: true }));

      const terrainCallback = createMultiRoomTerrain(roomTerrains);

      // Only ONE peak - no expansion into E76N8 allowed
      const peaks: WorldPeakData[] = [
        {
          tiles: [{ x: 25, y: 25, roomName: "E75N8" }],
          center: { x: 25, y: 25, roomName: "E75N8" },
          height: 10,
        },
      ];

      const territories = bfsDivideMultiRoom(peaks, terrainCallback, TERRAIN_MASK_WALL, 2);

      const territory = territories.get("E75N8-25-25");
      expect(territory).to.exist;

      const roomsSpanned = countRoomsInTerritory(territory!);
      // Territory should stay in E75N8 only - no flooding into E76N8
      expect(roomsSpanned.size).to.equal(1);
      expect(roomsSpanned.has("E75N8")).to.be.true;
      expect(roomsSpanned.has("E76N8")).to.be.false;
    });
  });

  describe("BUG: uncontested expansion into adjacent rooms", () => {
    it("should NOT allow a single peak to claim entire adjacent rooms", () => {
      // This test demonstrates the bug where a peak near a room edge
      // floods into adjacent rooms that have no competing peaks
      const roomTerrains = new Map<string, (x: number, y: number) => number>();

      // Main room with peak near the right edge
      roomTerrains.set("E75N8", createEmptyRoomWithExits({ right: true }));
      // Adjacent room with no peaks - currently gets entirely claimed
      roomTerrains.set("E76N8", createEmptyRoomWithExits({ left: true }));

      const terrainCallback = createMultiRoomTerrain(roomTerrains);

      const peaks: WorldPeakData[] = [
        {
          tiles: [{ x: 45, y: 25, roomName: "E75N8" }],
          center: { x: 45, y: 25, roomName: "E75N8" },
          height: 5,
        },
      ];

      const territories = bfsDivideMultiRoom(peaks, terrainCallback, TERRAIN_MASK_WALL, 2);
      const territory = territories.get("E75N8-45-25");

      // Count tiles in each room
      const tilesPerRoom = new Map<string, number>();
      for (const coord of territory!) {
        tilesPerRoom.set(coord.roomName, (tilesPerRoom.get(coord.roomName) || 0) + 1);
      }

      const tilesInE75N8 = tilesPerRoom.get("E75N8") || 0;
      const tilesInE76N8 = tilesPerRoom.get("E76N8") || 0;

      console.log(`Peak at E75N8 (45,25) claimed:`);
      console.log(`  E75N8: ${tilesInE75N8} tiles`);
      console.log(`  E76N8: ${tilesInE76N8} tiles`);

      // BUG: Currently the peak claims ALL of E76N8 because there's no competition
      // This test documents the current (buggy) behavior
      // TODO: Fix the algorithm to limit cross-room expansion

      // The adjacent room E76N8 has ~2300 walkable tiles (48x48 interior)
      // A peak that's 45 tiles from the exit shouldn't claim all of them
      // We expect the territory in E76N8 to be bounded somehow

      // For now, just document that this is happening:
      if (tilesInE76N8 > 1000) {
        console.log("  BUG CONFIRMED: Peak is claiming excessive territory in adjacent room");
      }
    });

    it("BUG: corner peak spans 4 rooms", () => {
      // Recreate the E74N10-8-2 bug where a corner peak spans 4 rooms
      const roomTerrains = new Map<string, (x: number, y: number) => number>();

      // Create 4 connected rooms in a 2x2 grid
      // E74N10 is bottom-right, peak at (8, 2) is near top-left corner
      roomTerrains.set("E74N10", createEmptyRoomWithExits({ top: true, left: true }));
      roomTerrains.set("E74N11", createEmptyRoomWithExits({ bottom: true, left: true })); // North
      roomTerrains.set("E73N10", createEmptyRoomWithExits({ top: true, right: true })); // West
      roomTerrains.set("E73N11", createEmptyRoomWithExits({ bottom: true, right: true })); // Northwest

      const terrainCallback = createMultiRoomTerrain(roomTerrains);

      const peaks: WorldPeakData[] = [
        {
          tiles: [{ x: 8, y: 2, roomName: "E74N10" }],
          center: { x: 8, y: 2, roomName: "E74N10" },
          height: 7,
        },
      ];

      const territories = bfsDivideMultiRoom(peaks, terrainCallback, TERRAIN_MASK_WALL, 9);
      const territory = territories.get("E74N10-8-2");

      const roomsSpanned = countRoomsInTerritory(territory!);

      console.log(`Corner peak at E74N10 (8,2) spans ${roomsSpanned.size} rooms:`);
      for (const room of roomsSpanned) {
        const count = territory!.filter(c => c.roomName === room).length;
        console.log(`  ${room}: ${count} tiles`);
      }

      // BUG: This peak currently spans all 4 rooms
      // A single peak shouldn't own territory in 4 different rooms
      expect(roomsSpanned.size).to.be.at.most(2,
        "A peak near a corner should not span more than 2 rooms");
    });
  });

  describe("competing peaks across rooms", () => {
    it("should divide territory fairly between peaks in different rooms", () => {
      const roomTerrains = new Map<string, (x: number, y: number) => number>();
      roomTerrains.set("E75N8", createEmptyRoomWithExits({ right: true }));
      roomTerrains.set("E76N8", createEmptyRoomWithExits({ left: true }));

      const terrainCallback = createMultiRoomTerrain(roomTerrains);

      // One peak in each room
      const peaks: WorldPeakData[] = [
        {
          tiles: [{ x: 25, y: 25, roomName: "E75N8" }],
          center: { x: 25, y: 25, roomName: "E75N8" },
          height: 10,
        },
        {
          tiles: [{ x: 25, y: 25, roomName: "E76N8" }],
          center: { x: 25, y: 25, roomName: "E76N8" },
          height: 10,
        },
      ];

      const territories = bfsDivideMultiRoom(peaks, terrainCallback, TERRAIN_MASK_WALL, 2);

      // Each peak should primarily claim its own room
      const t1 = territories.get("E75N8-25-25")!;
      const t2 = territories.get("E76N8-25-25")!;

      const t1Rooms = countRoomsInTerritory(t1);
      const t2Rooms = countRoomsInTerritory(t2);

      // Each territory should be mostly in its own room
      const t1InOwnRoom = t1.filter(c => c.roomName === "E75N8").length;
      const t2InOwnRoom = t2.filter(c => c.roomName === "E76N8").length;

      expect(t1InOwnRoom / t1.length).to.be.at.least(0.8);
      expect(t2InOwnRoom / t2.length).to.be.at.least(0.8);
    });
  });
});

// ============================================================================
// Real Room Data Tests
// ============================================================================

describe("Real Room Data Tests", () => {
  describe("terrain data verification", () => {
    it("should have loaded E75N8 terrain correctly", () => {
      // Verify some known wall positions from the pattern
      expect(E75N8_TERRAIN(0, 0)).to.equal(TERRAIN_MASK_WALL);
      expect(E75N8_TERRAIN(49, 49)).to.equal(TERRAIN_MASK_WALL);

      // Count walkable tiles
      const walkable = countWalkableTiles(E75N8_TERRAIN);
      console.log(`E75N8 walkable tiles: ${walkable}`);
      expect(walkable).to.be.greaterThan(1000);
    });

    it("should have loaded E74N8 terrain correctly", () => {
      // Verify some known wall positions from the pattern
      expect(E74N8_TERRAIN(0, 0)).to.equal(TERRAIN_MASK_WALL);
      expect(E74N8_TERRAIN(49, 49)).to.equal(TERRAIN_MASK_WALL);

      // Count walkable tiles
      const walkable = countWalkableTiles(E74N8_TERRAIN);
      console.log(`E74N8 walkable tiles: ${walkable}`);
      expect(walkable).to.be.greaterThan(800);
    });
  });

  describe("E75N8 + E74N8 territory flooding bug", () => {
    it("should demonstrate territory flooding from E75N8 into E74N8", () => {
      const roomTerrains = new Map<string, (x: number, y: number) => number>();
      roomTerrains.set("E75N8", E75N8_TERRAIN);
      roomTerrains.set("E74N8", E74N8_TERRAIN);

      const terrainCallback = createMultiRoomTerrain(roomTerrains);

      // Place a peak near the left edge of E75N8 (where it connects to E74N8)
      // The left edge is at x=0, so a peak near x=5 would be close to the exit
      const peaks: WorldPeakData[] = [
        {
          tiles: [{ x: 10, y: 25, roomName: "E75N8" }],
          center: { x: 10, y: 25, roomName: "E75N8" },
          height: 8,
        },
      ];

      const territories = bfsDivideMultiRoom(peaks, terrainCallback, TERRAIN_MASK_WALL, 2);
      const territory = territories.get("E75N8-10-25");

      expect(territory).to.exist;

      // Count tiles per room
      const tilesInE75N8 = territory!.filter(c => c.roomName === "E75N8").length;
      const tilesInE74N8 = territory!.filter(c => c.roomName === "E74N8").length;

      console.log(`Peak at E75N8 (10,25) with real terrain:`);
      console.log(`  E75N8: ${tilesInE75N8} tiles`);
      console.log(`  E74N8: ${tilesInE74N8} tiles`);
      console.log(`  Total: ${territory!.length} tiles`);

      // The peak should NOT claim all walkable tiles in E74N8
      // This is the bug - it floods the entire adjacent room
      const e74n8WalkableTiles = countWalkableTiles(E74N8_TERRAIN);
      const percentageOfE74N8Claimed = tilesInE74N8 / e74n8WalkableTiles;

      console.log(`  E74N8 has ${e74n8WalkableTiles} walkable tiles`);
      console.log(`  Percentage of E74N8 claimed: ${(percentageOfE74N8Claimed * 100).toFixed(1)}%`);

      if (percentageOfE74N8Claimed > 0.9) {
        console.log("  BUG CONFIRMED: Peak is claiming >90% of adjacent room!");
      }

      // This assertion documents the expected behavior (currently fails due to bug)
      // A peak that's 10 tiles from the room edge shouldn't claim the entire adjacent room
      expect(percentageOfE74N8Claimed).to.be.at.most(0.5,
        "A peak should not claim more than 50% of an adjacent room's walkable tiles");
    });

    it("should properly divide territory with competing peaks in each room", () => {
      const roomTerrains = new Map<string, (x: number, y: number) => number>();
      roomTerrains.set("E75N8", E75N8_TERRAIN);
      roomTerrains.set("E74N8", E74N8_TERRAIN);

      const terrainCallback = createMultiRoomTerrain(roomTerrains);

      // One peak in each room - they should compete for boundary tiles
      // Using positions that are actually open in the terrain:
      // E75N8: (10, 25) is plain, E74N8: (35, 25) is plain
      const peaks: WorldPeakData[] = [
        {
          tiles: [{ x: 10, y: 25, roomName: "E75N8" }],
          center: { x: 10, y: 25, roomName: "E75N8" },
          height: 10,
        },
        {
          tiles: [{ x: 35, y: 25, roomName: "E74N8" }],
          center: { x: 35, y: 25, roomName: "E74N8" },
          height: 10,
        },
      ];

      const territories = bfsDivideMultiRoom(peaks, terrainCallback, TERRAIN_MASK_WALL, 2);

      const t1 = territories.get("E75N8-10-25");
      const t2 = territories.get("E74N8-35-25");

      expect(t1).to.exist;
      expect(t2).to.exist;

      const t1InE75N8 = t1!.filter(c => c.roomName === "E75N8").length;
      const t1InE74N8 = t1!.filter(c => c.roomName === "E74N8").length;
      const t2InE75N8 = t2!.filter(c => c.roomName === "E75N8").length;
      const t2InE74N8 = t2!.filter(c => c.roomName === "E74N8").length;

      console.log(`Two competing peaks with real terrain:`);
      console.log(`  E75N8 peak: ${t1InE75N8} in E75N8, ${t1InE74N8} in E74N8`);
      console.log(`  E74N8 peak: ${t2InE75N8} in E75N8, ${t2InE74N8} in E74N8`);

      // Each peak should primarily claim its own room (>80%)
      const t1OwnRoomRatio = t1InE75N8 / t1!.length;
      const t2OwnRoomRatio = t2InE74N8 / t2!.length;

      console.log(`  E75N8 peak owns ${(t1OwnRoomRatio * 100).toFixed(1)}% in own room`);
      console.log(`  E74N8 peak owns ${(t2OwnRoomRatio * 100).toFixed(1)}% in own room`);

      expect(t1OwnRoomRatio).to.be.at.least(0.8, "E75N8 peak should own >80% in its own room");
      expect(t2OwnRoomRatio).to.be.at.least(0.8, "E74N8 peak should own >80% in its own room");
    });
  });

  describe("multi-room distance transform with real terrain", () => {
    it("should compute distance transform across E75N8 and E74N8", () => {
      const roomTerrains = new Map<string, (x: number, y: number) => number>();
      roomTerrains.set("E75N8", E75N8_TERRAIN);
      roomTerrains.set("E74N8", E74N8_TERRAIN);

      const terrainCallback = createMultiRoomTerrain(roomTerrains);

      const distances = createMultiRoomDistanceTransform(
        ["E75N8", "E74N8"],
        terrainCallback,
        TERRAIN_MASK_WALL,
        2
      );

      // Find max distance in each room
      let maxE75N8 = 0;
      let maxE74N8 = 0;
      let maxE75N8Pos = { x: 0, y: 0 };
      let maxE74N8Pos = { x: 0, y: 0 };

      for (const [key, dist] of distances) {
        const [room, coordStr] = key.split(":");
        const [xStr, yStr] = coordStr.split(",");
        const x = parseInt(xStr);
        const y = parseInt(yStr);

        if (room === "E75N8" && dist > maxE75N8) {
          maxE75N8 = dist;
          maxE75N8Pos = { x, y };
        }
        if (room === "E74N8" && dist > maxE74N8) {
          maxE74N8 = dist;
          maxE74N8Pos = { x, y };
        }
      }

      console.log(`Multi-room distance transform:`);
      console.log(`  E75N8 max distance: ${maxE75N8} at (${maxE75N8Pos.x}, ${maxE75N8Pos.y})`);
      console.log(`  E74N8 max distance: ${maxE74N8} at (${maxE74N8Pos.x}, ${maxE74N8Pos.y})`);

      expect(maxE75N8).to.be.greaterThan(5);
      expect(maxE74N8).to.be.greaterThan(3);
    });

    it("should find peaks in both rooms", () => {
      const roomTerrains = new Map<string, (x: number, y: number) => number>();
      roomTerrains.set("E75N8", E75N8_TERRAIN);
      roomTerrains.set("E74N8", E74N8_TERRAIN);

      const terrainCallback = createMultiRoomTerrain(roomTerrains);

      const distances = createMultiRoomDistanceTransform(
        ["E75N8", "E74N8"],
        terrainCallback,
        TERRAIN_MASK_WALL,
        2
      );

      const rawPeaks = findMultiRoomPeaks(distances, terrainCallback, TERRAIN_MASK_WALL);
      const filteredPeaks = filterMultiRoomPeaks(rawPeaks, { minHeight: 3, maxPeaks: 10 });

      console.log(`Found ${rawPeaks.length} raw peaks, ${filteredPeaks.length} after filtering`);

      // Group by room
      const peaksInE75N8 = filteredPeaks.filter(p => p.center.roomName === "E75N8");
      const peaksInE74N8 = filteredPeaks.filter(p => p.center.roomName === "E74N8");

      console.log(`  E75N8: ${peaksInE75N8.length} peaks`);
      for (const peak of peaksInE75N8) {
        console.log(`    (${peak.center.x}, ${peak.center.y}) height=${peak.height}`);
      }
      console.log(`  E74N8: ${peaksInE74N8.length} peaks`);
      for (const peak of peaksInE74N8) {
        console.log(`    (${peak.center.x}, ${peak.center.y}) height=${peak.height}`);
      }

      expect(peaksInE75N8.length).to.be.at.least(1, "Should find at least 1 peak in E75N8");
      expect(peaksInE74N8.length).to.be.at.least(1, "Should find at least 1 peak in E74N8");
    });
  });
});
