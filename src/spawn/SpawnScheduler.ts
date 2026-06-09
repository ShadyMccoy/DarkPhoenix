/**
 * @fileoverview Spawn scheduler.
 *
 * The colony has a single scarce resource at the heart of its economy: spawn
 * time + spawn energy. Historically there was no real scheduler - corps pushed
 * orders into a queue that was drained by a fixed type priority
 * (miner > hauler > upgrader > ...) and throttled by an arbitrary "max 2
 * pending" gate. That starves whichever creep happens to sit low in the fixed
 * order: in practice the upgrader (the thing that actually drives RCL) could
 * never win spawn energy against an endless trickle of mining orders, so the
 * colony stalled.
 *
 * This module replaces that with a demand-driven scheduler. Every producing
 * corp declares what it wants as a {@link SpawnDemand} carrying a flow-derived
 * marginal value, a desired and a minimum-useful body cost, and whether the
 * economy is blocked without it. Each tick the scheduler picks the single best
 * creep to spawn for a given spawn, deciding both WHAT to spawn and HOW MUCH
 * energy to spend on it - including the option to wait (let the spawn fill) for
 * a high-value blocking creep instead of always spending immediately on the
 * cheapest thing available.
 *
 * The scheduler is intentionally pure (no Screeps globals) so it can be unit
 * tested directly. The executor (SpawningCorp) turns a {@link ScheduleResult}
 * into an actual body + spawnCreep call.
 *
 * @module spawn/SpawnScheduler
 */

/** Roles the scheduler knows how to rank and size. */
export type SpawnRole = "miner" | "hauler" | "upgrader" | "builder" | "scout" | "tanker" | "reserver";

/**
 * A request for one creep, declared by a producing corp.
 *
 * Costs are in energy. The scheduler reasons in energy cost (so it can make
 * affordability / wait decisions); the executor maps the granted energy budget
 * to an actual body via the body builders.
 */
export interface SpawnDemand {
  /** Corp that will own the spawned creep. */
  buyerCorpId: string;
  /** What kind of creep. Also tells the executor which body builder to use. */
  role: SpawnRole;
  /**
   * Marginal value to the colony of fulfilling this demand right now. Higher
   * wins. Derived from the flow solution (sink allocation priority, unblocking
   * value of a stranded source, etc.).
   */
  value: number;
  /** True if the colony's economy is stalled until this creep exists. */
  blocking: boolean;
  /** True if this creep increases energy delivery (miner/hauler). */
  producesIncome: boolean;
  /**
   * Identifier of the funding group this demand belongs to - the income "unit"
   * the scheduler funds as a whole (e.g. a source: its miner and that source's
   * haulers share one groupId). Demands without a group default to standing
   * alone. Used to implement the "fund one corp fully before opening the next"
   * strategy.
   */
  groupId?: string;
  /**
   * True when this demand's group is already underway - it has its bootstrap
   * producer in the field (e.g. the source is already being mined) and what
   * remains is to finish staffing it. Such demands are boosted so the spawn
   * completes a started income unit before opening a brand-new one. See
   * {@link COMPLETION_BOOST}.
   */
  groupStarted?: boolean;
  /** Ideal body cost given the flow demand. */
  desiredCost: number;
  /** Smallest body cost still worth spawning (enables "small now, scale later"). */
  minCost: number;
  /** Tick the demand was first observed, for anti-starvation aging. */
  since: number;
  /**
   * Opaque body-sizing hint passed through to the executor (e.g. desired WORK
   * for a miner, desired CARRY for a hauler). The scheduler does not interpret
   * it.
   */
  bodyParam?: number;
  /** Hauler CARRY:MOVE ratio hint, passed through to the executor. */
  haulerRatio?: "2:1" | "1:1" | "1:2";
  /**
   * Body-shape strategy hint passed through to the executor (e.g. an upgrader's
   * "mobile" vs "containerFed" supply strategy). The scheduler does not interpret it.
   */
  bodyStrategy?: string;
}

/**
 * Context passed to a corp's getSpawnDemand(). Kept minimal so the methods stay
 * self-contained and unit-testable. The scheduler/director fills in the `since`
 * timestamps for aging, so corps return demands with `since` left at 0.
 */
export interface SpawnDemandContext {
  /** Maximum energy the room can hold for spawning (spawn + extensions). */
  energyCapacity: number;
  /** Current game tick. */
  tick: number;
}

/** Live spawn/economy state the scheduler needs to make a decision. */
export interface ScheduleContext {
  /** Energy currently available in the spawn + extensions. */
  energyAvailable: number;
  /** Maximum energy the room can hold for spawning (spawn + extensions). */
  energyCapacity: number;
  /** Estimated energy/tick arriving into the spawn network. */
  energyIncome: number;
  /** Current game tick. */
  tick: number;
}

/** The scheduler's decision: which demand to spawn and the energy budget for it. */
export interface ScheduleResult {
  demand: SpawnDemand;
  /** Energy the executor may spend on the body (>= demand.minCost). */
  energyBudget: number;
  /** Human-readable explanation, for logging/debugging. */
  reason: string;
}

/** How much a demand's effective value grows per tick spent waiting. */
export const AGING_VALUE_PER_TICK = 0.5;

/**
 * How much to boost a demand that *completes an already-started income unit*
 * (a source that is already being mined and now needs its haulers, or a second
 * miner). This is the "fund one corp fully before opening the next" strategy:
 * the spawn should finish staffing the source it has already started - getting
 * that energy actually hauled home - before it spends spawn time opening a
 * fresh source whose energy will just strand unhauled. This was the root of the
 * "lots of remote miners going out, little energy coming back" failure: a fresh
 * source's first miner (base value) used to outrank an already-mined source's
 * remaining haulers, so the colony kept opening sources it never finished.
 *
 * The boost is sized to sit *above* the base values of the economy
 * (miner/hauler/builder/upgrader are all ~90-110) so completion wins decisively
 * over opening, yet *below* {@link effectiveValue}'s blocking boost (1000) so a
 * genuinely blocking bootstrap demand (the colony's first miner, the first
 * upgrader that keeps the controller alive) still comes first.
 */
export const COMPLETION_BOOST = 150;

/**
 * Effective value used for ranking: base value, a large boost for blocking
 * demands, a boost for completing an already-started income unit (see
 * {@link COMPLETION_BOOST}), plus anti-starvation aging so a demand that keeps
 * losing eventually wins.
 */
export function effectiveValue(demand: SpawnDemand, tick: number): number {
  const BLOCKING_BOOST = 1000;
  const age = Math.max(0, tick - demand.since);
  const completing = demand.producesIncome && demand.groupStarted ? COMPLETION_BOOST : 0;
  return (
    demand.value +
    (demand.blocking ? BLOCKING_BOOST : 0) +
    completing +
    AGING_VALUE_PER_TICK * age
  );
}

/**
 * Choose the single best creep to spawn now, or return null to spawn nothing
 * this tick (either there is no demand, or it is worth waiting for the spawn to
 * fill).
 *
 * Decision procedure:
 *  1. Rank demands by {@link effectiveValue} (blocking + completion + aging
 *     aware - so a started income unit's remaining staffing outranks opening a
 *     fresh one; see {@link COMPLETION_BOOST}).
 *  2. Walk from highest value:
 *     - If we can afford the demand's minimum body, spawn it now, spending up
 *       to its desired cost (capped by available energy).
 *     - Otherwise, if it is a *blocking* demand that the room can eventually
 *       afford AND energy is actually flowing in (income > 0), wait: hold the
 *       spawn so energy accumulates for it, rather than spending on a
 *       lower-value creep. This is what lets the upgrader win against a steady
 *       trickle of mining orders.
 *     - Otherwise skip it and consider the next demand. In particular, when no
 *       energy is coming in yet (income == 0) we never wait - we fall through to
 *       spawn whatever affordable income producer gets the economy moving.
 */
export function scheduleSpawn(
  demands: SpawnDemand[],
  ctx: ScheduleContext
): ScheduleResult | null {
  if (demands.length === 0) return null;

  const ranked = [...demands].sort(
    (a, b) => effectiveValue(b, ctx.tick) - effectiveValue(a, ctx.tick)
  );

  for (const demand of ranked) {
    if (ctx.energyAvailable >= demand.minCost) {
      const energyBudget = Math.min(demand.desiredCost, ctx.energyAvailable);
      return {
        demand,
        energyBudget,
        reason:
          energyBudget >= demand.desiredCost
            ? "afford-desired"
            : "afford-min-scaled",
      };
    }

    // Cannot afford even the minimum body for this demand.
    const canEverAfford = ctx.energyCapacity >= demand.minCost;
    const worthWaiting = demand.blocking && canEverAfford && ctx.energyIncome > 0;
    if (worthWaiting) {
      // Hold the spawn for this high-value blocking demand instead of spending
      // energy on something less important.
      return null;
    }
    // Otherwise, let a lower-value but affordable demand have a turn.
  }

  return null;
}
