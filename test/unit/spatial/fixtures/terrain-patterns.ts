/**
 * @fileoverview Terrain pattern fixtures for spatial algorithm testing.
 *
 * These fixtures provide known terrain configurations for testing:
 * - Empty room: Simple open space with border walls
 * - Corridor: Long narrow passage
 * - Islands: Multiple separated open areas
 * - Complex: Mix of features for comprehensive testing
 *
 * Each fixture includes:
 * - Terrain callback function
 * - Expected properties (peak locations, counts, etc.)
 */

import {
  createEmptyRoomTerrain,
  createCorridorTerrain,
  createIslandsTerrain,
  createTerrainFromPattern,
  TERRAIN_MASK_WALL,
} from "../../mock";

// ============================================================================
// Simple Test Patterns (Small, for fast unit tests)
// ============================================================================

/**
 * 10x10 empty room pattern (all plains except walls on edges)
 */
export const SMALL_EMPTY_ROOM = {
  pattern: [
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
  ],
  terrain: createTerrainFromPattern([
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
  ]),
  gridSize: 10,
  expectedPeakCount: 1,
  expectedPeakCenter: { x: 5, y: 5 }, // Approximate center
  expectedMaxHeight: 4, // Distance from walls in a 10x10 room
};

/**
 * 10x10 corridor pattern (horizontal corridor through middle)
 */
export const SMALL_CORRIDOR = {
  pattern: [
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "X........X",
    "X........X",
    "X........X",
    "X........X",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
  ],
  terrain: createTerrainFromPattern([
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "X........X",
    "X........X",
    "X........X",
    "X........X",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
  ]),
  gridSize: 10,
  expectedPeakCount: 1,
  expectedPeakCenterY: 5, // Should be in middle of corridor
  expectedMaxHeight: 2, // Narrow corridor = low peak height
};

/**
 * 10x10 two-island pattern (two separate open areas)
 */
export const SMALL_TWO_ISLANDS = {
  pattern: [
    "XXXXXXXXXX",
    "X...XX...X",
    "X...XX...X",
    "X...XX...X",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "X...XX...X",
    "X...XX...X",
    "X...XX...X",
    "XXXXXXXXXX",
  ],
  terrain: createTerrainFromPattern([
    "XXXXXXXXXX",
    "X...XX...X",
    "X...XX...X",
    "X...XX...X",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "X...XX...X",
    "X...XX...X",
    "X...XX...X",
    "XXXXXXXXXX",
  ]),
  gridSize: 10,
  expectedPeakCount: 2, // Two separate areas should produce two peaks
};

/**
 * 10x10 L-shaped room pattern
 */
export const SMALL_L_SHAPED = {
  pattern: [
    "XXXXXXXXXX",
    "X....XXXXX",
    "X....XXXXX",
    "X....XXXXX",
    "X....XXXXX",
    "X........X",
    "X........X",
    "X........X",
    "X........X",
    "XXXXXXXXXX",
  ],
  terrain: createTerrainFromPattern([
    "XXXXXXXXXX",
    "X....XXXXX",
    "X....XXXXX",
    "X....XXXXX",
    "X....XXXXX",
    "X........X",
    "X........X",
    "X........X",
    "X........X",
    "XXXXXXXXXX",
  ]),
  gridSize: 10,
  expectedPeakCount: 1, // L-shape should have one main peak in the open area
};

/**
 * 10x10 center obstacle pattern
 */
export const SMALL_CENTER_OBSTACLE = {
  pattern: [
    "XXXXXXXXXX",
    "X........X",
    "X........X",
    "X...XX...X",
    "X...XX...X",
    "X...XX...X",
    "X...XX...X",
    "X........X",
    "X........X",
    "XXXXXXXXXX",
  ],
  terrain: createTerrainFromPattern([
    "XXXXXXXXXX",
    "X........X",
    "X........X",
    "X...XX...X",
    "X...XX...X",
    "X...XX...X",
    "X...XX...X",
    "X........X",
    "X........X",
    "XXXXXXXXXX",
  ]),
  gridSize: 10,
  // Peaks should be on the sides of the central obstacle
};

// ============================================================================
// Full Room Patterns (50x50, for integration-level tests)
// ============================================================================

/**
 * Standard empty room (50x50 with border walls)
 */
export const FULL_EMPTY_ROOM = {
  terrain: createEmptyRoomTerrain(),
  gridSize: 50,
  expectedPeakCount: 1,
  expectedPeakCenter: { x: 25, y: 25 }, // Center of room
  expectedMaxHeightMin: 20, // Should be high in a fully open room
};

/**
 * Full room with horizontal corridor
 */
export const FULL_CORRIDOR_HORIZONTAL = {
  terrain: createCorridorTerrain(25, 10),
  gridSize: 50,
  expectedPeakCount: 1,
  expectedPeakCenterY: 25, // Center of corridor
};

/**
 * Full room with multiple islands
 */
export const FULL_THREE_ISLANDS = {
  terrain: createIslandsTerrain([
    { x: 15, y: 15, radius: 8 },
    { x: 35, y: 15, radius: 8 },
    { x: 25, y: 35, radius: 8 },
  ]),
  gridSize: 50,
  expectedPeakCount: 3, // Should have three distinct peaks
};

// ============================================================================
// Edge Case Patterns
// ============================================================================

/**
 * All walls (no walkable tiles)
 */
export const ALL_WALLS = {
  terrain: () => TERRAIN_MASK_WALL,
  gridSize: 10,
  expectedPeakCount: 0,
};

/**
 * Single walkable tile in center
 */
export const SINGLE_TILE = {
  pattern: [
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXX.XXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
  ],
  terrain: createTerrainFromPattern([
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXX.XXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
  ]),
  gridSize: 10,
  expectedPeakCount: 1,
  expectedPeakCenter: { x: 4, y: 4 },
  expectedMaxHeight: 1, // Single tile = height 1
};

/**
 * Narrow snake pattern (tests elongated areas)
 */
export const SNAKE_PATTERN = {
  pattern: [
    "XXXXXXXXXX",
    "X........X",
    "XXXXXXXX.X",
    "X........X",
    "X.XXXXXXXX",
    "X........X",
    "XXXXXXXX.X",
    "X........X",
    "X.XXXXXXXX",
    "XXXXXXXXXX",
  ],
  terrain: createTerrainFromPattern([
    "XXXXXXXXXX",
    "X........X",
    "XXXXXXXX.X",
    "X........X",
    "X.XXXXXXXX",
    "X........X",
    "XXXXXXXX.X",
    "X........X",
    "X.XXXXXXXX",
    "XXXXXXXXXX",
  ]),
  gridSize: 10,
  // Snake should have low peak heights due to narrow passages
};
