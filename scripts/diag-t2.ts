/* eslint-disable @typescript-eslint/no-explicit-any */
/** diag-t2 - two stubborn T2 cells: staged-builder repair + ring deposit. */
import { mkdirSync, readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import { RoomBuilder } from "../test/integration/scenario/RoomBuilder";
import { loadLayout } from "../test/integration/loadLayout";
import { bulkPadTerrain } from "../test/grid/bulkPad";
const { ScreepsServer } = require("screeps-server-mockup");

async function world(port: number, room: any, setup: (db: any, bot: any, env: any) => Promise<void>) {
  const serverPath = path.resolve("server", `grid-diag-${port}`);
  (fs as any).rmSync(serverPath, { recursive: true, force: true });
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();
  await loadLayout(server.world, room);
  await bulkPadTerrain(server, [room.room], 3);
  const bot = await server.world.addBot({ username: "diag", room: room.room, x: 25, y: 25, modules: { main: readFileSync("dist/main.js").toString() } });
  const { db } = await server.world.load();
  const { env } = server.common.storage;
  await setup(db, bot, env);
  await server.start();
  return { server, bot, db };
}

const creepDoc = (body: string[], name: string, x: number, y: number, room: string, user: string, energy = 0) => ({
  type: "creep", name, x, y, room, user,
  body: body.map((t) => ({ type: t, hits: 100 })),
  store: { energy }, storeCapacity: body.filter((t) => t === "carry").length * 50,
  hits: body.length * 100, hitsMax: body.length * 100, fatigue: 0, ageTime: 3000, spawning: false, notifyWhenAttacked: true,
});

async function repairDiag(): Promise<void> {
  console.log("=== REPAIR-STOPS DIAG (W0N0) ===");
  const R = "W0N0";
  const room = new RoomBuilder(R).border().controller(25, 10).source(15, 30).source(35, 30).toRoom();
  const { server, bot, db } = await world(27060, room, async (db2, bot2, env) => {
    await db2["rooms.objects"].update({ room: R, type: "controller" }, { $set: { level: 3, safeMode: null } });
    for (const c of [
      { x: 15, y: 29, energy: 1500, hits: 137500 },
      { x: 35, y: 29, energy: 0, hits: 250000 },
      { x: 24, y: 24, energy: 0, hits: 250000 },
      { x: 25, y: 12, energy: 0, hits: 250000 },
    ]) {
      await db2["rooms.objects"].insert({ room: R, type: "container", x: c.x, y: c.y, hits: c.hits, hitsMax: 250000, store: { energy: c.energy }, storeCapacity: 2000, notifyWhenAttacked: true });
    }
    const EXT = [[22,24],[28,24],[22,26],[28,26],[24,22],[26,22],[22,28],[28,28],[20,24],[30,24]];
    for (const [x, y] of EXT) {
      await db2["rooms.objects"].insert({ room: R, type: "extension", x, y, user: bot2.id, store: { energy: 50 }, storeCapacityResource: { energy: 50 }, hits: 1000, hitsMax: 1000, notifyWhenAttacked: true });
    }
    await db2["rooms.objects"].insert(creepDoc(["work","work","work","work","work","work","work","work","work","work","carry","carry","carry","carry","move","move"], "b1", 15, 28, R, bot2.id, 200));
    await db2["rooms.objects"].insert(creepDoc(["carry","move"], "decoy", 20, 20, R, bot2.id, 0));
    await db2["rooms.objects"].insert(creepDoc(["move"], "filler1", 19, 20, R, bot2.id, 0));
    await db2["rooms.objects"].insert(creepDoc(["move"], "filler2", 19, 21, R, bot2.id, 0));
    await env.set(env.keys.MEMORY + bot2.id, JSON.stringify({ creeps: { b1: { workType: "build", corpId: `building-${R}-construction`, working: true }, decoy: { workType: "haul" } } }));
  });
  for (let t = 1; t <= 80; t++) {
    await server.tick();
    if (t % 5 !== 0) continue;
    const objs = await server.world.roomObjects(R);
    const a = objs.find((o: any) => o.type === "container" && o.x === 15 && o.y === 29);
    const b1 = objs.find((o: any) => o.type === "creep" && o.name === "b1");
    let mem: any = {};
    try { mem = JSON.parse((await bot.memory) || "{}"); } catch {}
    console.log(`t${t}: A.hits=${a?.hits} b1=${b1 ? `@${b1.x},${b1.y} e${b1.store?.energy}` : "GONE"} corpId=${mem.creeps?.b1?.corpId} recycling=${mem.creeps?.b1?.recycling} orphaned=${mem.creeps?.b1?.orphanedSince}`);
  }
  await server.stop?.();
}

async function ringDiag(): Promise<void> {
  console.log("=== RING-DEPOSIT DIAG (W0N0) ===");
  const R = "W0N0";
  const b = new RoomBuilder(R).rect(23, 6, 27, 14, "wall").border();
  for (let y = 6; y <= 13; y++) b.tile(25, y, "plain");
  const room = b.controller(25, 10).source(25, 40).toRoom();
  const { server, bot, db } = await world(27061, room, async (db2, bot2, env) => {
    await db2["rooms.objects"].update({ room: R, type: "controller" }, { $set: { level: 2, safeMode: null } });
    const src = await db2["rooms.objects"].findOne({ room: R, type: "source" });
    await db2["rooms.objects"].insert(creepDoc(["work","carry","move"], "u1", 25, 7, R, bot2.id, 50));
    await db2["rooms.objects"].insert(creepDoc(["work","carry","move"], "u2", 25, 9, R, bot2.id, 50));
    await db2["rooms.objects"].insert(creepDoc(["carry","carry","move","move"], "h1", 25, 20, R, bot2.id, 100));
    await env.set(env.keys.MEMORY + bot2.id, JSON.stringify({ creeps: {
      u1: { workType: "upgrade", corpId: "sr1", working: true, upgradeSpot: { x: 25, y: 7 } },
      u2: { workType: "upgrade", corpId: "sr2", working: true, upgradeSpot: { x: 25, y: 9 } },
      h1: { workType: "haul", corpId: "srh", working: true, homeSink: "controller", deliverSinkId: "controller", assignedSourceId: src._id },
    } }));
  });
  for (let t = 1; t <= 90; t++) {
    await server.tick();
    if (t % 5 !== 0) continue;
    const objs = await server.world.roomObjects(R);
    const pos = (n: string) => { const c = objs.find((o: any) => o.type === "creep" && o.name === n); return c ? `@${c.x},${c.y} e${c.store?.energy}` : "GONE"; };
    let mem: any = {};
    try { mem = JSON.parse((await bot.memory) || "{}"); } catch {}
    console.log(`t${t}: h1${pos("h1")} d=${mem.creeps?.h1?.deliverSinkId} u1${pos("u1")} u2${pos("u2")}`);
  }
  await server.stop?.();
}

async function main(): Promise<void> {
  await repairDiag();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
