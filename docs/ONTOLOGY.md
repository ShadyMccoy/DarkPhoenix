# Colony Economy Ontology

This document defines the concrete model the colony's economy is built on, names
the overlapping/shadow systems being collapsed into it, and describes the
GOAP-style planner whose operators are corps.

It is the reference the code is being shaped to match. When code and this
document disagree, that is a bug in one of them — fix it, don't let them drift.

---

## 1. Entities (the world)

| Entity | What it is | Key facts |
|--------|-----------|-----------|
| **Room** | A 50×50 tile grid, owned or remote. | Holds sources, a controller, structures. |
| **Source** | An energy producer. | Yields `capacity/300` e/tick (≤10 standard); has `maxMiners` mining spots. A **Producer**. |
| **Sink** | An energy consumer with a *value* and a *capacity*. | Spawn (overhead), Controller (upgrade), ConstructionSite (build), Storage (buffer). A **Consumer**. |
| **Spawn** | A creep factory with a build-time budget. | Builds 1 body part / 3 ticks (`SPAWN_PARTS_PER_TICK`). The scarce resource. |
| **Position / distance** | Real walking distance between two tiles. | `pathDistance` (cached, wall/swamp-aware). The cost driver for hauling. |

These are *physical givens*. The planner does not change them; it decides what
to build on top of them.

## 2. Economic primitives (`src/economy/primitives.ts`)

One definition of every per-tick economic quantity. Semantics match the live
path: a creep posted `distance` tiles away loses ~`distance` ticks walking out,
so its cost amortises over `effectiveLife(distance) = CREEP_LIFETIME - distance`.

- `roundTripTicks(d) = 2d + 2`
- `carryPartsFor(rate, d) = rate · roundTrip / 50`
- `minerOverhead(d) = MINER_COST / life(d)`
- `haulerOverhead(carry, d) = carry · (CARRY+MOVE) / life(d)`
- `netEnergy(rate, d) = rate − minerOverhead − haulerOverhead` — the profitability of a source
- `spawnPartsFor(rate, d) = (MINER_PARTS + 2·carry) / life(d)` — build-time the source's miner+haulers cost
- `miningBudgetPerSpawn() = SPAWN_PARTS_PER_TICK · MINING_BUDGET_FRACTION` — build-time a spawn lends to income

Everything economic derives from these. No module reimplements them.

## 3. The Corp (the building block / GOAP operator)

A **Corp** is a *commission*: a unit of economic activity that consumes spawn
build-time (and maybe energy) and produces energy-at-a-place or colony value. It
is simultaneously

- the **planning operator** (a candidate action the planner can take), and
- the **runtime owner** of the creeps that execute it.

| Corp | Role | Consumes | Produces | Cost |
|------|------|----------|----------|------|
| **HarvestCorp** | Producer | a Source + spawn parts | `rate` e/tick at the source | `minerOverhead` + miner spawn parts |
| **CarryCorp** | Transport | energy at a source + spawn parts | `rate` e/tick delivered at a sink | `haulerOverhead` + hauler spawn parts |
| **UpgradingCorp** | Consumer | energy at the controller + spawn parts | controller progress (value) | worker overhead + spawn parts |
| **ConstructionCorp** | Consumer | energy at a site + spawn parts | structures (value) | worker overhead + spawn parts |
| **ScoutCorp / ReservationCorp / BootstrapCorp** | Auxiliary | spawn parts | intel / reservation / cold-start rescue | off the income budget |

Lifecycle (uniform across types): **create → plan(tick) → work(tick) →
serialize**. The planner sets a corp's *assignment* (size + targets); the corp
executes it and reports variance.

## 4. The Plan (GOAP output)

A **ColonyPlan** is a set of commissioned corps with sizes such that:

1. **Energy balance** — delivered energy ≥ consumed energy (sustainable).
2. **Spawn budget** — per spawn, Σ `spawnPartsFor(source)` ≤ `miningBudgetPerSpawn()`.
3. **Value maximised** — Σ (energy delivered to sink × sink.value) − overhead is maximised.

## 5. GOAP framing

- **Goal:** maximise colony value-rate (weighted energy delivery) subject to feasibility.
- **State:** which sources are staffed, spawn build-time remaining per spawn, energy supply vs demand.
- **Operators (actions):** commission a corp — *mine S*, *haul S→K*, *upgrade*, *build* — each with
  - **preconditions** (haul S→K requires S mined),
  - **cost** (`spawnPartsFor`, overhead),
  - **effect** (energy produced / moved / consumed).
- **Exploration:** assign each source to its best (nearest) spawn; rank candidate income
  corps by **net energy per build-part**; fill each spawn's mining budget highest-value-first;
  route the delivered energy to sinks by value, respecting capacity and reserves.

  This is the corp-atomic rule — *complete the highest-value income corp before opening the
  next* — generalised from one spawn to N. At N=1 it is trivial (saturate the source, size
  the haulers, feed the controller); at N>1 it is the same rule per spawn with sources
  assigned to their nearest spawn. We build and test it 1→2→3→N and trust it to generalise.

## 6. Systems being collapsed into this model

The economy currently runs **two** solvers plus several vestigial layers. The
target is ONE planner (the GOAP `CorpPlanner`) whose operators are corps.

| System | File(s) | Status | Disposition |
|--------|---------|--------|-------------|
| **CorpPlanner** | `economy/CorpPlanner.ts`, `economy/flowAdapter.ts` | ✅ LIVE — the single economy authority | — |
| **FlowSolver** | `flow/FlowSolver.ts` | ✅ DELETED | `printSolutionSummary` relocated to `FlowEconomy`; unique behavior pin (far-source-with-spare-budget) migrated to the CorpPlanner test |
| **EconomyPlanner / EconomyAdapter** | `flow/EconomyPlanner.ts`, `flow/EconomyAdapter.ts` | ✅ DELETED | Absorbed by `CorpPlanner`; overlay removed from `main.ts` |
| **Duplicate formulas** | 9 files (see analysis) | ✅ collapsed | `economy/primitives.ts` is the canonical home. CarryCorp/ConstructionCorp/BodyBuilder/HarvestCorp/UpgradingCorp/FlowGraph now call `carryPartsFor`/`effectiveLife`/`roundTripTicks`; the FlowTypes copies (`calculateRoundTrip`/`calculateCarryParts`/`calculateHaulerCostPerTick`) are deleted |
| **Four "value" models** | mintValue / net-energy / effectiveNet / sink.value | ✅ one model | `DEFAULT_SINK_VALUE` in the planner (spawn 100 / construction 70 / controller 50) |
| **ChainPlanner / Chain / projections / OfferCollector** | `planning/*`, `corps/CorpState.ts` | VESTIGIAL — not driving spawns; market-era artifact | Out of scope now; isolate, then retire |
| **EdgeVariant variant search** | `framework/EdgeVariant.ts` (`generateEdgeVariants`/`selectBestVariant`), `FlowSolver` terrain branch | DEAD — `edge.terrain` never populated | Remove functions + branch; keep `HaulerRatio`/`MiningMode` types (used by body building) |
| **FlowEdge (framework)** | `framework/FlowEdge.ts` | DEAD — imported only by EdgeVariant + its test | Remove |

### Progress (this pass)

Done: ontology + canonical `economy/primitives.ts` (15 tests); GOAP `CorpPlanner`
(11 tests, 1→N); `flowAdapter` drop-in (3 tests); **swapped live** in
`FlowEconomy.solve`; shadow `EconomyPlanner`/`EconomyAdapter` **deleted** (~600
LOC); profitability test migrated to the live planner. Validated by the fast
fixture harness (singleSource / twoSourceRcl3 / threeChamberRcl2 all mine their
sources).

Consolidation pass two: `FlowSolver` **deleted** (with `solveIteratively`,
`calculateEfficiency`, `estimateOverhead`; `printSolutionSummary` relocated to
`FlowEconomy`); the duplicate formula call-sites **migrated** to `primitives`
(CarryCorp, ConstructionCorp, BodyBuilder, HarvestCorp, UpgradingCorp,
FlowGraph) and the FlowTypes copies deleted; dead `calculateHaulingNeeds` /
`calculateTankerCarryNeeded` (BodyBuilder) and the broken
`scripts/compare-efficiency.ts` removed. 394 unit tests pass.

Next: retire the vestigial chain/market layer (`ChainPlanner`/`ColonyEconomy` -
note `marginalNodeValue` is still live in `IncrementalAnalysis` and needs a new
home first).

### Integration contract

`CorpPlanner` emits the same shape the materialiser already consumes
(`MinerAssignment[]`, `HaulerAssignment[]`, `SinkAllocation[]` — i.e. a
`FlowSolution`). That makes it a **proven drop-in** for `FlowSolver.solve`: swap
the call, delete the loser, keep the corps/materialiser/scheduler untouched.
