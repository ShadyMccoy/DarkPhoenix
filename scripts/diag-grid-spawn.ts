/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * diag-grid-spawn - one-off: why does the pinned-300 grid cell never spawn its
 * flow miner? Replicates spawn-no-hauler-before-miner's world and dumps spawn
 * store + creep roster + Memory.spawnDemandFirstSeen every 5 ticks.
 */

import { mkdirSync, readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import { RoomBuilder } from "../test/integration/scenario/RoomBuilder";
import { loadLayout } from "../test/integration/loadLayout";
import { bulkPadTerrain } from "../test/grid/bulkPad";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const PORT = 26950;
const ROOM = "W0N0";

async function main(): Promise<void> {
  const serverPath = path.resolve("server", `grid-diag-${PORT}`);
  (fs as any).rmSync(serverPath, { recursive: true, force: true });
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port: PORT, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();
  const room = new RoomBuilder(ROOM).border().controller(25, 8).source(25, 45).toRoom();
  await loadLayout(server.world, room);
  await bulkPadTerrain(server, [ROOM], 3);
  const bot = await server.world.addBot({
    username: "diag",
    room: ROOM,
    x: 25,
    y: 25,
    modules: { main: readFileSync("dist/main.js").toString() },
  });
  bot.on("console", (logs: string[]) => {
    for (const line of logs ?? []) if (/spawn|Spawn|hold|demand|miner/i.test(line)) console.log(`  [bot] ${line}`);
  });

  const { db } = await server.world.load();
  await db["rooms.objects"].update({ room: ROOM, type: "controller" }, { $set: { level: 2, progress: 0, safeMode: null } });

  await server.start();

  for (let t = 1; t <= 60; t++) {
    await server.tick();
    // The pin, as in the cell.
    await db["rooms.objects"].update({ room: ROOM, type: "spawn" }, { $set: { "store.energy": 300 } });

    if (t % 5 === 0) {
      const objs = await server.world.roomObjects(ROOM);
      const spawn = objs.find((o: any) => o.type === "spawn");
      const creeps = objs.filter((o: any) => o.type === "creep").map((o: any) => o.name);
      let mem: any = {};
      try {
        mem = JSON.parse((await bot.memory) || "{}");
      } catch {
        /* ignore */
      }
      const firstSeen = mem.spawnDemandFirstSeen ? Object.keys(mem.spawnDemandFirstSeen) : [];
      console.log(
        `t${t}: store=${spawn?.store?.energy} spawning=${JSON.stringify(spawn?.spawning) ?? "?"} creeps=[${creeps.join(",")}] demands=[${firstSeen.map((k: string) => k.split(":").slice(1).join(":")).join(" | ")}]`
      );
    }
  }

  await server.stop?.();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
