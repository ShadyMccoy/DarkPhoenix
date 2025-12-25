/**
 * @fileoverview Orchestration module exports.
 *
 * This module contains the phased orchestration logic:
 * - Init phase (once per code push, lazy initialization)
 * - Survey phase (when nodes are created)
 * - Planning phase (every 5000 ticks) - unified ChainPlanner-based planning
 * - Execution phase (every tick)
 *
 * The ChainPlanner is the single source of truth for economic planning.
 * It finds viable chains, creates contracts, and assigns them to corps.
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
  // Planning phase (unified ChainPlanner-based)
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
