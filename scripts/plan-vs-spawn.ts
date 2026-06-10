/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * plan-vs-spawn - assert the invariant that SPAWNING MATCHES THE PLAN.
 *
 * The strategic planner (Memory.economyPlan) commissions a roster: so much
 * mining WORK, hauling CARRY, upgrade WORK, build WORK. The execution layer is
 * supposed to field exactly that. When the fielded creeps diverge from the plan,
 * something is broken - either the executor is not following the plan, or the
 * plan is asking for something the room cannot build (a CONSTRAINED economy).
 *
 * This harness runs a list of scenarios and prints, per role, planned vs fielded
 * parts with a PASS/FAIL. The expectation is PASS everywhere EXCEPT scenarios
 * tagged as constrained counter-tests, where an UNDER is the point of the test.
 *
 *   npm run sim:planspawn -- threeChamberRcl2,twoSourceRcl3,remoteSource 600
 *   npm run sim:planspawn -- singleSource 800
 *
 * Add a trailing `:constrained` to a scenario name to mark it a counter-test
 * (an UNDER-spawn there is expected and reported as ok-constrained):
 *   npm run sim:planspawn -- threeChamberRcl2:constrained 600
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadScenario } from "../test/integration/scenario/Scenario";
import * as library from "../test/integration/scenario/library";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

/** Tolerance: fielded parts may differ from plan by this fraction (min 1 part). */
const TOLERANCE = 0.2;

/** Plan corp.kind -> the creep workType that realises it. */
const KIND_ROLE: Record<string, { role: string; part: "work" | "carry" }> = {
  mine: { role: "harvest", part: "work" },
  haul: { role: "haul", part: "carry" },
  upgrade: { role: "upgrade", part: "work" },
  build: { role: "build", part: "work" }
};

async function mem(bot: any): Promise<any> {
  try {
    return JSON.parse((await bot.memory) || "{}");
  } catch {
    return {};
  }
}

/** Count body parts of a mock-server creep object, tolerating shape variants. */
function bodyParts(o: any): { work: number; carry: number; move: number } {
  const acc = { work: 0, carry: 0, move: 0 };
  for (const p of o.body ?? []) {
    const t = typeof p === "string" ? p : p.type;
    if (t === "work") acc.work++;
    else if (t === "carry") acc.carry++;
    else if (t === "move") acc.move++;
  }
  return acc;
}

interface RoleTotals {
  work: number;
  carry: number;
}

async function runScenario(name: string, ticks: number, constrained: boolean): Promise<boolean> {
  const factory = (library as any)[name];
  if (typeof factory !== "function") {
    console.error(`Unknown scenario "${name}". Available: ${Object.keys(library).join(", ")}`);
    return false;
  }

  const port = 25700;
  const serverPath = path.resolve("server", String(port));
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();
  const mainJs = readFileSync("dist/main.js").toString();

  const scenario = factory();
  const { bot } = await loadScenario(server, scenario, mainJs);
  await server.start();
  for (let t = 0; t < ticks; t++) await server.tick();

  const m = await mem(bot);

  // PLAN: sum commissioned parts per role from Memory.economyPlan.
  const plan: Record<string, number> = { harvest: 0, haul: 0, upgrade: 0, build: 0 };
  for (const c of (m.economyPlan?.corps ?? []) as any[]) {
    const map = KIND_ROLE[c.kind];
    if (!map) continue;
    plan[map.role] += (map.part === "work" ? c.work : c.carry) ?? 0;
  }

  // ACTUAL: sum fielded parts per role across every room in the scenario.
  const roomNames = new Set<string>([scenario.bot.room, ...scenario.rooms.map((r: any) => r.room)]);
  const fielded: Record<string, RoleTotals> = {};
  for (const room of roomNames) {
    const objs = await server.world.roomObjects(room);
    for (const o of objs.filter((x: any) => x.type === "creep")) {
      const role = m.creeps?.[o.name]?.workType ?? "?";
      const b = bodyParts(o);
      const tot = (fielded[role] ??= { work: 0, carry: 0 });
      tot.work += b.work;
      tot.carry += b.carry;
    }
  }

  await server.stop();

  // REPORT.
  const energyCap = scenario.state?.structures?.filter((s: any) => s.type === "extension").length ?? 0;
  console.log(`\n=== ${name}${constrained ? " (constrained counter-test)" : ""} @ ${ticks} ticks ===`);
  console.log(["role", "plan", "fielded", "status"].map(s => s.padStart(9)).join(" "));

  let pass = true;
  for (const role of ["harvest", "haul", "upgrade", "build"]) {
    const want = plan[role] ?? 0;
    const part = role === "haul" ? "carry" : "work";
    const got = (fielded[role]?.[part as "work" | "carry"]) ?? 0;
    const tol = Math.max(1, Math.round(want * TOLERANCE));
    let status: string;
    if (want === 0 && got === 0) status = "n/a";
    else if (Math.abs(got - want) <= tol) status = "OK";
    else if (got < want) status = constrained ? "ok-constrained" : "UNDER";
    else status = "OVER";
    if (status === "UNDER" || status === "OVER") pass = false;
    console.log([role, String(want), String(got), status].map(s => s.padStart(9)).join(" "));
  }

  // Feeders (tankers) are an executor detail not in the plan; report for context.
  const tank = fielded["tank"]?.carry ?? 0;
  console.log(`  (feeders: tank ${tank}C; built extensions: ${energyCap})`);
  console.log(`  -> ${pass ? "PASS" : constrained ? "PASS (constrained)" : "FAIL"}`);
  return pass || constrained;
}

async function main(): Promise<void> {
  const list = (process.argv[2] ?? "threeChamberRcl2").split(",");
  const ticks = Number(process.argv[3] ?? 600);

  let allPass = true;
  for (const entry of list) {
    const constrained = entry.endsWith(":constrained");
    const name = entry.replace(":constrained", "");
    const ok = await runScenario(name, ticks, constrained);
    allPass = allPass && ok;
  }

  console.log(`\n${allPass ? "ALL PASS" : "SOME FAILED"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
