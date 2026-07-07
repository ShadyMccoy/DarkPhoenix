# 01 — Early-game progression: prod has never reached RCL4

**Status:** OPEN — P0. Reframed 2026-06-12: production has never organically
reached RCL4, so the original subject of this spec (a synthetic RCL5 cold-start
stall in the test harness) is demoted to a secondary repro — prod never enters
that state. The primary question is: **what caps or stalls the colony's
control-point throughput at RCL2–3?**

## BREAKTHROUGH 2026-07-07 — two compounding starve mechanisms found and fixed

The inflection grid (spec 08) isolated, reproduced deterministically, and
fixed two mechanisms that together produce exactly the "~1200-1700 ticks at
ZERO controller progress" signature (commit `4e4c97f`; diag traces in
`scripts/diag-circuit.ts` / `scripts/diag-d22.ts`):

1. **The critical-divert steal** (`CarryCorp.spawnNetworkCritical`): during
   buildout the bank sits below the 50% divert gate almost continuously, so
   the controller-homed hauler's trip was overridden to 'spawn' on EVERY
   flip — the solver's controller allocation, anti-downgrade reserve
   included, was never physically delivered (controller progress 0 for 700+
   observed ticks). Fixed by counting fleet-mates' inbound committed cargo:
   a covered deficit is not an emergency.
2. **The empty starvation backstop** (`SpawnScheduler`): the STARVED_TIER
   lift only reorders the walk; an unaffordable NON-BLOCKING demand was
   skipped regardless of rank, so every cheaper demand kept eating the
   200-299 band and (e.g.) a scaling hauler at min 300 never spawned at 300
   capacity. Starved demands now gain hold semantics — the one-guaranteed-
   spawn promise is real.

Measured (sim:ab, same two-source cold world as the table below): cp@1500
was **200 flat** before and with fix 1 alone; with both fixes **252 and
climbing**, 2 upgraders live, both hauler circuits staffed. Remaining drag:
convergence still leans on the 300-tick starvation threshold (the d=22 grid
cell converges at tick ~726) — candidate next lever: shorter threshold or
income-aware demand pricing, to be A/B'd separately.

### 2026-07-07 bisect: the fixes trade spawn TEMPO for convergence

Same-era isolated 3000-tick draws on the ab-cold-start world:

| bundle | cp@3000 |
|--------|---------|
| pre-fix (4e4c97f~1) | 7711 |
| fix 1 only (inbound-aware divert) | 2901 |
| fix 2 only (starved-hold) | 2805 |
| both | 3942 / 3050 (two draws) |

**RESOLVED 2026-07-07 (energy-led retuning, commit fcc8adc):** the owner set
the metric - ENERGY is the leading cold-start indicator, cp trails; the
fleet-first invest-early strategy is desired; sequence greedy->RCL2 ->
extensions -> containers -> RCL3 push. Refinements: starved holds now protect
INCOME demands only (consumers keep the one-shot rank lift, never idle the
spawn), and containers unlock at RCL2 once the extension set is built.
Same-condition instrumented A/B @3000 (identical build order, only
scheduler/carry deltas): refined mined 38,036 (12.7/t) / invested 33,092 /
cp 6,493 vs pre-fix mined 33,106 (11.0/t) / invested 37,945 / cp 4,852 -
the refined bundle mines +15% MORE energy, spends -13% LESS on spawning, and
still leads cp, while keeping the no-stranding convergence guarantee (grid:
82/84, BOT LEVEL 3, both known-reds documented). The earlier reading below
is retained for history:

Reading: EACH fix alone halves cp on this friendly world - both throttle
spawn tempo (fix 1 keeps controller loads out of the spawn engine; fix 2
idles the spawn on holds), and the pre-fix bot's aggressive spawn-first
behavior compounds fleet -> income -> late upgrading. BUT the pre-fix bot
scores ZERO FOREVER on the adversarial worlds (single-source d=22:
controller progress 0 for 700+ measured ticks; the deadlock is pinned by
grid cells plan-t1-single-source-loop / haul-t1-circuit-split, which the
ratchet keeps green). The open engineering problem is a PRESSURE-AWARE
version of both mechanisms: divert/hold only when the colony is actually
starving on the relevant axis, so friendly worlds keep pre-fix tempo and
adversarial worlds keep the convergence guarantee. Next session: instrument
spawn-idle ticks + spawn events per 100 ticks in fixed-vs-prefix A/B runs to
locate exactly where the tempo goes, then tune under the double constraint
(grid green AND cp@3000 recovered toward 7700).

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
   ticks; the bundle under test is the only variable. Baseline, 3000 ticks,
   ONE run each (high variance - use `sim:variance` before drawing fine
   conclusions):

   | bundle | cp@1000 | cp@1500 | cp@2000 | cp@3000 | fleet@3000 |
   |--------|---------|---------|---------|---------|------------|
   | master (fce0e84) | 200 | 200 | 1893 | 7743 | 4 harvest / 11 haul / 6 upgrade |
   | branch (7dc72c6+) | 200 | 599 | 3450 | 6880 | 3 harvest / 6 haul / 6 upgrade |

   Readings: (a) **both bundles spend ~1200-1700 ticks at ZERO controller
   progress from cold start** - the single most damning, owner-thesis-
   confirming number: not one bug, the whole bootstrap-to-flow pipeline is
   slow; (b) the branch starts upgrading ~500 ticks earlier but this single
   run ended ~11% lower cumulative - within plausible run-to-run noise, and
   the branch fields half the haulers for the same upgraders (cheaper fleet);
   (c) master's variance rows show a fully stalled mining corp (0/10) and a
   near-dead hauler (0.2/9.93) at t=3000 - chronic zombie corps. No smoking
   gun; a collection of drags, exactly as the owner called it.
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

## Post-cutover measurement (2026-06-16, framework migration complete)

Re-ran `sim:ab` (3000 ticks) on the framework-complete branch, with a per-200-
tick creep+variance trace (ab-cold-start now prints these):

| t | cp | creeps | upgrade variance |
|---|----|--------|------------------|
| 200-1000 | 200 | building miners+haulers, no upgraders | mining 0-6, upgrading 0 |
| 1000 | 200 | +6 upgraders appear | **upgrading 0/17.67** |
| 1200-1800 | 200 | 6 upgraders, miners 6-12, haulers 6-12 | **upgrading 0/10 (idle!)** |
| 2000 | 466 | same fleet | upgrading 2.35/16.56 (starts) |
| 3000 | **9072** | 4 harvest / 8 haul / 6 upgrade | mining 12/10, healthy |

Two headline results: (1) **the branch now beats master** - cp@3000 9072 vs
master's 7743 and the early-branch 6880; the cutover is a net economic win, and
the zombie-miner signature is GONE (both miners 12/10). (2) **The cold-start
zero-progress window is fully explained and is the remaining prize.** Diagnosis:
from t=0 the colony builds its income fleet; the spawn sink (value 100) consumes
ALL hauled energy while the fleet is built/upsized, so the controller (lower
value) gets nothing. Yet ~6 upgraders are fielded by t=1000 because
UpgradingCorp sizes targetCount from the OPTIMISTIC flow allocation (the full
steady-state surplus, ~12-18 e/tick -> 6 small upgraders), not realized
delivery. Those 6 upgraders sit at `upgrading 0/10` for ~800-1000 ticks until
the fleet stops upsizing, the spawn finally fills, and surplus reaches the
controller (~t=2000). Each idle upgrader also burned a spawn cycle that could
have completed the income fleet sooner. Theory to test: bound the upgrader fleet
GROWTH by realized controller delivery (ramp from 1, add more only once the
existing upgraders are actually fed) so the colony fills the spawn / completes
income first and surplus reaches the controller earlier.

### Experiment (2026-06-16): ramp upgraders by realized delivery — REFUTED

Tested the theory two ways via `sim:ab` (3000 ticks), both reverted:

1. **Gate growth on spawn-network near-full** (a surplus proxy): start was
   ~600 ticks faster (cp 2178@t2000 vs 466) but cp@3000 collapsed to **4118**
   (vs 9072 baseline) - the spawn is essentially never 90% full during active
   spawning, so upgraders stayed pinned at 1-2 and the controller chronically
   under-consumed.
2. **Gate growth on "an upgrader upgraded within 60 ticks"** (realized
   delivery): even worse, cp@3000 **1295**. Held at one small (~2-WORK)
   upgrader almost the whole run; the controller could not absorb the supply,
   so energy piled up and the colony fielded 10-11 haulers instead, whose spawn
   cycles then crowded out upgrader growth.

**Conclusion - the premature-upgrader hypothesis is WRONG.** The "idle" 6
upgraders are not waste; they are READY CAPACITY that consumes controller energy
the instant it arrives. Throttling the upgrader count starves the controller far
more than the idle spawn cycles ever cost - the baseline (size to the optimistic
allocation) is strictly better (9072). The cold-start zero-progress window is
dominated by INCOME-FLEET BUILD-OUT (miners+haulers being built and runt-upsized
while the spawn consumes all hauled energy), not by consumer over-fielding.
Future effort should target the income fleet's time-to-complete (e.g. fewer
runt-recycle upsizing cycles, or larger first bodies) rather than consumer
gating - but note master is already beaten, so this is optimization, not a bug.

## Warm steady-state throughput (2026-06-16): the ceiling is CONSUMPTION, not hauling

Built a fast warm-start harness (sim:warm captures a warm colony once; sim:carry
replays it and measures steady-state delivery in ~500 ticks ≈ 1 min) to isolate
the steady-state ceiling from the cold-start. Standard two-source RCL2 room,
instrumented per-sink energy fate:

| quantity | e/tick |
|---|---|
| mined (2 sources) | ~20 (22 with burst drain) |
| delivered to controller | **~15** |
| delivered to spawn network | ~1 |
| decayed at source (not hauled) | ~6 (the far/walled source) |
| **upgraded (actual cp/tick)** | **~7** |

The surprise: **hauling is NOT the bottleneck - 15 e/tick reaches the
controller, but only ~7 becomes cp.** The other ~8 piles up at the controller
and decays. The binding constraint is CONTROLLER-SIDE CONSUMPTION: ~6 small RCL2
upgraders (≈2 WORK each) fetch dropped energy then upgrade, idling ~40% of ticks
on the fetch cycle, with no upgrader container at RCL2 so the surplus decays on
the ground. Raising UPGRADER_COUNT_CAP 6->12 did NOT help (cp/tick stayed ~7;
the extra upgraders crowd the controller's limited tiles and even *reduce*
delivery). Removing the spawn diversion (pure "bus route") was slightly worse
(6.19 vs 6.88) - the diversion usefully rescues spawn-overflow to the controller.

So the realized ceiling at warm RCL2 is **~7 cp/tick (~31% of the ~20-25 e/tick
income)**, gated by controller consumption. Levers, in likely-impact order:
(1) an upgrader CONTAINER/link at the controller (upgraders withdraw in place
instead of chasing decaying drops - cuts the fetch idle and the decay loss);
(2) bigger upgrader bodies (more WORK/creep, which RCL-up provides);
(3) the far source's ~6 e/tick haul shortfall (scenario-specific to the wall).
Income, the spawn split, and hauler "thrash" are all NOT the limiter at warm
steady state. New harness: scripts/snapshot-warm.ts + scripts/carry-efficiency.ts.

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
