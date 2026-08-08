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

import "../types/Memory"; // RoomMemory.deadTiles augmentation (single-file ts-node runs)
import { travelToBypass } from "./movement";
import { LINK_FIRE_THRESHOLD } from "../economy/primitives";
import { stripSourcePrefix } from "../economy/ids";

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
 * Reach of the SPAWN-REFILL STOCK GUARD: drops/containers this close to a
 * my-spawn are the refill apparatus's draw pool (the drop tile is range 1;
 * one more covers cluster-adjacent stock). Deliberately tight - a site pile
 * three tiles out is build fuel, not refill stock.
 */
export const SPAWN_REFILL_STOCK_RANGE = 2;

/**
 * TRUE while energy at `pos` is SPAWN-REFILL STOCK a consumer must not raid:
 * within {@link SPAWN_REFILL_STOCK_RANGE} of a my-spawn while the extension
 * bank is short. The sink ladder applied at the STOCK level (spawn 100 >
 * construction 70) - the grid's refill-SLA regression (plan-t5, t=537,
 * surfaced by #148's route-share hauler bodies) measured a builder parked on
 * the spawn drop tile hoovering each delivery the tick it landed, so the
 * tender's reload fell back to a source pile 15 tiles out and the next
 * drain's deadline lapsed while it walked. A FULL bank drops the guard: the
 * pile is then genuine surplus and construction may eat it
 * (construction-first doctrine unchanged in surplus). Storage is never
 * guarded - a bank draw is priced by the plan's construction allocation,
 * not this claim rule. Shared by every construction fuel path (one lens,
 * every reader - the staffsPost symmetry rule).
 */
export function isSpawnRefillStock(room: Room, pos: { x: number; y: number }): boolean {
  // Fail OPEN on harness stubs / degenerate rooms: the guard is a claim-order
  // refinement, never something a fuel walk may crash on.
  if (typeof room.find !== "function" || room.energyAvailable === undefined) return false;
  if (room.energyAvailable >= room.energyCapacityAvailable) return false;
  return room
    .find(FIND_MY_SPAWNS)
    .some(s => Math.max(Math.abs(s.pos.x - pos.x), Math.abs(s.pos.y - pos.y)) <= SPAWN_REFILL_STOCK_RANGE);
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
 * Income headroom the FEEDER must leave in the core link (owner 2026-07-21:
 * "the hub should reserve capacity for it" - a feeder topping the core to the
 * brim left the source link's volleys nowhere to land). One typical source
 * volley (~2 fire thresholds); the relay buffer that remains (capacity -
 * reserve = 600) still out-runs every relay target to date, and a volley the
 * reserve can't hold spills to the controller link directly (LinkRunner's
 * congestion fallback - the second half of the owner's fix).
 */
export const CORE_LINK_INCOME_RESERVE = 200;

/**
 * Energy the feeder may still load into the core link. The feeder is the core
 * link's SLAVE, coordinated with the fire down to the controller (owner
 * 2026-07-24): the core is an INCOME hub FIRST (production > consumption). It
 * must never stage more storage energy than the controller link can currently
 * RECEIVE - staging income headroom for energy the core can't fire down is a
 * production leak.
 *
 * Measured incident (t72548874/t72548972): the old rule filled the core to
 * capacity - reserve = 600 regardless of the relay's needs. Live the feeder
 * held the core at 600-794 while the source link stood 800/800 FULL and
 * ~17.4k of remote income sat stranded across the mines; the controller link
 * was 750/800 (a single 3-WORK upgrader burned ~2.5 e/t) so the relay could
 * not drain the staged energy - the hub gridlocked and income could not land.
 *
 * `controllerFree` is the controller link's current free capacity (the relay's
 * headroom). When it is known (link-fed rooms), the feeder's core TARGET is the
 * lesser of that headroom and the income-reserve ceiling: with the controller
 * sated the feeder stages ~nothing and the whole core stays open for source
 * volleys; as the upgraders drain the controller link the target rises and the
 * feeder tops the relay from storage. Omit it (walking relay, no controller
 * link) for the legacy ceiling exactly. The SOURCE side is never throttled -
 * only the feeder's controller-relay staging is.
 *
 * ARRIVALS-FIRST (spec 45 leg 2, owner-directed 2026-08-05). An INBOUND
 * volley - a source link standing loaded, or about to come off cooldown -
 * drives the target to ZERO for that tick. Measured t72805426:
 * hubClampShare **0.625** against coreEmptyShare **0.276**, i.e. the core
 * clamped arriving volleys 62% of the time while sitting empty 28% of the
 * time. A buffer cannot be both saturated and idle: it was being STAGED FULL
 * from storage exactly when income wanted to land, then drained to empty when
 * nothing was arriving - inverted sequencing.
 *
 * Riding the ONE target level fixes both directions at once and keeps the
 * symmetry intact: loadRoom goes to 0 (stop staging into the landing zone)
 * and drainAmount goes to the whole store (PRE-drain, clearing it ahead of
 * the arrival). Nothing about the phase-D valve changes - this decides WHEN
 * the core holds staged energy, never how much the controller is allocated.
 */
export function coreLinkTargetLevel(capacity: number, controllerFree?: number, inboundPending = false): number {
  if (inboundPending) return 0;
  const ceiling = capacity - CORE_LINK_INCOME_RESERVE;
  return controllerFree === undefined ? ceiling : Math.min(ceiling, Math.max(0, controllerFree));
}

export function coreLinkLoadRoom(
  store: number,
  capacity: number,
  controllerFree?: number,
  inboundPending = false
): number {
  return Math.max(0, coreLinkTargetLevel(capacity, controllerFree, inboundPending) - store);
}

/**
 * Energy the feeder must DRAIN core link -> storage: the excess above the
 * target level (spec 02 feeder-router, owner 2026-07-26). The feeder is the
 * SOLE bidirectional operator of the core link - it loads the relay buffer AND
 * empties the surplus/income back to the bank so source-link volleys always
 * find landing room. The drain target is the SAME level coreLinkLoadRoom loads
 * to (min of the income-reserve ceiling and the controller link's headroom), so
 * the two directions meet at one level and never fight: with the controller
 * sated the target is ~0 and the feeder drains the core near-empty (income banks,
 * core stays open); as the upgraders drain the controller link the target rises
 * and the feeder tops the relay from storage instead. Symmetric partner of
 * coreLinkLoadRoom (loadRoom>0 XOR drainAmount>0, both 0 only at target).
 */
export function coreLinkDrainAmount(
  store: number,
  capacity: number,
  controllerFree?: number,
  inboundPending = false
): number {
  return Math.max(0, store - coreLinkTargetLevel(capacity, controllerFree, inboundPending));
}

/**
 * The room's CONTROLLER link: a built link within upgrade range (3) of the
 * controller, excluding the core link (a storage parked next to the
 * controller needs no second link). THE link-fed lens (spec 24 rung 3,
 * owner 2026-07-20): the feeder corp's retask, the plan's feeder pricing,
 * the LinkRunner's send rule, and the input election all read THIS function
 * - one lens, no drift.
 */
export function controllerLink(room: Room): StructureLink | null {
  const ctrl = room.controller;
  if (!ctrl || !ctrl.my) return null;
  const core = coreLink(room);
  const link = ctrl.pos.findInRange(FIND_MY_STRUCTURES, 3, {
    filter: s => s.structureType === STRUCTURE_LINK && s.id !== core?.id
  })[0] as StructureLink | undefined;
  return link ?? null;
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
  avoid?: { x: number; y: number }[],
  forStructure?: BuildableStructureConstant
): RoomPosition | null {
  const terrain = room.getTerrain();
  // Obstacle placements (links/towers/storage/extensions) block their tile; the
  // walkable ones (containers, and the bare stand tile) do not. This predicate
  // is reused below for the exit-buffer shun.
  const obstaclePlacement =
    forStructure !== undefined && forStructure !== STRUCTURE_ROAD && forStructure !== STRUCTURE_CONTAINER;
  const occupied = new Set<string>();
  // A BUILT road never blocks a container site or a creep's stand tile: the
  // engine (checkConstructionSite) exempts existing roads for every structure
  // type, and creeps walk on roads. So when placing a container (or picking a
  // bare harvest/stand tile) a road underfoot is NOT occupied - the paved
  // harvest tile is exactly where the container should land, converging with
  // the miner's drop (prod W44N23: the trunk paved the only open source
  // neighbour, this scan then excluded it, bestAdjacentTile returned null, and
  // sourceHarvestSpot fell back to the source's own tile -> "-7" forever). The
  // wall-terrain check below still applies, so a road ON a wall stays rejected.
  // OBSTACLE structures still shun roads (an unwalkable building plugs the lane).
  for (const s of room.find(FIND_STRUCTURES)) {
    if (s.structureType === STRUCTURE_ROAD && !obstaclePlacement) continue;
    occupied.add(`${s.pos.x},${s.pos.y}`);
  }
  // Construction SITES of ANY type block a new site (the engine forbids two
  // sites on one tile), roads included - so these are never exempted.
  for (const s of room.find(FIND_CONSTRUCTION_SITES)) occupied.add(`${s.pos.x},${s.pos.y}`);
  // Sources and minerals are NOT structures, so the two scans above miss them -
  // but no buildable structure can sit on their tile (createConstructionSite
  // returns ERR_INVALID_TARGET). This matters when `target` is ADJACENT to a
  // source (e.g. placing a source link beside the harvest spot): the source's
  // own tile is within range and would otherwise be picked as "nearest the
  // spawn", producing a link site that fails to place every cooldown forever.
  for (const s of room.find(FIND_SOURCES)) occupied.add(`${s.pos.x},${s.pos.y}`);
  for (const m of room.find(FIND_MINERALS)) occupied.add(`${m.pos.x},${m.pos.y}`);
  // Tiles a placement already proved permanently invalid (-7): placeSite
  // records them so the ladder stops retrying the same tile every cooldown
  // (W43N23 link@48,13 looped ~forever before the stamp made it visible).
  for (const key of Object.keys(room.memory?.deadTiles ?? {})) occupied.add(key);

  const shunExitBuffer = obstaclePlacement;

  // Swamp-favored placement (owner 2026-07-21): an UNWALKABLE building blots
  // out its tile either way, so at EQUAL distance "waste" a swamp and leave
  // the plain as a walking lane; among swamps prefer one with an adjacent
  // plain (the servicing creep parks there - standing pays no fatigue, only
  // the approach does). Same class as the exit-buffer rule: roads and
  // containers are walkable, so they stay terrain-neutral (a container on
  // swamp would tax every visitor 5x fatigue). Distance always rules first -
  // a farther swamp would charge every servicing trip forever.
  const swampScore = (x: number, y: number): number => {
    if (!shunExitBuffer || (terrain.get(x, y) & TERRAIN_MASK_SWAMP) === 0) return 0;
    for (let ax = x - 1; ax <= x + 1; ax++) {
      for (let ay = y - 1; ay <= y + 1; ay++) {
        if (ax === x && ay === y) continue;
        if (ax < 0 || ax > 49 || ay < 0 || ay > 49) continue;
        if (terrain.get(ax, ay) === 0) return 2; // swamp with a plain stand beside it
      }
    }
    return 1; // landlocked swamp: still better than blotting a plain
  };

  let best: { x: number; y: number; d: number; s: number } | null = null;
  for (let dx = -range; dx <= range; dx++) {
    for (let dy = -range; dy <= range; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = target.x + dx;
      const y = target.y + dy;
      // 1..48: the engine allows a non-road structure on a near-border tile
      // ONLY when every edge tile beside it is a natural wall; besideOpenExit
      // (below) models that rule precisely for exit-restricted structures.
      // (#116 - this REPLACES the old conservative 2..47 cutoff that rejected
      // legal wall-backed border placements, the W43N23 link -7 loop.)
      if (x < 1 || x > 48 || y < 1 || y > 48) continue;
      // Caller-marked keep-clear zones (owner 2026-07-19): an unwalkable
      // structure on a spawn-adjacent tile can lock in freshly spawned units.
      // Generators for towers/storage/links pass the room's spawn positions.
      if (avoid?.some(p => Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) <= 1)) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      if (occupied.has(`${x},${y}`)) continue;
      if (shunExitBuffer && besideOpenExit(terrain, x, y)) continue;
      const d = spawnPos ? Math.max(Math.abs(spawnPos.x - x), Math.abs(spawnPos.y - y)) : 0;
      const s = swampScore(x, y);
      if (!best || d < best.d || (d === best.d && s > best.s)) best = { x, y, d, s };
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
/**
 * The engine forbids ALL construction on the room border row (x or y = 0 or
 * 49) - createConstructionSite returns ERR_INVALID_TARGET there for every
 * structure type, roads included. Creeps traverse exits without roads, so a
 * border tile on a cross-room path is walkable but never placeable: any tile
 * list that feeds placement must exclude these (prod t72483047: a trunk's
 * two border tiles read err-7 every pass for ~4400t and the paved receipt
 * could never land - the completion condition was unsatisfiable by
 * construction). Sibling of besideOpenExit below, which handles the
 * engine's separate exit-BUFFER rule (x/y = 1 or 48, roads exempt).
 */
export function isRoomEdgeTile(x: number, y: number): boolean {
  return x === 0 || x === 49 || y === 0 || y === 49;
}

/**
 * Trunk tiles WITHIN RANGE 1 of the route's source are not worth paving
 * (owner 2026-07-22: "we don't need that very last bit of road next to the
 * source mine"): the miner stands there permanently and haulers STOP there
 * to load - fatigue clears during the standing tick, so the road saves
 * nothing, while costing build energy + perpetual decay. Unlike edge tiles
 * (which the engine REJECTS - err-7), these are perfectly placeable - just
 * pointless (owner). Same skip mechanics as isRoomEdgeTile: the survey AND
 * the completion check exempt them, so routes already stored with approach
 * tiles complete without migration.
 */
export function isSourceApproachTile(
  x: number,
  y: number,
  roomName: string,
  source?: { x: number; y: number; roomName: string }
): boolean {
  if (!source || roomName !== source.roomName) return false;
  return Math.max(Math.abs(x - source.x), Math.abs(y - source.y)) <= 1;
}

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
  // NO CORE-LINK REDIRECT (spec 02 feeder-router, owner 2026-07-26): a
  // link-served source's transport belongs to the link network + the feeder
  // (the sole bidirectional core-link operator), and no walking CarryCorp is
  // commissioned for it (emergent, commissionsFromPlan). The old redirect
  // pointed the source's hauler at the CORE link, where it drained the very
  // energy the feeder was loading - the storage->core->storage thrash
  // (t72595372). Removed: this resolver now only serves the source's own
  // ground pile / container. During a fresh-link transition (a source-side
  // pile before the miner turns the link over) the pile is picked up by the
  // scavenge path (detectTransientSources, a distinct `-scavenge` route that
  // is never suppressed), so nothing rots.

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
 *   - an existing LINK within range 3 (a deliberate placement, never migrated), else
 *   - an existing container within range 3 whose PARK RING (walkable neighbours
 *     inside upgrade range, controller tile excluded) is within 1 of the best
 *     fresh candidate's - the hysteresis that stops migration flap, else
 *   - the walkable tile (within range 2 of the controller) with the largest
 *     park ring. Ties broken by (x,y) for stability.
 * Spec 24 rung 1 (owner 2026-07-20): a legacy container used to be accepted
 * unconditionally, its ring quality never re-examined - live it held parking
 * at 6 of a possible 8, 30 e/t of burn ceiling lost to position alone. When
 * the best candidate beats the incumbent by 2+ park tiles the spot MIGRATES:
 * this function returns the bare better tile, findMissingControllerContainer
 * immediately wants the container there, and the fleet re-anchors (pile-fed
 * until it builds) while the old container leaves the maintenance rolls.
 */
export function controllerInputSpot(controller: StructureController): EnergySpot {
  const room = controller.room as Room;
  const buffers = controller.pos.findInRange(FIND_STRUCTURES, 3, {
    filter: s => s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_LINK
  }) as (StructureContainer | StructureLink)[];
  const link = buffers.find(s => s.structureType === STRUCTURE_LINK);
  if (link) return { pos: link.pos, structure: link };

  const terrain = room.getTerrain();
  const cx = controller.pos.x;
  const cy = controller.pos.y;
  // Tiles createConstructionSite proved permanently invalid (-7): the fresh
  // spot IS the future controller-container tile (findMissingControllerContainer
  // places one there), so a dead tile must not be CHOSEN or that placement
  // retries it every cooldown forever - the eaten-ladder loop bestAdjacentTile
  // already guards for source/depot containers ("Failed to place container ...:
  // -7" looping). Excluded from the candidate pick only, NOT from the park-ring
  // count below: an upgrader can still STAND on a dead tile (a road), it just
  // can't host a container there.
  const dead = new Set<string>(Object.keys(room.memory?.deadTiles ?? {}));
  const walkable = (x: number, y: number): boolean =>
    x >= 1 && x <= 48 && y >= 1 && y <= 48 && terrain.get(x, y) !== TERRAIN_MASK_WALL;
  const inUpgradeRange = (x: number, y: number): boolean => Math.max(Math.abs(x - cx), Math.abs(y - cy)) <= 3;
  const parkRing = (x: number, y: number): number => {
    let score = 0;
    for (let ex = -1; ex <= 1; ex++) {
      for (let ey = -1; ey <= 1; ey++) {
        if (ex === 0 && ey === 0) continue;
        const nx = x + ex;
        const ny = y + ey;
        if (nx === cx && ny === cy) continue; // the controller tile hosts no upgrader
        if (walkable(nx, ny) && inUpgradeRange(nx, ny)) score++;
      }
    }
    return score;
  };

  let best: { x: number; y: number; score: number } | null = null;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      const x = cx + dx;
      const y = cy + dy;
      if ((dx === 0 && dy === 0) || !walkable(x, y) || !inUpgradeRange(x, y) || dead.has(`${x},${y}`)) continue;
      const score = parkRing(x, y);
      const better =
        !best || score > best.score || (score === best.score && (x < best.x || (x === best.x && y < best.y)));
      if (better) best = { x, y, score };
    }
  }

  const incumbent = buffers
    .filter((s): s is StructureContainer => s.structureType === STRUCTURE_CONTAINER)
    .map(c => ({ c, score: parkRing(c.pos.x, c.pos.y) }))
    .sort((a, b) => b.score - a.score)[0];
  if (incumbent && (!best || incumbent.score >= best.score - 1)) {
    return { pos: incumbent.c.pos, structure: incumbent.c };
  }
  if (best) return { pos: new RoomPosition(best.x, best.y, room.name) };
  if (incumbent) return { pos: incumbent.c.pos, structure: incumbent.c }; // walled-in: keep what stands
  return { pos: controller.pos };
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
  // OFF-ROAD FIRST (owner 2026-07-22): road tiles in the ring are the
  // delivery lanes - a parked upgrader there plugs them for every hauler and
  // feeder trip. Road avoidance dominates the closest-first rule (every ring
  // tile is within upgrade range, so distance is comfort, not function);
  // road tiles stay in the ring as last-resort capacity. Precomputed once -
  // never inside the comparator (lookForAt per comparison).
  const roadTiles = new Set<string>();
  if (typeof room.lookForAt === "function") {
    for (const t of tiles) {
      if (room.lookForAt(LOOK_STRUCTURES, t.x, t.y).some(s => s.structureType === STRUCTURE_ROAD)) {
        roadTiles.add(`${t.x},${t.y}`);
      }
    }
  }
  const road = (p: RoomPosition): number => (roadTiles.has(`${p.x},${p.y}`) ? 1 : 0);
  tiles.sort((a, b) => road(a) - road(b) || distToController(a) - distToController(b) || a.x - b.x || a.y - b.y);
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
 * The parameterized core of the "energy staged at the controller" lenses.
 * TWO named variants exist DELIBERATELY (spec 35 phase D, audit finding
 * corps-rest/8 - do not blind-merge them): the wide sizing/ledger view
 * ({@link controllerSideStock}) and the feeder's narrow top-up gate
 * ({@link feederRelayStock}). The divergence is load-bearing and is encoded
 * here as named parameters instead of a private re-implementation, so the
 * difference between the two readings is visible in one place.
 */
function stagedControllerEnergy(
  controller: StructureController,
  inputPos: RoomPosition,
  opts: {
    /** Tiles around the CONTROLLER within which buffer structures count. */
    structureRange: number;
    /** Count the room's storage as staged stock (the wide sizing view only). */
    includeStorage: boolean;
    /** Count only the FIRST matching buffer (the feeder's single input buffer). */
    firstBufferOnly: boolean;
    /** Tiles around the INPUT SPOT within which loose piles count. */
    pileRange: number;
  }
): number {
  let stock = 0;
  let buffers = 0;
  for (const s of controller.pos.findInRange(FIND_STRUCTURES, opts.structureRange)) {
    const isBuffer =
      s.structureType === STRUCTURE_CONTAINER ||
      s.structureType === STRUCTURE_LINK || // the controller link IS the input once built (spec 24 rung 3)
      (opts.includeStorage && s.structureType === STRUCTURE_STORAGE);
    if (!isBuffer) continue;
    if (opts.firstBufferOnly && buffers >= 1) continue;
    buffers++;
    stock += (s as StructureContainer | StructureStorage | StructureLink).store[RESOURCE_ENERGY] ?? 0;
  }
  for (const r of inputPos.findInRange(FIND_DROPPED_RESOURCES, opts.pileRange)) {
    if (r.resourceType === RESOURCE_ENERGY) stock += r.amount;
  }
  return stock;
}

/**
 * Energy actually pooled at the controller side: containers/storage/links
 * within 4 of the controller plus loose energy near the input spot. THE lens
 * for stock-grounded upgrader sizing (UpgradingCorp) AND the telemetry room
 * ledger (spec 14 phase 1) - both read this one function so the number a
 * dashboard shows is the number the decision used.
 */
export function controllerSideStock(controller: StructureController): number {
  const spot = controllerInputSpot(controller).pos;
  return stagedControllerEnergy(controller, spot, {
    structureRange: 4,
    includeStorage: true,
    firstBufferOnly: false,
    pileRange: 2
  });
}

/**
 * The FEEDER's narrow view of the same stock - the gate for its
 * CONTROLLER_FEED_TARGET top-up (ControllerFeederCorp). Deliberately
 * NARROWER than {@link controllerSideStock}; each difference is a reason,
 * not an accident:
 *  - EXCLUDES storage: a storage within reach of the controller is the BANK
 *    the feeder relays FROM - counting it as staged stock would read the
 *    whole bank as "topped up" and stop the relay for good.
 *  - FIRST buffer only, within 3: the feeder fills ONE input buffer (the
 *    container/link the upgraders draw from), not every box near the
 *    controller.
 *  - piles within 1 of the input tile only: its own drop pile, not the wider
 *    scatter the sizing lens tolerates.
 */
export function feederRelayStock(controller: StructureController, inputPos: RoomPosition): number {
  return stagedControllerEnergy(controller, inputPos, {
    structureRange: 3,
    includeStorage: false,
    firstBufferOnly: true,
    pileRange: 1
  });
}

/**
 * Unhauled energy at a SOURCE's mouth: container stock within 1 plus ground
 * piles within 1. ONE lens, two readers (the {@link controllerSideStock}
 * doctrine - the number the dashboard shows is the number the decision used):
 * the sourceBuffers telemetry (coreSegment) and the miner pile gate
 * (HarvestCorp.minerSpawnDemand vs SOURCE_BUFFER_DEFER_THRESHOLD). Returns
 * null when the read is unmeasurable (partial mock without wired finds) - a
 * different fact from zero; decision callers fail OPEN on null.
 */
/**
 * The DROPPED share of a source's buffer - the half that ROTS.
 *
 * Container energy keeps indefinitely; dropped energy loses ceil(amount/1000)
 * every tick. Splitting them makes ground rot a measurable line in the audit's
 * energy account instead of a lump inside the unattributed residual (owner
 * 2026-08-01). `sourceBufferStock` keeps returning the TOTAL - E6 and the haul
 * drain term are sized on the whole pile and must not change.
 */
export function sourceDroppedStock(source: Source): number | null {
  try {
    let dropped = 0;
    for (const r of source.pos.findInRange(FIND_DROPPED_RESOURCES, 1)) {
      if (r.resourceType === RESOURCE_ENERGY) dropped += r.amount ?? 0;
    }
    return dropped;
  } catch {
    return null;
  }
}

export function sourceBufferStock(source: Source): number | null {
  try {
    let stock = 0;
    for (const s of source.pos.findInRange(FIND_STRUCTURES, 1)) {
      if (s.structureType === STRUCTURE_CONTAINER) {
        stock += (s as StructureContainer).store?.[RESOURCE_ENERGY] ?? 0;
      }
    }
    for (const r of source.pos.findInRange(FIND_DROPPED_RESOURCES, 1)) {
      if (r.resourceType === RESOURCE_ENERGY) stock += r.amount ?? 0;
    }
    return stock;
  } catch {
    return null;
  }
}

/**
 * How stale a mouth observation may be and still price a drain fleet: one
 * creep generation, the same horizon the drain law itself clears the buffer
 * over.
 *
 * Erring long is the SAFE direction here, and the asymmetry is the argument.
 * Over-price the drain and the plan buys CARRY that empties the mouth, after
 * which the next observation reads ~0 and the term retires itself - one
 * generation of slightly fat routes. Under-price it (today's behaviour) and
 * the pile grows without bound, gates the miner off its own source, and takes
 * the room's vision with it - which is why nothing self-corrects.
 */
export const MOUTH_STOCK_MAX_AGE = 1500;

/**
 * THE DURABLE MOUTH-STOCK LENS: what a miner last SAW at this source's mouth,
 * or null if nobody has looked recently.
 *
 * Exists because `sourceBufferStock` needs VISION - `Game.getObjectById`
 * returns null for a source in a remote room with no creep standing in it -
 * and the SOLVE runs whether or not a creep happens to be there. The miner's
 * read always succeeds (it is standing at the mouth), so it stamps what it
 * sees and the plan reads the stamp. Exactly the durable-signal rule the
 * stranded-reserver incident wrote: never key a decision on "one of our creeps
 * is standing there", because it flaps on every death AND goes blind with the
 * vision that creep provided.
 *
 * Measured t72850264: six of eleven mouths held 2,737-3,553 for 78-100% of the
 * window while EVERY hauler route in the published plan was sized at
 * `flow = 10` - the raw source rate, no drain term anywhere. The miner saw the
 * pile (E6 reads these very stamps); the plan did not.
 */
export function observedMouthStock(sourceId: string, tick: number): number | null {
  if (typeof Memory === "undefined") return null;
  const w = Memory.pileMeter?.[stripSourcePrefix(sourceId).slice(-6)];
  if (!w || w.stock === undefined || w.stockAt === undefined) return null;
  return tick - w.stockAt <= MOUTH_STOCK_MAX_AGE ? w.stock : null;
}

/**
 * Is a source-link volley INBOUND to the core link right now (spec 45 leg 2)?
 *
 * True when any non-core, non-controller link in the room stands loaded at or
 * above the fire threshold AND is either off cooldown or about to come off it
 * ("near-fire"): those are the volleys that need landing room THIS beat or the
 * next. Feeds `coreLinkTargetLevel`, which drops the core's target to 0 while
 * this holds - stop staging from storage, pre-drain what is already there.
 *
 * NEAR-FIRE window: a link one tick from firing is as much an arrival as one
 * firing now, because the feeder needs a beat to walk its load. A whole
 * LINK_COOLDOWN would over-trigger (the core would never stage at all in a
 * busy room), so the window is deliberately short.
 *
 * The CONTROLLER link is excluded as a sender by rule (withdraw-only,
 * LinkRunner's invariant) and the core cannot arrive at itself.
 */
export function coreInboundPending(room: Room, core: StructureLink, nearFireTicks = 1): boolean {
  // Partial mocks (and any room the caller could not resolve): no EVIDENCE of
  // an arrival is not an arrival - fail to the pre-spec-45 staging law rather
  // than throwing inside a per-tick creep path.
  if (!room || typeof room.find !== "function") return false;
  const ctrl = controllerLink(room);
  let links: StructureLink[];
  try {
    links = room.find(FIND_MY_STRUCTURES, {
      filter: (s: AnyOwnedStructure) => s.structureType === STRUCTURE_LINK
    }) as StructureLink[];
  } catch {
    return false; // partial mocks: no evidence of an arrival is not an arrival
  }
  for (const link of links) {
    if (link.id === core.id) continue;
    if (ctrl && link.id === ctrl.id) continue;
    if ((link.cooldown ?? 0) > nearFireTicks) continue;
    if ((link.store?.[RESOURCE_ENERGY] ?? 0) >= LINK_FIRE_THRESHOLD) return true;
  }
  return false;
}
