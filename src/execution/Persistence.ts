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
import { createEdgeKey, serializeNode } from "../nodes";
import { Colony } from "../colony";
import { CorpRegistry } from "./CorpRunner";
import { MultiRoomAnalysisResult } from "../spatial";

/**
 * Cache guard for the economicEdges BFS - persist's dominant cost (measured 98%
 * of persist, ~54% of the whole tick, when recomputed every tick).
 *
 * This is the "heap cache" trick: module-scope state survives tick-to-tick in
 * the runtime's global (it is NOT re-read from Memory each tick), so a warm
 * signature comparison is far cheaper than rehydrating and recomputing. The
 * catch is that persistence is NOT guaranteed - the runtime container is wiped
 * on a code push AND at random intervals (~every 100-150 ticks). That wipe is
 * exactly our correctness backstop: it clears econCacheSig, so the very next
 * tick recomputes from scratch. The explicit ECON_RECOMPUTE_INTERVAL below caps
 * staleness independently of when the random wipe lands (and refreshes
 * position-based distances); Memory.economicEdges is the durable copy that
 * carries the result across a wipe until that recompute runs.
 */
let econCacheSig: string | undefined;
let econCacheTick = -Infinity;
/** Staleness backstop: recompute at least this often even if the signature is
 * unchanged - covers the rare same-signature topology change and refreshes the
 * position-based distance estimates. Set below the ~100-150t heap-wipe window so
 * it, not the random wipe, is the binding staleness bound. */
const ECON_RECOMPUTE_INTERVAL = 100;

/**
 * Persists all state to memory.
 */
export function persistState(
  colony: Colony,
  registry: CorpRegistry,
  analysisCache: { result: MultiRoomAnalysisResult } | null
): void {
  // Sub-timing (diagnostic): persist is ~55% of the whole tick, so split it
  // into serialize / spatial-edges / econ-edges to confirm which part is the
  // hog before optimizing. Written to Memory.persistBreakdown, OUTSIDE the infra
  // reconciliation (the umbrella "persist" bucket still totals it), so no
  // double-counting. Cheap: three getUsed() reads.
  const now = (): number => (typeof Game !== "undefined" && Game.cpu?.getUsed ? Game.cpu.getUsed() : 0);
  const t0 = now();

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

  const tAfterSerialize = now();

  // Build node position map for distance calculations
  const nodePositions = new Map<string, { x: number; y: number; room: string }>();
  for (const node of colony.getNodes()) {
    nodePositions.set(node.id, {
      x: node.peakPosition.x,
      y: node.peakPosition.y,
      room: node.peakPosition.roomName
    });
  }

  // Helper to estimate walking distance between two nodes using their peak positions
  const estimateDistance = (id1: string, id2: string): number => {
    const p1 = nodePositions.get(id1);
    const p2 = nodePositions.get(id2);
    if (!p1 || !p2) return Infinity;
    // Same room: Chebyshev distance
    if (p1.room === p2.room) {
      return Math.max(Math.abs(p1.x - p2.x), Math.abs(p1.y - p2.y));
    }
    // Different rooms: estimate ~50 tiles per room crossing
    const roomDist = Game.map.getRoomLinearDistance(p1.room, p2.room) * 50;
    return roomDist + Math.max(Math.abs(p1.x - p2.x), Math.abs(p1.y - p2.y));
  };

  // Calculate and persist spatial edge weights
  const spatialWeights: { [edge: string]: number } = {};
  for (const edgeKey of Memory.nodeEdges || []) {
    const [id1, id2] = edgeKey.split("|");
    const distance = estimateDistance(id1, id2);
    if (distance < Infinity) {
      spatialWeights[edgeKey] = distance;
    }
  }
  Memory.spatialEdgeWeights = spatialWeights;

  const tAfterSpatial = now();

  // Compute and persist economic edges (nodes with resources)
  // Economic nodes have sources, controllers, or minerals - filter out empty terrain
  const economicNodeIds = new Set<string>();
  for (const node of colony.getNodes()) {
    const hasEconomicResources = node.resources.some(
      r => r.type === "source" || r.type === "controller" || r.type === "mineral"
    );
    if (hasEconomicResources) {
      economicNodeIds.add(node.id);
    }
  }

  // economicEdges is a PURE FUNCTION of node topology: the economic-node set,
  // the nodeEdges adjacency, and node positions - all of which change only on
  // expansion, room loss, or structural change (rare). The per-economic-node
  // BFS below was the whole tick's largest single cost when re-run every tick,
  // so gate it on a cheap topology signature and reuse the persisted result
  // when nothing changed. The signature is the sorted economic-node ids plus
  // the nodeEdges list (edge adds/removes shift its length or content); building
  // and comparing it is sub-CPU versus the ~65-CPU BFS it guards.
  const econSig = `${[...economicNodeIds].sort().join(",")}::${(Memory.nodeEdges ?? []).join(";")}`;
  const gameTime = typeof Game !== "undefined" ? Game.time : 0;
  const staleBackstop = gameTime - econCacheTick >= ECON_RECOMPUTE_INTERVAL;
  const cacheHit = econSig === econCacheSig && !staleBackstop && Memory.economicEdges !== undefined;

  if (!cacheHit) {
    // Build adjacency list from spatial edges
    const adjacency = new Map<string, Set<string>>();
    for (const edge of Memory.nodeEdges || []) {
      const [id1, id2] = edge.split("|");
      if (!adjacency.has(id1)) adjacency.set(id1, new Set());
      if (!adjacency.has(id2)) adjacency.set(id2, new Set());
      adjacency.get(id1)!.add(id2);
      adjacency.get(id2)!.add(id1);
    }

    const MAX_ECON_DISTANCE = 2000;

    // Find economic neighbors: BFS from each economic node through non-economic nodes
    // Track cumulative distance and stop if > MAX_ECON_DISTANCE
    // Then limit to top 10 closest neighbors per node
    const MAX_ECONOMIC_NEIGHBORS = 10;
    const allNeighbors = new Map<string, { neighbor: string; dist: number }[]>();

    for (const startId of economicNodeIds) {
      allNeighbors.set(startId, []);
      const visited = new Map<string, number>(); // nodeId -> distance from start
      visited.set(startId, 0);
      const queue: { id: string; dist: number }[] = [{ id: startId, dist: 0 }];

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
    econCacheSig = econSig;
    econCacheTick = gameTime;
  }

  const tAfterEcon = now();

  // Persist bootstrap corps
  Memory.bootstrapCorps = {};
  for (const roomName in registry.bootstrapCorps) {
    Memory.bootstrapCorps[roomName] = registry.bootstrapCorps[roomName].serialize();
  }

  // Mining/hauling/upgrading/construction corps persist in
  // Memory.commissionedCorps via CommissionHost; only the registry corps
  // (bootstrap, spawning) are persisted here.

  // Persist spawning corps
  Memory.spawningCorps = {};
  for (const spawnId in registry.spawningCorps) {
    Memory.spawningCorps[spawnId] = registry.spawningCorps[spawnId].serialize();
  }

  // Diagnostic breakdown (see top of fn): serialize is the colony/nodes/corps
  // writes (before + after the edge math); spatial is the spatialEdgeWeights
  // pass; econ is the per-economic-node BFS. round(3) to keep Memory small.
  const tEnd = now();
  const r = (n: number): number => Number(n.toFixed(3));
  Memory.persistBreakdown = {
    tick: typeof Game !== "undefined" ? Game.time : 0,
    total: r(tEnd - t0),
    serialize: r(tAfterSerialize - t0 + (tEnd - tAfterEcon)),
    spatial: r(tAfterSpatial - tAfterSerialize),
    econ: r(tAfterEcon - tAfterSpatial),
    nodeCount: colony.getNodes().length,
    edgeCount: (Memory.nodeEdges ?? []).length
  };
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
