/**
 * @fileoverview Screeps Memory type extensions.
 *
 * Extends the global Screeps memory interfaces to support
 * colony routine persistence.
 *
 * @module types/Memory
 */

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
   */
  role?: string;
}
