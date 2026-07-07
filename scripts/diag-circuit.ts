/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * diag-circuit - why does the controller circuit never deliver? Replicates the
 * grid's haul-t1-circuit-split staging and dumps, per 5 ticks: each hauler's
 * homeSink/deliverSinkId/store/position, spawn store, and controller progress.
 * Hypothesis under test: spawnNetworkCritical (<50% fill) overrides the
 * controller-homed hauler's trip destination EVERY trip because organic
 * spawning keeps the bank low - so the solver's controller allocation is
 * never physically delivered.
 */

import { mkdirSync, readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import { RoomBuilder } from "../test/integration/scenario/RoomBuilder";
import { loadLayout } from "../test/integration/loadLayout";
import { bulkPadTerrain } from "../test/grid/bulkPad";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const PORT = 26960;
const ROOM = "W0N0";

async function main(): Promise<void> {
  const serverPath = path.resolve("server", `grid-diag-${PORT}`);
  (fs as any).rmSync(serverPath, { recursive: true, force: true });
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port: PORT, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();
  await loadLayout(server.world, new RoomBuilder(ROOM).border().controller(25, 8).source(25, 42).toRoom());
  await bulkPadTerrain(server, [ROOM], 3);
  const bot = await server.world.addBot({
    username: "diag",
    room: ROOM,
    x: 25,
    y: 25,
    modules: { main: readFileSync("dist/main.js").toString() },
  });

  const { db } = await server.world.load();
  await db["rooms.objects"].update({ room: ROOM, type: "controller" }, { $set: { level: 2, progress: 0, safeMode: null } });
  const src = await db["rooms.objects"].findOne({ room: ROOM, type: "source" });
  await db["rooms.objects"].insert({
    room: ROOM, type: "container", x: 24, y: 41, hits: 250000, hitsMax: 250000,
    store: { energy: 1500 }, storeCapacity: 2000, notifyWhenAttacked: true,
  });
  const gameTime = await server.world.gameTime;
  const mkCreep = (name: string, x: number, y: number, body: string[]) =>
    db["rooms.objects"].insert({
      type: "creep", name, x, y, room: ROOM, user: bot.id,
      body: body.map((t) => ({ type: t, hits: 100 })),
      store: { energy: 0 }, storeCapacity: body.filter((t) => t === "carry").length * 50,
      hits: body.length * 100, hitsMax: body.length * 100, fatigue: 0,
      ageTime: gameTime + 1500, spawning: false, notifyWhenAttacked: true,
    });
  await mkCreep("m1", 24, 41, ["work", "work", "work", "work", "work", "move", "move", "move"]);
  for (let i = 0; i < 3; i++) await mkCreep(`h${i + 1}`, 25, 27 + i, ["carry", "carry", "carry", "carry", "move", "move", "move", "move"]);
  const memory: any = {
    creeps: {
      m1: { workType: "harvest", corpId: "staged-m", assignedSourceId: src._id },
      h1: { workType: "haul", corpId: "staged-h1", working: false, assignedSourceId: src._id },
      h2: { workType: "haul", corpId: "staged-h2", working: false, assignedSourceId: src._id },
      h3: { workType: "haul", corpId: "staged-h3", working: false, assignedSourceId: src._id },
    },
  };
  const { env } = server.common.storage;
  await env.set(env.keys.MEMORY + bot.id, JSON.stringify(memory));

  await server.start();

  for (let t = 1; t <= 120; t++) {
    await server.tick();
    if (t % 5 !== 0) continue;
    const objs = await server.world.roomObjects(ROOM);
    const spawn = objs.find((o: any) => o.type === "spawn");
    const ctrl = objs.find((o: any) => o.type === "controller");
    let mem: any = {};
    try {
      mem = JSON.parse((await bot.memory) || "{}");
    } catch { /* ignore */ }
    const hs = ["h1", "h2", "h3"]
      .map((n) => {
        const doc = objs.find((o: any) => o.type === "creep" && o.name === n);
        const m = mem.creeps?.[n] ?? {};
        return `${n}[${m.homeSink ?? "-"}→${m.deliverSinkId ?? "-"} e${doc?.store?.energy ?? "?"} @${doc?.x},${doc?.y}]`;
      })
      .join(" ");
    console.log(`t${t}: spawn=${spawn?.store?.energy} ctrlProg=${ctrl?.progress} ${hs}`);
  }

  await server.stop?.();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
