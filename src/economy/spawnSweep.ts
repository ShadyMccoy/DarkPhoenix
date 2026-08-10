/**
 * @fileoverview THE SPAWN-HANDICAP SWEEP - a self-driving planner experiment
 * (owner 2026-08-06).
 *
 * Charter: owns the ONE number the experiment varies - the fraction of the
 * physical spawn build-rate the planner may commit - and the calendar that
 * advances it. No other module decides the handicap; `primitives.plannableSpawnParts`
 * resolves it through `spawnPlanFraction()` and nothing else reads the state.
 *
 * ## Why an experiment at all
 *
 * The margin was 0.9 for months (owner 2026-07-30: "90% of theoretical spawn
 * capacity is available for planning"). Lifting it to 1.0 on 2026-08-04
 * OVERHEATED the colony, measured: utilization 0.97-0.98 with queue depth 4-8
 * sustained ~2000t, forgone mining climbing 8-20 -> 44.5 e/t over five fiscal
 * months, F2 fielding 38 of 84 declared parts. It was reverted to 0.9 on
 * 2026-08-05 and the colony recovered - utilization 0.64, forgone 9.71 e/t,
 * churn 0% at t72823437.
 *
 * So we know 1.0 is too hot and 0.9 works. We do NOT know where between them
 * the economy actually sits, or whether 0.9 is itself leaving capacity unused.
 * Owner 2026-08-06: *"I want to set up an experiment with every fiscal month.
 * We add 1% of handicap. From 0 to 20 over the course of two fiscal years. We
 * will then examine the income statements across all 20 months."*
 *
 * The sweep walks the handicap 0% -> 20% one step per fiscal MONTH, holding it
 * fixed within the month so each month's income statement describes exactly one
 * handicap. At the top it wraps to 0 and runs again (owner: *"It can cycle back
 * to zero and around again"*) - which is not merely a convenience. A fiscal
 * month is a phase sample of the ~9000-tick bank limit cycle (spec 41), so a
 * SINGLE pass aliases the bank oscillation against the handicap ramp and cannot
 * separate them. Cycling re-samples each handicap at a different bank phase; the
 * second cycle is what turns 21 phase samples into a comparison.
 *
 * ## Why the state lives in Memory
 *
 * Three reasons, and the third is the one that makes the experiment safe:
 *
 * 1. It must survive a global reset - a heap value would re-randomise the
 *    experiment on every deploy (telemetry/LossMeter's header logs exactly this
 *    defect costing a whole fiscal month of measurement).
 * 2. It must be STABLE within a month. Recomputing from `Game.time` at every
 *    call would be equivalent here, but latching makes the value auditable: the
 *    archive records what was actually in force, not what we believe was.
 * 3. **The sweep never self-arms.** With no `Memory.spawnSweep` the fraction is
 *    `SPAWN_PLAN_FRACTION` (0.9, the measured-good value), so the grid, the
 *    sims and the unit suite are untouched by the experiment's existence, and a
 *    wiped Memory FAILS SAFE back to 0.9 rather than to the overheated 1.0.
 *    Arming is a deliberate one-time act (`fiscalArchive.armSweep`); advancing
 *    is the bot's.
 */

/** Ticks in a fiscal month - CREEP_LIFETIME, matching scripts/fiscal.ts. */
export const SWEEP_MONTH_TICKS = 1500;

/** The top of the ramp, in percent. The sweep wraps to 0 after this step. */
export const SWEEP_MAX_PCT = 20;

/**
 * The default per-month increment (owner: "We add 1% of handicap"). At this
 * step the ramp 0..20 inclusive is 21 months - a little over the owner's "two
 * fiscal years" (20 months), because the 20% endpoint is the interesting one:
 * it brackets the retired 10% handicap at the exact midpoint of the sweep.
 */
export const SWEEP_STEP_PCT = 1;

/**
 * The ACCELERATED increment (owner: "RCL 8 may hit before then - so if
 * necessary let's plan to accelerate that with 2% per month"). At 2% the ramp
 * is 11 months instead of 21, trading resolution for the chance of finishing
 * inside one RCL regime.
 */
export const SWEEP_STEP_PCT_FAST = 2;

/**
 * The experiment's persistent state. One object, all of it auditable, published
 * verbatim into the fiscal archive so every month's income statement carries the
 * handicap that produced it.
 */
export interface SpawnSweepState {
  /** Handicap in force RIGHT NOW, percent. Fraction = 1 - pct/100. */
  pct: number;
  /** Per-month increment currently latched (SWEEP_STEP_PCT or ..._FAST). */
  step: number;
  /** Tick of the month boundary that last advanced the sweep - the idempotence key. */
  lastBoundary: number;
  /** How many complete 0->MAX ramps have finished. The cycle index of the CURRENT pass. */
  cycle: number;
  /** Controller progress at the last boundary, for the RCL-8 arrival projection. */
  lastProgress?: number;
  /** Why the current step was chosen - stamped for the audit, never read back. */
  stepReason?: string;
}

/**
 * ## Purity (spec 17)
 *
 * This module is on the PLAN-layer PURE list, and it has to be: `primitives.ts`
 * resolves the margin through it, and primitives is the planning core's formula
 * home. So the sweep's STATE lives in `Memory` - owned by the adapter that
 * already touches it, telemetry/fiscalArchive - and this module keeps only a
 * module-level MIRROR that the adapter refreshes each tick before the planner
 * runs.
 *
 * The mirror being empty is the fail-safe, not a bug: after a global reset, and
 * in every Game-free caller (grid cell, sim, unit test), `currentHandicapPct()`
 * returns undefined and the margin falls back to the measured-good 0.9.
 */
let handicapPct: number | undefined;

/** Adapter seam: publish the latched handicap for this tick (undefined = unarmed). */
export function setHandicapPct(pct: number | undefined): void {
  handicapPct = pct === undefined ? undefined : clampPct(pct);
}

/**
 * The handicap in force, as a percentage. Unarmed => undefined (the caller falls
 * back to the static constant).
 */
export function currentHandicapPct(): number | undefined {
  return handicapPct;
}

/** A fresh sweep at a given handicap. Pure - the adapter persists it. */
export function newSweep(startPct = 0, step: number = SWEEP_STEP_PCT): SpawnSweepState {
  return { pct: clampPct(startPct), step, lastBoundary: -1, cycle: 0, stepReason: "armed" };
}

function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(SWEEP_MAX_PCT, Math.max(0, Math.round(pct)));
}

/** Is this tick a fiscal-month boundary? Absolute clock - never drifts. */
export function isMonthBoundary(tick: number): boolean {
  return tick % SWEEP_MONTH_TICKS === 0;
}

/**
 * Inputs the step decision reads. Supplied by the caller rather than pulled from
 * `Game` so the rule is unit-testable and this module stays free of room lookups.
 */
export interface SweepContext {
  tick: number;
  /** Home controller progress toward the NEXT level. */
  rclProgress?: number;
  /** Points needed for the next level (RCL 7->8 is 10,935,000). */
  rclProgressTotal?: number;
  /** Home controller level - the sweep only races a level 7 room. */
  rcl?: number;
}

/**
 * Should the sweep run at 2%/month instead of 1%?
 *
 * The owner's "if necessary": necessary means RCL 8 would land BEFORE the ramp
 * finishes, because the controller caps at 15 e/t there and income statements
 * either side of that boundary are not comparable. The projection uses the
 * colony's OWN measured controller rate between the last two month boundaries -
 * no constant, no model - so it tracks whatever the economy is actually doing.
 *
 * Measured at t72823437: 3,652,926 points remaining at 37.4/tick projects RCL 8
 * ~97,700 ticks out against ~31,500 ticks of ramp, a 3x margin - so this returns
 * false today and the sweep keeps its 1% resolution. It flips only if the
 * controller rate roughly triples.
 *
 * Degrades safe in both directions: with no rate sample it returns false (the
 * finer sweep), and a wrong TRUE merely finishes the experiment sooner.
 */
export function shouldAccelerate(state: SpawnSweepState, ctx: SweepContext): boolean {
  if (ctx.rcl !== 7) return false; // only a level-7 room is racing RCL 8
  const { rclProgress, rclProgressTotal, lastProgress } = { ...ctx, lastProgress: state.lastProgress };
  if (rclProgress === undefined || rclProgressTotal === undefined || lastProgress === undefined) return false;
  const gained = rclProgress - lastProgress;
  if (gained <= 0) return false; // no sample, or a level-up already reset it
  const rate = gained / SWEEP_MONTH_TICKS;
  const remainingPoints = rclProgressTotal - rclProgress;
  if (remainingPoints <= 0) return true;
  const ticksToRcl8 = remainingPoints / rate;
  // Months of ramp still to walk at the CURRENT step, this cycle.
  const stepsLeft = Math.ceil((SWEEP_MAX_PCT - state.pct) / SWEEP_STEP_PCT);
  return ticksToRcl8 < stepsLeft * SWEEP_MONTH_TICKS;
}

/**
 * Advance the sweep one step. Idempotent per boundary: called every tick, it
 * acts only on a month boundary it has not already handled, so a duplicate call
 * (or a retry after a skipped tick) cannot double-step the experiment.
 *
 * Returns the state when it advanced, undefined otherwise.
 */
export function advanceSweep(state: SpawnSweepState | undefined, ctx: SweepContext): SpawnSweepState | undefined {
  if (!state) return undefined;
  if (!isMonthBoundary(ctx.tick)) return undefined;
  if (state.lastBoundary === ctx.tick) return undefined; // already stepped this boundary

  const fast = shouldAccelerate(state, ctx);
  state.step = fast ? SWEEP_STEP_PCT_FAST : SWEEP_STEP_PCT;
  state.stepReason = fast ? "rcl8-projected-before-ramp-end" : "nominal";

  const next = state.pct + state.step;
  if (next > SWEEP_MAX_PCT) {
    // Wrap: a completed ramp is one cycle. Owner: "It can cycle back to zero
    // and around again if it does get all the way to the end."
    state.pct = 0;
    state.cycle += 1;
  } else {
    state.pct = next;
  }
  state.lastBoundary = ctx.tick;
  state.lastProgress = ctx.rclProgress;
  return state;
}
