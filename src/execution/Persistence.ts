/**
 * @fileoverview State persistence for colony and corps.
 *
 * This module handles saving and restoring game state to/from Memory.
 * All persistence logic is centralized here to ensure consistent
 * serialization/deserialization across game restarts.
 *
 * @module execution/Persistence
 */

import "../types/Memory";
import { Colony } from "../colony";
import { serializeNode, createEdgeKey } from "../nodes";
import { MultiRoomAnalysisResult } from "../spatial";
import { CorpRegistry } from "./CorpRunner";
import { getMarket } from "../market/Market";

/**
 * Persists all state to memory.
 */
export function persistState(
  colony: Colony,
  registry: CorpRegistry,
  analysisCache: { result: MultiRoomAnalysisResult } | null
): void {
  // Persist colony
  Memory.colony = colony.serialize();

  // Persist nodes
  Memory.nodes = {};
  for (const node of colony.getNodes()) {
    Memory.nodes[node.id] = serializeNode(node);
  }

  // Persist node edges (from cached analysis)
  if (analysisCache?.result.adjacencies) {
    Memory.nodeEdges = Array.from(analysisCache.result.adjacencies);
  }

  // Compute and persist economic edges (nodes with resources)
  // Economic nodes have sources, controllers, or minerals - filter out empty terrain
  const economicNodeIds = new Set<string>();
  const nodePositions = new Map<string, { x: number; y: number; room: string }>();
  for (const node of colony.getNodes()) {
    nodePositions.set(node.id, {
      x: node.peakPosition.x,
      y: node.peakPosition.y,
      room: node.peakPosition.roomName
    });
    const hasEconomicResources = node.resources.some(
      r => r.type === "source" || r.type === "controller" || r.type === "mineral"
    );
    if (hasEconomicResources) {
      economicNodeIds.add(node.id);
    }
  }

  // Build adjacency list from spatial edges
  const adjacency = new Map<string, Set<string>>();
  for (const edge of Memory.nodeEdges || []) {
    const [id1, id2] = edge.split("|");
    if (!adjacency.has(id1)) adjacency.set(id1, new Set());
    if (!adjacency.has(id2)) adjacency.set(id2, new Set());
    adjacency.get(id1)!.add(id2);
    adjacency.get(id2)!.add(id1);
  }

  // Helper to estimate distance between two nodes
  const MAX_ECON_DISTANCE = 2000;
  const estimateDistance = (id1: string, id2: string): number => {
    const p1 = nodePositions.get(id1);
    const p2 = nodePositions.get(id2);
    if (!p1 || !p2) return Infinity;
    // Same room: Chebyshev distance
    if (p1.room === p2.room) {
      return Math.max(Math.abs(p1.x - p2.x), Math.abs(p1.y - p2.y));
    }
    // Different rooms: estimate ~50 tiles per room
    const roomDist = Game.map.getRoomLinearDistance(p1.room, p2.room) * 50;
    return roomDist + Math.max(Math.abs(p1.x - p2.x), Math.abs(p1.y - p2.y));
  };

  // Find economic neighbors: BFS from each economic node through non-economic nodes
  // Track cumulative distance and stop if > MAX_ECON_DISTANCE
  // Then limit to top 10 closest neighbors per node
  const MAX_ECONOMIC_NEIGHBORS = 10;
  const allNeighbors = new Map<string, Array<{ neighbor: string; dist: number }>>();

  for (const startId of economicNodeIds) {
    allNeighbors.set(startId, []);
    const visited = new Map<string, number>(); // nodeId -> distance from start
    visited.set(startId, 0);
    const queue: Array<{ id: string; dist: number }> = [{ id: startId, dist: 0 }];

    while (queue.length > 0) {
      const { id: current, dist: currentDist } = queue.shift()!;
      for (const neighbor of adjacency.get(current) || []) {
        const edgeDist = estimateDistance(current, neighbor);
        const totalDist = currentDist + edgeDist;

        // Skip if too far
        if (totalDist > MAX_ECON_DISTANCE) continue;

        // Skip if already visited with shorter distance
        if (visited.has(neighbor) && visited.get(neighbor)! <= totalDist) continue;
        visited.set(neighbor, totalDist);

        if (economicNodeIds.has(neighbor)) {
          // Found an economic neighbor - record distance (don't continue through it)
          allNeighbors.get(startId)!.push({ neighbor, dist: totalDist });
        } else {
          // Non-economic node - continue searching through it
          queue.push({ id: neighbor, dist: totalDist });
        }
      }
    }
  }

  // For each node, keep only top N closest neighbors
  const economicEdgeMap = new Map<string, number>();
  for (const [startId, neighbors] of allNeighbors) {
    // Sort by distance ascending
    neighbors.sort((a, b) => a.dist - b.dist);

    // Keep top N
    const topN = neighbors.slice(0, MAX_ECONOMIC_NEIGHBORS);
    for (const { neighbor, dist } of topN) {
      const edgeKey = createEdgeKey(startId, neighbor);
      const existingDist = economicEdgeMap.get(edgeKey);
      if (existingDist === undefined || dist < existingDist) {
        economicEdgeMap.set(edgeKey, dist);
      }
    }
  }

  // Convert Map to object
  const econEdgesObj: { [edge: string]: number } = {};
  economicEdgeMap.forEach((dist, edge) => {
    econEdgesObj[edge] = dist;
  });
  Memory.economicEdges = econEdgesObj;

  // Persist bootstrap corps
  Memory.bootstrapCorps = {};
  for (const roomName in registry.bootstrapCorps) {
    Memory.bootstrapCorps[roomName] = registry.bootstrapCorps[roomName].serialize();
  }

  // Persist mining corps
  Memory.harvestCorps = {};
  for (const sourceId in registry.harvestCorps) {
    Memory.harvestCorps[sourceId] = registry.harvestCorps[sourceId].serialize();
  }

  // Persist hauling corps
  Memory.haulingCorps = {};
  for (const roomName in registry.haulingCorps) {
    Memory.haulingCorps[roomName] = registry.haulingCorps[roomName].serialize();
  }

  // Persist upgrading corps
  Memory.upgradingCorps = {};
  for (const roomName in registry.upgradingCorps) {
    Memory.upgradingCorps[roomName] = registry.upgradingCorps[roomName].serialize();
  }

  // Persist scout corps
  Memory.scoutCorps = {};
  for (const roomName in registry.scoutCorps) {
    Memory.scoutCorps[roomName] = registry.scoutCorps[roomName].serialize();
  }

  // Persist construction corps
  Memory.constructionCorps = {};
  for (const roomName in registry.constructionCorps) {
    Memory.constructionCorps[roomName] = registry.constructionCorps[roomName].serialize();
  }

  // Persist spawning corps
  Memory.spawningCorps = {};
  for (const spawnId in registry.spawningCorps) {
    Memory.spawningCorps[spawnId] = registry.spawningCorps[spawnId].serialize();
  }

  // Persist market (central contract store - source of truth for creep assignments)
  Memory.market = getMarket().serialize();
}

/**
 * Cleans up memory for dead creeps.
 */
export function cleanupDeadCreeps(): void {
  for (const name in Memory.creeps) {
    if (!Game.creeps[name]) {
      delete Memory.creeps[name];
    }
  }
}
