#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * diag-storage - why doesn't the RCL4 colony place its storage?
 *
 * Reproduces the storage-depot integration scenario (walled two-chamber room,
 * RCL4, full extension set, container depot pre-placed) and prints the bot's
 * [Construction] console lines plus periodic structure/site summaries.
 *
 *   npx ts-node -P tsconfig.test.json scripts/diag-storage.ts
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadLayout, padNeighborTerrain, setRoomLevel, enableMods, FREE_ECONOMY_MOD } from "../test/integration/loadLayout";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

async function main(): Promise<void> {
  const port = 26400 + Math.floor(Math.random() * 500);
  const serverPath = path.resolve("server", `diagst-${port}`);
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();
  const terrain = Array.from({ length: 50 }, (_v, y) =>
    ".".repeat(25) + (y >= 23 && y <= 27 ? "." : "#") + ".".repeat(24)
  );
  const extensions: Array<{ x: number; y: number }> = [];
  for (let x = 8; x <= 17; x += 1) extensions.push({ x, y: 21 }, { x, y: 22 });

  await loadLayout(server.world, {
    room: "W0N0",
    terrain,
    objects: [
      { type: "controller", x: 38, y: 25 },
      { type: "source", x: 10, y: 10 },
      { type: "source", x: 40, y: 40 },
      {
        type: "container",
        x: 13,
        y: 25,
        attributes: {
          store: { energy: 0 },
          storeCapacityResource: { energy: 2000 },
          hits: 250000,
          hitsMax: 250000
        }
      }
    ]
  });
  await padNeighborTerrain(server.world, ["W0N0"]);
  const player = await server.world.addBot({
    username: "player", room: "W0N0", x: 12, y: 25, modules: { main: readFileSync("dist/main.js").toString() }
  });
  await setRoomLevel(server.world, "W0N0", 4, extensions, true);
  enableMods(serverPath, [FREE_ECONOMY_MOD]);
  await server.start();

  player.on("console", (logs: string[], results: string[]) => {
    for (const line of logs || []) {
      if (/Construction|storage|Storage|PROBE/.test(line)) console.log(`   | ${line}`);
    }
    for (const line of results || []) console.log(`   |= ${line}`);
  });

  for (let t = 1; t <= 600; t += 1) {
    await server.tick();
    if (t === 100) {
      await player.console(
        `JSON.stringify({myStructExt: Game.rooms['W0N0'].find(FIND_MY_STRUCTURES, {filter: s => s.structureType === STRUCTURE_EXTENSION}).length, structExt: Game.rooms['W0N0'].find(FIND_STRUCTURES, {filter: s => s.structureType === STRUCTURE_EXTENSION}).length, cap: Game.rooms['W0N0'].energyCapacityAvailable, rcl: Game.rooms['W0N0'].controller.level})`
      );
    }
    if (t % 50 !== 0) continue;
    const objs = await server.world.roomObjects("W0N0");
    const ctrl = objs.find((o: any) => o.type === "controller");
    const sites = objs.filter((o: any) => o.type === "constructionSite").map((o: any) => `${o.structureType}@${o.x},${o.y}(${o.progress})`);
    const built = objs.filter((o: any) => ["container", "storage"].includes(o.type)).map((o: any) => `${o.type}@${o.x},${o.y}`);
    const exts = objs.filter((o: any) => o.type === "extension");
    const spawnObj = objs.find((o: any) => o.type === "spawn");
    const extUsers = new Set(exts.map((e: any) => e.user));
    console.log(`   ext count=${exts.length} users=${JSON.stringify([...extUsers])} spawnUser=${spawnObj?.user}`);
    let mem: any = {};
    try { mem = JSON.parse((await player.memory) || "{}"); } catch { /* ignore */ }
    const creeps: Record<string, number> = {};
    for (const name in mem.creeps || {}) {
      const wt = mem.creeps[name].workType || "jack";
      creeps[wt] = (creeps[wt] || 0) + 1;
    }
    console.log(`t=${String(t).padStart(3)} RCL ${ctrl?.level} | creeps ${JSON.stringify(creeps)} | sites [${sites.join(" ")}] | built [${built.join(" ")}]`);
  }

  await server.stop();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
