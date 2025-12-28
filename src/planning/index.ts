/**
 * @fileoverview Planning module exports.
 *
 * This module provides chain-based planning for the economic system:
 * - Chain: Production chains linking corps together
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

// Re-export Node from canonical source
export { Node } from "../nodes/Node";

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
  PLANNING_EPOCH,
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

// Note: ScenarioRunner is not exported here as it depends on test-only modules
// (ChainPlanner, OfferCollector, projections). Use directly from ./ScenarioRunner
// in test environments where those modules are available.
