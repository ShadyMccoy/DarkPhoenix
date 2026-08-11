/**
 * @fileoverview Orchestration module exports.
 *
 * Init hydration (once per code push) and the planning-cadence bookkeeping
 * the main loop sequences. The economy itself is planned by the CorpPlanner
 * (src/economy); this module just gates the phases.
 *
 * @module orchestration
 */

export { PLANNING_INTERVAL, initCorps, needsInit, setLastPlanningTick, shouldRunPlanning } from "./Phases";
