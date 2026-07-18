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
export type SpawnRole =
  | "miner"
  | "hauler"
  | "upgrader"
  | "builder"
  | "scout"
  | "tanker"
  | "feeder"
  | "reserver"
  | "claimer"
  | "guard"
  | "buster"
  | "striker";

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
  /**
   * True when this demand exists because a live incumbent entered its
   * replacement lead window (staffsPost excluded it): the post is still
   * served TODAY but goes dark on schedule unless this body banks NOW.
   * Holds like `blocking` (mustFund) without being mislabeled an emergency -
   * measured on W2N6: without a hold, cheap demand streams kept the bank
   * under the replacement body's cost until the incumbent died, degrading
   * the delivery contract to reactive replacement plus a death-gap scramble.
   */
  replacement?: boolean;
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
   * Bank toward this demand whenever it is top-ranked and unaffordable, no
   * starvation wait - for indivisible income bodies (e.g. the reserver's
   * CLAIM pair) that cheaper demands would otherwise starve forever.
   */
  holdToFund?: boolean;
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
  /**
   * The TRANSITION this demand implements (spec 11 phase 3), when the corp
   * knows something the generic flags cannot express (e.g. HarvestCorp's
   * spawn-then-recycle upsizing). Left unset, the agenda derives a label
   * from the flags ({@link agendaWhy}). The scheduler does not interpret it.
   */
  why?: AgendaWhy;
}

// =============================================================================
// THE NOW PLAN (spec 11 phase 3) - the agenda as the transition contract
// =============================================================================

/**
 * Why an acquisition is on the agenda - the transition it implements. The
 * measured failure classes each get a name, so agenda-vs-actual violations
 * read as "the replacement never surfaced", not archaeology:
 *  - replacement: delivery contract - an incumbent entered its lead window
 *  - upsize:      spawn-then-recycle - a runt's strictly-bigger overlap body
 *  - campaign:    an indivisible funded op (reserver hold, expansion claim)
 *  - new-unit:    opening a fresh income unit (first miner of a source)
 *  - scale:       finishing a started unit (haulers, extra miners)
 *  - infra:       the local movers/intel tier (tender, feeder, scout)
 *  - consume:     consumers sized from stock (upgraders, builders)
 */
export type AgendaWhy = "replacement" | "upsize" | "campaign" | "new-unit" | "scale" | "infra" | "consume";

/** One published acquisition on a spawn's agenda (Memory.spawnAgenda queue). */
export interface AgendaEntry {
  role: string;
  corp: string;
  minCost: number;
  desiredCost: number;
  mustFund: boolean;
  why: AgendaWhy;
  /**
   * First tick the director saw this demand (0 = unstamped). Exported so a
   * capture can tell a starved-but-ignored demand (large age: ranking/buy
   * failure) from a resetting clock (age never accrues: demand flicker) -
   * the spec 15 S3 diagnosis.
   */
  since: number;
  /** "bank>=N" (head, unaffordable) or "after:<corpId>" (ordered behind). */
  precondition?: string;
}

const INFRA_ROLES = new Set<string>(["tanker", "feeder", "scout"]);

/** Derive the transition label for a demand (corp-provided `why` wins). */
export function agendaWhy(d: SpawnDemand): AgendaWhy {
  if (d.why) return d.why;
  if (d.replacement === true) return "replacement";
  if (d.holdToFund === true) return "campaign";
  if (INFRA_ROLES.has(d.role)) return "infra";
  if (d.producesIncome) return d.groupStarted === false ? "new-unit" : "scale";
  return "consume";
}

/**
 * Build the published agenda for one spawn: the ordered next acquisitions
 * under the scheduler's own ranking, each labeled with its transition and
 * precondition, plus the outstanding must-fund financing need. Pure - the
 * scheduler still makes its own decisions; deviations are SIGNAL.
 */
export function buildAgendaQueue(
  demands: SpawnDemand[],
  tick: number,
  energyAvailable: number
): { queue: AgendaEntry[]; fundingNeed: number } {
  const ranked = [...demands].sort((a, b) => effectivePriority(b, tick) - effectivePriority(a, tick));
  const queue = ranked.slice(0, 8).map((d, i): AgendaEntry => {
    const precondition =
      i === 0
        ? d.minCost > energyAvailable
          ? `bank>=${d.minCost}`
          : undefined
        : `after:${ranked[i - 1].buyerCorpId}`;
    return {
      role: d.role,
      corp: d.buyerCorpId,
      minCost: d.minCost,
      desiredCost: d.desiredCost,
      mustFund: d.blocking || d.replacement === true || d.holdToFund === true,
      why: agendaWhy(d),
      since: d.since,
      ...(precondition ? { precondition } : {})
    };
  });
  const fundingNeed = queue.reduce((sum, a) => sum + (a.mustFund ? a.minCost : 0), 0);
  return { queue, fundingNeed };
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
 *   1. income, BLOCKING - the critical path of EVERY source: its first miner
 *                         (without it the source is dead) and, once mined, its
 *                         first hauler (without it the energy strands). Across all
 *                         sources, so each source is brought online before any
 *                         source is fully fleshed out (breadth-first on income).
 *   2. income, scaling  - the 2nd+ hauler / 2nd miner that saturate an
 *                         already-producing-and-hauled source (depth, after breadth).
 *   3. consumption      - spend the leftover, once income is staffed.
 *
 * Within a tier the higher-VALUE corp/sink wins, so corps are ordered by
 * expected value. `groupStarted` is a SMALL tiebreak BELOW `blocking`: among
 * blocking demands it finishes a started source's first hauler before opening a
 * fresh source's first miner (don't strand a producing source's energy); among
 * scaling demands it finishes a started source first.
 *
 * The crucial ordering this encodes - and the bug it fixes - is that a fresh
 * source's FIRST MINER (income, blocking) outranks another source's SCALING
 * hauler (income, started, non-blocking). The old model put ALL started income
 * above ALL fresh income (STARTED >> URGENT), so one source's never-ending
 * scaling-hauler demand monopolised the spawn and a second source NEVER got a
 * miner (its energy zero) while the first was endlessly topped up. Putting
 * BLOCKING above STARTED makes every source get a miner + first hauler before any
 * source is scaled - the user-visible "one source piles un-hauled, the other has
 * no miner, the controller starves" all trace back to that monopoly.
 *
 * The tier gaps (1e6 >> 1e4 >> 1e3 >> value~50-110) are pure separators, not
 * tunables. At cold start no corp is started, so the colony's first miner (income,
 * blocking) leads.
 */
export function spawnPriority(demand: SpawnDemand): number {
  const INCOME_TIER = 1_000_000;
  const BLOCKING = 10_000; // first miner of ANY source / first hauler of a started one - the critical path
  const STARTED = 1_000; // tiebreak WITHIN a blocking class: finish a started source before a fresh one
  let p = demand.value; // base corp/sink value, ~50-110
  if (demand.groupId !== undefined && demand.producesIncome) {
    p += INCOME_TIER;
    if (demand.blocking) p += BLOCKING;
    if (demand.groupStarted) p += STARTED;
  } else if (demand.blocking) {
    // Non-income critical work (the first upgrader holding the controller against
    // downgrade): above idle consumption, but still below all income.
    p += STARTED;
  }
  return p;
}

/**
 * Ticks a demand may go unmet before anti-starvation lifts it above the income
 * tier for one spawn. Long enough that it never disturbs the normal income-first
 * ordering during a healthy ramp (income demands clear in far fewer ticks), short
 * enough that a chronically-outranked consumer (a builder whose room is busy
 * spawning remote income every tick) is not stranded forever - the bug this fixes:
 * the bot places a construction site, but the value-95 builder never wins a spawn
 * slot against the +1e6 income tier, so the site sits unbuilt indefinitely.
 */
const STARVATION_THRESHOLD = 300;

/**
 * Priority a starved demand is lifted to: strictly ABOVE the income tiers (1e6 +
 * blocking 1e4), so a demand ignored past the threshold gets exactly ONE
 * guaranteed spawn. It is a one-shot: once the creep exists the demand stops
 * reappearing and its age resets, so this preempts a critical income creep for at
 * most a single tick after a long starvation - the whole point of the backstop.
 */
const STARVED_TIER = 3_000_000;

/**
 * Anti-starvation boost for a demand the director has been seeing for too long.
 * `since` is the first tick the demand was observed (0 when unstamped - the pure
 * unit/harness paths leave it 0, so they are unaffected). Returns 0 until the
 * demand has waited {@link STARVATION_THRESHOLD} ticks, then {@link STARVED_TIER}.
 * Only exactly-0 means unstamped: a NEGATIVE since is a legitimately ancient
 * stamp (test worlds backdate below the young sim clock; prod Game.time is
 * always positive), and `<= 0` here silently disarmed the boost in early-game
 * worlds - the starved one-shot only worked when its batch slot happened to
 * start late on the shared server clock.
 */
export function starvationBoost(demand: SpawnDemand, tick: number): number {
  if (!demand.since) return 0;
  return tick - demand.since >= STARVATION_THRESHOLD ? STARVED_TIER : 0;
}

/**
 * Spawn priority including the anti-starvation backstop - THE value both the
 * buy walk and the published agenda rank on (one function, so the NOW plan can
 * never show an order the scheduler won't follow).
 *
 * Inside the starved tier, AGE decides - oldest first - NOT the base income
 * tier. A flat boost preserved income-over-infra ordering among the starved,
 * which vacates the "one guaranteed slot" promise whenever starvation is not
 * singular: under a fleet-wide rebuild, "scale" hauler demands are a
 * self-renewing stream that all cross the threshold, and consumers/infra
 * starve INSIDE the backstop (live incident t72403765: tender age 1371 held
 * at queue position 4 behind starved haulers aged <=1134, receipts showing
 * four hauler buys in ~160t; upgrader age 1023 at position 6 - the colony's
 * progress itself queued behind the stream). FIFO among the starved makes the
 * guarantee real: every demand that crosses the threshold is reached in
 * bounded time.
 */
export function effectivePriority(demand: SpawnDemand, tick: number): number {
  const starved = starvationBoost(demand, tick);
  return starved > 0 ? starved + (tick - demand.since) : spawnPriority(demand);
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

  // Rank on EFFECTIVE priority (base tier + anti-starvation age boost). A demand
  // that has waited past the threshold is lifted above the income tier, so the
  // walk below reaches it - affordable and on top - before any blocking income
  // demand can hold the spawn, giving the long-starved creep its one guaranteed slot.
  const ranked = [...eligible].sort((a, b) => effectivePriority(b, ctx.tick) - effectivePriority(a, ctx.tick));

  // Set once we pass a blocking demand we cannot afford yet but the room can
  // eventually build. From then on we decline to spend the dribble on
  // lower-priority creeps, letting the spawn fill for the blocking demand.
  let holdForBlocking = false;
  // Strict hold: the blocking demand we are waiting on is itself an income
  // PRODUCER, so energy is already being mined/moved by incumbents - nothing
  // lower may spend, the bank must reach the held body. A held CONSUMER
  // (upgrader) is not strict: a lower affordable income producer still
  // spawns, because at income 0 the consumer can never be afforded without
  // it (the cold-start deadlock).
  let holdStrict = false;
  // A hold raised INSIDE the starved tier is deferred until the walk crosses
  // the tier boundary. Within the tier no demand may wall out another: the
  // backstop's bounded-time promise is per-STARVED-demand, and (measured:
  // flow-handoff on the first FIFO build, zero flow creeps by t600) a cold
  // start seeds every demand in the same tick, so the oldest unaffordable
  // must-fund head hard-exited the walk while affordable starved demands sat
  // behind it. The tier drains itself one purchase at a time - each buy
  // resets that stream's clock (resetDemandClock) and drops it below the
  // tier - so the deferred body's bank still accumulates once the tier empties.
  let starvedHoldPending = false;
  let starvedHoldStrict = false;

  for (const demand of ranked) {
    const starved = starvationBoost(demand, ctx.tick) > 0;
    // Crossing the starved-tier boundary (ranking puts every starved demand
    // first): a deferred starved hold becomes a real one here, protecting
    // the accumulating bank from the fresh tiers exactly as a direct hold
    // would have.
    if (!starved && starvedHoldPending) {
      starvedHoldPending = false;
      if (ctx.energyIncome > 0) return null;
      holdForBlocking = true;
      holdStrict = holdStrict || starvedHoldStrict;
    }
    if (ctx.energyAvailable >= demand.minCost) {
      // While holding for an unaffordable blocking demand, decline EVERY
      // lower-priority spend - blocking ones included. The old rule let any
      // blocking demand through, assuming blocking demands are few and
      // precious; the tender/construction era made them a STREAM (0-WORK
      // feeder tankers at 100-150 with blockingWhenEmpty, cheap first
      // haulers at 200) that drained the bank every time it approached the
      // held miner's 700 body - measured on W2N6: the second home source's
      // miner never fielded in 3000 ticks while cheap blocking spawns fired
      // continuously. Lower demands wait the bounded ~100 ticks the held
      // body needs to bank ("fund one corp fully", applied consistently);
      // income keeps flowing because the incumbents that earn it are already
      // fielded, and anything that outranks the held demand already had its
      // chance earlier in this walk. The one exception: under a NON-strict
      // hold (held demand is a consumer), a lower income PRODUCER still
      // spawns - see holdStrict above.
      if (holdForBlocking && (holdStrict || !demand.producesIncome)) continue;
      const energyBudget = Math.min(demand.desiredCost, ctx.energyAvailable);
      return {
        demand,
        energyBudget,
        reason: energyBudget >= demand.desiredCost ? "afford-desired" : "afford-min-scaled"
      };
    }

    // Cannot afford even the minimum body for this demand.
    const canEverAfford = ctx.energyCapacity >= demand.minCost;
    // A starved INCOME demand gains hold semantics: the one-guaranteed-spawn
    // promise is empty for a demand whose minCost exceeds the current dribble
    // (measured: at 300 capacity a scaling hauler, min 300, lost the 200-299
    // band to cheaper demands for 700+ ticks while its source's energy
    // stranded; grid cell plan-t1-single-source-loop). Holding makes the
    // backstop real where it protects ENERGY THROUGHPUT.
    //
    // Starved CONSUMERS (builders/upgraders) deliberately do NOT hold: they
    // keep only the rank lift - one guaranteed slot the moment they are
    // affordable. Holding the spawn for a consumer stalls the fleet-first
    // investment strategy (owner directive: energy is the leading cold-start
    // metric; measured cost of consumer holds was ~2x cp@3000 and a smaller
    // fleet at every sample).
    //
    // INCOME demands hold when starved (the no-stranding backstop) or when
    // they declare holdToFund (indivisible bodies like the reserver's CLAIM
    // pair, where without a hold every cheaper hauler eats the bank first
    // and the ranking is moot - measured, diag-reserver). A BLANKET income
    // hold was tried and measurably cost ~12% mined energy in the two-source
    // A/B: it parks the spawn for 700-cost miner top-ups that fleet-first
    // tempo should not wait on.
    const fundableIncome = demand.producesIncome && (demand.holdToFund === true || starved);
    const mustFund = demand.blocking || demand.replacement === true || fundableIncome;
    if (mustFund && canEverAfford) {
      if (starved) {
        // Defer: no walls inside the starved tier (see starvedHoldPending).
        starvedHoldPending = true;
        starvedHoldStrict = starvedHoldStrict || demand.producesIncome;
      } else if (ctx.energyIncome > 0) {
        // Energy is flowing in - just hold the spawn for this blocking demand
        // instead of spending on something less important.
        return null;
      } else {
        // No income measured this tick: hold anyway. The dribble accumulates
        // toward this body; lower demands wait (see the decline above).
        holdForBlocking = true;
        if (demand.producesIncome) holdStrict = true;
      }
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
