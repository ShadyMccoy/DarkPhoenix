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
 * Long-commute jack for real-map distances. The 1W1C1M jack was tuned on
 * synthetic 5-tile rooms; on a captured live room (sources at path ~15-25) it
 * moves 50 energy per ~2t/tile round trip - ~0.6 e/t - and RCL1->2 takes
 * ~550 ticks (measured, sim:real shard3 W1N6). The 1W2C2M jack carries double
 * at 1.5 t/tile loaded (~2.6x throughput) for 1.5x cost, still within the
 * bare spawn's 300.
 */
export const LONG_JACK_BODY: BodyPartConstant[] = [WORK, CARRY, CARRY, MOVE, MOVE];
export const LONG_JACK_COST = 300;

/** Path distance (spawn -> source) beyond which the long jack pays. */
export const JACK_LONG_COMMUTE = 10;

/**
 * Jack body for a given spawn->source path distance. Pure - the distance
 * comes from the caller (PathFinder in production, a number in tests).
 */
export function jackBodyForCommute(pathDistance: number): { body: BodyPartConstant[]; cost: number } {
  return pathDistance > JACK_LONG_COMMUTE
    ? { body: LONG_JACK_BODY, cost: LONG_JACK_COST }
    : { body: JACK_BODY, cost: JACK_COST };
}

// Note: Miner bodies are now dynamically built by BodyBuilder based on
// room.energyCapacityAvailable. See spawn/BodyBuilder.ts

// Note: Hauler bodies are now dynamically built by BodyBuilder based on
// energy flow rate and distance. See spawn/BodyBuilder.ts and CarryCorp.ts

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
// and distance. See CarryCorp.ts

/**
 * Maximum upgraders per room.
 */
export const MAX_UPGRADERS = 2;

/**
 * Maximum scouts per scout corp.
 */
export const MAX_SCOUTS = 1;

/**
 * Minimum room control level before a scout may be spawned. Below this the
 * home economy is still bootstrapping and cannot spare the energy or spawn
 * time for exploration.
 */
export const MIN_SCOUT_RCL = 2;

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

/**
 * Anti-downgrade emergency thresholds (see BootstrapCorp.runAntiDowngrade).
 *
 * During construction the flow economy starves the controller of energy on
 * purpose (building supersedes upgrading), so its downgrade timer ticks down.
 * When it falls below TRIGGER, a self-sufficient jack is dispatched to top the
 * controller back up; once the timer climbs back above SAFE the jack's job is
 * done and it recycles itself. Level-1 controllers cannot downgrade, so this
 * only applies at MIN_RCL and above.
 */
export const ANTI_DOWNGRADE_TRIGGER_TICKS = 3000;
export const ANTI_DOWNGRADE_SAFE_TICKS = 7000;
export const ANTI_DOWNGRADE_MIN_RCL = 2;
