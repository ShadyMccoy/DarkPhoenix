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
  // Init phase (lazy initialization)
  needsInit,
  initCorps,
  InitResult,
  // Survey phase
  getLastSurveyTick,
  setLastSurveyTick,
  // Planning phase (refreshes corp production targets)
  shouldRunPlanning,
  // Execution phase
  // Status
  // Persistence
  getLastPlanningTick,
  setLastPlanningTick
} from "./Phases";
