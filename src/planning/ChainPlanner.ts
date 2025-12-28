/**
 * @fileoverview ChainPlanner finds viable production chains.
 *
 * The ChainPlanner analyzes corp states and their offers to identify
 * profitable chains from resource sources to value-creating goals.
 *
 * @module planning/ChainPlanner
 */

import { MintValues } from "../colony/MintValues";
import { AnyCorpState } from "../corps/CorpState";
import {
  Chain,
  ChainSegment,
  createChain,
  createChainId,
  buildSegment,
  filterViable,
  sortByProfit,
  selectNonOverlapping
} from "./Chain";
import { OfferCollector } from "./OfferCollector";
import { projectAll } from "./projections";

/**
 * The production chain from sources to goals.
 */
const RESOURCE_CHAIN = [
  "raw-energy",
  "harvested-energy",
  "delivered-energy",
  "controller-points"
];

/**
 * Default margin for each corp type.
 */
const DEFAULT_MARGINS: Record<string, number> = {
  source: 0,
  mining: 0.1,
  hauling: 0.1,
  spawning: 0.1,
  upgrading: 0.1,
  building: 0.1,
  bootstrap: 0,
  scout: 0
};

/**
 * ChainPlanner discovers and evaluates production chains.
 */
export class ChainPlanner {
  private collector: OfferCollector;
  private mintValues: MintValues;
  private maxDepth: number;
  private corpStates: AnyCorpState[] = [];
  private corpStateMap: Map<string, AnyCorpState> = new Map();

  constructor(
    collector: OfferCollector,
    mintValues: MintValues,
    maxDepth: number = 10
  ) {
    this.collector = collector;
    this.mintValues = mintValues;
    this.maxDepth = maxDepth;
  }

  /**
   * Register corp states for planning.
   */
  registerCorpStates(states: AnyCorpState[], tick: number): void {
    this.corpStates = states;
    this.corpStateMap.clear();
    for (const state of states) {
      this.corpStateMap.set(state.id, state);
    }
  }

  /**
   * Find all viable chains at the given tick.
   */
  findViableChains(tick: number): Chain[] {
    const chains: Chain[] = [];
    const projections = projectAll(this.corpStates, tick);

    // Find goal corps (upgrading corps that produce controller points)
    const goalCorps = this.corpStates.filter((s) => s.type === "upgrading");

    for (const goalCorp of goalCorps) {
      // Build chain backwards from goal to source
      const chain = this.buildChainToGoal(goalCorp, tick);
      if (chain) {
        chains.push(chain);
      }
    }

    return filterViable(chains);
  }

  /**
   * Find the best chains within a budget.
   */
  findBestChains(tick: number, budget: number): Chain[] {
    const viableChains = this.findViableChains(tick);
    const sorted = sortByProfit(viableChains);

    // Select non-overlapping chains within budget
    const selected: Chain[] = [];
    let totalCost = 0;

    for (const chain of sorted) {
      if (totalCost + chain.totalCost <= budget) {
        // Check if chain overlaps with already selected
        const overlaps = selected.some((existing) =>
          this.chainsOverlap(chain, existing)
        );

        if (!overlaps) {
          selected.push(chain);
          totalCost += chain.totalCost;
        }
      }
    }

    return selected;
  }

  /**
   * Build a production chain from sources to a goal corp.
   */
  private buildChainToGoal(goalCorp: AnyCorpState, tick: number): Chain | null {
    const segments: ChainSegment[] = [];

    // Find the mining corp (source of harvested energy)
    const miningCorps = this.corpStates.filter((s) => s.type === "mining");
    if (miningCorps.length === 0) return null;

    // Find the hauling corp
    const haulingCorps = this.corpStates.filter((s) => s.type === "hauling");
    if (haulingCorps.length === 0) return null;

    // Use the first mining corp and hauling corp for simplicity
    const miningCorp = miningCorps[0];
    const haulingCorp = haulingCorps[0];

    // Build segments from production to goal
    let currentCost = 0;

    // Segment 1: Mining (harvests energy)
    const miningMargin = DEFAULT_MARGINS.mining;
    segments.push(
      buildSegment(
        miningCorp.id,
        "mining",
        "harvested-energy",
        miningCorp.type === "mining" ? miningCorp.sourceCapacity : 3000,
        currentCost,
        miningMargin
      )
    );
    currentCost = segments[segments.length - 1].outputPrice;

    // Segment 2: Hauling (transports energy)
    const haulingMargin = DEFAULT_MARGINS.hauling;
    segments.push(
      buildSegment(
        haulingCorp.id,
        "hauling",
        "delivered-energy",
        haulingCorp.type === "hauling" ? haulingCorp.carryCapacity * 10 : 500,
        currentCost,
        haulingMargin
      )
    );
    currentCost = segments[segments.length - 1].outputPrice;

    // Segment 3: Upgrading (converts energy to controller points)
    const upgradingMargin = DEFAULT_MARGINS.upgrading;
    segments.push(
      buildSegment(
        goalCorp.id,
        "upgrading",
        "controller-points",
        1000, // work output estimate
        currentCost,
        upgradingMargin
      )
    );

    // Calculate mint value based on controller points
    const mintValue = this.mintValues.rcl_upgrade * 1000;

    // Create and return the chain
    return createChain(
      createChainId(goalCorp.id, tick),
      segments,
      mintValue
    );
  }

  /**
   * Check if two chains overlap (share corps).
   */
  private chainsOverlap(a: Chain, b: Chain): boolean {
    const aCorps = new Set(a.segments.map((s) => s.corpId));
    return b.segments.some((s) => aCorps.has(s.corpId));
  }
}
