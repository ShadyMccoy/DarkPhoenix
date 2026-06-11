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
   * remains is to finish staffing it. {@link spawnPriority} ranks such demands
   * above fresh income corps so the spawn completes a started income unit before
   * opening a brand-new one.
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

/**
 * Spawn priority of a single demand - higher spawns first. Strictly TIERED, so
 * the order is obvious and needs no tuning (this replaces the old additive soup
 * of blocking + completion + aging boosts that no one could reason about):
 *
 *   1. income corp, already started   - finish what's underway (its haulers /
 *                                        a second miner) before anything else
 *   2. income corp, fresh             - open the next source's first miner
 *   3. consumption (upgrade/build/...) - spend the leftover, once income is staffed
 *
 * Within a tier the higher-VALUE corp/sink wins, so income corps are opened and
 * completed in expected-value order. Within one corp `blocking` nudges the urgent
 * demand ahead (a mining source with no hauler stranding its energy; the first
 * upgrader that keeps the controller alive). That is the entire strategy: rank
 * income corps by value, staff the top one to completion before the next, consume
 * only what income leaves - with no boosts to balance and no aging to drift.
 *
 * The tier gaps (1e6 >> 1e4 >> 1e3 >> value~50-110) are pure separators, not
 * tunables: a started corp always outranks a fresh one, income always outranks
 * consumption, regardless of the raw values involved. At cold start no corp is
 * started, so the colony's first miner (tier 2) leads.
 */
export function spawnPriority(demand: SpawnDemand): number {
  const INCOME_TIER = 1_000_000;
  const STARTED = 10_000;
  const URGENT = 1_000; // first hauler (stranded energy) / first upgrader (anti-downgrade)
  let p = demand.value; // base corp/sink value, ~50-110
  if (demand.blocking) p += URGENT;
  if (demand.groupId !== undefined && demand.producesIncome) {
    p += INCOME_TIER;
    if (demand.groupStarted) p += STARTED;
  }
  return p;
}

/**
 * Choose the single best creep to spawn now, or return null to spawn nothing
 * this tick (either there is no demand, or it is worth waiting for the spawn to
 * fill).
 *
 * Decision procedure:
 *  1. Rank demands by {@link spawnPriority} (a started income corp's remaining
 *     staffing outranks opening a fresh source, which outranks consumption).
 *  2. Walk from highest priority:
 *     - If we can afford the demand's minimum body, spawn it now, spending up
 *       to its desired cost (capped by available energy) - UNLESS we are holding
 *       the spawn for a higher-ranked blocking demand we cannot yet afford, in
 *       which case we only spend on another *blocking* demand (never on a lower
 *       non-blocking creep) so energy keeps accumulating for the blocking one.
 *     - If a *blocking* demand the room can eventually afford is unaffordable
 *       right now, hold the spawn for it: directly when energy is flowing
 *       (income > 0), or - even at income == 0 - by refusing to spend the dribble
 *       on lower-priority non-blocking creeps. The latter is what breaks the
 *       first-hauler deadlock: a freshly-mining source's blocking hauler costs
 *       more than a near-empty spawn holds, and if we kept funding extra miners /
 *       upgraders the spawn would never accumulate the hauler's body. Cold-start
 *       income is supplied by the bootstrap corp (which spawns its jacks
 *       directly, ahead of this scheduler), so holding here cannot deadlock the
 *       very first creep.
 */
export function scheduleSpawn(demands: SpawnDemand[], ctx: ScheduleContext): ScheduleResult | null {
  if (demands.length === 0) return null;

  // Within a mining unit the miner is a prerequisite for its haulers: while a
  // source still has an unmet miner demand, hold back that source's haulers so
  // the miner is staffed first. Otherwise a hauler can outrank its own miner on
  // raw value and get funded with nothing to pick up.
  const eligible = withMinerPrecedence(demands);

  const ranked = [...eligible].sort((a, b) => spawnPriority(b) - spawnPriority(a));

  // Set once we pass a blocking demand we cannot afford yet but the room can
  // eventually build. From then on we decline to spend the dribble on
  // lower-priority creeps, letting the spawn fill for the blocking demand.
  let holdForBlocking = false;
  // Strict hold: the blocking demand we are waiting on is itself an income
  // PRODUCER (a hauler), which means energy is already being mined and just
  // needs moving - spawning more producers would not help, so even an affordable
  // income producer must wait. When the blocking demand is a consumer (upgrader)
  // we are NOT strict: an affordable income producer still spawns, because we
  // need income flowing before the consumer can ever be afforded (cold start).
  let holdStrict = false;

  for (const demand of ranked) {
    if (ctx.energyAvailable >= demand.minCost) {
      // While holding for an unaffordable blocking demand, decline lower-priority
      // creeps that would bleed the spawn back below the body we are accumulating
      // for. A blocking demand always spends; a non-blocking income producer
      // spends only when the hold is not strict (see holdStrict).
      if (holdForBlocking && !demand.blocking && (holdStrict || !demand.producesIncome)) continue;
      const energyBudget = Math.min(demand.desiredCost, ctx.energyAvailable);
      return {
        demand,
        energyBudget,
        reason: energyBudget >= demand.desiredCost ? "afford-desired" : "afford-min-scaled"
      };
    }

    // Cannot afford even the minimum body for this demand.
    const canEverAfford = ctx.energyCapacity >= demand.minCost;
    if (demand.blocking && canEverAfford) {
      if (ctx.energyIncome > 0) {
        // Energy is flowing in - just hold the spawn for this blocking demand
        // instead of spending on something less important.
        return null;
      }
      // No income yet: don't spend the dribble on lower-priority creeps. Keep
      // scanning in case a lower-ranked demand we DO allow is affordable (a
      // blocking demand always; an income producer when the hold is not strict),
      // which still makes progress; otherwise we fall through to the final hold.
      holdForBlocking = true;
      if (demand.producesIncome) holdStrict = true;
    }
    // Otherwise, let a lower-value but affordable demand have a turn.
  }

  return null;
}

/**
 * Drop hauler demands whose source has NO miner in the field (`groupStarted` is
 * false) - a hauler with no miner has nothing to carry, so it must never spawn.
 * This is the single invariant behind "no hauler without a staffed miner": it
 * fires on the source's mining state directly, so it catches BOTH a source whose
 * miner is still being staffed AND an orphan hauler whose source has no miner
 * demand at all (e.g. a remote source the miner-profitability gate rejected) -
 * the "green haulers parked at minerless sources in every room" failure. Once a
 * miner is mining (`groupStarted`), its haulers proceed even while a bigger/second
 * miner is still wanted. Demands with no groupId (non-source roles) pass through.
 * Pure, so it can be unit tested.
 */
export function withMinerPrecedence(demands: SpawnDemand[]): SpawnDemand[] {
  return demands.filter(d => !(d.role === "hauler" && d.groupId !== undefined && d.groupStarted === false));
}
