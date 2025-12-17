/**
 * @fileoverview Screeps Memory type extensions.
 *
 * Extends the global Screeps memory interfaces to support
 * colony-based economic system persistence.
 *
 * @module types/Memory
 */

import { SerializedColony } from "../colony/Colony";
import { SerializedNode } from "../nodes/Node";
import { SerializedChain } from "../planning/Chain";

declare global {
  /**
   * Extended global memory with colony persistence.
   */
  interface Memory {
    /**
     * Serialized colony state for persistence across ticks.
     */
    colony?: SerializedColony;

    /**
     * Serialized nodes (territories) for persistence.
     */
    nodes?: { [nodeId: string]: SerializedNode };

    /**
     * Serialized chains for persistence.
     */
    chains?: { [chainId: string]: SerializedChain };

    /**
     * Room map cache metadata (tick when last computed).
     */
    roomMapCache?: { [roomName: string]: number };
  }

  /**
   * Extended room memory for colony operations.
   */
  interface RoomMemory {
    /**
     * Node IDs associated with this room.
     */
    nodeIds?: string[];

    /**
     * Last surveyed tick for this room.
     */
    lastSurveyTick?: number;
  }

  /**
   * Extended creep memory with corp assignment.
   */
  interface CreepMemory {
    /**
     * The corp ID this creep is assigned to.
     */
    corpId?: string;

    /**
     * The type of work this creep performs.
     */
    workType?: "harvest" | "haul" | "upgrade" | "build" | "repair";

    /**
     * Target ID for current task.
     */
    targetId?: string;

    /**
     * Source ID for hauling tasks.
     */
    sourceId?: string;

    /**
     * Destination ID for hauling tasks.
     */
    destinationId?: string;

    /**
     * Whether creep is currently working (vs traveling).
     */
    working?: boolean;
  }
}

export {};
