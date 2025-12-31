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
  SerializedUpgradingCorp,
  SerializedScoutCorp,
  SerializedConstructionCorp,
  SerializedSpawningCorp,
  SerializedHaulerCorp,
  SerializedTankerCorp,
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
     * Flag set after one-time memory wipe on respawn.
     * Remove this (and the wipe code in main.ts) after confirming respawn works.
     */
    memoryCleared?: boolean;

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
     * Walking distances for spatial edges between adjacent nodes.
     * Format: Map of "nodeId1|nodeId2" -> distance in tiles.
     * Calculated from node peak positions.
     */
    spatialEdgeWeights?: { [edge: string]: number };

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
     * Serialized hauler corps by source ID.
     * Haulers work on edges, transporting energy from source to sink.
     */
    haulerCorps?: { [sourceId: string]: SerializedHaulerCorp };

    /**
     * Serialized tanker corps by node ID.
     * Tankers work within nodes, distributing energy locally.
     */
    tankerCorps?: { [nodeId: string]: SerializedTankerCorp };

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
     * - harvest: Mining energy from sources
     * - haul: Edge-based transport (source to sink via paths)
     * - tank: Node-based local distribution (fill extensions/spawns)
     * - upgrade: Controller upgrading
     * - build: Construction
     * - repair: Structure repair
     * - scout: Room scouting
     */
    workType?: "harvest" | "haul" | "tank" | "upgrade" | "build" | "repair" | "scout";

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

    /**
     * Assigned source position for intel-based remote sources.
     * Used when the source object isn't visible (remote room without vision).
     */
    assignedSourcePos?: { x: number; y: number; roomName: string };

    // === Fleet Coordination (Belt/Bus System) ===

    /**
     * Hauler's slot in the fleet circulation.
     * Determines their starting position in the structure rotation.
     * Assigned once when hauler joins corp, persists for their lifetime.
     */
    haulerSlot?: number;

    /**
     * Current rotation offset in the delivery circulation.
     * Increments after each successful delivery, wraps around.
     * Combined with haulerSlot to determine target structure.
     */
    deliveryRotation?: number;

    /**
     * Current delivery target ID.
     * Persists across ticks to prevent reactive switching.
     * Cleared after successful delivery to trigger rotation.
     */
    deliveryTargetId?: string;
  }
}

export {};
