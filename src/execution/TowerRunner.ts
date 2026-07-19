/**
 * @fileoverview TowerRunner - fire each owned room's towers (RCL 3+).
 *
 * v1 (spec 07) was deliberately tiny: every tower shoots the closest hostile.
 * That is optimal against the lone 10-part invaders an owned room faces below
 * RCL4, but it loses to a HEALER: a single healer cancels one tower's damage on
 * one creep, so spreading fire thin (or predictably focusing) nets zero kills.
 *
 * v2 (spec 07, focus-fire game — ported from the bonzAI defense sauce) beats
 * pre-emptive healing by playing a pursuit game keyed on tick-over-tick HP
 * (`assignTowerFire`). The unpredictability the enemy sees is adaptive tracking,
 * NOT randomness — targeting stays fully deterministic so the grid (spec 08)
 * remains pinned.
 *
 * Firing is intent-only and cheap; this runs every tick from the main loop,
 * pattern of LinkRunner.
 *
 * @module execution/TowerRunner
 */

import "../types/Memory"; // Memory.towerTargeting augmentation (focus-fire HP memory)

/** Don't attempt a shot the tower can't pay for (TOWER_ENERGY_COST = 10). */
const TOWER_MIN_FIRE_ENERGY = 10;

/**
 * Pure fire decision: index of the closest hostile, or null for no shot.
 * Ties break to the LOWER index (determinism - spec 07 acceptance).
 *
 * Retained from v1 for the single-target range decision and its unit contract;
 * the live loop uses `assignTowerFire` (below) for multi-tower focus fire.
 */
export function pickTowerTarget(hostiles: { range: number }[]): number | null {
  if (hostiles.length === 0) return null;
  let best = 0;
  for (let i = 1; i < hostiles.length; i++) {
    if (hostiles[i].range < hostiles[best].range) best = i;
  }
  return best;
}

/** A hostile as seen by the focus-fire planner: stable id + current/max HP. */
export interface TowerFireHostile {
  id: string;
  hits: number;
  hitsMax: number;
}

/**
 * Pure multi-tower focus-fire plan: for each of `towerCount` towers, the INDEX
 * (into `hostiles`) it should fire at, or null to hold. `prevHits` is last
 * tick's hits by hostile id — the heal-baiting signal.
 *
 * The pool of creeps worth shooting is chosen in three tiers, most-committed
 * first, so fire naturally narrows 3→2→1 as the healer covers one target/tick:
 *   1. DROPPING — hits fell since last tick: the healer is NOT covering them, so
 *      we're winning here → collapse fire (this is the kill).
 *   2. WOUNDED — nobody dropped, but some sit below max: keep the pressure on the
 *      damaged ones rather than poking full creeps.
 *   3. PROBE — everyone is at full (first contact, or heals topping all). Spread
 *      across creeps we have no history on (or all, if all are known-covered) to
 *      force a wound and reveal where the heals go.
 *
 * Within the pool, towers assign lowest-HP-first (round-robin), so the weakest
 * creep soaks any surplus tower. Deterministic throughout: equal HP breaks ties
 * to the lower id.
 */
export function assignTowerFire(
  hostiles: TowerFireHostile[],
  towerCount: number,
  prevHits: { [id: string]: number }
): (number | null)[] {
  const plan: (number | null)[] = new Array(Math.max(0, towerCount)).fill(null);
  if (towerCount <= 0 || hostiles.length === 0) return plan;

  const indexed = hostiles.map((h, i) => ({ h, i }));

  const dropping = indexed.filter(({ h }) => prevHits[h.id] !== undefined && h.hits < prevHits[h.id]);
  let pool: { h: TowerFireHostile; i: number }[];
  if (dropping.length > 0) {
    pool = dropping;
  } else {
    const wounded = indexed.filter(({ h }) => h.hits < h.hitsMax);
    if (wounded.length > 0) {
      pool = wounded;
    } else {
      // Everyone full: probe the creeps we have no history on (a known-covered
      // creep at full is the healer's — don't waste fire re-poking it). If all
      // carry history (all covered), fall back to the whole set.
      const fresh = indexed.filter(({ h }) => prevHits[h.id] === undefined);
      pool = fresh.length > 0 ? fresh : indexed;
    }
  }

  // Lowest HP first; ties to the lower id (determinism — spec 07 acceptance).
  pool.sort((a, b) => a.h.hits - b.h.hits || (a.h.id < b.h.id ? -1 : a.h.id > b.h.id ? 1 : 0));

  for (let t = 0; t < towerCount; t++) {
    plan[t] = pool[t % pool.length].i;
  }
  return plan;
}

/** Run the towers of every owned room. */
export function runTowers(): void {
  if (!Memory.towerTargeting) Memory.towerTargeting = {};

  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller?.my) continue;

    const hostiles = room.find(FIND_HOSTILE_CREEPS);
    if (hostiles.length === 0) {
      // Fight over: drop the HP memory so a later raid starts from first contact.
      delete Memory.towerTargeting[roomName];
      continue;
    }

    const towers = room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_TOWER
    }) as StructureTower[];
    const ready = towers.filter(t => t.store[RESOURCE_ENERGY] >= TOWER_MIN_FIRE_ENERGY);

    // Last tick's HP is only a valid net-damage signal if it is EXACTLY last
    // tick's (a paused-then-resumed fight must probe fresh, not compare stale HP).
    const stored = Memory.towerTargeting[roomName];
    const prevHits = stored && stored.tick === Game.time - 1 ? stored.hits : {};

    if (ready.length > 0) {
      const plan = assignTowerFire(
        hostiles.map(h => ({ id: h.id, hits: h.hits, hitsMax: h.hitsMax })),
        ready.length,
        prevHits
      );
      for (let i = 0; i < ready.length; i++) {
        const target = plan[i];
        if (target !== null) ready[i].attack(hostiles[target]);
      }
    }

    // Record this tick's HP for next tick's net-damage read.
    const hits: { [id: string]: number } = {};
    for (const h of hostiles) hits[h.id] = h.hits;
    Memory.towerTargeting[roomName] = { tick: Game.time, hits };
  }
}
