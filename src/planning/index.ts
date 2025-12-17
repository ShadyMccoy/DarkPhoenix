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
  Node,
  ResourceStat,
  OfferStats
} from "./OfferCollector";

export {
  ChainPlanner,
  GoalType,
  ChainGoal,
  InputRequirement,
  canBuildChain
} from "./ChainPlanner";
