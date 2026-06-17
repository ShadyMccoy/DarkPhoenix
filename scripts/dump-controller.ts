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
  await loadScenario(server, snapshot, readFileSync("dist/main.js").toString());
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

  await server.stop();
  process.exit(0);
}
main().catch(err => { console.error("dump failed:", err); process.exit(1); });
