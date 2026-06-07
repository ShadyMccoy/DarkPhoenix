/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * startAtRcl - fast-iteration world setup that begins at a chosen RCL.
 *
 * The normal bootstrap from RCL 1 to RCL 2 takes ~600 ticks, which makes
 * iterating on the RCL 2+ flow economy painfully slow. This helper builds an
 * open room with a controller + sources, adds the bot, then bumps the
 * controller straight to the requested level so tests/probes can exercise the
 * flow economy almost immediately.
 *
 * Usage:
 *   const server = new ScreepsServer(...);
 *   await server.world.reset();
 *   const player = await startAtRcl(server, {
 *     room: "W0N0", level: 2, spawn: { x: 25, y: 25 },
 *     sources: [{ x: 10, y: 40 }, { x: 40, y: 40 }],
 *     controller: { x: 25, y: 10 }, mainModule,
 *   });
 */

import { loadLayout, padNeighborTerrain } from "./loadLayout";

export interface StartAtRclOptions {
  room: string;
  level: number;
  spawn: { x: number; y: number };
  sources: Array<{ x: number; y: number }>;
  controller: { x: number; y: number };
  /** Compiled bot main.js source. */
  mainModule: string;
  /** Optional controller progress to start with. */
  progress?: number;
}

export async function startAtRcl(server: any, opts: StartAtRclOptions): Promise<any> {
  await loadLayout(server.world, {
    room: opts.room,
    terrain: Array.from({ length: 50 }, () => ".".repeat(50)),
    objects: [
      { type: "controller", x: opts.controller.x, y: opts.controller.y },
      ...opts.sources.map((s) => ({ type: "source", x: s.x, y: s.y })),
    ],
  });
  // Pad neighbouring rooms so the native PathFinder never hits unloaded terrain
  // when a creep paths near the room edge.
  await padNeighborTerrain(server.world, [opts.room]);

  const player = await server.world.addBot({
    username: "player",
    room: opts.room,
    x: opts.spawn.x,
    y: opts.spawn.y,
    modules: { main: opts.mainModule },
  });

  // addBot forces the controller to level 1; bump it to the requested level.
  const { db } = await server.world.load();
  await db["rooms.objects"].update(
    { room: opts.room, type: "controller" },
    { $set: { level: opts.level, progress: opts.progress ?? 0, downgradeTime: null, safeMode: null } }
  );

  return player;
}
