/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadScenario } from "../test/integration/scenario/Scenario";
import * as library from "../test/integration/scenario/library";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");
(async () => {
  const port = 25715; const sp = path.resolve("server", String(port));
  mkdirSync(path.join(sp, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: sp, logdir: path.join(sp, "logs") });
  await server.world.reset();
  const mainJs = readFileSync("dist/main.js").toString();
  const scenario = (library as any)[process.argv[2] ?? "threeChamberRcl2"]();
  const { bot } = await loadScenario(server, scenario, mainJs);
  await server.start();
  for (let t = 0; t < 360; t++) {
    await server.tick();
    if (t % 60 !== 0 && t !== 359) continue;
    const m = JSON.parse((await bot.memory) || "{}");
    const wt: Record<string, number> = {};
    for (const n in (m.creeps ?? {})) { const w = m.creeps[n].workType ?? "?"; wt[w] = (wt[w] ?? 0) + 1; }
    console.log(`t=${t}  workTypes=${JSON.stringify(wt)}  haulingCorps=${Object.keys(m.haulingCorps ?? {}).length}  bootstrapJacks=${Object.values(m.bootstrapCorps ?? {}).reduce((a:number,b:any)=>a+((b.creepNames??[]).length),0)}`);
  }
  await server.stop?.(); process.exit(0);
})();
