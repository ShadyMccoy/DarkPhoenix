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
  /**
   * Deposit-port buffers that are NOT being drained (spec 57), one entry per
   * offending port. Omitted by callers that cannot see the ports.
   */
  portBuffers?: PortBufferSample[];
}

/** One deposit port's buffer, as the tender check reads it. */
export interface PortBufferSample {
  /** "x,y" in the port's room - enough to go look at it in-game. */
  where: string;
  /** Energy standing in the buffer. */
  energy: number;
  /** The buffer's capacity. 0 means unreadable, and the pinned rule then
   *  declines to judge fullness rather than guessing at it. */
  capacity: number;
  /** Live port tenders in that room, counted the demand side's way. */
  tenders: number;
}

export interface WatchdogAlert {
  kind: "no-spawn" | "downgrade" | "bucket" | "errors" | "port-untended";
  message: string;
}

/** A buffer this full is not buffering, it is queueing. */
export const PORT_BUFFER_PINNED_SHARE = 0.9;

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
  // THE TENDER CHECK (spec 57). Two ways a port buffer stops being a buffer,
  // and both were invisible for the 1,800+ ticks the (44,12) container spent
  // at 2000/2000: nothing tends it, or something tends it and it is pinned
  // full anyway. Neither shows up in a RATE - a jammed port reads the same as
  // a quiet one, which is exactly how this hid. A STOCK against its own
  // capacity cannot.
  for (const p of input.portBuffers ?? []) {
    if (p.tenders === 0 && p.energy > 0) {
      alerts.push({
        kind: "port-untended",
        message: `deposit-port buffer ${p.where} holds ${p.energy}e with NO tender - haulers are dropping into a hole`
      });
      continue;
    }
    if (p.capacity > 0 && p.energy >= p.capacity * PORT_BUFFER_PINNED_SHARE) {
      alerts.push({
        kind: "port-untended",
        message:
          `deposit-port buffer ${p.where} pinned at ${p.energy}/${p.capacity} with ${p.tenders} tender(s) - ` +
          `the drain is not keeping up`
      });
    }
  }
  return alerts;
}
