/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * stage - inject a cell's staged state into a built (not yet started) world.
 *
 * Generalizes test/integration/scenario/Scenario.ts's applyState for the grid:
 * creeps can be placed in ANY of the cell's rooms (applyState only injects into
 * the bot's home room), Memory is composed from per-creep entries plus cell
 * extras, and "$id(handle,type,x,y)" tokens anywhere in the injected Memory are
 * resolved to the fresh game-object ids of the built world - the grid's
 * equivalent of Snapshot's idMap, needed because staged corp/creep memory must
 * reference real source/spawn/controller ids that only exist after the db
 * inserts.
 *
 * Structure schemas mirror applyState's hard-won gotchas: structures need
 * hits/hitsMax (missing/0 hits reads as destroyed and the engine purges the
 * object on the first tick), containers/storage are NEUTRAL and use a single
 * numeric storeCapacity, owned structures carry the user id and a per-resource
 * storeCapacityResource.
 */

import { GridCell } from "./GridCell";

const ID_TOKEN = /\$id\(([^,)]+),([^,)]+),(\d+),(\d+)\)/g;

/** Full hits for common structures (so the engine doesn't read them as destroyed). */
function structureHits(type: string): number {
  switch (type) {
    case "spawn":
      return 5000;
    case "extension":
      return 1000;
    case "container":
      return 250000;
    case "storage":
      return 10000;
    case "tower":
      return 3000;
    case "link":
      return 1000;
    case "road":
      return 5000;
    case "wall":
      return 1;
    default:
      return 1000;
  }
}

/** Energy capacity for common structures (RCL-independent approximations). */
function structureCapacity(type: string): number {
  switch (type) {
    case "extension":
      return 50;
    case "container":
      return 2000;
    case "storage":
      return 1000000;
    case "tower":
      return 1000;
    case "link":
      return 800; // errata: Scenario.ts lacks this case, so links were uninsertable
    default:
      return 0;
  }
}

/**
 * Stage one cell into the built world. `rooms` maps the cell's local handles to
 * packed room names; `userId` is the cell's bot id from addBot.
 */
export async function stageCell(
  server: any,
  cell: GridCell,
  rooms: Record<string, string>,
  userId: string
): Promise<void> {
  const { C, db } = await server.world.load();
  const room = (handle?: string): string => {
    const name = rooms[handle ?? "home"];
    if (!name) throw new Error(`grid stage: cell ${cell.id} has no room handle "${handle}"`);
    return name;
  };

  // Controller state. addBot leaves level 1 + safeMode 20000; the flow economy
  // needs RCL >= 2, and safe mode is cleared for uniformity with warm scenarios.
  if (cell.controller) {
    await db["rooms.objects"].update(
      { room: room(cell.bot.room), type: "controller" },
      {
        $set: {
          level: cell.controller.level,
          progress: cell.controller.progress ?? 0,
          downgradeTime: cell.controller.downgradeTime ?? null,
          safeMode: null,
        },
      }
    );
  }

  for (const s of cell.structures ?? []) {
    const neutral = s.type === "container" || s.type === "road" || s.type === "wall";
    const hits = structureHits(s.type);
    const doc: any = {
      room: room(s.room),
      type: s.type,
      x: s.x,
      y: s.y,
      hits,
      hitsMax: hits,
      notifyWhenAttacked: true,
    };
    if (!neutral) doc.user = userId;
    if (s.energy != null) {
      doc.store = { energy: s.energy };
      if (s.type === "container" || s.type === "storage") {
        doc.storeCapacity = structureCapacity(s.type);
      } else {
        doc.storeCapacityResource = { energy: structureCapacity(s.type) };
      }
    }
    await db["rooms.objects"].insert(doc);
  }

  const gameTime = await server.world.gameTime;
  const creepMemories: Record<string, unknown> = {};
  for (const cr of cell.creeps ?? []) {
    const body = cr.body.map((t) => ({ type: t, hits: 100 }));
    const carry = cr.body.filter((t) => t === "carry").length;
    await db["rooms.objects"].insert({
      type: "creep",
      name: cr.name,
      x: cr.x,
      y: cr.y,
      room: room(cr.room),
      user: userId,
      body,
      store: { energy: cr.energy ?? 0 },
      storeCapacity: carry * 50,
      hits: body.length * 100,
      hitsMax: body.length * 100,
      fatigue: 0,
      ageTime: gameTime + 1500,
      spawning: false,
      notifyWhenAttacked: true,
    });
    if (cr.memory) creepMemories[cr.name] = cr.memory;
  }

  // Compose + inject Memory: per-creep entries plus cell extras, with
  // "$id(handle,type,x,y)" tokens resolved against the freshly built db.
  const memory: Record<string, unknown> = { ...(cell.memory ?? {}) };
  if (Object.keys(creepMemories).length > 0) {
    memory.creeps = { ...(memory.creeps as object | undefined), ...creepMemories };
  }
  if (Object.keys(memory).length > 0) {
    const json = await resolveIdTokens(JSON.stringify(memory), db, room);
    const { env } = server.common.storage;
    await env.set(env.keys.MEMORY + userId, json);
  }

  if (cell.stage) {
    await cell.stage({ db, C, userId, room });
  }
}

/** Replace every "$id(handle,type,x,y)" with the object's fresh id. */
async function resolveIdTokens(
  json: string,
  db: any,
  room: (handle?: string) => string
): Promise<string> {
  const tokens: RegExpExecArray[] = [];
  ID_TOKEN.lastIndex = 0;
  for (let m = ID_TOKEN.exec(json); m; m = ID_TOKEN.exec(json)) tokens.push(m);
  let out = json;
  for (const m of tokens) {
    const [token, handle, type, x, y] = m;
    const obj = await db["rooms.objects"].findOne({
      room: room(handle.trim()),
      type: type.trim(),
      x: Number(x),
      y: Number(y),
    });
    if (!obj?._id) {
      throw new Error(`grid stage: no ${type.trim()} at (${x},${y}) in room "${handle.trim()}" for ${token}`);
    }
    out = out.split(token).join(String(obj._id));
  }
  return out;
}
