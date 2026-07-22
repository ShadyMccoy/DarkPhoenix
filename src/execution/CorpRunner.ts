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
import { BootstrapCorp, Corp, SpawningCorp, createBootstrapCorp, createSpawningCorp } from "../corps";
import { completeCensus } from "./CommissionHost";

/**
 * Container for all active corps, organized by type.
 */
export interface CorpRegistry {
  bootstrapCorps: { [roomName: string]: BootstrapCorp };
  spawningCorps: { [spawnId: string]: SpawningCorp };
  // harvest/carry/upgrade/construction corps live in the commission store
  // (CommissionHost), reached via commissionedCorpsOfKind(), not the registry.
}

/**
 * Creates a new empty corp registry.
 */
export function createCorpRegistry(): CorpRegistry {
  return {
    bootstrapCorps: {},
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

/** Every corp, via the complete census - a new kind's corps join the variance
 * snapshot by registration (off-budget corps return null variance and drop out). */
function allCorps(registry: CorpRegistry): Corp[] {
  return completeCensus(registry).map(e => e.corp);
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
 * Log per-kind creep counts, derived from the complete census - every
 * registered kind with creeps prints, none by name.
 */
export function logCorpStats(registry: CorpRegistry): void {
  const byKind: { [kind: string]: number } = {};
  for (const { kind, corp } of completeCensus(registry)) {
    const counter = corp as Partial<{ getCreepCount(): number }>;
    if (typeof counter.getCreepCount !== "function") continue;
    byKind[kind] = (byKind[kind] ?? 0) + counter.getCreepCount!();
  }
  const line = Object.keys(byKind)
    .sort()
    .map(kind => `${kind}: ${byKind[kind]}`)
    .join(", ");
  console.log(`  Creeps by kind - ${line || "none"}`);
}
