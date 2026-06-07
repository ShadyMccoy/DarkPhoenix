/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Snapshot - capture a running mock world back into a self-contained Scenario.
 *
 * Run a colony to some interesting state (RCL 2 with a few extensions, a
 * stalled economy, whatever), call {@link exportSnapshot}, and you get a
 * Scenario you can save to disk and reload later with `loadScenario` - skipping
 * the slow bootstrap and replaying exactly that situation deterministically.
 *
 * Captured: terrain, sources/controller/mineral (as scenario objects), the
 * spawn position (for the bot), controller level/progress, built structures
 * (extensions/containers/towers/storage with stored energy), and bot Memory.
 * Live creeps are intentionally not captured - the bot re-derives them from
 * Memory + the flow economy on the next ticks.
 */

import { Scenario, ScenarioState } from "./Scenario";
import { ScenarioObject, ScenarioRoom, Tile } from "./RoomBuilder";

const SIZE = 50;
const TILE_CHAR: Record<Tile, string> = { plain: ".", wall: "#", swamp: "~" };

/** Object types that belong in scenario terrain (re-created on load). */
const SCENERY = new Set(["source", "controller", "mineral"]);
/** Built structures worth capturing as state (with stored energy). */
const BUILT = new Set(["extension", "container", "tower", "storage", "link"]);

export interface SnapshotOptions {
  name: string;
  description?: string;
  /** Rooms to capture (defaults to the bot's room). */
  rooms?: string[];
  username?: string;
}

export async function exportSnapshot(
  server: any,
  bot: any,
  opts: SnapshotOptions
): Promise<Scenario> {
  const roomNames = opts.rooms ?? (await botRooms(server, bot));

  const rooms: ScenarioRoom[] = [];
  const structures: ScenarioState["structures"] = [];
  const creeps: ScenarioState["creeps"] = [];
  const idMap: ScenarioState["idMap"] = [];
  let spawnPos: { room: string; x: number; y: number } | undefined;
  let controller: ScenarioState["controller"] | undefined;

  for (const room of roomNames) {
    const terrain = await readTerrain(server, room);
    const objs = await server.world.roomObjects(room);

    const scenery: ScenarioObject[] = [];
    for (const o of objs) {
      // Game-object ids change between worlds; record old id <-> position for the
      // fixed objects so Memory references can be remapped on reload.
      if ((SCENERY.has(o.type) || o.type === "spawn") && o._id) {
        idMap.push({ oldId: String(o._id), type: o.type, room, x: o.x, y: o.y });
      }
      if (SCENERY.has(o.type)) {
        scenery.push({ type: o.type, x: o.x, y: o.y });
      }
      if (o.type === "spawn" && !spawnPos) {
        spawnPos = { room, x: o.x, y: o.y };
      }
      if (o.type === "controller" && o.level) {
        controller = {
          level: o.level,
          progress: o.progress ?? 0,
          downgradeTime: o.downgradeTime ?? null,
        };
      }
      if (BUILT.has(o.type)) {
        structures.push({ room, type: o.type, x: o.x, y: o.y, energy: o.store?.energy ?? 0 });
      }
      if (o.type === "creep" && !o.spawning && o.name) {
        creeps.push({
          name: o.name,
          x: o.x,
          y: o.y,
          body: (o.body || []).map((p: any) => p.type),
          energy: o.store?.energy ?? 0,
        });
      }
    }

    rooms.push({ room, terrain, objects: scenery });
  }

  if (!spawnPos) {
    throw new Error("exportSnapshot: no spawn found - cannot place the bot on reload");
  }

  const memory = await readMemory(server, bot);

  return {
    name: opts.name,
    description: opts.description,
    rooms,
    bot: { room: spawnPos.room, x: spawnPos.x, y: spawnPos.y, username: opts.username },
    state: {
      controller,
      structures: structures.length > 0 ? structures : undefined,
      creeps: creeps.length > 0 ? creeps : undefined,
      idMap: idMap.length > 0 ? idMap : undefined,
      memory,
    },
  };
}

async function readTerrain(server: any, room: string): Promise<string[]> {
  const matrix = await server.world.getTerrain(room);
  const rows: string[] = [];
  for (let y = 0; y < SIZE; y++) {
    let row = "";
    for (let x = 0; x < SIZE; x++) {
      row += TILE_CHAR[(matrix.get(x, y) as Tile) ?? "plain"];
    }
    rows.push(row);
  }
  return rows;
}

async function readMemory(server: any, bot: any): Promise<unknown> {
  try {
    return JSON.parse((await bot.memory) || "{}");
  } catch {
    return {};
  }
}

async function botRooms(server: any, bot: any): Promise<string[]> {
  // The bot's rooms aren't directly enumerable here; fall back to any room that
  // has a controller owned by this bot.
  const { db } = await server.world.load();
  const owned = await db["rooms.objects"].find({ type: "controller", user: bot.id });
  return owned.map((c: any) => c.room);
}
