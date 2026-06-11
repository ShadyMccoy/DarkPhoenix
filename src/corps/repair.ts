/**
 * @fileoverview Container maintenance rules (pure).
 *
 * Containers decay - in an owned room a container loses CONTAINER_DECAY (5000)
 * hits every CONTAINER_DECAY_TIME_OWNED (500) ticks, ~10 hits/tick - so left
 * unrepaired they eventually die. The ConstructionCorp that builds them also
 * maintains them: when there is nothing to build, a builder tops up the most
 * decayed container, and the corp fields a small maintenance builder on demand.
 *
 * These two functions are the decision rules, kept pure so the thresholds and the
 * hysteresis are unit-tested without a live room. The creep.repair() execution and
 * room scanning live in ConstructionCorp.
 *
 * @module corps/repair
 */

/** Builder repairs any container below this fraction of max hits (the ceiling). */
export const REPAIR_TO = 0.99;

/**
 * Only START a maintenance builder once a container drops below this fraction.
 * Lower than REPAIR_TO on purpose: the builder repairs back up to the ceiling and
 * retires, so the next spawn is one full decay band away (~thousands of ticks)
 * instead of every time a container dips a hair below the ceiling.
 */
export const REPAIR_SPAWN_BELOW = 0.6;

interface Repairable {
  hits: number;
  hitsMax: number;
}

/**
 * The most-decayed structure below `belowFraction` of its max hits, or null if all
 * are healthier than that. This is what a builder repairs next.
 */
export function pickRepairTarget<T extends Repairable>(structures: T[], belowFraction: number): T | null {
  let worst: T | null = null;
  for (const s of structures) {
    if (s.hits >= s.hitsMax * belowFraction) continue;
    if (!worst || s.hits < worst.hits) worst = s;
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
