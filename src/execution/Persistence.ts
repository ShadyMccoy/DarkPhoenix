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
import { serializeNode } from "../nodes";
import { MultiRoomAnalysisResult } from "../spatial";
import { CorpRegistry } from "./CorpRunner";

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

  // Persist bootstrap corps
  Memory.bootstrapCorps = {};
  for (const roomName in registry.bootstrapCorps) {
    Memory.bootstrapCorps[roomName] = registry.bootstrapCorps[roomName].serialize();
  }

  // Persist mining corps
  Memory.miningCorps = {};
  for (const sourceId in registry.miningCorps) {
    Memory.miningCorps[sourceId] = registry.miningCorps[sourceId].serialize();
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
