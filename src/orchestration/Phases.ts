/**
 * @fileoverview Phased orchestration for the colony economic system.
 *
 * The game loop operates in distinct phases:
 *
 * ## NEW NODES (rare - when recalculateTerrain runs)
 * Survey phase: Nodes inventory their territory and corps are instantiated.
 *
 * ## EVERY 5000 TICKS (planning)
 * 1. Offer Phase: Corps generate buy/sell offers
 * 2. Planning Phase: GOAP planner finds best value chains
 * 3. Contracts are stored in Memory
 *
 * ## EVERY TICK (execution)
 * 1. Hydrate corps from memory
 * 2. Each corp runs its actions
 *
 * @module orchestration/Phases
 */

import { Colony } from "../colony/Colony";
import { CorpRegistry } from "../execution/CorpRunner";
import { ChainPlanner } from "../planning/ChainPlanner";
import { SerializedChain, Chain, deserializeChain, serializeChain } from "../planning/Chain";
import { Contract } from "../market/Contract";
import { AnyCorpState } from "../corps/CorpState";
import { Node, NodeResource } from "../nodes/Node";
import {
  RealMiningCorp,
  createRealMiningCorp,
  RealHaulingCorp,
  createRealHaulingCorp,
  RealUpgradingCorp,
  createRealUpgradingCorp,
  SpawningCorp,
  createSpawningCorp,
} from "../corps";

/** Planning interval in ticks */
export const PLANNING_INTERVAL = 5000;

/** Contract duration (creep lifetime) */
export const CONTRACT_DURATION = 1500;

// =============================================================================
// PLANNING PHASE (every 5000 ticks)
// =============================================================================

/**
 * Result of the planning phase.
 */
export interface PlanningResult {
  /** Chains that were planned */
  chains: Chain[];
  /** Contracts derived from chains */
  contracts: Contract[];
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
 * 1. Collects offers from all corps (via projections)
 * 2. Runs the chain planner to find optimal chains
 * 3. Stores planned chains in Memory
 *
 * @param corps - The corp registry with all active corps
 * @param colony - The colony for node information
 * @param tick - Current game tick
 * @returns Planning result with chains and contracts
 */
export function runPlanningPhase(
  corps: CorpRegistry,
  colony: Colony,
  tick: number
): PlanningResult {
  console.log(`[Planning] Running planning phase at tick ${tick}`);

  // Create planner and register corps
  const planner = new ChainPlanner();

  // Collect all corp states from Real*Corps
  const corpStates = collectCorpStates(corps);
  planner.registerCorpStates(corpStates, tick);

  // Register nodes for context
  const nodes = colony.getNodes();
  planner.registerNodes(nodes, tick);

  // Find optimal chains
  const chains = planner.findOptimalChains();

  // Convert chains to contracts for execution
  const contracts = chainsToContracts(chains, tick);

  // Store in Memory
  storeChains(chains);
  storeContracts(contracts);

  console.log(`[Planning] Found ${chains.length} chains, ${contracts.length} contracts`);

  return {
    chains,
    contracts,
    planningTick: tick
  };
}

/**
 * Collect corp states from all Real*Corps in the registry.
 */
function collectCorpStates(corps: CorpRegistry): AnyCorpState[] {
  const states: AnyCorpState[] = [];

  // Mining corps
  for (const sourceId in corps.miningCorps) {
    const corp = corps.miningCorps[sourceId];
    if (typeof corp.toCorpState === "function") {
      states.push(corp.toCorpState());
    }
  }

  // Hauling corps
  for (const roomName in corps.haulingCorps) {
    const corp = corps.haulingCorps[roomName];
    if (typeof corp.toCorpState === "function") {
      states.push(corp.toCorpState());
    }
  }

  // Upgrading corps
  for (const roomName in corps.upgradingCorps) {
    const corp = corps.upgradingCorps[roomName];
    if (typeof corp.toCorpState === "function") {
      states.push(corp.toCorpState());
    }
  }

  // Spawning corps
  for (const spawnId in corps.spawningCorps) {
    const corp = corps.spawningCorps[spawnId];
    if (typeof corp.toCorpState === "function") {
      states.push(corp.toCorpState());
    }
  }

  return states;
}

/**
 * Convert planned chains to executable contracts.
 */
function chainsToContracts(chains: Chain[], tick: number): Contract[] {
  const contracts: Contract[] = [];

  for (const chain of chains) {
    // Each segment in a chain becomes a contract between adjacent corps
    for (let i = 0; i < chain.segments.length - 1; i++) {
      const seller = chain.segments[i];
      const buyer = chain.segments[i + 1];

      contracts.push({
        id: `${chain.id}-${i}`,
        sellerId: seller.corpId,
        buyerId: buyer.corpId,
        resource: seller.resource,
        quantity: seller.quantity,
        price: seller.outputPrice,
        duration: CONTRACT_DURATION,
        startTick: tick,
        delivered: 0,
        paid: 0
      });
    }
  }

  return contracts;
}

/**
 * Store chains in Memory for persistence.
 */
function storeChains(chains: Chain[]): void {
  Memory.chains = {};
  for (const chain of chains) {
    Memory.chains[chain.id] = serializeChain(chain);
  }
}

/**
 * Store contracts in Memory for execution.
 */
function storeContracts(contracts: Contract[]): void {
  if (!Memory.contracts) {
    Memory.contracts = {};
  }

  // Clear old contracts and add new ones
  Memory.contracts = {};
  for (const contract of contracts) {
    Memory.contracts[contract.id] = contract;
  }
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
export function loadContracts(): Contract[] {
  if (!Memory.contracts) return [];

  const contracts: Contract[] = [];
  for (const contractId in Memory.contracts) {
    contracts.push(Memory.contracts[contractId]);
  }
  return contracts;
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
 *
 * 1. Hydrate corps from memory (done by CorpRunner before this)
 * 2. Run each corp's work loop
 * 3. Update contract progress
 *
 * Note: Corps are already hydrated by CorpRunner functions.
 * This function provides the execution context from stored contracts.
 *
 * @param corps - The corp registry with hydrated corps
 * @param tick - Current game tick
 * @returns Execution result
 */
export function runExecutionPhase(
  corps: CorpRegistry,
  tick: number
): ExecutionResult {
  // Load stored contracts
  const contracts = loadContracts();

  // Filter to active contracts
  const activeContracts = contracts.filter(c =>
    tick < c.startTick + c.duration && c.delivered < c.quantity
  );

  // Note: Actual corp work is done by CorpRunner.run*Corps() functions
  // This is the integration point for contract-aware execution

  return {
    corpsRun: countCorps(corps),
    contractsUpdated: activeContracts.length
  };
}

/**
 * Count total corps in registry.
 */
function countCorps(corps: CorpRegistry): number {
  let count = 0;
  count += Object.keys(corps.miningCorps).length;
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
    mining: number;
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
 *
 * Surveys all nodes in the colony and creates corps based on resources:
 * - Source -> MiningCorp (one per source)
 * - Controller -> UpgradingCorp (one per room)
 * - Spawn -> SpawningCorp (one per spawn)
 * - Owned room -> HaulingCorp (one per room)
 *
 * @param colony - The colony with nodes to survey
 * @param corps - The corp registry to populate
 * @param tick - Current game tick
 * @returns Survey result
 */
export function runSurveyPhase(
  colony: Colony,
  corps: CorpRegistry,
  tick: number
): SurveyResult {
  console.log(`[Survey] Running survey phase at tick ${tick}`);

  const result: SurveyResult = {
    nodesSurveyed: 0,
    corpsCreated: { mining: 0, hauling: 0, upgrading: 0, spawning: 0 },
    resourcesFound: { sources: 0, controllers: 0, spawns: 0 }
  };

  const nodes = colony.getNodes();

  // Track rooms we've processed (for hauling/upgrading which are per-room)
  const processedRooms = new Set<string>();

  for (const node of nodes) {
    result.nodesSurveyed++;

    // Get room visibility
    const room = Game.rooms[node.roomName];
    if (!room) continue;

    // Only create corps for owned rooms
    if (!room.controller?.my) continue;

    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;

    const spawn = spawns[0];

    // Survey node resources and create corps
    for (const resource of node.resources) {
      switch (resource.type) {
        case "source":
          result.resourcesFound.sources++;
          // Create mining corp if not exists
          if (!corps.miningCorps[resource.id]) {
            const source = Game.getObjectById(resource.id as Id<Source>);
            if (source) {
              const miningCorp = createRealMiningCorp(room, spawn, source);
              miningCorp.createdAt = tick;
              corps.miningCorps[resource.id] = miningCorp;
              result.corpsCreated.mining++;
              console.log(`[Survey] Created MiningCorp for source ${resource.id.slice(-4)}`);
            }
          }
          break;

        case "controller":
          result.resourcesFound.controllers++;
          break;

        case "spawn":
          result.resourcesFound.spawns++;
          // Create spawning corp if not exists
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

    // Create room-level corps (hauling, upgrading) once per room
    if (!processedRooms.has(node.roomName)) {
      processedRooms.add(node.roomName);

      // Create hauling corp if not exists
      if (!corps.haulingCorps[node.roomName]) {
        const haulingCorp = createRealHaulingCorp(room, spawn);
        haulingCorp.createdAt = tick;
        corps.haulingCorps[node.roomName] = haulingCorp;
        result.corpsCreated.hauling++;
        console.log(`[Survey] Created HaulingCorp for room ${node.roomName}`);
      }

      // Create upgrading corp if not exists
      if (!corps.upgradingCorps[node.roomName]) {
        const upgradingCorp = createRealUpgradingCorp(room, spawn);
        upgradingCorp.createdAt = tick;
        corps.upgradingCorps[node.roomName] = upgradingCorp;
        result.corpsCreated.upgrading++;
        console.log(`[Survey] Created UpgradingCorp for room ${node.roomName}`);
      }
    }
  }

  console.log(`[Survey] Surveyed ${result.nodesSurveyed} nodes, created ${
    result.corpsCreated.mining + result.corpsCreated.hauling +
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
  const contracts = loadContracts();

  return {
    lastSurveyTick: getLastSurveyTick(),
    lastPlanningTick: getLastPlanningTick(),
    activeChains: chains.length,
    activeContracts: contracts.filter(c =>
      Game.time < c.startTick + c.duration && c.delivered < c.quantity
    ).length,
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
