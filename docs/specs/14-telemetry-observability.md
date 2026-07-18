# 14 — Telemetry observability: answer the basic questions

**Status:** phases 0/0b LANDED (PRs #111/#113); phases 1–2 implemented
2026-07-18 (room energy ledger, core v4; sizing records, corps v4 — first
stamper: UpgradingCorp via the shared `nodeEnergy.controllerSideStock`
lens and `upgraderSizing`); phases 3–4 open.
Deviation from the plan as written: phase 1 drops the
`spawnEnergy`/`extensionEnergy` split — no decision reads a per-structure
split (the lens decisions read is `energyAvailable`/`energyCapacity`,
already exported), and the ledger carries only lenses decisions actually
use.

## The problem, from evidence

A single owner session (2026-07-18) asked four ordinary questions of the
live economy. Telemetry answered **none** of them without code spelunking,
hand arithmetic, or the owner's own memory:

| Question | Why telemetry couldn't answer |
|---|---|
| "What creep bodies does the plan want vs what we have?" | Actual bodies weren't captured at all (only counts); plan bodies existed for miners only. **Fixed** by phases 0/0b. |
| "Why is the upgrader 2 WORK?" | The sizing inputs (`planAllocated`, controller-side stock, banked energy, inflow, `controllerFeederActive`) are live `Game` reads inside `UpgradingCorp.getSpawnDemand` — exported nowhere. |
| "How much energy is in storage?" | The warchest balance is not in any segment. The owner had to say "200k+" from the game client. |
| "What is spawn capacity at?" | No measured spawn utilization, no actual parts/tick, no queue depth. Derived by hand from `SPAWN_PARTS_PER_TICK` + fleet body counts. |

The pattern: telemetry exports **outcomes** (counts, allocations, ROI) but
not **stocks** or **decision inputs**. Sizing decisions read live Game state
at the decision site (`container.store`, `storage.store.energy`,
`room.memory.controllerFeederActive`); those reads are captured nowhere —
not in segments, and not in `Memory` dumps either (store objects are not
Memory). So every "why is X sized this way" requires reproducing the read,
which sims can't do (live-only state) and captures can't recover after the
fact.

## Design principle: decision symmetry

Generalize the staffsPost-symmetry doctrine to observability: **telemetry
exports the same lens the decision read, stamped at the decision site.**
Corps record the inputs of their last sizing decision when they make it;
`Telemetry` exports the record verbatim. Telemetry never recomputes a
decision input (recomputation can drift from the decision — the exact bug
class the staffsPost trap documents).

## Phases

### Phase 0 / 0b — plan-vs-actual bodies (LANDED / IN REVIEW)

Actual per-corp + colony body parts measured from `Creep.body` (segments
0/4, v3; PR #111). Plan-side hauler CARRY + consumer WORK in the flow
segment (v2; PR #113). Acceptance: `test/unit/telemetry/census.test.ts`,
`test/unit/telemetry/flowPlan.test.ts`.

### Phase 1 — room energy ledger (the "where is the energy" question)

Extend `CoreTelemetry.rooms[]` with the stocks decisions read:

- `storageEnergy` (warchest balance; null when no storage)
- `controllerStock` (controller-side container energy — the
  `controllerSideStock` lens)
- `feederActive` (`room.memory.controllerFeederActive`)
- `spawnEnergy` / `extensionEnergy` (fill state behind `energyAvailable`)

Acceptance (unit, census-test style): a mocked room with storage/container
stocks lands each field in segment 0; a storage-less room reports nulls,
not zeros. Core version 3 → 4.
**DONE** — `test/unit/telemetry/roomLedger.test.ts`.

### Phase 2 — sizing records (the "why is it 2 WORK" question)

A generic optional `lastSizing` record on `Corp`, stamped inside
`getSpawnDemand` where the decision is made; `updateCorpsTelemetry`
exports it verbatim on the corp's segment-4 entry as `sizing`.

First consumer: `UpgradingCorp` stamps
`{ tick, planAllocated, stock, banked, inflow, allocated, targetCount }`.
Same pattern then extends to CarryCorp/ConstructionCorp for free.

Acceptance: unit test drives `getSpawnDemand` with a known stock and
asserts the corps segment carries the exact inputs the decision used
(not recomputed values). Corps version 3 → 4 (one bump shared with any
concurrently landing field).
**DONE** — `test/unit/telemetry/sizingRecord.test.ts` (stamp verbatim
export + UpgradingCorp decision-site stamp on the plan-trusted path).
**Extended 2026-07-18 (gate stamps):** ControllerFeederCorp +
ExtensionTenderCorp stamp every `getSpawnDemand` return with the GATE
that fired (`no-spawn`/`no-storage`/`no-miner`/`staffed`/`demand`) plus
the inputs it read — for infrastructure corps the gate IS the decision.
Driven by a live incident (first v4 captures, t72400561/t72400612):
warchest 549k (~20× the 27.6k target) and growing ~70 e/t, feeder AND
tender at 0 creeps across consecutive captures, upgrader stock-starved
at ~3 e/t while the plan allocated ~30 — cause invisible because the
corps' shared `roomHasMiner` gate (which keys on live creep POSITIONS,
a trap-list lens) stamped nothing. The gate stamps make the next
capture name the blocking gate directly.

### Phase 3 — spawn meter (the "what is spawn capacity at" question)

Measured, windowed spawn utilization in a new `spawns[]` block (core
segment): per spawn, over a rolling ~1500-tick window —
`busyTicks / windowTicks`, actual `partsSpawned / tick`, and current
agenda queue depth (from `Memory.spawnAgenda[spawnId].queue.length`).
Sits next to the static ceiling (`SPAWN_PARTS_PER_TICK`) so
"72% of ceiling" is read, not derived.

Acceptance: unit test advances a mocked spawn through busy/idle ticks and
asserts the meter; integration smoke: meter present and ≤ 1.0 after a
`flow-handoff` run.

### Phase 4 — NOW-plan mirror (actual-vs-NOW, spec 11 alignment)

Export `Memory.spawnAgenda` heads + executed receipts (last ~8 per spawn)
in a telemetry block, so the NOW plan and its execution receipts are
visible without a `/user/memory` pull. Spec 11's tight-assertion pair
(actual-vs-NOW) becomes dashboard-readable.

Acceptance: unit test seeds a spawnAgenda and asserts the telemetry
mirror; receipts match `executed` verbatim.

## Non-goals

- No new segments (0–6 have room; segment size is not a constraint — the
  economy segments total ~11K of the 100K/segment limit).
- No dashboards in this spec (telemetry-app consumes; it is not the
  contract).
- No telemetry-driven behavior: segments remain write-only observability.
  Nothing in `src/` may read a decision from a segment.

## Regression gate

Phases touch telemetry only, but phase 2 adds a write inside
`getSpawnDemand`: run the full gate (`npm run test-unit` + `flow-handoff`,
`runt-economy`, `storage-depot`) for phase 2; unit suite alone suffices
for 1, 3, 4 unless SpawnDirector is touched.
