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
import { serializeNode } from "../nodes";
import { Colony } from "../colony";
import { CorpRegistry } from "./CorpRunner";
import { MultiRoomAnalysisResult } from "../spatial";

/**
 * Persists all state to memory.
 */
export function persistState(
  colony: Colony,
  registry: CorpRegistry,
  analysisCache: { result: MultiRoomAnalysisResult } | null
): void {
  // Sub-timing (diagnostic): split persist into serialize vs the rest so a
  // future hog is attributable. Written to Memory.persistBreakdown, OUTSIDE the
  // infra reconciliation (the umbrella "persist" bucket still totals it), so no
  // double-counting. Cheap: two getUsed() reads.
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

  // Diagnostic breakdown (see top of fn). round(3) to keep Memory small.
  const tEnd = now();
  const r = (n: number): number => Number(n.toFixed(3));
  Memory.persistBreakdown = {
    tick: typeof Game !== "undefined" ? Game.time : 0,
    total: r(tEnd - t0),
    serialize: r(tEnd - t0),
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
