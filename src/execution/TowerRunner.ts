/**
 * @fileoverview TowerRunner - fire each owned room's towers (RCL 3+), and, in
 * peacetime, top up decaying roads/containers within good range.
 *
 * Spec 07 v1 was deliberately tiny: every tick, each tower with enough energy
 * shoots the closest hostile creep. No target prioritization beyond distance -
 * the engine's NPC raid table (spec 13 ground truth) guarantees owned rooms
 * below RCL4 only ever face 10-part "small" invaders, which closest-first tower
 * fire deletes unaided. That defense duty is UNTOUCHED and always wins: a tower
 * only ever repairs on a tick when the room holds NO hostiles (a tower has one
 * intent per tick, and defense is never traded for maintenance).
 *
 * PEACE-TIME REPAIR (owner directive 2026-07-19). A tower repair action costs
 * TOWER_ENERGY_COST (10) for TOWER_POWER_REPAIR (800) hits at range <=5 - 80
 * hits/energy, ~0.8x a WORK part's flat 100 hits/energy - falling to ~65 at
 * range 10 and 20 hits/energy (5x worse) by range 20. So repair is gated to
 * TOWER_REPAIR_RANGE (10): inside it the ~25-35% energy premium buys back the
 * colony's SCARCE resource (spawn build-time and the CPU/pathing of a repairer
 * creep - see economy/roadEconomics), which the macro doctrine funds from the
 * residual. Past range 10 the energy waste dominates and maintenance stays with
 * the ConstructionCorp builder fleet.
 *
 * This composes with the builder fleet WITHOUT touching the demand side: the
 * ConstructionCorp fields a maintenance builder only once a structure drops
 * below REPAIR_SPAWN_BELOW (0.6); a tower that pins its in-range structures near
 * the REPAIR_TO ceiling means they never reach that gate, so the builder simply
 * never fields FOR them, while out-of-range structures still trigger it exactly
 * as before. No double-repair, no SpawnDirector change.
 *
 * Firing and repair are intent-only and cheap; this runs every tick from the
 * main loop, pattern of LinkRunner.
 *
 * @module execution/TowerRunner
 */

import { REPAIR_TO } from "../corps/repair";

/** Don't attempt a shot the tower can't pay for (TOWER_ENERGY_COST = 10). */
const TOWER_MIN_FIRE_ENERGY = 10;

/**
 * Only repair structures within this range. At range <=5 a tower does 80
 * hits/energy (0.8x a WORK part); by range 10 ~65 hits/energy. Past here the
 * falloff (25% effect, 20 hits/energy, at range 20) makes tower repair 5x
 * worse than a builder - against the production-over-consumption doctrine - so
 * out-of-range decay stays with the ConstructionCorp maintenance fleet.
 */
export const TOWER_REPAIR_RANGE = 10;

/**
 * A tower never spends below this on repair, so a repair pass can never leave it
 * unable to burst on an invader next tick. Defense always spends freely (the
 * repair path is skipped entirely while any hostile is in the room); this floor
 * only caps the PEACE-time residual sink, keeping repair a consumer of surplus
 * (macro doctrine) rather than draining the defensive buffer.
 */
export const TOWER_REPAIR_RESERVE = 500;

/**
 * Pure fire decision: index of the closest hostile, or null for no shot.
 * Ties break to the LOWER index (determinism - spec 07 acceptance).
 */
export function pickTowerTarget(hostiles: { range: number }[]): number | null {
  if (hostiles.length === 0) return null;
  let best = 0;
  for (let i = 1; i < hostiles.length; i++) {
    if (hostiles[i].range < hostiles[best].range) best = i;
  }
  return best;
}

/**
 * Pure repair decision: index of the structure a tower should repair this tick,
 * or null for none. Candidates within TOWER_REPAIR_RANGE and below the REPAIR_TO
 * ceiling are eligible; the most-decayed by hits FRACTION wins (same lens as
 * corps/repair.pickRepairTarget, so roads and containers of different hitsMax
 * rank fairly), ties breaking to the LOWER index for determinism.
 */
export function pickTowerRepairTarget(
  candidates: { range: number; hits: number; hitsMax: number }[]
): number | null {
  let best = -1;
  let bestFraction = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.range > TOWER_REPAIR_RANGE) continue;
    if (c.hits >= c.hitsMax * REPAIR_TO) continue; // already at the ceiling
    const fraction = c.hits / c.hitsMax;
    if (fraction < bestFraction) {
      bestFraction = fraction;
      best = i;
    }
  }
  return best === -1 ? null : best;
}

/** Run the towers of every owned room. */
export function runTowers(): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller?.my) continue;

    const towers = room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_TOWER
    }) as StructureTower[];
    if (towers.length === 0) continue;

    // DEFENSE first and exclusive: while any hostile is in the room, every
    // tower's single intent goes to closest-first fire - never repair.
    const hostiles = room.find(FIND_HOSTILE_CREEPS);
    if (hostiles.length > 0) {
      for (const tower of towers) {
        if (tower.store[RESOURCE_ENERGY] < TOWER_MIN_FIRE_ENERGY) continue;
        const target = pickTowerTarget(hostiles.map(h => ({ range: tower.pos.getRangeTo(h.pos) })));
        if (target !== null) {
          tower.attack(hostiles[target]);
        }
      }
      continue;
    }

    // PEACE: top up decaying roads/containers in good range from the residual
    // energy above the defensive reserve.
    const repairables = room.find(FIND_STRUCTURES, {
      filter: s =>
        (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) &&
        s.hits < s.hitsMax * REPAIR_TO
    }) as (StructureRoad | StructureContainer)[];
    if (repairables.length === 0) continue;

    for (const tower of towers) {
      if (tower.store[RESOURCE_ENERGY] <= TOWER_REPAIR_RESERVE) continue;
      const target = pickTowerRepairTarget(
        repairables.map(s => ({ range: tower.pos.getRangeTo(s.pos), hits: s.hits, hitsMax: s.hitsMax }))
      );
      if (target !== null) {
        tower.repair(repairables[target]);
      }
    }
  }
}
