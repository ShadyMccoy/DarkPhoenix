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
