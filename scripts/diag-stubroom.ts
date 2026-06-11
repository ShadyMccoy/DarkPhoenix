#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * diag-stubroom - run the stub world's W0N1 as a SINGLE room from RCL1.
 *
 * Isolates walls vs multi-room: the full stub world stalls (1 jack, 0 progress,
 * 102 nodes), a simple all-plain single room bootstraps fine. This loads ONLY
 * W0N1 (its real walled terrain + its sources/controller) as a lone room, so if
 * it stalls the walled home room is the cause; if it bootstraps, the 102-node
 * multi-room overload is.
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { padNeighborTerrain } from "../test/integration/loadLayout";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer, TerrainMatrix } = require("screeps-server-mockup");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stubRooms = require("screeps-server-mockup/assets/rooms.json");

async function main(): Promise<void> {
  const port = 26100 + Math.floor(Math.random() * 500);
  const serverPath = path.resolve("server", `stubroom-${port}`);
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();

  const room = "W0N1";
  const data = stubRooms[room];
  await server.world.addRoom(room);
  await server.world.setTerrain(room, TerrainMatrix.unserialize(data.serial));
  for (const o of data.objects) {
    if (o.type === "controller" || o.type === "source" || o.type === "mineral") {
      await server.world.addRoomObject(room, o.type, o.x, o.y, o.attributes);
    }
  }
  await padNeighborTerrain(server.world, [room]);

  // Spawn near the room's first source.
  const src = data.objects.find((o: any) => o.type === "source");
  const player = await server.world.addBot({
    username: "player", room, x: Math.min(48, src.x + 1), y: src.y,
    modules: { main: readFileSync("dist/main.js").toString() }
  });
  await server.start();

  console.log(`single W0N1: sources ${data.objects.filter((o:any)=>o.type==="source").map((o:any)=>o.x+","+o.y).join(" ")} controller ${data.objects.find((o:any)=>o.type==="controller") ? data.objects.find((o:any)=>o.type==="controller").x+","+data.objects.find((o:any)=>o.type==="controller").y : "?"}`);
  for (let t = 1; t <= 600; t += 1) {
    await server.tick();
    if (t % 75 !== 0) continue;
    let mem: any = {};
    try { mem = JSON.parse((await player.memory) || "{}"); } catch { /* ignore */ }
    const objs = await server.world.roomObjects(room);
    const ctrl = objs.find((o: any) => o.type === "controller");
    const byType: Record<string, number> = {};
    for (const name in mem.creeps || {}) {
      const wt = mem.creeps[name].workType || "bootstrap";
      byType[wt] = (byType[wt] || 0) + 1;
    }
    console.log(`t=${String(t).padStart(3)} RCL ${ctrl?.level} prog ${ctrl?.progress} | creeps ${JSON.stringify(byType)} | nodes ${Object.keys(mem.nodes || {}).length}`);
  }

  await server.stop();
  process.exit(0);
}

main().catch(e => { console.error("diag-stubroom failed:", e); process.exit(1); });
