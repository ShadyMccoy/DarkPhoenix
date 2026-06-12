/**
 * @fileoverview storeFill - the colony's energy thermostat reading.
 *
 * ONE measured signal for balancing income against consumption (build/upgrade):
 * how full the room's stored-energy reservoir is, 0..1. We deliberately read the
 * LEVEL, not its per-tick derivative ("surplus/tick"): the level is the integral
 * of net flow, so it is naturally smooth and moves on the same slow timescale as
 * the spawn actuator it ultimately drives. A derivative signal is noisy tick-to-
 * tick and, fed to a laggy actuator (spawning takes hundreds of ticks to field a
 * fleet), would oscillate.
 *
 * Reservoir = storage + containers. Spawn/extensions are excluded on purpose:
 * they are operating buffers that income keeps topped up, not surplus the colony
 * is failing to consume. Energy backing up in containers/storage is exactly the
 * "we collect more than we use" signal.
 *
 * @module economy/storeFill
 */

/**
 * Fill level of the room's stored-energy reservoir, in [0, 1].
 *
 * - 1 → the reservoir is full: the colony collects more than it consumes, so
 *   income growth should stand down and consumers (build/upgrade) should soak it.
 * - 0 → empty (or no reservoir yet): nothing is backing up, so income is free to
 *   grow and consumers should stay modest.
 *
 * Degrades gracefully before storage exists (RCL < 4): the gauge is then just the
 * source/controller containers, whose smaller caps fill and empty faster but
 * still signal a haul/consume backlog. With NO reservoir at all (a bare early
 * room: no containers, no storage) capacity is 0 and we report 0 ("empty"), so a
 * cold-start room never gates its income off.
 */
export function storeFill(room: Room): number {
  const { energy, capacity } = storeLevels(room);
  return capacity > 0 ? energy / capacity : 0;
}

/**
 * The raw reservoir totals behind {@link storeFill}: stored energy and the
 * capacity that holds it. Exposed for probes/telemetry that want the absolute
 * numbers (e.g. "stores climbing toward full") alongside the normalised fill.
 */
export function storeLevels(room: Room): { energy: number; capacity: number } {
  let energy = 0;
  let capacity = 0;

  const storage = room.storage;
  if (storage) {
    energy += storage.store[RESOURCE_ENERGY];
    capacity += storage.store.getCapacity(RESOURCE_ENERGY) ?? 0;
  }

  const containers = room.find(FIND_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_CONTAINER
  }) as StructureContainer[];
  for (const c of containers) {
    energy += c.store[RESOURCE_ENERGY];
    capacity += c.store.getCapacity(RESOURCE_ENERGY) ?? 0;
  }

  return { energy, capacity };
}
