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
  runSpawningCorps,
  logCorpStats,
  snapshotCorpVariance,
  CorpVarianceRow
} from "./CorpRunner";

export {
  commissionedCorpsOfKind,
  allCommissionedCorps,
  CorpCensusEntry,
  runCommissionHost,
  resetCommissionHost
} from "./CommissionHost";

export { rescueOrphans, orphanAction, ORPHAN_GRACE_TICKS } from "./OrphanRescue";

export { runSpawnScheduling } from "./SpawnDirector";

export { runLinks } from "./LinkRunner";

export { pickTowerTarget, runTowers } from "./TowerRunner";

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
