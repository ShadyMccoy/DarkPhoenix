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

  return { pos: sourcePos };
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
  // A bare drop spot only needs range 2 (drop/pickup reach an adjacent tile);
  // a structure must be touched at range 1.
  const range = spot.structure ? 1 : 2;
  if (creep.pos.getRangeTo(spot.pos) > range) {
    creep.moveTo(spot.pos, { range, visualizePathStyle: { stroke: "#ffaa00" } });
    return 0;
  }

  const carried = creep.store[RESOURCE_ENERGY];
  if (mode === "collect") {
    if (spot.structure) {
      creep.withdraw(spot.structure, RESOURCE_ENERGY);
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
