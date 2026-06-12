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

import { travelTo } from "./movement";

/** A store-bearing structure a hauler can deposit into or draw from. */
type StoreStructure = StructureContainer | StructureStorage | StructureSpawn | StructureExtension | StructureLink;

/** The room's core depot: the one structure haulers dump into and the tender draws from. */
export type CoreDepot = StructureContainer | StructureStorage;

/**
 * Resolve a room's core depot. Storage is the depot from the moment it exists
 * (durable, huge, and placed beside the spawn by ConstructionCorp); before that,
 * a container adjacent to one of the room's spawns. Null until either is built -
 * haulers then fill the spawn network directly.
 *
 * Shared by CarryCorp (dump point of the source->depot bus), ExtensionTenderCorp
 * (draw point for extension refills) and ConstructionCorp (placement), so all
 * three always agree on which structure is "the depot".
 */
export function coreDepot(room: Room): CoreDepot | null {
  if (room.storage && room.storage.my) return room.storage;
  for (const spawn of room.find(FIND_MY_SPAWNS)) {
    const c = spawn.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: s => s.structureType === STRUCTURE_CONTAINER
    })[0] as StructureContainer | undefined;
    if (c) return c;
  }
  return null;
}

/**
 * The room's CORE link: the link beside the storage, the receiving end of the
 * link network (source links fire their energy here; haulers withdraw from it).
 * Null until the room has both a storage and a link next to it.
 */
export function coreLink(room: Room): StructureLink | null {
  const storage = room.storage;
  if (!storage || !storage.my) return null;
  return (
    (storage.pos.findInRange(FIND_MY_STRUCTURES, 2, {
      filter: s => s.structureType === STRUCTURE_LINK
    })[0] as StructureLink | undefined) ?? null
  );
}

/**
 * A source's link: a link within 2 of the source (close enough that the miner
 * standing on its harvest tile can feed it), excluding the core link itself
 * (a source right beside the storage needs no link at all).
 */
export function sourceLink(sourcePos: RoomPosition, coreLinkId?: string): StructureLink | null {
  return (
    (sourcePos.findInRange(FIND_MY_STRUCTURES, 2, {
      filter: s => s.structureType === STRUCTURE_LINK && s.id !== coreLinkId
    })[0] as StructureLink | undefined) ?? null
  );
}

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
 * The deterministic best tile within `range` of `target`: walkable, unoccupied,
 * and nearest the spawn (shorter hauls). Iteration order makes ties deterministic.
 *
 * Shared by the source-container placement (where to BUILD), the miner (where to
 * STAND), and - via {@link sourceHarvestSpot} - the drop pile, so all three
 * converge on ONE tile instead of three different ones. That convergence is what
 * stops a miner dropping energy on a tile the haulers never visit.
 */
export function bestAdjacentTile(
  room: Room,
  target: RoomPosition,
  range: number,
  spawnPos?: RoomPosition
): RoomPosition | null {
  const terrain = room.getTerrain();
  const occupied = new Set<string>();
  for (const s of room.find(FIND_STRUCTURES)) occupied.add(`${s.pos.x},${s.pos.y}`);
  for (const s of room.find(FIND_CONSTRUCTION_SITES)) occupied.add(`${s.pos.x},${s.pos.y}`);

  let best: { x: number; y: number; d: number } | null = null;
  for (let dx = -range; dx <= range; dx++) {
    for (let dy = -range; dy <= range; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = target.x + dx;
      const y = target.y + dy;
      if (x < 1 || x > 48 || y < 1 || y > 48) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      if (occupied.has(`${x},${y}`)) continue;
      const d = spawnPos ? Math.max(Math.abs(spawnPos.x - x), Math.abs(spawnPos.y - y)) : 0;
      if (!best || d < best.d) best = { x, y, d };
    }
  }
  return best ? new RoomPosition(best.x, best.y, room.name) : null;
}

/**
 * Where a source's miner should STAND: on the source container (built or planned)
 * if one is adjacent - static mining drops the harvested energy straight in - else
 * the deterministic best harvest tile ({@link bestAdjacentTile}). Construction
 * places the source container on that SAME tile, so the miner is already standing
 * where the container will appear: the miner's drop pile, the future container, and
 * the haulers' pickup all land on one tile. Without this the miner parks on an
 * arbitrary adjacent tile, drops its energy there, and the haulers - routed to the
 * planned container tile - never collect it, so it piles up un-hauled.
 *
 * Falls back to the source tile only if nothing adjacent is walkable (shouldn't
 * happen for a real source, which always has an open mining tile).
 */
export function sourceHarvestSpot(source: Source, spawnPos?: RoomPosition): RoomPosition {
  const built = source.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: s => s.structureType === STRUCTURE_CONTAINER
  })[0];
  if (built) return built.pos;
  const site = source.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 1, {
    filter: s => s.structureType === STRUCTURE_CONTAINER
  })[0];
  if (site) return site.pos;
  return bestAdjacentTile(source.room, source.pos, 1, spawnPos) ?? source.pos;
}

/**
 * Where a hauler picks up a source node's output, by the node's strategy: its
 * container (static mining) if one holds energy, else the miner's drop pile beside
 * the source, else the source tile itself (route there and wait for the next drop).
 * Position-based so it serves live and remote (intel) sources alike.
 */
export function sourcePickupSpot(sourcePos: RoomPosition): EnergySpot {
  // Link-served source: the miner feeds its source link and the network fires
  // the energy across the room to the core link - so the hauler's pickup stop
  // is the CORE link beside the storage, not the far source tile. This is the
  // node-strategy change the resolver exists for: the haulers don't change.
  //
  // The redirect follows where energy ACTUALLY is, not just where structures
  // stand: a fresh link pair with a CARRY-less old miner (it can't feed the
  // link until natural turnover replaces it) still drops at the source, so a
  // loaded source-side container/pile below still wins. Only when nothing sits
  // at the source does a link-served hauler wait at the core - where the next
  // volley lands - instead of trekking to the empty source.
  const room = Game.rooms[sourcePos.roomName];
  const core = room ? coreLink(room) : null;
  const linkServed = core !== null && sourceLink(sourcePos, core.id) !== null;
  if (linkServed && core!.store[RESOURCE_ENERGY] > 0) {
    return { pos: core!.pos, structure: core! };
  }

  const container = sourcePos.findInRange(FIND_STRUCTURES, 1, {
    filter: s => s.structureType === STRUCTURE_CONTAINER && (s as StructureContainer).store[RESOURCE_ENERGY] > 0
  })[0] as StructureContainer | undefined;
  if (container) return { pos: container.pos, structure: container };

  const pile = sourcePos
    .findInRange(FIND_DROPPED_RESOURCES, 1, { filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0 })
    .sort((a, b) => b.amount - a.amount)[0];
  if (pile) return { pos: pile.pos };

  if (linkServed) return { pos: core!.pos, structure: core! };

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
    // travelTo so a hauler crossing into a remote room doesn't bounce on the border.
    travelTo(creep, spot.pos, { range, visualizePathStyle: { stroke: "#ffaa00" } });
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
