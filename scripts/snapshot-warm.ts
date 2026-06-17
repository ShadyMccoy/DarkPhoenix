#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * snapshot-warm - capture a WARM colony (fleet + extensions + containers +
 * memory) so the carry-efficiency harness can replay it instantly instead of
 * paying the ~2000-tick cold-start each iteration.
 *
 * Run ONCE per scenario (slow); writes test/integration/scenario/fixtures/warm-<name>.json.
 *
 *   npx ts-node -P tsconfig.test.json scripts/snapshot-warm.ts [scenario] [warmupTicks]
 *     scenario: "ab" (default, walled two-chamber RCL2) or a library factory name
 *               e.g. "twoSourceRcl3Containers".
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadLayout, padNeighborTerrain, setRoomLevel } from "../test/integration/loadLayout";
import { exportSnapshot, loadScenario, scenarios } from "../test/integration/scenario";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

/** The original inline walled two-chamber RCL2 scenario (no library entry). */
async function loadAbRoom(server: any, mainModule: string): Promise<any> {
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
  const bot = await server.world.addBot({ username: "player", room: "W0N0", x: 12, y: 25, modules: { main: mainModule } });
  await setRoomLevel(server.world, "W0N0", 2, [
    { x: 13, y: 24 }, { x: 11, y: 24 }, { x: 13, y: 26 }, { x: 11, y: 26 }, { x: 14, y: 25 }
  ]);
  return bot;
}

async function main(): Promise<void> {
  const scenarioName = process.argv[2] ?? "ab";
  const warmup = Number(process.argv[3] ?? (scenarioName === "ab" ? 2600 : 1800));
  // "ab" keeps the historical fixture name "two-source"; library scenarios use
  // their factory name.
  const key = scenarioName === "ab" ? "two-source" : scenarioName;
  const out = path.resolve(`test/integration/scenario/fixtures/warm-${key}.json`);
  const port = 27000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve("server", `warm-${port}`);
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();
  const main = readFileSync("dist/main.js").toString();

  let bot: any;
  if (scenarioName === "ab") {
    bot = await loadAbRoom(server, main);
  } else {
    const factory = (scenarios as any)[scenarioName];
    if (typeof factory !== "function") throw new Error(`unknown scenario "${scenarioName}"`);
    ({ bot } = await loadScenario(server, factory(), main));
  }
  await server.start();

  for (let t = 1; t <= warmup; t += 1) {
    await server.tick();
    if (t % 500 === 0) {
      const o = await server.world.roomObjects("W0N0");
      const c = o.find((x: any) => x.type === "controller");
      console.log(`  warmup t=${t} rcl=${c?.level} prog=${c?.progress ?? 0} creeps=${o.filter((x: any) => x.type === "creep").length}`);
    }
  }

  const snap = await exportSnapshot(server, bot, {
    name: `warm-${scenarioName}`,
    description: `Warm ${scenarioName} after ${warmup} ticks (fleet+structures+memory).`
  });
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(snap, null, 2));
  console.log(`wrote ${out}: ${snap.state?.creeps?.length ?? 0} creeps, RCL ${snap.state?.controller?.level}`);
  await server.stop();
  process.exit(0);
}
main().catch(err => { console.error("snapshot-warm failed:", err); process.exit(1); });
