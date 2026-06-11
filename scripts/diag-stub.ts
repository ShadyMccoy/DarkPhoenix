#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * diag-stub - why do the stub-world budgeted corps produce nothing?
 *
 * Replicates sim-variance's setup (stub world, one bot at W0N1, free economy) and
 * prints, over time: controller level + progress, creeps by workType, and the
 * corpVariance rows. Reveals whether the colony reaches RCL2, whether the flow
 * miners/haulers ever spawn (bootstrap->flow hand-off), or whether it is stuck on
 * bootstrap jacks while the flow corps stay budgeted-but-unstaffed.
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { enableMods, FREE_ECONOMY_MOD } from "../test/integration/loadLayout";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

async function main(): Promise<void> {
  const port = 25800 + Math.floor(Math.random() * 500);
  const serverPath = path.resolve("server", `diag-${port}`);
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();
  await server.world.stubWorld();
  const player = await server.world.addBot({
    username: "player", room: "W0N1", x: 15, y: 15, modules: { main: readFileSync("dist/main.js").toString() }
  });
  // --paid keeps the real build/upgrade energy sinks (free economy is on by
  // default, to match sim-variance); used to isolate free-economy artifacts.
  if (!process.argv.includes("--paid")) enableMods(serverPath, [FREE_ECONOMY_MOD]);
  await server.start();

  for (let t = 1; t <= 1000; t += 1) {
    await server.tick();
    if (t % 100 !== 0) continue;

    let mem: any = {};
    try { mem = JSON.parse((await player.memory) || "{}"); } catch { /* ignore */ }
    const objs = await server.world.roomObjects("W0N1");
    const ctrl = objs.find((o: any) => o.type === "controller");
    const byType: Record<string, number> = {};
    for (const name in mem.creeps || {}) {
      const wt = mem.creeps[name].workType || "bootstrap";
      byType[wt] = (byType[wt] || 0) + 1;
    }
    const variance = (mem.corpVariance || []).map((r: any) => `${r.type} ${r.actual}/${r.budget}`).join(", ");
    const nodes = Object.keys(mem.nodes || {}).length;
    const corps =
      `harvest ${Object.keys(mem.harvestCorps || {}).length} haul ${Object.keys(mem.haulingCorps || {}).length} ` +
      `upgrade ${Object.keys(mem.upgradingCorps || {}).length} bootstrap ${Object.keys(mem.bootstrapCorps || {}).length}`;
    console.log(
      `t=${String(t).padStart(4)} RCL ${ctrl?.level} prog ${ctrl?.progress} | creeps ${JSON.stringify(byType)} | nodes ${nodes} | ${corps} | var [${variance}]`
    );
  }

  await server.stop();
  process.exit(0);
}

main().catch(e => { console.error("diag-stub failed:", e); process.exit(1); });
