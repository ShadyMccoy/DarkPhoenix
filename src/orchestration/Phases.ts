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
 * Survey phase is triggered when new nodes are created.
 * This happens during recalculateTerrain() -> runIncrementalAnalysis().
 *
 * The survey creates corps based on node resources:
 * - Source -> MiningCorp
 * - Controller -> UpgradingCorp
 * - Spawn -> SpawningCorp
 * - Territory paths -> HaulingCorp
 *
 * Currently, CorpRunner handles this implicitly by scanning rooms.
 * Future: Make this explicit via Node.survey() -> create corps.
 */

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
