/**
 * @fileoverview Orchestration module exports.
 *
 * This module contains the phased orchestration logic:
 * - Init phase (once per code push, lazy initialization)
 * - Survey phase (when nodes are created)
 * - Investment phase (allocates capital before planning)
 * - Planning phase (every 5000 ticks)
 * - Execution phase (every tick)
 *
 * @module orchestration
 */

export {
  // Constants
  PLANNING_INTERVAL,
  CONTRACT_DURATION,
  // Init phase (lazy initialization)
  needsInit,
  initCorps,
  InitResult,
  // Survey phase
  runSurveyPhase,
  SurveyResult,
  getLastSurveyTick,
  setLastSurveyTick,
  // Planning phase
  shouldRunPlanning,
  runPlanningPhase,
  PlanningResult,
  // Execution phase
  runExecutionPhase,
  ExecutionResult,
  // Status
  getOrchestrationStatus,
  // Persistence
  loadChains,
  loadContracts,
  getLastPlanningTick,
  setLastPlanningTick,
} from "./Phases";

export {
  // Investment phase (forward capital flow)
  runInvestmentPhase,
  shouldRefreshInvestments,
  recordInvestmentDelivery,
  getCorpCapital,
  getInvestmentSummary,
  getInvestmentState,
  resetInvestmentState,
  InvestmentPhaseResult,
  InvestmentState,
} from "./InvestmentPhase";
