/**
 * @fileoverview Spatial analysis module exports.
 *
 * Multi-room spatial analysis for colony planning. The barrel carries what
 * the execution layer consumes; the pure algorithms are imported from
 * ./algorithms and ./RoomMap directly (tests do).
 *
 * @module spatial
 */

export {
  CrossRoomPeak,
  MultiRoomAnalysisResult,
  WorldPosition,
  analyzeMultiRoomTerrain,
  visualizeMultiRoomAnalysis
} from "./RoomMap";

export { WorldCoordinate, findTerritoryAdjacencies } from "./algorithms";
