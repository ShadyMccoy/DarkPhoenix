/**
 * @fileoverview Planning models for chain planning and testing.
 *
 * These models simulate corp behavior without requiring Screeps runtime.
 * Use these for:
 * - ChainPlanner testing
 * - Economic simulation
 * - Offline analysis
 *
 * For actual game execution, use corps from src/corps/.
 *
 * @module planning/models
 */

export {
  MiningModel,
  MiningStats,
  MINING_CONSTANTS,
  calculateExpectedOutput,
  calculateOptimalWorkParts,
  calculateMiningEfficiency
} from "./MiningModel";

export {
  SpawningModel,
  CreepBody,
  SpawnRequest,
  SPAWN_CONSTANTS,
  calculateBodyEnergyCost,
  calculateWorkTicks,
  calculateCarryTicks,
  calculateSpawnTime
} from "./SpawningModel";

export {
  UpgradingModel,
  UpgradingStats,
  UPGRADING_CONSTANTS,
  calculateExpectedUpgradeOutput,
  calculateUpgradeEnergyNeeded,
  calculateUpgradeEfficiency
} from "./UpgradingModel";

export {
  HaulingModel,
  HaulingStats,
  HAULING_CONSTANTS,
  calculateHaulingThroughput,
  calculateRoundTripTime,
  calculateTripsPerLifetime
} from "./HaulingModel";
