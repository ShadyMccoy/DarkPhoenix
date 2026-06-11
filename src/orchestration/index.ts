/**
 * @fileoverview Orchestration module exports.
 *
 * This module contains the phased orchestration logic:
 * - Init phase (once per code push, lazy initialization)
 * - Survey phase (when nodes are created)
 * - Planning phase (every 5000 ticks) - refreshes corp production targets
 * - Execution phase (every tick)
 *
 * The economy itself is planned by the CorpPlanner (src/economy); this module
 * just sequences the phases and persistence.
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
  // Planning phase (refreshes corp production targets)
  shouldRunPlanning,
  runPlanningPhase,
  PlanningResult,
  // Execution phase
  runExecutionPhase,
  ExecutionResult,
  // Status
  getOrchestrationStatus,
  // Persistence
  getLastPlanningTick,
  setLastPlanningTick
} from "./Phases";
