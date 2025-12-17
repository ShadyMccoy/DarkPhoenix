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
import { BootstrapCorp, createBootstrapCorp, SerializedBootstrapCorp } from "./corps";
import { ErrorMapper } from "./utils/ErrorMapper";
import { RoomMap, Peak } from "./spatial";
import "./types/Memory";

declare global {
  namespace NodeJS {
    interface Global {
      log: any;
      colony: Colony | undefined;
      bootstrapCorps: { [roomName: string]: BootstrapCorp };
    }
  }

  interface Memory {
    bootstrapCorps?: { [roomName: string]: SerializedBootstrapCorp };
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

/**
 * Main game loop - executed every tick.
 *
 * Wrapped with ErrorMapper to catch and log errors without crashing.
 */
export const loop = ErrorMapper.wrapLoop(() => {
  // Run bootstrap corps first (keep colony alive)
  runBootstrapCorps();

  // Initialize or restore colony
  colony = getOrCreateColony();

  // Make colony available globally for debugging
  global.colony = colony;
  global.bootstrapCorps = bootstrapCorps;

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
 */
function getOrCreateRoomMap(room: Room): RoomMap {
  const cached = roomMapCache[room.name];
  if (cached && Game.time - cached.tick < ROOM_MAP_CACHE_TTL) {
    return cached.map;
  }

  const map = new RoomMap(room);
  roomMapCache[room.name] = { map, tick: Game.time };

  // Optionally render visualization
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
}
