/**
 * @fileoverview Shared runt-recycling helpers.
 *
 * Bootstrap deliberately spawns small bodies so the spawn stays affordable while
 * the economy is cold: a 2-WORK miner now beats a 5-WORK miner never. But once
 * the room is flush those undersized creeps cap the colony's output for their
 * whole 1500-tick life. When the room is maxed out (every store full) and the
 * spawn would otherwise idle, the energy and the spawn tick are free, so we
 * retire the smallest runt; its corp then respawns it at full size. In a
 * constrained room the gate never opens, which is correct - we never disrupt a
 * working creep to chase a bigger body we cannot afford.
 *
 * @module corps/recycle
 */

/**
 * Is the room maxed out (spawn + extensions full) with the spawn idle? Only then
 * is recycling free: the surplus energy and the empty spawn tick would otherwise
 * go to waste, and the replacement will spawn at full size.
 */
export function spawnIdleAndMaxed(room: Room, spawn: StructureSpawn): boolean {
  return !spawn.spawning && room.energyAvailable >= room.energyCapacityAvailable;
}

/**
 * Choose which creep (if any) to retire so its corp respawns it at full size.
 * Returns the index into `partCounts` of the smallest sub-max creep when the
 * fleet's total useful parts are below what the plan needs, or null when nothing
 * should be recycled (the fleet already meets the plan, or every creep is already
 * full-size - in which case the fix is to add a creep, not recycle one). Pure, so
 * it serves miners (WORK), haulers (CARRY) and any other sized fleet identically.
 */
export function pickRuntToRecycle(partCounts: number[], partsNeeded: number, maxPartsPerCreep: number): number | null {
  if (partsNeeded <= 0) return null;
  const total = partCounts.reduce((sum, p) => sum + p, 0);
  if (total >= partsNeeded) return null; // fleet already meets the plan

  let idx: number | null = null;
  let smallest = Infinity;
  partCounts.forEach((parts, i) => {
    if (parts < maxPartsPerCreep && parts < smallest) {
      smallest = parts;
      idx = i;
    }
  });
  return idx;
}

/**
 * Walk a retired creep to the spawn, banking any carried energy, then recycle
 * it - onto a container when one stands beside the spawn.
 *
 * Two mechanics fixes (owner 2026-08-03, on the t72755898 finding that
 * recycle tombstones masqueraded as combat kills):
 * - CARGO DELIVERS, NEVER ENTOMBS: the bank is storage-first. The old spawn
 *   dump livelocked in any healthy room (the spawn buffer is pinned FULL, so
 *   ERR_FULL forever) and the cargo eventually died into a tombstone the
 *   death watch read as a kill. Rooms without storage keep the spawn dump.
 * - THE REFUND LANDS IN A STORE: recycleCreep's body refund drops onto the
 *   creep's tile, and the engine banks it into a container under the creep.
 *   When a container stands beside the spawn the recycler seats it first;
 *   occupied or absent falls back to the plain adjacent recycle - the pad is
 *   an optimization, never a precondition. (Whether to BUILD such a pad is
 *   priced by v28's tombstoneRecycled line; this only uses one that exists.)
 */
export function driveRecycle(creep: Creep, spawn: StructureSpawn): void {
  if (creep.store[RESOURCE_ENERGY] > 0) {
    const bank: AnyStoreStructure | StructureSpawn = creep.room.storage ?? spawn;
    if (creep.transfer(bank, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(bank, { visualizePathStyle: { stroke: "#888888" } });
    }
    return;
  }
  const pad = spawn.pos
    .findInRange(FIND_STRUCTURES, 1, { filter: (s: AnyStructure) => s.structureType === STRUCTURE_CONTAINER })
    .find(p => {
      const others = typeof p.pos.lookFor === "function" ? p.pos.lookFor(LOOK_CREEPS) : [];
      return !others.some((c: { name?: string }) => c.name !== creep.name);
    });
  if (pad && !creep.pos.isEqualTo(pad.pos)) {
    creep.moveTo(pad.pos, { visualizePathStyle: { stroke: "#888888" } });
    return;
  }
  if (creep.pos.isNearTo(spawn)) {
    spawn.recycleCreep(creep);
  } else {
    creep.moveTo(spawn, { visualizePathStyle: { stroke: "#888888" } });
  }
}
