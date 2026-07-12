/**
 * @fileoverview CpuGovernor - ordered degradation when the CPU bucket falls
 * (spec 09 phase 5). CPU is the colony's third currency; when the bucket
 * drains, the governor sheds load in VALUE order - observability first,
 * planning cadence second, investment third, intel last - so the income
 * core (miners, haulers, spawning) is the last thing standing.
 *
 * The plan is a pure function of the bucket, so the degradation ORDER is a
 * unit-tested fact (the grid pins it with a stubbed clock; the real effect
 * is verified on the live server only). Level transitions are logged to the
 * black box - a bucket collapse arrives with its own shedding history.
 *
 * @module execution/CpuGovernor
 */

import { record } from "../telemetry/BlackBox";

/** Degradation levels, mildest first. Each level keeps all milder sheds. */
export type GovernorLevel = "full" | "lean" | "stretched" | "austere" | "survival";

export interface GovernorPlan {
  level: GovernorLevel;
  /** Skip the RawMemory telemetry export (the black box still flushes). */
  skipTelemetry: boolean;
  /** Economy re-solve cadence (ticks); FULL_SOLVE_INTERVAL (50) when full. */
  solveInterval: number;
  /** Pause NEW construction placement + paving (existing sites keep building). */
  pauseConstruction: boolean;
  /** Stop buying scouts (fielded scouts keep walking). */
  freezeScouting: boolean;
}

export const FULL_SOLVE_INTERVAL = 50;
const STRETCHED_SOLVE_INTERVAL = 150;

/** Bucket thresholds, in shedding order. */
export const LEAN_BUCKET = 8000; // skip telemetry
export const STRETCHED_BUCKET = 5000; // + stretch the solve cadence
export const AUSTERE_BUCKET = 3000; // + pause construction/paving
export const SURVIVAL_BUCKET = 1500; // + freeze scouting

/** The degradation plan for a bucket level. Pure. */
export function governorPlan(bucket: number): GovernorPlan {
  const level: GovernorLevel =
    bucket < SURVIVAL_BUCKET
      ? "survival"
      : bucket < AUSTERE_BUCKET
      ? "austere"
      : bucket < STRETCHED_BUCKET
      ? "stretched"
      : bucket < LEAN_BUCKET
      ? "lean"
      : "full";
  return {
    level,
    skipTelemetry: level !== "full",
    solveInterval: level === "full" || level === "lean" ? FULL_SOLVE_INTERVAL : STRETCHED_SOLVE_INTERVAL,
    pauseConstruction: level === "austere" || level === "survival",
    freezeScouting: level === "survival"
  };
}

let lastLevel: GovernorLevel | null = null;
let current: GovernorPlan = governorPlan(10000);

/**
 * ARMED only when the owner flips Memory.cpuGovernor = "on" (a live console
 * command). Everywhere else - grid worlds, sims, integration - the governor
 * runs DRY: it computes and black-boxes its would-be level (observability
 * first, the spec-11 phase-1 pattern) but sheds nothing. Cells must stay
 * deterministic: the mockup meters real CPU against a real bucket, so an
 * armed governor couples cell behavior to HOST LOAD (measured: a full grid
 * run drained heavy worlds' buckets, paused construction colony-wide, and
 * failed six baseline-green cells with runt fleets). Spec 09 ph5: "real
 * effect verified on the live server only."
 */
function armed(): boolean {
  return typeof Memory === "undefined" || Memory.cpuGovernor === "on";
}

/**
 * Evaluate the governor for this tick and log level TRANSITIONS to the black
 * box. Call once per tick, early in the loop; consumers read via plan().
 */
export function runGovernor(bucket: number, tick?: number): GovernorPlan {
  const computed = governorPlan(bucket);
  if (computed.level !== lastLevel) {
    if (lastLevel !== null) record("gov", { level: computed.level, bucket, armed: armed() }, tick);
    lastLevel = computed.level;
  }
  current = armed() ? computed : governorPlan(10000);
  return current;
}

/** The plan computed by this tick's runGovernor (full operation before init). */
export function plan(): GovernorPlan {
  return current;
}

/** Test seam. */
export function resetGovernor(): void {
  lastLevel = null;
  current = governorPlan(10000);
}
