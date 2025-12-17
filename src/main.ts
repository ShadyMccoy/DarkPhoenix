/**
 * @fileoverview Main game loop entry point.
 *
 * This is the entry point for the Screeps AI. It orchestrates the colony
 * economic system using a graph-based architecture.
 *
 * ## Architecture Overview
 *
 * The system uses an economic model where:
 * - Colony: Top-level orchestrator managing all economic activity
 * - Nodes: Territory-based regions (derived from spatial peak detection)
 * - Corps: Business units that buy/sell resources (mining, hauling, upgrading)
 * - Chains: Production paths linking corps together
 * - BootstrapCorp: Fallback corp that keeps colony alive with basic creeps
 *
 * ## Execution Flow
 *
 * Each tick:
 * 1. Run bootstrap corps (fallback to keep colony alive)
 * 2. Initialize nodes from rooms (spatial analysis)
 * 3. Run colony economic tick (survey, plan, execute, settle)
 * 4. Persist state to memory
 * 5. Clean up dead creep memory
 *
 * @module main
 */

import { Colony, createColony } from "./colony";
import { createNode, Node, serializeNode } from "./nodes";
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
} from "./corps";
import { ErrorMapper } from "./utils/ErrorMapper";
import { RoomMap, Peak } from "./spatial";
import "./types/Memory";

declare global {
  namespace NodeJS {
    interface Global {
      log: any;
      colony: Colony | undefined;
      bootstrapCorps: { [roomName: string]: BootstrapCorp };
      miningCorps: { [sourceId: string]: RealMiningCorp };
      haulingCorps: { [roomName: string]: RealHaulingCorp };
      upgradingCorps: { [roomName: string]: RealUpgradingCorp };
    }
  }

  interface Memory {
    bootstrapCorps?: { [roomName: string]: SerializedBootstrapCorp };
    miningCorps?: { [sourceId: string]: SerializedRealMiningCorp };
    haulingCorps?: { [roomName: string]: SerializedRealHaulingCorp };
    upgradingCorps?: { [roomName: string]: SerializedRealUpgradingCorp };
  }
}

/** Cache for room maps to avoid recalculating every tick */
const roomMapCache: { [roomName: string]: { map: RoomMap; tick: number } } = {};

/** Recalculate room maps every N ticks */
const ROOM_MAP_CACHE_TTL = 100;

/** The colony instance (persisted across ticks) */
let colony: Colony | undefined;

/** Bootstrap corps per room (fallback workers) */
const bootstrapCorps: { [roomName: string]: BootstrapCorp } = {};

/** Mining corps per source */
const miningCorps: { [sourceId: string]: RealMiningCorp } = {};

/** Hauling corps per room */
const haulingCorps: { [roomName: string]: RealHaulingCorp } = {};

/** Upgrading corps per room */
const upgradingCorps: { [roomName: string]: RealUpgradingCorp } = {};

/**
 * Main game loop - executed every tick.
 *
 * Wrapped with ErrorMapper to catch and log errors without crashing.
 */
export const loop = ErrorMapper.wrapLoop(() => {
  // Run bootstrap corps first (keep colony alive)
  runBootstrapCorps();

  // Run real corps (mining, hauling, upgrading)
  runRealCorps();

  // Initialize or restore colony
  colony = getOrCreateColony();

  // Make colony available globally for debugging
  global.colony = colony;
  global.bootstrapCorps = bootstrapCorps;
  global.miningCorps = miningCorps;
  global.haulingCorps = haulingCorps;
  global.upgradingCorps = upgradingCorps;

  // Initialize nodes from rooms
  initializeNodesFromRooms(colony);

  // Run the colony economic tick
  colony.run(Game.time);

  // Persist all state
  persistState(colony);

  // Clean up memory for dead creeps
  cleanupDeadCreeps();

  // Log stats periodically
  if (Game.time % 100 === 0) {
    logStats(colony);
  }
});

/**
 * Run bootstrap corps for all owned rooms.
 *
 * Bootstrap corps are the fallback - they create simple jack creeps
 * that harvest energy and return it to spawn.
 */
function runBootstrapCorps(): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];

    // Only process owned rooms with spawns
    if (!room.controller?.my) continue;
    if (room.find(FIND_MY_SPAWNS).length === 0) continue;

    // Get or create bootstrap corp for this room
    let bootstrapCorp = bootstrapCorps[roomName];

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
          bootstrapCorps[roomName] = bootstrapCorp;
        }
      }

      // Create new if still missing
      if (!bootstrapCorp) {
        const newCorp = createBootstrapCorp(room);
        if (newCorp) {
          newCorp.createdAt = Game.time;
          bootstrapCorps[roomName] = newCorp;
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
function runRealCorps(): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];

    // Only process owned rooms with spawns
    if (!room.controller?.my) continue;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;

    const spawn = spawns[0];
    const sources = room.find(FIND_SOURCES);

    // Initialize and run mining corps (one per source)
    for (const source of sources) {
      let miningCorp = miningCorps[source.id];

      if (!miningCorp) {
        // Try to restore from memory
        const saved = Memory.miningCorps?.[source.id];
        if (saved) {
          miningCorp = new RealMiningCorp(saved.nodeId, saved.spawnId, saved.sourceId);
          miningCorp.deserialize(saved);
          miningCorps[source.id] = miningCorp;
        } else {
          // Create new
          miningCorp = createRealMiningCorp(room, spawn, source);
          miningCorp.createdAt = Game.time;
          miningCorps[source.id] = miningCorp;
          console.log(`[Mining] Created corp for source ${source.id.slice(-4)} in ${roomName}`);
        }
      }

      miningCorp.work(Game.time);
    }

    // Initialize and run hauling corp (one per room)
    let haulingCorp = haulingCorps[roomName];

    if (!haulingCorp) {
      const saved = Memory.haulingCorps?.[roomName];
      if (saved) {
        haulingCorp = new RealHaulingCorp(saved.nodeId, saved.spawnId);
        haulingCorp.deserialize(saved);
        haulingCorps[roomName] = haulingCorp;
      } else {
        haulingCorp = createRealHaulingCorp(room, spawn);
        haulingCorp.createdAt = Game.time;
        haulingCorps[roomName] = haulingCorp;
        console.log(`[Hauling] Created corp for ${roomName}`);
      }
    }

    haulingCorp.work(Game.time);

    // Initialize and run upgrading corp (one per room)
    let upgradingCorp = upgradingCorps[roomName];

    if (!upgradingCorp) {
      const saved = Memory.upgradingCorps?.[roomName];
      if (saved) {
        upgradingCorp = new RealUpgradingCorp(saved.nodeId, saved.spawnId);
        upgradingCorp.deserialize(saved);
        upgradingCorps[roomName] = upgradingCorp;
      } else {
        upgradingCorp = createRealUpgradingCorp(room, spawn);
        upgradingCorp.createdAt = Game.time;
        upgradingCorps[roomName] = upgradingCorp;
        console.log(`[Upgrading] Created corp for ${roomName}`);
      }
    }

    upgradingCorp.work(Game.time);
  }
}

/**
 * Gets existing colony or creates a new one.
 *
 * Restores colony state from memory if available.
 */
function getOrCreateColony(): Colony {
  if (colony) {
    return colony;
  }

  const newColony = createColony();

  // Restore from memory if available
  if (Memory.colony) {
    newColony.deserialize(Memory.colony);
  }

  return newColony;
}

/**
 * Initialize nodes from owned rooms.
 *
 * Creates nodes based on spatial peak detection (territories).
 * Each peak in a room becomes a node.
 */
function initializeNodesFromRooms(colony: Colony): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];

    // Only process owned rooms
    if (!room.controller?.my) continue;

    // Get or create room map (cached)
    const roomMap = getOrCreateRoomMap(room);

    // Create nodes from peaks
    const peaks = roomMap.getPeaks();
    for (const peak of peaks) {
      const nodeId = `${roomName}-${peak.center.x}-${peak.center.y}`;

      // Skip if node already exists
      if (colony.getNode(nodeId)) continue;

      // Create node from peak
      const node = createNodeFromPeak(room, peak, nodeId);
      colony.addNode(node);

      // Track node in room memory
      if (!room.memory.nodeIds) {
        room.memory.nodeIds = [];
      }
      if (!room.memory.nodeIds.includes(nodeId)) {
        room.memory.nodeIds.push(nodeId);
      }
    }
  }
}

/**
 * Creates a node from a spatial peak.
 */
function createNodeFromPeak(room: Room, peak: Peak, nodeId: string): Node {
  const peakPosition = { x: peak.center.x, y: peak.center.y, roomName: room.name };
  return createNode(nodeId, room.name, peakPosition, [], Game.time);
}

/**
 * Gets or creates a RoomMap for spatial analysis.
 *
 * Caches room maps to avoid expensive recalculation every tick.
 * Renders visualization every tick (Screeps visuals only persist one tick).
 */
function getOrCreateRoomMap(room: Room): RoomMap {
  const cached = roomMapCache[room.name];
  if (cached && Game.time - cached.tick < ROOM_MAP_CACHE_TTL) {
    // Render visualization every tick (visuals don't persist across ticks)
    cached.map.render(room);
    return cached.map;
  }

  const map = new RoomMap(room);
  roomMapCache[room.name] = { map, tick: Game.time };

  // Render visualization
  map.render(room);

  return map;
}

/**
 * Persists all state to memory.
 */
function persistState(colony: Colony): void {
  // Persist colony
  Memory.colony = colony.serialize();

  // Persist nodes
  Memory.nodes = {};
  for (const node of colony.getNodes()) {
    Memory.nodes[node.id] = serializeNode(node);
  }

  // Persist bootstrap corps
  Memory.bootstrapCorps = {};
  for (const roomName in bootstrapCorps) {
    Memory.bootstrapCorps[roomName] = bootstrapCorps[roomName].serialize();
  }

  // Persist mining corps
  Memory.miningCorps = {};
  for (const sourceId in miningCorps) {
    Memory.miningCorps[sourceId] = miningCorps[sourceId].serialize();
  }

  // Persist hauling corps
  Memory.haulingCorps = {};
  for (const roomName in haulingCorps) {
    Memory.haulingCorps[roomName] = haulingCorps[roomName].serialize();
  }

  // Persist upgrading corps
  Memory.upgradingCorps = {};
  for (const roomName in upgradingCorps) {
    Memory.upgradingCorps[roomName] = upgradingCorps[roomName].serialize();
  }
}

/**
 * Cleans up memory for dead creeps.
 */
function cleanupDeadCreeps(): void {
  for (const name in Memory.creeps) {
    if (!Game.creeps[name]) {
      delete Memory.creeps[name];
    }
  }
}

/**
 * Logs statistics for monitoring.
 */
function logStats(colony: Colony): void {
  const stats = colony.getStats();
  const supply = colony.getMoneySupply();

  console.log(`[Colony] Tick ${Game.time}`);
  console.log(`  Nodes: ${stats.nodeCount}, Corps: ${stats.totalCorps} (${stats.activeCorps} active)`);
  console.log(`  Chains: ${stats.activeChains}, Treasury: ${supply.treasury.toFixed(0)}`);
  console.log(`  Money Supply: ${supply.net.toFixed(0)} (minted: ${supply.minted.toFixed(0)}, taxed: ${supply.taxed.toFixed(0)})`);

  // Log bootstrap stats
  let totalJacks = 0;
  for (const roomName in bootstrapCorps) {
    const corp = bootstrapCorps[roomName];
    totalJacks += corp.getCreepCount();
  }
  console.log(`  Bootstrap Jacks: ${totalJacks}`);

  // Log real corps stats
  let totalMiners = 0;
  let totalHaulers = 0;
  let totalUpgraders = 0;

  for (const sourceId in miningCorps) {
    totalMiners += miningCorps[sourceId].getCreepCount();
  }
  for (const roomName in haulingCorps) {
    totalHaulers += haulingCorps[roomName].getCreepCount();
  }
  for (const roomName in upgradingCorps) {
    totalUpgraders += upgradingCorps[roomName].getCreepCount();
  }

  console.log(`  Miners: ${totalMiners}, Haulers: ${totalHaulers}, Upgraders: ${totalUpgraders}`);
}
