# 29 — CPU as a costed resource in the planner (deferred stub)

**Status:** STUB — deferred by owner directive (2026-07-19). This is a *later
pass*, picked up only once CPU is actually the binding constraint. Recording the
gap so the objective-function hole is on the record, not scheduling the work.

**Priority:** P4 (dormant until the bucket drains under real load).

**Strategic companion:** [GRAND_STRATEGY.md](../GRAND_STRATEGY.md) argues why
`value/intent` is the late-game objective this spec is reaching for — the whole
convertibility ladder (energy, GCL, military → intents) and why CPU is the one
resource you cannot manufacture.

---

## The gap

The CorpPlanner's objective today is **value maximised subject to (a) per-spawn
build-time budget (`miningBudgetPerSpawn`) and (b) energy balance** (ONTOLOGY §4,
`CorpPlanner.ts`). **CPU is nowhere in the objective.** It exists only as the
`CpuGovernor` — a DRY-RUN-by-default *bulkhead* that throttles work when the
bucket runs low (spec 09; CLAUDE.md trap: it's live-console-only and couples
behavior to host load). A bulkhead is not a price: the planner will happily open
a CPU-ruinous op because it cannot *see* CPU, and only discovers the cost after
the fact when the governor starts pausing colonies.

At empire scale the binding constraint is **CPU per tick**, not energy or even
spawn build-time — sources regenerate whether mined or not; the real question is
whether there is CPU to spare to work another one. The right objective there is
**value per CPU**. The planner cannot pursue that today.

## The principle (why this belongs in the planner, not a heuristic)

Strategic preferences — prefer dense SK clusters over thin remotes, keep owned
cores few, fan out harvest ops — must be **emergent from costing**, never
hardcoded flags (the house doctrine: "the behavior falls out of it, not narrowly
programmed as a flag"). CPU is a real cost of every corp; pricing it is how those
preferences fall out on the math, exactly as `netEnergy` and the sink-value
ladder drive placement today. SK mining (spec 28) is the sharpest case — energy
yield and CPU cost diverge most there — which is why the gap surfaced.

## Shape when picked up (sketch, not a commitment)

- **A CPU primitive** in `economy/primitives.ts` (the single home): a per-corp /
  per-op `cpuCostPerTick`, ideally *measured* not estimated (attribute real CPU
  to corps — this is telemetry spec 14 territory; a static estimator is the
  fallback). Combat/pathing-heavy corps (SK guardians, remote haulers through
  contested rooms) cost more; static container miners cost ~nothing after arrival.
- **A second budget constraint** in `planColony` alongside spawn build-time: rank
  candidate corps by **value per (the binding resource)** — value/build-part
  where spawn-bound, value/CPU where CPU-bound. The existing corp-atomic /
  net-per-part ranking generalises; CPU just becomes a second denominator.
- **Governor reconciliation:** the `CpuGovernor` bulkhead becomes the *runtime
  enforcement* of a constraint the *planner* now respects up front — the two stop
  being independent. Bulkhead stays as the safety net; the price prevents hitting
  it.

## The static estimator, already derived (2026-08-06)

The fallback estimator this spec calls for exists now — worked in
[docs/TRANSPORT_NETWORK.md §7](../TRANSPORT_NETWORK.md), analytic and unmeasured,
but concrete enough to code against the day this is picked up. It sharpens
GRAND_STRATEGY §1's sketch ("harvest ≈ 1/source, haul ≈ 2/trip minus links,
upgrade ≈ 1/static WORK") into numbers.

**The law:** an intent is 0.2 CPU, and **moving costs one intent per tile
regardless of what the creep carries**. So CPU efficiency is exactly *energy
delivered per intent*, and the enemy is movement, not cargo. Two consequences do
most of the work:

- **A moving creep costs ~0.2 CPU/tick no matter how big it is** — it fires one
  move intent per tick either way. Creep capacity is CPU-free.
- **CPU is linear in energy·tiles/tick**, the same unit the transport analysis
  uses for bandwidth-distance. One max hauler (33C:17M) is 825 e·tiles/tick at
  0.2 CPU/tick, fixing the coefficient at **2.42 × 10⁻⁴ CPU per e·tile/tick**.
  Energy cost is likewise linear in that unit (2.6 × 10⁻³), so *for routing and
  placement decisions the two currencies are proportional and no shadow price is
  needed* — the price is only required where capital sits on the other side.

Per-mode, over a 45-tile room crossing:

| mode | CPU per 1,000 energy |
|---|---|
| 3-part hauler (100 capacity) | 184 |
| 12-part hauler (400 capacity) | 46 |
| 50-part hauler (1,650 capacity) | 11.2 |
| link pair (1 send + 2 hub-drain intents) | **0.77** |
| stationary link-fed filler, zero moves | 1.1 |
| roaming filler | 2.8 |

**Two levers, the same size, and they multiply.** Body size buys 16x and then
stops dead at `MAX_CREEP_SIZE`; links buy a further 15x past that wall. Body size
is the cheaper lever — it costs only spawn energy against a link's 5,000 and one
of six slots — but once haulers are at 50 parts there is *no* creep-side CPU
optimization left, and every further unit of throughput costs a flat 0.2
CPU/tick. That is the point where links stop being optional, and it is exactly
the kind of preference this spec wants falling out of a price rather than a flag.

Caveat that matters for calibration: this counts **engine intents only**. Own-code
cost sits on top and is wildly asymmetric — a hauler carries pathfinding, a state
machine and traffic resolution (another 0.1–0.3 CPU/tick); a link's logic is
"check cooldown, check full, fire." So the link ratios above are a **floor**, and
the measured estimator this spec prefers should come in higher. Spec 20 phase 1's
per-corp CPU metering is the instrument that would settle it.

## Why deferred (this is the honest part)

CPU is **not** the binding constraint for a small or mid colony — it is
spawn-build-time and energy that bind, and the planner already prices those.
Adding a CPU price now would distort decisions with a cost that isn't yet real
(measured-not-vibes: don't add a currency you can't yet observe *binding*). Pick
this up when the bucket actually drains under load — i.e. when the `CpuGovernor`
starts firing for real on the live empire, not in a sim (sims don't reproduce
live CPU pressure faithfully; the mockup meters real host CPU — CLAUDE.md).
Until then this stub is the whole deliverable.

## Open questions (for whoever picks it up)

- How to attribute per-corp CPU cheaply enough that the measurement doesn't cost
  more CPU than it saves (sampling vs per-tick profiling).
- Static estimate vs profiled cost as the primitive's source of truth.
- Whether CPU enters as a hard second budget or a soft penalty term in the value
  function.
- Interaction with the two-plans model (spec 11): CPU cost is a property of the
  NOW fleet, not the GOAL equilibrium.

## Non-goals (now)

- Implementing any of the above. This is a placeholder for a future pass.
