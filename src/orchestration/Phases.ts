/**
 * @fileoverview Phase gating for the main loop.
 *
 * Two jobs survive here (the survey/market-era phase runners are long
 * deleted - see docs/PIPELINE.md "Deleted / vestigial"):
 *
 * - INIT (once per global reset): re-hydrate the legacy-registry corps
 *   (spawning, bootstrap) from Memory. The framework corps live in the
 *   commission store and are hydrated by CommissionHost.
 * - PLANNING cadence bookkeeping: the fixed PLANNING_INTERVAL gate and the
 *   last-planning-tick stamp. The live re-solve triggers (fiscal-month
 *   boundary, bootstrap eagerness, plan triggers) live in main.ts.
 *
 * @module orchestration/Phases
 */

import { BootstrapCorp, SpawningCorp } from "../corps";
import { CorpRegistry } from "../execution/CorpRunner";

/** Planning interval in ticks */
export const PLANNING_INTERVAL = 5000;

// =============================================================================
// INIT PHASE (once per code push, lazy initialization)
// =============================================================================

/**
 * Result of the init phase: how many legacy-registry corps were re-hydrated.
 */
export interface InitResult {
  /** Whether initialization was needed (cache was empty) */
  wasNeeded: boolean;
  /** Corps hydrated from memory */
  corpsHydrated: {
    spawning: number;
    bootstrap: number;
  };
}

/**
 * Check if corps registry needs initialization.
 * Returns true if the global cache is empty (after code push).
 */
export function needsInit(corps: CorpRegistry): boolean {
  // Economy corps (harvest/carry/upgrade) live in the commission store and are
  // hydrated by CommissionHost; this gates only the registry corps.
  const hasCorps = Object.keys(corps.spawningCorps).length > 0 || Object.keys(corps.bootstrapCorps).length > 0;

  return !hasCorps;
}

/**
 * Initialize corps from Memory.
 */
export function initCorps(corps: CorpRegistry): InitResult {
  const result: InitResult = {
    wasNeeded: false,
    corpsHydrated: {
      spawning: 0,
      bootstrap: 0
    }
  };

  if (!needsInit(corps)) {
    return result;
  }

  result.wasNeeded = true;
  console.log(`[Init] Hydrating corps from Memory (cache was empty)`);

  // Framework corps (harvest/carry/upgrade/construction/...) live in the
  // commission store and are hydrated by CommissionHost from
  // Memory.commissionedCorps, not here.

  // Hydrate spawning corps
  if (Memory.spawningCorps) {
    for (const spawnId in Memory.spawningCorps) {
      const saved = Memory.spawningCorps[spawnId];
      if (saved && !corps.spawningCorps[spawnId]) {
        const spawningCorp = new SpawningCorp(saved.nodeId, spawnId);
        spawningCorp.deserialize(saved);
        corps.spawningCorps[spawnId] = spawningCorp;
        result.corpsHydrated.spawning++;
      }
    }
  }

  // Hydrate bootstrap corps
  if (Memory.bootstrapCorps) {
    for (const roomName in Memory.bootstrapCorps) {
      const saved = Memory.bootstrapCorps[roomName];
      if (saved && !corps.bootstrapCorps[roomName]) {
        const bootstrapCorp = new BootstrapCorp(saved.nodeId, saved.spawnId, saved.sourceId);
        bootstrapCorp.deserialize(saved);
        corps.bootstrapCorps[roomName] = bootstrapCorp;
        result.corpsHydrated.bootstrap++;
      }
    }
  }

  const totalHydrated = result.corpsHydrated.spawning + result.corpsHydrated.bootstrap;
  console.log(`[Init] Hydrated ${totalHydrated} corps from Memory`);

  return result;
}

// =============================================================================
// PLANNING CADENCE
// =============================================================================

/**
 * Check if it's time to run the planning phase.
 */
export function shouldRunPlanning(tick: number): boolean {
  return tick % PLANNING_INTERVAL === 0;
}

/**
 * Set the last planning tick in memory.
 */
export function setLastPlanningTick(tick: number): void {
  Memory.lastPlanningTick = tick;
}
