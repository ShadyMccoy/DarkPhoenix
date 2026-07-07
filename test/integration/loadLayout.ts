/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * loadLayout - build a screeps-server-mockup world from declarative layouts.
 *
 * This bridges the room fixtures already in this repo into a running mock
 * server, so integration tests can exercise the same room definitions used by
 * the spatial-analysis unit tests:
 *
 *   - ASCII terrain patterns (e.g. test/unit/spatial/fixtures/real-room-terrain.ts)
 *     via `terrainMatrixFromPattern`.
 *   - Node-network JSON fixtures (e.g. test/fixtures/simple-mining.json)
 *     via `layoutFromNodeFixture`.
 *
 * See https://github.com/screepers/screeps-server-mockup for the world API.
 */

// screeps-server-mockup ships no type definitions, so require it directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TerrainMatrix } = require("screeps-server-mockup");
import * as fs from "fs";
import * as path from "path";

export type ObjectType = "source" | "controller" | "mineral" | string;

export interface LayoutObject {
  type: ObjectType;
  x: number;
  y: number;
  /** Engine attributes; merged over per-type defaults below. */
  attributes?: Record<string, unknown>;
}

export interface RoomLayout {
  room: string;
  /**
   * Up to 50 strings of up to 50 chars: '#' = wall, '~' = swamp, anything
   * else (typically '.') = plain. Omit for an all-plain room.
   */
  terrain?: string[];
  objects?: LayoutObject[];
}

/**
 * Canonical engine attributes per object type. Mirrors the shapes the engine
 * expects (see screeps-server-mockup/assets/rooms.json), so callers can place
 * an object with just a type and coordinates.
 */
const DEFAULT_ATTRIBUTES: Record<string, Record<string, unknown>> = {
  source: { energy: 3000, energyCapacity: 3000, ticksToRegeneration: 300 },
  controller: { level: 0 },
  mineral: { mineralType: "H", density: 3, mineralAmount: 70000 },
};

/**
 * Convert a 50-line ASCII terrain pattern into a mockup `TerrainMatrix`.
 * '#' = wall, '~' = swamp, every other character = plain.
 */
export function terrainMatrixFromPattern(pattern: string[]): any {
  const matrix = new TerrainMatrix();
  for (let y = 0; y < pattern.length; y += 1) {
    const row = pattern[y];
    for (let x = 0; x < row.length; x += 1) {
      const ch = row[x];
      if (ch === "#") {
        matrix.set(x, y, "wall");
      } else if (ch === "~") {
        matrix.set(x, y, "swamp");
      }
      // '.' and anything else stays plain (the matrix default)
    }
  }
  return matrix;
}

/**
 * Apply a single room layout (terrain + objects) to a mock server's world.
 * The room is created if needed. Object tiles are forced to plain so a source
 * or controller is never buried in a wall.
 */
export async function applyRoomLayout(world: any, layout: RoomLayout): Promise<void> {
  await world.addRoom(layout.room);

  if (layout.terrain && layout.terrain.length > 0) {
    const matrix = terrainMatrixFromPattern(layout.terrain);
    for (const obj of layout.objects ?? []) {
      matrix.set(obj.x, obj.y, "plain");
    }
    await world.setTerrain(layout.room, matrix);
  }

  for (const obj of layout.objects ?? []) {
    const attributes = { ...(DEFAULT_ATTRIBUTES[obj.type] ?? {}), ...(obj.attributes ?? {}) };
    await world.addRoomObject(layout.room, obj.type, obj.x, obj.y, attributes);
  }
}

/**
 * Apply one or more room layouts to a mock server's world.
 *
 *   await loadLayout(server.world, {
 *     room: "W0N0",
 *     terrain: E75N8_TERRAIN_PATTERN,
 *     objects: [
 *       { type: "source", x: 10, y: 25 },
 *       { type: "controller", x: 25, y: 25 },
 *     ],
 *   });
 */
export async function loadLayout(world: any, layout: RoomLayout | RoomLayout[]): Promise<void> {
  const layouts = Array.isArray(layout) ? layout : [layout];
  for (const single of layouts) {
    await applyRoomLayout(world, single);
  }
}

/**
 * Give an EXISTING bot a second (third, ...) owned room: claim that room's
 * controller for the user and drop a functional spawn in it. This mirrors the
 * two db writes `addBot` does for its first room, so a single player can own N
 * rooms at once - the setup for "does N rooms behave like N independent single
 * rooms?". The room must already have a controller (load its layout first).
 */
export async function addOwnedRoom(
  world: any,
  userId: string,
  room: string,
  x: number,
  y: number,
  spawnName: string
): Promise<void> {
  const { C, db } = await world.load();
  const controller = await db["rooms.objects"].findOne({ $and: [{ room }, { type: "controller" }] });
  if (controller == null) {
    throw new Error(`addOwnedRoom: ${room} has no controller (load its layout first)`);
  }
  await Promise.all([
    db.rooms.update({ _id: room }, { $set: { active: true } }),
    db["rooms.objects"].update(
      { room, type: "controller" },
      { $set: { user: userId, level: 1, progress: 0, downgradeTime: null, safeMode: 20000 } }
    ),
    db["rooms.objects"].insert({
      room,
      type: "spawn",
      x,
      y,
      user: userId,
      name: spawnName,
      store: { energy: C.SPAWN_ENERGY_START },
      storeCapacityResource: { energy: C.SPAWN_ENERGY_CAPACITY },
      hits: C.SPAWN_HITS,
      hitsMax: C.SPAWN_HITS,
      spawning: null,
      notifyWhenAttacked: true
    })
  ]);
}

/**
 * Load engine mods that override game constants, by injecting a `mods` array
 * into the server's db.json - the file the engine processes read as their
 * MODFILE (config-manager loads each listed module with the live `config`).
 *
 * Call AFTER the world is built (so db.json exists, having been copied on the
 * first world op) and BEFORE `server.start()` (so the engine processes read it
 * when they fork). Storage has already loaded the db into memory, so adding a
 * `mods` key here does not disturb the live world - it only feeds the engine's
 * constant-loading step.
 */
export function enableMods(serverPath: string, modPaths: string[]): void {
  const dbPath = path.resolve(serverPath, "db.json");
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  db.mods = modPaths.map(p => path.resolve(p));
  fs.writeFileSync(dbPath, JSON.stringify(db));
}

/** Absolute path to the bundled free-economy mod (zeroes build/upgrade sinks). */
export const FREE_ECONOMY_MOD = path.resolve(__dirname, "mods", "freeEconomy.js");

/**
 * Set an owned room's controller level (and optional extension count), so a sim
 * can START at a given RCL instead of grinding through bootstrap to reach it.
 * Call after the bot is added (its controller exists). Extensions are dropped
 * around the spawn so energyCapacityAvailable reflects the level.
 */
export async function setRoomLevel(
  world: any,
  room: string,
  level: number,
  extensions: Array<{ x: number; y: number }> = [],
  /** Start the extensions full, as an organically-grown colony's would be. */
  filled = false
): Promise<void> {
  const { C, db } = await world.load();
  await db["rooms.objects"].update(
    { room, type: "controller" },
    { $set: { level, progress: 0, downgradeTime: null } }
  );
  const capacity = C.EXTENSION_ENERGY_CAPACITY[level] ?? 50;
  for (const e of extensions) {
    await db["rooms.objects"].insert({
      room,
      type: "extension",
      x: e.x,
      y: e.y,
      user: (await db["rooms.objects"].findOne({ room, type: "controller" })).user,
      store: { energy: filled ? capacity : 0 },
      storeCapacityResource: { energy: capacity },
      hits: C.EXTENSION_HITS,
      hitsMax: C.EXTENSION_HITS,
      notifyWhenAttacked: true
    });
  }
}

// ---------------------------------------------------------------------------
// Neighbour-room padding
// ---------------------------------------------------------------------------

/** Parse a room name like "W0N0" / "E3S12" into signed grid coordinates. */
export function parseRoomName(name: string): { x: number; y: number } | null {
  const m = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
  if (!m) return null;
  const horiz = Number(m[2]);
  const vert = Number(m[4]);
  const x = m[1] === "W" ? -horiz - 1 : horiz;
  const y = m[3] === "N" ? -vert - 1 : vert;
  return { x, y };
}

/** Inverse of {@link parseRoomName}. */
export function formatRoomName(x: number, y: number): string {
  const h = x < 0 ? `W${-x - 1}` : `E${x}`;
  const v = y < 0 ? `N${-y - 1}` : `S${y}`;
  return `${h}${v}`;
}

/**
 * Register all-plain terrain for every room adjacent to a real (loaded) room
 * that has not itself been loaded.
 *
 * The native PathFinder throws "Could not load terrain data" the moment a
 * creep's path-search frontier touches a room whose terrain table is empty.
 * In single-room test worlds this fires whenever a creep paths near the room
 * edge (e.g. a bootstrap jack at a source by the border walking to the
 * controller), which silently aborts that creep's logic and any creep after it
 * in the same loop. Padding the eight neighbours with empty terrain gives the
 * PathFinder something to read; creeps still have no targets out there, so they
 * never actually leave their room.
 */
export async function padNeighborTerrain(world: any, rooms: string[], radius = 1): Promise<void> {
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
  const empty = Array.from({ length: 50 }, () => ".".repeat(50));
  for (const name of needed) {
    await applyRoomLayout(world, { room: name, terrain: empty });
  }
}

// ---------------------------------------------------------------------------
// Node-network fixture conversion (test/fixtures/*.json)
// ---------------------------------------------------------------------------

interface NodeFixtureResource {
  type: string;
  position: { x: number; y: number };
  capacity?: number;
}

interface NodeFixtureNode {
  roomName: string;
  position?: { x: number; y: number };
  resourceNodes?: NodeFixtureResource[];
}

export interface NodeFixture {
  nodes: NodeFixtureNode[];
}

export interface FixtureLayout {
  /** Room layouts ready to pass to `loadLayout` (excludes spawn markers). */
  rooms: RoomLayout[];
  /**
   * Spawn positions found in the fixture. The engine creates a functional spawn
   * via `world.addBot`, not `addRoomObject`, so these are surfaced separately
   * for bot placement rather than placed as objects.
   */
  spawns: Array<{ room: string; x: number; y: number }>;
}

/**
 * Convert a node-network JSON fixture (as in test/fixtures/) into room layouts
 * plus the spawn positions it declares.
 */
export function layoutFromNodeFixture(fixture: NodeFixture): FixtureLayout {
  const byRoom = new Map<string, LayoutObject[]>();
  const spawns: Array<{ room: string; x: number; y: number }> = [];

  for (const node of fixture.nodes ?? []) {
    for (const resource of node.resourceNodes ?? []) {
      const { x, y } = resource.position;

      if (resource.type === "spawn") {
        spawns.push({ room: node.roomName, x, y });
        continue;
      }

      const obj: LayoutObject = { type: resource.type, x, y };
      if (resource.type === "source" && resource.capacity != null) {
        obj.attributes = { energy: resource.capacity, energyCapacity: resource.capacity };
      }

      const list = byRoom.get(node.roomName) ?? [];
      list.push(obj);
      byRoom.set(node.roomName, list);
    }
  }

  const rooms: RoomLayout[] = [...byRoom.entries()].map(([room, objects]) => ({ room, objects }));
  return { rooms, spawns };
}
