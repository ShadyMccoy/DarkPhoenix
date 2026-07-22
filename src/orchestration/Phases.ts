/**
 * @fileoverview Phased orchestration for the colony economic system.
 *
 * The game loop operates in distinct phases:
 *
 * ## NEW NODES (rare - when recalculateTerrain runs)
 * Survey phase: Nodes inventory their territory and corps are instantiated.
 *
 * ## EVERY 5000 TICKS (planning)
 * Planning Phase: Corps update their production targets
 *
 * ## EVERY TICK (execution)
 * 1. Hydrate corps from memory
 * 2. Each corp runs its actions
 *
 * @module orchestration/Phases
 */

import { BootstrapCorp, SpawningCorp, createSpawningCorp } from "../corps";
import { Colony } from "../colony/Colony";
import { CorpRegistry } from "../execution/CorpRunner";
import { commissionedCorpsOfKind } from "../execution/CommissionHost";

/** Planning interval in ticks */
export const PLANNING_INTERVAL = 5000;


// =============================================================================
// INIT PHASE (once per code push, lazy initialization)
// =============================================================================

/**
 * Result of the init phase.
 */
export interface InitResult {
  /** Whether initialization was needed (cache was empty) */
  wasNeeded: boolean;
  /** Corps hydrated from memory */
  corpsHydrated: {
    harvest: number;
    hauling: number;
    upgrading: number;
    spawning: number;
    bootstrap: number;
    construction: number;
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
      harvest: 0,
      hauling: 0,
      upgrading: 0,
      spawning: 0,
      bootstrap: 0,
      construction: 0
    }
  };

  if (!needsInit(corps)) {
    return result;
  }

  result.wasNeeded = true;
  console.log(`[Init] Hydrating corps from Memory (cache was empty)`);

  // Harvest/carry/upgrade corps live in the commission store and are hydrated
  // by CommissionHost (from Memory.commissionedCorps), not here.

  // Hydrate spawning corps
  if (Memory.spawningCorps) {
    for (const spawnId in Memory.spawningCorps) {
      const saved = Memory.spawningCorps[spawnId];
      if (saved && !corps.spawningCorps[spawnId]) {
        const spawningCorp = new SpawningCorp(saved.nodeId, spawnId, saved.energyCapacity);
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

  // Construction corps live in the commission store (CommissionHost hydrates them).

  const totalHydrated =
    result.corpsHydrated.harvest +
    result.corpsHydrated.hauling +
    result.corpsHydrated.upgrading +
    result.corpsHydrated.spawning +
    result.corpsHydrated.bootstrap +
    result.corpsHydrated.construction;

  console.log(`[Init] Hydrated ${totalHydrated} corps from Memory`);

  return result;
}

// =============================================================================
// PLANNING PHASE (every 5000 ticks)
// =============================================================================


/**
 * Check if it's time to run the planning phase.
 */
export function shouldRunPlanning(tick: number): boolean {
  return tick % PLANNING_INTERVAL === 0;
}


// =============================================================================
// EXECUTION PHASE (every tick)
// =============================================================================




// =============================================================================
// SURVEY PHASE (when nodes are created)
// =============================================================================



/**
 * Get the last survey tick from memory.
 */
export function getLastSurveyTick(): number {
  return Memory.lastSurveyTick ?? 0;
}

/**
 * Set the last survey tick in memory.
 */
export function setLastSurveyTick(tick: number): void {
  Memory.lastSurveyTick = tick;
}


/**
 * Get the last planning tick from memory.
 */
export function getLastPlanningTick(): number {
  return Memory.lastPlanningTick ?? 0;
}

/**
 * Set the last planning tick in memory.
 */
export function setLastPlanningTick(tick: number): void {
  Memory.lastPlanningTick = tick;
}
