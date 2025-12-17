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
 *
 * ## Execution Flow
 *
 * Each tick:
 * 1. Restore colony state from memory
 * 2. Initialize nodes from rooms (spatial analysis)
 * 3. Run colony economic tick (survey, plan, execute, settle)
 * 4. Persist colony state to memory
 * 5. Clean up dead creep memory
 *
 * @module main
 */

import { Colony, createColony, SerializedColony } from "./colony";
import { createNode, Node, serializeNode, SerializedNode } from "./nodes";
import { ErrorMapper } from "./utils/ErrorMapper";
import { RoomMap, Peak } from "./spatial";
import "./types/Memory";

declare global {
  namespace NodeJS {
    interface Global {
      log: any;
      colony: Colony | undefined;
    }
  }
}

/** Cache for room maps to avoid recalculating every tick */
const roomMapCache: { [roomName: string]: { map: RoomMap; tick: number } } = {};

/** Recalculate room maps every N ticks */
const ROOM_MAP_CACHE_TTL = 100;

/** The colony instance (persisted across ticks) */
let colony: Colony | undefined;

/**
 * Main game loop - executed every tick.
 *
 * Wrapped with ErrorMapper to catch and log errors without crashing.
 */
export const loop = ErrorMapper.wrapLoop(() => {
  // Initialize or restore colony
  colony = getOrCreateColony();

  // Make colony available globally for debugging
  global.colony = colony;

  // Initialize nodes from rooms
  initializeNodesFromRooms(colony);

  // Run the colony economic tick
  colony.run(Game.time);

  // Persist colony state
  persistColonyState(colony);

  // Clean up memory for dead creeps
  cleanupDeadCreeps();

  // Log stats periodically
  if (Game.time % 100 === 0) {
    logColonyStats(colony);
  }
});

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
 * Persists colony state to memory.
 */
function persistColonyState(colony: Colony): void {
  Memory.colony = colony.serialize();

  // Persist nodes
  Memory.nodes = {};
  for (const node of colony.getNodes()) {
    Memory.nodes[node.id] = serializeNode(node);
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
 * Logs colony statistics for monitoring.
 */
function logColonyStats(colony: Colony): void {
  const stats = colony.getStats();
  const supply = colony.getMoneySupply();

  console.log(`[Colony] Tick ${Game.time}`);
  console.log(`  Nodes: ${stats.nodeCount}, Corps: ${stats.totalCorps} (${stats.activeCorps} active)`);
  console.log(`  Chains: ${stats.activeChains}, Treasury: ${supply.treasury.toFixed(0)}`);
  console.log(`  Money Supply: ${supply.net.toFixed(0)} (minted: ${supply.minted.toFixed(0)}, taxed: ${supply.taxed.toFixed(0)})`);
  console.log(`  Avg ROI: ${(stats.averageROI * 100).toFixed(1)}%`);
}
