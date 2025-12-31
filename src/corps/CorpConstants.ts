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

// Note: Miner bodies are now dynamically built by BodyBuilder based on
// room.energyCapacityAvailable. See spawn/BodyBuilder.ts

// Note: Hauler bodies are now dynamically built by BodyBuilder based on
// energy flow rate and distance. See spawn/BodyBuilder.ts and HaulerCorp.ts

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

// Note: Max harvesters is now dynamically calculated based on available mining
// spots and desired WORK parts. See HarvestCorp.ts

// Note: Max haulers is now dynamically calculated based on energy flow rate
// and distance. See HaulerCorp.ts

/**
 * Maximum upgraders per room.
 */
export const MAX_UPGRADERS = 2;

/**
 * Maximum scouts per scout corp.
 */
export const MAX_SCOUTS = 1;

/**
 * Maximum builders per construction corp.
 */
export const MAX_BUILDERS = 2;

// =============================================================================
// BUILDER-SPECIFIC CONSTANTS
// =============================================================================

/**
 * Builder creep body: work-focused with carry and movement.
 * Cost: 400 energy (WORK:100 + WORK:100 + CARRY:50 + CARRY:50 + MOVE:50 + MOVE:50)
 */
export const BUILDER_BODY: BodyPartConstant[] = [WORK, WORK, CARRY, CARRY, MOVE, MOVE];
export const BUILDER_COST = 400;

/**
 * Minimum profit required before construction corp will invest in extensions.
 * This ensures the economy is stable before expanding.
 */
export const MIN_CONSTRUCTION_PROFIT = 500;

/**
 * Extension construction site progress total.
 * An extension requires 3000 build progress to complete.
 */
export const EXTENSION_BUILD_PROGRESS = 3000;

// =============================================================================
// SCOUT-SPECIFIC CONSTANTS
// =============================================================================

/**
 * Budget for scouting per planning cycle (in energy equivalent).
 * At 50 energy per scout, this allows ~10 scouts per planning cycle.
 */
export const SCOUT_BUDGET_PER_CYCLE = 500;

/**
 * Planning interval for scout purchases (ticks).
 * Scouts are bought in bulk at planning time, not continuously.
 */
export const SCOUT_PLANNING_INTERVAL = 5000;

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

// =============================================================================
// CONTROLLER CONSTANTS
// =============================================================================

/**
 * Threshold for controller downgrade timer that triggers urgency.
 * At RCL 2+, controllers downgrade after 10,000 ticks without upgrading.
 */
export const CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD = 10000;
