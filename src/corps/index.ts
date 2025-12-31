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
  HarvestCorp,
  SerializedHarvestCorp,
  createHarvestCorp
} from "./HarvestCorp";

export {
  HaulerCorp,
  SerializedHaulerCorp,
  createHaulerCorp
} from "./HaulerCorp";

export {
  TankerCorp,
  TankerDemand,
  SerializedTankerCorp,
  createTankerCorp
} from "./TankerCorp";

export {
  UpgradingCorp,
  SerializedUpgradingCorp,
  createUpgradingCorp
} from "./UpgradingCorp";

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
  SourceCorpState,
  MiningCorpState,
  SpawningCorpState,
  UpgradingCorpState,
  HaulingCorpState,
  BuildingCorpState,
  BootstrapCorpState,
  ScoutCorpState,
  AnyCorpState,
  createSourceState,
  createMiningState,
  createSpawningState,
  createUpgradingState,
  createHaulingState,
  getCorpPosition
} from "./CorpState";

// Registry for dependency resolution
export {
  CorpStateRegistry,
  createCorpStateRegistry
} from "./CorpStateRegistry";
