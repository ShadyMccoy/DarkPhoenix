/**
 * main.ts — the v2 loop. Five phases, one direction of data flow:
 *
 *   snapshot -> plan (cached, pure) -> assign -> run creeps -> run spawns
 *
 * plus the fidelity ledger and a status line. Memory lifecycle (the plan
 * cache, creep-memory burial) lives here and only here; world facts come
 * only from the snapshot; economic decisions only from the planner
 * (docs/REBOOT.md is the law).
 */
import "./types";
import { snapshot } from "./world";
import { buildPlan, planStale } from "./plan";
import { assignJobs, runCreeps, runSpawns } from "./execute";
import { tickLedger } from "./ledger";

/** Replan cadence. Staleness triggers (room set change, survival flip) can
 * force it sooner — see planStale. */
const PLAN_INTERVAL = 20;

export const loop = (): void => {
  try {
    const world = snapshot();

    // Bury the dead: creep memory with no live creep behind it.
    const alive = new Set(world.creeps.map(c => c.name));
    for (const name of Object.keys(Memory.creeps ?? {})) {
      if (!alive.has(name)) delete Memory.creeps[name];
    }

    if (!Memory.plan || planStale(Memory.plan, world, PLAN_INTERVAL)) {
      Memory.plan = buildPlan(world);
    }
    const plan = Memory.plan;

    assignJobs(world, plan);
    runCreeps(world, plan);
    runSpawns(world, plan);
    tickLedger(world, plan);

    if (world.tick % 100 === 0) {
      const room = world.rooms[0];
      const spawning = world.creeps.filter(c => c.spawning).length;
      if (room) {
        console.log(
          `[v2] t${world.tick} ${room.name} RCL${room.rcl} ${room.rclProgress}/${room.rclProgressTotal} ` +
            `creeps ${world.creeps.length - spawning}(+${spawning}) plan ${plan.expectedMined.toFixed(2)} e/t`
        );
      } else {
        console.log(`[v2] t${world.tick} no owned rooms`);
      }
    }
  } catch (err) {
    const e = err as Error;
    console.log(`[v2] LOOP ERROR: ${e.message}\n${e.stack ?? ""}`);
  }
};
