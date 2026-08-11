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

import { MAX_SCOUT_DISTANCE } from "../economy/primitives";

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

// =============================================================================
// CREEP LIMITS
// =============================================================================

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
// SCOUT-SPECIFIC CONSTANTS
// =============================================================================

/**
 * How old room intel must be before it's worth updating (ticks).
 */
export const STALE_THRESHOLD = 5000;

/**
 * Maximum distance (in room exits) to search for stale rooms.
 *
 * DECLARED in economy/primitives (the ONE leaf every tool can load) and
 * re-exported here so its long-standing importers are unchanged. This module
 * evaluates `JACK_BODY = [WORK, CARRY, MOVE]` at load time, so it cannot be
 * required outside the game engine - and `utils/raidMeter` sits in the audit
 * scripts' import graph. Importing this module from there crashed
 * `npm run audit:ledger` at load with `ReferenceError: WORK is not defined`.
 */
export { MAX_SCOUT_DISTANCE };

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
