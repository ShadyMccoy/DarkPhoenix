/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadScenario } from "../test/integration/scenario/Scenario";
import { threeChamberRcl2 } from "../test/integration/scenario/library";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

async function main(): Promise<void> {
  const ticks = Number(process.argv[2] ?? 150);
  const port = 25700;
  const serverPath = path.resolve("server", String(port));
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();
  const main = readFileSync("dist/main.js").toString();
  const { bot } = await loadScenario(server, threeChamberRcl2(), main);

  bot.on("console", (log: string[]) => {
    for (const line of log) {
      if (/Construction|Harvest|container|Container/.test(line)) console.log(`  bot> ${line}`);
    }
  });

  await server.start();
  for (let t = 1; t <= ticks; t++) {
    await server.tick();
    if (t % 30 === 0) {
      const objs = await server.world.roomObjects("W0N0");
      const sites = objs.filter((o: any) => o.type === "constructionSite");
      const conts = objs.filter((o: any) => o.type === "container");
      const spawn = objs.find((o: any) => o.type === "spawn");
      const m = JSON.parse((await bot.memory) || "{}");
      const creeps = objs
        .filter((o: any) => o.type === "creep")
        .map((c: any) => `${(m.creeps?.[c.name]?.workType ?? "?")}@(${c.x},${c.y})e${c.store?.energy ?? 0}`)
        .join(" ");
      console.log(`t${t} spawnE${spawn?.store?.energy} sites=[${sites.map((s: any) => `${s.structureType}@(${s.x},${s.y})${s.progress}/${s.progressTotal}`).join(" ")}] cont=${conts.length}`);
      console.log(`   creeps: ${creeps}`);
    }
  }
  await server.stop();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
