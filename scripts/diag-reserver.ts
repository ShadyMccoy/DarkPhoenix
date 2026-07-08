/* eslint-disable @typescript-eslint/no-explicit-any */
/** diag-reserver - why does the reserver starve forever under contention? */
import { mkdirSync, readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import { RoomBuilder } from "../test/integration/scenario/RoomBuilder";
import { loadLayout } from "../test/integration/loadLayout";
import { bulkPadTerrain } from "../test/grid/bulkPad";
const { ScreepsServer } = require("screeps-server-mockup");

async function main(): Promise<void> {
  const serverPath = path.resolve("server", "grid-diag-27070");
  (fs as any).rmSync(serverPath, { recursive: true, force: true });
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port: 27070, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();
  const home = new RoomBuilder("W0N0").border().controller(25, 10).source(25, 40);
  for (let y = 24; y <= 26; y++) home.tile(49, y, "plain");
  const east = new RoomBuilder("E0N0").border().controller(10, 10).source(25, 25);
  for (let y = 24; y <= 26; y++) east.tile(0, y, "plain");
  await loadLayout(server.world, [home.toRoom(), east.toRoom()] as any);
  await bulkPadTerrain(server, ["W0N0", "E0N0"], 3);
  const bot = await server.world.addBot({ username: "diag", room: "W0N0", x: 25, y: 25, modules: { main: readFileSync("dist/main.js").toString() } });
  const { db } = await server.world.load();
  await db["rooms.objects"].update({ room: "W0N0", type: "controller" }, { $set: { level: 3, safeMode: null } });
  const EXT8 = [[23,23],[23,27],[27,23],[27,27],[22,25],[28,25],[24,22],[26,22]];
  for (const [x, y] of EXT8) {
    await db["rooms.objects"].insert({ room: "W0N0", type: "extension", x, y, user: bot.id, store: { energy: 0 }, storeCapacityResource: { energy: 50 }, hits: 1000, hitsMax: 1000, notifyWhenAttacked: true });
  }
  const gameTime = await server.world.gameTime;
  const mk = (name: string, room: string, x: number, y: number, body: string[]) =>
    db["rooms.objects"].insert({ type: "creep", name, x, y, room, user: bot.id, body: body.map((t) => ({ type: t, hits: 100 })), store: { energy: 0 }, storeCapacity: body.filter((t) => t === "carry").length * 50, hits: body.length * 100, hitsMax: body.length * 100, fatigue: 0, ageTime: gameTime + 1500, spawning: false, notifyWhenAttacked: true });
  void mk; // fully organic - no staged creeps (pipeline shape)
  bot.on("console", (logs: string[]) => {
    for (const line of logs ?? []) if (line.includes("DIAG]")) console.log(line);
  });
  await server.start();
  for (let t = 1; t <= 1200; t++) {
    await server.tick();
    if (t % 100 !== 0) continue;
    const o = await server.world.roomObjects("W0N0");
    const bank = o.filter((x: any) => x.type === "spawn" || x.type === "extension").reduce((s: number, x: any) => s + (x.store?.energy ?? 0), 0);
    let mem: any = {};
    try { mem = JSON.parse((await bot.memory) || "{}"); } catch {}
    const gt = gameTime + t;
    const seen = Object.entries(mem.spawnDemandFirstSeen ?? {}).map(([k, v]: [string, any]) => `${k.split(":").slice(1).join(":").slice(-24)}@${gt - v}`);
    const creeps = o.filter((x: any) => x.type === "creep").map((x: any) => x.name.slice(0, 10));
    console.log(`t${t}: bank=${bank} seen=[${seen.join(" ")}] creeps=[${creeps.join(",")}]`);
  }
  await server.stop?.();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
