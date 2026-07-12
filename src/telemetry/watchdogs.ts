/**
 * @fileoverview Watchdog rules (spec 09 phase 4) - pure alert predicates over
 * the black box + core telemetry, shared by the telemetry-app poller and any
 * future in-game alarm. Pure so the thresholds are unit-tested facts, not
 * dashboard folklore.
 *
 * @module telemetry/watchdogs
 */

export interface WatchdogInput {
  tick: number;
  /** Highest owned-room RCL (the wedge alarm only applies at >= 2). */
  rcl: number;
  /** Tick of the last black-box "spawn" row (0 if none in the ring). */
  lastSpawnTick: number;
  /** Lowest controller downgrade timer across owned rooms. */
  minDowngradeTicks: number | null;
  /** Game.cpu.bucket at the last watch sample. */
  bucket: number;
  /** "err" rows within the ring's window. */
  errRowsInWindow: number;
}

export interface WatchdogAlert {
  kind: "no-spawn" | "downgrade" | "bucket" | "errors";
  message: string;
}

/** The wedge signature: an RCL2+ colony that has bought nothing for this long. */
export const NO_SPAWN_ALARM_TICKS = 1000;
/** Downgrade timers below this are an emergency (RCL2 max is 10k). */
export const DOWNGRADE_ALARM_TICKS = 5000;
/** Bucket below this means the colony is burning more CPU than it earns. */
export const BUCKET_ALARM = 2000;
/** Caught errors in one ring window before it counts as a burst. */
export const ERR_BURST = 5;

/** Evaluate every rule; returns the alerts that fired (empty = healthy). */
export function runWatchdogs(input: WatchdogInput): WatchdogAlert[] {
  const alerts: WatchdogAlert[] = [];
  if (input.rcl >= 2 && input.tick - input.lastSpawnTick > NO_SPAWN_ALARM_TICKS) {
    alerts.push({
      kind: "no-spawn",
      message: `no spawn for ${input.tick - input.lastSpawnTick} ticks at RCL${input.rcl} (wedge signature)`
    });
  }
  if (input.minDowngradeTicks !== null && input.minDowngradeTicks < DOWNGRADE_ALARM_TICKS) {
    alerts.push({ kind: "downgrade", message: `controller downgrade in ${input.minDowngradeTicks} ticks` });
  }
  if (input.bucket < BUCKET_ALARM) {
    alerts.push({ kind: "bucket", message: `CPU bucket collapsed to ${input.bucket}` });
  }
  if (input.errRowsInWindow >= ERR_BURST) {
    alerts.push({ kind: "errors", message: `${input.errRowsInWindow} caught errors in the ring window` });
  }
  return alerts;
}
