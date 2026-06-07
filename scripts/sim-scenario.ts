/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * sim-scenario - run a named library scenario and report economy metrics.
 *
 * The measurement harness for economy iteration: load a scenario, run it, and
 * print a compact metrics table (RCL, control points, structures incl.
 * containers, creeps by role) so planner/executive changes can be compared.
 *
 *   npm run sim:scenario -- threeChamberRcl2 600
 *   npm run sim:scenario -- singleSource 800
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadScenario } from "../test/integration/scenario/Scenario";
import * as library from "../test/integration/scenario/library";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const RCL_TOTALS = [0, 200, 45200, 180200, 585200, 1395200, 3405200, 10405200];
const controlPoints = (level: number, progress: number): number =>
  (RCL_TOTALS[level - 1] ?? 0) + progress;

async function mem(bot: any): Promise<any> {
  try {
    return JSON.parse((await bot.memory) || "{}");
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const name = process.argv[2] ?? "threeChamberRcl2";
  const ticks = Number(process.argv[3] ?? 600);
  const sample = Number(process.argv[4] ?? 50);

  const factory = (library as any)[name];
  if (typeof factory !== "function") {
    console.error(`Unknown scenario "${name}". Available: ${Object.keys(library).join(", ")}`);
    process.exit(1);
  }

  const port = 25600;
  const serverPath = path.resolve("server", String(port));
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();
  const main = readFileSync("dist/main.js").toString();

  const scenario = factory();
  const { bot } = await loadScenario(server, scenario, main);
  const room = scenario.bot.room;
  await server.start();

  const pad = (s: string) => s.padStart(9);
  console.log(`scenario=${name} ticks=${ticks}`);
  console.log(["tick", "rcl", "cp", "ext", "cont", "creeps", "roles"].map(pad).join(" "));

  let lastCp = 0;
  for (let t = 1; t <= ticks; t++) {
    await server.tick();
    if (t % sample !== 0 && t !== ticks) continue;

    const objs = await server.world.roomObjects(room);
    const ctrl = objs.find((o: any) => o.type === "controller");
    const cp = ctrl ? controlPoints(ctrl.level, ctrl.progress) : 0;
    const ext = objs.filter((o: any) => o.type === "extension").length;
    const cont = objs.filter((o: any) => o.type === "container").length;
    const creeps = objs.filter((o: any) => o.type === "creep");

    const m = await mem(bot);
    const roles: Record<string, number> = {};
    for (const c of creeps) {
      const r = m.creeps?.[c.name]?.workType ?? "?";
      roles[r] = (roles[r] ?? 0) + 1;
    }
    const roleStr = Object.entries(roles).map(([r, n]) => `${r}:${n}`).join(",");
    const rate = Math.round((cp - lastCp) / sample);
    lastCp = cp;

    console.log(
      [String(t), `R${ctrl?.level}`, String(cp), String(ext), String(cont), String(creeps.length)]
        .map(pad)
        .join(" ") + `  +${rate}/t  ${roleStr}`
    );
  }

  await server.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
