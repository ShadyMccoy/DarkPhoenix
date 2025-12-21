/**
 * @fileoverview Corps module exports.
 *
 * Corps are the execution units that actually control creeps in the game.
 * For planning/simulation models (used in ChainPlanner), see src/planning/models/.
 *
 * @module corps
 */

// Shared constants
export * from "./CorpConstants";

export {
  Corp,
  CorpType,
  SerializedCorp,
  calculateMargin,
  calculatePrice,
  calculateROI
} from "./Corp";

export {
  BootstrapCorp,
  SerializedBootstrapCorp,
  createBootstrapCorp
} from "./BootstrapCorp";

export {
  RealMiningCorp,
  SerializedRealMiningCorp,
  createRealMiningCorp
} from "./RealMiningCorp";

export {
  RealHaulingCorp,
  SerializedRealHaulingCorp,
  createRealHaulingCorp
} from "./RealHaulingCorp";

export {
  RealUpgradingCorp,
  SerializedRealUpgradingCorp,
  createRealUpgradingCorp
} from "./RealUpgradingCorp";

export {
  ScoutCorp,
  SerializedScoutCorp,
  createScoutCorp
} from "./ScoutCorp";

export {
  ConstructionCorp,
  SerializedConstructionCorp,
  createConstructionCorp
} from "./ConstructionCorp";

export {
  SpawningCorp,
  SerializedSpawningCorp,
  SpawnOrder,
  SpawnableCreepType,
  createSpawningCorp
} from "./SpawningCorp";

// Corp state types for pure projection functions
export {
  MiningCorpState,
  SpawningCorpState,
  UpgradingCorpState,
  HaulingCorpState,
  BuildingCorpState,
  BootstrapCorpState,
  ScoutCorpState,
  AnyCorpState,
  createMiningState,
  createSpawningState,
  createUpgradingState,
  createHaulingState,
  getCorpPosition
} from "./CorpState";
