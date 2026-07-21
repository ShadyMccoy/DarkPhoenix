# 17 — Ontology layers: registration-only kinds, prescriptive NOW plan

**Status:** P0–P5 LANDED (this branch, 2026-07-20 — the P5 sweep deleted
the second sink ladder, NodeFlow, FlowEconomy's dead API, the survey/market
vestiges, the Node.corps web, and the dead ROI/variant layers). Landed: contract v2 + registration-only
plumbing (P1), the prescriptive NOW planner (P2), propose purity + the
expansion split + host-assembled problem facts (P3), truthful consume
envelopes (P4), and the enforcement suite (purity ratchet, registration-only
proof, propose-purity conformance, behavior pins). Follow-on specs from the
owner vision: [18 weighted goals](18-weighted-goals.md),
[19 delivery contract](19-delivery-contract.md).
**Priority:** P0 — this is the "increase future velocity" spec: every future kind
(spec 02 link hauler, minerals/labs, market, military campaigns) gets cheaper
once it lands.

## The thesis

The bot is THREE layers, and each boundary is mechanically enforced:

| Layer | Contents | May read | Must never |
|---|---|---|---|
| **PLAN** (pure) | `economy/` core (CorpPlanner, primitives, Commission, CorpKind, commissionPlan, siteValue, bank, roadEconomics), `spawn/SpawnScheduler` (the NOW planner), every kind's `propose()` | its arguments (`ColonyProblem`, draft commissions) | `Game`, `Memory`, `execution/`, live creep/vision state |
| **EXECUTE** (dumb) | `corps/`, `corps/kinds/` (materialize/run/body), `execution/` | Game + its commission's assignment | invent policy the plan owns; read another kind's naming conventions |
| **AUDIT** (passive, pullable) | variance meters, telemetry segments, spawn agenda + receipts, BlackBox | everything, generically (the census) | feed back into decisions (planner inputs come from the world, not the audit), enumerate kinds by hand |

Two organizing decisions (owner interview, 2026-07-19):

1. **Full GOAP is the endpoint.** Corps are planner *operators*. The central
   solver already plans the energy economy; auxiliary kinds today apply
   themselves via `propose(problem, draft)` — that is the interim operator
   mechanism, and its contract (pure function of problem + draft, durable
   signals only) is what lets a kind migrate INTO `planColony` later without
   rework. New contract surface must be declarative (cost/effect/roles/policy
   as data or pure methods) so the planner can eventually reason over it.
2. **The NOW plan is prescriptive.** Spawn build-time is THE scarce resource,
   so the acquisition sequence is a *plan artifact*, not an emergent ranking:
   one pure call produces both the published agenda and the buy decision, and
   the decision IS the first executable agenda entry. `SpawnDirector` executes
   and files receipts; deviations are impossible by construction, not "signal".
   The spawn *doctrine* (tier ladder, holds, starvation, miner precedence) is
   settled and stays behavior-pinned; it becomes one swappable pure module.

**Registration-only rule:** adding a corp kind = one kind file + one `KINDS`
entry. Planning, spawning, orphan rescue, body building, census, variance, and
telemetry all pick it up from the registry. Anything that requires a third edit
is a bug in the framework (and test C below must catch it).

## The gap (audited 2026-07-19, 7-dimension sweep; branch `claude/bot-cleanup-ontology-bqo054`)

Mirror lists that re-enumerate what the `KINDS` array already knows:

| Leak | Evidence |
|---|---|
| Per-kind demand-policy blocks, 10 kinds, ~150 lines | `execution/SpawnDirector.ts` `collectDemands` (imports all ten corp classes) |
| Three parallel kind/role lists — one already stale (no `claim` entry in `ROLE_KIND`) | `execution/OrphanRescue.ts` `liveCorpIds`, `ROLE_KIND`, `readoptTarget` |
| Live body path is a 12-role string switch; every kind's `CorpKind.body()` is dead code (zero callers) | `corps/SpawningCorp.ts` `buildBodyForRole` |
| Creep census buckets drifted: raidGuard/coreBuster creeps count as "untracked" | `telemetry/Telemetry.ts` `KIND_TO_CREEP_BUCKET` |
| Variance snapshot covers 4 of 11 kinds — the audit layer under-reports | `execution/CorpRunner.ts` `allCorps`, `logCorpStats` |
| Closed unions as undeclared registration points | `CreepMemory.workType`, `CorpType`, `SpawnRole` |
| Console tooling omits 4 kinds | `main.ts` `status`/`survey`/`marketStatus` |

Purity breaches in the planning layer:

- `economy/expansion.ts` issues **game intents** (`createConstructionSite`) and
  Memory writes from `economy/`.
- Three impure `propose()` implementations: `constructionKind` reads
  `Game.creeps` (the documented creep-position trap class), `claimKind` reads
  `Memory.expansion` + `Game.map`, `scoutKind` reads CPU-governor state via an
  `execution/` import.
- `CommissionHost.liveProblem()` hands propose() empty sources/sinks and a
  cross-room-broken Chebyshev dist — and its raw spawn ids collide with the
  draft's flow-prefixed ids, so `constructionKind` attributes every remote
  trunk to the FIRST spawn's room (live bug in multi-room colonies).
- No boundary is mechanically enforced anywhere (no purity test, no import
  rules) — which is how all of the above landed green.

Audit-layer fictions:

- Consume commissions declare `spawnPartsPerTick: 0` while the planner's ledger
  charges real consumer build-time (stale "not yet budgeted" comment).
- The conformance suite's 1e-9 economics check is opt-in and currently vacuous
  (every enrolled kind asserts 0 or omits it); `claimKind` has no conformance
  test at all.
- A second, disagreeing sink-priority ladder still computes every solve
  (`PriorityManager` + `FlowGraph.calculateSinkPriority` + 
  `DEFAULT_SINK_PRIORITIES`) — dead for routing, live for confusion.

## Target design

### 1. CorpKind contract v2 (additive)

```ts
export interface CorpKind<C extends Corp = Corp> {
  // ... existing: kind, runOrder, propose, materialize, run,
  //     serializeCorp, deserializeCorp, body ...

  /** Roles this kind's creeps carry: SpawnRole -> the workType it stamps.
   *  Drives body dispatch, orphan re-adoption, and role registries.
   *  (Replaces SpawningCorp's workTypeMap + OrphanRescue's ROLE_KIND.) */
  roles: { [role: string]: { workType: string } };

  /** DEMAND policy: decorate this corp's spawn demands with funding-group
   *  semantics. Pure; `world` carries the few cross-kind execution facts the
   *  policy may read (e.g. isSourceMined). Absent/null = pass through
   *  (the corp's own getSpawnDemand already said everything). */
  demandGroup?(corp: C, world: DemandWorld): { groupId: string; started: boolean } | null;

  /** ORPHAN re-adoption: return the id of one of this kind's corps that
   *  legitimately owns this creep's work, or null. Default (absent): any
   *  same-room corp of the creep's role. (Replaces readoptTarget's switches.) */
  claimsOrphan?(creep: Creep, corps: { [id: string]: C }): string | null;
}
```

`DemandWorld` is assembled by the director from the commission store — it is
execution-layer state (creep counts), which is exactly why it is an *input* to
the pure policy rather than something the policy digs out of `Game`.

### 2. Generic plumbing (the mirrors dissolve)

- `collectDemands`: ONE loop — every store entry, uniform
  `getSpawnId() === spawnId && !retiring` filter, `getSpawnDemand(ctx)`, then
  the kind's `demandGroup` decoration. Zero per-kind imports.
- `OrphanRescue`: `liveCorpIds` = census (`allCommissionedCorps()` + legacy
  registry); role→kind map built from `kind.roles`; re-adoption via
  `claimsOrphan` with the same-room default.
- `SpawningCorp.executeSpawn`: body via `getCorpKind(kind).body(role, ...)`,
  workType via `kind.roles`. The role switch survives only for the two
  legacy-registry corps (bootstrap jack, spawning) until they port.
- Telemetry census: `creeps.byKind` derived from the census generically
  (telemetry-app types updated in the same commit); `KIND_TO_CREEP_BUCKET`
  deleted. Variance snapshot + corp stats iterate the census.
- Type unions (`workType`, `SpawnRole`) widen to `string`; validity is enforced
  by conformance against `kind.roles`, not by the compiler at 6 distant sites.

### 3. The NOW planner (spawn sequence, prescriptive)

`spawn/SpawnScheduler.ts` (pure, unchanged doctrine) gains the single entry:

```ts
planAcquisitions(demands, ctx): {
  agenda: AgendaEntry[];   // ALL demands, ranked; each entry annotated with its
                           // gate verdict ("no-miner", "hold", "bank>=N", "after:X")
  decision: ScheduleResult | null; // = first agenda entry whose gate opens NOW
}
```

- The agenda covers the same demand set as today (miner-precedence-filtered
  entries stay listed, annotated `gated:"no-miner"`) so fidelity cells keep
  their view; but agenda and decision now come from one walk and cannot
  disagree.
- `SpawnDirector` per spawn: build demands (generic) → stamp ages →
  `planAcquisitions` → publish agenda → execute `decision` → receipt.
  It contains no decision logic.
- `scheduleSpawn`/`buildAgendaQueue` become internals of `planAcquisitions`;
  the doctrine (spawnPriority, effectivePriority, holds, starvation, miner
  precedence) is untouched and pinned by equivalence tests.

### 4. Purity + the host problem

- The host passes propose() a truthful problem: fresh spawns (as today) plus
  the last solve's sources/sinks/dist, and host-assembled context the impure
  triggers currently steal from globals: `problem.expansion` (claim),
  `problem.freezes.scouting` (scout). `constructionKind` derives remote mined
  rooms from the DRAFT's harvest commissions (durable signal, same lens as
  reservation) instead of `Game.creeps`.
- Id spaces: planner/commission ids stay flow-prefixed (renaming corpIds
  orphans live creeps — the trap list is normative). The convention is
  DOCUMENTED in ONTOLOGY, and lookups that cross spaces (constructionKind's
  `spawnRoomById`) normalize explicitly.
- `economy/expansion.ts` splits: pure candidate scoring stays; the campaign
  driver (Memory writes, `createConstructionSite`) moves to
  `execution/ExpansionCampaign.ts`.
- `flowAdapter.publishRoster` stops writing Memory from the adapter; the roster
  is returned and published by the caller.
- `primitives.ts` owns its constants (arrows invert: flow/corps re-export FROM
  economy).

### 5. Truthful envelope + audit uniformity

- Consume commissions carry the same `spawnPartsPerTick` the ledger charges
  (`controllerWorkSpawnLoad`/`constructionWorkSpawnLoad`).
- The conformance economics check becomes mandatory: a kind either derives its
  envelope from primitives or explicitly declares `consumesNoBuildTime`.
- Every registered kind has a conformance enrollment (auto-verified: a test
  iterates the KINDS roster and fails on any kind without one — closes the
  claimKind hole).

## Extension paths (documented, NOT implemented here)

- **Typed resources** (minerals/labs/market): `consumes`/`produces` grow a
  `resource?: ResourceConstant` defaulting to energy; primitives stay
  energy-denominated until a second resource exists. No new surface hard-codes
  "energy" in a name where "rate at place" is meant.
- **Mission-shaped commissions** (military campaigns): `shape: "mission"` with
  objective-typed assignments; raidGuard/coreBuster are the proto-missions and
  keep their forced-`started` demand policy as kind declarations.
- **Planner absorption**: an auxiliary kind migrates into `planColony` by
  turning its `propose()` into an operator (precondition = the trigger,
  cost = its spawn load, effect = its value) — the contract above is already
  that shape.

## Acceptance tests

1. **Registration-only (extends spec 00 test C):** the toy kind in
   `newCorp.test.ts`, with `roles` + a demand, flows end-to-end through the
   REAL `collectDemands`, is body-built via its own `body()`, appears in the
   census/variance snapshot, and its orphaned creep is re-adopted/recycled by
   the REAL OrphanRescue decision path — importing only the public API, with
   zero edits outside the test file.
2. **Spawn-decision equivalence:** across the harness worlds (and a randomized
   demand-set sweep), `planAcquisitions(demands, ctx).decision` deep-equals the
   pre-refactor `scheduleSpawn(demands, ctx)`, and the generic `collectDemands`
   yields demand sets deep-equal to the pre-refactor enumerated version.
   Agenda[0]-consistency: for every input, `decision` is `agenda`'s first
   entry whose gate verdict is open.
3. **Body equivalence:** for every (role × bodyParam × budget) in a sweep grid,
   `kind.body(...)` equals the legacy `buildBodyForRole(...)` before the switch
   is deleted.
4. **Purity:** with `global.Game`/`global.Memory` deleted, every PLAN-layer
   module imports cleanly and `planColony` + every registered kind's
   `propose(problem, draft)` runs without throwing; an import-boundary test
   pins the PLAN-layer files' import lists against an allowlist.
5. **Envelope honesty:** conformance derives every kind's
   `consumes.spawnPartsPerTick` from primitives (or the kind declares
   `consumesNoBuildTime`); consume commissions match the ledger's charge to
   1e-9; the kinds-roster test fails on any registered kind missing
   conformance enrollment.
6. **Census completeness:** telemetry `creeps.byKind` accounts for every creep
   whose corpId resolves in the store/registry; a registered kind cannot be
   "untracked" by construction.
7. **Regression gate (every phase):** full unit suite + `flow-handoff` +
   `runt-economy` + `storage-depot`; grid baseline at the end
   (`npm run grid`), updated in the same commit as any earned change.

## Phases (one commit each, gated)

- **P0** this spec + pins (2, 3 above) captured against pre-refactor behavior.
- **P1** contract v2 + generic director/rescue/body/census/variance/console.
- **P2** `planAcquisitions` + director inversion (NOW plan prescriptive).
- **P3** purity: host problem, impure propose fixes, expansion split, roster
  return, primitives constants, enforcement tests.
- **P4** truthful envelope + mandatory conformance + claimKind enrollment.
- **P5** dead code: PriorityManager/second ladder, NodeFlow, FlowEconomy dead
  API, Phases/market vestiges, EdgeVariant shrink, broken `plan:budget`.
- **P6** docs: ONTOLOGY rewrite (layers as §1), PIPELINE re-anchor, spec 00
  status/gates, CLAUDE.md trap-list refresh.
