#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * carry-efficiency - FAST steady-state delivery harness for iterating on
 * CarryCorp (and the spawn/controller routing). Loads a pre-captured WARM
 * colony (see snapshot-warm.ts) so there is no cold-start, then measures over a
 * short window:
 *
 *   - cp/tick        : control points delivered to the controller (the headline
 *                      - this is hauled energy actually reaching the consumer);
 *   - mined/tick     : energy harvested (from corp variance);
 *   - efficiency     : cp/tick as a fraction of mined/tick (what share of mined
 *                      energy becomes RCL progress vs is wasted in transit/overflow).
 *
 * Change CarryCorp, `npm run build`, re-run; compare cp/tick. ~500 ticks ≈ 1 min.
 *
 *   npm run build && npx ts-node -P tsconfig.test.json scripts/carry-efficiency.ts [measureTicks] [settleTicks]
 */
import { readFileSync, existsSync } from "fs";
import * as path from "path";
import { loadScenario } from "../test/integration/scenario";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const SNAP = path.resolve("test/integration/scenario/fixtures/warm-two-source.json");

async function readState(server: any, bot: any): Promise<{ cp: number; mined: number; upgraders: number; haulers: number }> {
  const objs = await server.world.roomObjects("W0N0");
  const ctrl = objs.find((o: any) => o.type === "controller");
  const cp = (ctrl?.level === 2 ? 0 : 0) + (ctrl?.progress ?? 0); // RCL fixed at 2 here; progress is the signal
  let mem: any = {};
  try { mem = JSON.parse((await bot.memory) || "{}"); } catch { /* ignore */ }
  const rows = (mem.corpVariance || []) as Array<{ type: string; actual: number }>;
  const mined = rows.filter(r => r.type === "mining").reduce((s, r) => s + r.actual, 0);
  let upgraders = 0;
  let haulers = 0;
  for (const n in mem.creeps || {}) {
    const w = mem.creeps[n].workType;
    if (w === "upgrade") upgraders++;
    if (w === "haul") haulers++;
  }
  return { cp, mined, upgraders, haulers };
}

async function main(): Promise<void> {
  if (!existsSync(SNAP)) {
    console.error(`No warm snapshot at ${SNAP}. Run: npx ts-node -P tsconfig.test.json scripts/snapshot-warm.ts`);
    process.exit(1);
  }
  const measure = Number(process.argv[2] ?? 500);
  const settle = Number(process.argv[3] ?? 50);
  const snapshot = JSON.parse(readFileSync(SNAP, "utf8"));
  const port = 28000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve("server", `carry-${port}`);
  require("fs").mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();
  const { bot } = await loadScenario(server, snapshot, readFileSync("dist/main.js").toString());
  await server.start();

  // Settle: let the bot re-adopt the warm state (hydrate corps, re-solve) before
  // measuring, so the first ticks' transients don't pollute the rate.
  for (let t = 0; t < settle; t += 1) await server.tick();
  const start = await readState(server, bot);
  const startProgress = start.cp;

  let minedSum = 0;
  let samples = 0;
  for (let t = 1; t <= measure; t += 1) {
    await server.tick();
    if (t % 50 === 0) {
      const s = await readState(server, bot);
      minedSum += s.mined;
      samples += 1;
      if (t % 100 === 0) {
        console.log(`  t=+${String(t).padStart(4)} cpGained=${s.cp - startProgress} mined~${s.mined.toFixed(1)}/tick up=${s.upgraders} haul=${s.haulers}`);
      }
    }
  }
  const end = await readState(server, bot);
  const cpGained = end.cp - startProgress;
  const cpPerTick = cpGained / measure;
  const minedPerTick = samples > 0 ? minedSum / samples : 0;
  const efficiency = minedPerTick > 0 ? (cpPerTick / minedPerTick) * 100 : 0;

  console.log("");
  console.log(`=== carry efficiency (warm, ${measure} ticks) ===`);
  console.log(`cp/tick      = ${cpPerTick.toFixed(2)}   (control points delivered to controller)`);
  console.log(`mined/tick   = ${minedPerTick.toFixed(2)}   (energy harvested)`);
  console.log(`efficiency   = ${efficiency.toFixed(0)}%   (cp / mined - rest is overhead + waste)`);
  console.log(`fleet        = ${end.upgraders} upgraders, ${end.haulers} haulers`);
  await server.stop();
  process.exit(0);
}
main().catch(err => { console.error("carry-efficiency failed:", err); process.exit(1); });
