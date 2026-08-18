/**
 * ledger.ts — the fidelity line (F1), the whole telemetry system until a
 * question earns more (REBOOT.md bet #4). Every window it prints the
 * planner's claimed e/t NEXT TO measured energy put to use, because a plan
 * the runtime doesn't follow costs more than the energy it misprices — it
 * costs the diagnosis (owner 2026-07-30).
 *
 * "Used" = controller progress gained + energy spent on bodies. That is an
 * under-count of MINED (drops, decay and spawn self-regen blur it) — the
 * label says used, not mined, and M3 owns tightening the account. A window
 * that crosses an RCL-up reports the event instead of a ratio rather than
 * pretend the progress arithmetic spans the reset.
 */
import { Plan } from "./plan";
import { World } from "./world";

export interface LedgerMemory {
  windowStart: number;
  ctrl0: number;
  rcl0: number;
  spend: number;
}

const WINDOW = 100;

export function recordSpawnSpend(cost: number): void {
  if (Memory.ledger) Memory.ledger.spend += cost;
}

function reset(world: World): void {
  const room = world.rooms[0];
  Memory.ledger = {
    windowStart: world.tick,
    ctrl0: room ? room.rclProgress : 0,
    rcl0: room ? room.rcl : 0,
    spend: 0
  };
}

export function tickLedger(world: World, plan: Plan): void {
  const room = world.rooms[0];
  if (!room) return;
  if (!Memory.ledger) {
    reset(world);
    return;
  }

  const led = Memory.ledger;
  const elapsed = world.tick - led.windowStart;
  if (elapsed < WINDOW) return;

  if (room.rcl !== led.rcl0) {
    console.log(`[F1] t${world.tick} RCL ${led.rcl0}->${room.rcl} inside the window - ratio skipped`);
  } else {
    const ctrlGain = room.rclProgress - led.ctrl0;
    const used = (ctrlGain + led.spend) / elapsed;
    const planned = plan.expectedMined;
    const ratio = planned > 0 ? used / planned : 0;
    console.log(
      `[F1] t${world.tick} plan ${planned.toFixed(2)} e/t | used ${used.toFixed(2)} e/t ` +
        `(ctrl ${(ctrlGain / elapsed).toFixed(2)}, bodies ${(led.spend / elapsed).toFixed(2)}) | ${ratio.toFixed(2)}x`
    );
  }
  reset(world);
}
