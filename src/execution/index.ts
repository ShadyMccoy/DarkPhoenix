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
  snapshotCorpVariance
} from "./CorpRunner";

export { allCommissionedCorps, assembleFieldedFleets, completeCensus, runCommissionHost } from "./CommissionHost";

export { rescueOrphans } from "./OrphanRescue";

export { sampleMarketPrices } from "./marketSampler";

export { runSpawnScheduling } from "./SpawnDirector";

export { runLinks } from "./LinkRunner";
export { runTerminals } from "./TerminalRunner";

export { runTowers } from "./TowerRunner";

export { persistState, cleanupDeadCreeps } from "./Persistence";

export {
  getAnalysisCache,
  isAnalysisInProgress,
  refreshNodeResourcesFromCache,
  resetAnalysis,
  restoreVisualizationCache,
  runIncrementalAnalysis
} from "./IncrementalAnalysis";

export { renderNodeVisuals, renderSpatialVisuals } from "./Visualization";

export { trackRoadUsage } from "./roadTracker";

export {
  isSpawnPlacementInProgress,
  shouldKickSweep,
  startSpawnPlacement,
  runSpawnPlacementStep
} from "./SpawnPlacementScheduler";
