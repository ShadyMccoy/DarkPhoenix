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
          bootstrapCorp = new BootstrapCorp(
            saved.nodeId,
            saved.spawnId,
            saved.sourceId
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
          harvestCorp = new HarvestCorp(saved.nodeId, saved.spawnId, saved.sourceId);
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
        haulingCorp = new CarryCorp(saved.nodeId, saved.spawnId);
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
        upgradingCorp = new UpgradingCorp(saved.nodeId, saved.spawnId);
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
        scoutCorp = new ScoutCorp(saved.nodeId, saved.spawnId);
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
        constructionCorp = new ConstructionCorp(saved.nodeId, saved.spawnId);
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
          spawningCorp = new SpawningCorp(saved.nodeId, spawn.id, saved.energyCapacity);
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
    carryCorp: CarryCorp | null;
    haulerAssignments: any[];
    spawningCorp: SpawningCorp | null;
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

    // Initialize room stats
    if (!roomStats.has(roomName)) {
      const spawns = Game.rooms[roomName]?.find(FIND_MY_SPAWNS) ?? [];
      roomStats.set(roomName, {
        totalMiners: 0,
        totalHaulers: carryCorp.getCreepCount(),
        targetMiners: 0,
        targetHaulers: assignments.length,
        carryCorp,
        haulerAssignments: assignments,
        spawningCorp: spawns.length > 0 ? registry.spawningCorps[spawns[0].id] : null,
      });
    }
  }

  // First pass: count existing miners and targets per room
  const sourcesNeedingMiners: Array<{ harvestCorp: HarvestCorp; minerAssignment: any; roomName: string }> = [];

  for (const sourceId in registry.harvestCorps) {
    const harvestCorp = registry.harvestCorps[sourceId];
    const minerAssignment = harvestCorp.getMinerAssignment();

    if (!minerAssignment) continue;

    // Determine room from the source position or node
    const roomName = minerAssignment.nodeId.split("-")[0];

    // Initialize room stats if needed
    if (!roomStats.has(roomName)) {
      const spawns = Game.rooms[roomName]?.find(FIND_MY_SPAWNS) ?? [];
      roomStats.set(roomName, {
        totalMiners: 0,
        totalHaulers: 0,
        targetMiners: 0,
        targetHaulers: 0,
        carryCorp: null,
        haulerAssignments: [],
        spawningCorp: spawns.length > 0 ? registry.spawningCorps[spawns[0].id] : null,
      });
    }

    const stats = roomStats.get(roomName)!;
    stats.targetMiners++;

    const minerCount = harvestCorp.getCreepCount();
    stats.totalMiners += minerCount;

    if (minerCount < 1) {
      sourcesNeedingMiners.push({ harvestCorp, minerAssignment, roomName });
    }
  }

  // === Proportional spawning: miners and haulers in lockstep ===
  for (const [roomName, stats] of roomStats) {
    if (!stats.spawningCorp) continue;

    const pendingCount = stats.spawningCorp.getPendingOrderCount();
    if (pendingCount >= 2) continue; // Keep queue small for responsiveness

    // Target haulers = number of miners that exist (proportional)
    const targetHaulersForCurrentMiners = Math.min(stats.totalMiners, stats.targetHaulers);

    // Decision: do we need a miner or a hauler next?
    const needMoreMiners = stats.totalMiners < stats.targetMiners;
    const needMoreHaulers = stats.totalHaulers < targetHaulersForCurrentMiners;

    if (needMoreMiners && stats.totalHaulers >= stats.totalMiners) {
      // Haulers caught up to miners, spawn next miner
      const sourceInfo = sourcesNeedingMiners.find(s => s.roomName === roomName);
      if (sourceInfo) {
        const workParts = Math.ceil(sourceInfo.minerAssignment.harvestRate / 2);
        stats.spawningCorp.queueSpawnOrder({
          buyerCorpId: sourceInfo.harvestCorp.id,
          creepType: "miner",
          workTicksRequested: workParts,
          queuedAt: Game.time,
        });
        console.log(`[FlowSpawn] Queued miner for ${sourceInfo.harvestCorp.id} (${workParts} WORK)`);
        // Remove from list so we don't queue twice
        const idx = sourcesNeedingMiners.indexOf(sourceInfo);
        if (idx >= 0) sourcesNeedingMiners.splice(idx, 1);
      }
    } else if (needMoreHaulers && stats.carryCorp && stats.totalMiners > 0) {
      // Have miners without matching haulers, spawn hauler
      // Pick the first hauler assignment (they're all for the same CarryCorp)
      const assignment = stats.haulerAssignments[0];
      if (assignment) {
        stats.spawningCorp.queueSpawnOrder({
          buyerCorpId: stats.carryCorp.id,
          creepType: "hauler",
          workTicksRequested: assignment.carryParts,
          haulDemandRequested: assignment.carryParts,
          queuedAt: Game.time,
        });
        console.log(`[FlowSpawn] Queued hauler for ${stats.carryCorp.id} (${assignment.carryParts} CARRY)`);
      }
    } else if (needMoreMiners) {
      // No haulers needed yet, just spawn miners
      const sourceInfo = sourcesNeedingMiners.find(s => s.roomName === roomName);
      if (sourceInfo) {
        const workParts = Math.ceil(sourceInfo.minerAssignment.harvestRate / 2);
        stats.spawningCorp.queueSpawnOrder({
          buyerCorpId: sourceInfo.harvestCorp.id,
          creepType: "miner",
          workTicksRequested: workParts,
          queuedAt: Game.time,
        });
        console.log(`[FlowSpawn] Queued miner for ${sourceInfo.harvestCorp.id} (${workParts} WORK)`);
        const idx = sourcesNeedingMiners.indexOf(sourceInfo);
        if (idx >= 0) sourcesNeedingMiners.splice(idx, 1);
      }
    }
  }

  // === After all mining pairs complete, spawn upgraders ===
  for (const [roomName, stats] of roomStats) {
    // Mining is only complete if we have targets AND met them
    // Prevents upgraders from spawning when no miners are planned/exist
    const hasMiningPlan = stats.targetMiners > 0;
    const miningComplete = hasMiningPlan &&
                           stats.totalMiners >= stats.targetMiners &&
                           stats.totalHaulers >= stats.targetHaulers;

    if (!miningComplete) continue;

    const upgradingCorp = registry.upgradingCorps[roomName];
    if (!upgradingCorp) continue;

    const allocation = upgradingCorp.getSinkAllocation();
    if (!allocation || allocation.allocated <= 0) continue;

    const currentCreeps = upgradingCorp.getCreepCount();
    if (currentCreeps >= 1) continue; // Already have an upgrader

    if (!stats.spawningCorp) continue;

    const pendingCount = stats.spawningCorp.getPendingOrderCount();
    if (pendingCount >= 2) continue;

    const workParts = Math.ceil(allocation.allocated);
    stats.spawningCorp.queueSpawnOrder({
      buyerCorpId: upgradingCorp.id,
      creepType: "upgrader",
      workTicksRequested: Math.min(workParts, 5),
      queuedAt: Game.time,
    });
    console.log(`[FlowSpawn] Queued upgrader for ${upgradingCorp.id} (${Math.min(workParts, 5)} WORK)`);
  }
}
