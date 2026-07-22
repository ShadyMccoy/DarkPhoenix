/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * diag-concurrent - instrument the red third assert of
 * cons-t3-build-and-repair-concurrent (site progress never >500, no 6th
 * extension, 400t). Two theories spent (last-builder steal: fixed, assert
 * calibration: fixed) - per the audit method the next step is a MEASUREMENT
 * of what the build crew actually does, not a third theory.
 *
 * Dumps every 20t: sites+progress, extension count, container A, every
 * creep's role/workType/repairDetail/pos/energy, spawn state, and the
 * building corp's memory (members, lastSizing).
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
  const cell = buildConstructionT2Cells().find((c) => c.id === "cons-t3-build-and-repair-concurrent");
  if (!cell) throw new Error("cell not found");
  const batch = packBatch([cell]);
  const port = 25790;
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
        if (/[Cc]onstruction|[Bb]uild|[Rr]epair|DetailDiag/.test(line)) console.log(`  bot> ${line}`);
      }
    });

    await server.start();
    const window = (p.cell as any).window ?? 400;
    for (let t = 1; t <= window; t++) {
      await server.tick();
      if (t % 20 !== 0) continue;
      const objs = await server.world.roomObjects(botRoom);
      const sites = objs.filter((o: any) => o.type === "constructionSite");
      const exts = objs.filter((o: any) => o.type === "extension");
      const contA = objs.find((o: any) => o.type === "container" && o.x === 15 && o.y === 29);
      const spawn = objs.find((o: any) => o.type === "spawn");
      const m = JSON.parse((await bot.memory) || "{}");
      const creeps = objs
        .filter((o: any) => o.type === "creep")
        .map((c: any) => {
          const cm = m.creeps?.[c.name] ?? {};
          const parts = (c.body ?? []).reduce((acc: any, b: any) => {
            acc[b.type] = (acc[b.type] ?? 0) + 1;
            return acc;
          }, {});
          const bodyStr = Object.entries(parts).map(([k, v]) => `${String(k)[0]}${v}`).join("");
          return `${cm.role ?? "?"}${cm.repairDetail ? "*RD*" : ""}/${cm.workType ?? "-"}@(${c.x},${c.y})e${c.store?.energy ?? 0}[${bodyStr}]`;
        })
        .join("  ");
      const corpIds = Object.keys(m.corps ?? {});
      const buildCorp = corpIds.filter((k) => /build|construction/i.test(k)).map((k) => {
        const cm = m.corps[k] ?? {};
        return `${k}: members=${JSON.stringify(cm.members ?? cm.memberNames ?? null)} lastSizing=${JSON.stringify(cm.lastSizing ?? null)}`;
      });
      console.log(
        `t${t} spawnE=${spawn?.store?.energy}${spawn?.spawning ? "(spawning)" : ""} sites=[${sites
          .map((s: any) => `${s.structureType}@(${s.x},${s.y})${s.progress}/${s.progressTotal}`)
          .join(" ")}] ext=${exts.length} contA=${contA?.hits}`
      );
      console.log(`   creeps: ${creeps}`);
      for (const line of buildCorp) console.log(`   corp: ${line}`);
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
