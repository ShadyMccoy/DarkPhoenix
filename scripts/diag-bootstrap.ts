#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * diag-bootstrap - does a from-scratch RCL1 colony progress with a FAR controller?
 *
 * Isolates the stub-world stall: a single all-plain room (so no multi-room / many-
 * node confusion), but with the controller placed far from the spawn like the stub
 * world's W0N1 (controller@8,43, spawn@15,15, dist ~28). Runs from RCL1 and prints
 * the controller level/progress + creeps over time. Compares against a NEAR
 * controller to see whether distance alone stalls the bootstrap.
 *
 *   npx ts-node -P tsconfig.test.json scripts/diag-bootstrap.ts          # far (default)
 *   npx ts-node -P tsconfig.test.json scripts/diag-bootstrap.ts --near   # near controller
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadLayout, padNeighborTerrain } from "../test/integration/loadLayout";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

async function main(): Promise<void> {
  const near = process.argv.includes("--near");
  const controller = near ? { x: 14, y: 16 } : { x: 8, y: 43 }; // near spawn vs far corner
  const port = 25900 + Math.floor(Math.random() * 500);
  const serverPath = path.resolve("server", `diagbs-${port}`);
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();
  await loadLayout(server.world, {
    room: "W0N0",
    terrain: Array.from({ length: 50 }, () => ".".repeat(50)),
    objects: [
      { type: "controller", x: controller.x, y: controller.y },
      { type: "source", x: 14, y: 18 },
      { type: "source", x: 39, y: 14 }
    ]
  });
  await padNeighborTerrain(server.world, ["W0N0"]);
  const player = await server.world.addBot({
    username: "player", room: "W0N0", x: 15, y: 15, modules: { main: readFileSync("dist/main.js").toString() }
  });
  await server.start();

  console.log(`controller ${near ? "NEAR" : "FAR"} @ ${controller.x},${controller.y} (spawn 15,15)`);
  for (let t = 1; t <= 600; t += 1) {
    await server.tick();
    if (t % 75 !== 0) continue;
    let mem: any = {};
    try { mem = JSON.parse((await player.memory) || "{}"); } catch { /* ignore */ }
    const objs = await server.world.roomObjects("W0N0");
    const ctrl = objs.find((o: any) => o.type === "controller");
    const byType: Record<string, number> = {};
    for (const name in mem.creeps || {}) {
      const wt = mem.creeps[name].workType || "bootstrap";
      byType[wt] = (byType[wt] || 0) + 1;
    }
    console.log(`t=${String(t).padStart(3)} RCL ${ctrl?.level} prog ${ctrl?.progress} | creeps ${JSON.stringify(byType)} | nodes ${Object.keys(mem.nodes || {}).length}`);
  }

  await server.stop();
  process.exit(0);
}

main().catch(e => { console.error("diag-bootstrap failed:", e); process.exit(1); });
