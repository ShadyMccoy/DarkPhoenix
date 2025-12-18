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
import { createNode, Node, serializeNode, calculateNodeROI, NodeROI, NodeSurveyor } from "./nodes";
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
} from "./corps";
import { ErrorMapper, discoverNearbyRooms } from "./utils";
import {
  RoomMap,
  getRoomsToVisualize,
  analyzeMultiRoomTerrain,
  visualizeMultiRoomAnalysis,
  MultiRoomAnalysisResult,
} from "./spatial";
import "./types/Memory";

/** Maximum room distance from owned rooms for node expansion */
const NEARBY_ROOM_DISTANCE = 2;

/** Tick interval for expanding to nearby rooms (expensive operation) */
const NEARBY_ROOM_EXPANSION_INTERVAL = 500;

declare global {
  namespace NodeJS {
    interface Global {
      log: any;
      colony: Colony | undefined;
      bootstrapCorps: { [roomName: string]: BootstrapCorp };
      miningCorps: { [sourceId: string]: RealMiningCorp };
      haulingCorps: { [roomName: string]: RealHaulingCorp };
      upgradingCorps: { [roomName: string]: RealUpgradingCorp };
      scoutCorps: { [roomName: string]: ScoutCorp };
      recalculateTerrain: () => void;
      showNodes: () => void;
      exportNodes: () => string;
    }
  }

  interface Memory {
    bootstrapCorps?: { [roomName: string]: SerializedBootstrapCorp };
    miningCorps?: { [sourceId: string]: SerializedRealMiningCorp };
    haulingCorps?: { [roomName: string]: SerializedRealHaulingCorp };
    upgradingCorps?: { [roomName: string]: SerializedRealUpgradingCorp };
    scoutCorps?: { [roomName: string]: SerializedScoutCorp };
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

/** Scout corps per room */
const scoutCorps: { [roomName: string]: ScoutCorp } = {};

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

  // Run scout corps (room exploration)
  runScoutCorps();

  // Initialize or restore colony
  colony = getOrCreateColony();

  // Make colony available globally for debugging
  global.colony = colony;
  global.bootstrapCorps = bootstrapCorps;
  global.miningCorps = miningCorps;
  global.haulingCorps = haulingCorps;
  global.upgradingCorps = upgradingCorps;
  global.scoutCorps = scoutCorps;

  // Run unified multi-room spatial analysis (periodically - expensive)
  // Also run on first tick if we don't have any nodes yet
  if (Game.time % NEARBY_ROOM_EXPANSION_INTERVAL === 0 || colony.getNodes().length === 0) {
    runMultiRoomAnalysis(colony);
  }

  // Render visualizations for flagged rooms
  renderNearbyRoomVisuals();

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
 * Run scout corps for all owned rooms.
 *
 * Scout corps create minimal creeps (1 MOVE) that explore nearby rooms
 * to gather intel about sources, minerals, hostiles, etc.
 */
function runScoutCorps(): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];

    // Only process owned rooms with spawns
    if (!room.controller?.my) continue;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;

    // Get or create scout corp for this room
    let scoutCorp = scoutCorps[roomName];

    if (!scoutCorp) {
      // Try to restore from memory
      const saved = Memory.scoutCorps?.[roomName];
      if (saved) {
        scoutCorp = new ScoutCorp(saved.nodeId, saved.spawnId);
        scoutCorp.deserialize(saved);
        scoutCorps[roomName] = scoutCorp;
      } else {
        // Create new
        const newCorp = createScoutCorp(room);
        if (newCorp) {
          newCorp.createdAt = Game.time;
          scoutCorps[roomName] = newCorp;
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

/** Cache for multi-room analysis results */
let multiRoomAnalysisCache: { result: MultiRoomAnalysisResult; tick: number } | null = null;

/**
 * Force recalculation of multi-room spatial analysis.
 * Call from console: `global.recalculateTerrain()`
 */
global.recalculateTerrain = () => {
  multiRoomAnalysisCache = null;
  // Actually run the analysis now
  if (colony) {
    const nodeCountBefore = colony.getNodes().length;
    console.log(`[MultiRoom] Forcing recalculation now (clearing ${nodeCountBefore} existing nodes)...`);
    runMultiRoomAnalysis(colony);
    const nodeCountAfter = colony.getNodes().length;
    console.log(`[MultiRoom] Recalculation complete: ${nodeCountAfter} nodes`);
  } else {
    console.log("[MultiRoom] Cache cleared - will recalculate when colony exists");
  }
};

/**
 * Show node summary with ROI scores based on potential corps.
 * Call from console: `global.showNodes()`
 */
global.showNodes = () => {
  if (!colony) {
    console.log("[Nodes] No colony exists yet");
    return;
  }

  const nodes = colony.getNodes();
  if (nodes.length === 0) {
    console.log("[Nodes] No nodes found. Run global.recalculateTerrain() first.");
    return;
  }

  // Sort by ROI score descending
  const sortedNodes = [...nodes].sort((a, b) => (b.roi?.score ?? 0) - (a.roi?.score ?? 0));

  console.log(`\n=== Colony Nodes (${nodes.length} total) ===`);
  console.log("Sorted by ROI score (based on potential corps value)\n");

  for (const node of sortedNodes) {
    const roi = node.roi;
    if (roi) {
      const corpSummary = roi.potentialCorps.length > 0
        ? roi.potentialCorps.map(c => `${c.type}(${c.estimatedROI.toFixed(2)})`).join(", ")
        : "none";
      const distStr = roi.distanceFromOwned === Infinity ? "∞" : roi.distanceFromOwned.toString();

      console.log(`${node.id} [${roi.isOwned ? "OWNED" : `dist=${distStr}`}]`);
      console.log(`  Score: ${roi.score.toFixed(1)} | Raw Corp ROI: ${roi.rawCorpROI.toFixed(2)} | Openness: ${roi.openness}`);
      console.log(`  Resources: ${roi.sourceCount} sources, ${roi.hasController ? "has controller" : "no controller"}`);
      console.log(`  Potential Corps: ${corpSummary}`);
    } else {
      console.log(`${node.id} | (no ROI data)`);
    }
  }

  // Show top expansion targets
  console.log("\n=== Top Expansion Targets ===");
  const expansionTargets = sortedNodes.filter(n => !n.roi?.isOwned && (n.roi?.score ?? 0) > 0);
  if (expansionTargets.length === 0) {
    console.log("No viable expansion targets found.");
  } else {
    for (const node of expansionTargets.slice(0, 5)) {
      const roi = node.roi!;
      const distStr = roi.distanceFromOwned === Infinity ? "∞" : roi.distanceFromOwned.toString();
      console.log(`  ${node.id}: score=${roi.score.toFixed(1)}, corps=${roi.potentialCorps.length}, dist=${distStr}`);
    }
  }
};

/**
 * Export node graph as JSON for external analysis.
 * Call from console: `global.exportNodes()`
 */
global.exportNodes = (): string => {
  if (!colony) {
    console.log("[Export] No colony exists yet");
    return "{}";
  }

  const nodes = colony.getNodes();

  // Build export structure
  const exportData = {
    exportedAt: Game.time,
    nodeCount: nodes.length,
    nodes: nodes.map(node => ({
      id: node.id,
      roomName: node.roomName,
      peakPosition: node.peakPosition,
      territorySize: node.positions.length,
      resources: node.resources.map(r => ({
        type: r.type,
        id: r.id,
        position: r.position,
        capacity: r.capacity,
        mineralType: r.mineralType
      })),
      roi: node.roi,
      // Include rooms this node spans
      spansRooms: [...new Set(node.positions.map(p => p.roomName))]
    })),
    // Summary stats
    summary: {
      totalSources: nodes.reduce((sum, n) => sum + (n.roi?.sourceCount ?? 0), 0),
      ownedNodes: nodes.filter(n => n.roi?.isOwned).length,
      expansionCandidates: nodes.filter(n => !n.roi?.isOwned && (n.roi?.score ?? 0) > 0).length,
      avgROI: nodes.length > 0
        ? nodes.reduce((sum, n) => sum + (n.roi?.score ?? 0), 0) / nodes.length
        : 0
    }
  };

  const json = JSON.stringify(exportData, null, 2);
  console.log(`[Export] Exported ${nodes.length} nodes. Copy from console or use: JSON.parse(global.exportNodes())`);
  console.log(json);
  return json;
};

/** TTL for multi-room analysis cache */
const MULTI_ROOM_ANALYSIS_CACHE_TTL = 500;

/**
 * Performs unified multi-room spatial analysis and creates/updates nodes.
 *
 * This replaces per-room peak detection with a unified approach where:
 * - Distance transform crosses room boundaries
 * - Peaks are found based on true terrain openness
 * - Territories span rooms based purely on terrain
 */
function runMultiRoomAnalysis(colony: Colony): void {
  // Collect all rooms to analyze (owned + nearby)
  const roomsToAnalyze: string[] = [];

  // Add owned rooms
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.controller?.my) {
      roomsToAnalyze.push(roomName);
    }
  }

  // Add nearby rooms
  const nearbyRooms = discoverNearbyRooms(NEARBY_ROOM_DISTANCE);
  for (const roomName of nearbyRooms) {
    if (!roomsToAnalyze.includes(roomName)) {
      roomsToAnalyze.push(roomName);
    }
  }

  if (roomsToAnalyze.length === 0) return;

  // Check cache
  if (multiRoomAnalysisCache && Game.time - multiRoomAnalysisCache.tick < MULTI_ROOM_ANALYSIS_CACHE_TTL) {
    // Use cached result for visualization
    return;
  }

  console.log(`[MultiRoom] Analyzing ${roomsToAnalyze.length} rooms: ${roomsToAnalyze.join(", ")}`);

  // Run unified multi-room analysis
  const result = analyzeMultiRoomTerrain(roomsToAnalyze, {
    maxRooms: 20, // Must be larger than number of rooms with peaks
    peakOptions: { minHeight: 3, maxPeaks: 20 },
  });

  // Cache result
  multiRoomAnalysisCache = { result, tick: Game.time };

  // Debug: Log peaks per room
  const peaksByRoom = new Map<string, number>();
  for (const peak of result.peaks) {
    peaksByRoom.set(peak.roomName, (peaksByRoom.get(peak.roomName) || 0) + 1);
  }
  console.log(`[MultiRoom] Peaks by room: ${Array.from(peaksByRoom.entries()).map(([r, c]) => `${r}:${c}`).join(", ")}`);

  // Get set of new node IDs from multi-room analysis
  const newNodeIds = new Set(result.peaks.map((p) => p.peakId));

  // Remove existing nodes that are NOT in the new multi-room analysis
  // This clears old per-room nodes that were created before multi-room analysis
  const existingNodes = colony.getNodes();
  for (const node of existingNodes) {
    if (!newNodeIds.has(node.id)) {
      colony.removeNode(node.id);
      console.log(`[MultiRoom] Removed old node ${node.id}`);
    }
  }

  // Clean up room memory nodeIds for all rooms
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.memory.nodeIds) {
      room.memory.nodeIds = room.memory.nodeIds.filter((id) => newNodeIds.has(id));
    }
  }

  const existingNodeIds = new Set(colony.getNodes().map((n) => n.id));

  // Get owned rooms for ROI calculation
  const ownedRooms = new Set<string>();
  for (const roomName in Game.rooms) {
    if (Game.rooms[roomName].controller?.my) {
      ownedRooms.add(roomName);
    }
  }

  // Create surveyor for ROI estimation
  const surveyor = new NodeSurveyor();

  // Track stats for final summary
  let nodesCreated = 0;
  let nodesRemoved = 0;

  // Create/update nodes from peaks
  for (const peak of result.peaks) {
    const nodeId = peak.peakId;

    if (!existingNodeIds.has(nodeId)) {
      // Create new node
      const peakPosition = { x: peak.center.x, y: peak.center.y, roomName: peak.roomName };
      const node = createNode(nodeId, peak.roomName, peakPosition, [], Game.time);
      colony.addNode(node);
      nodesCreated++;
    }

    // Update node positions from unified territories
    const node = colony.getNode(nodeId);
    if (node) {
      const positions = result.territories.get(nodeId);
      if (positions && positions.length > 0) {
        node.positions = positions;

        // Log cross-room territories
        const roomsInTerritory = new Set(positions.map((p) => p.roomName));
        if (roomsInTerritory.size > 1) {
          console.log(`[MultiRoom] Node ${nodeId} spans ${roomsInTerritory.size} rooms: ${Array.from(roomsInTerritory).join(", ")}`);
        }

        // Populate resources from room intel or live data
        populateNodeResources(node);

        // Survey node to find potential corps and their ROI
        const surveyResult = surveyor.survey(node, Game.time);

        // Calculate ROI based on potential corps
        node.roi = calculateNodeROI(node, peak.height, ownedRooms, surveyResult.potentialCorps);
      } else {
        // Node has no territory - remove it
        colony.removeNode(nodeId);
        nodesRemoved++;
        console.log(`[MultiRoom] Removed node ${nodeId} (no territory - peak on wall?)`);
      }
    }
  }

  // Final summary
  const finalNodes = colony.getNodes();
  const nodesByRoom = new Map<string, number>();
  for (const node of finalNodes) {
    nodesByRoom.set(node.roomName, (nodesByRoom.get(node.roomName) || 0) + 1);
  }
  console.log(`[MultiRoom] Analysis complete: ${result.peaks.length} peaks, ${nodesCreated} created, ${nodesRemoved} removed (no territory)`);
  console.log(`[MultiRoom] Final nodes by room: ${Array.from(nodesByRoom.entries()).map(([r, c]) => `${r}:${c}`).join(", ") || "none"}`);
  console.log(`[MultiRoom] Territories in result: ${result.territories.size}`);
}

/**
 * Populates a node's resources from room intel or live game data.
 *
 * Resources are associated with a node if they're within or adjacent to
 * the node's territory positions.
 */
function populateNodeResources(node: Node): void {
  node.resources = [];

  // Get all rooms this node spans
  const roomsInNode = new Set<string>([node.roomName]);
  for (const pos of node.positions) {
    roomsInNode.add(pos.roomName);
  }

  for (const roomName of roomsInNode) {
    // Try live data first (if we have vision)
    const room = Game.rooms[roomName];
    if (room) {
      // Add sources - check if source or any adjacent tile is in territory
      for (const source of room.find(FIND_SOURCES)) {
        if (isNearTerritory(node, source.pos.x, source.pos.y, roomName)) {
          node.resources.push({
            type: "source",
            id: source.id,
            position: { x: source.pos.x, y: source.pos.y, roomName },
            capacity: source.energyCapacity
          });
        }
      }

      // Add controller
      if (room.controller && isNearTerritory(node, room.controller.pos.x, room.controller.pos.y, roomName)) {
        node.resources.push({
          type: "controller",
          id: room.controller.id,
          position: { x: room.controller.pos.x, y: room.controller.pos.y, roomName },
          level: room.controller.level
        });
      }

      // Add minerals
      for (const mineral of room.find(FIND_MINERALS)) {
        if (isNearTerritory(node, mineral.pos.x, mineral.pos.y, roomName)) {
          node.resources.push({
            type: "mineral",
            id: mineral.id,
            position: { x: mineral.pos.x, y: mineral.pos.y, roomName },
            mineralType: mineral.mineralType
          });
        }
      }
    } else {
      // Fall back to room intel
      const intel = Memory.roomIntel?.[roomName];
      if (intel) {
        // Add sources from intel
        for (const sourcePos of intel.sourcePositions || []) {
          if (isNearTerritory(node, sourcePos.x, sourcePos.y, roomName)) {
            node.resources.push({
              type: "source",
              id: `intel-${roomName}-${sourcePos.x}-${sourcePos.y}`,
              position: { x: sourcePos.x, y: sourcePos.y, roomName },
              capacity: 3000 // Default capacity
            });
          }
        }

        // Add controller from intel (if we have position)
        if (intel.controllerPos && isNearTerritory(node, intel.controllerPos.x, intel.controllerPos.y, roomName)) {
          node.resources.push({
            type: "controller",
            id: `intel-controller-${roomName}`,
            position: { x: intel.controllerPos.x, y: intel.controllerPos.y, roomName },
            level: intel.controllerLevel
          });
        }

        // Add mineral from intel
        if (intel.mineralPos && isNearTerritory(node, intel.mineralPos.x, intel.mineralPos.y, roomName)) {
          node.resources.push({
            type: "mineral",
            id: `intel-mineral-${roomName}`,
            position: { x: intel.mineralPos.x, y: intel.mineralPos.y, roomName },
            mineralType: intel.mineralType ?? undefined
          });
        }
      }
    }
  }
}

/**
 * Checks if a position is within or adjacent to a node's territory.
 * This is more lenient than exact position matching - a source next to
 * territory tiles should still be associated with that node.
 */
function isNearTerritory(node: Node, x: number, y: number, roomName: string): boolean {
  // Check exact position first
  if (isPositionInTerritory(node, x, y, roomName)) {
    return true;
  }

  // Check adjacent positions (sources/controllers are often on tiles next to walkable areas)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      if (isPositionInTerritory(node, x + dx, y + dy, roomName)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Checks if a position is within a node's territory.
 */
function isPositionInTerritory(node: Node, x: number, y: number, roomName: string): boolean {
  return node.positions.some(p => p.x === x && p.y === y && p.roomName === roomName);
}

/**
 * Gets or creates a RoomMap using only terrain data (no vision required).
 * Used for nearby rooms we don't have vision in.
 */
function getOrCreateRoomMapByName(roomName: string): RoomMap {
  const cached = roomMapCache[roomName];
  if (cached && Game.time - cached.tick < ROOM_MAP_CACHE_TTL) {
    return cached.map;
  }

  const map = RoomMap.fromRoomName(roomName);
  roomMapCache[roomName] = { map, tick: Game.time };

  return map;
}

/**
 * Render visualizations for nearby rooms.
 * If ANY visual flag exists, renders in ALL analyzed rooms.
 * Works even for rooms without vision.
 */
function renderNearbyRoomVisuals(): void {
  // Check if any visual flags exist
  const roomsToVisualize = getRoomsToVisualize();
  const hasAnyVisualFlag = roomsToVisualize.size > 0;

  if (!hasAnyVisualFlag) {
    return; // No visual flags, skip rendering
  }

  // If we have multi-room analysis, render all analyzed rooms
  if (multiRoomAnalysisCache) {
    // Collect all unique rooms from peaks and territories
    const allRooms = new Set<string>();
    for (const peak of multiRoomAnalysisCache.result.peaks) {
      allRooms.add(peak.roomName);
    }
    for (const positions of multiRoomAnalysisCache.result.territories.values()) {
      for (const pos of positions) {
        allRooms.add(pos.roomName);
      }
    }
    for (const roomName of allRooms) {
      visualizeMultiRoomAnalysis(roomName, multiRoomAnalysisCache.result, false, true);
    }
  } else {
    // Fall back to per-room visualization for flagged rooms only
    for (const roomName of roomsToVisualize) {
      const map = getOrCreateRoomMapByName(roomName);
      map.renderByName();
    }
  }
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

  // Persist scout corps
  Memory.scoutCorps = {};
  for (const roomName in scoutCorps) {
    Memory.scoutCorps[roomName] = scoutCorps[roomName].serialize();
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

  let totalScouts = 0;
  for (const roomName in scoutCorps) {
    totalScouts += scoutCorps[roomName].getCreepCount();
  }

  console.log(`  Miners: ${totalMiners}, Haulers: ${totalHaulers}, Upgraders: ${totalUpgraders}, Scouts: ${totalScouts}`);
}
