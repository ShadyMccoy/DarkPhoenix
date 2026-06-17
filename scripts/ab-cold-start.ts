#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ab-cold-start - measure how much a colony grows from a cold start.
 *
 * An A/B harness for "are the economy changes actually making the colony
 * better?". It stands up the same proven cold-start colony (walled two-chamber
 * room, two sources, RCL 2 + 5 extensions) on the real engine - NO free-economy
 * mod, so growth reflects real throughput - runs it for a fixed number of ticks,
 * and reports the colony's cumulative control points (the canonical "how far has
 * it grown" number) plus the producing fleet.
 *
 * The bot under test is whatever dist/main.js currently is, so the same harness
 * measures any commit: build the bot at commit A, run this; build at commit B,
 * run this; compare the control points. The scenario/harness stays constant, so
 * the delta is the bot's behavior change alone.
 *
 * Usage:
 *   npm run build && npx ts-node -P tsconfig.test.json scripts/ab-cold-start.ts [ticks]
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadLayout, padNeighborTerrain, setRoomLevel } from "../test/integration/loadLayout";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const RCL_TOTALS = [0, 200, 45200, 180200, 585200, 1395200, 3405200, 10405200];
const controlPoints = (level: number, progress: number): number => (RCL_TOTALS[level - 1] ?? 0) + progress;

async function main(): Promise<void> {
  const ticks = Number(process.argv[2] ?? 1500);
  const port = 26000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve("server", `ab-${port}`);
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();

  const terrain = Array.from({ length: 50 }, (_v, y) =>
    ".".repeat(25) + (y >= 23 && y <= 27 ? "." : "#") + ".".repeat(24)
  );
  await loadLayout(server.world, {
    room: "W0N0",
    terrain,
    objects: [
      { type: "controller", x: 38, y: 25 },
      { type: "source", x: 10, y: 10 },
      { type: "source", x: 40, y: 40 }
    ]
  });
  await padNeighborTerrain(server.world, ["W0N0"]);
  const player = await server.world.addBot({
    username: "player", room: "W0N0", x: 12, y: 25,
    modules: { main: readFileSync("dist/main.js").toString() }
  });
  await setRoomLevel(server.world, "W0N0", 2, [
    { x: 13, y: 24 }, { x: 11, y: 24 }, { x: 13, y: 26 }, { x: 11, y: 26 }, { x: 14, y: 25 }
  ]);

  await server.start();

  const sample = Number(process.argv[3] ?? 250);
  for (let t = 1; t <= ticks; t += 1) {
    await server.tick();
    if (t % sample === 0) {
      const o = await server.world.roomObjects("W0N0");
      const c = o.find((x: any) => x.type === "controller");
      let m: any = {};
      try { m = JSON.parse((await player.memory) || "{}"); } catch { /* ignore */ }
      const bt: Record<string, number> = {};
      for (const n in m.creeps || {}) { const w = m.creeps[n].workType || "bootstrap"; bt[w] = (bt[w] || 0) + 1; }
      const v = (m.corpVariance || []).map((r: any) => `${r.type} ${r.actual}/${r.budget}`).join(", ");
      console.log(
        `  t=${String(t).padStart(4)} cp=${controlPoints(c?.level ?? 0, c?.progress ?? 0)} creeps=${JSON.stringify(bt)} var=[${v}]`
      );
    }
  }

  const objs = await server.world.roomObjects("W0N0");
  const ctrl = objs.find((o: any) => o.type === "controller");
  const cp = controlPoints(ctrl?.level ?? 0, ctrl?.progress ?? 0);

  let mem: any = {};
  try { mem = JSON.parse((await player.memory) || "{}"); } catch { /* ignore */ }
  const byType: Record<string, number> = {};
  for (const name in mem.creeps || {}) {
    const wt = mem.creeps[name].workType || "bootstrap";
    byType[wt] = (byType[wt] || 0) + 1;
  }
  const variance = (mem.corpVariance || []).map((r: any) => `${r.type} ${r.actual}/${r.budget}`).join(", ");

  console.log(`ticks=${ticks} RCL=${ctrl?.level} controlPoints=${cp}`);
  console.log(`creeps=${JSON.stringify(byType)}`);
  console.log(`variance=[${variance}]`);
  const ep = mem.economyPlan;
  if (ep) {
    const totalAlloc = (ep.corps || [])
      .filter((c: any) => c.kind === "upgrade" || c.kind === "build")
      .reduce((s: number, c: any) => s + (c.work || 0), 0);
    console.log(
      `economyPlan: overhead=${ep.overhead} unrouted=${ep.unrouted} consumerWork=${totalAlloc} corps=${(ep.corps || []).length}`
    );
  }

  // Controller-area dump: WHY is upgrading stalled? Show the controller fringe -
  // parked upgraders (pos + carried energy), dropped piles, and each hauler's
  // committed sink. Distinguishes "no hauler routes to the controller" from
  // "haulers route there but can't deposit / upgraders can't withdraw".
  const cx = ctrl?.x ?? 0;
  const cy = ctrl?.y ?? 0;
  const cheb = (x: number, y: number) => Math.max(Math.abs(x - cx), Math.abs(y - cy));
  console.log(`controller @ (${cx},${cy})`);
  const creeps = objs.filter((o: any) => o.type === "creep");
  const memByName: Record<string, any> = mem.creeps || {};
  console.log("upgraders:");
  for (const c of creeps) {
    if (memByName[c.name]?.workType !== "upgrade") continue;
    console.log(`  (${c.x},${c.y}) d=${cheb(c.x, c.y)} e=${c.store?.energy ?? 0} spot=${JSON.stringify(memByName[c.name]?.upgradeSpot)}`);
  }
  const drops = objs.filter((o: any) => o.type === "energy" && cheb(o.x, o.y) <= 5);
  console.log(`piles near ctrl: ${drops.map((d: any) => `(${d.x},${d.y})d=${cheb(d.x, d.y)}=${d.energy}`).join(" ") || "none"}`);
  const sinks: Record<string, number> = {};
  for (const c of creeps) {
    const m = memByName[c.name];
    if (m?.workType !== "haul") continue;
    const key = `home=${m.homeSink ?? "?"}/deliver=${m.deliverSinkId ?? "?"}`;
    sinks[key] = (sinks[key] ?? 0) + 1;
  }
  console.log(`hauler sinks: ${JSON.stringify(sinks)}`);

  await server.stop();
  process.exit(0);
}

main().catch(err => { console.error("ab-cold-start failed:", err); process.exit(1); });
