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

export {
  RoomMap,
  Peak,
  Territory,
  Edge,
  InterRoomEdge,
  RoomMapOptions,
  WorldPosition,
  CrossRoomPeak,
  MultiRoomAnalysisResult,
  MultiRoomAnalysisOptions,
  shouldVisualize,
  getRoomsToVisualize,
  collectFeaturePositions,
  collectFeaturePositionsFromIntel,
  invalidateRoomMapCache,
  createMultiRoomTerrainCallback,
  calculateCrossRoomTerritories,
  extractPeaksFromRoomMaps,
  analyzeMultiRoomTerrain,
  visualizeMultiRoomAnalysis,
} from "./RoomMap";

// Export pure algorithms and types for testing
export {
  // Core algorithms
  createDistanceTransform,
  findPeaks,
  filterPeaks,
  bfsDivideRoom,
  // Multi-room algorithms
  createMultiRoomDistanceTransform,
  findMultiRoomPeaks,
  filterMultiRoomPeaks,
  bfsDivideMultiRoom,
  // Utility functions
  initializeGrid,
  markBarriers,
  floodFillDistanceSearch,
  parseRoomName,
  roomCoordsToName,
  getAdjacentRoomPosition,
  // Types
  TerrainCallback,
  MultiRoomTerrainCallback,
  Coordinate,
  WorldCoordinate,
  PeakData,
  WorldPeakData,
  RoomCoords,
  FilterPeaksOptions,
  // Constants
  GRID_SIZE,
  UNVISITED,
  BARRIER,
} from "./algorithms";
