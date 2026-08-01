/**
 * @fileoverview Canonical economic primitives for the colony economy.
 *
 * ONE definition of every per-tick economic quantity the planner and corps reason
 * about. Before this module these formulas were copy-pasted across FlowTypes,
 * FlowSolver, EconomyPlanner, EconomyAdapter, ConstructionCorp, BodyBuilder,
 * EdgeVariant and FlowEdge - with subtle divergences (fixed CREEP_LIFETIME vs
 * life-minus-travel, +2 vs +4 round-trip, etc.). Everything economic now derives
 * from here so the numbers cannot drift apart.
 *
 * The semantics match the live planner (CorpPlanner): a creep posted
 * `distance` tiles from its spawn loses ~`distance` ticks walking out, so its
 * spawn cost is amortised over `effectiveLife(distance)`, not the full lifetime.
 *
 * @module economy/primitives
 */

// ---------------------------------------------------------------------------
// Screeps ground-truth constants - the founding numbers every formula below
// derives from. Homed HERE (spec 35 phase B inverted the audited debt: this
// module used to import them from flow/FlowTypes, corps/economics and the
// retired planning/EconomicConstants). flow/FlowTypes and corps/economics
// re-export from here so legacy import paths keep working for one release.
// ---------------------------------------------------------------------------

/**
 * Body part costs (Screeps BODYPART_COST). The full 8-part table, so every
 * body-cost consumer can converge on the ONE home; the economic formulas
 * below use only the WORK/CARRY/MOVE trio.
 */
export const BODY_COSTS = {
  WORK: 100,
  CARRY: 50,
  MOVE: 50,
  ATTACK: 80,
  RANGED_ATTACK: 150,
  HEAL: 250,
  CLAIM: 600,
  TOUGH: 10
} as const;

/** Creep lifetime in ticks */
export const CREEP_LIFETIME = 1500;

/** Standard miner: 5W 3M */
export const MINER_COST = 5 * BODY_COSTS.WORK + 3 * BODY_COSTS.MOVE; // 650
/** Body parts of a standard miner (5 WORK + 3 MOVE), for spawn build-time costing. */
export const MINER_PARTS = 8;

/**
 * Ticks to spawn one body part (Screeps constant)
 */
export const SPAWN_TIME_PER_PART = 3;

/**
 * Body parts a single spawn can build per tick. A spawn produces one part every
 * SPAWN_TIME_PER_PART (3) ticks, so this is 1/3 - i.e. 500 parts over a creep's
 * 1500-tick life. It is the spawn's *time* budget, separate from and often
 * tighter than its energy budget: a far source can stay net-energy-positive yet
 * demand more hauler parts than the spawn can physically build. Corps compete for
 * this budget the same way they compete for energy, so a source that is too far
 * loses the competition and falls out - no hard distance limit required.
 */
export const SPAWN_PARTS_PER_TICK = 1 / 3;

/**
 * Lifetime of a creep carrying a CLAIM part (CREEP_CLAIM_LIFE_TIME). Reservers
 * live only 600 ticks, not 1500 - a big part of why the reserver toll is steep.
 */
export const CLAIM_LIFETIME = 600;

/**
 * Reserver duty cycle. A reservation accumulates (to 5000) and decays 1/tick, so a
 * reserver need not be present continuously - let it build up, let it tick down,
 * then top up. ~50% duty roughly halves the amortized cost.
 *
 * Reserver BODY models in play (documented, not reconciled - spec 35 phase B
 * moves homes, never values): the LIVE spawned body is reservationKind.body()
 * -> buildReserverBody(energyBudget, 2) - up to 2 CLAIM + 2 MOVE (1300),
 * degrading to 1 CLAIM + 1 MOVE when capacity affords only one pair.
 * infraSpawnLoad below prices the standing fleet at that full-budget 4-part
 * body (RESERVER_PARTS_PER_ROOM = 4), while corps/economics.RESERVER_BODY_COST
 * (650) deliberately prices the MINIMUM viable 1 CLAIM + 1 MOVE body - the
 * couldReserve affordability floor in IncrementalAnalysis.
 */
export const RESERVER_DUTY = 0.5;

/** CARRY part capacity (energy a CARRY part holds). */
export const CARRY_CAPACITY = 50;

/**
 * Energy cost of one CARRY + MOVE pair (100) - the unit every hauler-shaped
 * body scales by. ONE home for the PART_PAIR/PART_PAIR_COST locals the mover
 * corps used to re-declare.
 */
export const CARRY_MOVE_PAIR_COST = BODY_COSTS.CARRY + BODY_COSTS.MOVE; // 100

/** Source energy capacity in claimed rooms (Screeps constant) */
export const SOURCE_ENERGY_CAPACITY = 3000;

/** Source regeneration time in ticks (Screeps constant) */
export const SOURCE_REGEN_TIME = 300;

/** Energy/tick a standard source yields (3000 capacity / 300 regen). */
export const SOURCE_RATE = SOURCE_ENERGY_CAPACITY / SOURCE_REGEN_TIME; // 10

/**
 * Unhauled buffer at a source's mouth (container + ground pile, the
 * sourceBufferStock lens) at or above which buying ANOTHER miner body is
 * deferred (owner directive 2026-07-29). 2000 is the container cap: a buffer
 * pinned there means mining already outruns hauling (the sourceBuffers
 * telemetry diagnostic, owner 2026-07-20; ~8.5k measured rotting above the
 * cap, t72588289), so a new body buys rot, not income. Scarcity acts at the
 * SPAWN: standing miners keep working, haulers stay ungated (they are the
 * release), and demand resumes the tick the buffer drains below this line.
 */
export const SOURCE_BUFFER_DEFER_THRESHOLD = 2000;

/**
 * Priority penalty on a miner demand whose source mouth is saturated (owner
 * redesign 2026-07-29). The first implementation SUPPRESSED the demand, which
 * is the wrong class per doctrine - "scarcity acts at the SPAWN (defund: no
 * NEW bodies, via priority), and the planner prices - it doesn't gate" - and
 * it cost two measured failures: two live sources went DARK behind their own
 * piles when their miners EOL'd (E6 FAIL t72658948, income stopped), and the
 * runt UPSIZE was blocked whenever a bootstrap pile crossed the line,
 * reviving the documented runt equilibrium (~40% source output forever) and
 * making the runt-economy cell flaky.
 *
 * Now the demand always stands and only loses PRIORITY. Sized to exceed the
 * whole within-tier value spread (miner value = 100 + efficiency*0.5, so
 * 100..150): at 100 a piled source's miner sits below EVERY clear source's
 * miner, so scarce spawn parts go to mouths that can still move their energy,
 * while an idle spawn with nothing better to buy still re-staffs the source.
 * The tier separators (income 1e6, blocking 1e4) are untouched - they are
 * documented as separators, not tunables.
 */
export const SOURCE_BUFFER_PRIORITY_PENALTY = 100;

/**
 * Energy/tick credited per delivering creep by the scheduler's crude income
 * estimate (SpawnDirector.estimateIncome): one deliverer ~ one source's worth
 * (SOURCE_RATE). The scheduler only reads the positive/zero signal - whether
 * it is safe to wait for a blocking demand versus spawning income first - so
 * this is a nominal rate, not a measurement.
 */
export const DELIVERER_INCOME_RATE = SOURCE_RATE; // 10

/** Energy/tick a single WORK part moves, by work class (Screeps *_POWER). */
export const HARVEST_ENERGY_PER_WORK = 2; // HARVEST_POWER: 2 energy/tick per WORK
export const UPGRADE_ENERGY_PER_WORK = 1; // UPGRADE_CONTROLLER_POWER: 1 energy/tick per WORK
export const BUILD_ENERGY_PER_WORK = 5; // BUILD_POWER: 5 energy/tick per WORK

/**
 * WORK parts needed to move `energyPerTick` at `energyPerWork` energy/tick per
 * WORK - the single conversion behind every "energy rate -> WORK body" figure
 * (miner harvest, upgrader burn, builder burn). Rounded up: a fractional WORK
 * cannot be spawned. Zero/negative rate -> 0 parts.
 */
export function workPartsForEnergyRate(energyPerTick: number, energyPerWork: number): number {
  if (energyPerTick <= 0) return 0;
  return Math.ceil(energyPerTick / energyPerWork);
}

/**
 * Effective working life (ticks) of a creep posted `distance` tiles from its
 * spawn. It spends ~`distance` ticks walking to its post before it can work or
 * be replaced, so its build cost is amortised over the remainder. Floored at 1
 * so overhead stays finite for absurd distances.
 */
export function effectiveLife(distance: number): number {
  return Math.max(1, CREEP_LIFETIME - distance);
}

/**
 * Round-trip travel time (ticks) for a hauler covering `distance` tiles each way,
 * plus 2 ticks to load and unload. A 1:1 CARRY:MOVE hauler moves at full speed
 * both ways, so the trip is symmetric.
 */
export function roundTripTicks(distance: number): number {
  return 2 * distance + 2;
}

/**
 * CARRY parts needed to keep `rate` energy/tick in flight across `distance`.
 * carry = rate * roundTrip / CARRY_CAPACITY. Continuous (fractional); callers
 * round up when sizing an actual body.
 */
export function carryPartsFor(rate: number, distance: number): number {
  return (rate * roundTripTicks(distance)) / CARRY_CAPACITY;
}

/**
 * CARRY(+MOVE) pairs a single hauler-shaped body can be built with from
 * `energyBudget`: budget-capped whole pairs, hard-capped at 25 (the 50-part
 * body limit at 1 MOVE per CARRY), floored at one pair (the executor's energy
 * check rejects an unaffordable spawn; sizing never shrinks below a viable
 * body). ONE cap formula for the hauler/tender/feeder demand sizers.
 */
export function maxCarryPairs(energyBudget: number): number {
  return Math.max(1, Math.min(Math.floor(energyBudget / CARRY_MOVE_PAIR_COST), 25));
}

/**
 * CARRY parts ONE hauler should be built with to serve a route needing
 * `carryNeeded` total, at a room of `energyBudget` capacity: the even share of
 * the route across the smallest fleet that can cover it. Never above
 * maxCarryPairs by construction, and - the point - never above what the ROUTE
 * itself can load.
 *
 * The distinction this primitive exists to hold (production audit 2026-07-31,
 * t72695674): a hauler's right size is a property of its ROUTE, not of the
 * room's spawn capacity. Both hauler sizers used to reference maxCarryPairs
 * alone, which at RCL7 (capacity 5600 -> 25 pairs) made every body under 25
 * CARRY read as "under-built" no matter how small its route. The measured
 * result was a standing churn loop on short routes: the demand path rebuilt a
 * 7-CARRY route's hauler at 25 CARRY (2500e for a 700e job) and the recycle
 * path retired the adequate 8-CARRY incumbent that covered it, on every tick
 * the spawn happened to be flush. F1 read hauler spawn load 0.471 p/t against
 * a plan of 0.225 - and under a saturated spawn those parts come out of the
 * upgraders' build time (P7 controller delivery 0.44x plan).
 */
export function haulerBodyCarry(energyBudget: number, carryNeeded: number): number {
  const maxPer = maxCarryPairs(energyBudget);
  const fleet = Math.max(1, Math.ceil(carryNeeded / maxPer));
  return Math.max(1, Math.min(maxPer, Math.ceil(carryNeeded / fleet)));
}

/**
 * CARRY parts to sustain `rate` energy/tick at a PARKED relay post - a creep
 * standing adjacent to both its bank and its sink (the link-fed controller
 * feeder: storage on one side, core link on the other; owner 2026-07-22 "The
 * feeder doesn't move at all"). The cycle is withdraw tick + transfer tick with
 * zero travel, so carry = rate * 2 / CARRY_CAPACITY - roundTripTicks(1) would
 * charge two phantom travel ticks and double the body. Continuous (fractional);
 * callers round up when sizing an actual body.
 */
export const PARKED_RELAY_CYCLE_TICKS = 2;
export function parkedRelayCarry(rate: number): number {
  return (rate * PARKED_RELAY_CYCLE_TICKS) / CARRY_CAPACITY;
}

// =============================================================================
// OPERATION CORPS (spec 34): consumer buffers and the supply-method crossover
// =============================================================================

/**
 * CARRY parts a CONSUMER carries as its onboard BUFFER: enough stock to keep
 * burning `burnRate` for `intervalTicks` between refuel events (spec 34 D2,
 * owner: "the carry is designed to carry it over in between refuelings").
 * ONE law for every consumer - a mobile consumer (builder) buffers on the
 * body because a container costs ~an extension and rots (C7), a parked one
 * is the degenerate case: parkedRelayCarry(r) === bufferCarryParts(r, 2).
 * Continuous (fractional); callers round up when sizing an actual body.
 */
export function bufferCarryParts(burnRate: number, intervalTicks: number): number {
  return (burnRate * intervalTicks) / CARRY_CAPACITY;
}

/**
 * Ticks between refuel events for a PARKED consumer whose fuel stands
 * `distance` away: `haulerCount` carriers working the supply vector land a
 * delivery every roundTrip/n. The n=0 form (the full round trip) is the
 * degenerate no-carrier cadence - adjacent direct-draw, where RT(d<=1) is a
 * couple of ticks. The owner's buffer inputs verbatim: "the distance back to
 * the energy source and how many haulers are working the route".
 */
export function refuelIntervalTicks(distance: number, haulerCount: number): number {
  return roundTripTicks(distance) / Math.max(1, haulerCount);
}

/**
 * Standing body parts of a dedicated supply vector `(fuel, site, rate)`:
 * carriers at 1:1 CARRY:MOVE (laden both ways is the worst case; the vector
 * IS carryPartsFor - no third formula).
 */
export function vectorSupplyParts(rate: number, distance: number): number {
  return 2 * carryPartsFor(rate, distance);
}

/**
 * The PRICED-OUT COUNTERFACTUAL (spec 34 D1): what a consumer would cost if
 * it fetched its own fuel from `distance` - which builders NEVER do (owner:
 * "builders don't MOVE the energy. they stay in one place building"). This
 * exists to PROVE the parked doctrine, not as a live mode: the fetcher's
 * WORK idles for the round trip (utilization u = T/(T+RT), so netting `rate`
 * needs 1/u the WORK - at 100e/part the game's most expensive idle) and its
 * buffer returns LADEN (C3: empty CARRY is fatigue-free, full is not), so
 * the CARRY pays MOVE. parts(T) = burn(T) * (2/w + T/25),
 * burn = rate*(1+RT/T), w = energy/WORK; minimizing gives T* = sqrt(50*RT/w).
 * Even at its optimum it loses to the vector from d=2 up.
 */
export function directFetchParts(rate: number, distance: number, energyPerWork = BUILD_ENERGY_PER_WORK): number {
  const rt = roundTripTicks(distance);
  const t = Math.sqrt((50 * rt) / energyPerWork); // optimal build stretch between fetches
  const burn = rate * (1 + rt / t); // burn capacity that nets `rate` at util u
  const workParts = burn / energyPerWork;
  const carry = (burn * t) / CARRY_CAPACITY;
  return 2 * workParts + 2 * carry; // WORK+MOVE, laden CARRY+MOVE
}

/**
 * How far a PARKED consumer will reach for its own fuel without abandoning its
 * post. This is an EXECUTION capability, not a preference: the builder's
 * stationary scavenge (ConstructionCorp.doPickup) looks this far and no
 * further - "don't travel for energy; haulers are responsible for delivering
 * energy to builders". supplyMethod is bounded by it so the plan can never
 * elect a self-fetch the runtime will not perform.
 */
export const DIRECT_DRAW_REACH = 4;

/**
 * The supply-method verdict (spec 34 D1) for a PARKED consumer at `distance`
 * from its fuel: "a hauler brings them energy, unless it's already adjacent
 * to an energy source like a container or a link" (owner). Withdraw
 * adjacency (d<=1) is the route of length 0 - direct draw in place, no
 * vector. Beyond it, the vector delivers to the parked body. The comparison
 * against directFetchParts (the priced-out fetch counterfactual) documents
 * WHY the doctrine holds - the vector wins from d=2 up at any real rate,
 * the same math that made static miner + hauler the game's meta - so the
 * corp reads a computed verdict, never a hand-baked category.
 *
 * The verdict is bounded by REACH as well as by parts - see
 * {@link DIRECT_DRAW_REACH}.
 */
export function supplyMethod(
  rate: number,
  distance: number,
  energyPerWork = BUILD_ENERGY_PER_WORK
): { method: "direct" | "vector"; directParts: number; vectorParts: number } {
  const directParts = directFetchParts(rate, distance, energyPerWork);
  const vectorParts =
    vectorSupplyParts(rate, distance) +
    2 * (rate / energyPerWork) + // the baseline WORK core + its MOVE
    bufferCarryParts(rate, refuelIntervalTicks(distance, 1)); // buffer: CARRY only (refilled in place)
  if (distance <= 1) return { method: "direct", directParts, vectorParts };
  // REACH BOUND: the two part-curves RECROSS at long range (directFetchParts
  // grows linearly, vectorSupplyParts carries a fixed overhead), handing the
  // verdict back to "direct" precisely where a parked builder is least able
  // to fetch. Measured live at the cross-room distance the corp prices
  // (roomLinearDistance * 50 = 100): direct 241.5 vs vector 250.4 at rate 20
  // - a 3.6% margin, and the builder that "won" it stood in W41N23 beside 15
  // sites in FETCH state with no tanker, 4251 energy of work and 0 built
  // (P8 "CREW IDLE", t72675271). The consumer only ever draws from within
  // DIRECT_DRAW_REACH, so beyond that the vector is not the cheaper option -
  // it is the ONLY implementable one, whatever the parts say. Pricing a
  // behavior the runtime never performs is a fidelity bug by construction.
  if (distance > DIRECT_DRAW_REACH) return { method: "vector", directParts, vectorParts };
  return { method: directParts < vectorParts ? "direct" : "vector", directParts, vectorParts };
}

/**
 * The ALL-IN operation spawn load (spec 34 D4): the node's own bodies PLUS
 * every supply/evacuation vector it operates, each amortized over the
 * effective life at ITS distance. This is the `spawnPartsPerTick` a corp's
 * commission must declare - an operation that fields carriers its price
 * omits is lying to the parts ledger (P4's measured "unbudgeted" class).
 */
export function operationSpawnLoad(nodeLoad: number, vectors: { rate: number; distance: number }[]): number {
  let load = nodeLoad;
  for (const v of vectors) {
    load += vectorSupplyParts(v.rate, v.distance) / effectiveLife(v.distance);
  }
  return load;
}

/**
 * Ticks between STARTING a creep's spawn and it standing at its post:
 * build time (3/part) plus the walk out. `travelTicks` is the walk in TICKS,
 * not tiles - callers convert (e.g. distance * travelTicksPerTile) so slow
 * early bodies get the longer lead they actually need. This is the delivery
 * contract's lead time - the planner's effectiveLife amortization already
 * assumes a successor arrives the tick its predecessor dies, and that only
 * happens if the replacement STARTS this many ticks early.
 */
export function deliveryLeadTime(bodyParts: number, travelTicks: number): number {
  // 1.5x + 10 safety on the walk: measured (grid churn-t3-gapless-replacement)
  // real walks run ~1.75x the fatigue model once pathing noise, spawn-exit
  // delay and assignment lag are paid, and the cost asymmetry favors early
  // (a few ticks of double-staffing) over late (a dark post).
  return SPAWN_TIME_PER_PART * bodyParts + Math.ceil(travelTicks * 1.5) + 10;
}

/**
 * Whether an incumbent still counts as staffing its post for SPAWN PLANNING.
 * A creep inside its replacement lead time keeps working until it dies, but
 * its successor must start spawning NOW for the post to stay continuously
 * staffed - so for demand purposes it no longer holds the post. `ttl` is
 * undefined while a creep is still spawning: that is the freshest possible
 * incumbent (a successor already in the pipe), so it staffs.
 */
export function staffsPost(ttl: number | undefined, bodyParts: number, travelTicks: number): boolean {
  if (ttl === undefined) return true;
  return ttl > deliveryLeadTime(bodyParts, travelTicks);
}

/**
 * The consumption rate (energy/tick) a CONSUMER should be sized to, given the
 * ACTUAL energy at its work site (owner doctrine 2026-07-10: "plan consuming
 * corps only based on the actual energy available... 2000 in a storage by the
 * controller over a ~1500-tick lifetime needs X body parts"). Stock drains
 * over one creep generation, plus whatever measurably flows in. Sizing
 * consumers from ACTUALS (not the goal plan's allocation) is self-correcting:
 * under-delivery -> small stock -> small consumers -> spawn capacity stays on
 * the supply side (macro: income first, then spend savings); a windfall ->
 * consumers scale up to eat it.
 */
export function sustainableConsumptionRate(stock: number, inflow = 0): number {
  return inflow + stock / CREEP_LIFETIME;
}

/**
 * Fraction of a crew's EFFECTIVE life (lifetime minus travel) a project
 * should complete within (owner 2026-07-20: "limit the builders to the size
 * that would complete the whole construction project during their lifetime
 * ... Let's have a bit of a buffer. We don't want it 99% finished. And
 * there's travel time. We can aim for around 1,000 but in any case it
 * should be based on effective ttl (i.e. excluding travel time) not a hard
 * constant. Since we might, for example, be trying to build up a spawn in a
 * couple rooms over."). 2/3 of a full 1500 life = the owner's ~1000 at zero
 * travel; a build site 100 tiles out gets 2/3 of 1400.
 */
export const PROJECT_COMPLETION_FRACTION = 2 / 3;

/**
 * WARTIME completion fraction (owner 2026-07-27, spec 33 down-payment): while a
 * spendable warchest surplus stands, finish construction FASTER - complete over
 * a shorter fraction of the crew's effective life so the surplus is spent into
 * STRUCTURES (and the haul scales with it) instead of banking, and upgrading
 * relegates to the controller floor meanwhile. Bounded DOWNSTREAM and cannot run
 * away: the plan's construction sink is min(minedSupply + bankRate, absorb-share),
 * so a bigger absorb only draws MORE of the ALREADY-AVAILABLE energy, never
 * energy the economy lacks; the crew is further bounded by its fuel and
 * maxPerBuilder. Resumes the leisurely pace with no flap when the surplus/backlog
 * drains (the signal is the tapered bankSurplusRate the feeder/upgrader read).
 * 1/3 (~2x the normal ~1000t pace) is the owner's "speed it up a bit".
 */
export const WARTIME_COMPLETION_FRACTION = 1 / 3;

/**
 * The summed construction remaining work (energy) that marks a room as being in
 * WARTIME (spec 33): a build backlog meaningful enough that upgrading relegates
 * to its floor and the surplus flows to building. ~one structure (an extension
 * is 3000): a lone road (300) never trips it, a real build-out does. Read by
 * BOTH the plan (flowAdapter's controller-sink relegation) and the physical
 * consumer (UpgradingCorp's fleet relegation), so the two shift COHERENTLY.
 */
export const WARTIME_BACKLOG_THRESHOLD = 3000;

/**
 * The controller's anti-downgrade sip (energy/tick == WORK): the inviolable
 * floor upgrading is relegated TO (never zeroed) - keeps the controller alive
 * while the surplus funds building. The plan's controller sink and the physical
 * upgrader fleet both floor here, so relegation is a coherent ladder shift.
 */
export const ANTI_DOWNGRADE_RESERVE = 2;

/** The sizing horizon for a crew working `travelDistance` from its spawn.
 * `accelerate` (a spendable surplus stands) shortens it to the wartime pace. */
export function projectBuildHorizon(travelDistance: number, accelerate = false): number {
  const fraction = accelerate ? WARTIME_COMPLETION_FRACTION : PROJECT_COMPLETION_FRACTION;
  return Math.max(1, fraction * effectiveLife(travelDistance));
}

/**
 * The energy/tick a body of construction WORK can usefully absorb: finish the
 * outstanding site work within the buffered effective life of the crew,
 * floored at one small builder (5 e/t = 1 WORK - the granularity floor). A
 * crew sized this way finishes with margin before it dies - no 99%-stranded
 * projects, no spawned WORK-ticks idling long after completion; the
 * un-claimed energy scores at the controller via the value pass ("the rest
 * flows back to upgrading in the planner"). The SUM-OF-PROJECTS lens (owner
 * 2026-07-19: "a construction project is a finite tile list with a computable
 * total cost"), shared by the EXECUTION crew sizing (ConstructionCorp.
 * builderPlan) and the PLAN's construction-sink capacity (flowAdapter) - the
 * two MUST read the same formula, or the plan allocates energy the crew will
 * never burn (measured prod t72444684: a 455-energy extension site was
 * granted 124 e/t of bank draw, actual burn 0.45 e/t, warchest +7.66/t to
 * 8.3x target while the controller got 2 e/t). Batching a structure SET into
 * visible sites raises `remainingWork` and with it the crew cap - the
 * owner's focused-burst lever under this rule.
 */
export function projectAbsorbRate(remainingWork: number, travelDistance = 0, accelerate = false): number {
  return Math.max(5, remainingWork / projectBuildHorizon(travelDistance, accelerate));
}


/**
 * Body parts per WORK part of upgrader fleet, measured from the live fed-in-
 * place body (15W1C4M = 20 parts / 15 WORK). Used to convert a controller
 * energy allocation into the standing bodies that burn it.
 */
export const UPGRADER_PARTS_PER_WORK = 4 / 3;

/**
 * Spawn build-time (parts/tick) to MAINTAIN the upgrader fleet burning
 * `energyPerTick` at a controller `distance` tiles from its spawn. One WORK
 * burns UPGRADE_ENERGY_PER_WORK (1) e/t, each WORK rides in a body of
 * UPGRADER_PARTS_PER_WORK parts, amortized over the effective life. This is
 * the consumer side of the plan's spawn-parts ledger (spec 15 P4): energy
 * allocations are wishes until the bodies that burn them are affordable in
 * the spawn's OTHER currency.
 */
export function controllerWorkSpawnLoad(energyPerTick: number, distance: number): number {
  // Continuous, like carryPartsFor: planning math stays fractional and the
  // body sizer rounds (workPartsForEnergyRate ceils - correct for bodies,
  // wrong for a ledger, where the ceil made charge and audit disagree by a
  // fraction of one WORK body).
  const workParts = energyPerTick / UPGRADE_ENERGY_PER_WORK;
  return (workParts * UPGRADER_PARTS_PER_WORK) / effectiveLife(distance);
}

/**
 * Body parts per WORK of builder fleet (W-heavy build body: 5W1C3M = 1.8,
 * rounded up for the shuttle tanker's share). With BUILD_ENERGY_PER_WORK = 5,
 * a construction sink burns energy 5x more spawn-cheaply than a controller:
 * the same e/t needs one fifth the WORK bodies.
 */
export const BUILDER_PARTS_PER_WORK = 1.8; // measured: 5W1C3M = 9 parts / 5 WORK

/**
 * Spawn build-time (parts/tick) to maintain the builder fleet burning
 * `energyPerTick` at sites `distance` from the spawn - the construction-sink
 * side of the plan's spawn-parts ledger (spec 15 P4), mirror of
 * controllerWorkSpawnLoad. Continuous, like every planning formula here.
 */
export function constructionWorkSpawnLoad(energyPerTick: number, distance: number): number {
  const workParts = energyPerTick / BUILD_ENERGY_PER_WORK;
  return (workParts * BUILDER_PARTS_PER_WORK) / effectiveLife(distance);
}

/** Nominal feeder shuttle distance (storage -> controller input, measured live: 6). */
const FEEDER_NOMINAL_DISTANCE = 6;

/**
 * Spawn build-time (parts/tick) of the standing infrastructure the plan
 * implies but does not commission through routeToSinks: the storage->
 * controller feeder shuttle sized to `relayRate`, the extension tender
 * detail, and one reserver per remote room. Priced at CURRENT behavior
 * (reserver duty 1.0 - spec 15 P5; when the duty cycle ships this halves and
 * frees the parts). Fed to the planner as ColonyProblem.infraPartsPerTick by
 * the flow adapter, so the sink fill spends only what is truly left.
 */
export function infraSpawnLoad(
  relayRate: number,
  depotRoomCount: number,
  remoteRoomCount: number,
  linkFedRoomCount = 0
): number {
  // Feeder + tender are DEPOT movers: they exist only in rooms with a built
  // storage (`depotRoomCount`). Charging them unconditionally taxed early
  // worlds ~5-7% of the parts budget for infra that cannot exist there
  // (caught by grid cell plan-t1-single-source-loop on the first P4 gate).
  // A LINK-FED depot's feeder leg shrinks to storage -> core link (spec 24
  // rung 3, same controllerLink lens the corp reads): distance 1, ~1/6th
  // the CARRY for the same relay. Priced like the original: one feeder
  // detail for the depot room (multi-depot pricing arrives with expansion).
  const feederDist = linkFedRoomCount > 0 ? 1 : FEEDER_NOMINAL_DISTANCE;
  const feeder = depotRoomCount > 0 ? (2 * carryPartsFor(relayRate, feederDist)) / effectiveLife(feederDist) : 0;
  // 2 tankers x measured 24-part body, per depot room (owner ratchet
  // 2026-07-22, priced WITH the fleet-cap cut - P5: price = behavior).
  const TENDER_FLEET_PARTS = 48;
  const tender = (depotRoomCount * TENDER_FLEET_PARTS) / CREEP_LIFETIME;
  const RESERVER_PARTS_PER_ROOM = 4; // 2 CLAIM 2 MOVE (the full-budget live body - see RESERVER_DUTY)
  const RESERVER_WALK = 60; // nominal remote-controller walk
  // Priced at the SHIPPED duty cycle (P5, verified live 2026-07-18): the
  // corp coasts on the reservation bank, one stint per ~1080t. Holding this
  // at 1.0 after the fix shipped was pure phantom slack (owner: no standing
  // reserves - defense preempts via priority when needed, it does not
  // reserve capacity).
  const reservers =
    (RESERVER_DUTY * (remoteRoomCount * RESERVER_PARTS_PER_ROOM)) / Math.max(1, CLAIM_LIFETIME - RESERVER_WALK);
  return feeder + tender + reservers;
}

/**
 * The ENERGY twin of {@link infraSpawnLoad} - the same three details, priced in
 * energy/tick instead of build-parts/tick.
 *
 * Kept adjacent and structurally identical ON PURPOSE: same signature, same
 * terms, same order, so a change to one is visibly a change to the other. The
 * only difference is the per-part price, and it is per-CLASS because the bodies
 * differ - feeder and tender are CARRY+MOVE pairs (100e per 2 parts) while a
 * reserver is CLAIM+MOVE (650e per 2). A single averaged rate would be the
 * biased conversion F1 warns about; per body it is exact.
 *
 * Exists because the plan under-routed the spawn: `flowAdapter.discoverSinks`
 * priced the spawn sink at a hardcoded 10 e/t "base overhead" while the fleet
 * cost ~42 (measured t72714129), and the spawn sits at the TOP of the value
 * ladder - so the shortfall was handed down it and the controller absorbed it.
 * The two-pass solve prices the fleet after pass 1 and demands it in pass 2.
 */
export function infraSpawnEnergy(
  relayRate: number,
  depotRoomCount: number,
  remoteRoomCount: number,
  linkFedRoomCount = 0
): number {
  const CARRY_MOVE_PER_PART = CARRY_MOVE_PAIR_COST / 2;
  const CLAIM_MOVE_PER_PART = (BODY_COSTS.CLAIM + BODY_COSTS.MOVE) / 2;
  const feederDist = linkFedRoomCount > 0 ? 1 : FEEDER_NOMINAL_DISTANCE;
  const feeder =
    depotRoomCount > 0 ? ((2 * carryPartsFor(relayRate, feederDist)) / effectiveLife(feederDist)) * CARRY_MOVE_PER_PART : 0;
  const TENDER_FLEET_PARTS = 48;
  const tender = ((depotRoomCount * TENDER_FLEET_PARTS) / CREEP_LIFETIME) * CARRY_MOVE_PER_PART;
  const RESERVER_PARTS_PER_ROOM = 4;
  const RESERVER_WALK = 60;
  const reservers =
    ((RESERVER_DUTY * (remoteRoomCount * RESERVER_PARTS_PER_ROOM)) / Math.max(1, CLAIM_LIFETIME - RESERVER_WALK)) *
    CLAIM_MOVE_PER_PART;
  return feeder + tender + reservers;
}

/** Miner spawn overhead (energy/tick) for a source `distance` from its spawn. */
export function minerOverhead(distance: number): number {
  return MINER_COST / effectiveLife(distance);
}

/** Hauler spawn overhead (energy/tick) for `carryParts` posted `distance` away. */
export function haulerOverhead(carryParts: number, distance: number): number {
  return (carryParts * (BODY_COSTS.CARRY + BODY_COSTS.MOVE)) / effectiveLife(distance);
}

/**
 * Net energy/tick a source actually yields the colony after paying for the miner
 * and the haulers that carry its energy home: rate - minerOverhead -
 * haulerOverhead. This is the profitability of mining the source; <= 0 means it
 * costs more to staff than it produces.
 */
export function netEnergy(rate: number, distance: number): number {
  return rate - minerOverhead(distance) - haulerOverhead(carryPartsFor(rate, distance), distance);
}

/**
 * Spawn build-time (parts/tick) the miner + haulers serving a source consume.
 * (MINER_PARTS + 2*carryParts) / life: the miner is MINER_PARTS parts, and each
 * hauler CARRY part needs a MOVE to pair with it, so 2 parts per carry. This is
 * the scarce resource the planner budgets across a spawn's sources.
 */
export function spawnPartsFor(rate: number, distance: number): number {
  return (MINER_PARTS + 2 * carryPartsFor(rate, distance)) / effectiveLife(distance);
}

/**
 * The miner NODE body's own spawn load (parts/tick) - the produce half of a
 * miner operation's all-in price (spec 34 D5), amortized over the effective
 * life at its distance. The routed vector parts are priced per route by the
 * planner (carryPartsFor with paved/deposit adjustments) and SUMMED onto this
 * in the commission envelope; spawnPartsFor above remains the pre-solve
 * NOMINAL estimate the funding gate uses. One home for the node term - the
 * planner's ledger charges miners through this exact formula.
 */
export function minerSpawnLoad(distance: number): number {
  return MINER_PARTS / effectiveLife(distance);
}

/**
 * Shadow price of spawn build-time: energy/tick gained per build-part/tick
 * spent staffing a source at `distance`. netEnergy / spawnPartsFor - the
 * exchange rate between the colony's two currencies. Evaluated AT THE MARGIN
 * (the best un-staffed source), it prices anything that frees spawn parts:
 * ~537 e/part for a home source (d=20), ~150 at d=75, ~79 at d=120. When the
 * spawn budget is slack (no source waiting), freed parts are worth ~0 - the
 * caller owns that regime check.
 */
export function energyPerSpawnPart(rate: number, distance: number): number {
  return netEnergy(rate, distance) / spawnPartsFor(rate, distance);
}

/**
 * Fraction of the PHYSICAL spawn build-rate the planner may commit (owner
 * 2026-07-30: "90% of theoretical spawn capacity is available for planning -
 * everything is like before, we're just planning on an economy that's 10%
 * smaller in terms of bodies").
 *
 * The reserved 10% is EXECUTION slack, not waste. A plan at 100% of physical
 * had nowhere to put the parts execution provably spends outside the plan's
 * fleets: EOL replacement overlap (deliveryLeadTime deliberately starts
 * successors early), invader-churn rebuilds (X5 measured 18% of remote spawn
 * spend), runt upsizes, and orphan rescues. Measured at t72676360 the result
 * was utilization 0.97 with queue depth 8 and blocking demands waiting behind
 * a saturated pipe. With the margin, that churn lands in reserved slack
 * instead of queueing behind planned bodies.
 *
 * This is a MARGIN at the planning seam - execution still owns the full
 * physical spawn, standing fleets are untouched, and nothing is gated
 * (doctrine: the planner prices, it doesn't gate).
 */
export const SPAWN_PLAN_FRACTION = 0.9;

/**
 * Parts/tick the PLANNER may budget across `spawnCount` spawns - the ONE lens
 * every plan-side capacity read derives from, so the whole plan shrinks
 * uniformly (mining tranche and sink fill alike) rather than one tranche
 * eating the margin.
 */
export function plannableSpawnParts(spawnCount: number): number {
  return spawnCount * SPAWN_PARTS_PER_TICK * SPAWN_PLAN_FRACTION;
}

/**
 * Fraction of a spawn's PLANNABLE build-rate that mining + hauling may claim.
 * The spawn also builds upgraders, builders, reservers and scouts, so income
 * creeps get only part of its parts-per-tick. This sets how hard the
 * spawn-time budget bites before far sources fall out of contention.
 */
export const MINING_BUDGET_FRACTION = 0.6;

/** A spawn's per-tick build-time budget available to mining + hauling.
 * Composes with the planning headroom (SPAWN_PLAN_FRACTION): mining sees
 * 0.6 of a 90%-sized spawn, so the margin applies to the whole plan. */
export function miningBudgetPerSpawn(): number {
  return plannableSpawnParts(1) * MINING_BUDGET_FRACTION;
}

/**
 * Don't fire a link dribble: wait until the sending link holds at least this
 * much, so the (distance-long) cooldown and the 3% transfer fee are paid on a
 * full-ish load. Miners feed 50 per transfer, so this is a couple of feeds.
 * ONE home for the runner's fire gate (execution/LinkRunner) and the link
 * meter's core-fill sampler boundary (telemetry/LinkMeter).
 */
export const LINK_FIRE_THRESHOLD = 100;

// ---------------------------------------------------------------------------
// NPC-invader raid facts (spec 13 ground truth, verified against the vendored
// engine in node_modules - the same code the live servers run). Raids are a
// metered tax on OUR harvesting: the engine sums a per-source counter
// (engine harvest.js:45-48) and the backend cron fires a raid when the room's
// sum reaches `invaderGoal` (backend cronjobs.js:386-391).
// ---------------------------------------------------------------------------

/** The base raid goal (backend `C.INVADERS_ENERGY_GOAL`, constants.js:776). */
export const INVADERS_ENERGY_GOAL = 100_000;

/**
 * The goal's post-raid reroll floor: `floor(100k * U(0.7, 1.3))`
 * (cronjobs.js:433-438). Below this much accrued debt a raid CANNOT fire.
 */
export const RAID_GOAL_FLOOR = 70_000;

/**
 * The reroll ceiling for the common (90%) branch. Debt beyond this with no
 * raid observed is evidence raids aren't firing here at all (sector has no
 * live stronghold, or every exit borders an owned/reserved room) - the meter
 * goes OVERDUE and the guard disarms.
 */
export const RAID_GOAL_CEIL = 130_000;

/**
 * Expected energy harvested per raid: 90% U(70k,130k) + 5% doubled + 5%
 * exactly 100k (the engine's Math.floor(0.5)=0 quirk falls back to the base
 * goal) = 0.9*100k + 0.05*200k + 0.05*100k.
 */
export const INVADER_RAID_MEAN_ENERGY = 105_000;

/**
 * Arm the guard one delivery lead under the goal floor: the crossing at
 * ~10 e/tick gives >=500 ticks of lead versus ~180 needed for spawn + walk,
 * so a guard commissioned here stands at the source before the raid can fire
 * (bonzAI/Overmind arm 65k-90k against the same floor).
 */
export const RAID_ARM_FLOOR = 65_000;

/** Raid invaders live exactly this long and never leave their room (cronjobs.js:281). */
export const INVADER_TTL = 1_500;

/**
 * Expected defense cost per NPC raid under the fight-first posture: one
 * 5xATTACK/5xMOVE guard body (650) with a ~15% margin for the multi-creep
 * tail (~10% of raids are 2-5 smalls) and the occasional lost trade. A
 * DERIVED starting point - phase 5 telemetry replaces it with the measured
 * number (calibration windows >= 10x1500 ticks per the multi-draw rule).
 */
export const EXPECTED_RAID_DEFENSE_COST = 750;

/**
 * The invader tax as a per-energy coefficient: raids fire as a function of
 * energy harvested (one per E[105k] - see INVADER_RAID_MEAN_ENERGY), so the
 * expected defense cost composes as a constant tax on every harvested unit.
 * By construction it can never reorder equal-gross flows - it shifts
 * margins, dropping remotes whose profit was fictional.
 */
export function invaderTaxPerEnergy(expectedRaidCost: number): number {
  return expectedRaidCost / INVADER_RAID_MEAN_ENERGY;
}

/** The default remote-source tax rate (~0.71% of gross at the derived cost). */
export const INVADER_TAX_PER_ENERGY = invaderTaxPerEnergy(EXPECTED_RAID_DEFENSE_COST);

// ---------------------------------------------------------------------------
// Mineral extraction (spec 22 estimate, ahead of the mineral corp). An
// extractor (RCL6 in an owned room, or any controller-less SK/highway room)
// harvests a mineral deposit and the market converts it to energy: sell the
// mineral, buy energy with the proceeds. Unlike a source a mineral does NOT
// regenerate continuously - it drains to zero, then refills over
// MINERAL_REGEN_TIME. So the long-run rate is REGEN-limited, not miner-limited:
// a bigger miner drains faster but then idles longer. The peak burst is
// spectacular; the honest steady-state number is the cycle average.
// ---------------------------------------------------------------------------

/** Ticks between extractor harvests (Screeps `EXTRACTOR_COOLDOWN`). */
export const EXTRACTOR_COOLDOWN = 5;
/** Mineral harvested per WORK per harvest action (`HARVEST_MINERAL_POWER`). */
export const HARVEST_MINERAL_POWER = 1;
/** Ticks a depleted mineral takes to regenerate (`MINERAL_REGEN_TIME`). */
export const MINERAL_REGEN_TIME = 50_000;

/** Deposit size by density level 1-4 (Screeps `MINERAL_DENSITY` amounts). */
export const MINERAL_DENSITY_AMOUNT: Record<number, number> = {
  1: 15_000,
  2: 35_000,
  3: 70_000,
  4: 100_000
};

/**
 * A representative mature extractor miner (WORK parts). The long-run rate is
 * regen-bound, so the exact size barely moves it (18W at RCL6 vs 20W vs 40W on
 * density-3 spans only ~0.98..1.19 min/tick) - callers may override, but this
 * default keeps the estimate robust to RCL.
 */
export const DEFAULT_MINERAL_MINER_WORK = 20;

/**
 * MOVE parts per WORK on a mineral miner: 0.5 = road speed (a static miner
 * walks to its container once over the room's own roads, then never moves).
 */
export const MINERAL_MINER_MOVE_PER_WORK = 0.5;

/** Body part count of a `workParts`-WORK mineral miner (WORK + road-ratio MOVE). */
export function mineralMinerParts(workParts: number): number {
  return workParts + Math.max(1, Math.ceil(workParts * MINERAL_MINER_MOVE_PER_WORK));
}

/** Energy build cost of a `workParts`-WORK mineral miner body. */
export function mineralMinerCost(workParts: number): number {
  const move = Math.max(1, Math.ceil(workParts * MINERAL_MINER_MOVE_PER_WORK));
  return workParts * BODY_COSTS.WORK + move * BODY_COSTS.MOVE;
}

/**
 * PEAK mineral/tick a `workParts`-WORK miner sustains WHILE the deposit has ore:
 * one harvest of `workParts * HARVEST_MINERAL_POWER` every EXTRACTOR_COOLDOWN
 * ticks. This is the burst rate, not the steady-state (see
 * {@link mineralExtractionRate}).
 */
export function mineralPeakRate(workParts: number): number {
  if (workParts <= 0) return 0;
  return (workParts * HARVEST_MINERAL_POWER) / EXTRACTOR_COOLDOWN;
}

/**
 * LONG-RUN average mineral/tick over a full drain+regen cycle. The deposit of
 * `amount` drains in `amount / peakRate` ticks, then sits dead for
 * MINERAL_REGEN_TIME: avg = amount / (drainTicks + REGEN). Regen-bound - as
 * workParts grows the average approaches `amount / REGEN`, never the peak. This
 * is THE number for steady-state economy sizing; sizing a standing consumer to
 * the burst is the same mistake as sizing one to a windfall stock.
 */
export function mineralExtractionRate(workParts: number, amount: number): number {
  const peak = mineralPeakRate(workParts);
  if (peak <= 0 || amount <= 0) return 0;
  const drainTicks = amount / peak;
  return amount / (drainTicks + MINERAL_REGEN_TIME);
}

/**
 * Energy bought per mineral sold: the mineral's sell price (credits) over
 * energy's buy price. This EXCHANGE RATE is what makes a mineral comparable to
 * a source in energy terms ("sell the mineral, buy energy with the proceeds").
 * Zero/negative energy price -> 0 (no trade). Per spec 22 the prices feeding
 * this are OBSERVED (Game.market, cached), never assumed.
 */
export function marketEnergyPerMineral(mineralPrice: number, energyPrice: number): number {
  if (energyPrice <= 0 || mineralPrice <= 0) return 0;
  return mineralPrice / energyPrice;
}

/**
 * Net energy-equivalent/tick a mineral deposit yields the colony via the market
 * chain: the long-run mineral rate valued at `energyPerMineral`, minus the
 * miner and hauler spawn overhead. Mirror of {@link netEnergy} for sources, so
 * a mineral node ranks on the SAME energy axis as a source.
 *
 * Costs are charged PER MINERAL and multiplied by the average rate, which
 * automatically credits the regen dead-period: a miner/hauler pair produces
 * `peakRate * effectiveLife` minerals while alive and is recycled during regen,
 * so its build cost amortises over the ore it actually moves - not over the
 * ~50k idle ticks. GROSS of any securing cost (claim/keeper-clear): the caller
 * that decides to work the room nets that separately (spec 21/22).
 */
export function mineralNetEnergy(
  amount: number,
  workParts: number,
  energyPerMineral: number,
  distance: number
): number {
  const rate = mineralExtractionRate(workParts, amount);
  if (rate <= 0 || energyPerMineral <= 0) return 0;
  const peak = mineralPeakRate(workParts);
  const perLife = peak * effectiveLife(distance); // minerals a body makes while alive
  const minerCostPerMineral = mineralMinerCost(workParts) / perLife;
  const carry = carryPartsFor(peak, distance);
  const haulerCostPerMineral = (carry * (BODY_COSTS.CARRY + BODY_COSTS.MOVE)) / perLife;
  return rate * (energyPerMineral - minerCostPerMineral - haulerCostPerMineral);
}

/**
 * Spawn build-time (parts/tick) the mineral miner + haulers consume, averaged
 * over the drain+regen cycle. Mirror of {@link spawnPartsFor}; like the energy
 * cost above it amortises the bodies over the ore they move, so the regen
 * dead-period costs no parts.
 */
export function mineralSpawnParts(amount: number, workParts: number, distance: number): number {
  const rate = mineralExtractionRate(workParts, amount);
  const peak = mineralPeakRate(workParts);
  if (rate <= 0 || peak <= 0) return 0;
  const perLife = peak * effectiveLife(distance);
  const partsPerMineral = (mineralMinerParts(workParts) + 2 * carryPartsFor(peak, distance)) / perLife;
  return rate * partsPerMineral;
}

/**
 * Shadow price of spawn build-time for a mineral node: mineralNetEnergy /
 * mineralSpawnParts. Mirror of {@link energyPerSpawnPart}. Minerals score very
 * high here - the miner recycles through the ~50k regen dead-period, so the
 * dense ore is moved by almost no standing spawn budget.
 */
export function mineralEnergyPerSpawnPart(
  amount: number,
  workParts: number,
  energyPerMineral: number,
  distance: number
): number {
  const parts = mineralSpawnParts(amount, workParts, distance);
  if (parts <= 0) return 0;
  return mineralNetEnergy(amount, workParts, energyPerMineral, distance) / parts;
}

/**
 * Minimum REMAINING occupation (read `invaderReservedUntil - Game.time`)
 * before the core-buster mission is worth commissioning. Payback sketch
 * (engine facts): income under a foreign reservation is 0, an unmolested
 * level-0 core renews its reservation for the parent stronghold's whole
 * collapse window (tens of thousands of ticks), and the mission costs one
 * ATTACK body (390-1300) plus one CLAIM striker (650) against the room's
 * FULL rate restored. At a 5-10 e/tick blackout, the mission repays in well
 * under 1000 ticks of remaining occupation; below the gate the reservation
 * is about to lapse on its own and fighting buys nothing.
 */
export const CORE_BUSTER_MIN_REMAINING = 1_000;

/**
 * The energy a tower keeps back for DEFENSE, never spent on peace-time repair.
 * A raid is bursty and unannounced, so the tower must always be able to open
 * fire without waiting on a tender round-trip.
 */
export const TOWER_DEFENSE_RESERVE = 500;

/**
 * The peace-time REPAIR budget: energy a refilled tower may spend down to the
 * defensive reserve before it needs topping up again. At TOWER_POWER_REPAIR
 * (800 hits) per TOWER_ENERGY_COST (10) this buys ~24,000 hits per band at
 * close range - several roads restored from scratch - so the refill cadence
 * stays cheap relative to what it saves in builder WORK.
 */
export const TOWER_REPAIR_BAND = 300;

/**
 * The level BELOW which a tower wants topping up. Expressed in terms of the
 * defensive reserve ON PURPOSE (owner-reported 2026-07-30, "the tower should
 * repair the nearby roads anyways as well"): the refill trigger and the repair
 * floor were independently-chosen constants that happened to be the SAME
 * number - `capacity * 0.5` and TOWER_DEFENSE_RESERVE are both 500 at
 * TOWER_CAPACITY 1000 - with mutually exclusive comparisons. Repair costs
 * exactly 10, so a full tower walked 1000 -> ... -> EXACTLY 500 and then could
 * neither repair (not > 500) nor refill (not < 500). It parked there until a
 * raid spent it below the line, which is why tower repair looked intermittent
 * while roads decayed to the builder fleet.
 *
 * Deriving the threshold from the reserve makes that dead point
 * unrepresentable: the trigger is strictly above the floor, so draining to the
 * floor always calls a tender. Clamped to capacity so a small tower never asks
 * for more than it can hold.
 */
export function towerRefillBelow(capacity: number): number {
  return Math.min(capacity, TOWER_DEFENSE_RESERVE + TOWER_REPAIR_BAND);
}

// ---------------------------------------------------------------------------
// LOSS PRICING (owner 2026-08-01: "I'd like to see pile decay, tombstone and
// decay (structures) and repair show up in the report").
//
// The energy account balances to a named RESIDUAL that bounds ground decay,
// rot, raid losses and measurement error - 32% of gross mining at the
// 2026-08-01 close, and spec 15's rule is that a residual which cannot be
// split is a work item. These are the conversions that price the DECAY half of
// it in energy, so the account can carry line items instead of one bucket.
//
// Every constant here is a GAME RULE (the engine's own decay arithmetic), not
// a tuning knob - which is exactly why they belong in primitives rather than
// in the meter that reads them or the ledger that prints them.
// ---------------------------------------------------------------------------

/** A dropped pile loses ceil(amount / this) energy per tick (Screeps ENERGY_DECAY). */
export const ENERGY_DECAY_DIVISOR = 1000;

/**
 * Energy/tick a ground pile rots at. CONVEX in the pile size because of the
 * ceiling: a pile one energy over a 1000 boundary pays a whole extra energy per
 * tick forever. That convexity is why "let it pile up at the source and haul it
 * later" is not free, and why E6's deferred-miner gate has an energy price.
 */
export function pileDecayRate(amount: number): number {
  return amount > 0 ? Math.ceil(amount / ENERGY_DECAY_DIVISOR) : 0;
}

/** Hits restored per energy of repair (Screeps REPAIR_POWER / REPAIR_COST). */
export const REPAIR_HITS_PER_ENERGY_RATE = 100;

/** Energy it costs to restore `hits` - the price of a structure's decay. */
export function hitsToEnergy(hits: number): number {
  return hits > 0 ? hits / REPAIR_HITS_PER_ENERGY_RATE : 0;
}

/** Hits a container loses per decay event (Screeps CONTAINER_DECAY). */
export const CONTAINER_DECAY_HITS = 5000;
/** Decay cadence for a container in a room we own. */
export const CONTAINER_DECAY_INTERVAL_OWNED = 500;
/** Decay cadence for a container in a room we do NOT own - 5x faster. */
export const CONTAINER_DECAY_INTERVAL_REMOTE = 100;

/**
 * Energy/tick to hold one container at full hits. A REMOTE container costs 5x
 * an owned one (0.50 vs 0.10 e/t) purely because the engine decays it five
 * times as fast - a standing cost of remote mining that no plan term prices.
 */
export function containerDecayEnergy(owned: boolean): number {
  const interval = owned ? CONTAINER_DECAY_INTERVAL_OWNED : CONTAINER_DECAY_INTERVAL_REMOTE;
  return hitsToEnergy(CONTAINER_DECAY_HITS / interval);
}

/** Hits a rampart loses per decay event (Screeps RAMPART_DECAY_AMOUNT). */
export const RAMPART_DECAY_HITS = 300;
/** Decay cadence for a rampart. */
export const RAMPART_DECAY_INTERVAL = 100;

/** Energy/tick to hold one rampart at full hits. */
export function rampartDecayEnergy(): number {
  return hitsToEnergy(RAMPART_DECAY_HITS / RAMPART_DECAY_INTERVAL);
}

/**
 * Energy a creep spends repairing for one tick with `workParts`.
 * REPAIR_COST (0.01 energy/hit) x REPAIR_POWER (100 hits/WORK/tick) = exactly
 * one energy per WORK part, the precise inverse of hitsToEnergy - so a
 * structure held at constant hits costs exactly its decay rate, and the
 * account's decay and repair lines net out instead of double-counting.
 */
export function creepRepairEnergy(workParts: number): number {
  return workParts > 0 ? workParts : 0;
}
