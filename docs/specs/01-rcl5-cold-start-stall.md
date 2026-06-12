# 01 — Early-game progression: prod has never reached RCL4

**Status:** OPEN — P0. Reframed 2026-06-12: production has never organically
reached RCL4, so the original subject of this spec (a synthetic RCL5 cold-start
stall in the test harness) is demoted to a secondary repro — prod never enters
that state. The primary question is: **what caps or stalls the colony's
control-point throughput at RCL2–3?**

## What we know

1. **Prod (master) is missing fixes that this branch already has.** The
   dedicated-build-source bug affects *every* RCL with ≥ 2 sources:
   ConstructionCorp reserved a whole source the moment ANY construction site
   existed — before a builder was fielded — halving income, which starved the
   spawn of the energy to fund the very builder the reservation waited for.
   At RCL2–3 sites exist almost constantly (extensions, containers), so prod
   has plausibly been running on ~half income for long stretches. Fixed on
   this branch (`7dc72c6`); the A/B below quantifies it.
2. **The A/B harness is the instrument.** `scripts/ab-cold-start.ts`: same
   world, real economy (no free-build mod), cumulative control points after N
   ticks; the bundle under test is the only variable. Baseline run of
   master vs this branch at 3000 ticks: results to be recorded here.
3. **The synthetic RCL5 stall** (1 miner + 2 haulers, no consumers, no errors;
   `scripts/diag-storage.ts --rcl5`) may share a root cause with slow prod
   progression — both smell like the spawn scheduler declining to fund
   consumers — but it is not itself a prod state. Keep it as a magnifying
   glass, not the target.
4. **Prod telemetry exists but hasn't been read.** The bot writes CPU, corp
   variance and fleet composition to RawMemory segments (`telemetry/`,
   `Memory.corpVariance`). An owner-assisted step: pull
   `Memory.corpVariance` and `global.flowStatus()` from the live colony —
   corps with chronically negative variance point straight at the stall.

## Working theory to test, in order

1. The reservation bug (already fixed here) was the dominant drag → A/B shows
   a large branch-over-master delta → **merging this branch is the prod fix**.
2. Spawn-scheduler holds: the wait-for-blocking rule parks the spawn waiting
   for bodies the room can only afford when full, while consumers
   (upgraders!) starve behind it. Symptom signature: spawn idle + energy
   rising + zero consumer spawns — visible in both the RCL5 repro and
   potentially prod telemetry.
3. Energy routed away from the controller: construction/repair churn
   consuming the surplus that should become control points (check
   `Memory.economyPlan` allocations vs realized variance).

## Acceptance tests

### A. Throughput pin — `test/integration/cold-start-throughput.test.ts`

The A/B scenario as a pass/fail test (real economy, no free-build mod), run
≤ 3000 ticks from the standard RCL2 cold start:

1. **No stall windows:** cumulative control points strictly increase in every
   500-tick window after tick 1000 (a flat window = the colony stopped
   upgrading = fail). This is the regression guard for the entire class of
   "economy silently parks" bugs, including the reservation bug.
2. **Throughput floor:** cp(3000) − cp(1000) ≥ `2000 × FLOOR_RATE`, where
   `FLOOR_RATE` is set to 80% of this branch's measured baseline (record the
   measurement in this spec when the A/B completes; do NOT guess it).
3. An upgrader creep (`workType === "upgrade"`) is alive at every sample
   after tick 1200 (consumers stay funded — the precise failure mode prod
   exhibits).

### B. Scheduler hold bound — unit, `test/unit/spawn/nextSpawn.test.ts`

New pin (exact): with a blocking demand whose `minCost` exceeds
`energyAvailable` but not capacity, AND any affordable consumer demand
waiting, the scheduler may hold at most `HOLD_BOUND` consecutive calls
(tick-stamped context) before funding the affordable demand. Choose and
document `HOLD_BOUND` when implementing; the test asserts the exact bound —
"holds forever" must be impossible by construction.

### C. RCL5 secondary repro

The synthetic stall (spec's original subject) must also clear: the
`rcl5-economy` criteria from the previous revision of this spec (≥2 miners,
≥1 upgrader, ≥1 builder, storage built, no 50-tick window with neither a
creep-count nor an energy change after tick 300, all within 1000 ticks)
remain as the magnified test of suspect 2. The miner-CARRY bisect from the
groundwork commit still applies if this repro implicates it.

### Regression gate

Unit suite + `flow-handoff` + `runt-economy` + `storage-depot` green.

## Out of scope

RCL5+ features (links — spec 02 stays blocked behind this), remote-mining
expansion of income (helps throughput but masks the stall class this spec
exists to kill).
