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
   *  (e.g. reserver: "a miner works an unowned controllered room"). */
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
green across all 14 tests. SCOUT is ported end to end: rungs 1-4 in
test/unit/framework/scoutKind.test.ts, rung 5 via execution/CommissionHost
(the thin runtime host - registers kinds, proposes over the live world,
materializes/runs/persists the store under Memory.commissionedCorps), with
runScoutCorps and all per-type scout plumbing deleted. RESERVATION is ported the same way
(rungs 1-5; SpawnDirector reads its demands through the store adapter, so
the value-ranked spawn path is preserved). Next: the solver-backed kinds
(harvest -> carry -> upgrade), each one commit, each up the ladder. Known
pre-existing flake to fix en route: scenario-economy cases alternate failures
with a zombie-miner signature (a mining corp at 0/10 actual at sample time -
also seen in the A/B baseline on master); it is the first concrete spec-01
target.

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
