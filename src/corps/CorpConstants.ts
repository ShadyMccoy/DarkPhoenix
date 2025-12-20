/**
 * @fileoverview Shared constants for all corps.
 *
 * This module centralizes corp-related constants to:
 * - Prevent duplication across corp implementations
 * - Ensure consistency in behavior
 * - Make tuning easier (single source of truth)
 *
 * @module corps/CorpConstants
 */

// =============================================================================
// SPAWN TIMING
// =============================================================================

/**
 * Default ticks between spawn attempts for production corps.
 * This prevents corps from spamming spawn requests every tick.
 */
export const SPAWN_COOLDOWN = 10;

/**
 * Longer cooldown for scout corps since scouts are less frequently needed.
 */
export const SCOUT_SPAWN_COOLDOWN = 50;

// =============================================================================
// CREEP BODY DEFINITIONS
// =============================================================================

/**
 * Jack creep body for BootstrapCorp: basic all-purpose worker.
 * Cost: 200 energy (WORK:100 + CARRY:50 + MOVE:50)
 */
export const JACK_BODY: BodyPartConstant[] = [WORK, CARRY, MOVE];
export const JACK_COST = 200;

/**
 * Miner creep body: focused on harvesting, minimal carrying.
 * Cost: 250 energy (WORK:100 + WORK:100 + MOVE:50)
 */
export const MINER_BODY: BodyPartConstant[] = [WORK, WORK, MOVE];
export const MINER_COST = 250;

/**
 * Hauler creep body: focused on carrying, no work parts.
 * Cost: 200 energy (CARRY:50 + CARRY:50 + MOVE:50 + MOVE:50)
 */
export const HAULER_BODY: BodyPartConstant[] = [CARRY, CARRY, MOVE, MOVE];
export const HAULER_COST = 200;

/**
 * Upgrader creep body: work-focused with some carry capacity.
 * Cost: 300 energy (WORK:100 + WORK:100 + CARRY:50 + MOVE:50)
 */
export const UPGRADER_BODY: BodyPartConstant[] = [WORK, WORK, CARRY, MOVE];
export const UPGRADER_COST = 300;

/**
 * Scout creep body: minimal, just needs to move.
 * Cost: 50 energy (MOVE:50)
 */
export const SCOUT_BODY: BodyPartConstant[] = [MOVE];
export const SCOUT_COST = 50;

// =============================================================================
// CREEP LIMITS
// =============================================================================

/**
 * Maximum jack creeps per bootstrap corp.
 */
export const MAX_JACKS = 3;

/**
 * Maximum miners per source.
 */
export const MAX_MINERS = 1;

/**
 * Maximum haulers per room.
 */
export const MAX_HAULERS = 2;

/**
 * Maximum upgraders per room.
 */
export const MAX_UPGRADERS = 2;

/**
 * Maximum scouts per scout corp.
 */
export const MAX_SCOUTS = 1;

// =============================================================================
// SCOUT-SPECIFIC CONSTANTS
// =============================================================================

/**
 * How old room intel must be before it's worth updating (ticks).
 */
export const STALE_THRESHOLD = 5000;

/**
 * Maximum distance (in room exits) to search for stale rooms.
 */
export const MAX_SCOUT_DISTANCE = 5;

/**
 * Maximum value for updating very old intel.
 */
export const MAX_INTEL_VALUE = 10;

/**
 * Value multiplier per tick of staleness.
 */
export const VALUE_PER_STALE_TICK = 0.001;
