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

import { BootstrapCorp, ConstructionCorp, SpawningCorp, createSpawningCorp } from "../corps";
import { Colony } from "../colony/Colony";
import { CorpRegistry } from "../execution/CorpRunner";
import { commissionedCorpsOfKind } from "../execution/CommissionHost";

/** Planning interval in ticks */
export const PLANNING_INTERVAL = 5000;

/** Contract duration (creep lifetime) */
export const CONTRACT_DURATION = 1500;

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

  // Hydrate construction corps
  if (Memory.constructionCorps) {
    for (const roomName in Memory.constructionCorps) {
      const saved = Memory.constructionCorps[roomName];
      if (saved && !corps.constructionCorps[roomName]) {
        const constructionCorp = new ConstructionCorp(saved.nodeId, saved.spawnId);
        constructionCorp.deserialize(saved);
        corps.constructionCorps[roomName] = constructionCorp;
        result.corpsHydrated.construction++;
      }
    }
  }

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
 * Result of the planning phase.
 */
export interface PlanningResult {
  /** Tick when planning was performed */
  planningTick: number;
}

/**
 * Check if it's time to run the planning phase.
 */
export function shouldRunPlanning(tick: number): boolean {
  return tick % PLANNING_INTERVAL === 0;
}

/**
 * Run the planning phase.
 *
 * In the flow-based economy, this just updates corp production targets.
 */
export function runPlanningPhase(corps: CorpRegistry, colony: Colony, tick: number): PlanningResult {
  console.log(`[Planning] Running planning phase at tick ${tick}`);

  // Run planning on registry corps. Harvest/carry/upgrade plan on their own
  // cadence inside CommissionHost (their kind run() calls plan()), so they are
  // not planned here.
  for (const roomName in corps.constructionCorps) {
    corps.constructionCorps[roomName].plan(tick);
  }

  console.log(`[Planning] Planning phase complete`);

  return {
    planningTick: tick
  };
}

// =============================================================================
// EXECUTION PHASE (every tick)
// =============================================================================

/**
 * Result of the execution phase.
 */
export interface ExecutionResult {
  /** Number of corps that ran */
  corpsRun: number;
  /** Contracts that were updated */
  contractsUpdated: number;
}

/**
 * Run the execution phase.
 */
export function runExecutionPhase(corps: CorpRegistry, _tick: number): ExecutionResult {
  return {
    corpsRun: countCorps(corps),
    contractsUpdated: 0
  };
}

/**
 * Count total corps in registry.
 */
function countCorps(corps: CorpRegistry): number {
  // Harvest/carry/upgrade live in the commission store; this counts registry corps.
  let count = 0;
  count += Object.keys(commissionedCorpsOfKind("harvest")).length;
  count += Object.keys(commissionedCorpsOfKind("carry")).length;
  count += Object.keys(commissionedCorpsOfKind("upgrade")).length;
  count += Object.keys(corps.spawningCorps).length;
  count += Object.keys(corps.bootstrapCorps).length;
  count += Object.keys(corps.constructionCorps).length;
  return count;
}

// =============================================================================
// SURVEY PHASE (when nodes are created)
// =============================================================================

/**
 * Result of the survey phase.
 */
export interface SurveyResult {
  /** Number of nodes surveyed */
  nodesSurveyed: number;
  /** Corps created during survey */
  corpsCreated: {
    harvest: number;
    hauling: number;
    upgrading: number;
    spawning: number;
  };
  /** Resources found */
  resourcesFound: {
    sources: number;
    controllers: number;
    spawns: number;
  };
}

/**
 * Run the survey phase.
 */
export function runSurveyPhase(colony: Colony, corps: CorpRegistry, tick: number): SurveyResult {
  console.log(`[Survey] Running survey phase at tick ${tick}`);

  const result: SurveyResult = {
    nodesSurveyed: 0,
    corpsCreated: { harvest: 0, hauling: 0, upgrading: 0, spawning: 0 },
    resourcesFound: { sources: 0, controllers: 0, spawns: 0 }
  };

  const nodes = colony.getNodes();
  const processedRooms = new Set<string>();

  for (const node of nodes) {
    result.nodesSurveyed++;

    const room = Game.rooms[node.roomName];
    if (!room) continue;

    if (!room.controller?.my) continue;

    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;

    const spawn = spawns[0];

    for (const resource of node.resources) {
      switch (resource.type) {
        case "source":
          // HarvestCorps are framework-commissioned now (created by CommissionHost
          // from the planner's commissions), not provisioned here during survey.
          result.resourcesFound.sources++;
          break;

        case "controller":
          result.resourcesFound.controllers++;
          break;

        case "spawn":
          result.resourcesFound.spawns++;
          if (!corps.spawningCorps[resource.id]) {
            const spawnObj = Game.getObjectById(resource.id as Id<StructureSpawn>);
            if (spawnObj) {
              const spawningCorp = createSpawningCorp(spawnObj);
              spawningCorp.createdAt = tick;
              corps.spawningCorps[resource.id] = spawningCorp;
              result.corpsCreated.spawning++;
              console.log(`[Survey] Created SpawningCorp for spawn ${spawnObj.name}`);
            }
          }
          break;
      }
    }

    if (!processedRooms.has(node.roomName)) {
      processedRooms.add(node.roomName);

      // CarryCorps and UpgradingCorps are framework-commissioned now (created by
      // CommissionHost from the planner's commissions), not provisioned here.
    }
  }

  console.log(
    `[Survey] Surveyed ${result.nodesSurveyed} nodes, created ${
      result.corpsCreated.harvest +
      result.corpsCreated.hauling +
      result.corpsCreated.upgrading +
      result.corpsCreated.spawning
    } corps`
  );

  return result;
}

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
 * Get orchestration status for debugging.
 */
export function getOrchestrationStatus(): {
  lastSurveyTick: number;
  lastPlanningTick: number;
  corpCounts: {
    mining: number;
    hauling: number;
    upgrading: number;
    spawning: number;
    bootstrap: number;
    construction: number;
  };
} {
  return {
    lastSurveyTick: getLastSurveyTick(),
    lastPlanningTick: getLastPlanningTick(),
    corpCounts: {
      mining: 0,
      hauling: 0,
      upgrading: 0,
      spawning: 0,
      bootstrap: 0,
      construction: 0
    }
  };
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
