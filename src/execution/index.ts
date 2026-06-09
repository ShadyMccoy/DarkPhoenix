/**
 * @fileoverview Execution module exports.
 *
 * This module contains the runtime execution logic for the game loop:
 * - Corp lifecycle management (CorpRunner)
 * - State persistence (Persistence)
 * - Incremental terrain analysis (IncrementalAnalysis)
 * - Visualization rendering (Visualization)
 *
 * @module execution
 */

export {
  CorpRegistry,
  createCorpRegistry,
  runBootstrapCorps,
  runRealCorps,
  runScoutCorps,
  runConstructionCorps,
  runReservationCorps,
  runSpawningCorps,
  logCorpStats
} from "./CorpRunner";

export { runSpawnScheduling } from "./SpawnDirector";

export { persistState, cleanupDeadCreeps } from "./Persistence";

export {
  MULTI_ROOM_ANALYSIS_CACHE_TTL,
  getAnalysisCache,
  isAnalysisInProgress,
  refreshNodeResourcesFromCache,
  resetAnalysis,
  restoreVisualizationCache,
  runIncrementalAnalysis
} from "./IncrementalAnalysis";

export { renderNodeVisuals, renderSpatialVisuals } from "./Visualization";

export {
  isSpawnPlacementInProgress,
  resetSpawnPlacement,
  startSpawnPlacement,
  runSpawnPlacementStep
} from "./SpawnPlacementScheduler";
