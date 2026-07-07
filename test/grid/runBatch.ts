/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * runBatch - stand up ONE mockup world for a packed batch of cells, tick it,
 * sample every undecided cell each tick, and return per-cell verdicts.
 *
 * Wall-clock economics: the engine costs ~233ms/tick flat + ~67ms/tick per
 * ACTIVE bot, so (a) N cells share one engine, and (b) the moment a cell's
 * verdict is decided its bot is retired (db.users active:0 - the driver's
 * getAllUsers only queues users with active != 0), so a 15-tick cell stops
 * costing anything in a 300-tick world. The world itself stops early once
 * every cell is decided.
 *
 * Terrain padding is radius 3 (not the usual 1): the bot's incremental
 * analysis sweeps a radius-3 room-name box around owned rooms and a room with
 * NO terrain data makes that whole analysis batch throw and get dropped -
 * possibly including the home room, which would produce node-less colonies
 * that fail cells for a harness reason, not a bot reason.
 */

import * as fs from "fs";
import { mkdirSync, readFileSync } from "fs";
import * as path from "path";
import { CellSample, CellVerdict } from "./GridCell";
import { CellJudge } from "./judge";
import { PackedBatch } from "./pack";
import { bulkPadTerrain } from "./bulkPad";
import { enableMods, loadLayout } from "../integration/loadLayout";
import { stageCell } from "./stage";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const DIST_MAIN_JS = "dist/main.js";
/** Consecutive unparsable-memory samples before a cell is declared ERROR. */
const MAX_MEMORY_ERRORS = 5;

export interface RunBatchOptions {
  port: number;
  /** Print each bot's console output, prefixed by cell id. */
  debug?: boolean;
  /** Progress callback per tick (for the CLI's status line). */
  onTick?(tick: number, undecided: number): void;
}

interface LiveCell {
  packed: PackedBatch["cells"][number];
  bot: any;
  userId: string;
  judge: CellJudge;
  memoryErrors: number;
  errorMessage?: string;
}

export async function runBatch(batch: PackedBatch, opts: RunBatchOptions): Promise<CellVerdict[]> {
  const serverPath = path.resolve("server", `grid-${opts.port}`);
  // rmSync exists on the Node 18 runtime; @types/node 13 (spec 05) predates it.
  (fs as any).rmSync(serverPath, { recursive: true, force: true });
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({
    port: opts.port,
    path: serverPath,
    logdir: path.join(serverPath, "logs"),
  });

  try {
    await server.world.reset();
    const mainJs = readFileSync(DIST_MAIN_JS).toString();

    // Build every cell's rooms, then pad the whole set to radius 3.
    for (const p of batch.cells) {
      for (const [handle, build] of Object.entries(p.cell.rooms)) {
        await loadLayout(server.world, build(p.rooms[handle]));
      }
    }
    await bulkPadTerrain(server, batch.allRooms, 3);

    // One bot per cell (username = cell id), then per-cell staging.
    const live: LiveCell[] = [];
    for (const p of batch.cells) {
      const botRoom = p.rooms[p.cell.bot.room ?? "home"];
      const bot = await server.world.addBot({
        username: p.cell.id,
        room: botRoom,
        x: p.cell.bot.x,
        y: p.cell.bot.y,
        ...(p.cell.bot.gcl ? { gcl: p.cell.bot.gcl } : {}),
        modules: { main: mainJs },
      });
      if (opts.debug) {
        bot.on("console", (logs: string[]) => {
          for (const line of logs ?? []) console.log(`[${p.cell.id}] ${line}`);
        });
      }
      live.push({ packed: p, bot, userId: bot.id, judge: new CellJudge(p.cell), memoryErrors: 0 });
    }
    for (const cell of live) {
      try {
        await stageCell(server, cell.packed.cell, cell.packed.rooms, cell.userId);
      } catch (e) {
        cell.errorMessage = `staging: ${e instanceof Error ? e.message : String(e)}`;
        cell.judge.error(0);
      }
    }

    if (batch.mods.length > 0) enableMods(serverPath, batch.mods);

    await server.start();
    const { db } = await server.world.load();

    const retire = (c: LiveCell) => db.users.update({ _id: c.userId }, { $set: { active: 0 } });
    for (const c of live) {
      if (c.judge.isDecided) await retire(c); // staging errors retire immediately
    }

    for (let tick = 1; tick <= batch.window; tick++) {
      const undecided = live.filter((c) => !c.judge.isDecided);
      if (undecided.length === 0) break;
      await server.tick();
      opts.onTick?.(tick, undecided.length);

      // Cache room-object queries per tick across cells.
      const roomCache = new Map<string, any[]>();
      const objectsIn = async (room: string): Promise<any[]> => {
        if (!roomCache.has(room)) roomCache.set(room, await server.world.roomObjects(room));
        return roomCache.get(room) as any[];
      };

      // Per-tick harness interventions (energy pins, one-shot triggers).
      for (const c of undecided) {
        if (!c.packed.cell.onTick) continue;
        try {
          await c.packed.cell.onTick({
            tick,
            db,
            userId: c.userId,
            room: (handle?: string) => {
              const name = c.packed.rooms[handle ?? "home"];
              if (!name) throw new Error(`no room handle "${handle}"`);
              return name;
            },
          });
        } catch (e) {
          c.errorMessage = `onTick: ${e instanceof Error ? e.message : String(e)}`;
          c.judge.error(tick);
          await retire(c);
        }
      }

      for (const c of undecided) {
        if (c.judge.isDecided) continue; // onTick may have errored the cell
        // Pre-fetch this cell's rooms so the sample's accessors are sync.
        const fetched: Record<string, any[]> = {};
        for (const [handle, room] of Object.entries(c.packed.rooms)) {
          fetched[handle] = await objectsIn(room);
        }

        let memory: any = {};
        try {
          memory = JSON.parse((await c.bot.memory) || "{}");
          c.memoryErrors = 0;
        } catch {
          c.memoryErrors += 1;
          if (c.memoryErrors > MAX_MEMORY_ERRORS) {
            c.errorMessage = `memory unparsable for ${c.memoryErrors} consecutive samples`;
            c.judge.error(tick);
            await retire(c);
            continue;
          }
        }

        const sample: CellSample = {
          tick,
          memory,
          userId: c.userId,
          room: (handle?: string) => {
            const name = c.packed.rooms[handle ?? "home"];
            if (!name) throw new Error(`no room handle "${handle}"`);
            return name;
          },
          objects: (handle?: string) => {
            const objs = fetched[handle ?? "home"];
            if (!objs) throw new Error(`no room handle "${handle}"`);
            return objs;
          },
          creep: (name: string, handle?: string) =>
            (fetched[handle ?? "home"] ?? []).find((o: any) => o.type === "creep" && o.name === name),
        };

        if (c.judge.observe(sample) !== null) await retire(c);
      }
    }

    return live.map((c) => {
      if (!c.judge.isDecided) c.judge.error(batch.window); // should be unreachable
      return c.judge.verdict(c.errorMessage);
    });
  } finally {
    try {
      await server.stop?.();
    } catch {
      /* teardown best-effort; the port/dir are per-run anyway */
    }
  }
}
