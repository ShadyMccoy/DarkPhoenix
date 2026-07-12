# Economic Framework

This document describes the economic model underlying DarkPhoenix's resource
allocation: the canonical primitives, the two-currency planning problem, and
the effective-energy model that prices sources and remote operations.

> Architecture context lives in [PIPELINE.md](PIPELINE.md) and
> [ONTOLOGY.md](ONTOLOGY.md). The FlowSolver/priority-table design older
> versions of this file described is deleted; the live solver is
> `economy/CorpPlanner.ts` (`planColony`, pure and deterministic).

## Core Philosophy

Traditional Screeps AIs use explicit rules:
```
IF spawn.energy < 200 THEN spawn harvester
IF sources.length > harvesters THEN spawn harvester
```

DarkPhoenix computes the colony's allocation as one economic problem:

```
planColony sees: spawns, sources, sinks, real path distances (pure data)
Phase 1 (producer selection): staff the sources whose net energy per
  build-part is best, per spawn, under the spawn's mining build budget
Phase 2 (value routing): route the produced energy to sinks in value order,
  after a reserve pre-pass guarantees critical floors
Output: commissioned miners, haulers and sink allocations — the plan
```

The key insight: **optimal allocation emerges from a single global solve, not
local decisions** — and the solve reasons in TWO currencies at once.

## The two currencies

1. **Energy** (e/tick) — what sources yield (`capacity/300`, ≤ 10 standard)
   and sinks absorb.
2. **Spawn build-time** (parts/tick) — a spawn builds one body part per 3
   ticks (`SPAWN_PARTS_PER_TICK = 1/3`, ≈ 500 parts per creep lifetime).
   This is usually the *tighter* wall: a far source can stay
   net-energy-positive while demanding more hauler parts than the spawn can
   physically build.

Build-time is **priced in energy** (`energyPerSpawnPart` — the exchange rate,
evaluated at the margin) rather than hard-capped, so part-hungry far sources
are demoted in ranking and the spawn-time wall falls out of planning without
any hard distance limit.

## Canonical primitives (`src/economy/primitives.ts`)

ONE definition of every per-tick economic quantity — no module reimplements
these (the kind-conformance suite enforces it):

- `effectiveLife(d) = CREEP_LIFETIME − d` — a creep posted `d` tiles away
  amortises its cost over the remainder of its life
- `roundTripTicks(d) = 2d + 2`
- `carryPartsFor(rate, d) = rate · roundTrip / 50`
- `minerOverhead(d)`, `haulerOverhead(carry, d)` — spawn cost per tick
- `netEnergy(rate, d) = rate − minerOverhead − haulerOverhead` — source profitability
- `spawnPartsFor(rate, d)` — build-time the source's miner + haulers consume
- `energyPerSpawnPart(rate, d) = netEnergy / spawnPartsFor` — the shadow price
- `miningBudgetPerSpawn() = SPAWN_PARTS_PER_TICK · MINING_BUDGET_FRACTION (0.6)`
- `deliveryLeadTime` / `staffsPost` — the replacement delivery contract
- `sustainableConsumptionRate(stock, inflow)` — consumers sized from ACTUAL
  stock at their work site (macro doctrine: production over consumption;
  consumers burn the residual, never the goal plan's paper allocation)

## Sink values (the value ladder)

The planner fills sinks in value order, from nearest supply first
(`DEFAULT_SINK_VALUE` + per-instance overrides in `economy/flowAdapter.ts`):

| Sink | Value | Notes |
|------|-------|-------|
| spawn | 100 | keeping creeps alive — plus the agenda's funding need (spec 11) |
| new-spawn construction site | 85 | expansion founding outranks ordinary work |
| controller | 80 → 40 | log-priced by progress REMAINING (200 → 80, 10.4M → 40) |
| construction | 70 | build-out is investment; may absorb the full surplus while sites exist |
| storage | 1 | soaks excess only |

Floors are guaranteed by a reserve pre-pass (controller anti-downgrade = 2
e/tick). Once a room has a storage, the controller is capped at
`STORAGE_UPGRADE_TARGET` (15 e/t) and the surplus banks — the deposit half of
the warchest that funds expansion CAPEX.

**Ordering is load-bearing.** The controller band caps at 80 *below* the
founding site's 85 deliberately; at 90 a freshly claimed room's own L1
controller outbid its founding site and zeroed construction colony-wide
(measured). Never nudge one value in isolation.

## Effective Energy: What a Source TRULY Nets

The real value of a source is its **effective energy/tick** after every
overhead it actually incurs, and that is what drives "is this source worth
mining, and from where?". Three effects, all distance-driven, pull it down —
and the build-time currency makes the cutoff fall out without a hard limit.

Tools: `npm run sim:energy` prints the effective-energy table;
`scripts/effective-energy.ts` is the model. Each corp reports its own numbers via
`Corp.project()` → `CorpEconomics`, and `effectiveNet()` collapses them to one
number to rank by (`src/corps/economics.ts`).

### 1. The hauler dominates, and grows with distance

The miner is a flat, small cost (a 5W3M body, ~0.43 e/tick amortized). The
**hauler** is the cost that explodes: CARRY scales with the round trip, so
`haulerOverhead ≈ rate·(2d+2)/750`. For an owned source (10 e/tick gross):

| one-way dist | net e/tick | efficiency | total body parts |
|---|---|---|---|
| 0   | 9.5 | 95% | 10  |
| 50  | 8.1 | 81% | 50  |
| 100 | 6.6 | 66% | 90  |
| 200 | 3.3 | 33% | 170 |
| 300 | −0.6 | −6% | 250 |

### 2. Travel TTL shortens the miner's life

A static miner walks `d` tiles out and then **dies at the source**, so it only
mines for `1500 − d` ticks and must be respawned that much more often. Its real
amortized cost is `650/(1500−d)` (e.g. respawn every 1300 at d=200), not a flat
`650/1500`. The same initial walk-out shortens a hauler's productive life too.
TTL pulls the *net-zero* break-even in from ~356 to ~285 tiles (owned) / ~339
to ~270 (unreserved).

### 3. Spawn build-time is a SECOND budget — priced in energy

A spawn has two budgets, not one. Besides energy it has **build-time**: one
body part every `SPAWN_TIME_PER_PART` (3) ticks = **500 parts over a 1500-tick
life**. A far source can stay net-energy-positive yet demand more hauler parts
than the spawn can physically build — so build-time is often the *tighter*
wall, and it bites at a closer distance than the energy break-even. A single
owned source at d≈200 already eats ~40% of one spawn's entire part budget.

Rather than a hard part cap, we **price build-time in energy** and fold it into
the same ranking that already weighs energy:

```
effectiveNet = throughput − energyUpkeep − spawnPartsPerTick · SPAWN_PART_ENERGY_VALUE
```

`SPAWN_PART_ENERGY_VALUE ≈ 155` (energy per part/tick) is calibrated from a
representative source at the average remote distance (~75 tiles): it nets ~7.4
e/tick on ~70 parts, so a held part is worth ~0.1 e/tick ≈ 155 over its life.
Ranking by `effectiveNet`, a part-hungry far source is demoted below a near one
in pure energy — the spawn-time wall **falls out of planning**, no hard
distance limit required.

The constant is really a stand-in for the colony's **marginal alternative use
of a part** (an idle spawn → cheap parts → far sources welcome; abundant near
sources → expensive parts → far sources excluded). By construction `effNet`
crosses zero at the calibration distance, so with 155 a single spawn's
profitable remote reach is about **50–75 tiles**; lower the constant (a poorer
marginal alternative) and the reach extends. Tune it to the colony, don't
hard-code a distance.

### 4. Reserving a remote room is a per-ROOM cost

Reserving lifts a remote source from 5 → 10 e/tick, but a reserver is
**expensive in both currencies**: a `CLAIM+MOVE` body costs 650 energy, and
CLAIM creeps live only **600 ticks**, so its short life makes it cost more than
its body suggests. It also walks to the room — amortized ~`650/(600−d)` e/tick
*plus* its parts priced in energy. Two effects pull that toll back down:

- **Per-room, shared across the room's sources.** A **two-source** room halves
  the per-source reserver cost, so two sources justify reserving (and reaching
  farther) where one source may not.
- **Duty cycle ~50%.** Reservation accumulates (up to 5000) and decays 1/tick,
  so a reserver is *not* needed continuously — let it build up, let it tick
  down, then top up. That roughly halves the amortized cost again.

Reserve only while `+5/source` gross beats the (duty-cycled, per-source)
reserver toll — another decision that falls straight out of `effectiveNet`.
With both effects, the toll is ~0.8–1.2 e/tick per room and reserving wins out
to ~50 tiles for one source, ~75 for two.

## Plan-vs-actual (the fidelity doctrine)

The planner publishes its budgets (`Memory.economyPlan`: mine rate, upgrade
work, build work, hauler CARRY) and the harnesses measure what was physically
delivered, reporting the ratio:

- `npm run sim:real -- --metrics` samples plan-vs-actual per 100-tick window;
- the grid's `fid-*` cells ratchet fidelity floors with a full energy ledger
  (mined = sinks + Δstock + decay + Δtransit + residual);
- **two plans** (spec 11): tight floors belong on actual-vs-NOW
  (`Memory.spawnAgenda`); NOW-vs-GOAL convergence is a ramp gauge.

On synthetic worlds the plan *should* be achievable — a fidelity gap there is
a bug signal by construction, not noise.

## Best Practices

1. **Trust the solver.** Don't manually override allocations; fix the input
   data (the `ColonyProblem`) or the per-instance value model.
2. **Never reimplement a formula.** If you need an economic quantity, import
   it from `economy/primitives.ts`; if it doesn't exist, add it there.
3. **Respect the value ladder.** Value-ordering inversions have zeroed
   colony-wide allocations before; change values with a grid cell pinning the
   ordering you rely on.
4. **Report plan next to actual.** Any economy result quoted alone is half a
   number.
