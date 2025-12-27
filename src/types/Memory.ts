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
import {
  SerializedBootstrapCorp,
  SerializedHarvestCorp,
  SerializedCarryCorp,
  SerializedUpgradingCorp,
  SerializedScoutCorp,
  SerializedConstructionCorp,
  SerializedSpawningCorp,
} from "../corps";

declare global {
  /**
   * Room intelligence data from scouting.
   */
  interface RoomIntel {
    /** Game tick when this room was last visited */
    lastVisit: number;
    /** Number of energy sources in the room */
    sourceCount: number;
    /** Positions of energy sources */
    sourcePositions: { x: number; y: number }[];
    /** Type of mineral in the room (if any) */
    mineralType: MineralConstant | null;
    /** Position of the mineral (if any) */
    mineralPos: { x: number; y: number } | null;
    /** Controller level (0 if unclaimed) */
    controllerLevel: number;
    /** Position of controller (if any) */
    controllerPos: { x: number; y: number } | null;
    /** Username of controller owner (if owned) */
    controllerOwner: string | null;
    /** Username of controller reserver (if reserved) */
    controllerReservation: string | null;
    /** Number of hostile creeps observed */
    hostileCreepCount: number;
    /** Number of hostile structures observed */
    hostileStructureCount: number;
    /** Whether the room appears safe for operations */
    isSafe: boolean;
  }

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
     * Edges between nodes (adjacent territories).
     * Format: Array of "nodeId1|nodeId2" strings (sorted alphabetically).
     */
    nodeEdges?: string[];

    /**
     * Economic edges between corp-hosting nodes.
     * Format: Map of "nodeId1|nodeId2" -> distance (sorted alphabetically).
     */
    economicEdges?: { [edge: string]: number };

    /**
     * Serialized chains for persistence.
     */
    chains?: { [chainId: string]: SerializedChain };

    /**
     * Tick when last planning phase was run.
     */
    lastPlanningTick?: number;

    /**
     * Tick when last survey phase was run.
     */
    lastSurveyTick?: number;

    /**
     * Tick when the controller RCL last increased.
     * Used by FlowEconomy to boost construction priority after RCL-up.
     */
    lastRclUpTick?: number;

    /**
     * Room map cache metadata (tick when last computed).
     */
    roomMapCache?: { [roomName: string]: number };

    /**
     * Room intelligence data from scouting.
     */
    roomIntel?: { [roomName: string]: RoomIntel };

    /**
     * Serialized bootstrap corps by room name.
     */
    bootstrapCorps?: { [roomName: string]: SerializedBootstrapCorp };

    /**
     * Serialized harvest corps by source ID.
     */
    harvestCorps?: { [sourceId: string]: SerializedHarvestCorp };

    /**
     * Serialized hauling corps by room name.
     */
    haulingCorps?: { [roomName: string]: SerializedCarryCorp };

    /**
     * Serialized upgrading corps by room name.
     */
    upgradingCorps?: { [roomName: string]: SerializedUpgradingCorp };

    /**
     * Serialized scout corps by room name.
     */
    scoutCorps?: { [roomName: string]: SerializedScoutCorp };

    /**
     * Serialized construction corps by room name.
     */
    constructionCorps?: { [roomName: string]: SerializedConstructionCorp };

    /**
     * Serialized spawning corps by spawn ID.
     */
    spawningCorps?: { [spawnId: string]: SerializedSpawningCorp };
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
    workType?: "harvest" | "haul" | "upgrade" | "build" | "repair" | "scout";

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

    /**
     * ID of the SpawningCorp that spawned this creep.
     */
    spawnedBy?: string;

    /**
     * Contract ID this creep was spawned for.
     */
    contractId?: string;

    /**
     * Whether this is a maintenance hauler spawned by SpawningCorp
     * to break energy starvation. These haulers are assigned to the
     * room's HaulingCorp but don't fulfill contract commitments.
     */
    isMaintenanceHauler?: boolean;

    /**
     * Target room for scout creeps.
     * Each scout gets assigned a unique room to explore.
     */
    targetRoom?: string;

    /**
     * Assigned source ID for hauler creeps.
     * Used to prevent thrashing by giving each hauler a stable route.
     */
    assignedSourceId?: string;
  }
}

export {};
