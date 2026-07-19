/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * diag-repair-latch (incident #20) - cons-repair-stops-at-99 times out on the
 * deployed build (6/6 red, was baselined pass). The cell needs the staged
 * 10-WORK builder to drive container A (55%) to >=240000. Dumps every 10t:
 * b1's repairDetail flag + repairTargetId + pos, and every container's hits -
 * so we see whether b1 LATCHES on A (repairs it to the ceiling) or ROTATES
 * across the decaying full containers (A never finishes).
 */
import * as fs from "fs";
import { mkdirSync, readFileSync } from "fs";
import * as path from "path";
import { packBatch } from "../test/grid/pack";
import { bulkPadTerrain } from "../test/grid/bulkPad";
import { enableMods, loadLayout } from "../test/integration/loadLayout";
import { stageCell } from "../test/grid/stage";
import { buildConstructionT2Cells } from "../test/grid/cells/construction";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

async function main(): Promise<void> {
  const cell = buildConstructionT2Cells().find((c) => c.id === "cons-repair-stops-at-99");
  if (!cell) throw new Error("cell not found");
  const batch = packBatch([cell]);
  const port = 25791;
  const serverPath = path.resolve("server", `diag-${port}`);
  (fs as any).rmSync(serverPath, { recursive: true, force: true });
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  try {
    await server.world.reset();
    const mainJs = readFileSync("dist/main.js").toString();
    const p = batch.cells[0];
    for (const [handle, build] of Object.entries(p.cell.rooms)) {
      await loadLayout(server.world, build(p.rooms[handle]));
    }
    await bulkPadTerrain(server, batch.allRooms, 3);
    const botRoom = p.rooms[p.cell.bot.room ?? "home"];
    const bot = await server.world.addBot({
      username: p.cell.id,
      room: botRoom,
      x: p.cell.bot.x,
      y: p.cell.bot.y,
      modules: { main: mainJs },
    });
    await stageCell(server, p.cell, p.rooms, bot.id);
    if (batch.mods.length > 0) enableMods(serverPath, batch.mods);

    bot.on("console", (logs: string[]) => {
      for (const line of logs ?? []) {
        if (/[Rr]epair|[Mm]aintenance|[Rr]ecycl|[Dd]etail/.test(line)) console.log(`  bot> ${line}`);
      }
    });

    await server.start();
    const window = (p.cell as any).window ?? 230;
    for (let t = 1; t <= window; t++) {
      await server.tick();
      if (t % 10 !== 0) continue;
      const objs = await server.world.roomObjects(botRoom);
      const m = JSON.parse((await bot.memory) || "{}");
      const conts = objs
        .filter((o: any) => o.type === "container")
        .map((o: any) => `(${o.x},${o.y})=${o.hits}`)
        .join(" ");
      const b1 = objs.find((o: any) => o.type === "creep" && o.name === "b1");
      const bm = m.creeps?.b1 ?? {};
      const others = objs
        .filter((o: any) => o.type === "creep" && o.name !== "b1")
        .map((o: any) => `${(m.creeps?.[o.name]?.workType ?? "?")}@(${o.x},${o.y})`)
        .join(" ");
      console.log(
        `t${t} A=${objs.find((o: any) => o.type === "container" && o.x === 15 && o.y === 29)?.hits} | conts[${conts}]`
      );
      console.log(
        `   b1 ${b1 ? `@(${b1.x},${b1.y})e${b1.store?.energy ?? 0}` : "GONE"} detail=${bm.repairDetail} target=${bm.repairTargetId ?? bm.repairTarget ?? "-"} recycling=${bm.recycling} work=${bm.workType} | others[${others}]`
      );
    }
  } finally {
    await server.stop();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
