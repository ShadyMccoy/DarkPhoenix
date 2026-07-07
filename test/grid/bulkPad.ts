/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * bulkPadTerrain - all-plain terrain padding without the O(n^3) blowup.
 *
 * padNeighborTerrain calls world.setTerrain per pad room, and every setTerrain
 * re-scans ALL rooms and re-deflates the entire terrain env blob
 * (updateEnvTerrain). For the grid's radius-3 padding (~40 pad rooms per cell,
 * 150+ for a batch) that is minutes of pure setup. This writes the db.rooms +
 * rooms.terrain docs directly and rebuilds the env cache ONCE at the end -
 * same final state, one deflate.
 *
 * Radius 3 matters (not the usual 1): the bot's incremental analysis sweeps a
 * radius-3 room-name box around owned rooms, and a room with NO terrain data
 * makes that whole 9-room analysis batch throw and get dropped - possibly the
 * batch containing the home room (src/execution/IncrementalAnalysis.ts:189-199).
 */

import { formatRoomName, parseRoomName } from "../integration/loadLayout";

const ALL_PLAIN = "0".repeat(2500); // TerrainMatrix serialization: '0' = plain

/**
 * Register all-plain terrain for every room within `radius` of a real room
 * that has not itself been loaded. Pad rooms are active:true, exactly matching
 * what padNeighborTerrain's addRoom would produce - they hold no objects, so
 * the engine spends nothing on them, and sealed cell borders keep creeps out.
 */
export async function bulkPadTerrain(server: any, rooms: string[], radius = 3): Promise<void> {
  const real = new Set(rooms);
  const needed = new Set<string>();
  for (const name of rooms) {
    const c = parseRoomName(name);
    if (!c) continue;
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (dx === 0 && dy === 0) continue;
        const neighbor = formatRoomName(c.x + dx, c.y + dy);
        if (!real.has(neighbor)) needed.add(neighbor);
      }
    }
  }
  if (needed.size === 0) return;

  const { db, env } = server.common.storage;
  const existingRooms = new Set((await db.rooms.find()).map((r: any) => String(r._id)));
  const existingTerrain = new Set((await db["rooms.terrain"].find()).map((t: any) => String(t.room)));

  for (const name of needed) {
    if (!existingRooms.has(name)) {
      await db.rooms.insert({ _id: name, status: "normal", active: true });
    }
    if (!existingTerrain.has(name)) {
      await db["rooms.terrain"].insert({ room: name, terrain: ALL_PLAIN });
    }
  }

  // One env rebuild + one accessible-rooms refresh for the whole set.
  await server.world.updateEnvTerrain(db, env);
  await server.driver.updateAccessibleRoomsList();
}
