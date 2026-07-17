# 00 — The Corp Framework (the keystone)

**Status:** partially real, not yet enforced. This spec is the deliverable the
others serve.
**Priority:** P0 — every other spec gets cheaper once this lands; specs 02,
03, 06, 07 should be implemented AS corp kinds through this framework.

## The thesis

A corp is an interchangeable unit of economic activity defined entirely by its
**inputs and outputs**:

- **consumes:** energy-at-a-place (rate), spawn build-time (parts/tick)
- **produces:** energy-at-a-place (rate), or colony value (value/tick)
- **preconditions:** what must already be true (e.g. transport S→K requires S
  staffed; a tender requires a depot)

The planner reasons over an **abstracted world** (positions, rates, distances,
values — pure data, no Game objects) and emits **commissions**: which corps to
run, at what size, wired to which inputs/outputs. Materialization binds each
commission to a runtime corp and hands it the concrete object IDs it needs.
Execution is then deliberately dumb: follow your assignment. New corp kinds
slot in by declaring their shape — no edits to the planner's core, the
runner, the materializer, or main.ts.

## Where reality falls short today (the gap this spec closes)

| Leak | Evidence |
|------|----------|
| The planner knows exactly three shapes (miner/hauler/sink) baked into its output types | `economy/CorpPlanner.ts` (`CommissionedMiner/Hauler/Sink`) |
| Every corp type is enumerated by name in core plumbing | `CorpRegistry` typed maps; `runRealCorps`/`runScoutCorps`/`runConstructionCorps`/... in `execution/CorpRunner.ts` each called separately from `main.ts`; `FlowMaterializer` calls per-type setters (`setMinerAssignment`, `setHaulerAssignments`, `setSinkAllocation`); `Persistence`, `Telemetry.update` (positional per-type args), `Colony.updateStats` all enumerate types |
| "Auxiliary" corps (scout, reserver, bootstrap, tender) bypass the planner entirely via self-triggering side-channels | each implements its own activation gate in `getSpawnDemand` |
| Adding one capability fans out across the codebase | the link groundwork touched 7 files (BodyBuilder, HarvestCorp, nodeEnergy, ConstructionCorp, CorpPlanner, flowAdapter, main.ts) |
| Body building switches on role strings | `SpawningCorp.buildBodyForRole` |

What already conforms (build on it, don't rebuild it): the abstract world
(`ColonyProblem`), canonical economics (`economy/primitives`), the uniform
`Corp` base (plan/work/serialize/variance), uniform `getSpawnDemand` →
scheduler, and the materialize-then-execute flow.

## Target design

### 1. Commission — ONE envelope, four shapes

```ts
// economy/Commission.ts
export type CommissionShape = "produce" | "transport" | "consume" | "auxiliary";

export interface Commission {
  corpId: string;        // deterministic: `${kind}-${targetId}`
  kind: string;          // registered corp kind, e.g. "harvest", "carry", "tower"
  shape: CommissionShape;
  // the abstract economics the planner reasoned with (for variance/telemetry):
  consumes: { energyRate?: number; at?: Position; spawnPartsPerTick: number };
  produces: { energyRate?: number; at?: Position; valuePerTick?: number };
  // kind-specific binding payload, OPAQUE to planner & plumbing:
  assignment: unknown;   // e.g. MinerAssignment | HaulerAssignment[] | SinkAllocation
}
```

`ColonyPlan` becomes `{ commissions: Commission[]; ...metrics }`. The planner's
internal phases (producer selection, value routing) keep emitting what they
emit today — they just wrap results in the envelope. AUXILIARY commissions are
how scout/reserver/bootstrap/tender enter the SAME pipeline: their kinds
propose themselves when preconditions hold (see `propose` below), instead of
each inventing a private activation gate.

### 2. CorpKind — the pluggable unit

```ts
// economy/CorpKind.ts
export interface CorpKind<C extends Corp = Corp> {
  kind: string;
  /** PLAN (pure): propose commissions this kind can fulfil in this world.
   *  Producer/transport/consumer kinds usually return [] here because the
   *  central solver emits them; auxiliary kinds implement their trigger here
   *  (e.g. reserver: "the draft plan MINES an unowned, controllered room" -
   *  the DURABLE signal; never live creep positions or room vision). */
  propose(problem: ColonyProblem, plan: ReadonlyDraftPlan): Commission[];
  /** MATERIALIZE: create-or-update the runtime corp for a commission. */
  materialize(c: Commission, existing: C | undefined): C;
  /** EXECUTE: run one tick. Keep it dumb - the assignment has everything. */
  run(corp: C, tick: number): void;
  /** PERSIST: round-trip. */
  serialize(corp: C): SerializedCorp;
  deserialize(data: SerializedCorp): C;
  /** Body for this kind's roles (replaces SpawningCorp's string switch). */
  body(role: string, bodyParam: number | undefined, budget: number): BodyPartConstant[];
}

export function registerCorpKind(k: CorpKind): void;
```

### 3. Generic plumbing (replaces enumeration)

- `CorpRegistry` becomes `Map<corpId, Corp>` + `Map<kind, CorpKind>`.
- `main.ts` EXECUTE phase: `runAllCorps(registry)` — one call. Ordering, where
  it matters (spawning first), comes from a `runOrder` number on the kind, not
  from main.ts knowing names.
- `FlowMaterializer` → `materializePlan(plan, registry)`: dispatch each
  commission to its kind. Stale-corp cleanup compares commission sets, same as
  today's `cleanupStaleCorps`.
- `Persistence`/`Telemetry`/`Colony.updateStats` iterate the generic map.

### 4. Migration — strangler, one kind per commit

1. Land Commission + CorpKind + registry alongside the existing code (no
   behavior change; golden-master test pins equivalence).
2. Port kinds one at a time, easiest first:
   ScoutCorp → ReservationCorp → ExtensionTenderCorp (auxiliaries prove
   `propose`), then UpgradingCorp (consume), CarryCorp (transport),
   HarvestCorp (produce), ConstructionCorp, BootstrapCorp, SpawningCorp last
   (it is infrastructure, not really a commission — it may stay special, but
   its body-switch dissolves into `CorpKind.body`).
3. Delete the typed maps, the per-type run functions, and the materializer's
   per-type setters when the last kind ports. Grep gates below enforce this.

Each port commit passes the FULL gate: unit suite + `flow-handoff` +
`runt-economy` + `storage-depot`.

## Method: the proof ladder

Prod's stagnation is not one smoking gun - it is accumulated code and design
debt. So the framework is revamped **piece by piece, each piece proven in
isolation, then in progressively more complex isolations**. No piece touches
the live loop until it has climbed every rung below it:

| Rung | Isolation | Proof |
|------|-----------|-------|
| 0 | Pure data & functions (Commission envelope, registry, dispatch) | type-checked + direct unit tests, no Game, no corps |
| 1 | One kind alone | the conformance suite (`describeCorpKindConformance`) |
| 2 | Kind + planner | its commissions appear in `planCommissions` over a pure world |
| 3 | Kind + dispatch | materialize/run/persist/demobilize lifecycle on a plain CorpStore |
| 4 | Kinds composed, still pure | the golden master over the standard worlds |
| 5 | Real engine | the integration suite (flow-handoff / runt-economy / storage-depot + kind-specific tests) |

Every port commit states which rung it reaches. The strangler property -
`materializeCommissions` skips unregistered kinds, leaving legacy plumbing in
charge of them - is what makes rung-by-rung landing safe: a kind only takes
over the round its registration lands, and the golden master pins that nothing
else moved.

Status: rungs 0-4 scaffolded and green (Commission, CorpKind registry +
dispatch, commissionPlan, conformance suite, extensibility proof via the toy
"beacon" kind, golden master over 3 worlds / 12 commissions). The integration
gate itself was the first "poor code" fix: root-level mocha hooks
cross-corrupted suites, making the gate invocation-dependent - now scoped and
green across all 14 tests.

**RUNG-5 CUTOVER COMPLETE.** All six corp kinds run through CommissionHost off
the live loop: the auxiliaries (scout, reservation, tender - self-proposing)
and the solver-backed economy (harvest, carry, upgrade - commissioned from
FlowEconomy.getCommissions()). The cutover landed in staged, individually-
verified commits: (A) host union-sources solver + auxiliary commissions; (B)
the solver-backed kinds replicate the runRealCorps plan() cadence; (C1) the
behavioral flip - register the kinds, stop the legacy create/run paths
(FlowMaterializer/runRealCorps/Phases survey), and migrate every reader
(SpawnDirector's spawn-demand critical path, telemetry, variance, stats) to
commissionedCorpsOfKind(); (C2) delete the dead registry fields, Persistence
writes, and FlowMaterializer functions. Two flip regressions were caught by
flow-handoff and fixed: harvest must strip the flow "source-" prefix so
HarvestCorp.work() resolves the real source, and the miner/hauler grouping must
key off the real game source id so withMinerPrecedence couples them. Gate: 486
unit tests + 14/14 integration (incl. the formerly-flaky asymmetricTwoSource /
twoSourceRcl3).

**CONSTRUCTION PORTED; FLOWMATERIALIZER RETIRED.** ConstructionCorp is a HYBRID
kind (corps/kinds/constructionKind.ts): it proposes one commission per owned
room - so the corp always exists for container maintenance, as the legacy
per-room runConstructionCorps did - but reads the solver's "build" commissions
from the propose() DRAFT to carry that room's construction-energy allocations
(which size its builders). With it ported, FlowMaterializer had nothing left to
create and was DELETED outright (the file, its test, the flow/index export, and
the three main.ts materializeCorps calls). CorpRegistry now holds only bootstrap
+ spawning; everything else lives in the commission store. THE FRAMEWORK
MIGRATION IS COMPLETE - all corp kinds run through CommissionHost, and the
abstract-world planner -> commission -> materialize -> run pipeline is the one
and only path. Gate: 493 unit tests + 14/14 integration green (incl.
storage-depot, which exercises construction).

Remaining polish (not migration): SpawningCorp and BootstrapCorp still live in
the registry - SpawningCorp is infrastructure (it processes the spawn queue, not
really a commission) and BootstrapCorp is the cold-start fallback; both may stay
special, though SpawningCorp's body-switch could still dissolve into
CorpKind.body. The build-commission emission in commissionsFromPlan is now only
consumed by construction's propose(); it could be simplified later.

History: SCOUT was ported end to end: rungs 1-4 in
test/unit/framework/scoutKind.test.ts, rung 5 via execution/CommissionHost
(the thin runtime host - registers kinds, proposes over the live world,
materializes/runs/persists the store under Memory.commissionedCorps), with
runScoutCorps and all per-type scout plumbing deleted. RESERVATION and
EXTENSION-TENDER are ported the same way (rungs 1-5; SpawnDirector reads their
demands through the store adapter, so the value-ranked spawn path is
preserved). All THREE auxiliaries are now framework-driven, their legacy
run*Corps / registry maps / Persistence blocks / per-room factories deleted,
and the host's per-kind registration collapsed to a KINDS array.

ALL THREE SOLVER-BACKED KINDS are now ported at rungs 1-4 (NOT yet live -
imported by nothing in src/, golden master is the pinned baseline):
- HARVEST (corps/kinds/harvestKind.ts, produce): propose() returns [] (the
  planner emits the commission); materialize reconstructs the flowAdapter
  MinerAssignment and the legacy `mining-${room}-harvest-${suffix}` id.
- CARRY (corps/kinds/carryKind.ts, transport): one commission per source
  aggregating its routes; reconstructs HaulerAssignment[] and the
  `hauling-${room}-hauling-${suffix}` id.
- UPGRADE (corps/kinds/upgradeKind.ts, consume): reconstructs SinkAllocation
  and the `upgrading-${room}` id. Consumers are spawn-agnostic in the plan, so
  consume commissions were enriched (its own golden-master commit) to carry the
  serving spawn (ConsumeAssignment = { sink, spawnId }), chosen purely from
  problem.spawns by the sink's room - matching how FlowMaterializer picks it.

BRIDGE DONE (the rung-5 enabler): the live pipeline produced a FlowSolution,
not commissions, so the host had nothing to drive the economy kinds from.
flowAdapter.solveColony() now yields BOTH from one solve, FlowEconomy exposes
getCommissions(), and solverBridge.test.ts pins the equivalence - every
harvest/carry/upgrade commission reconstructs the EXACT assignment the live
FlowMaterializer sets (this caught + fixed a real bug: upgradeKind wasn't
stripping the "spawn-" prefix). Nothing consumes getCommissions() yet, so it is
non-behavioral. The blast-radius survey (registry.harvestCorps/haulingCorps/
upgradingCorps) is ~10 files / ~30 sites, including the SpawnDirector
spawn-demand critical path.

REMAINING: the single combined flip. Concrete plan, now that the bridge and
blast radius are mapped:
1. Register harvest/carry/upgrade in CommissionHost's KINDS. The host takes the
   solver commissions (main.ts passes flowEconomy.getCommissions(), stable
   between solves) and materializes the UNION with the per-tick auxiliary
   propose() set, so neither demobilizes the other.
2. The three kinds' run() must replicate runRealCorps' plan cadence
   (if shouldPlan(tick) plan(tick); then work(tick)) - the auxiliaries never
   needed plan(), these do.
3. Migrate every READER from registry maps to commissionedCorpsOfKind():
   SpawnDirector (CRITICAL - the spawn-demand loops + sourceHasMiner), Telemetry
   args (main.ts), Colony.updateStats, CorpRunner snapshotCorpVariance /
   logCorpStats, main.ts status/resetCorp, Phases counting/isStarted.
4. Delete harvest/carry/upgrade from FlowMaterializer's per-node loop, from
   runRealCorps, the registry maps, Persistence, and Phases hydration.
5. OPEN QUESTION to resolve first: Phases SURVEY provisionally creates
   HarvestCorp/UpgradingCorp ("create if absent", keyed like the flow corps) so
   they exist before the first solve; CarryCorp already comes only from
   FlowMaterializer. With the flip, economy corps appear only after the first
   solve (which runs at init anyway). Likely safe to drop the survey provisioning
   and rely on the initial solve - but this is behavior-sensitive and must be
   confirmed by the integration suite (bootstrap timing), not assumed.
This is a high-risk change to the live core economy; it gets its own focused
effort gated on the FULL integration run (expect 2-3 iterations). Known
pre-existing flake to fix en route: scenario-economy cases alternate failures
with a zombie-miner signature (a mining corp at 0/10 actual at sample time -
also seen in the A/B baseline on master); it is the first concrete spec-01
target, and lives in exactly the harvest/carry code the cutover touches.

## Acceptance tests (the framework is DONE when all pass)

### A. Conformance suite — `test/unit/framework/corpKind.conformance.ts`

A shared `describeCorpKindConformance(kind, fixtures)` helper run against
EVERY registered kind (one `describe` per kind, auto-enumerated from the
registry — a newly registered kind is conformance-tested with zero new test
code). Per kind, exact requirements:

1. **Round-trip:** `serialize(deserialize(serialize(c)))` deep-equals
   `serialize(c)` for the fixture corp.
2. **Determinism:** `propose(world, draft)` called twice with the same inputs
   returns deep-equal arrays; corpIds match `/^[a-z]+-[\w-]+$/` and are unique
   within the result.
3. **Demand validity:** every `getSpawnDemand` result has
   `buyerCorpId === corp.id`, `0 < minCost <= desiredCost`, and
   `kind.body(role, bodyParam, desiredCost)` returns a non-empty body whose
   cost is `<= desiredCost`.
4. **Empty-world safety:** `run(corp, t)` on a world with no game objects does
   not throw (extends the existing ErrorMapper-contract test).
5. **Economics envelope:** the fixture commission's
   `consumes.spawnPartsPerTick` is within 1e-9 of the value derivable from
   `economy/primitives` for its declared rate/distance — no kind ships its own
   formula (ONTOLOGY § 2 enforced mechanically).

### B. Golden master — `test/unit/framework/planEquivalence.test.ts`

For the three standard fixture worlds (singleSource, twoSourceRcl3,
threeChamberRcl2 — the fast fixture harness): the commission set produced via
the new envelope, normalized (sorted by corpId, assignment JSON), deep-equals
a checked-in snapshot generated from TODAY's miner/hauler/sink output. Pin
BEFORE the migration starts; any intentional change to the snapshot must be a
separate commit explaining the economic delta. This is what makes the strangler
safe.

### C. Extensibility proof — `test/unit/framework/newCorp.test.ts`

The test file itself defines and registers a toy `beacon` kind (an auxiliary
consumer that proposes one commission whenever the world has ≥ 1 spawn),
**importing only the framework's public API** (`Corp`, `registerCorpKind`,
`Commission` types — nothing from `execution/` or `flow/`). Assert the full
lifecycle without ANY core edit:

1. Planning: the beacon commission appears in `planColony(world).commissions`.
2. Materialization: `materializePlan` creates a corp instance; calling it
   again UPDATES (same instance id), not duplicates.
3. Execution: `runAllCorps` invokes the kind's `run` exactly once per tick for
   it (spy).
4. Demand: its spawn demand flows through `collectDemands` untouched.
5. Persistence: after `persistState`-shape serialize + a fresh registry
   restore, the corp exists with its assignment intact.

This test failing = the framework has a hardwired seam; it is the single most
important test in the suite.

### D. Structural gates (greps, exact)

After the last port commit:

1. `grep -c "harvestCorps\|haulingCorps\|upgradingCorps\|scoutCorps\|constructionCorps\|bootstrapCorps\|reservationCorps\|extensionTenderCorps" src/ -r` → **0**
   (the typed maps are gone).
2. `grep -cE "runRealCorps|runScoutCorps|runConstructionCorps|runExtensionTenderCorps|runReservationCorps|runBootstrapCorps|runSpawningCorps" src/main.ts` → **0**
   (main.ts runs corps through one generic call).
3. `grep -c "setMinerAssignment\|setHaulerAssignments\|setSinkAllocation" src/flow/FlowMaterializer.ts` → **0**
   (dispatch via kinds; the file may well be deleted).
4. `grep -c "case \"" src/corps/SpawningCorp.ts` for the role switch → **0**
   (bodies come from `CorpKind.body`).

### E. Regression gate

Unchanged throughout: full unit suite + `flow-handoff` + `runt-economy` +
`storage-depot` green on every migration commit. The integration tests are the
proof that "the plan actually comes to fruition" — the abstract world's
commissions turn into real creeps mining real sources.

## Relationship to the other specs

- **02 LinkHaulerCorp:** the framework's first real transport kind — link
  operation is a corp (consumes energy at the source link, produces energy at
  the sink, runs the link intents + one stub creep), NOT a free function. Its
  planner-side piece (haulPos) is a world-abstraction feature and stays.
- **03 storage draw-down:** the bank source is a world-abstraction feature;
  its hauling rides whatever transport kind the commission selects.
- **06 expansion (ClaimCorp) / 07 towers (TowerCorp):** implement these AS new
  kinds through the framework — each is then also a live test of test C.
- **04 chain-layer retirement:** removes the last competing notion of what a
  corp's economics are; do it before or during the migration, not after.
