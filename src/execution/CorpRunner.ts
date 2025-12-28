/**
 * @fileoverview Corp lifecycle management.
 *
 * This module handles creation, restoration, and execution of all corps.
 * It consolidates the repeated patterns of getting-or-creating corps
 * and running their work loops.
 *
 * @module execution/CorpRunner
 */

import "../types/Memory";
import {
  BootstrapCorp,
  createBootstrapCorp,
  SerializedBootstrapCorp,
  HarvestCorp,
  createHarvestCorp,
  SerializedHarvestCorp,
  CarryCorp,
  createCarryCorp,
  SerializedCarryCorp,
  UpgradingCorp,
  createUpgradingCorp,
  SerializedUpgradingCorp,
  ScoutCorp,
  createScoutCorp,
  SerializedScoutCorp,
  ConstructionCorp,
  createConstructionCorp,
  SerializedConstructionCorp,
  SpawningCorp,
  createSpawningCorp,
  SerializedSpawningCorp,
  SpawnableCreepType,
} from "../corps";
import { getMinableSources } from "../analysis";
import { getMaxSpawnCapacity } from "../planning/EconomicConstants";

/**
 * Container for all active corps, organized by type.
 */
export interface CorpRegistry {
  bootstrapCorps: { [roomName: string]: BootstrapCorp };
  harvestCorps: { [sourceId: string]: HarvestCorp };
  haulingCorps: { [roomName: string]: CarryCorp };
  upgradingCorps: { [roomName: string]: UpgradingCorp };
  scoutCorps: { [roomName: string]: ScoutCorp };
  constructionCorps: { [roomName: string]: ConstructionCorp };
  spawningCorps: { [spawnId: string]: SpawningCorp };
}

/**
 * Creates a new empty corp registry.
 */
export function createCorpRegistry(): CorpRegistry {
  return {
    bootstrapCorps: {},
    harvestCorps: {},
    haulingCorps: {},
    upgradingCorps: {},
    scoutCorps: {},
    constructionCorps: {},
    spawningCorps: {},
  };
}

/**
 * Run bootstrap corps for all owned rooms.
 *
 * Bootstrap corps are the fallback - they create simple jack creeps
 * that harvest energy and return it to spawn.
 */
export function runBootstrapCorps(registry: CorpRegistry): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];

    // Only process owned rooms with spawns
    if (!room.controller?.my) continue;
    if (room.find(FIND_MY_SPAWNS).length === 0) continue;

    // Get or create bootstrap corp for this room
    let bootstrapCorp = registry.bootstrapCorps[roomName];

    if (!bootstrapCorp) {
      // Try to restore from memory
      const saved = Memory.bootstrapCorps?.[roomName];
      if (saved) {
        const spawns = room.find(FIND_MY_SPAWNS);
        const sources = room.find(FIND_SOURCES);
        if (spawns.length > 0 && sources.length > 0) {
          // Pass saved.id as customId to preserve the original ID
          bootstrapCorp = new BootstrapCorp(
            saved.nodeId,
            saved.spawnId,
            saved.sourceId,
            saved.id
          );
          bootstrapCorp.deserialize(saved);
          registry.bootstrapCorps[roomName] = bootstrapCorp;
        }
      }

      // Create new if still missing
      if (!bootstrapCorp) {
        const newCorp = createBootstrapCorp(room);
        if (newCorp) {
          newCorp.createdAt = Game.time;
          registry.bootstrapCorps[roomName] = newCorp;
          bootstrapCorp = newCorp;
          console.log(`[Bootstrap] Created corp for ${roomName}`);
        }
      }
    }

    // Run the bootstrap corp
    if (bootstrapCorp) {
      bootstrapCorp.work(Game.time);
    }
  }
}

/**
 * Run real corps (mining, hauling, upgrading) for all owned rooms.
 *
 * These corps work together:
 * - Mining: Harvests energy and drops it
 * - Hauling: Picks up energy and delivers to spawn/controller
 * - Upgrading: Picks up energy near controller and upgrades
 */
export function runRealCorps(registry: CorpRegistry): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];

    // Only process owned rooms with spawns
    if (!room.controller?.my) continue;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;

    const spawn = spawns[0];
    const sources = getMinableSources(room);

    // Initialize and run harvest corps (one per source, excludes source keeper sources)
    for (const source of sources) {
      let harvestCorp = registry.harvestCorps[source.id];

      if (!harvestCorp) {
        // Try to restore from memory
        const saved = Memory.harvestCorps?.[source.id];
        if (saved) {
          // Pass saved.id as customId to preserve the original ID
          harvestCorp = new HarvestCorp(saved.nodeId, saved.spawnId, saved.sourceId, saved.desiredWorkParts, saved.id);
          harvestCorp.deserialize(saved);
          registry.harvestCorps[source.id] = harvestCorp;
        } else {
          // Create new
          harvestCorp = createHarvestCorp(room, spawn, source);
          harvestCorp.createdAt = Game.time;
          registry.harvestCorps[source.id] = harvestCorp;
          console.log(`[Harvest] Created corp for source ${source.id.slice(-4)} in ${roomName}`);
        }
      }

      // Run periodic planning if needed
      if (harvestCorp.shouldPlan(Game.time)) {
        harvestCorp.plan(Game.time);
      }
      harvestCorp.work(Game.time);
    }

    // Initialize and run hauling corp (one per room)
    let haulingCorp = registry.haulingCorps[roomName];

    if (!haulingCorp) {
      const saved = Memory.haulingCorps?.[roomName];
      if (saved) {
        // Pass saved.id as customId to preserve the original ID
        haulingCorp = new CarryCorp(saved.nodeId, saved.spawnId, saved.id);
        haulingCorp.deserialize(saved);
        registry.haulingCorps[roomName] = haulingCorp;
      } else {
        haulingCorp = createCarryCorp(room, spawn);
        haulingCorp.createdAt = Game.time;
        registry.haulingCorps[roomName] = haulingCorp;
        console.log(`[Hauling] Created corp for ${roomName}`);
      }
    }

    // Run periodic planning if needed
    if (haulingCorp.shouldPlan(Game.time)) {
      haulingCorp.plan(Game.time);
    }
    haulingCorp.work(Game.time);

    // Initialize and run upgrading corp (one per room)
    let upgradingCorp = registry.upgradingCorps[roomName];

    if (!upgradingCorp) {
      const saved = Memory.upgradingCorps?.[roomName];
      if (saved) {
        // Pass saved.id as customId to preserve the original ID
        upgradingCorp = new UpgradingCorp(saved.nodeId, saved.spawnId, saved.id);
        upgradingCorp.deserialize(saved);
        registry.upgradingCorps[roomName] = upgradingCorp;
      } else {
        upgradingCorp = createUpgradingCorp(room, spawn);
        upgradingCorp.createdAt = Game.time;
        registry.upgradingCorps[roomName] = upgradingCorp;
        console.log(`[Upgrading] Created corp for ${roomName}`);
      }
    }

    // Run periodic planning if needed
    if (upgradingCorp.shouldPlan(Game.time)) {
      upgradingCorp.plan(Game.time);
    }
    upgradingCorp.work(Game.time);
  }
}

/**
 * Run scout corps for all owned rooms.
 *
 * Scout corps create minimal creeps (1 MOVE) that explore nearby rooms
 * to gather intel about sources, minerals, hostiles, etc.
 */
export function runScoutCorps(registry: CorpRegistry): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];

    // Only process owned rooms with spawns
    if (!room.controller?.my) continue;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;

    // Get or create scout corp for this room
    let scoutCorp = registry.scoutCorps[roomName];

    if (!scoutCorp) {
      // Try to restore from memory
      const saved = Memory.scoutCorps?.[roomName];
      if (saved) {
        // Pass saved.id as customId to preserve the original ID
        scoutCorp = new ScoutCorp(saved.nodeId, saved.spawnId, saved.id);
        scoutCorp.deserialize(saved);
        registry.scoutCorps[roomName] = scoutCorp;
      } else {
        // Create new
        const newCorp = createScoutCorp(room);
        if (newCorp) {
          newCorp.createdAt = Game.time;
          registry.scoutCorps[roomName] = newCorp;
          scoutCorp = newCorp;
          console.log(`[Scout] Created corp for ${roomName}`);
        }
      }
    }

    // Run the scout corp
    if (scoutCorp) {
      scoutCorp.work(Game.time);

      // Request scout spawns if needed
      const spawn = spawns[0];
      const spawningCorp = registry.spawningCorps[spawn.id];
      if (spawningCorp) {
        scoutCorp.requestSpawnsIfNeeded(spawningCorp, Game.time);
      }
    }
  }
}

/**
 * Run construction corps for all owned rooms.
 *
 * Construction corps build extensions when there's profit available.
 * They place extensions along walls to stay out of the way.
 */
export function runConstructionCorps(registry: CorpRegistry): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];

    // Only process owned rooms with spawns
    if (!room.controller?.my) continue;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;

    const spawn = spawns[0];

    // Get or create construction corp for this room
    let constructionCorp = registry.constructionCorps[roomName];

    if (!constructionCorp) {
      // Try to restore from memory
      const saved = Memory.constructionCorps?.[roomName];
      if (saved) {
        // Pass saved.id as customId to preserve the original ID
        constructionCorp = new ConstructionCorp(saved.nodeId, saved.spawnId, saved.id);
        constructionCorp.deserialize(saved);
        registry.constructionCorps[roomName] = constructionCorp;
      } else {
        // Create new
        constructionCorp = createConstructionCorp(room, spawn);
        constructionCorp.createdAt = Game.time;
        registry.constructionCorps[roomName] = constructionCorp;
        console.log(`[Construction] Created corp for ${roomName}`);
      }
    }

    // Run periodic planning if needed
    if (constructionCorp.shouldPlan(Game.time)) {
      constructionCorp.plan(Game.time);
    }
    constructionCorp.work(Game.time);
  }
}

/**
 * Run spawning corps for all owned rooms.
 *
 * Spawning corps manage spawn structures and sell spawning capacity.
 * They process queued spawn orders from market contracts.
 */
export function runSpawningCorps(registry: CorpRegistry): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];

    // Only process owned rooms with spawns
    if (!room.controller?.my) continue;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;

    // Create/restore spawning corp for each spawn
    for (const spawn of spawns) {
      let spawningCorp = registry.spawningCorps[spawn.id];

      if (!spawningCorp) {
        // Try to restore from memory
        const saved = Memory.spawningCorps?.[spawn.id];
        if (saved) {
          // Pass saved.id as customId to preserve the original ID
          spawningCorp = new SpawningCorp(saved.nodeId, spawn.id, saved.energyCapacity, saved.id);
          spawningCorp.deserialize(saved);
          registry.spawningCorps[spawn.id] = spawningCorp;
        } else {
          // Create new
          spawningCorp = createSpawningCorp(spawn);
          spawningCorp.createdAt = Game.time;
          registry.spawningCorps[spawn.id] = spawningCorp;
          console.log(`[Spawning] Created corp for spawn ${spawn.name} in ${roomName}`);
        }
      }

      // Run the spawning corp (processes pending orders)
      spawningCorp.work(Game.time);
    }
  }
}

/**
 * Log corp statistics.
 */
export function logCorpStats(registry: CorpRegistry): void {
  let totalJacks = 0;
  for (const roomName in registry.bootstrapCorps) {
    totalJacks += registry.bootstrapCorps[roomName].getCreepCount();
  }
  console.log(`  Bootstrap Jacks: ${totalJacks}`);

  let totalHarvesters = 0;
  let totalHaulers = 0;
  let totalUpgraders = 0;

  for (const sourceId in registry.harvestCorps) {
    totalHarvesters += registry.harvestCorps[sourceId].getCreepCount();
  }
  for (const roomName in registry.haulingCorps) {
    totalHaulers += registry.haulingCorps[roomName].getCreepCount();
  }
  for (const roomName in registry.upgradingCorps) {
    totalUpgraders += registry.upgradingCorps[roomName].getCreepCount();
  }

  let totalScouts = 0;
  for (const roomName in registry.scoutCorps) {
    totalScouts += registry.scoutCorps[roomName].getCreepCount();
  }

  let totalBuilders = 0;
  for (const roomName in registry.constructionCorps) {
    totalBuilders += registry.constructionCorps[roomName].getCreepCount();
  }

  console.log(`  Harvesters: ${totalHarvesters}, Haulers: ${totalHaulers}, Upgraders: ${totalUpgraders}, Scouts: ${totalScouts}, Builders: ${totalBuilders}`);
}

// =============================================================================
// SPAWN CALCULATION HELPERS
// =============================================================================

/**
 * Result of calculating spawn requirements for a creep type.
 * Used to distribute body parts across multiple smaller creeps when
 * the room's energy capacity can't support one large creep.
 */
interface SpawnRequirements {
  /** Total body parts needed (WORK for miners, CARRY for haulers) */
  totalPartsNeeded: number;
  /** Maximum parts per creep based on energy capacity */
  maxPartsPerCreep: number;
  /** Target number of creeps to spawn */
  targetCreeps: number;
  /** Parts per creep (distributed evenly) */
  partsPerCreep: number;
  /** How many more creeps needed */
  creepsNeeded: number;
}

/**
 * Calculate spawn requirements for distributing body parts across multiple creeps.
 *
 * This handles the early-game scenario where we need more body parts than
 * a single creep can hold given the room's energy capacity.
 *
 * @param totalPartsNeeded - Total body parts required for the operation
 * @param maxPartsPerCreep - Maximum parts per creep (based on energy capacity or spatial limits)
 * @param currentCreepCount - Number of creeps already spawned
 * @returns SpawnRequirements with calculated distribution
 */
function calculateSpawnRequirements(
  totalPartsNeeded: number,
  maxPartsPerCreep: number,
  currentCreepCount: number
): SpawnRequirements {
  // Target creeps: how many needed to cover all parts (at least 1)
  const targetCreeps = Math.max(1, Math.ceil(totalPartsNeeded / maxPartsPerCreep));

  // Distribute parts evenly across creeps
  const partsPerCreep = Math.ceil(totalPartsNeeded / targetCreeps);

  // How many more creeps do we need?
  const creepsNeeded = Math.max(0, targetCreeps - currentCreepCount);

  return {
    totalPartsNeeded,
    maxPartsPerCreep,
    targetCreeps,
    partsPerCreep,
    creepsNeeded,
  };
}

/**
 * Calculate max CARRY parts per hauler based on energy capacity.
 * Hauler body: CARRY + MOVE pairs (100 energy each)
 */
function calculateMaxHaulerCarryParts(energyCapacity: number): number {
  // CARRY=50, MOVE=50 = 100 per CARRY part, max 25 pairs (50 body parts)
  return Math.min(25, Math.floor(energyCapacity / 100));
}

// =============================================================================
// MAIN SPAWN REQUEST FUNCTION
// =============================================================================

/**
 * Request creeps from SpawningCorp based on flow assignments.
 *
 * This bridges the gap between FlowMaterializer (which stores assignments on corps)
 * and SpawningCorp (which spawns creeps from queued orders).
 *
 * Spawn priority (proportional):
 * 1. Spawn miners and haulers proportionally (1 hauler per miner)
 * 2. After all mining pairs complete, spawn upgraders
 *
 * Example with 2 sources:
 *   Miner 1 → Hauler 1 → Miner 2 → Hauler 2 → Upgrader
 *
 * Called every tick to ensure spawn orders are queued when corps need creeps.
 */
export function requestFlowCreeps(registry: CorpRegistry): void {
  // Find the spawning corp to queue orders with
  const spawningCorpIds = Object.keys(registry.spawningCorps);
  if (spawningCorpIds.length === 0) return;

  // Track mining infrastructure status per room
  const roomStats = new Map<string, {
    totalMiners: number;
    totalHaulers: number;
    targetMiners: number;
    targetHaulers: number;
    totalCarryPartsNeeded: number;
    maxCarryPerHauler: number;
    carryPartsPerHauler: number;
    carryCorp: CarryCorp | null;
    haulerAssignments: any[];
    spawningCorp: SpawningCorp | null;
    haulersNeeded: number;
  }>();

  // Build a map of sourceId -> hauler assignment for pairing
  const haulerAssignmentsBySource = new Map<string, { carryCorp: CarryCorp; assignment: any }>();
  for (const roomName in registry.haulingCorps) {
    const carryCorp = registry.haulingCorps[roomName];
    const assignments = carryCorp.getHaulerAssignments();
    if (!assignments) continue;

    for (const assignment of assignments) {
      haulerAssignmentsBySource.set(assignment.fromId, { carryCorp, assignment });
    }

    // Calculate total carry parts needed from all assignments
    const totalCarryPartsNeeded = assignments.reduce((sum: number, a: any) => sum + (a.carryParts || 0), 0);

    // Calculate max carry parts per hauler based on room's max energy capacity
    // Use max capacity for RCL so we plan for full-size creeps even while building extensions
    const room = Game.rooms[roomName];
    const controllerLevel = room?.controller?.level ?? 1;
    const energyCapacity = getMaxSpawnCapacity(controllerLevel);
    const maxCarryPerHauler = calculateMaxHaulerCarryParts(energyCapacity);

    // Use shared helper for spawn distribution calculation
    const currentHaulers = carryCorp.getCreepCount();
    const haulerReqs = calculateSpawnRequirements(totalCarryPartsNeeded, maxCarryPerHauler, currentHaulers);

    // Initialize room stats
    if (!roomStats.has(roomName)) {
      const spawns = Game.rooms[roomName]?.find(FIND_MY_SPAWNS) ?? [];
      roomStats.set(roomName, {
        totalMiners: 0,
        totalHaulers: currentHaulers,
        targetMiners: 0,
        targetHaulers: haulerReqs.targetCreeps,
        totalCarryPartsNeeded: haulerReqs.totalPartsNeeded,
        maxCarryPerHauler: haulerReqs.maxPartsPerCreep,
        carryPartsPerHauler: haulerReqs.partsPerCreep,
        carryCorp,
        haulerAssignments: assignments,
        spawningCorp: spawns.length > 0 ? registry.spawningCorps[spawns[0].id] : null,
        haulersNeeded: haulerReqs.creepsNeeded,
      });
    }
  }

  // First pass: count existing miners and targets per room
  // Now supports multiple miners per source based on maxMiners
  const sourcesNeedingMiners: Array<{
    harvestCorp: HarvestCorp;
    minerAssignment: any;
    roomName: string;
    minersNeeded: number;
    workPartsPerMiner: number;
  }> = [];

  for (const sourceId in registry.harvestCorps) {
    const harvestCorp = registry.harvestCorps[sourceId];
    const minerAssignment = harvestCorp.getMinerAssignment();

    if (!minerAssignment) continue;

    // Determine room from the source position or node
    const roomName = minerAssignment.nodeId.split("-")[0];

    // Initialize room stats if needed
    if (!roomStats.has(roomName)) {
      const spawns = Game.rooms[roomName]?.find(FIND_MY_SPAWNS) ?? [];
      const room = Game.rooms[roomName];
      const controllerLevel = room?.controller?.level ?? 1;
      const energyCapacity = getMaxSpawnCapacity(controllerLevel);
      const maxCarryPerHauler = Math.min(25, Math.floor(energyCapacity / 100));
      roomStats.set(roomName, {
        totalMiners: 0,
        totalHaulers: 0,
        targetMiners: 0,
        targetHaulers: 0,
        totalCarryPartsNeeded: 0,
        maxCarryPerHauler,
        carryPartsPerHauler: 0,
        carryCorp: null,
        haulerAssignments: [],
        spawningCorp: spawns.length > 0 ? registry.spawningCorps[spawns[0].id] : null,
        haulersNeeded: 0,
      });
    }

    const stats = roomStats.get(roomName)!;

    // Calculate target work parts (harvestRate / 2 energy per WORK per tick)
    const totalWorkPartsNeeded = Math.ceil(minerAssignment.harvestRate / 2);

    // Max miners limited by mining spots (spatial constraint)
    const maxMiners = minerAssignment.maxMiners || 1;

    // For miners: target is maxMiners (spatial limit), not work parts / capacity
    // Each miner should have enough WORK parts to fully utilize the source
    const currentMinerCount = harvestCorp.getCreepCount();
    const targetMiners = maxMiners;  // We want exactly maxMiners creeps at this source
    const minersNeeded = Math.max(0, targetMiners - currentMinerCount);
    const workPartsPerMiner = Math.ceil(totalWorkPartsNeeded / targetMiners);

    stats.targetMiners += targetMiners;
    stats.totalMiners += currentMinerCount;

    if (minersNeeded > 0) {
      sourcesNeedingMiners.push({
        harvestCorp,
        minerAssignment,
        roomName,
        minersNeeded,
        workPartsPerMiner,
      });
    }
  }

  // === Proportional spawning: miners and haulers in lockstep ===
  for (const [roomName, stats] of roomStats) {
    if (!stats.spawningCorp) continue;

    const pendingCount = stats.spawningCorp.getPendingOrderCount();
    if (pendingCount >= 2) continue; // Keep queue small for responsiveness

    // Target haulers = number of miners that exist (proportional)
    const targetHaulersForCurrentMiners = Math.min(stats.totalMiners, stats.targetHaulers);

    // Check if ANY source in this room needs miners (per-source check, not room total)
    // This handles imbalanced distribution where one source has excess and another has deficit
    const sourceNeedingMiner = sourcesNeedingMiners.find(s => s.roomName === roomName);
    const anySourceNeedsMiners = sourceNeedingMiner !== undefined;

    // Room-level checks for haulers
    const needMoreHaulers = stats.totalHaulers < targetHaulersForCurrentMiners;

    if (anySourceNeedsMiners && stats.totalHaulers >= stats.totalMiners) {
      // Haulers caught up to miners, spawn next miner for source that needs it
      const sourceInfo = sourceNeedingMiner!;
      // Use pre-calculated work parts per miner (accounts for multi-miner sources)
      const workParts = sourceInfo.workPartsPerMiner;
      stats.spawningCorp.queueSpawnOrder({
        buyerCorpId: sourceInfo.harvestCorp.id,
        creepType: "miner",
        workTicksRequested: workParts,
        queuedAt: Game.time,
      });
      const maxMiners = sourceInfo.minerAssignment.maxMiners || 1;
      console.log(`[FlowSpawn] Queued miner for ${sourceInfo.harvestCorp.id} (${workParts} WORK, max ${maxMiners} miners)`);
      // Decrement miners needed, remove from list when done
      sourceInfo.minersNeeded--;
      if (sourceInfo.minersNeeded <= 0) {
        const idx = sourcesNeedingMiners.indexOf(sourceInfo);
        if (idx >= 0) sourcesNeedingMiners.splice(idx, 1);
      }
    } else if (needMoreHaulers && stats.carryCorp && stats.totalMiners > 0 && stats.haulersNeeded > 0) {
      // Have miners without matching haulers, spawn hauler
      // Use distributed carry parts (accounts for multi-hauler when capacity is limited)
      const carryParts = stats.carryPartsPerHauler;
      stats.spawningCorp.queueSpawnOrder({
        buyerCorpId: stats.carryCorp.id,
        creepType: "hauler",
        workTicksRequested: carryParts,
        haulDemandRequested: carryParts,
        queuedAt: Game.time,
      });
      console.log(`[FlowSpawn] Queued hauler for ${stats.carryCorp.id} (${carryParts} CARRY, ${stats.haulersNeeded} needed, max ${stats.maxCarryPerHauler}/hauler)`);
      stats.haulersNeeded--;
    } else if (anySourceNeedsMiners) {
      // No haulers needed yet, just spawn miners for source that needs it
      const sourceInfo = sourceNeedingMiner!;
      // Use pre-calculated work parts per miner (accounts for multi-miner sources)
      const workParts = sourceInfo.workPartsPerMiner;
      stats.spawningCorp.queueSpawnOrder({
        buyerCorpId: sourceInfo.harvestCorp.id,
        creepType: "miner",
        workTicksRequested: workParts,
        queuedAt: Game.time,
      });
      const maxMiners = sourceInfo.minerAssignment.maxMiners || 1;
      console.log(`[FlowSpawn] Queued miner for ${sourceInfo.harvestCorp.id} (${workParts} WORK, max ${maxMiners} miners)`);
      // Decrement miners needed, remove from list when done
      sourceInfo.minersNeeded--;
      if (sourceInfo.minersNeeded <= 0) {
        const idx = sourcesNeedingMiners.indexOf(sourceInfo);
        if (idx >= 0) sourcesNeedingMiners.splice(idx, 1);
      }
    }
  }

  // === Spawn builders/upgraders when at least one miner-hauler pair is working ===
  // At RCL 2+: prioritize builders to get extensions built (increases spawn capacity)
  // At RCL 1: prioritize upgraders to reach RCL 2
  for (const [roomName, stats] of roomStats) {
    const room = Game.rooms[roomName];
    const rcl = room?.controller?.level ?? 1;

    // Early game: just need 1 working pair to start building/upgrading
    // Later game: wait for full mining infrastructure to be efficient
    const hasWorkingPair = stats.totalMiners >= 1 && stats.totalHaulers >= 1;
    const miningFullyComplete = stats.targetMiners > 0 &&
                                stats.totalMiners >= stats.targetMiners &&
                                stats.totalHaulers >= stats.targetHaulers;

    const canSpawnWorker = rcl <= 2 ? hasWorkingPair : miningFullyComplete;
    if (!canSpawnWorker) continue;

    if (!stats.spawningCorp) continue;

    const pendingCount = stats.spawningCorp.getPendingOrderCount();
    if (pendingCount >= 2) continue;

    // At RCL 2+, check if we need builders (extensions not maxed out)
    const constructionCorp = registry.constructionCorps[roomName];
    const upgradingCorp = registry.upgradingCorps[roomName];

    // At RCL 3+, spawn dedicated builders for construction
    // At RCL 2, upgraders handle both building and upgrading
    if (rcl >= 3 && constructionCorp) {
      const constructionSites = room.find(FIND_MY_CONSTRUCTION_SITES);
      const currentBuilders = constructionCorp.getCreepCount();

      // Spawn builders if there are construction sites and we don't have enough builders
      if (constructionSites.length > 0 && currentBuilders < 1) {
        stats.spawningCorp.queueSpawnOrder({
          buyerCorpId: constructionCorp.id,
          creepType: "builder",
          workTicksRequested: 2, // 2 WORK parts for builders
          queuedAt: Game.time,
        });
        console.log(`[FlowSpawn] Queued builder for ${constructionCorp.id} (${constructionSites.length} sites)`);
        continue;
      }
    }

    // Spawn upgrader if no builder needed
    if (!upgradingCorp) continue;

    const allocation = upgradingCorp.getSinkAllocation();
    // At RCL 1-2, spawn upgraders even without flow allocation (bootstrap)
    // At higher RCL, require proper flow allocation
    const hasAllocation = allocation && allocation.allocated > 0;
    if (rcl > 2 && !hasAllocation) continue;

    const currentCreeps = upgradingCorp.getCreepCount();
    if (currentCreeps >= 1) continue; // Already have an upgrader

    // Use allocation if available, otherwise default to 2 WORK for early game
    const workParts = hasAllocation ? Math.ceil(allocation.allocated) : 2;
    stats.spawningCorp.queueSpawnOrder({
      buyerCorpId: upgradingCorp.id,
      creepType: "upgrader",
      workTicksRequested: Math.min(workParts, 5),
      queuedAt: Game.time,
    });
    console.log(`[FlowSpawn] Queued upgrader for ${upgradingCorp.id} (${Math.min(workParts, 5)} WORK)`);
  }
}
