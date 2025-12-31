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
  SerializedHarvestCorp,
  CarryCorp,
  SerializedCarryCorp,
  HaulerCorp,
  SerializedHaulerCorp,
  TankerCorp,
  SerializedTankerCorp,
  createTankerCorp,
  UpgradingCorp,
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
import { getMaxSpawnCapacity } from "../planning/EconomicConstants";
import { MAX_SCOUTS } from "../corps/CorpConstants";

/**
 * Container for all active corps, organized by type.
 */
export interface CorpRegistry {
  bootstrapCorps: { [roomName: string]: BootstrapCorp };
  harvestCorps: { [sourceId: string]: HarvestCorp };
  /** Hauling corps keyed by source ID (each source has its own CarryCorp) - LEGACY */
  haulingCorps: { [sourceId: string]: CarryCorp };
  /** Edge-based hauler corps keyed by edge ID */
  haulerCorps: { [edgeId: string]: HaulerCorp };
  /** Node-based tanker corps keyed by node ID */
  tankerCorps: { [nodeId: string]: TankerCorp };
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
    haulerCorps: {},
    tankerCorps: {},
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
 * Run real corps (mining, hauling, upgrading).
 *
 * This function is room-agnostic - it runs all corps in the registry.
 * Corps are created by FlowMaterializer based on the flow solution.
 *
 * These corps work together:
 * - Mining: Harvests energy and drops it
 * - Hauling (legacy CarryCorp): Picks up energy and delivers to spawn/controller
 * - Haulers (HaulerCorp): Edge-based transport from source to sink
 * - Tankers (TankerCorp): Node-based local distribution
 * - Upgrading: Picks up energy near controller and upgrades
 */
export function runRealCorps(registry: CorpRegistry): void {
  // Run all HarvestCorps (both local and remote)
  for (const sourceId in registry.harvestCorps) {
    const harvestCorp = registry.harvestCorps[sourceId];
    if (harvestCorp.shouldPlan(Game.time)) {
      harvestCorp.plan(Game.time);
    }
    harvestCorp.work(Game.time);
  }

  // Run all HaulingCorps (legacy CarryCorp)
  for (const sourceId in registry.haulingCorps) {
    const haulingCorp = registry.haulingCorps[sourceId];
    if (haulingCorp.shouldPlan(Game.time)) {
      haulingCorp.plan(Game.time);
    }
    haulingCorp.work(Game.time);
  }

  // Run all HaulerCorps (edge-based transport)
  for (const edgeId in registry.haulerCorps) {
    const haulerCorp = registry.haulerCorps[edgeId];
    haulerCorp.work(Game.time);
  }

  // Run all TankerCorps (node-based distribution)
  for (const nodeId in registry.tankerCorps) {
    const tankerCorp = registry.tankerCorps[nodeId];
    tankerCorp.work(Game.time);
  }

  // Run all UpgradingCorps
  for (const roomName in registry.upgradingCorps) {
    const upgradingCorp = registry.upgradingCorps[roomName];
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
  let totalLegacyHaulers = 0;
  let totalHaulers = 0;
  let totalTankers = 0;
  let totalUpgraders = 0;

  for (const sourceId in registry.harvestCorps) {
    totalHarvesters += registry.harvestCorps[sourceId].getCreepCount();
  }
  for (const sourceId in registry.haulingCorps) {
    totalLegacyHaulers += registry.haulingCorps[sourceId].getCreepCount();
  }
  for (const edgeId in registry.haulerCorps) {
    totalHaulers += registry.haulerCorps[edgeId].getCreepCount();
  }
  for (const nodeId in registry.tankerCorps) {
    totalTankers += registry.tankerCorps[nodeId].getCreepCount();
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

  const allHaulers = totalLegacyHaulers + totalHaulers;
  console.log(`  Harvesters: ${totalHarvesters}, Haulers: ${allHaulers} (${totalHaulers} edge, ${totalTankers} tank), Upgraders: ${totalUpgraders}, Scouts: ${totalScouts}, Builders: ${totalBuilders}`);
}

/**
 * Run tanker corps for all owned rooms with spawns.
 *
 * Tanker corps handle local distribution within a node:
 * - Pick up energy from containers, storage, dropped energy
 * - Deliver to spawns, extensions, towers
 */
export function runTankerCorps(registry: CorpRegistry): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];

    // Only process owned rooms with spawns
    if (!room.controller?.my) continue;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;

    const spawn = spawns[0];
    const nodeId = `${roomName}-tanker`;

    // Get or create tanker corp for this room
    let tankerCorp = registry.tankerCorps[nodeId];

    if (!tankerCorp) {
      // Try to restore from memory
      const saved = Memory.tankerCorps?.[nodeId];
      if (saved) {
        tankerCorp = new TankerCorp(
          saved.nodeId,
          saved.spawnId,
          saved.nodeCenter,
          saved.demand,
          saved.id
        );
        tankerCorp.deserialize(saved);
        registry.tankerCorps[nodeId] = tankerCorp;
      } else {
        // Create new tanker corp
        const nodeCenter = { x: spawn.pos.x, y: spawn.pos.y, roomName };
        tankerCorp = createTankerCorp(nodeId, spawn.id, nodeCenter);
        tankerCorp.createdAt = Game.time;
        registry.tankerCorps[nodeId] = tankerCorp;
        console.log(`[Tanker] Created corp for ${roomName}`);
      }
    }

    // Tanker corps are run in runRealCorps()
  }
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
    // EdgeVariant optimization
    preferredHaulerRatio?: "2:1" | "1:1" | "1:2";
  }>();

  // Build a map of sourceId -> CarryCorp for pairing with HarvestCorps
  // CarryCorps are now keyed by source ID (game ID), not room name
  const carryCorpsBySource = new Map<string, CarryCorp>();
  for (const sourceId in registry.haulingCorps) {
    const carryCorp = registry.haulingCorps[sourceId];
    // The fromId in assignments has "source-" prefix, the registry key is raw game ID
    carryCorpsBySource.set(`source-${sourceId}`, carryCorp);
  }

  // Build a complete list of ALL sources with their efficiency data
  // Includes both sources that need miners and fully staffed sources
  // Each source has its own CarryCorp for independent hauler scaling
  interface SourceInfo {
    harvestCorp: HarvestCorp;
    carryCorp: CarryCorp | null;  // Per-source CarryCorp
    minerAssignment: any;
    roomName: string;
    sourceId: string;
    efficiency: number;  // Mining efficiency % (higher = better, prioritize first)
    currentMiners: number;
    targetMiners: number;
    minersNeeded: number;
    workPartsPerMiner: number;
    carryPartsNeeded: number;  // Hauler carry parts for this source's edge
    currentHaulers: number;    // Current haulers for THIS source
    targetHaulers: number;     // Target haulers for THIS source
    haulersNeeded: number;     // Haulers still needed for THIS source
    carryPartsPerHauler: number;
    preferredHaulerRatio?: "2:1" | "1:1" | "1:2";
  }

  const allSources: SourceInfo[] = [];

  for (const sourceId in registry.harvestCorps) {
    const harvestCorp = registry.harvestCorps[sourceId];
    const minerAssignment = harvestCorp.getMinerAssignment();

    if (!minerAssignment) continue;

    // Get the spawn for this miner assignment
    // Strip "spawn-" prefix from flow sink ID to get actual game ID
    const spawnGameId = minerAssignment.spawnId.replace("spawn-", "");
    const assignedSpawn = Game.getObjectById(spawnGameId as Id<StructureSpawn>);
    if (!assignedSpawn) continue; // Spawn not visible, skip

    // Use the SPAWN's room for stats, not the source's room
    // This ensures remote miners are spawned from owned rooms
    const spawnRoomName = assignedSpawn.room.name;

    // Initialize room stats if needed (keyed by spawn room, not source room)
    if (!roomStats.has(spawnRoomName)) {
      const room = assignedSpawn.room;
      const controllerLevel = room.controller?.level ?? 1;
      const energyCapacity = getMaxSpawnCapacity(controllerLevel);
      const maxCarryPerHauler = Math.min(25, Math.floor(energyCapacity / 100));
      roomStats.set(spawnRoomName, {
        totalMiners: 0,
        totalHaulers: 0,
        targetMiners: 0,
        targetHaulers: 0,
        totalCarryPartsNeeded: 0,
        maxCarryPerHauler,
        carryPartsPerHauler: 0,
        carryCorp: null,
        haulerAssignments: [],
        spawningCorp: registry.spawningCorps[assignedSpawn.id] ?? null,
        haulersNeeded: 0,
      });
    }

    const stats = roomStats.get(spawnRoomName)!;

    // Calculate target work parts (harvestRate / 2 energy per WORK per tick)
    const totalWorkPartsNeeded = Math.ceil(minerAssignment.harvestRate / 2);

    // Max miners limited by mining spots (spatial constraint)
    const maxMiners = minerAssignment.maxMiners || 1;

    // For miners: target is maxMiners (spatial limit), not work parts / capacity
    // Each miner should have enough WORK parts to fully utilize the source
    // Use getTotalCreepCount to include spawning creeps (prevents duplicate spawns)
    const currentMinerCount = harvestCorp.getTotalCreepCount();
    const targetMiners = maxMiners;  // We want exactly maxMiners creeps at this source
    const minersNeeded = Math.max(0, targetMiners - currentMinerCount);
    const workPartsPerMiner = Math.ceil(totalWorkPartsNeeded / targetMiners);

    stats.targetMiners += targetMiners;
    stats.totalMiners += currentMinerCount;

    // Get the per-source CarryCorp and its hauler assignment
    const carryCorp = carryCorpsBySource.get(minerAssignment.sourceId) ?? null;
    const assignments = carryCorp?.getHaulerAssignments() ?? [];
    const assignment = assignments[0]; // Each per-source CarryCorp has one assignment
    const carryPartsNeeded = assignment?.carryParts ?? 0;

    // Calculate per-source hauler requirements
    const room = assignedSpawn.room;
    const controllerLevel = room.controller?.level ?? 1;
    const energyCapacity = getMaxSpawnCapacity(controllerLevel);
    const maxCarryPerHauler = calculateMaxHaulerCarryParts(energyCapacity);
    const currentHaulers = carryCorp?.getCreepCount() ?? 0;
    const haulerReqs = calculateSpawnRequirements(carryPartsNeeded, maxCarryPerHauler, currentHaulers);

    // Update room-level hauler totals
    stats.totalHaulers += currentHaulers;
    stats.targetHaulers += haulerReqs.targetCreeps;
    stats.haulersNeeded += haulerReqs.creepsNeeded;
    stats.totalCarryPartsNeeded += carryPartsNeeded;

    allSources.push({
      harvestCorp,
      carryCorp,
      minerAssignment,
      roomName: spawnRoomName,
      sourceId: minerAssignment.sourceId,
      efficiency: minerAssignment.efficiency ?? 0,
      currentMiners: currentMinerCount,
      targetMiners,
      minersNeeded,
      workPartsPerMiner,
      carryPartsNeeded,
      currentHaulers,
      targetHaulers: haulerReqs.targetCreeps,
      haulersNeeded: haulerReqs.creepsNeeded,
      carryPartsPerHauler: haulerReqs.partsPerCreep,
      preferredHaulerRatio: assignment?.haulerRatio,
    });
  }

  // Sort sources by efficiency (higher = better = higher priority)
  // Efficiency accounts for both miner and hauler overhead
  allSources.sort((a, b) => b.efficiency - a.efficiency);

  // === Sequential spawning by efficiency ===
  // Process sources in efficiency order (highest first). For each source:
  //   1. If source needs miners AND has hauler support, spawn a miner
  //   2. If source has working miners but insufficient haulers, spawn a hauler
  //
  // IMPORTANT: Each source has its OWN CarryCorp with dedicated haulers.
  // Don't spawn miners for a source until it has sufficient hauler capacity.
  // This prevents spawning miners that will have no haulers to collect energy.
  for (const [roomName, stats] of roomStats) {
    if (!stats.spawningCorp) continue;

    const pendingCount = stats.spawningCorp.getPendingOrderCount();
    if (pendingCount >= 2) continue; // Keep queue small for responsiveness

    // Get sources for this room, already sorted by efficiency
    const roomSources = allSources.filter(s => s.roomName === roomName);
    if (roomSources.length === 0) continue;

    // Process sources in priority order (sorted by efficiency, highest first)
    for (const source of roomSources) {
      // Get count of WORKING miners (not spawning) for this source
      const workingMiners = source.harvestCorp.getCreepCount();
      const hasWorkingMiner = workingMiners > 0;

      // Calculate per-source hauler capacity (only count WORKING haulers)
      const currentHaulerCarryCapacity = source.currentHaulers * source.carryPartsPerHauler;
      const hasEnoughHaulers = currentHaulerCarryCapacity >= source.carryPartsNeeded || source.carryPartsNeeded === 0;

      // Step 1: Does this source need haulers for its working miners?
      // Prioritize hauler spawning if we have working miners but insufficient haulers
      if (hasWorkingMiner && !hasEnoughHaulers && source.carryCorp && source.haulersNeeded > 0) {
        const carryParts = source.carryPartsPerHauler;
        stats.spawningCorp.queueSpawnOrder({
          buyerCorpId: source.carryCorp.id,
          creepType: "hauler",
          workTicksRequested: carryParts,
          haulDemandRequested: carryParts,
          queuedAt: Game.time,
          haulerRatio: source.preferredHaulerRatio,
        });
        const shortfall = source.carryPartsNeeded - currentHaulerCarryCapacity;
        const ratioInfo = source.preferredHaulerRatio ? ` ${source.preferredHaulerRatio}` : "";
        console.log(`[FlowSpawn] Queued hauler for ${source.sourceId.slice(-4)} (${carryParts} CARRY${ratioInfo}, need ${source.carryPartsNeeded} have ${currentHaulerCarryCapacity}, shortfall ${shortfall.toFixed(0)})`);
        break; // Stop after queueing one spawn
      }

      // Step 2: Does this source need more miners?
      // Only spawn miners if this source has hauler support (or doesn't need haulers yet)
      if (source.minersNeeded > 0) {
        // For the first miner, allow spawning even without haulers
        // (haulers will be spawned once miner is working)
        const isFirstMiner = source.currentMiners === 0 && source.currentHaulers === 0;
        const canSpawnMiner = isFirstMiner || hasEnoughHaulers;

        if (canSpawnMiner) {
          stats.spawningCorp.queueSpawnOrder({
            buyerCorpId: source.harvestCorp.id,
            creepType: "miner",
            workTicksRequested: source.workPartsPerMiner,
            queuedAt: Game.time,
          });
          console.log(`[FlowSpawn] Queued miner for ${source.harvestCorp.id} (${source.workPartsPerMiner} WORK, eff=${source.efficiency.toFixed(1)}%)`);
          break; // Stop after queueing one spawn
        } else {
          // This source needs miners but doesn't have hauler support yet
          // Don't move to lower priority sources - wait for haulers
          break;
        }
      }

      // Step 3: Check if this source is "operational" before considering next source
      // A source is operational if it has working miners AND sufficient haulers
      if (!hasWorkingMiner || !hasEnoughHaulers) {
        break; // Stop here - don't spawn for lower priority sources yet
      }

      // This source is fully operational, continue to next
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

  // === Spawn scouts when economy is stable ===
  for (const [roomName, stats] of roomStats) {
    if (!stats.spawningCorp) continue;

    // Only spawn scouts once we have basic mining infrastructure
    const hasWorkingPair = stats.totalMiners >= 1 && stats.totalHaulers >= 1;
    if (!hasWorkingPair) continue;

    const pendingCount = stats.spawningCorp.getPendingOrderCount();
    if (pendingCount >= 2) continue;

    const scoutCorp = registry.scoutCorps[roomName];
    if (!scoutCorp) continue;

    const currentScouts = scoutCorp.getCreepCount();
    if (currentScouts >= MAX_SCOUTS) continue;

    stats.spawningCorp.queueSpawnOrder({
      buyerCorpId: scoutCorp.id,
      creepType: "scout",
      workTicksRequested: 1,
      queuedAt: Game.time,
    });
    console.log(`[FlowSpawn] Queued scout for ${scoutCorp.id}`);
  }

  // === Spawn tankers for local distribution when needed ===
  for (const [roomName, stats] of roomStats) {
    if (!stats.spawningCorp) continue;

    const room = Game.rooms[roomName];
    const rcl = room?.controller?.level ?? 1;

    // Only spawn tankers at RCL 2+ when we have extensions to fill
    if (rcl < 2) continue;

    // Need working mining infrastructure first
    const hasWorkingPair = stats.totalMiners >= 1 && stats.totalHaulers >= 1;
    if (!hasWorkingPair) continue;

    const pendingCount = stats.spawningCorp.getPendingOrderCount();
    if (pendingCount >= 2) continue;

    const nodeId = `${roomName}-tanker`;
    const tankerCorp = registry.tankerCorps[nodeId];
    if (!tankerCorp) continue;

    // Check if tanker corp needs more capacity
    if (tankerCorp.hasAdequateCapacity()) continue;

    const currentTankers = tankerCorp.getCreepCount();
    const requiredCarry = tankerCorp.getRequiredCarryParts();
    const currentCarry = tankerCorp.getCurrentCarryParts();

    // Don't spawn if we already have sufficient tankers
    if (currentCarry >= requiredCarry) continue;

    // Calculate carry parts for this tanker
    const carryNeeded = requiredCarry - currentCarry;
    const carryPerTanker = Math.min(carryNeeded, 10); // Cap individual tanker size

    stats.spawningCorp.queueSpawnOrder({
      buyerCorpId: tankerCorp.id,
      creepType: "tanker",
      workTicksRequested: carryPerTanker,
      queuedAt: Game.time,
    });
    console.log(`[FlowSpawn] Queued tanker for ${tankerCorp.id} (${carryPerTanker} CARRY, need ${requiredCarry} have ${currentCarry})`);
  }
}
