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

import { travelToBypass } from "./movement";

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
 *
 * `forStructure` applies the engine's placement legality for that structure
 * type. Without it the tile is only guaranteed STANDABLE - fine for creeps,
 * and for the exempt structures (roads, containers), but the engine refuses
 * most structure types on a tile one step from the room edge unless every
 * edge tile beside it is a natural wall (see {@link besideOpenExit}). Pass
 * the type whenever the tile is for createConstructionSite, or the picker
 * re-picks the same illegal tile every cooldown and the structure never
 * places (the W43N23 link incident: a source pocketed against an open east
 * exit, "Failed to place link at W43N23 (48, 13): -7" forever).
 */
export function bestAdjacentTile(
  room: Room,
  target: RoomPosition,
  range: number,
  spawnPos?: RoomPosition,
  forStructure?: BuildableStructureConstant
): RoomPosition | null {
  const terrain = room.getTerrain();
  const occupied = new Set<string>();
  for (const s of room.find(FIND_STRUCTURES)) occupied.add(`${s.pos.x},${s.pos.y}`);
  for (const s of room.find(FIND_CONSTRUCTION_SITES)) occupied.add(`${s.pos.x},${s.pos.y}`);
  // Sources and minerals are NOT structures, so the two scans above miss them -
  // but no buildable structure can sit on their tile (createConstructionSite
  // returns ERR_INVALID_TARGET). This matters when `target` is ADJACENT to a
  // source (e.g. placing a source link beside the harvest spot): the source's
  // own tile is within range and would otherwise be picked as "nearest the
  // spawn", producing a link site that fails to place every cooldown forever.
  for (const s of room.find(FIND_SOURCES)) occupied.add(`${s.pos.x},${s.pos.y}`);
  for (const m of room.find(FIND_MINERALS)) occupied.add(`${m.pos.x},${m.pos.y}`);

  const shunExitBuffer =
    forStructure !== undefined && forStructure !== STRUCTURE_ROAD && forStructure !== STRUCTURE_CONTAINER;

  let best: { x: number; y: number; d: number } | null = null;
  for (let dx = -range; dx <= range; dx++) {
    for (let dy = -range; dy <= range; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = target.x + dx;
      const y = target.y + dy;
      if (x < 1 || x > 48 || y < 1 || y > 48) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      if (occupied.has(`${x},${y}`)) continue;
      if (shunExitBuffer && besideOpenExit(terrain, x, y)) continue;
      const d = spawnPos ? Math.max(Math.abs(spawnPos.x - x), Math.abs(spawnPos.y - y)) : 0;
      if (!best || d < best.d) best = { x, y, d };
    }
  }
  return best ? new RoomPosition(best.x, best.y, room.name) : null;
}

/**
 * The engine's exit-buffer rule (checkConstructionSite): a tile one step from
 * the room edge (x or y == 1 or 48) can host a non-exempt structure only when
 * all three edge tiles beside it are natural walls - one open exit tile there
 * and createConstructionSite returns ERR_INVALID_TARGET. Only roads and
 * containers are exempt. Mirrors the engine exactly, including its corner
 * behaviour: the sequential ifs OVERWRITE, so a corner tile (e.g. x==48,
 * y==48) is judged only by its last-matching side's edge tiles - the y-side
 * list replaces the x-side one, same as the engine's checkConstructionSite.
 */
function besideOpenExit(terrain: RoomTerrain, x: number, y: number): boolean {
  let edge: [number, number][] | null = null;
  if (x === 1) edge = [[0, y - 1], [0, y], [0, y + 1]];
  if (x === 48) edge = [[49, y - 1], [49, y], [49, y + 1]];
  if (y === 1) edge = [[x - 1, 0], [x, 0], [x + 1, 0]];
  if (y === 48) edge = [[x - 1, 49], [x, 49], [x + 1, 49]];
  if (!edge) return false;
  return edge.some(([ex, ey]) => (terrain.get(ex, ey) & TERRAIN_MASK_WALL) === 0);
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

  // PILE BEFORE CONTAINER (owner 2026-07-10): a pile decays 1/1000 per tick,
  // a container's contents do not - when both hold energy at the source,
  // drain the depreciating stock first. Planning treats them as ONE summed
  // stock; this is the execution-side half of the same principle.
  //
  // EXCEPT while the container is FULL: harvest dropped onto a full container
  // tile spills to the ground, so a fresh trickle-pile reappears EVERY tick and
  // pile-first locks the hauler into ~10-energy pickups forever (observed live
  // 2026-07-16: a hauler parked at the source inching toward full while 2000
  // sat in the container). A full container means the pile is overflow in
  // progress, not stale stock: withdraw from the container instead - one intent
  // fills the hauler AND re-opens capacity so the next drops are absorbed. The
  // leftover pile is drained by pile-first as soon as the container is no
  // longer full.
  const pile = sourcePos
    .findInRange(FIND_DROPPED_RESOURCES, 1, { filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0 })
    .sort((a, b) => b.amount - a.amount)[0];
  const container = sourcePos.findInRange(FIND_STRUCTURES, 1, {
    filter: s => s.structureType === STRUCTURE_CONTAINER && (s as StructureContainer).store[RESOURCE_ENERGY] > 0
  })[0] as StructureContainer | undefined;
  const containerFull = container !== undefined && (container.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) === 0;

  if (pile && !containerFull) return { pos: pile.pos };
  if (container) return { pos: container.pos, structure: container };

  if (linkServed) return { pos: core!.pos, structure: core! };

  // No pile yet: stand clear of the source so we don't block the miner's tile.
  return { pos: sourcePos, waitClear: true };
}

/**
 * Where a scavenger collects a ground stock: a tombstone or ruin holding energy
 * (withdraw), else a dropped pile (pick up) or the container the stock was summed
 * with (withdraw), at or beside `pos`. Returns null when the stock is gone - the
 * scavenger has drained it and can stand down. Position-based so it serves the
 * stock by where it was detected.
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

  // A stock detected ON a container tile INCLUDES that container's contents
  // (detectRoomStocks' one-summed-stock rule), so the container is part of this
  // scavenger's stock and must be reachable - otherwise a stock whose bulk sits
  // in the container is mostly invisible to its own scavenger (observed live
  // 2026-07-17: a full source container's overflow pile was promoted to a 2000+
  // stock, and the scavenger stood beside the container forever, seeing only
  // the per-tick trickle). Range 0 mirrors detection exactly: a container on a
  // NEIGHBOURING tile was never summed into this stock and belongs to some
  // other route - drawing from it would steal off-route energy.
  //
  // Pile-vs-container priority is sourcePickupSpot's rule: the decaying pile
  // first, EXCEPT while the container is full - then the pile is overflow in
  // progress, re-created every tick, and pile-first locks the scavenger into
  // ~10-energy pickups while the stock's bulk sits in the container. One
  // withdraw fills the scavenger AND re-opens capacity for the next drops.
  const container = pos.findInRange(FIND_STRUCTURES, 0, {
    filter: s => s.structureType === STRUCTURE_CONTAINER && (s as StructureContainer).store[RESOURCE_ENERGY] > 0
  })[0] as StructureContainer | undefined;
  const containerFull = container !== undefined && (container.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) === 0;

  if (pile && !containerFull) return { pos: pile.pos };
  if (container) return { pos: container.pos, structure: container };

  return null;
}

/**
 * Where a hauler drops energy bound for the controller node, by its strategy: the
 * upgrader container if one has room, else a fixed spot beside the controller for
 * the camping upgraders to draw from (a pile).
 */
export function controllerDeliverySpot(controller: StructureController): EnergySpot {
  return controllerInputSpot(controller);
}

/**
 * The single DEDICATED controller input spot: the one tile haulers always drop
 * at and upgraders always draw from (where the upgrader container is, or will be
 * built). Deterministic so haulers, upgraders, and the future container all
 * agree on it:
 *   - an existing container/link within range 3 of the controller, else
 *   - the walkable tile (within range 2 of the controller) with the MOST walkable
 *     neighbours that are themselves within upgrade range - i.e. the spot that can
 *     host the most parked upgraders. Ties broken by (x,y) for stability.
 * No container yet (RCL 2) => a bare drop tile, so every load lands on ONE pile
 * the parked upgraders share, instead of scattering across the controller fringe.
 */
export function controllerInputSpot(controller: StructureController): EnergySpot {
  const room = controller.room as Room;
  const buffer = controller.pos.findInRange(FIND_STRUCTURES, 3, {
    filter: s => s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_LINK
  })[0] as StructureContainer | StructureLink | undefined;
  if (buffer) return { pos: buffer.pos, structure: buffer };

  const terrain = room.getTerrain();
  const cx = controller.pos.x;
  const cy = controller.pos.y;
  const walkable = (x: number, y: number): boolean =>
    x >= 1 && x <= 48 && y >= 1 && y <= 48 && terrain.get(x, y) !== TERRAIN_MASK_WALL;
  const inUpgradeRange = (x: number, y: number): boolean => Math.max(Math.abs(x - cx), Math.abs(y - cy)) <= 3;

  let best: { x: number; y: number; score: number } | null = null;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      const x = cx + dx;
      const y = cy + dy;
      if ((dx === 0 && dy === 0) || !walkable(x, y) || !inUpgradeRange(x, y)) continue;
      let score = 0;
      for (let ex = -1; ex <= 1; ex++) {
        for (let ey = -1; ey <= 1; ey++) {
          if (ex === 0 && ey === 0) continue;
          if (walkable(x + ex, y + ey) && inUpgradeRange(x + ex, y + ey)) score++;
        }
      }
      const better =
        !best || score > best.score || (score === best.score && (x < best.x || (x === best.x && y < best.y)));
      if (better) best = { x, y, score };
    }
  }
  return { pos: best ? new RoomPosition(best.x, best.y, room.name) : controller.pos };
}

/**
 * Walkable upgrader PARKING tiles RINGING the input spot: tiles within range 1 of
 * the input (so an upgrader withdraws without moving) AND within upgrade range (3)
 * of the controller (so it upgrades from there), excluding the controller's own
 * tile AND the input tile itself. Ordered CLOSEST-TO-THE-CONTROLLER first (ties
 * broken by (x,y) for a stable, deterministic slot each upgrader keeps across
 * ticks). This is the "analyse the controller-adjacent layout" strategy: the
 * parked upgraders ring the one shared pile/container and never move or block each
 * other.
 *
 * Proximity ordering matters when the input spot sits ~2 tiles off the controller
 * (a bare drop tile is placed to maximise parking capacity, so it lands on the
 * open side, up to range 2 away). Its ring then spans range 1..3 of the
 * controller. Filling from the FAR corner (a plain (x,y) sort did) left a lone
 * RCL2 upgrader parked 3 tiles out on the open side while a range-1 tile sat free
 * next to the controller - the "upgrader doesn't move close enough" symptom.
 * Closest-first fills the tiles hugging the controller before the outer ring, so
 * upgraders sit as near the controller as the shared input allows.
 *
 * The input tile is deliberately EXCLUDED: it is the dedicated drop/withdraw point
 * that the hauler must reach to deposit. An upgrader squatting it would wall the
 * hauler out, so the shared pile (which lands on the input tile) never grows and
 * the ring starves - the RCL2 deadlock. Reserving it keeps the pile reachable.
 */
export function controllerParkingTiles(controller: StructureController, input: RoomPosition): RoomPosition[] {
  const room = controller.room as Room;
  const terrain = room.getTerrain();
  const cx = controller.pos.x;
  const cy = controller.pos.y;
  const tiles: RoomPosition[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const x = input.x + dx;
      const y = input.y + dy;
      if (x < 1 || x > 48 || y < 1 || y > 48) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      if (x === cx && y === cy) continue; // can't stand on the controller
      if (x === input.x && y === input.y) continue; // reserved drop/withdraw tile
      if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) > 3) continue;
      tiles.push(new RoomPosition(x, y, room.name));
    }
  }
  const distToController = (p: RoomPosition): number => Math.max(Math.abs(p.x - cx), Math.abs(p.y - cy));
  tiles.sort((a, b) => distToController(a) - distToController(b) || a.x - b.x || a.y - b.y);
  return tiles;
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
    // travelToBypass (force-swap), NOT a queue: this collect path is also how a
    // just-emptied hauler LEAVES the controller input tile for its source. It heads
    // OPPOSITE the haulers queuing to deliver, so if both sides held they would
    // mutually block head-on (the original deadlock). Force-swapping resolves the
    // head-on - both step through - and still swaps a hauler through a parked
    // upgrader ring to escape (the trapped-on-the-pile symptom). Away from any creep
    // this falls back to the border-bounce-safe travelTo.
    travelToBypass(creep, spot.pos, { range, visualizePathStyle: { stroke: "#ffaa00" } });
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

/**
 * Energy actually pooled at the controller side: containers/storage within 4
 * of the controller plus loose energy near the input spot. THE lens for
 * stock-grounded upgrader sizing (UpgradingCorp) AND the telemetry room
 * ledger (spec 14 phase 1) - both read this one function so the number a
 * dashboard shows is the number the decision used.
 */
export function controllerSideStock(controller: StructureController): number {
  const spot = controllerInputSpot(controller).pos;
  let stock = 0;
  for (const s of controller.pos.findInRange(FIND_STRUCTURES, 4)) {
    if (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) {
      stock += (s as StructureContainer | StructureStorage).store[RESOURCE_ENERGY];
    }
  }
  for (const r of spot.findInRange(FIND_DROPPED_RESOURCES, 2)) {
    if (r.resourceType === RESOURCE_ENERGY) stock += r.amount;
  }
  return stock;
}
