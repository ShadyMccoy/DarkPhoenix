#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * dump-controller - one-shot diagnostic: load a warm snapshot, settle a few
 * ticks, then print the controller fringe - controller pos, every creep's
 * pos/workType/energy, and dropped energy piles. Reveals WHY upgraders stall
 * (squatting the drop tile, scattered piles, blocked approaches).
 *
 *   npm run build && ts-node -P tsconfig.test.json scripts/dump-controller.ts [settle] [snapshot]
 */
import { readFileSync, existsSync } from "fs";
import * as path from "path";
import { loadScenario } from "../test/integration/scenario";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

async function main(): Promise<void> {
  const settle = Number(process.argv[2] ?? 60);
  const name = process.argv[3] ?? "two-source";
  const SNAP = path.resolve(`test/integration/scenario/fixtures/warm-${name}.json`);
  if (!existsSync(SNAP)) {
    console.error(`No warm snapshot at ${SNAP}`);
    process.exit(1);
  }
  const snapshot = JSON.parse(readFileSync(SNAP, "utf8"));
  const port = 29000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve("server", `dump-${port}`);
  require("fs").mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();
  const { bot } = await loadScenario(server, snapshot, readFileSync("dist/main.js").toString());
  await server.start();
  for (let t = 0; t < settle; t += 1) await server.tick();

  const objs = await server.world.roomObjects("W0N0");
  const ctrl = objs.find((o: any) => o.type === "controller");
  console.log(`controller @ (${ctrl?.x},${ctrl?.y}) rcl=${ctrl?.level} prog=${ctrl?.progress}`);
  const cx = ctrl?.x ?? 0;
  const cy = ctrl?.y ?? 0;
  const cheb = (x: number, y: number) => Math.max(Math.abs(x - cx), Math.abs(y - cy));

  const creeps = objs.filter((o: any) => o.type === "creep");
  console.log(`\ncreeps near controller (cheb<=6):`);
  for (const c of creeps) {
    if (cheb(c.x, c.y) > 6) continue;
    const energy = (c.store?.energy ?? 0);
    console.log(`  (${c.x},${c.y}) d=${cheb(c.x, c.y)} body=${(c.body || []).length} e=${energy} mem=${JSON.stringify(c.name)}`);
  }

  const drops = objs.filter((o: any) => o.type === "energy");
  console.log(`\ndropped energy:`);
  for (const d of drops) console.log(`  (${d.x},${d.y}) d=${cheb(d.x, d.y)} amount=${d.energy ?? d.resourceType}`);

  const conts = objs.filter((o: any) => o.type === "container" || o.type === "link");
  console.log(`\ncontainers/links near controller:`);
  for (const k of conts) if (cheb(k.x, k.y) <= 4) console.log(`  ${k.type} (${k.x},${k.y}) d=${cheb(k.x, k.y)} e=${k.store?.energy ?? 0}`);

  // Hauler routing + spawn fill: distinguishes "no hauler routes to controller"
  // from "routes there but can't deposit".
  let mem: any = {};
  try { mem = JSON.parse((await bot.memory) || "{}"); } catch { /* ignore */ }
  const memByName: Record<string, any> = mem.creeps || {};
  const sinks: Record<string, number> = {};
  for (const c of objs.filter((o: any) => o.type === "creep")) {
    const m = memByName[c.name];
    if (m?.workType !== "haul") continue;
    const key = `home=${m.homeSink ?? "?"}/deliver=${m.deliverSinkId ?? "?"}`;
    sinks[key] = (sinks[key] ?? 0) + 1;
  }
  console.log(`\nhauler sinks: ${JSON.stringify(sinks)}`);
  console.log("haulers:");
  for (const c of objs.filter((o: any) => o.type === "creep")) {
    const m = memByName[c.name];
    if (m?.workType !== "haul") continue;
    console.log(`  (${c.x},${c.y}) e=${c.store?.energy ?? 0} working=${m.working} home=${m.homeSink} deliver=${m.deliverSinkId} src=${m.assignedSourceId?.slice(-4)}`);
  }
  const spawnObj = objs.find((o: any) => o.type === "spawn");
  console.log(`spawn @ (${spawnObj?.x},${spawnObj?.y}) e=${spawnObj?.store?.energy ?? 0} spawning=${JSON.stringify(spawnObj?.spawning ?? null)}`);
  const spawns = objs.filter((o: any) => o.type === "spawn" || o.type === "extension");
  let used = 0;
  let cap = 0;
  for (const s of spawns) { used += s.store?.energy ?? 0; cap += (s.type === "spawn" ? 300 : 50); }
  console.log(`spawn network fill: ${used}/${cap} (${cap ? Math.round((100 * used) / cap) : 0}%)`);

  await server.stop();
  process.exit(0);
}
main().catch(err => { console.error("dump failed:", err); process.exit(1); });
