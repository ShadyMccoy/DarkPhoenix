/**
 * @fileoverview Decaying-structure maintenance rules (pure).
 *
 * Containers decay - in an owned room a container loses CONTAINER_DECAY (5000)
 * hits every CONTAINER_DECAY_TIME_OWNED (500) ticks, ~10 hits/tick - so left
 * unrepaired they eventually die. Roads decay too (traffic-driven; see
 * economy/roadEconomics). The ConstructionCorp that builds them also maintains
 * them: when there is nothing to build, a builder tops up the most decayed
 * structure, and the corp fields a small maintenance builder on demand.
 *
 * Ordering is by hits FRACTION, not absolute hits: the maintained set mixes
 * hitsMax scales (plain road 5k, container 250k, tunnel road 750k), and an
 * absolute sort would chronically starve high-hitsMax structures - a tunnel at
 * a critical 60% (450k hits) would lose to a plain road at a healthy 98%
 * (4.9k hits) forever.
 *
 * These two functions are the decision rules, kept pure so the thresholds and the
 * hysteresis are unit-tested without a live room. The creep.repair() execution and
 * room scanning live in ConstructionCorp.
 *
 * @module corps/repair
 */

/** Builder repairs any structure below this fraction of max hits (the ceiling). */
export const REPAIR_TO = 0.99;

/**
 * Only START a maintenance builder once a structure drops below this fraction.
 * Lower than REPAIR_TO on purpose: the builder repairs back up to the ceiling and
 * retires, so the next spawn is one full decay band away (~thousands of ticks)
 * instead of every time a container dips a hair below the ceiling.
 */
export const REPAIR_SPAWN_BELOW = 0.6;

/**
 * A structure this decayed is close enough to expiry that a builder repairs it
 * EVEN with construction work outstanding. Ordinary maintenance is gated off
 * entirely while any construction site exists (the builder builds, one site at a
 * time, and only maintains once the room is fully built) - so during a long
 * build-out a container that dips below the idle start gate keeps decaying with
 * nothing coming to repair it, all the way to expiry. Below this critical
 * fraction the value flips: a container is worth 5000 energy to rebuild plus the
 * mining it strands, far more than the marginal delay to a build, so the build
 * crew diverts to save it. Set below REPAIR_SPAWN_BELOW so it only fires for
 * genuinely endangered structures, not routine dips.
 */
export const REPAIR_CRITICAL = 0.3;

/**
 * The most-decayed structure below the critical fraction, or null if none is
 * that low. The trigger for a build crew to divert onto emergency repair.
 */
export function pickCriticalRepairTarget<T extends Repairable>(structures: T[]): T | null {
  return pickRepairTarget(structures, REPAIR_CRITICAL);
}

/**
 * Whether a builder mid-diversion should keep repairing rather than resume
 * building: it started on a critical structure and holds the diversion until
 * nothing is left in the idle-maintenance band (REPAIR_SPAWN_BELOW), comfortably
 * clear of the critical gate. The hysteresis (start at REPAIR_CRITICAL, release
 * at REPAIR_SPAWN_BELOW) stops the crew thrashing between a far site and the
 * container each time the structure dips a hair past the start gate.
 */
export function wantsCriticalRecovery(structures: Repairable[]): boolean {
  return structures.some(s => s.hits < s.hitsMax * REPAIR_SPAWN_BELOW);
}

interface Repairable {
  hits: number;
  hitsMax: number;
}

/**
 * The most-decayed structure below `belowFraction` of its max hits, or null if all
 * are healthier than that. "Most decayed" is the lowest hits/hitsMax fraction, so
 * structures of different scales (roads vs containers) rank fairly.
 */
export function pickRepairTarget<T extends Repairable>(structures: T[], belowFraction: number): T | null {
  let worst: T | null = null;
  for (const s of structures) {
    if (s.hits >= s.hitsMax * belowFraction) continue;
    if (!worst || s.hits / s.hitsMax < worst.hits / worst.hitsMax) worst = s;
  }
  return worst;
}

/**
 * Whether to field (or keep) a maintenance builder, with hysteresis:
 * - if a builder already exists, keep it while anything is below the repair ceiling
 *   (REPAIR_TO) so it finishes the job before retiring;
 * - if no builder exists yet, only start one once a container is genuinely low
 *   (REPAIR_SPAWN_BELOW), so maintenance is infrequent rather than flapping.
 */
export function wantsMaintenanceBuilder(
  structures: Repairable[],
  hasBuilder: boolean,
  repairTo = REPAIR_TO,
  spawnBelow = REPAIR_SPAWN_BELOW
): boolean {
  const anyBelowCeiling = structures.some(s => s.hits < s.hitsMax * repairTo);
  if (!anyBelowCeiling) return false;
  if (hasBuilder) return true;
  return structures.some(s => s.hits < s.hitsMax * spawnBelow);
}
