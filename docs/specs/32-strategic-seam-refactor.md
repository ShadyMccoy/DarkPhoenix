# 32 — The strategic-seam refactor: one contract, one home, one lens

**Status:** PHASES A–D LANDED 2026-07-27 (each its own gated commit: A
dead-code sweep −3,295 lines; B constants inversion + formula folds,
primitives imports from nobody; C economy/ids.ts + corps/censusLens.ts;
D propose helpers + startedUnitDemandGroup + optional run/runCorpTick +
INFRA_ROLES deleted + spawn/demandLadder.ts + SpawnAnchoredCorp +
corps/regimes.ts + OrphanRescue census fold). Gates: build + unit suite +
integration trio green per phase; grid run at phase exit. OPEN: D-scout
(scout through the scheduler), E structural-regime upgrade, F legacy-pair
port, G translation-layer collapse, H giant-file splits. Mapped by a
9-reader audit (106 findings across every subsystem).
**Priority:** P0 — this is the "corps plug in seamlessly" spec: it finishes
what specs 17/20 started so that implementing, introducing, or updating a
corp kind never requires knowledge that lives outside the kind's own file.

## The thesis (owner, 2026-07-27)

> Simpler code will have less bugs even if it temporarily breaks some tests.
> The key is the overall strategic structure so corps can be implemented,
> introduced, updated as necessary and they seamlessly fit into the
> strategic system.

The strategic structure already exists and is enforced: the CorpKind
registration-only contract (spec 17), the pure planner core, the prescriptive
NOW plan. This spec does not redesign it — it **finishes** it. The audit
found the seam leaking in four ways, and each phase below closes one class
of leak:

1. **Dead weight.** ~2,500+ lines from the deleted FlowSolver/market/chain
   eras still stand (the NodeNavigator graph class, FlowGraph's edge matrix
   and query API, SpawningCorp's order queue, NodeSurveyor's ROI estimators,
   the market-era Colony shell, dead accessors on every heavy corp). Dead
   code is not neutral: PIPELINE.md already claims some of it was deleted,
   so the docs lie, and every reader pays the tax.
2. **Economics has four homes.** `primitives.ts` — the canonical home —
   imports its own founding constants FROM `flow/FlowTypes`,
   `corps/economics`, and `planning/EconomicConstants` (the purity ratchet
   whitelists this as audited debt). Body-part costs exist in four tables.
   `CLAIM_LIFETIME` is defined twice. Three modules re-implement
   `carryPartsFor`/`roundTripTicks` inline.
3. **The id-space rule has no home.** ONTOLOGY §5 says "lookups that cross
   id spaces must normalize explicitly" — but there is no shared lens:
   `.replace("source-", "")` appears at 8 sites in kind files alone, the
   intel/scavenge position-regex is copy-pasted 4×, the bank role is
   inferred by `id.startsWith("bank-")` at 5 sites, and corps sniff each
   other's corp-id prefixes (`"mining-"` at 3 sites) — the exact
   "read another kind's naming conventions" violation the ontology forbids.
4. **Per-kind knowledge still leaks out of kind files.** Seven kinds
   copy-paste the same `propose()` home-spawn loop; three kinds hand-write
   the identical `demandGroup`; every kind hand-writes the same spawnId
   refresh; the spawn-value ladder lives as literals in six corp files with
   cross-referencing comments; the NOW planner enumerates kind role names
   (`INFRA_ROLES`); scout spawning tunnels through a host-wired resolver;
   and the regime flags couple mover kinds to CarryCorp/UpgradingCorp
   branches (the documented spec-17 backlog).

**Method rule (how "may break tests" is applied):** every phase is
behavior-preserving unless explicitly labeled otherwise. A test deleted with
the dead code it pins is not a broken test. A pin updated in the same commit
as a deliberate mechanism change (with the rationale in the commit) is the
documented procedure. The grid baseline moves only in a commit that earns it.

## Phases

### A — dead-code sweep (pure deletion, zero behavior change)

- `corps/SpawningCorp.ts`: the entire pendingOrders/SpawnOrder queue surface
  (zero production callers), plus `main.ts global.clearSpawnQueue`, the
  Telemetry pending-order read, ScoutCorp's `countPendingOrdersFrom` term.
- `nodes/NodeNavigator.ts`: the graph class (~700 lines, zero callers) —
  keep the module-level `pathDistance`/`estimateWalkingDistance`/
  `clearPathDistanceCache` (THE live distance function). Drop the
  `Memory.economicEdges` BFS in `execution/Persistence.ts` (persist's
  measured dominant cost, feeding only the dead navigator) and
  `buildFlowEconomyFromMemory`'s navigator plumbing.
- `flow/FlowGraph.ts`: `buildEdges`, the FlowEdge map, every edge
  query/stat accessor (zero callers) — keep discovery + getSources/getSinks.
- `nodes/NodeSurveyor.ts`: the ROI estimators PIPELINE.md already claims
  were deleted; `Node.roi.potentialCorps` display plumbing.
- `corps/`: the 17 uncalled FLOW-INTEGRATION accessors across the four heavy
  corps; `BootstrapCorp.estimateROI/shouldActivate`; `Squad.moveAsWorm`;
  CorpType `"source"`; the nine dead CorpConstants exports; dead
  `corps/economics.ts` trio (reserverTollPerRoom family).
- `spawn/BodyBuilder.ts`: `buildHaulerBody`, `calculateCreepsNeeded`.
- `spatial/`: the skeleton-builder state machine, `bfsWalkingDistance`,
  dead RoomMap exports. `analysis/SourceAnalysis.ts` → `countMiningSpots`
  only; delete `types/SourceMine.ts`, dead Position helpers.
- `telemetry/Telemetry.ts`: `extractNodeId` + the always-empty
  flowRateByEdge merge; deprecated NodeTelemetry fields; market-era header.
- `types/Memory.ts`: `lastRclUpTick`, `memoryCleared`, `contractId`,
  `isMaintenanceHauler` and friends; `main.ts` phantom global declarations.
- Stale headers that describe the deleted world (scoutKind "NOT yet
  registered", harvest/carry/upgrade rung-5 cutover prose, CommissionHost's
  six-of-eleven roster comment).

### B — one home for economics (values must not move; homes do)

- **Invert the constants dependency** (the documented spec-17 P5 fold):
  `BODY_COSTS` (full 8-part table), `CREEP_LIFETIME`, `MINER_COST`,
  `MINER_PARTS`, `SPAWN_TIME_PER_PART`, `SPAWN_PARTS_PER_TICK`,
  `RESERVER_DUTY`, `CLAIM_LIFETIME`, `CARRY_CAPACITY`, `HARVEST_RATE`,
  `SOURCE_*` move INTO `economy/primitives.ts`; `flow/FlowTypes`,
  `corps/economics`, `planning/EconomicConstants` become re-exports, then
  callers migrate and `planning/EconomicConstants.ts` is deleted with its
  dead half. The purity whitelist entries for the inverted imports go with
  them.
- **Fold the formula clones**: `roadEconomics.carryUnits` →
  `carryPartsFor`; flowAdapter's local `ENERGY_PER_WORK` → the primitives
  constants; the inline `2*d+2`/`PART_PAIR_COST`/`floor(cap/100)` clones in
  CarryCorp/HarvestCorp/ConstructionCorp → primitives calls;
  `SpawningCorp.calculateBodyCost` + BodyBuilder's `PART_COSTS` → the one
  table; `controllerFeederKind.body` → `buildRatioHaulerBody` (bit-identical,
  proven by bodyEquivalence); `SpawnDirector.estimateIncome`'s bare `* 10` →
  a named primitives constant.
- **One ladder home**: `CorpPlanner.DEFAULT_SINK_VALUE` derived from
  `goals.DEFAULT_VALUATION` (goals.ts is already "the ONE sink-valuation
  home"; today they must agree by hand).

### C — the id-space module (`economy/ids.ts`)

One tiny module, exported lenses, zero new behavior:
`stripSourcePrefix`/`stripSpawnPrefix` (anchored), `corpIdFor`'s inverse,
`parsePositionalId` (the intel-/scavenge- position codec, replacing 4
regex copies), `isScavengeId`, `isBankSourceId` (+ `bankRoomFromId`),
`isMinedIncomeId` re-homed and used at its own bypass site
(flowAdapter line ~592). Kinds, corps, adapter, and planner all import the
lens; the trap-list rule ("a rename silently orphans live creeps") becomes
mechanical instead of tribal. Corp-id **prefix sniffing** across kinds
(`"mining-"`, `"hauling-"`, `includes("tender")`) is replaced by a
census/workType lens (`roomFieldsWorkType`) — the kind name is the stable
vocabulary, the id format is not.

### D — kind-contract completion (the strategic centerpiece)

- **Shared propose helpers** (PLAN-layer, beside Commission.ts):
  `homeSpawnsByRoom(problem)`, `nearestSpawnTo(problem, room)`,
  `perRoomAuxiliaryCommission(...)` — seven copy-pasted loops become one
  expression each; a new per-room auxiliary kind's propose() is ~5 lines.
- **Declarative funding**: `startedUnit()` helper (or `funding:
  "startedUnit"` declaration) replaces the three byte-identical
  `demandGroup` implementations; rationale comments stay at the
  declaration site.
- **Kill INFRA_ROLES**: the NOW planner labels agenda entries from the
  demand's declared class (`SpawnDemand.why`/`infrastructure`), never from
  a role-name enumeration in the PLAN layer.
- **One ladder module** (`spawn/demandLadder.ts`): named rungs
  (FEEDER_LINCHPIN 150, TENDER_BOOTSTRAP 150, RESERVER 115, GUARD 105,
  BUSTER 104, TENDER 96, FEEDER 95, CLAIM 80 …) with ONE ordering test;
  corps import their rung. Numbers move verbatim — each carries its
  incident rationale as a comment on the rung.
- **Default run()**: the dispatch supplies the standard
  `shouldPlan→plan→work` cadence; kinds declare run() only when custom.
- **Scout through the scheduler** *(behavior-adjacent, own commit)*: give
  ScoutCorp a real `getSpawnDemand` (its RCL/count/cooldown/stale-room
  gates become demand gates), delete `setSpawningCorpResolver` — the last
  kind-specific wiring inside CommissionHost — and scout buys join the
  agenda/receipts like everyone else.
- **OrphanRescue.liveCorpIds = completeCensus** (the census is already the
  sanctioned fold point; rescue re-implements it by hand).

### E — regimes and lenses get one owner (behavior-preserving moves first)

- `corps/regimes.ts`: `tenderOwnsExtensions` moves out of CarryCorp (a
  reader) to a neutral module; writers stamp through documented setters
  beside the lens. `roomHasMiner` (verbatim-duplicated in tender + feeder,
  id-prefix-sniffed in harvest) becomes one census lens. The feeder's
  private `controllerStock` folds onto `nodeEnergy.controllerSideStock`.
- The **structural-regime upgrade** (feeder-COVERED from structures instead
  of the liveness-keyed `controllerFeederActive` — the flapping-signal trap
  class ONTOLOGY itself flags) is designed here but lands as its OWN
  gated change with the integration trio + grid, because it changes live
  semantics. Same for expressing `dedicatedBuildSourceId` in the plan
  (the spec-25 continuation).

### F — port the legacy pair (spec 20 phases 2–3, designed here)

`SpawningCorp` and `BootstrapCorp` join KINDS; the ~9 hand-wired sites
(CorpRunner registry, Persistence, OrphanRescue fold, completeCensus,
SpawnDirector ×2, main.ts, Phases, Colony.updateStats) collapse into the
generic dispatch. Constraints the port must honor: corp ids and
`Memory.bootstrapCorps`/`spawningCorps` schemas are legacy-stable (a
migration reads them once); BootstrapCorp's raw `spawnCreep` fallback must
provably work when the demand pipeline itself is starved — its buys route
through the emergency lanes (`infrastructure`/`blocking`) so cold-start
spawns finally leave receipts; the eager-bootstrap solve gate in main.ts
re-keys from the census. This is the largest phase and lands LAST, after
the seam is otherwise clean.

### G — collapse the translation layer

After A's deletions, `flow/` is ~120 live lines of discovery plus a thin
solve driver: fold FlowGraph discovery + FlowEconomy's cadence/persistence
driver into `economy/flowAdapter.ts` (the sanctioned adapter), keep ONE DTO
module for the FlowSolution/assignment shapes (live corps' assignment
vocabulary + telemetry DTO). FlowEconomy's raw Memory traffic
(`Memory.goal`/`lastBankDraw`/`warchestTarget`) moves inside the adapter;
the purity ratchet's scan extends beyond `src/economy/`. `main.ts` sheds
`addConstructionSitesToFlow` (sink-admission policy → the adapter seam)
and the ~400-line console block (→ `execution/console.ts`);
`global.plan()` and the loop's planning phase become one
`runPlanningPhase(force)` — which also fixes the real bug where a
console-forced plan solves with zero construction sinks.

### H — split the giants (mechanical, lowest urgency)

ConstructionCorp (2,972) → ledger/pool lens module (the PLAN-consumed
surface main.ts currently imports from a corp file — a seam violation),
placement-ladder module (pure rung table), corp runtime. CarryCorp's
exported pure-policy head (~360 lines) → haulPolicy module. Telemetry →
per-segment writers + the spawn meter as its own accumulator.

## Explicitly deferred (named so they aren't re-litigated)

- The phantom `"build"` commission kind and the three-vocabulary problem
  (`build` vs `construction` vs `mine/haul` in Memory.economyPlan): the fix
  is a declarative SinkKind→consumer table, but corpIds embed the kind name
  and the golden master pins envelopes byte-for-byte — do it as its own
  deliberate golden-master regeneration, not inside this sweep.
- PlannerSource `role: "bank"` field (replacing the 5 `startsWith("bank-")`
  sites): same golden-master blast radius; the `isBankSourceId` lens from
  phase C contains the leak until then.
- The Commission envelope `staffedBy` promotion (kills constructionKind's
  cast of harvest assignments AND the 11 hand-written spawnId refreshes):
  envelope shape change, golden-master churn — bundle with the "build"
  fix in one deliberate envelope-v2 commit.
- Creep-position/vision traps, sink-value ladder VALUES, spawn doctrine,
  hub-and-spoke routing: measured, pinned, correct — not touched.

## Acceptance

1. Every phase: `npm run build` + `npm run test-unit` green (with pins
   updated/deleted only per the method rule), and for phases touching live
   behavior (D-scout, E-structural, F, G) the integration trio
   (`flow-handoff`, `runt-economy`, `storage-depot`) plus `npm run grid`
   with the baseline updated in the same commit if it moves.
2. The registration-only proof and the conformance suite stay green
   THROUGHOUT — they are the seam's definition, not its victims.
3. End state, mechanically checkable: `primitives.ts` imports constants
   from nobody; `grep -rn 'startsWith("bank-")\|replace("source-"\|replace("spawn-"' src/`
   returns only `economy/ids.ts`; no kind file's name appears in
   CommissionHost beyond its KINDS entry + import; `INFRA_ROLES` gone;
   `setSpawningCorpResolver` gone; the purity whitelist carries zero
   "(debt)" entries.
