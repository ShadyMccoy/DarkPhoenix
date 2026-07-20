# Architecture: The Economic Pipeline (current)

> **Authority.** This note reflects the code as it actually is. Where it
> disagrees with `README.md`, `ARCHITECTURE.md`, `ECONOMIC_FRAMEWORK.md`, or
> `ROUTINES.md`, **this note and [`ONTOLOGY.md`](./ONTOLOGY.md) win** — those
> older docs describe a `FlowSolver` + market design that was **deleted**.
> Anchors are `file → symbol` (line numbers rot; a 2026-07-19 audit found 20+
> stale line anchors in this file's previous revision — don't reintroduce them).

## What changed (read this first)

- `FlowSolver` was replaced by a pure GOAP planner, **`economy/CorpPlanner.ts`
  → `planColony`**. The seam is `economy/flowAdapter.ts` → `solveColony` /
  `solveWithCorpPlanner`; `flow/FlowEconomy.ts` is a thin façade.
- The **market** layer (offers/contracts/clearing) is retired.
  `global.marketStatus()` is a mis-named stats dump.
- **Vocabulary:** the live corps are **HarvestCorp / CarryCorp** (old docs say
  MiningCorp / HaulingCorp). A *corp* is a **commission** — both the planning
  operator and the runtime owner of its creeps ([ONTOLOGY §4](./ONTOLOGY.md)).
- **Spec 17 (2026-07):** kinds integrate by REGISTRATION ONLY — the per-kind
  plumbing mirrors (SpawnDirector demand blocks, OrphanRescue lists,
  SpawningCorp's body switch, telemetry bucket maps) are deleted; their policy
  lives on the `CorpKind` contract. The NOW plan is prescriptive
  (`planAcquisitions`).

`FlowGraph`/`FlowEconomy`/`FlowSolution` survive as the **world-translation
layer** feeding the planner and the legacy telemetry DTO. The graph's own
`PriorityManager` priorities are vestigial (deletion tracked, spec 17 P5) —
sink values come from the planner's ladder (ONTOLOGY §7).

## The pipeline, end to end

Raw room state → a spawned creep, in seven hops:

```
terrain ─▶ Nodes ─▶ FlowGraph ─▶ ColonyProblem ─▶ ColonyPlan ─▶ Commissions ─▶ Corps ─▶ creep
 (1)        (2)        (3)            (4)             (5)            (6)          (7)
```

1. **Spatial → Nodes.** `spatial/algorithms.ts` runs a distance-transform from
   walls, finds peaks, thins them, and divides the map into nearest-peak
   **territories**. `execution/IncrementalAnalysis.ts` turns peaks into `Node`s,
   fills `node.resources` (`populateNodeResources`), and force-attaches owned
   spawns the territory BFS skipped (`attachOwnedSpawnsToNodes` — **without
   this the solver assigns zero miners**).

2. **Nodes → FlowGraph.** `flow/FlowGraph.ts` discovers `FlowSource`s
   (`rate = capacity/300`, `maxMiners` from mining spots), `FlowSink`s
   (spawn/controller/storage; SK rooms skipped), and builds source×sink edges
   with **real cached `pathDistance`**. Shapes in `flow/FlowTypes.ts`.

3. **FlowGraph → ColonyProblem.** `economy/flowAdapter.ts` → `buildColonyProblem`
   flattens the graph into a pure, `Game`-free `ColonyProblem`
   (`{spawns, sources, sinks, dist}`), pricing every sink from the compiled
   GOAL valuation (spec 18: `economy/goals.ts`, default = the measured
   ladder; `Memory.goal` via `global.setGoal`). It also injects **scavenge** sources
   (`economy/scavenge.ts`, stocks ≥ 750; feeder-bucket stocks excluded),
   **bank** sources (spec 03 draw-down: storage above `WARCHEST_TARGET`
   becomes a transient source — `economy/bank.ts`), and **link `haulPos`**
   (link-served sources haul from the core link). Sink `value` =
   `perInstanceSinkValue` over `DEFAULT_SINK_VALUE` (the ladder, ONTOLOGY §7);
   controllers carry the anti-downgrade `reserve`.

4. **ColonyProblem → ColonyPlan.** The strategic searcher runs first
   (spec 18: `economy/strategy.ts` — `searchStructure` may pin budget-dropped
   sources to spawns with slack, margin-gated, `planColony` as its
   evaluator), then the final structure's plan is the GOAL plan.
   `economy/CorpPlanner.ts` → `planColony`, all math from
   **`economy/primitives.ts`**:
   - `selectProducers` — assign each source to its nearest spawn, drop
     net-negative sources (`netEnergy`), fill each spawn's build-time budget
     (`miningBudgetPerSpawn`), ranking by net-energy-per-build-part.
   - `routeToSinks` — anti-downgrade reserve pre-pass, then value-descending
     fill from nearest supply; charges the **spawn-parts LEDGER** for
     consumer/infra work (spec 15: `controllerWorkSpawnLoad` etc.); with a
     storage hub, **hub-and-spoke** routing (mined energy → storage; consumers
     draw the bank source); **storage-full defund** and per-sink verdicts; the
     **invader tax** (spec 13) prices raid risk on remote routes.
   Output: `ColonyPlan` — miners/haulers/sinks + `partsLedger`,
   `spawnPartsUsed`, `valueDelivered`, `sustainable`.

5. **ColonyPlan → Commissions.** `economy/commissionPlan.ts` →
   `commissionsFromPlan` wraps the plan into **`Commission`** envelopes
   (`{corpId, kind, shape, consumes, produces, assignment}`): one
   produce/harvest per miner, one transport/carry per source (aggregating its
   routes), one consume per allocated sink. The `assignment` is **opaque** —
   only the kind reads it.

6. **Commissions → Corps.** `execution/CommissionHost.ts` → `runCommissionHost`
   (every tick) seeds the draft with the solver's commissions, lets every
   registered **`CorpKind`** `propose()` add its own, then
   `materializeCommissions` (`economy/CorpKind.ts`) binds each to a runtime
   **`Corp`** (with demobilize hysteresis while creeps live) and
   `runCommissionedCorps` runs them in `runOrder`. Persisted to
   `Memory.commissionedCorps`. The registered roster (the `KINDS` array — the
   ONE registration point): harvest(10), carry(20), upgrade(30), then scout,
   reservation, raidGuard, coreBuster, construction, tender (40),
   controllerFeeder (41), claim (45). Legacy outside the framework: bootstrap,
   spawning — folded into every census via `completeCensus`.
   - **Id spaces:** planner ids are flow-prefixed; kinds strip `source-` /
     `spawn-` at materialize. Corp ids are legacy-stable — a rename silently
     orphans live creeps (trap list).

7. **Corps → spawn (the NOW plan, prescriptive).** `execution/SpawnDirector.ts`
   → `runSpawnScheduling` per spawn: `collectDemands` — ONE generic loop over
   the census (uniform `getSpawnId`/`!retiring` filter, each corp's
   `getSpawnDemand`, the kind's `demandGroup` decoration) — then the pure NOW
   planner `spawn/SpawnScheduler.ts` → `planAcquisitions`, whose single
   decision walk yields the published agenda (`Memory.spawnAgenda`, every
   entry gate-annotated) AND the buy decision (= the `buy`-gated entry). The
   director executes it via `SpawningCorp.executeSpawn`, which dispatches body
   + workType through the buyer kind's declarations (`kind.body`,
   `kind.roles`), and files the execution receipt. Doctrine (tier ladder,
   holds, starvation, miner precedence) lives in `SpawnScheduler` alone.

After the corps run, `execution/OrphanRescue.ts` re-adopts or recycles any
creep no live corp claims — live ids from the census, rescue targets from the
kinds' declared roles and `claimsOrphan` rules.

## Tick cadences (`src/main.ts` → `loop`)

Three independent clocks — don't conflate them:

- **Execution: every tick.** Spawning + bootstrap corps → `runCommissionHost`
  → links/towers → orphan rescue → `runSpawnScheduling`.
- **Economy re-solve:** the CPU governor's plan (`execution/CpuGovernor.ts`:
  `FULL_SOLVE_INTERVAL` = 50 at full/lean, `STRETCHED_SOLVE_INTERVAL` = 150
  degraded), or eagerly when nodes exist but no produce-shaped commission is
  materialized (bootstrap gate in `main.ts`).
- **Spatial/terrain analysis:** ≤ every 5000 ticks
  (`MULTI_ROOM_ANALYSIS_CACHE_TTL`), spread incrementally across ticks;
  node-resource refresh on its own 50-tick clock.

## Current vocabulary (use these names)

| Concept | What it is | Home |
|---|---|---|
| **CorpPlanner** | pure GOAP planner; the brain | `economy/CorpPlanner.ts` |
| **ColonyProblem / ColonyPlan** | pure input / planner output | `economy/CorpPlanner.ts` |
| **Commission** | one corp's envelope (shape + consumes/produces + opaque assignment) | `economy/Commission.ts` |
| **CorpKind** | the registration-only contract: propose/materialize/run/persist/body + roles/demandGroup/sourceOf/claimsOrphan | `economy/CorpKind.ts` |
| **Corp** | runtime owner of creeps; variance meter (unitsProduced vs budgetedRate) | `corps/Corp.ts` |
| **NOW planner** | `planAcquisitions`: one walk → agenda + buy | `spawn/SpawnScheduler.ts` |
| **completeCensus** | the whole corp roster (store + legacy), the audit layer's source | `execution/CommissionHost.ts` |
| **primitives** | the single canonical home for economic math | `economy/primitives.ts` |

## Deleted / vestigial — do not build on these

- **Deleted:** `FlowSolver`, the market/offer/contract layer, `EconomyPlanner`,
  `FlowMaterializer`, the chain/ROI layer, per-corp money accounting,
  SpawningCorp's role switch, OrphanRescue's kind/role lists, SpawnDirector's
  per-kind demand blocks, telemetry's kind→bucket map.
- **Also deleted (spec 17 P5 sweep, 2026-07-20):** `flow/PriorityManager.ts`
  + the dynamic sink-priority recalc (the second ladder), `flow/NodeFlow.ts`,
  the `FlowEconomy` query/metrics/preset API (the façade is five live
  methods), the FlowSolver input machinery (`getFlowProblem`/`FlowProblem`/
  `FlowConstraints`), the survey/market console vestiges (`global.survey`,
  `global.marketStatus`, `runSurveyPhase`/`runPlanningPhase`/
  `runExecutionPhase`), the always-empty `Node.corps` web, the NodeSurveyor
  ROI estimators, `framework/EdgeVariant` beyond `HaulerRatio`/`MiningMode`,
  and `scripts/plan-budget.ts`. `FlowSink.priority` survives only as a
  telemetry passthrough (default 0).
- **Not yet ported to the framework:** `BootstrapCorp` and `SpawningCorp`
  (infrastructure; folded into the census by `completeCensus`).

See [`ONTOLOGY.md`](./ONTOLOGY.md) for the layer model and kind contract, and
[`specs/17-ontology-layers.md`](./specs/17-ontology-layers.md) for the
enforcement program.
