# Architecture: The Economic Pipeline (current)

> **Authority.** This note reflects the code as it actually is. Where it
> disagrees with `README.md`, `ARCHITECTURE.md`, `ECONOMIC_FRAMEWORK.md`, or
> `ROUTINES.md`, **this note and [`ONTOLOGY.md`](./ONTOLOGY.md) win** — those
> older docs describe a `FlowSolver` + market design that has been **deleted**.
> Anchors are `file:line` into `src/` and were verified against the source.

## What changed (read this first)

The README sells a greedy **`FlowSolver`** over a `FlowGraph`, and `ROUTINES.md`
talks about a **market** of offers/contracts. Neither exists anymore:

- `FlowSolver` was replaced by a pure GOAP planner, **`economy/CorpPlanner.ts`
  → `planColony()`**. The seam is `economy/flowAdapter.ts:203`
  (`solveWithCorpPlanner`); `flow/FlowEconomy.ts` is now a thin façade.
- The **market** layer (offers/contracts/clearing) and the shadow
  `EconomyPlanner` overlay are retired. `global.marketStatus()` is just a
  mis-named stats dump.
- **Vocabulary:** the live corps are **HarvestCorp / CarryCorp** (old docs say
  MiningCorp / HaulingCorp). A *corp* is a **commission** — a unit of economic
  activity that consumes spawn build-time (±energy) and produces
  energy-at-a-place or colony value. It is both the planning operator and the
  runtime owner of its creeps.

`FlowGraph`/`FlowEconomy`/`FlowSolution` survive only as a **translation layer**
feeding the planner and as the legacy output shape for telemetry. The graph's
own `PriorityManager` priorities are largely vestigial — the planner values
sinks with its own `DEFAULT_SINK_VALUE` ladder (`CorpPlanner.ts:99`).

## The pipeline, end to end

Raw room state → a spawned creep, in seven hops:

```
terrain ─▶ Nodes ─▶ FlowGraph ─▶ ColonyProblem ─▶ ColonyPlan ─▶ Commissions ─▶ Corps ─▶ creep
 (1)        (2)        (3)            (4)             (5)            (6)          (7)
```

1. **Spatial → Nodes.** `spatial/algorithms.ts` runs a distance-transform from
   walls (`:229`), finds peaks (`:348`), thins them (`:467`), and divides the
   map into nearest-peak **territories** (`:831`). `execution/IncrementalAnalysis.ts`
   turns peaks into `Node`s (`:331`, private), fills `node.resources`
   (sources/controller/spawn/storage) in `populateNodeResources` (`:523`), and
   force-attaches owned spawns the territory BFS skipped in
   `attachOwnedSpawnsToNodes` (`:475` — **without this the solver assigns zero
   miners**). Output: `Node` (`nodes/Node.ts:149`).

2. **Nodes → FlowGraph.** `flow/FlowGraph.ts` discovers `FlowSource`s (`:107`,
   `rate = capacity/300`, `maxMiners` from mining spots), `FlowSink`s (`:144`,
   spawn/controller/storage; SK rooms skipped), and builds source×sink edges
   with **real cached `pathDistance`** (`:216`). Shapes in `flow/FlowTypes.ts`.

3. **FlowGraph → ColonyProblem.** `economy/flowAdapter.ts` `buildColonyProblem`
   flattens the graph into a pure, `Game`-free `ColonyProblem` (`CorpPlanner.ts:90`):
   `{spawns, sources, sinks, dist}`. It also injects **scavenge** sources
   (dropped energy/tombstones ≥ 750, `scavenge.ts`; stocks inside a
   feeder-managed controller bucket are excluded — the feeder would just
   refill them), **bank**
   sources (spec 03 surplus draw-down: a storage above `WARCHEST_TARGET`
   becomes a transient source and its room's storage sink is dropped —
   `economy/bank.ts`), and **link `haulPos`**
   (a link-served source is *hauled* from the core link by storage but *mined*
   at the real walk distance). Sink `value` = `DEFAULT_SINK_VALUE`; controllers
   carry `reserve = ANTI_DOWNGRADE_RESERVE` (2).

4. **ColonyProblem → ColonyPlan.** `economy/CorpPlanner.ts:352` `planColony`,
   two GOAP phases, all math from **`economy/primitives.ts`** (the one canonical
   home — no module reimplements these formulas):
   - **`selectProducers` (`:189`)** — assign each source to its nearest spawn,
     drop net-negative sources (`netEnergy`, `primitives.ts:73`), and fill each
     spawn's **build-time budget** `miningBudgetPerSpawn()` = `SPAWN_PARTS_PER_TICK
     (1/3) × MINING_BUDGET_FRACTION (0.6)` (`primitives.ts:96`), ranking by
     **net-energy-per-build-part** (`net/parts`, `:221`). A spawn's best source
     is always staffed.
   - **`routeToSinks` (`:280`)** — a reserve pre-pass for the anti-downgrade
     floor (`:337`), then value-descending fill from nearest supply (`:341`),
     each source→sink flow becoming one hauler.
   Output: `ColonyPlan` (`:141`) with `miners`, `haulers`, `sinks`,
   `spawnPartsUsed`, `valueDelivered`, `sustainable`.

5. **ColonyPlan → Commissions.** `economy/commissionPlan.ts:51`
   `commissionsFromPlan` wraps the plan into **`Commission`** envelopes
   (`economy/Commission.ts:51`): `{corpId, kind, shape, consumes, produces,
   assignment}`. One **produce/harvest** per miner, one **transport/carry** per
   source (aggregating its routes), one **consume/upgrade|build** per allocated
   sink. The `assignment` is **opaque** — only the kind reads it.

6. **Commissions → Corps.** `execution/CommissionHost.ts:96` `runCommissionHost`
   (every tick) seeds the draft with the solver's commissions, lets each
   registered **`CorpKind`** `propose()` add its own (auxiliaries:
   scout/reservation/extensionTender/construction), then `materializeCommissions`
   (`economy/CorpKind.ts:116`) binds each to a runtime **`Corp`** and
   `runCommissionedCorps` runs them in `runOrder` (10 produce → 20 transport →
   30 consume → 40 auxiliary). Persisted to `Memory.commissionedCorps`.
   - **Live strangler seam:** planner ids are pure (`harvest-{flowSourceId}`);
     runtime corps use legacy Game-derived ids. Each kind's `materialize`
     bridges them and strips flow prefixes (`harvestKind` strips `"source-"`,
     `carryKind`/`upgradeKind` strip `"spawn-"`). A rename here silently orphans
     live creeps whose `memory.corpId` no longer resolves — handle with care.

7. **Corps → spawn.** Each corp's `getSpawnDemand()` feeds
   `execution/SpawnDirector.ts:101` `collectDemands` (grouping a source's miner +
   haulers into one income unit), then the **pure** `spawn/SpawnScheduler.ts:200`
   `scheduleSpawn` picks ≤1 creep/spawn by tiered `spawnPriority` (`:158`):
   income `1e6` ≫ blocking `1e4` ≫ started `1e3`, so **breadth before depth**
   (every source gets a miner + first hauler before any source scales). Body via
   `spawn/BodyBuilder.ts`; `SpawningCorp.executeSpawn` calls `spawn.spawnCreep`.

## Tick cadences (`src/main.ts:149`, `loop`)

Three independent clocks — don't conflate them:

- **Execution: every tick.** `runSpawningCorps` → `runBootstrapCorps` →
  `runCommissionHost(getCommissions())` → `runLinks` → `runSpawnScheduling`
  (`main.ts:184-352`). The corps are materialized and run *every* tick from the
  last solved commission set.
- **Economy re-solve:** `FLOW_RESOLVE_INTERVAL = 50` ticks (or a 5000-tick
  cadence, or "bootstrap needed": nodes exist but zero harvest corps)
  (`main.ts:268-282`). A solve rebuilds the graph from Memory and calls
  `flowEconomy.update(context, true)`.
- **Spatial/terrain analysis:** ≤ every 5000 ticks (`MULTI_ROOM_ANALYSIS_CACHE_TTL`),
  spread incrementally across ticks (`main.ts:210-256`), separate from the
  economy solve. Node-resource refresh is its own 50-tick clock.

## Where roads come from (two signals)

Road placement is fed by two independent inputs that answer different questions:

- **A priori — `economy/roadEconomics.ts`.** A closed-form cost/benefit for a
  KNOWN route with an ASSUMED flow. `ConstructionCorp.tryPlaceRoadRoute`
  (`ConstructionCorp.ts:731`) uses it to decide whether to pave each
  source→depot haul route and caches the verdict in `RoomMemory.roadRoutes`.
- **Empirical — `economy/roadScoring.ts` + `execution/roadTracker.ts`.**
  `trackRoadUsage` (every tick, `main.ts` EXECUTE phase) watches where our
  creeps actually STEP on unpaved plain/swamp while paying move-fatigue, and
  credits each tile the fatigue a road there would have saved
  (`stepScore = fatigueParts × (terrainFatigue − 1)`; swamp 9×, plain 1×, empty
  haulers 0). Scores accumulate in `RoomMemory.roadScores`, decay on a 3000-tick
  cadence, and are read back — ranked — via `roadCandidateTiles` (console:
  `global.roadHeatmap()`). This is a DURABLE statistical accumulator (thousands
  of steps), not a position-keyed trigger, so it does not fall into the
  flap-on-a-creep-death trap. Wiring these candidates into `ConstructionCorp`
  placement (empirical flow instead of assumed `SOURCE_RATE`) is the next step.

## Current vocabulary (use these names)

| Concept | What it is | Home |
|---|---|---|
| **CorpPlanner** | pure GOAP planner; the brain | `economy/CorpPlanner.ts` |
| **ColonyProblem** | pure input (spawns/sources/sinks/dist) | `CorpPlanner.ts:90` |
| **ColonyPlan** | planner output (miners/haulers/sinks) | `CorpPlanner.ts:141` |
| **Commission** | one corp's envelope (shape + consumes/produces + opaque assignment) | `economy/Commission.ts:51` |
| **CorpKind** | plug-in contract: propose/materialize/run/serialize/body + runOrder | `economy/CorpKind.ts` |
| **Corp** | runtime owner of creeps; economic ledger + `variance()` | `corps/Corp.ts:53` |
| **HarvestCorp / CarryCorp** | the income corps (was Mining/Hauling) | `corps/` |
| **primitives** | the single canonical home for all economic math | `economy/primitives.ts` |

## Deleted / vestigial — do not build on these

- **Deleted:** `FlowSolver`, the market/offer/contract layer, `EconomyPlanner`,
  `FlowMaterializer`.
- **Vestigial:** `FlowGraph.PriorityManager` dynamic priorities (planner uses its
  own `DEFAULT_SINK_VALUE`); `framework/EdgeVariant.ts` (now vocabulary-only —
  its variant search was dead). The `FlowSolution` shape persists only as the
  legacy telemetry/output format.
- **Not yet ported to the CorpKind framework:** `BootstrapCorp` (cold-start
  "jacks" + anti-downgrade rescue) and `SpawningCorp` (still owns
  `executeSpawn`; the rung-5 `kind.body()` spawn seam is wired but unused).

See [`ONTOLOGY.md`](./ONTOLOGY.md) for the canonical domain definitions and
[`specs/00-corp-framework.md`](./specs/00-corp-framework.md) for the CorpKind
contract and its acceptance tests.
