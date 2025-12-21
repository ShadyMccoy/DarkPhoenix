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
  runSpawningCorps,
  registerCorpsWithMarket,
  runMarketClearing,
  processSpawnContracts,
  logCorpStats,
} from "./CorpRunner";

export {
  persistState,
  cleanupDeadCreeps,
} from "./Persistence";

export {
  MULTI_ROOM_ANALYSIS_CACHE_TTL,
  getAnalysisCache,
  isAnalysisInProgress,
  resetAnalysis,
  restoreVisualizationCache,
  runIncrementalAnalysis,
} from "./IncrementalAnalysis";

export {
  renderNodeVisuals,
  renderSpatialVisuals,
} from "./Visualization";
