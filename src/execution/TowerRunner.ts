/**
 * @fileoverview TowerRunner - fire each owned room's towers (RCL 3+).
 *
 * Spec 07 v1, deliberately tiny: every tick, each tower with enough energy
 * shoots the closest hostile creep. No heal/repair logic, no target
 * prioritization beyond distance - the engine's NPC raid table (spec 13
 * ground truth) guarantees owned rooms below RCL4 only ever face 10-part
 * "small" invaders, which closest-first tower fire deletes unaided.
 *
 * Firing is intent-only and cheap; this runs every tick from the main loop,
 * pattern of LinkRunner.
 *
 * @module execution/TowerRunner
 */

/** Don't attempt a shot the tower can't pay for (TOWER_ENERGY_COST = 10). */
const TOWER_MIN_FIRE_ENERGY = 10;

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

/** Run the towers of every owned room. */
export function runTowers(): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller?.my) continue;

    const hostiles = room.find(FIND_HOSTILE_CREEPS);
    if (hostiles.length === 0) continue;

    const towers = room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_TOWER
    }) as StructureTower[];

    for (const tower of towers) {
      if (tower.store[RESOURCE_ENERGY] < TOWER_MIN_FIRE_ENERGY) continue;
      const target = pickTowerTarget(hostiles.map(h => ({ range: tower.pos.getRangeTo(h.pos) })));
      if (target !== null) {
        tower.attack(hostiles[target]);
      }
    }
  }
}
