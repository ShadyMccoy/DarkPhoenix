#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * snapshot-warm - capture a WARM colony (fleet + extensions + memory) so the
 * carry-efficiency harness can replay it instantly instead of paying the
 * ~2000-tick cold-start each iteration.
 *
 * Run ONCE (slow); it writes a snapshot fixture. carry-efficiency.ts then loads
 * that fixture and measures steady-state delivery in ~500 fast ticks.
 *
 *   npm run build && npx ts-node -P tsconfig.test.json scripts/snapshot-warm.ts [warmupTicks]
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadLayout, padNeighborTerrain, setRoomLevel } from "../test/integration/loadLayout";
import { exportSnapshot } from "../test/integration/scenario";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const OUT = path.resolve("test/integration/scenario/fixtures/warm-two-source.json");

async function main(): Promise<void> {
  const warmup = Number(process.argv[2] ?? 2600);
  const port = 27000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve("server", `warm-${port}`);
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();

  // The standard cold-start scenario (same as ab-cold-start): walled two-chamber
  // room, two sources, RCL 2 + 5 extensions.
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
  const bot = await server.world.addBot({
    username: "player",
    room: "W0N0",
    x: 12,
    y: 25,
    modules: { main: readFileSync("dist/main.js").toString() }
  });
  await setRoomLevel(server.world, "W0N0", 2, [
    { x: 13, y: 24 }, { x: 11, y: 24 }, { x: 13, y: 26 }, { x: 11, y: 26 }, { x: 14, y: 25 }
  ]);
  await server.start();

  for (let t = 1; t <= warmup; t += 1) {
    await server.tick();
    if (t % 500 === 0) {
      const o = await server.world.roomObjects("W0N0");
      const c = o.find((x: any) => x.type === "controller");
      console.log(`  warmup t=${t} cp=${(c?.progress ?? 0)} creeps=${o.filter((x: any) => x.type === "creep").length}`);
    }
  }

  const snap = await exportSnapshot(server, bot, {
    name: "warm-two-source",
    description: `Warm two-source RCL2 colony after ${warmup} cold-start ticks (fleet+extensions+memory).`
  });
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(snap, null, 2));
  const nCreeps = snap.state?.creeps?.length ?? 0;
  console.log(`wrote ${OUT}: ${nCreeps} creeps, RCL ${snap.state?.controller?.level}`);
  await server.stop();
  process.exit(0);
}
main().catch(err => { console.error("snapshot-warm failed:", err); process.exit(1); });
