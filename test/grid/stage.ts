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

// =============================================================================
// THE STAGING VOCABULARY (spec 61 row 5) - the mockup-db traps, made unwritable
// =============================================================================
// Three staging mistakes have each cost a debugging session (CLAUDE.md trap
// list, "Grid staging"): the mockup db's $set with dotted paths silently
// NO-OPS, staged storage needs the OWNED schema, and addBot's `gcl` is POINTS
// not level. Each gets a helper here that makes the mistake a thrown error or
// an unwritable unit mismatch; test/unit/grid/stage.test.ts pins the helpers
// AND cops the cell sources for raw dotted-$set payloads.

/** Engine GCL curve constants (screeps: level = floor((points/MULT)^(1/POW)) + 1). */
const GCL_POW = 2.4;
const GCL_MULTIPLY = 1_000_000;

/**
 * The POINTS addBot's `gcl` field needs for a bot to sit at GCL `level` -
 * the minimal such value, so `gcl: gclPoints(2)` reads as the level it means
 * and the points-vs-level unit mismatch (1e6 = GCL 2, not "level 1e6") is
 * unwritable.
 */
export function gclPoints(level: number): number {
  if (!Number.isInteger(level) || level < 1) {
    throw new Error(`gclPoints: GCL level must be a positive integer, got ${level}`);
  }
  return Math.ceil(Math.pow(level - 1, GCL_POW) * GCL_MULTIPLY);
}

/**
 * Refuse a $set patch whose top-level keys are mongo dotted paths: the mockup
 * db layer silently NO-OPS them ("store.energy" updates nothing, no error),
 * which has produced false-red cells staged against state that never landed.
 * Write whole objects ({ store: { energy: N } }); nested keys are literal keys
 * and stay legal.
 */
export function assertWholeObjectPatch(patch: Record<string, unknown>): void {
  for (const key of Object.keys(patch)) {
    if (key.includes(".")) {
      throw new Error(
        `grid stage: $set key "${key}" is a dotted path - the mockup db silently no-ops these. ` +
          `Write the whole object instead (e.g. { store: { energy: N } }); see CLAUDE.md "Grid staging".`
      );
    }
  }
}

/**
 * The one sanctioned spelling of a staged db update: $set with a
 * whole-object patch, dotted paths refused before they can no-op.
 * `query` is a rooms.objects filter (or an _id string).
 */
export async function dbPatch(
  db: any,
  query: string | Record<string, unknown>,
  patch: Record<string, unknown>,
  collection = "rooms.objects"
): Promise<void> {
  assertWholeObjectPatch(patch);
  await db[collection].update(typeof query === "string" ? { _id: query } : query, { $set: patch });
}

/**
 * A staged storage document in the OWNED schema, complete - user id plus the
 * flat storeCapacity the engine's transfer paths read (a neutral or
 * partially-schema'd storage stages fine and then breaks link-haul pricing /
 * deposit paths invisibly). Spread extra fields onto the result if a cell
 * needs overrides; the schema core cannot be mis-assembled.
 */
export function stagedStorage(
  room: string,
  energy: number,
  user: string
): {
  room: string;
  type: "storage";
  x?: number;
  y?: number;
  user: string;
  store: { energy: number };
  storeCapacity: number;
  hits: number;
  hitsMax: number;
  notifyWhenAttacked: boolean;
} {
  return {
    room,
    type: "storage",
    user,
    store: { energy },
    storeCapacity: structureCapacity("storage"),
    hits: structureHits("storage"),
    hitsMax: structureHits("storage"),
    notifyWhenAttacked: true,
  };
}

/**
 * Harness refusal (spec 61 row 6): a cell staging an ARMED CpuGovernor
 * couples its verdict to HOST load - the mockup meters real CPU against a
 * real bucket, so one full grid run drained heavy worlds' buckets, paused
 * construction colony-wide, and failed six baseline-green cells. A governor
 * test that means it declares `expectsGovernor: true`; anything else is
 * refused at staging, before a tick runs.
 */
export function armedGovernorError(cell: GridCell): string | null {
  const armed = (cell.memory as { cpuGovernor?: unknown } | undefined)?.cpuGovernor === "on";
  if (!armed || cell.expectsGovernor) return null;
  return (
    `cell ${cell.id} stages Memory.cpuGovernor = "on" without expectsGovernor: true - an armed ` +
    `governor couples the cell's verdict to HOST load (a full grid run drained heavy worlds' ` +
    `buckets and failed six baseline-green cells). Declare expectsGovernor: true only if the ` +
    `governor itself is under test; see CLAUDE.md "CPU governor is DRY-RUN by default".`
  );
}

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
    case "terminal":
      return 3000;
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
    case "terminal":
      return 300000; // TERMINAL_CAPACITY
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
  const governorError = armedGovernorError(cell);
  if (governorError) throw new Error(governorError);

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
    // Storage stays OWNED: the neutral schema broke link-haul pricing
    // (detectLinkHaulPositions needs the owned storage) without fixing the
    // bank cell, whose real confound was the tender withdraw race.
    const neutral = s.type === "container" || s.type === "road" || s.type === "wall";
    const fullHits = structureHits(s.type);
    const doc: any = {
      room: room(s.room),
      type: s.type,
      x: s.x,
      y: s.y,
      hits: s.hits ?? fullHits,
      hitsMax: fullHits,
      notifyWhenAttacked: true,
    };
    if (!neutral) doc.user = userId;
    if (s.energy != null) {
      doc.store = { energy: s.energy };
      // Terminals join the FLAT-capacity branch: the engine's market transfer
      // reads the scalar `storeCapacity` for destination free space (probe
      // 2026-08-06: a storeCapacityResource-only terminal computes NaN free
      // space and every inbound send silently no-ops).
      if (s.type === "container" || s.type === "storage" || s.type === "terminal") {
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
  // "$id(handle,type,x,y)" and "$room(handle)" tokens (in values AND keys)
  // resolved against the freshly built world.
  const memory: Record<string, unknown> = { ...(cell.memory ?? {}) };
  if (Object.keys(creepMemories).length > 0) {
    memory.creeps = { ...(memory.creeps as object | undefined), ...creepMemories };
  }
  if (Object.keys(memory).length > 0) {
    let json = JSON.stringify(memory);
    json = json.replace(/\$room\(([^)]*)\)/g, (_, h) => room(h.trim() || undefined));
    json = await resolveIdTokens(json, db, room);
    const { env } = server.common.storage;
    await env.set(env.keys.MEMORY + userId, json);
  }

  if (cell.stage) {
    await cell.stage({ db, C, userId, room, gameTime });
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
