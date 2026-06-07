/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * snapshot - capture a mid-game state once, then iterate on it fast.
 *
 *   npm run snapshot -- gen twoSource 1400 server/snaps/two.json
 *       run a scenario to tick N, capture a full snapshot (terrain, structures,
 *       creeps, memory) to a file.
 *
 *   npm run snapshot -- run server/snaps/two.json 800
 *       reload that snapshot and run it, with instrumentation: per sample it
 *       prints RCL/cp, structures, spawn energy, creeps by role, and the
 *       planner's budget (overhead + WORK it commissioned) so you can see at a
 *       glance whether execution is matching the plan.
 */
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import { loadScenario } from "../test/integration/scenario/Scenario";
import { exportSnapshot } from "../test/integration/scenario/Snapshot";
import * as library from "../test/integration/scenario/library";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const RCL_TOTALS = [0, 200, 45200, 180200, 585200, 1395200, 3405200, 10405200];
const cp = (level: number, prog: number): number => (RCL_TOTALS[level - 1] ?? 0) + prog;

async function freshServer(port: number): Promise<any> {
  const serverPath = path.resolve("server", String(port));
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();
  return server;
}

async function mem(bot: any): Promise<any> {
  try {
    return JSON.parse((await bot.memory) || "{}");
  } catch {
    return {};
  }
}

async function gen(scenarioName: string, ticks: number, outFile: string): Promise<void> {
  const factory = (library as any)[scenarioName];
  if (typeof factory !== "function") throw new Error(`unknown scenario ${scenarioName}`);
  const server = await freshServer(25800);
  const main = readFileSync("dist/main.js").toString();
  const scenario = factory();
  const { bot } = await loadScenario(server, scenario, main);
  await server.start();
  for (let t = 0; t < ticks; t++) await server.tick();
  const snap = await exportSnapshot(server, bot, { name: `${scenarioName}-t${ticks}`, username: "player" });
  await server.stop();
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(snap, null, 2));
  const nCreeps = snap.state?.creeps?.length ?? 0;
  console.log(`captured ${scenarioName} @t${ticks} -> ${outFile} (${nCreeps} creeps)`);
}

async function run(file: string, ticks: number): Promise<void> {
  const snap = JSON.parse(readFileSync(file).toString());
  const room = snap.bot.room;
  const server = await freshServer(25801);
  const main = readFileSync("dist/main.js").toString();
  const { bot } = await loadScenario(server, snap, main);
  await server.start();

  const pad = (s: string) => s.padStart(8);
  console.log(`reloaded ${file}`);
  console.log(["tick", "rcl", "cp", "ext", "spawnE", "creeps", "roles | plan"].map(pad).join(" "));

  const sample = Math.max(1, Math.floor(ticks / 10));
  for (let t = 1; t <= ticks; t++) {
    await server.tick();
    if (t % sample !== 0 && t !== ticks) continue;
    const objs = await server.world.roomObjects(room);
    const ctrl = objs.find((o: any) => o.type === "controller");
    const spawn = objs.find((o: any) => o.type === "spawn");
    const ext = objs.filter((o: any) => o.type === "extension").length;
    const creeps = objs.filter((o: any) => o.type === "creep");
    const m = await mem(bot);
    const roles: Record<string, number> = {};
    for (const c of creeps) roles[m.creeps?.[c.name]?.workType ?? "?"] = (roles[m.creeps?.[c.name]?.workType ?? "?"] ?? 0) + 1;
    const roleStr = Object.entries(roles).map(([r, n]) => `${r}:${n}`).join(",");
    // Plan budget (stashed in Memory.economyPlan by FlowEconomy).
    const plan = m.economyPlan;
    let planStr = "";
    if (plan) {
      const w = (k: string) => (plan.corps ?? []).filter((c: any) => c.kind === k).reduce((s: number, c: any) => s + (c.work ?? 0), 0);
      planStr = `oh${plan.overhead} mineW${w("mine")} upW${w("upgrade")} bdW${w("build")}`;
    }
    console.log(
      [String(t), `R${ctrl?.level}`, String(cp(ctrl?.level, ctrl?.progress ?? 0)), String(ext), String(spawn?.store?.energy ?? 0), String(creeps.length)]
        .map(pad)
        .join(" ") + `  ${roleStr}  |  ${planStr}`
    );
  }
  await server.stop();
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "gen") await gen(rest[0], Number(rest[1] ?? 1400), rest[2] ?? `server/snaps/${rest[0]}.json`);
  else if (cmd === "run") await run(rest[0], Number(rest[1] ?? 800));
  else console.error("usage: snapshot gen <scenario> <ticks> <out> | snapshot run <file> <ticks>");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
