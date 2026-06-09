/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * probe-plan - validate EconomyPlanner against the real 3-node world.
 *
 * Loads the fast RCL2 three-chamber scenario, runs it, and dumps the corp
 * roster the planner produces from live data (Memory.economyPlan) alongside the
 * controller's progress - so we can sanity-check the strategic layer's output
 * before it drives any corp.
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadScenario } from "../test/integration/scenario/Scenario";
import { threeChamberRcl2 } from "../test/integration/scenario/library";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

async function mem(bot: any): Promise<any> {
  try {
    return JSON.parse((await bot.memory) || "{}");
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const ticks = Number(process.argv[2] ?? 200);
  const port = 25500;
  const serverPath = path.resolve("server", String(port));
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();
  const main = readFileSync("dist/main.js").toString();
  const { bot } = await loadScenario(server, threeChamberRcl2(), main);
  await server.start();

  for (let t = 1; t <= ticks; t++) {
    await server.tick();
    if (t % 50 !== 0 && t !== ticks) continue;

    const m = await mem(bot);
    const objs = await server.world.roomObjects("W0N0");
    const ctrl = objs.find((o: any) => o.type === "controller");
    const plan = m.economyPlan;
    console.log(`\n== t${t}  R${ctrl?.level} prog${ctrl?.progress}  exts=${objs.filter((o: any) => o.type === "extension").length} ==`);
    if (!plan) {
      console.log("  (no economyPlan in memory yet)");
      continue;
    }
    console.log(`  overhead=${plan.overhead}  unrouted=${plan.unrouted}`);
    for (const c of plan.corps ?? []) {
      if (c.kind === "mine") console.log(`  mine    work=${c.work}  src=${short(c.sourceId)}`);
      else if (c.kind === "haul") console.log(`  haul    carry=${c.carry}  ${short(c.fromId)} -> ${short(c.toId)}`);
      else if (c.kind === "build") console.log(`  build   work=${c.work}  site=${short(c.sinkId)}`);
      else if (c.kind === "upgrade") console.log(`  upgrade work=${c.work}  ctrl=${short(c.sinkId)}`);
    }
  }

  await server.stop();
  process.exit(0);
}

function short(id: string): string {
  return id.length > 14 ? id.slice(0, 6) + "…" + id.slice(-4) : id;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
