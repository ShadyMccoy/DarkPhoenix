/**
 * @fileoverview Planning module exports.
 *
 * This module provides chain-based planning for the economic system:
 * - Chain: Production chains linking corps together
 * - ChainPlanner: Builds profitable chains from offers
 * - OfferCollector: Gathers offers from all corps
 *
 * @module planning
 */

export {
  Chain,
  ChainSegment,
  SerializedChain,
  calculateProfit,
  isViable,
  calculateTotalCost,
  calculateChainROI,
  buildSegment,
  createChain,
  sortByProfit,
  sortByROI,
  filterViable,
  getCorpIds,
  chainsOverlap,
  selectNonOverlapping,
  createChainId,
  serializeChain,
  deserializeChain
} from "./Chain";

export {
  OfferCollector,
  ResourceStat,
  OfferStats
} from "./OfferCollector";

// Re-export Node from canonical source
export { Node } from "../nodes/Node";

export {
  ChainPlanner,
  GoalType,
  ChainGoal,
  InputRequirement,
  canBuildChain
} from "./ChainPlanner";

export {
  BodyPart,
  BODY_PART_COST,
  CREEP_LIFETIME,
  HARVEST_RATE,
  CARRY_CAPACITY,
  SPAWN_TIME_PER_PART,
  SOURCE_REGEN_TIME,
  SOURCE_ENERGY_CAPACITY,
  SOURCE_ENERGY_PER_TICK,
  parseRoomCoords,
  calculateTravelTime,
  calculateEffectiveWorkTime,
  calculateBodyCost,
  countBodyParts,
  calculateTotalHarvest,
  calculateCreepCostPerEnergy,
  designMiningCreep,
  calculateOptimalWorkParts,
  calculateSpawnTime
} from "./EconomicConstants";

export {
  FixtureNode,
  FixtureResource,
  Fixture,
  HydrationConfig,
  HydrationResult,
  hydrateFixture,
  hydrateNodes,
  resetIdCounter,
  createSimpleMiningFixture,
  createRemoteMiningFixture,
  createCompleteRoomFixture
} from "./FixtureHydration";

export {
  ChainReporter,
  ChainReport,
  ChainStepReport,
  ResourceMarketData
} from "./ChainReporter";

export {
  ScenarioRunner,
  Scenario,
  ScenarioExpectations,
  ScenarioConfig,
  ScenarioResult,
  parseScenario,
  createScenario
} from "./ScenarioRunner";

// Pure projection functions (uses CorpState)
export {
  CorpProjection,
  projectMining,
  projectSpawning,
  projectUpgrading,
  projectHauling,
  project,
  projectAll,
  collectBuys,
  collectSells
} from "./projections";
