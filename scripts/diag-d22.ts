/* eslint-disable @typescript-eslint/no-explicit-any */
/** diag-d22 - why does the d=22 single-source loop never feed its controller? */
import { mkdirSync, readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import { RoomBuilder } from "../test/integration/scenario/RoomBuilder";
import { loadLayout } from "../test/integration/loadLayout";
import { bulkPadTerrain } from "../test/grid/bulkPad";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

async function main(): Promise<void> {
  const serverPath = path.resolve("server", "grid-diag-26970");
  (fs as any).rmSync(serverPath, { recursive: true, force: true });
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port: 26970, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();
  await loadLayout(server.world, new RoomBuilder("W0N0").border().controller(25, 10).source(25, 47).toRoom());
  await bulkPadTerrain(server, ["W0N0"], 3);
  const bot = await server.world.addBot({ username: "diag", room: "W0N0", x: 25, y: 25, modules: { main: readFileSync("dist/main.js").toString() } });
  const { db } = await server.world.load();
  await db["rooms.objects"].update({ room: "W0N0", type: "controller" }, { $set: { level: 2, progress: 0, safeMode: null } });
  await server.start();

  for (let t = 1; t <= 700; t++) {
    await server.tick();
    if (t % 40 !== 0) continue;
    const objs = await server.world.roomObjects("W0N0");
    const spawn = objs.find((o: any) => o.type === "spawn");
    const ctrl = objs.find((o: any) => o.type === "controller");
    let mem: any = {};
    try { mem = JSON.parse((await bot.memory) || "{}"); } catch { /* */ }
    const creeps = Object.entries(mem.creeps ?? {}).map(([n, m]: [string, any]) =>
      `${n.slice(0, 14)}(${m.workType?.[0] ?? "?"}${m.homeSink ? "/" + m.homeSink[0] : ""}${m.deliverSinkId ? ">" + m.deliverSinkId[0] : ""})`);
    const hauls = (mem.economyPlan?.corps ?? []).filter((c: any) => c.kind === "haul").map((c: any) => `${String(c.toId).split("-")[0]}:${c.carry}`);
    console.log(`t${t}: bank=${spawn?.store?.energy} prog=${ctrl?.progress} hauls=[${hauls.join(",")}] creeps=[${creeps.join(" ")}]`);
  }
  await server.stop?.();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
