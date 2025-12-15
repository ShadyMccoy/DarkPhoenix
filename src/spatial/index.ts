/**
 * @fileoverview Spatial analysis module exports.
 *
 * This module provides spatial analysis tools for colony planning:
 * - RoomMap: Full room analysis with peaks and territories
 * - Peak: Optimal building location interface
 * - Territory: Zone ownership interface
 *
 * Pure algorithm exports (for testing and direct use):
 * - createDistanceTransform: Distance from walls calculation
 * - findPeaks: Peak detection algorithm
 * - filterPeaks: Peak filtering with exclusion radius
 * - bfsDivideRoom: Territory division via BFS
 *
 * @module spatial
 */

export { RoomMap, Peak, Territory } from "./RoomMap";

// Export pure algorithms and types for testing
export {
  // Core algorithms
  createDistanceTransform,
  findPeaks,
  filterPeaks,
  bfsDivideRoom,
  // Utility functions
  initializeGrid,
  markBarriers,
  floodFillDistanceSearch,
  // Types
  TerrainCallback,
  Coordinate,
  PeakData,
  // Constants
  GRID_SIZE,
  UNVISITED,
  BARRIER,
} from "./algorithms";
