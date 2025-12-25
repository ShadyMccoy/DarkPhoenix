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
import { OfferCollector } from "../planning/OfferCollector";
import { SerializedChain, Chain, ChainSegment, deserializeChain, serializeChain } from "../planning/Chain";
import { Contract, CreepSpec } from "../market/Contract";
import { AnyCorpState } from "../corps/CorpState";
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
  // Check if any corps exist in the registry
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
 *
 * This is a lazy initialization that only runs when the global cache
 * is empty (typically after a code push that resets module state).
 *
 * Corps are hydrated from their serialized state in Memory.
 * If Memory is also empty, corps will be created by the survey phase.
 *
 * @param corps - The corp registry to populate
 * @returns Init result
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

  // Check if init is needed
  if (!needsInit(corps)) {
    return result;
  }

  result.wasNeeded = true;
  console.log(`[Init] Hydrating corps from Memory (cache was empty)`);

  // Clean up legacy resource types from Memory.contracts if present
  if (Memory.contracts) {
    const legacyResources = ["work-ticks", "carry-ticks", "move-ticks"];
    for (const contractId in Memory.contracts) {
      const contract = Memory.contracts[contractId];
      if (contract && legacyResources.includes(contract.resource)) {
        delete Memory.contracts[contractId];
        console.log(`[Init] Removed legacy contract: ${contractId}`);
      }
    }
  }

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

  // Hydrate hauling corps
  if (Memory.haulingCorps) {
    for (const roomName in Memory.haulingCorps) {
      const saved = Memory.haulingCorps[roomName];
      if (saved && !corps.haulingCorps[roomName]) {
        const haulingCorp = new CarryCorp(saved.nodeId, saved.spawnId);
        haulingCorp.deserialize(saved);
        corps.haulingCorps[roomName] = haulingCorp;
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

  // Collect all corp states from Real*Corps
  const corpStates = collectCorpStates(corps);

  // Create offer collector and populate from corp states
  const collector = new OfferCollector();
  collector.collectFromCorpStates(corpStates, tick);

  // Debug: Log what offers were collected
  const stats = collector.getStats();
  console.log(`[Planning] Collected ${stats.totalOffers} offers (${stats.sellOffers} sell, ${stats.buyOffers} buy)`);
  for (const resource in stats.resources) {
    const r = stats.resources[resource];
    console.log(`  ${resource}: ${r.sellCount} sell (qty ${r.sellQuantity}), ${r.buyCount} buy (qty ${r.buyQuantity})`);
  }

  // Get mint values from colony
  const mintValues = colony.getMintValues();
  console.log(`[Planning] Mint values: rcl_upgrade=${mintValues.rcl_upgrade}, gcl_upgrade=${mintValues.gcl_upgrade}`);

  // Create planner with collector and mint values
  const planner = new ChainPlanner(collector, mintValues);

  // Register corp states with planner
  // Note: Don't call registerNodes() after this - it clears corpStateRegistry!
  // Economic edges require a NodeNavigator to be set via planner.setNavigator()
  planner.registerCorpStates(corpStates, tick);
  console.log(`[Planning] Registered ${corpStates.length} corp states`);

  // Find viable chains (profit > 0)
  const chains = planner.findViableChains(tick);

  // Convert chains to contracts for execution
  const contracts = chainsToContracts(chains, tick);

  // Store in Memory
  storeChains(chains);
  storeContracts(contracts);

  // Assign contracts to corps for execution
  // This is the key step that makes ChainPlanner contracts executable
  const assignedCount = assignContractsToCorps(contracts, corps);

  console.log(`[Planning] Found ${chains.length} chains, ${contracts.length} contracts (${assignedCount} assigned)`);

  return {
    chains,
    contracts,
    planningTick: tick
  };
}

/**
 * Collect corp states from all corps in the registry.
 *
 * All corps with toCorpState() are included for chain planning:
 * - SpawningCorp: origin of labor (sells spawn-capacity)
 * - MiningCorp: extracts energy (buys spawn-capacity, sells energy)
 * - HaulingCorp: transports energy (buys spawn-capacity, sells delivered-energy)
 * - UpgradingCorp: upgrades controller (buys spawn-capacity + delivered-energy, sells rcl-progress)
 */
function collectCorpStates(corps: CorpRegistry): AnyCorpState[] {
  const states: AnyCorpState[] = [];

  // Spawning corps - origin of labor in production chains
  for (const spawnId in corps.spawningCorps) {
    const corp = corps.spawningCorps[spawnId];
    states.push(corp.toCorpState());
  }

  // Harvest corps
  for (const sourceId in corps.harvestCorps) {
    const corp = corps.harvestCorps[sourceId];
    states.push(corp.toCorpState());
  }

  // Hauling corps
  for (const roomName in corps.haulingCorps) {
    const corp = corps.haulingCorps[roomName];
    states.push(corp.toCorpState());
  }

  // Upgrading corps
  for (const roomName in corps.upgradingCorps) {
    const corp = corps.upgradingCorps[roomName];
    states.push(corp.toCorpState());
  }

  return states;
}

/**
 * Derive creepSpec from buyer's corp type.
 * Used when creating spawn-capacity contracts so SpawningCorp knows what to spawn.
 */
function getCreepSpecForBuyer(buyerSegment: ChainSegment): CreepSpec | undefined {
  switch (buyerSegment.corpType) {
    case "mining":
      return { role: "miner", workParts: 5 };
    case "hauling":
      return { role: "hauler", carryParts: 8 };
    case "upgrading":
      return { role: "upgrader", workParts: 2 };
    case "building":
      return { role: "builder", workParts: 2 };
    case "scout":
      return { role: "scout", moveParts: 1 };
    default:
      return undefined;
  }
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

      // Default maxCreeps: 1 for work-ticks (mining spots), 999 for others
      const maxCreeps = seller.resource === "work-ticks" ? 1 : 999;

      // For spawn-capacity contracts, derive creepSpec from buyer's corp type
      const creepSpec = seller.resource === "spawn-capacity"
        ? getCreepSpecForBuyer(buyer)
        : undefined;

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
        paid: 0,
        creepIds: [],
        maxCreeps,
        pendingRequests: 0,
        claimed: 0,
        travelTime: 0, // TODO: Calculate from seller/buyer positions
        creepSpec
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
 * Find a corp by ID in the registry.
 * Returns the corp if found, undefined otherwise.
 */
function findCorpById(corpId: string, corps: CorpRegistry): { addContract: (c: Contract) => void } | undefined {
  // Check each corp type registry
  for (const id in corps.harvestCorps) {
    if (corps.harvestCorps[id].id === corpId) return corps.harvestCorps[id];
  }
  for (const id in corps.haulingCorps) {
    if (corps.haulingCorps[id].id === corpId) return corps.haulingCorps[id];
  }
  for (const id in corps.upgradingCorps) {
    if (corps.upgradingCorps[id].id === corpId) return corps.upgradingCorps[id];
  }
  for (const id in corps.spawningCorps) {
    if (corps.spawningCorps[id].id === corpId) return corps.spawningCorps[id];
  }
  for (const id in corps.constructionCorps) {
    if (corps.constructionCorps[id].id === corpId) return corps.constructionCorps[id];
  }
  for (const id in corps.bootstrapCorps) {
    if (corps.bootstrapCorps[id].id === corpId) return corps.bootstrapCorps[id];
  }
  for (const id in corps.scoutCorps) {
    if (corps.scoutCorps[id].id === corpId) return corps.scoutCorps[id];
  }
  return undefined;
}

/**
 * Assign contracts to corps for execution.
 *
 * This is the key integration point that makes ChainPlanner contracts executable.
 * Each contract is assigned to both the seller and buyer corps.
 *
 * @returns Number of contract assignments made (2 per contract if both corps found)
 */
function assignContractsToCorps(contracts: Contract[], corps: CorpRegistry): number {
  let assigned = 0;

  for (const contract of contracts) {
    const seller = findCorpById(contract.sellerId, corps);
    const buyer = findCorpById(contract.buyerId, corps);

    if (seller) {
      seller.addContract(contract);
      assigned++;
    } else {
      console.log(`[Planning] Warning: Seller corp not found: ${contract.sellerId}`);
    }

    if (buyer) {
      buyer.addContract(contract);
      assigned++;
    } else {
      console.log(`[Planning] Warning: Buyer corp not found: ${contract.buyerId}`);
    }
  }

  return assigned;
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
    corpsCreated: { harvest: 0, hauling: 0, upgrading: 0, spawning: 0 },
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
          // Create harvest corp if not exists
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
        const haulingCorp = createCarryCorp(room, spawn);
        haulingCorp.createdAt = tick;
        corps.haulingCorps[node.roomName] = haulingCorp;
        result.corpsCreated.hauling++;
        console.log(`[Survey] Created HaulingCorp for room ${node.roomName}`);
      }

      // Create upgrading corp if not exists
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
