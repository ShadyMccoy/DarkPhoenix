/**
 * @fileoverview Room discovery utilities using public map data.
 *
 * These utilities discover rooms within a certain distance from owned rooms
 * using only public map data (no vision required).
 *
 * @module utils/RoomDiscovery
 */

import { recordRaidSighting } from "./raidMeter";

/**
 * Discovers all rooms within a certain exit distance from owned rooms.
 * Uses BFS traversal via Game.map.describeExits (public data, no vision needed).
 *
 * @param maxDistance - Maximum number of room exits to traverse (default 2)
 * @returns Set of room names within range
 */
export function discoverNearbyRooms(maxDistance = 2): Set<string> {
  const discovered = new Set<string>();
  const visited = new Set<string>();

  // Start from all owned rooms
  const queue: { roomName: string; distance: number }[] = [];

  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.controller?.my) {
      queue.push({ roomName, distance: 0 });
      visited.add(roomName);
      discovered.add(roomName);
    }
  }

  // BFS to find rooms within maxDistance
  while (queue.length > 0) {
    const { roomName, distance } = queue.shift()!;

    // Don't expand beyond maxDistance
    if (distance >= maxDistance) continue;

    // Get adjacent rooms
    const exits = Game.map.describeExits(roomName);
    if (!exits) continue;

    for (const direction in exits) {
      const adjacentRoom = exits[direction as ExitKey];
      if (!adjacentRoom) continue;
      if (visited.has(adjacentRoom)) continue;

      // Check room status (avoid inaccessible rooms)
      const status = Game.map.getRoomStatus(adjacentRoom);
      if (status.status === "closed") continue;

      visited.add(adjacentRoom);
      discovered.add(adjacentRoom);
      queue.push({ roomName: adjacentRoom, distance: distance + 1 });
    }
  }

  return discovered;
}

/**
 * Gets the distance from a room to the nearest owned room.
 * Returns 0 for owned rooms, Infinity if not reachable.
 *
 * @param targetRoom - The room to check
 * @param maxSearch - Maximum distance to search (default 10)
 * @returns Distance in room exits
 */
export function getDistanceToOwnedRoom(targetRoom: string, maxSearch = 10): number {
  const visited = new Set<string>();
  const queue: { roomName: string; distance: number }[] = [{ roomName: targetRoom, distance: 0 }];
  visited.add(targetRoom);

  while (queue.length > 0) {
    const { roomName, distance } = queue.shift()!;

    // Check if this room is owned
    const room = Game.rooms[roomName];
    if (room?.controller?.my) {
      return distance;
    }

    // Don't search beyond maxSearch
    if (distance >= maxSearch) continue;

    // Expand to adjacent rooms
    const exits = Game.map.describeExits(roomName);
    if (!exits) continue;

    for (const direction in exits) {
      const adjacentRoom = exits[direction as ExitKey];
      if (!adjacentRoom) continue;
      if (visited.has(adjacentRoom)) continue;

      const status = Game.map.getRoomStatus(adjacentRoom);
      if (status.status === "closed") continue;

      visited.add(adjacentRoom);
      queue.push({ roomName: adjacentRoom, distance: distance + 1 });
    }
  }

  return Infinity;
}

/**
 * Parses a room name into its coordinate components.
 * E.g., "E75N8" -> { xDir: "E", x: 75, yDir: "N", y: 8 }
 */
function parseRoomName(roomName: string): { xDir: string; x: number; yDir: string; y: number } | null {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
  if (!match) return null;
  return {
    xDir: match[1],
    x: parseInt(match[2], 10),
    yDir: match[3],
    y: parseInt(match[4], 10)
  };
}

/**
 * Builds a room name from coordinate components.
 */
function buildRoomName(xDir: string, x: number, yDir: string, y: number): string {
  return `${xDir}${x}${yDir}${y}`;
}

/** Default radius for room box discovery (3 = 7x7 grid) */
export const DEFAULT_ROOM_BOX_RADIUS = 3;

/**
 * Gets a box of room names centered on the given room with configurable radius.
 * A radius of 3 gives a 7x7 box (49 rooms), radius of 4 gives 9x9 (81 rooms), etc.
 *
 * @param centerRoom - The room at the center of the box
 * @param radius - Distance from center (default 3 for 7x7)
 * @returns Array of room names in the box
 */
export function getRoomBox(centerRoom: string, radius: number = DEFAULT_ROOM_BOX_RADIUS): string[] {
  const parsed = parseRoomName(centerRoom);
  if (!parsed) return [centerRoom];

  const rooms: string[] = [];

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      // Calculate new coordinates, handling sector boundary crossings
      let newX = parsed.x + dx;
      let newY = parsed.y + dy;
      let newXDir = parsed.xDir;
      let newYDir = parsed.yDir;

      // Handle X axis crossing (W/E boundary at 0)
      if (newX < 0) {
        // Crossing from E to W or W to E
        newX = -newX - 1; // E0 - 1 = W0, E0 - 2 = W1
        newXDir = parsed.xDir === "E" ? "W" : "E";
      }

      // Handle Y axis crossing (N/S boundary at 0)
      if (newY < 0) {
        // Crossing from N to S or S to N
        newY = -newY - 1; // N0 - 1 = S0, N0 - 2 = S1
        newYDir = parsed.yDir === "N" ? "S" : "N";
      }

      rooms.push(buildRoomName(newXDir, newX, newYDir, newY));
    }
  }

  return rooms;
}

/**
 * Gets a 7x7 box of room names centered on the given room.
 * Convenience wrapper for getRoomBox with radius 3.
 */
export function get7x7RoomBox(centerRoom: string): string[] {
  return getRoomBox(centerRoom, 3);
}

/**
 * Gets a box of rooms centered on each owned room, combined.
 * Filters out closed rooms.
 *
 * @param radius - Distance from center (default 3 for 7x7)
 * @returns Set of room names in the combined boxes
 */
export function getRoomBoxAroundOwnedRooms(radius: number = DEFAULT_ROOM_BOX_RADIUS): Set<string> {
  const rooms = new Set<string>();

  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.controller?.my) {
      const box = getRoomBox(roomName, radius);
      for (const boxRoom of box) {
        // Check if room is accessible
        const status = Game.map.getRoomStatus(boxRoom);
        if (status.status !== "closed") {
          rooms.add(boxRoom);
        }
      }
    }
  }

  return rooms;
}

/**
 * Gets a 7x7 box of rooms centered on each owned room, combined.
 * Convenience wrapper for getRoomBoxAroundOwnedRooms with radius 3.
 */
export function get7x7BoxAroundOwnedRooms(): Set<string> {
  return getRoomBoxAroundOwnedRooms(3);
}

/**
 * Categorizes discovered rooms by their distance from owned rooms.
 *
 * @param maxDistance - Maximum distance to discover
 * @returns Map of distance to room names at that distance
 */
export function categorizeRoomsByDistance(maxDistance = 2): Map<number, string[]> {
  const result = new Map<number, string[]>();

  // Initialize distance buckets
  for (let d = 0; d <= maxDistance; d++) {
    result.set(d, []);
  }

  const visited = new Set<string>();
  const queue: { roomName: string; distance: number }[] = [];

  // Start from owned rooms
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.controller?.my) {
      queue.push({ roomName, distance: 0 });
      visited.add(roomName);
      result.get(0)!.push(roomName);
    }
  }

  // BFS
  while (queue.length > 0) {
    const { roomName, distance } = queue.shift()!;

    if (distance >= maxDistance) continue;

    const exits = Game.map.describeExits(roomName);
    if (!exits) continue;

    for (const direction in exits) {
      const adjacentRoom = exits[direction as ExitKey];
      if (!adjacentRoom) continue;
      if (visited.has(adjacentRoom)) continue;

      const status = Game.map.getRoomStatus(adjacentRoom);
      if (status.status === "closed") continue;

      visited.add(adjacentRoom);
      const newDistance = distance + 1;
      result.get(newDistance)!.push(adjacentRoom);
      queue.push({ roomName: adjacentRoom, distance: newDistance });
    }
  }

  return result;
}

/**
 * Source-Keeper room classification by name: both room-grid coordinates mod 10
 * in [4,6], excluding the center (5,5) crossroads room. SK rooms' sources are
 * already excluded from mining (SourceAnalysis keeper check; grid cell
 * plan-t5-sk-never-mined), but nothing kept CREEPS out: scouts wandered in and
 * died to keepers (measured: 4 creeps parked in W44N24 on the shard1 stress
 * fixture). Mirrors test/grid/pack.ts's isSkRoomName - keep in sync.
 */
export function isSourceKeeperRoom(name: string): boolean {
  const m = /^[WE](\d+)[NS](\d+)$/.exec(name);
  if (!m) return false;
  const h = Number(m[1]) % 10;
  const v = Number(m[2]) % 10;
  const inBand = (n: number) => n >= 4 && n <= 6;
  return inBand(h) && inBand(v) && !(h === 5 && v === 5);
}

/** The Invader NPC's username: invader creeps and invader-core reservations. */
export const INVADER_USERNAME = "Invader";

/**
 * Rooms currently held by hostiles, memoized per tick. Two flavors, one set:
 * hostile CREEPS (invaders, or any player's) sighted in the room, and an
 * invader CORE's controller reservation - the core is a structure the creep
 * pass never sees, so the reservation itself is the observable. The v1
 * DEFENSE ECONOMICS (owner directive 2026-07-10): while hostiles hold a
 * room, the corps operating there are DEFUNDED - no new bodies are bought
 * for a grinder (miners mining there, haulers hauling there, reservers
 * headed there). Existing creeps run out; funding resumes the tick the room
 * clears. Vision-limited by design: an unseen room is not assumed hostile.
 */
let hostileRoomsTick = -1;
let hostileRoomsCache = new Set<string>();
export function hostileRooms(): Set<string> {
  if (typeof Game === "undefined" || !Game.rooms) return new Set();
  if (Game.time === hostileRoomsTick) return hostileRoomsCache;
  hostileRoomsTick = Game.time;
  hostileRoomsCache = new Set<string>();

  // Vision pass: sight a hostile once and its ticksToLive BOUNDS the threat
  // (owner: "not always sight on the invaders, but if we see one we capture
  // the TTL") - the mark outlives vision; a clear sighting lifts it early.
  if (typeof Memory !== "undefined") {
    Memory.roomIntel = Memory.roomIntel ?? {};
    for (const roomName in Game.rooms) {
      const hostiles = Game.rooms[roomName].find(FIND_HOSTILE_CREEPS);
      const intel = Memory.roomIntel[roomName];
      if (hostiles.length > 0) {
        const maxTtl = hostiles.reduce((m, c) => Math.max(m, c.ticksToLive ?? 1500), 0);
        if (intel) intel.hostileUntil = Game.time + maxTtl;
        else {
          Memory.roomIntel[roomName] = { lastVisit: Game.time, hostileUntil: Game.time + maxTtl } as RoomIntel;
        }
        // Raid observation (spec 13): Invader-owned creeps in sight mean the
        // engine zeroed its raid fuse when it spawned them - zero the mirror
        // and stamp the sighting (the guard corp's reactive trigger).
        if (hostiles.some(c => c.owner?.username === INVADER_USERNAME)) {
          recordRaidSighting(roomName);
        }
      } else if (intel?.hostileUntil) {
        delete intel.hostileUntil; // fresh all-clear sighting
      }

      // Invader-core reservation: the room is held even with zero hostile
      // creeps in sight. The reservation's ticksToEnd bounds the occupation
      // the way a creep's ticksToLive bounds a raid - though a live core
      // RENEWS it, so each sighting refreshes the bound; blind, the mark
      // lapses at the last-seen bound and the next sighting re-arms it.
      const reservation = Game.rooms[roomName].controller?.reservation;
      const stamped = Memory.roomIntel[roomName]; // may exist since the creep pass
      if (reservation && reservation.username === INVADER_USERNAME) {
        const until = Game.time + reservation.ticksToEnd;
        if (stamped) stamped.invaderReservedUntil = until;
        else {
          Memory.roomIntel[roomName] = { lastVisit: Game.time, invaderReservedUntil: until } as RoomIntel;
        }
        // Is the CORE itself in sight? Splits the occupation into its two
        // phases for the buster corp (spec 13 phase 4): core alive = KILL
        // (stripping against a live core's +2/tick renewal is pointless),
        // core dead = STRIP (the leftover reservation decays 1/tick for up
        // to 5000 ticks unless CLAIM parts grind it). Only checked in
        // invader-reserved rooms with vision, so the extra find() is rare.
        const coreSeen = Game.rooms[roomName]
          .find(FIND_HOSTILE_STRUCTURES)
          .some(s => s.structureType === STRUCTURE_INVADER_CORE);
        Memory.roomIntel[roomName].invaderCorePresent = coreSeen;
      } else if (stamped?.invaderReservedUntil) {
        delete stamped.invaderReservedUntil; // fresh sighting: reservation gone
        delete stamped.invaderCorePresent;
      }
    }
    // Marks persist without vision until their TTL bound expires.
    for (const roomName in Memory.roomIntel) {
      const intel = Memory.roomIntel[roomName];
      const hostileUntil = intel?.hostileUntil;
      const reservedUntil = intel?.invaderReservedUntil;
      if (
        (hostileUntil !== undefined && hostileUntil > Game.time) ||
        (reservedUntil !== undefined && reservedUntil > Game.time)
      ) {
        hostileRoomsCache.add(roomName);
      }
    }
  } else {
    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (room.find(FIND_HOSTILE_CREEPS).length > 0 || room.controller?.reservation?.username === INVADER_USERNAME) {
        hostileRoomsCache.add(roomName);
      }
    }
  }
  return hostileRoomsCache;
}

/**
 * Rooms a haul route transits between two rooms, endpoints included, per the
 * engine's room-level router (Game.map.findRoute - the same topology moveTo
 * follows across rooms). Memoized per tick. Falls back to just the endpoints
 * when the map API is unavailable (harness) or routing fails, so callers
 * degrade to the old pickup-room-only behavior.
 *
 * Spec 13 phase 2b (The International's `pathsThrough`): a route is dangerous
 * if ANY room it transits is hostile - haulers must not drive their circuit
 * through a raid two rooms out just because the pickup room itself is clear.
 */
let routeRoomsTick = -1;
let routeRoomsCache = new Map<string, string[]>();
export function routeRooms(fromRoom: string, toRoom: string): string[] {
  if (typeof Game === "undefined") return [fromRoom, toRoom];
  if (Game.time !== routeRoomsTick) {
    routeRoomsTick = Game.time;
    routeRoomsCache = new Map();
  }
  const key = `${fromRoom}->${toRoom}`;
  const hit = routeRoomsCache.get(key);
  if (hit) return hit;

  let rooms = [fromRoom, toRoom];
  if (fromRoom === toRoom) {
    rooms = [fromRoom];
  } else if (typeof Game.map?.findRoute === "function") {
    const route = Game.map.findRoute(fromRoom, toRoom);
    if (Array.isArray(route)) {
      rooms = [fromRoom, ...route.map(step => step.room)];
    }
  }
  routeRoomsCache.set(key, rooms);
  return rooms;
}

/** Is any room on the route between the two rooms currently hostile? */
export function routeIsDangerous(fromRoom: string, toRoom: string): boolean {
  const danger = hostileRooms();
  if (danger.size === 0) return false;
  return routeRooms(fromRoom, toRoom).some(r => danger.has(r));
}
