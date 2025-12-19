/**
 * @fileoverview Spatial analysis module exports.
 *
 * This module provides multi-room spatial analysis tools for colony planning:
 * - analyzeMultiRoomTerrain: Main entry point for cross-room analysis
 * - CrossRoomPeak: Peak info with room context
 * - WorldPosition: Position with room name
 *
 * Pure algorithm exports (for testing and direct use):
 * - createMultiRoomDistanceTransform: Distance from walls calculation
 * - findMultiRoomPeaks: Peak detection algorithm
 * - filterMultiRoomPeaks: Peak filtering with exclusion radius
 * - bfsDivideMultiRoom: Territory division via BFS
 *
 * @module spatial
 */

// Main API exports
export {
  WorldPosition,
  CrossRoomPeak,
  MultiRoomAnalysisResult,
  MultiRoomAnalysisOptions,
  analyzeMultiRoomTerrain,
  calculateCrossRoomTerritories,
  visualizeMultiRoomAnalysis,
  createMultiRoomTerrainCallback,
  collectFeaturePositions,
  collectFeaturePositionsFromIntel,
  invalidateRoomMapCache,
} from "./RoomMap";

// Export pure algorithms and types for testing
export {
  // Multi-room algorithms
  createMultiRoomDistanceTransform,
  findMultiRoomPeaks,
  filterMultiRoomPeaks,
  bfsDivideMultiRoom,
  findTerritoryAdjacencies,
  bfsWalkingDistance,
  // Incremental skeleton builder (multi-tick)
  createSkeletonBuilderState,
  processSkeletonBuilderChunk,
  SkeletonBuilderState,
  // Utility functions
  parseRoomName,
  roomCoordsToName,
  getAdjacentRoomPosition,
  // Types
  MultiRoomTerrainCallback,
  WorldCoordinate,
  WorldPeakData,
  RoomCoords,
  FilterPeaksOptions,
  // Constants
  GRID_SIZE,
} from "./algorithms";
