/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * diag-runt-stall (incident #18) - the cold-start stall basin: some draws of
 * the runt-economy world staff ONE 2-WORK miner and freeze (no second source,
 * no recycle, 1200t). Reproduces on the DEPLOYED build - pre-existing, draw
 * dependent (~4R/5G today). This harness stages the exact runt-economy world
 * and dumps the NOW-plan mirror every 25t: agenda queue heads + receipts,
 * spawn energy, miner/hauler census - the FIFO incident's method, scripted.
 * Run 2 draws back-to-back; a red draw's dump shows what the walk was doing
 * while the second source starved.
 */
import * as fs from "fs";
import { mkdirSync, readFileSync } from "fs";
import * as path from "path";
import { loadLayout, padNeighborTerrain, setRoomLevel, enableMods, FREE_ECONOMY_MOD } from "../test/integration/loadLayout";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

async function oneDraw(draw: number): Promise<void> {
  const port = 25795 + draw;
  const serverPath = path.resolve("server", `diag-stall-${port}`);
  (fs as any).rmSync(serverPath, { recursive: true, force: true });
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  try {
    await server.world.reset();
    const terrain = Array.from({ length: 50 }, (_v, y) => ".".repeat(25) + (y >= 23 && y <= 27 ? "." : "#") + ".".repeat(24));
    await loadLayout(server.world, {
      room: "W0N0",
      terrain,
      objects: [
        { type: "controller", x: 38, y: 25 },
        { type: "source", x: 10, y: 10 },
        { type: "source", x: 40, y: 40 }
      ]
    });
    await padNeighborTerrain(server.world, ["W0N0"]);
    const mainJs = readFileSync("dist/main.js").toString();
    const bot = await server.world.addBot({ username: `stall-${draw}`, room: "W0N0", x: 12, y: 25, modules: { main: mainJs } });
    const { db } = await server.world.load();
    await setRoomLevel(server.world, "W0N0", 2, [
      { x: 13, y: 24 }, { x: 11, y: 24 }, { x: 13, y: 26 }, { x: 11, y: 26 }, { x: 14, y: 25 }
    ]);
    enableMods(serverPath, [FREE_ECONOMY_MOD]);
    void db;

    await server.start();
    console.log(`\n########## DRAW ${draw} ##########`);
    for (let t = 1; t <= 1200; t++) {
      await server.tick();
      if (t % 25 !== 0) continue;
      const objs = await server.world.roomObjects("W0N0");
      const m = JSON.parse((await bot.memory) || "{}");
      const spawn = objs.find((o: any) => o.type === "spawn");
      const miners: string[] = [];
      const others: string[] = [];
      for (const o of objs) {
        if (o.type !== "creep") continue;
        const cm = m.creeps?.[o.name] ?? {};
        const w = (o.body || []).filter((p: any) => (p.type ?? p) === "work").length;
        const c = (o.body || []).filter((p: any) => (p.type ?? p) === "carry").length;
        const tag = `${(cm.workType ?? "?")[0]}${w}w${c}c${cm.recycling ? "*R*" : ""}`;
        if (cm.workType === "harvest") miners.push(tag);
        else others.push(tag);
      }
      const agenda = Object.values(m.spawnAgenda ?? {})[0] as any;
      const queue = (agenda?.queue ?? [])
        .slice(0, 4)
        .map((q: any) => `${q.role}@${q.minCost}${q.mustFund ? "!" : ""}${q.precondition ? `[${q.precondition}]` : ""}`)
        .join(" ");
      const exec = (agenda?.executed ?? []).slice(-2).map((e: any) => `${e.role}@${e.cost}t${e.tick % 10000}`).join(" ");
      console.log(
        `t${t} spawnE=${spawn?.store?.energy}${spawn?.spawning ? "(S)" : ""} miners[${miners.join(",")}] others[${others.join(",")}] Q[${queue}] X[${exec}]`
      );
    }
  } finally {
    await server.stop();
  }
}

async function main(): Promise<void> {
  await oneDraw(1);
  await oneDraw(2);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
