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
export function discoverNearbyRooms(maxDistance: number = 2): Set<string> {
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
export function getDistanceToOwnedRoom(
  targetRoom: string,
  maxSearch: number = 10
): number {
  const visited = new Set<string>();
  const queue: { roomName: string; distance: number }[] = [
    { roomName: targetRoom, distance: 0 },
  ];
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
 * Categorizes discovered rooms by their distance from owned rooms.
 *
 * @param maxDistance - Maximum distance to discover
 * @returns Map of distance to room names at that distance
 */
export function categorizeRoomsByDistance(
  maxDistance: number = 2
): Map<number, string[]> {
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
