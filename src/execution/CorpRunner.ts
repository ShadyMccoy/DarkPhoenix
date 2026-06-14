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
  CarryCorp,
  ConstructionCorp,
  Corp,
  HarvestCorp,
  ScoutCorp,
  SpawningCorp,
  UpgradingCorp,
  createBootstrapCorp,
  createConstructionCorp,
  createSpawningCorp
} from "../corps";
import { commissionedCorpsOfKind } from "./CommissionHost";

/**
 * Container for all active corps, organized by type.
 */
export interface CorpRegistry {
  bootstrapCorps: { [roomName: string]: BootstrapCorp };
  constructionCorps: { [roomName: string]: ConstructionCorp };
  spawningCorps: { [spawnId: string]: SpawningCorp };
  // harvest/carry/upgrade corps live in the commission store (CommissionHost),
  // reached via commissionedCorpsOfKind(), not the registry.
}

/**
 * Creates a new empty corp registry.
 */
export function createCorpRegistry(): CorpRegistry {
  return {
    bootstrapCorps: {},
    constructionCorps: {},
    spawningCorps: {}
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
          bootstrapCorp = new BootstrapCorp(saved.nodeId, saved.spawnId, saved.sourceId, saved.id);
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

      // Spawning is now driven by the demand-based scheduler (runSpawnScheduling
      // in SpawnDirector), not by draining a fixed-priority queue here. We only
      // ensure the SpawningCorp instance exists; actual spawn decisions happen
      // after planning.
      spawningCorp.work(Game.time);
    }
  }
}

/** One corp's budget-vs-actual line in a variance snapshot. */
export interface CorpVarianceRow {
  id: string;
  type: string;
  /** Units/tick the planner commissioned. */
  budget: number;
  /** Recent actual units/tick. */
  actual: number;
  /** (actual - budget) / budget. */
  variance: number;
}

/** Every budgeted corp (off-budget corps return null variance). Economy corps
 * (harvest/carry/upgrade) live in the commission store; the rest in the registry. */
function allCorps(registry: CorpRegistry): Corp[] {
  const out: Corp[] = [];
  const groups: { [id: string]: Corp }[] = [
    commissionedCorpsOfKind("harvest"),
    commissionedCorpsOfKind("carry"),
    commissionedCorpsOfKind("upgrade"),
    registry.constructionCorps,
    registry.bootstrapCorps,
    registry.spawningCorps
  ];
  for (const g of groups) for (const k in g) out.push(g[k]);
  return out;
}

/**
 * Snapshot every budgeted corp's budget vs actual throughput into
 * `Memory.corpVariance`, sorted worst-variance first so outliers (the corps
 * straying furthest below what they were funded to produce) sit at the top.
 *
 * Per-corp ROI is not comparable across types, but variance is - it measures a
 * corp only against its own commission - so this is the uniform way to spot a
 * stalled or misfiring corp (a miner budgeted 10 e/tick delivering 0).
 */
export function snapshotCorpVariance(registry: CorpRegistry, tick: number): CorpVarianceRow[] {
  const rows: CorpVarianceRow[] = [];
  for (const corp of allCorps(registry)) {
    const variance = corp.variance(tick);
    if (variance === null) continue; // off-budget corp
    rows.push({
      id: corp.id,
      type: corp.type,
      budget: Number(corp.budgetedRate().toFixed(2)),
      actual: Number(corp.productionRate(tick).toFixed(2)),
      variance: Number(variance.toFixed(2))
    });
  }
  rows.sort((a, b) => a.variance - b.variance);
  if (typeof Memory !== "undefined") {
    (Memory as { corpVariance?: CorpVarianceRow[] }).corpVariance = rows;
  }
  return rows;
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

  for (const corp of Object.values(commissionedCorpsOfKind<HarvestCorp>("harvest"))) {
    totalHarvesters += corp.getCreepCount();
  }
  for (const corp of Object.values(commissionedCorpsOfKind<CarryCorp>("carry"))) {
    totalHaulers += corp.getCreepCount();
  }
  for (const corp of Object.values(commissionedCorpsOfKind<UpgradingCorp>("upgrade"))) {
    totalUpgraders += corp.getCreepCount();
  }

  let totalScouts = 0;
  for (const corp of Object.values(commissionedCorpsOfKind<ScoutCorp>("scout"))) {
    totalScouts += corp.getCreepCount();
  }

  let totalBuilders = 0;
  for (const roomName in registry.constructionCorps) {
    totalBuilders += registry.constructionCorps[roomName].getCreepCount();
  }

  console.log(
    `  Harvesters: ${totalHarvesters}, Haulers: ${totalHaulers}, Upgraders: ${totalUpgraders}, Scouts: ${totalScouts}, Builders: ${totalBuilders}`
  );
}
