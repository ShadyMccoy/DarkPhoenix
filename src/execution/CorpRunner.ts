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
  RealMiningCorp,
  createRealMiningCorp,
  SerializedRealMiningCorp,
  RealHaulingCorp,
  createRealHaulingCorp,
  SerializedRealHaulingCorp,
  RealUpgradingCorp,
  createRealUpgradingCorp,
  SerializedRealUpgradingCorp,
  ScoutCorp,
  createScoutCorp,
  SerializedScoutCorp,
  ConstructionCorp,
  createConstructionCorp,
  SerializedConstructionCorp,
} from "../corps";
import { getMinableSources } from "../analysis";
import { getMarket, ClearingResult } from "../market";

/**
 * Container for all active corps, organized by type.
 */
export interface CorpRegistry {
  bootstrapCorps: { [roomName: string]: BootstrapCorp };
  miningCorps: { [sourceId: string]: RealMiningCorp };
  haulingCorps: { [roomName: string]: RealHaulingCorp };
  upgradingCorps: { [roomName: string]: RealUpgradingCorp };
  scoutCorps: { [roomName: string]: ScoutCorp };
  constructionCorps: { [roomName: string]: ConstructionCorp };
}

/**
 * Creates a new empty corp registry.
 */
export function createCorpRegistry(): CorpRegistry {
  return {
    bootstrapCorps: {},
    miningCorps: {},
    haulingCorps: {},
    upgradingCorps: {},
    scoutCorps: {},
    constructionCorps: {},
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

    // Initialize and run mining corps (one per source, excludes source keeper sources)
    for (const source of sources) {
      let miningCorp = registry.miningCorps[source.id];

      if (!miningCorp) {
        // Try to restore from memory
        const saved = Memory.miningCorps?.[source.id];
        if (saved) {
          miningCorp = new RealMiningCorp(saved.nodeId, saved.spawnId, saved.sourceId);
          miningCorp.deserialize(saved);
          registry.miningCorps[source.id] = miningCorp;
        } else {
          // Create new
          miningCorp = createRealMiningCorp(room, spawn, source);
          miningCorp.createdAt = Game.time;
          registry.miningCorps[source.id] = miningCorp;
          console.log(`[Mining] Created corp for source ${source.id.slice(-4)} in ${roomName}`);
        }
      }

      miningCorp.work(Game.time);
    }

    // Initialize and run hauling corp (one per room)
    let haulingCorp = registry.haulingCorps[roomName];

    if (!haulingCorp) {
      const saved = Memory.haulingCorps?.[roomName];
      if (saved) {
        haulingCorp = new RealHaulingCorp(saved.nodeId, saved.spawnId);
        haulingCorp.deserialize(saved);
        registry.haulingCorps[roomName] = haulingCorp;
      } else {
        haulingCorp = createRealHaulingCorp(room, spawn);
        haulingCorp.createdAt = Game.time;
        registry.haulingCorps[roomName] = haulingCorp;
        console.log(`[Hauling] Created corp for ${roomName}`);
      }
    }

    haulingCorp.work(Game.time);

    // Initialize and run upgrading corp (one per room)
    let upgradingCorp = registry.upgradingCorps[roomName];

    if (!upgradingCorp) {
      const saved = Memory.upgradingCorps?.[roomName];
      if (saved) {
        upgradingCorp = new RealUpgradingCorp(saved.nodeId, saved.spawnId);
        upgradingCorp.deserialize(saved);
        registry.upgradingCorps[roomName] = upgradingCorp;
      } else {
        upgradingCorp = createRealUpgradingCorp(room, spawn);
        upgradingCorp.createdAt = Game.time;
        registry.upgradingCorps[roomName] = upgradingCorp;
        console.log(`[Upgrading] Created corp for ${roomName}`);
      }
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

    // Run the construction corp
    constructionCorp.work(Game.time);
  }
}

/**
 * Register all corps with the market for trading.
 */
export function registerCorpsWithMarket(registry: CorpRegistry): void {
  const market = getMarket();

  // Register mining corps
  for (const sourceId in registry.miningCorps) {
    market.registerCorp(registry.miningCorps[sourceId]);
  }

  // Register hauling corps
  for (const roomName in registry.haulingCorps) {
    market.registerCorp(registry.haulingCorps[roomName]);
  }

  // Register upgrading corps
  for (const roomName in registry.upgradingCorps) {
    market.registerCorp(registry.upgradingCorps[roomName]);
  }

  // Register construction corps
  for (const roomName in registry.constructionCorps) {
    market.registerCorp(registry.constructionCorps[roomName]);
  }

  // Note: Bootstrap and Scout corps don't participate in the market
}

/**
 * Run market clearing to match offers and record transactions.
 * Should be called after all corps have run their work loops.
 */
export function runMarketClearing(): ClearingResult {
  const market = getMarket();
  const result = market.clear(Game.time);

  // Log market activity periodically
  if (Game.time % 100 === 0 && result.totalVolume > 0) {
    console.log(`[Market] Cleared: ${result.contracts.length} contracts, ` +
      `${result.totalVolume.toFixed(0)} volume, ` +
      `avg price ${result.averagePrice.toFixed(3)}`);
  }

  return result;
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

  let totalMiners = 0;
  let totalHaulers = 0;
  let totalUpgraders = 0;

  for (const sourceId in registry.miningCorps) {
    totalMiners += registry.miningCorps[sourceId].getCreepCount();
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

  console.log(`  Miners: ${totalMiners}, Haulers: ${totalHaulers}, Upgraders: ${totalUpgraders}, Scouts: ${totalScouts}, Builders: ${totalBuilders}`);
}
