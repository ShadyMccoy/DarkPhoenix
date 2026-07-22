# 29 — CPU as a costed resource in the planner (deferred stub)

**Status:** STUB — deferred by owner directive (2026-07-19). This is a *later
pass*, picked up only once CPU is actually the binding constraint. Recording the
gap so the objective-function hole is on the record, not scheduling the work.

**Priority:** P4 (dormant until the bucket drains under real load).

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
