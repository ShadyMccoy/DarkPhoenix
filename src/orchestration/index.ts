/**
 * @fileoverview Orchestration module exports.
 *
 * This module contains the phased orchestration logic:
 * - Survey phase (when nodes are created)
 * - Planning phase (every 5000 ticks)
 * - Execution phase (every tick)
 *
 * @module orchestration
 */

export {
  // Constants
  PLANNING_INTERVAL,
  CONTRACT_DURATION,
  // Planning phase
  shouldRunPlanning,
  runPlanningPhase,
  PlanningResult,
  // Execution phase
  runExecutionPhase,
  ExecutionResult,
  // Persistence
  loadChains,
  loadContracts,
  getLastPlanningTick,
  setLastPlanningTick,
} from "./Phases";
