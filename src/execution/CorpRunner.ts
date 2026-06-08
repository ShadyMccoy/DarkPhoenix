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
  UpgradingCorp,
  SerializedUpgradingCorp,
  ScoutCorp,
  createScoutCorp,
  SerializedScoutCorp,
  ConstructionCorp,
  createConstructionCorp,
  SerializedConstructionCorp,
  ReservationCorp,
  createReservationCorp,
  SerializedReservationCorp,
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
  /** Hauling corps keyed by source ID (each source has its own CarryCorp) */
  haulingCorps: { [sourceId: string]: CarryCorp };
  upgradingCorps: { [roomName: string]: UpgradingCorp };
  scoutCorps: { [roomName: string]: ScoutCorp };
  constructionCorps: { [roomName: string]: ConstructionCorp };
  spawningCorps: { [spawnId: string]: SpawningCorp };
  reservationCorps: { [roomName: string]: ReservationCorp };
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
    reservationCorps: {},
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
 * - Hauling: Picks up energy and delivers to spawn/controller
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

  // Run all HaulingCorps
  for (const roomName in registry.haulingCorps) {
    const haulingCorp = registry.haulingCorps[roomName];
    if (haulingCorp.shouldPlan(Game.time)) {
      haulingCorp.plan(Game.time);
    }
    haulingCorp.work(Game.time);
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
 * Run reservation corps for all owned rooms.
 *
 * A reservation corp keeps the controllers of remote rooms we mine reserved, so
 * their sources regenerate the full 3000 instead of the unreserved 1500. Spawn
 * demand flows through the SpawnDirector (getSpawnDemand), like construction.
 */
export function runReservationCorps(registry: CorpRegistry): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];

    // Only process owned rooms with spawns
    if (!room.controller?.my) continue;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;

    let reservationCorp = registry.reservationCorps[roomName];

    if (!reservationCorp) {
      const saved = Memory.reservationCorps?.[roomName];
      if (saved) {
        reservationCorp = new ReservationCorp(saved.nodeId, saved.spawnId, saved.id);
        reservationCorp.deserialize(saved);
        registry.reservationCorps[roomName] = reservationCorp;
      } else {
        const newCorp = createReservationCorp(room);
        if (newCorp) {
          newCorp.createdAt = Game.time;
          registry.reservationCorps[roomName] = newCorp;
          reservationCorp = newCorp;
          console.log(`[Reservation] Created corp for ${roomName}`);
        }
      }
    }

    if (reservationCorp) {
      reservationCorp.work(Game.time);
    }
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

      // Spawning is now driven by the demand-based scheduler (runSpawnScheduling
      // in SpawnDirector), not by draining a fixed-priority queue here. We only
      // ensure the SpawningCorp instance exists; actual spawn decisions happen
      // after planning.
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
