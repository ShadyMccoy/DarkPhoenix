/**
 * @fileoverview Room discovery utilities using public map data.
 *
 * These utilities discover rooms within a certain distance from owned rooms
 * using only public map data (no vision required).
 *
 * @module utils/RoomDiscovery
 */

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

/**
 * Rooms currently containing hostile creeps (invaders, or any player's),
 * memoized per tick. The v1 DEFENSE ECONOMICS (owner directive 2026-07-10):
 * while hostiles hold a room, the corps operating there are DEFUNDED - no
 * new bodies are bought for a grinder (miners mining there, haulers hauling
 * there, reservers headed there). Existing creeps run out; funding resumes
 * the tick the room clears. Vision-limited by design: an unseen room is not
 * assumed hostile.
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
      } else if (intel?.hostileUntil) {
        delete intel.hostileUntil; // fresh all-clear sighting
      }
    }
    // Marks persist without vision until their TTL bound expires.
    for (const roomName in Memory.roomIntel) {
      const until = Memory.roomIntel[roomName]?.hostileUntil;
      if (until !== undefined && until > Game.time) hostileRoomsCache.add(roomName);
    }
  } else {
    for (const roomName in Game.rooms) {
      if (Game.rooms[roomName].find(FIND_HOSTILE_CREEPS).length > 0) hostileRoomsCache.add(roomName);
    }
  }
  return hostileRoomsCache;
}
