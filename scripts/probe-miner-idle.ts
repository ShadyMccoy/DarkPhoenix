/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * probe-miner-idle - look for miners/haulers standing away from their source.
 *
 * Runs twoSourceRcl3 (which places source-container construction sites) and, per
 * source, reports the nearest harvester's distance to the source and whether the
 * source has a miner adjacent + how much energy is piling up. A miner stuck far
 * from its source (not adjacent, not harvesting) is the bug we're hunting.
 *
 *   npx ts-node -P tsconfig.test.json scripts/probe-miner-idle.ts 300
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadScenario } from "../test/integration/scenario/Scenario";
import * as library from "../test/integration/scenario/library";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const cheby = (a: any, b: any) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

async function main(): Promise<void> {
  const ticks = parseInt(process.argv[2] ?? "300", 10);
  const port = 25714;
  const serverPath = path.resolve("server", String(port));
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();
  const mainJs = readFileSync("dist/main.js").toString();

  const scenario = (library as any)[process.argv[3] ?? "twoSourceRcl3"]();
  const room = scenario.bot.room;
  const { bot } = await loadScenario(server, scenario, mainJs);
  await server.start();

  const mem = async () => {
    try {
      return JSON.parse((await bot.memory) || "{}");
    } catch {
      return {};
    }
  };

  for (let t = 0; t < ticks; t++) {
    await server.tick();
    if (t % 30 !== 0 && t !== ticks - 1) continue;

    const objs = await server.world.roomObjects(room);
    const sources = objs.filter((o: any) => o.type === "source");
    const creeps = objs.filter((o: any) => o.type === "creep");
    const m = await mem();

    // Identify miners by memory.workType and report each one's distance to its
    // nearest source (whether it is adjacent = harvesting).
    const miners = creeps.filter((c: any) => m.creeps?.[c.name]?.workType === "harvest");
    const minerInfo = miners.map((c: any) => {
      const nearest = sources.map((s: any) => cheby(c, s)).sort((a: number, b: number) => a - b)[0];
      const mm = m.creeps?.[c.name] ?? {};
      const work = (c.body ?? []).filter((p: any) => (typeof p === "string" ? p : p.type) === "work").length;
      const corp = (mm.corpId ?? "?").slice(-6);
      return `${c.name.slice(-5)}@(${c.x},${c.y}) d=${nearest} W=${work} corp=${corp}${mm.recycling ? " REC" : ""}`;
    });
    console.log(`t=${String(t).padStart(4)} miners=${miners.length}\n   ${minerInfo.join("\n   ")}`);
  }

  await server.stop?.();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
