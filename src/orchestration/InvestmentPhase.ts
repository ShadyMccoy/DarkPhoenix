/**
 * @fileoverview Investment phase for forward capital flow.
 *
 * This module integrates the BankCorp investment model with the existing
 * orchestration phases. It runs before the standard planning phase to:
 *
 * 1. Allocate capital from treasury to investment contracts
 * 2. Distribute capital to recipient corps
 * 3. Enable capital-aware projections for planning
 *
 * The investment phase is OPTIONAL and works alongside the existing
 * backward-tracing chain planner. When investments are active, corps
 * use capital-aware projections that limit demand based on available capital.
 *
 * @module orchestration/InvestmentPhase
 */

import { Colony } from "../colony/Colony";
import { CorpRegistry } from "../execution/CorpRunner";
import { AnyCorpState } from "../corps/CorpState";
import {
  InvestmentPlanner,
  createInvestmentPlanner,
  InvestmentPlanResult,
  CapitalChain
} from "../planning/InvestmentPlanner";
import {
  InvestmentContract,
  InvestmentPerformance,
  calculatePerformance
} from "../market/InvestmentContract";
import {
  distributeInvestmentCapital,
  distributeSubContractCapital,
  clearAllBudgets,
  getCapitalBudget
} from "../market/CapitalBudget";
import { getMintValue } from "../colony/MintValues";

/**
 * Result of the investment phase.
 */
export interface InvestmentPhaseResult {
  /** Investment contracts created */
  investments: InvestmentContract[];
  /** Capital chains built */
  chains: CapitalChain[];
  /** Total budget allocated */
  totalBudgetAllocated: number;
  /** Corps that received capital */
  corpsWithCapital: number;
}

/**
 * Investment phase state - persisted across ticks.
 */
export interface InvestmentState {
  /** Active investment contracts */
  activeInvestments: InvestmentContract[];
  /** Performance history for ROI tracking */
  performanceHistory: InvestmentPerformance[];
  /** Last tick investments were refreshed */
  lastInvestmentTick: number;
}

// Singleton investment planner
let investmentPlanner: InvestmentPlanner | null = null;

// In-memory state (could be persisted to Memory if needed)
let investmentState: InvestmentState = {
  activeInvestments: [],
  performanceHistory: [],
  lastInvestmentTick: 0
};

/**
 * Get or create the investment planner.
 */
export function getInvestmentPlanner(colony: Colony): InvestmentPlanner {
  if (!investmentPlanner) {
    investmentPlanner = createInvestmentPlanner(colony.getMintValues());
  }
  return investmentPlanner;
}

/**
 * Check if investments should be refreshed.
 * Investments refresh alongside the standard planning interval.
 */
export function shouldRefreshInvestments(tick: number, planningInterval: number): boolean {
  return tick % planningInterval === 0;
}

/**
 * Run the investment phase.
 *
 * This runs BEFORE standard planning to:
 * 1. Calculate how much budget to invest
 * 2. Create investment contracts for goal corps
 * 3. Distribute capital to recipients
 * 4. Build capital chains through supply network
 *
 * @param corps - Corp registry
 * @param colony - Colony for treasury access
 * @param tick - Current game tick
 * @returns Investment phase result
 */
export function runInvestmentPhase(
  corps: CorpRegistry,
  colony: Colony,
  tick: number
): InvestmentPhaseResult {
  console.log(`[Investment] Running investment phase at tick ${tick}`);

  // Get planner
  const planner = getInvestmentPlanner(colony);

  // Clear any stale capital budgets
  clearAllBudgets();

  // Collect corp states for planning
  const corpStates = collectCorpStates(corps);
  planner.registerCorpStates(corpStates, tick);

  // Calculate investment budget from treasury
  // Use a portion of treasury for investments
  const treasury = colony.treasury;
  const investmentBudget = calculateInvestmentBudget(treasury);

  console.log(`[Investment] Treasury: ${treasury.toFixed(0)}, Investment budget: ${investmentBudget.toFixed(0)}`);

  // Run investment planning
  const planResult = planner.plan(investmentBudget, tick);

  // Distribute capital to recipient corps
  distributeInvestmentCapital(planResult.investments);
  distributeSubContractCapital(planResult.subContracts);

  // Track state
  investmentState.activeInvestments = planner.getActiveInvestments();
  investmentState.lastInvestmentTick = tick;

  // Count corps that received capital
  let corpsWithCapital = 0;
  for (const state of corpStates) {
    if (getCapitalBudget(state.id).getAvailableCapital() > 0) {
      corpsWithCapital++;
    }
  }

  console.log(`[Investment] Created ${planResult.investments.length} investments, ${corpsWithCapital} corps received capital`);

  return {
    investments: planResult.investments,
    chains: planResult.chains,
    totalBudgetAllocated: planResult.totalBudget,
    corpsWithCapital
  };
}

/**
 * Calculate how much of the treasury to invest.
 *
 * Investment strategy:
 * - Keep a buffer for operational costs
 * - Invest remaining capital for growth
 */
function calculateInvestmentBudget(treasury: number): number {
  // Keep 20% as operational buffer
  const bufferRatio = 0.2;
  const buffer = Math.max(1000, treasury * bufferRatio);

  // Invest the rest
  return Math.max(0, treasury - buffer);
}

/**
 * Collect corp states from all corps in the registry.
 */
function collectCorpStates(corps: CorpRegistry): AnyCorpState[] {
  const states: AnyCorpState[] = [];

  // Spawning corps
  for (const spawnId in corps.spawningCorps) {
    states.push(corps.spawningCorps[spawnId].toCorpState());
  }

  // Mining corps
  for (const sourceId in corps.miningCorps) {
    states.push(corps.miningCorps[sourceId].toCorpState());
  }

  // Hauling corps
  for (const roomName in corps.haulingCorps) {
    states.push(corps.haulingCorps[roomName].toCorpState());
  }

  // Upgrading corps
  for (const roomName in corps.upgradingCorps) {
    states.push(corps.upgradingCorps[roomName].toCorpState());
  }

  return states;
}

/**
 * Record delivery against an investment.
 * Called when a goal corp produces output.
 */
export function recordInvestmentDelivery(
  corpId: string,
  units: number,
  colony: Colony
): number {
  const planner = getInvestmentPlanner(colony);
  const investment = planner.getInvestmentForCorp(corpId);

  if (!investment) {
    return 0; // No investment for this corp
  }

  const payment = planner.recordDelivery(investment.id, units);

  // Record performance for ROI tracking
  const mintValue = getMintValue(colony.getMintValues(), getMintKeyForResource(investment.resource));
  const performance = calculatePerformance(investment, mintValue);
  planner.recordPerformance(performance);

  return payment;
}

/**
 * Map resource to mint value key.
 */
function getMintKeyForResource(resource: string): keyof ReturnType<Colony["getMintValues"]> {
  switch (resource) {
    case "rcl-progress":
      return "rcl_upgrade";
    case "gcl-progress":
      return "gcl_upgrade";
    default:
      return "rcl_upgrade";
  }
}

/**
 * Get available capital for a corp.
 */
export function getCorpCapital(corpId: string): number {
  return getCapitalBudget(corpId).getAvailableCapital();
}

/**
 * Get investment state for debugging.
 */
export function getInvestmentState(): InvestmentState {
  return { ...investmentState };
}

/**
 * Get investment summary for display.
 */
export function getInvestmentSummary(colony: Colony): {
  activeInvestments: number;
  totalDeployed: number;
  totalReturns: number;
  averageROI: number;
} {
  const planner = getInvestmentPlanner(colony);
  return planner.getPortfolioSummary();
}

/**
 * Reset investment state (for testing).
 */
export function resetInvestmentState(): void {
  investmentPlanner = null;
  investmentState = {
    activeInvestments: [],
    performanceHistory: [],
    lastInvestmentTick: 0
  };
  clearAllBudgets();
}
