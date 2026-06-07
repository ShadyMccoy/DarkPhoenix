/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * fastConstants - optional sim-only knob to speed up the slow parts of the game
 * so economy iteration doesn't wait real-game ticks for a 5000-energy container
 * or a 45000-progress RCL.
 *
 * `server.constants` is the shared @screeps/common constants object that the
 * physics engine reads (e.g. a construction site's progressTotal is
 * CONSTRUCTION_COST[type] at creation, RCL advances at CONTROLLER_LEVELS[n]), so
 * mutating it in place before the server starts changes the simulation cheaply.
 *
 * IMPORTANT: this changes the economy BALANCE. Use it to reach a built-out state
 * fast or to smoke-test logic - NOT to measure real performance. Default runs
 * (no env) use the real constants so measurements stay honest.
 *
 * Enable with env vars:
 *   FAST=1            cheaper construction (CONSTRUCTION_COST / FAST_FACTOR)
 *   FAST_RCL=1        also climb RCL faster (CONTROLLER_LEVELS / FAST_FACTOR)
 *   FAST_FACTOR=10    the divisor (default 10)
 */
export function applyFastConstants(server: any): void {
  if (!process.env.FAST && !process.env.FAST_RCL) return;
  const C = server.constants;
  const factor = Math.max(1, Number(process.env.FAST_FACTOR ?? 10));

  if (process.env.FAST) {
    for (const k of Object.keys(C.CONSTRUCTION_COST)) {
      C.CONSTRUCTION_COST[k] = Math.max(1, Math.round(C.CONSTRUCTION_COST[k] / factor));
    }
  }
  if (process.env.FAST_RCL) {
    for (const k of Object.keys(C.CONTROLLER_LEVELS)) {
      C.CONTROLLER_LEVELS[k] = Math.max(1, Math.round(C.CONTROLLER_LEVELS[k] / factor));
    }
  }

  const parts: string[] = [];
  if (process.env.FAST) parts.push(`construction cost /${factor}`);
  if (process.env.FAST_RCL) parts.push(`RCL thresholds /${factor}`);
  console.log(`[FAST] ${parts.join(", ")} (sim balance altered - for iteration only)`);
}
