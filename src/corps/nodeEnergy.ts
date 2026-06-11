/**
 * @fileoverview Node energy access points.
 *
 * A hauler is node-to-node: ontologically it carries energy FROM one node TO
 * another, and does not itself know which tile or structure to touch. Each node
 * resolves that to a concrete spot via its own internal energy-balancing strategy
 * - a bare drop position (make a pile), a container, the spawn/extension network,
 * or storage at higher RCL. Centralising the "where exactly" here keeps the
 * haulers dumb: when a node's strategy changes (a container gets built, storage
 * appears), the resolver changes and the haulers don't change at all.
 *
 * The hauler routes to `pos`, then transfers to / withdraws from `structure` if it
 * is set, otherwise drops / picks up energy at `pos`.
 *
 * @module corps/nodeEnergy
 */

/** A store-bearing structure a hauler can deposit into or draw from. */
type StoreStructure = StructureContainer | StructureStorage | StructureSpawn | StructureExtension;

/** A concrete energy access point resolved from a node's strategy. */
export interface EnergySpot {
  pos: RoomPosition;
  /** If set, transfer-to / withdraw-from this; if absent, drop / pick up at pos. */
  structure?: StoreStructure;
  /**
   * Collect-only withdraw target for scavenging: a tombstone or ruin holding
   * energy. Distinct from `structure` because you can withdraw from these but never
   * deposit into them.
   */
  withdrawFrom?: Tombstone | Ruin;
  /**
   * True when `pos` is a stand-clear point, not an energy target yet - a bare
   * source with no drop pile. The hauler should wait NEAR it (not on it) so it
   * doesn't block the miner's harvest tile, and approach the actual pile once the
   * miner starts dropping.
   */
  waitClear?: boolean;
}

/**
 * Where a hauler picks up a source node's output, by the node's strategy: its
 * container (static mining) if one holds energy, else the miner's drop pile beside
 * the source, else the source tile itself (route there and wait for the next drop).
 * Position-based so it serves live and remote (intel) sources alike.
 */
export function sourcePickupSpot(sourcePos: RoomPosition): EnergySpot {
  const container = sourcePos.findInRange(FIND_STRUCTURES, 1, {
    filter: s => s.structureType === STRUCTURE_CONTAINER && (s as StructureContainer).store[RESOURCE_ENERGY] > 0
  })[0] as StructureContainer | undefined;
  if (container) return { pos: container.pos, structure: container };

  const pile = sourcePos
    .findInRange(FIND_DROPPED_RESOURCES, 1, { filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0 })
    .sort((a, b) => b.amount - a.amount)[0];
  if (pile) return { pos: pile.pos };

  // No pile yet: stand clear of the source so we don't block the miner's tile.
  return { pos: sourcePos, waitClear: true };
}

/**
 * Where a scavenger collects a ground stock: a tombstone or ruin holding energy
 * (withdraw), else a dropped pile (pick up), at or beside `pos`. Returns null when
 * the stock is gone - the scavenger has drained it and can stand down. Position-
 * based so it serves the stock by where it was detected.
 */
export function scavengeSpot(pos: RoomPosition): EnergySpot | null {
  const tomb = pos
    .findInRange(FIND_TOMBSTONES, 1, { filter: t => t.store[RESOURCE_ENERGY] > 0 })
    .sort((a, b) => b.store[RESOURCE_ENERGY] - a.store[RESOURCE_ENERGY])[0];
  if (tomb) return { pos: tomb.pos, withdrawFrom: tomb };

  const ruin = pos
    .findInRange(FIND_RUINS, 1, { filter: r => r.store[RESOURCE_ENERGY] > 0 })
    .sort((a, b) => b.store[RESOURCE_ENERGY] - a.store[RESOURCE_ENERGY])[0];
  if (ruin) return { pos: ruin.pos, withdrawFrom: ruin };

  const pile = pos
    .findInRange(FIND_DROPPED_RESOURCES, 1, { filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0 })
    .sort((a, b) => b.amount - a.amount)[0];
  if (pile) return { pos: pile.pos };

  return null;
}

/**
 * Where a hauler drops energy bound for the controller node, by its strategy: the
 * upgrader container if one has room, else a fixed spot beside the controller for
 * the camping upgraders to draw from (a pile).
 */
export function controllerDeliverySpot(controller: StructureController): EnergySpot {
  const container = controller.pos.findInRange(FIND_STRUCTURES, 4, {
    filter: s =>
      s.structureType === STRUCTURE_CONTAINER && (s as StructureContainer).store.getFreeCapacity(RESOURCE_ENERGY) > 0
  })[0] as StructureContainer | undefined;
  if (container) return { pos: container.pos, structure: container };

  return { pos: controller.pos };
}

/**
 * Run a hauler's interaction at a resolved spot: route to it, then (once in range)
 * withdraw from / transfer to its structure, or pick up / drop at the bare tile.
 * `mode` picks deposit vs collect. Returns the energy moved this tick (0 while
 * still travelling), so the caller can account for what it delivered.
 */
export function workSpot(creep: Creep, spot: EnergySpot, mode: "collect" | "deposit"): number {
  // pickup/withdraw must be adjacent to the energy (range 1); a structure is
  // likewise touched at range 1. A bare DROP only needs range 2 (it lands on the
  // creep's own tile). A waitClear spot (a bare source with no pile yet) is also
  // approached only to range 2, so the hauler idles near the source rather than
  // camping the miner's harvest tile - it closes to range 1 once a real pile
  // appears (sourcePickupSpot then returns the pile, not the waitClear source).
  // Collecting a real pile at range 2 was the original bug (the hauler stopped a
  // tile short, common in remote mining where there is no container).
  const range = mode === "collect" && !spot.waitClear ? 1 : spot.structure ? 1 : 2;
  if (creep.pos.getRangeTo(spot.pos) > range) {
    creep.moveTo(spot.pos, { range, visualizePathStyle: { stroke: "#ffaa00" } });
    return 0;
  }

  const carried = creep.store[RESOURCE_ENERGY];
  if (mode === "collect") {
    if (spot.structure) {
      creep.withdraw(spot.structure, RESOURCE_ENERGY);
    } else if (spot.withdrawFrom) {
      creep.withdraw(spot.withdrawFrom, RESOURCE_ENERGY); // scavenge a tombstone / ruin
    } else {
      const pile = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
        filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0
      })[0];
      if (pile) creep.pickup(pile);
    }
    return 0; // production is accounted on delivery, not pickup
  }

  // deposit
  const moved = spot.structure
    ? Math.min(carried, spot.structure.store.getFreeCapacity(RESOURCE_ENERGY) ?? carried)
    : carried;
  if (spot.structure) creep.transfer(spot.structure, RESOURCE_ENERGY);
  else creep.drop(RESOURCE_ENERGY);
  return moved;
}
