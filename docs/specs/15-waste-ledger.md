# 15 — Waste ledger: make every leak a measured number

**Status:** proposed 2026-07-18 (owner directive: "identify, measure,
eliminate or minimize any wastes of CPU, energy, or spawn time, either in
planning or execution — make the basic mechanics sing"). Phase 1 is
audit-side only (no bot changes); phases 2–4 add in-bot counters via the
spec 14 decision-symmetry pattern.

## Principle

A leak that isn't a number is an anecdote. Every waste class below gets a
NAME, a UNIT (energy/tick, parts/tick, CPU/tick), a MEASUREMENT SOURCE, and
a target (usually ~0; some have a floor by design). The audit loop
(`/production-audit`) ranks the ledger by size each cycle and attacks the
top line. "Eliminated" means the measured number went to target and a
regression test pins it.

Tonight's incidents, priced, seed the ledger: the reserver purchase loop
was E1+S1 (58 e/t + 53% of build time); the stranded remote haulers E2
(~2,800e of body, 45% of hauler fleet); the idle warchest E4 (594k, ~20×
target); the floored upgrader X1's mirror image (planned 30–44 e/t of
progress unconverted).

## The ledger

### Energy leaks (e/tick unless noted)

| id | leak | measurement |
|----|------|-------------|
| E1 | purchase-void: spawn energy on creeps that die before ~25% of expected life (loops, insta-recycles, doomed newborns) | phase 4 counter: per-corp life-fraction at death; until then, receipts × census diffing |
| E2 | stranded fleet: actual bodies serving routes absent from the current plan | EXISTS: flow plan carry/work vs segment-4 actual, per corp |
| E3 | ground decay: dropped energy rotting (1/1000/t), decaying containers | phase 2 counter in scavenge/room ledger: `decayLoss` |
| E4 | idle capital: `storageEnergy` above WARCHEST_TARGET with the spend path down | EXISTS: room ledger + feeder gate |
| E5 | runt purchases: bodies below the efficient floor bought from a drained spawn | EXISTS: agenda receipts (cost) + body floors |

### Spawn-time leaks (parts/tick of the 1/3 ceiling)

| id | leak | measurement |
|----|------|-------------|
| S1 | loop/void purchases (S-side of E1) | same as E1; historically up to 0.18 parts/t (53%) |
| S2 | oscillation rebuilds: parts spawned for plans that flip within a creep lifetime | EXISTS: `candidates[]` verdict flips between captures × parts |
| S3 | scheduler stall: spawn idle while agenda queue is non-empty and affordable | EXISTS: meter `utilization` vs `queueDepth` + `fundingNeed` |
| S4 | replacement mistiming: double-orders or dark posts around handoffs | staffsPost cells pin the mechanism; phase 4 life-fraction exposes residuals |

### CPU leaks (CPU/tick of the 300 limit)

| id | leak | measurement |
|----|------|-------------|
| C1 | per-phase cost unknown: main-loop phases (plan, execute, telemetry, pathing) are unmetered in telemetry | phase 3: export bulkhead phase timings (main.ts already brackets phases) to core segment |
| C2 | recompute churn: replanning/pathing redone without input change | after C1: phase timings vs plan-input hash stability |

### Planning leaks

| id | leak | measurement |
|----|------|-------------|
| P1 | plan flap: sources/routes flipping funded↔excluded between solves | EXISTS: `candidates[]` diff between captures (flap rate, parts wasted → S2) |
| P2 | micro-routes: planned flows below the 3-CARRY body floor, each forcing an over-built body | EXISTS: flow `haulers[].carryParts < 3` (measured: 7/10 routes, 6.5 planned carry → ≥21 fielded) |
| P3 | budget-model divergence: planner `spawnPartsUsed` vs measured `partsPerTick` | EXISTS: both sides exported (plan spawnPartsUsed vs meter) |
| P4 | plan spawn-infeasibility: the WHOLE plan's amortized maintenance (parts/tick, ALL fleet classes — transient routes, consumers, infra, budgeted or not) vs the physical `spawnCount × 1/3` ceiling. Above 1.0 actuals converge to the ceiling, never the plan (measured 2026-07-18: 1.68×; the queue-priority incidents were the symptom) | EXISTS: ledger `planSpawnLoad` from flow plan + measured body ratios |
| P5 | price/behavior drift: a pricing constant encodes a behavioral assumption the executor doesn't implement (found: `RESERVER_DUTY = 0.5` priced while the corp gate re-staffs continuously, never reading the reservation bank — 2× the priced spawn+energy cost). Every such constant gets a ledger check | ledger: structural check + staffing proxy; exact once phase 2 exports `reservation.ticksToEnd` |
| P6 | reservation under-pump: fielded CLAIM parts adding less bank than they should (walking between posts, blocked, dead — "reservers not reserving", owner 2026-07-19) | EXISTS: per-room `pump = bank2 − (bank1 − stampDt)` from the P5 sizing stamps; FAIL all-rooms-zero with parts fielded, WARN ≥half (first live read: W42N22 +20 W42N23 +66 W43N24 0 W44N23 0 over 156t — the one-way-violation churn as a number) |
| P7 | controller under-delivery: actual `ΔrclProgress/dt` vs the LOWER endpoint plan's controller allocation ("upgraders not upgrading") | EXISTS: ledger from rooms[] + flow sinks; FAIL <0.5× with stock >500 standing at both endpoints (the energy was there); the lower-endpoint comparator never false-fails a doctrine shift (construction preempt measured 86.3→2.0) |
| P8 | build under-delivery: sites standing, construction funded at both endpoints, summed site progress FLAT ("builders not building") | EXISTS (v6): rooms[] `siteProgress/siteTotal/siteCount`; completions (count/total drop) read ambiguous and are skipped; pre-v6 captures skip the row |

### Execution leaks

| id | leak | measurement |
|----|------|-------------|
| X1 | dry WORK ticks: upgraders/builders in position with no energy to burn | phase 2 counter per corp: `workTicks`/`dryTicks` (sizing-record style) |
| X2 | deadhead hauling: hauler ticks moving empty beyond the unavoidable return leg | phase 2 counter: loaded vs empty move ticks |
| X3 | idle creeps: alive, assigned nothing | phase 2 counter, plus census `untracked` (EXISTS) |

## Phases

1. **Ledger report (audit-side, no bot changes)** — a `scripts/waste-ledger.ts`
   that takes two captures and prints the ledger: every EXISTS row computed,
   ranked by magnitude, with deltas vs the previous run. **DONE 2026-07-18**
   (`npm run audit:ledger`, wired into /production-audit §1 as the mandatory
   first read). Acceptance retargeted to the v5 fixture pair
   (t72404213/t72411542) in `test/unit/audit/wasteLedger.test.ts`: P4 FAIL
   >1.2× with the unbudgeted transient line named, P5 FAIL until the corp
   reads the reservation bank, E4 FAIL at 601k idle, E2 catches 48 parts of
   stranded scavenge haulers, S3 discriminates a funding hold from a stall.
   (The originally named t72402541 numbers predate the v5 schema; that
   incident's mechanism is pinned by its own regression tests.) Origin of P4/
   P5: the owner had to ask "is planning weighting effective ttl" and walk the
   reserver arithmetic by hand — the audit must catch accounting invariants,
   not only symptoms.
2. **Execution counters in-bot** — X1/X2/X3 + E3 accumulated per corp
   (decision-symmetry: counted where the work happens), exported in sizing
   records / room ledger. Corps segment bump.
3. **CPU phase export** — C1 via existing main.ts bulkhead brackets into the
   core segment.
4. **Purchase-outcome tracking** — E1/S1: per-corp life-fraction-at-death
   histogram (died <25% / <50% / full), exported; the definitive
   loop-purchase detector.

Each phase red-first; live-behavior changes none (all observability) except
any fixes the ledger motivates, which follow the /production-audit fix
protocol.

## Non-goals

- No optimization without a ledger line first (no "this feels wasteful").
- No CPU micro-tuning while C1 is unmeasured.
- The ledger reports; it never throttles or decides in-bot.
