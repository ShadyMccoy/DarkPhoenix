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
  SpawningCorp,
  createSpawningCorp,
  SerializedSpawningCorp,
  SpawnableCreepType,
} from "../corps";
import { getMinableSources } from "../analysis";
import { getMarket, ClearingResult, Contract } from "../market";

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
  spawningCorps: { [spawnId: string]: SpawningCorp };
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

      // Run periodic planning if needed
      if (miningCorp.shouldPlan(Game.time)) {
        miningCorp.plan(Game.time);
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
 * Spawning corps manage spawn structures and sell work-ticks.
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
 * Process spawn contracts from market clearing.
 * Routes work-ticks and haul-demand contracts to the selling SpawningCorp.
 * Also records commitments on buyer corps to prevent double-ordering.
 */
export function processSpawnContracts(
  contracts: Contract[],
  registry: CorpRegistry
): void {
  for (const contract of contracts) {
    // Handle work-ticks and carry-ticks contracts (for spawning)
    if (contract.resource !== "work-ticks" && contract.resource !== "carry-ticks") {
      continue;
    }

    // Find spawning corp by corp ID (registry is keyed by spawn.id, not corp.id)
    let spawningCorp: SpawningCorp | undefined;
    for (const spawnId in registry.spawningCorps) {
      if (registry.spawningCorps[spawnId].id === contract.sellerId) {
        spawningCorp = registry.spawningCorps[spawnId];
        break;
      }
    }
    if (!spawningCorp) continue;

    // Find buyer corp to determine creep type and record commitment
    const buyerResult = findBuyerCorp(contract.buyerId, registry);
    if (!buyerResult) continue;

    const { corp: buyerCorp, type: buyerCorpType } = buyerResult;

    // Map corp type to creep type
    const creepType = mapCorpTypeToCreepType(buyerCorpType);
    if (!creepType) continue;

    // Contract is already assigned to the buyer corp via Market.matchOffers
    // No need for separate commitment tracking

    if (contract.resource === "carry-ticks") {
      spawningCorp.queueSpawn({
        buyerCorpId: contract.buyerId,
        creepType,
        workTicksRequested: 0,
        haulDemandRequested: contract.quantity,
        contractId: contract.id,
        queuedAt: Game.time
      });
      console.log(`[Spawning] Queued ${creepType} for ${contract.buyerId} (${contract.quantity} carry-ticks)`);
    } else {
      spawningCorp.queueSpawn({
        buyerCorpId: contract.buyerId,
        creepType,
        workTicksRequested: contract.quantity,
        contractId: contract.id,
        queuedAt: Game.time
      });
      console.log(`[Spawning] Queued ${creepType} for ${contract.buyerId} (${contract.quantity} work-ticks)`);
    }
  }
}

/**
 * Find the buyer corp and its type by corp ID.
 * Returns both the corp instance and its type.
 */
function findBuyerCorp(
  corpId: string,
  registry: CorpRegistry
): { corp: RealMiningCorp | RealHaulingCorp | RealUpgradingCorp | ConstructionCorp; type: string } | null {
  // Check each corp registry
  for (const id in registry.miningCorps) {
    if (registry.miningCorps[id].id === corpId) {
      return { corp: registry.miningCorps[id], type: "mining" };
    }
  }
  for (const id in registry.haulingCorps) {
    if (registry.haulingCorps[id].id === corpId) {
      return { corp: registry.haulingCorps[id], type: "hauling" };
    }
  }
  for (const id in registry.upgradingCorps) {
    if (registry.upgradingCorps[id].id === corpId) {
      return { corp: registry.upgradingCorps[id], type: "upgrading" };
    }
  }
  for (const id in registry.constructionCorps) {
    if (registry.constructionCorps[id].id === corpId) {
      return { corp: registry.constructionCorps[id], type: "building" };
    }
  }
  return null;
}

/**
 * Find the corp type for a buyer corp ID.
 */
function findBuyerCorpType(
  corpId: string,
  registry: CorpRegistry
): string | null {
  const result = findBuyerCorp(corpId, registry);
  return result ? result.type : null;
}

/**
 * Map corp type to spawnable creep type.
 */
function mapCorpTypeToCreepType(corpType: string): SpawnableCreepType | null {
  switch (corpType) {
    case "mining": return "miner";
    case "hauling": return "hauler";
    case "upgrading": return "upgrader";
    case "building": return "builder";
    default: return null;
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

  // Register spawning corps
  for (const spawnId in registry.spawningCorps) {
    market.registerCorp(registry.spawningCorps[spawnId]);
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
