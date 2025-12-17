/**
 * @fileoverview Screeps Memory type extensions.
 *
 * Extends the global Screeps memory interfaces to support
 * colony routine persistence.
 *
 * @module types/Memory
 */

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
   * Extended global memory with room intel.
   */
  interface Memory {
    /** Room intelligence data from scouting */
    roomIntel: { [roomName: string]: RoomIntel };
  }

  /**
   * Extended room memory with routine persistence.
   */
  interface RoomMemory {
    /**
     * Persisted routine states, keyed by routine type.
     * Each routine type maps to an array of serialized routine instances.
     */
    routines: {
      [routineType: string]: any[];
    };
  }

  /**
   * Extended creep memory with role tracking.
   */
  interface CreepMemory {
    /**
     * Current role of the creep.
     *
     * Roles follow a naming convention:
     * - "jack" - Idle jack (multi-purpose early game)
     * - "busyjack" - Active jack assigned to a routine
     * - "harvester" - Idle harvester
     * - "busyharvester" - Active harvester on a mining operation
     * - "carrier" - Idle carrier
     * - "busycarrier" - Active carrier on a route
     * - "builder" - Idle builder
     * - "busyBuilder" - Active builder on construction
     * - "scout" - Idle scout
     * - "busyscout" - Active scout on exploration
     */
    role?: string;

    /** Target room for scout creeps */
    scoutTarget?: string;
  }
}

export {};
