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

import { Colony } from "../colony/Colony";
import { CorpRegistry } from "../execution/CorpRunner";
import { SerializedChain, Chain, deserializeChain, serializeChain } from "../planning/Chain";
import { Node, NodeResource } from "../nodes/Node";
import {
  HarvestCorp,
  createHarvestCorp,
  SerializedHarvestCorp,
  CarryCorp,
  createCarryCorp,
  SerializedCarryCorp,
  UpgradingCorp,
  createUpgradingCorp,
  SerializedUpgradingCorp,
  SpawningCorp,
  createSpawningCorp,
  SerializedSpawningCorp,
  BootstrapCorp,
  SerializedBootstrapCorp,
  ScoutCorp,
  SerializedScoutCorp,
  ConstructionCorp,
  SerializedConstructionCorp,
} from "../corps";

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
    scout: number;
    construction: number;
  };
}

/**
 * Check if corps registry needs initialization.
 * Returns true if the global cache is empty (after code push).
 */
export function needsInit(corps: CorpRegistry): boolean {
  const hasCorps =
    Object.keys(corps.harvestCorps).length > 0 ||
    Object.keys(corps.haulingCorps).length > 0 ||
    Object.keys(corps.upgradingCorps).length > 0 ||
    Object.keys(corps.spawningCorps).length > 0 ||
    Object.keys(corps.bootstrapCorps).length > 0;

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
      scout: 0,
      construction: 0
    }
  };

  if (!needsInit(corps)) {
    return result;
  }

  result.wasNeeded = true;
  console.log(`[Init] Hydrating corps from Memory (cache was empty)`);

  // Hydrate harvest corps
  if (Memory.harvestCorps) {
    for (const sourceId in Memory.harvestCorps) {
      const saved = Memory.harvestCorps[sourceId];
      if (saved && !corps.harvestCorps[sourceId]) {
        const harvestCorp = new HarvestCorp(saved.nodeId, saved.spawnId, saved.sourceId);
        harvestCorp.deserialize(saved);
        corps.harvestCorps[sourceId] = harvestCorp;
        result.corpsHydrated.harvest++;
      }
    }
  }

  // Hydrate hauling corps (keyed by source ID)
  if (Memory.haulingCorps) {
    for (const sourceId in Memory.haulingCorps) {
      const saved = Memory.haulingCorps[sourceId];
      if (saved && !corps.haulingCorps[sourceId]) {
        const haulingCorp = new CarryCorp(saved.nodeId, saved.spawnId);
        haulingCorp.deserialize(saved);
        corps.haulingCorps[sourceId] = haulingCorp;
        result.corpsHydrated.hauling++;
      }
    }
  }

  // Hydrate upgrading corps
  if (Memory.upgradingCorps) {
    for (const roomName in Memory.upgradingCorps) {
      const saved = Memory.upgradingCorps[roomName];
      if (saved && !corps.upgradingCorps[roomName]) {
        const upgradingCorp = new UpgradingCorp(saved.nodeId, saved.spawnId);
        upgradingCorp.deserialize(saved);
        corps.upgradingCorps[roomName] = upgradingCorp;
        result.corpsHydrated.upgrading++;
      }
    }
  }

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

  // Hydrate scout corps
  if (Memory.scoutCorps) {
    for (const roomName in Memory.scoutCorps) {
      const saved = Memory.scoutCorps[roomName];
      if (saved && !corps.scoutCorps[roomName]) {
        const scoutCorp = new ScoutCorp(saved.nodeId, saved.spawnId);
        scoutCorp.deserialize(saved);
        corps.scoutCorps[roomName] = scoutCorp;
        result.corpsHydrated.scout++;
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
    result.corpsHydrated.scout +
    result.corpsHydrated.construction;

  console.log(`[Init] Hydrated ${totalHydrated} corps from Memory`);

  return result;
}

// =============================================================================
// PLANNING PHASE (every 5000 ticks)
// =============================================================================

/**
 * Simplified contract for chain planning.
 */
export interface SimpleContract {
  id: string;
  startTick: number;
  duration: number;
  delivered: number;
  quantity: number;
}

/**
 * Result of the planning phase.
 */
export interface PlanningResult {
  /** Chains that were planned */
  chains: Chain[];
  /** Contracts derived from chains */
  contracts: SimpleContract[];
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
export function runPlanningPhase(
  corps: CorpRegistry,
  colony: Colony,
  tick: number
): PlanningResult {
  console.log(`[Planning] Running planning phase at tick ${tick}`);

  // Run planning on all corps
  for (const sourceId in corps.harvestCorps) {
    corps.harvestCorps[sourceId].plan(tick);
  }
  for (const sourceId in corps.haulingCorps) {
    corps.haulingCorps[sourceId].plan(tick);
  }
  for (const roomName in corps.upgradingCorps) {
    corps.upgradingCorps[roomName].plan(tick);
  }
  for (const roomName in corps.constructionCorps) {
    corps.constructionCorps[roomName].plan(tick);
  }

  console.log(`[Planning] Planning phase complete`);

  return {
    chains: [],
    contracts: [],
    planningTick: tick
  };
}

/**
 * Load chains from Memory.
 */
export function loadChains(): Chain[] {
  if (!Memory.chains) return [];

  const chains: Chain[] = [];
  for (const chainId in Memory.chains) {
    chains.push(deserializeChain(Memory.chains[chainId]));
  }
  return chains;
}

/**
 * Load contracts from Memory.
 */
export function loadContracts(): SimpleContract[] {
  return [];
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
export function runExecutionPhase(
  corps: CorpRegistry,
  tick: number
): ExecutionResult {
  return {
    corpsRun: countCorps(corps),
    contractsUpdated: 0
  };
}

/**
 * Count total corps in registry.
 */
function countCorps(corps: CorpRegistry): number {
  let count = 0;
  count += Object.keys(corps.harvestCorps).length;
  count += Object.keys(corps.haulingCorps).length;
  count += Object.keys(corps.upgradingCorps).length;
  count += Object.keys(corps.spawningCorps).length;
  count += Object.keys(corps.bootstrapCorps).length;
  count += Object.keys(corps.scoutCorps).length;
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
export function runSurveyPhase(
  colony: Colony,
  corps: CorpRegistry,
  tick: number
): SurveyResult {
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
          result.resourcesFound.sources++;
          if (!corps.harvestCorps[resource.id]) {
            const source = Game.getObjectById(resource.id as Id<Source>);
            if (source) {
              const harvestCorp = createHarvestCorp(room, spawn, source);
              harvestCorp.createdAt = tick;
              corps.harvestCorps[resource.id] = harvestCorp;
              result.corpsCreated.harvest++;
              console.log(`[Survey] Created HarvestCorp for source ${resource.id.slice(-4)}`);
            }
          }
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

      // Note: CarryCorps are now created per-source by FlowMaterializer,
      // not per-room during survey. This ensures each source has dedicated haulers.

      if (!corps.upgradingCorps[node.roomName]) {
        const upgradingCorp = createUpgradingCorp(room, spawn);
        upgradingCorp.createdAt = tick;
        corps.upgradingCorps[node.roomName] = upgradingCorp;
        result.corpsCreated.upgrading++;
        console.log(`[Survey] Created UpgradingCorp for room ${node.roomName}`);
      }
    }
  }

  console.log(`[Survey] Surveyed ${result.nodesSurveyed} nodes, created ${
    result.corpsCreated.harvest + result.corpsCreated.hauling +
    result.corpsCreated.upgrading + result.corpsCreated.spawning
  } corps`);

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
  activeChains: number;
  activeContracts: number;
  corpCounts: {
    mining: number;
    hauling: number;
    upgrading: number;
    spawning: number;
    bootstrap: number;
    scout: number;
    construction: number;
  };
} {
  const chains = loadChains();

  return {
    lastSurveyTick: getLastSurveyTick(),
    lastPlanningTick: getLastPlanningTick(),
    activeChains: chains.length,
    activeContracts: 0,
    corpCounts: {
      mining: 0,
      hauling: 0,
      upgrading: 0,
      spawning: 0,
      bootstrap: 0,
      scout: 0,
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
