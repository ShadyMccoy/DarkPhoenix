# 14 — Telemetry observability: answer the basic questions

**Status:** phases 0/0b LANDED (PRs #111/#113); phases 1–2 implemented
2026-07-18 (room energy ledger, core v4; sizing records, corps v4 — first
stamper: UpgradingCorp via the shared `nodeEnergy.controllerSideStock`
lens and `upgraderSizing`); phases 3–4 implemented 2026-07-18 (spawn
meter + NOW-plan mirror, core v5). The reserver-loop fix the audit found
landed alongside (owner-authorized): ReservationCorp's demand lens now
counts living reservers including spawning/unassigned newborns
(`countLivingReservers`), with its own sizing stamp.
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
**Verdict (post-deploy capture t72401512 + live spawnAgenda pull):** the
gate stamps ACQUITTED `roomHasMiner` (`hasMiner: true`; tender
`staffed`, feeder `gate: "demand"` - asking every tick, never funded).
The spawnAgenda receipts + blackbox then convicted a **reserver
purchase loop**: ReservationCorp's coverage lens is newborn-blind
(`getActiveCreeps` excludes `creep.spawning` - a 24-tick build - and
`covered` needs `memory.targetRoom`, assigned only after birth), so its
value-115 banked demand re-fires during every build; measured 4x1300
energy in ~90 ticks (vs 1/150t steady need), ~53% of spawn build-time,
~58 e/t - saturating the spawn (103% measured vs 77% steady-state
need), starving the feeder, and compounding the 570k warchest. The
staffsPost-symmetry trap, verbatim, in the post-#108 covered-lens.
Fix is deliberately NOT part of this spec (live spawn economics,
owner-gated): mirror HarvestCorp.countStaffing in the coverage lens,
red-first test, full regression gate. The audit chain that found it -
capture -> anomaly -> stamp the invisible decision -> redeploy -> next
capture names the cause - is the repeatable product of this spec.

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
**DONE** — `test/unit/telemetry/spawnMeter.test.ts` (utilization =
busy/observed, partsPerTick = utilization/3, Memory-backed windows,
queueDepth; window = 1500t, `last` guard against double-count).

### Phase 4 — NOW-plan mirror (actual-vs-NOW, spec 11 alignment)

Export `Memory.spawnAgenda` heads + executed receipts (last ~8 per spawn)
in a telemetry block, so the NOW plan and its execution receipts are
visible without a `/user/memory` pull. Spec 11's tight-assertion pair
(actual-vs-NOW) becomes dashboard-readable.

Acceptance: unit test seeds a spawnAgenda and asserts the telemetry
mirror; receipts match `executed` verbatim.
**DONE** — `test/unit/telemetry/agendaMirror.test.ts` (first 4 queue
heads + receipts verbatim, deep-equal; block absent without an agenda).

### Phase 5 — planner exclusion stamps (the "why are the remotes dead" question)

`selectProducers` was the last silent decision in the economy: a source
absent from the plan was indistinguishable from one priced out by the
invader tax, dropped for build-time budget, or never reachable. Driven by
the large-hauler audit (2026-07-18): the GOAL plan excluded all 5 remotes
continuously across 2000+ ticks while the NOW pipeline kept buying for
them, and the cause (tax overshoot? reservation-lapse deadlock? budget?)
was UNDETERMINABLE from captures — the raid-embargo attribution was
falsified by timing (marks expire ≤1500t; the exclusion persisted).

Every non-transient candidate now gets a `SourceVerdict` — `{sourceId,
rate, distance, net, tax, parts, verdict: funded|unprofitable|
over-budget|no-spawn}` — recorded in producer selection with the exact
pricing the decision read, carried through ColonyPlan → FlowSolution →
the flow segment as `candidates[]` (v3). One capture now names each
remote's exclusion reason and its tax term directly.

Acceptance: planner unit test drives a taxed source (unprofitable, tax
term visible), a budget-exhausted world (over-budget with positive net),
and funded/miner symmetry; telemetry test asserts verbatim export + v3.
**DONE** — `CorpPlanner.test.ts` (verdicts), `flowPlan.test.ts`
(candidates verbatim).

## Audit log

### 2026-07-18 — S3 starvation backstop: raw-age FIFO falsified, bucketed FIFO shipped

The `since` export (phase 4) named the live S3 inversion exactly (t72403765:
tender age 1371 at queue position 4 behind self-renewing starved scale-haulers
≤1134; four hauler buys in ~160t; upgrader fleet decayed to 0 by t72404213
while storage rose +19 e/t against a 115 e/t plan). First fix — raw-age FIFO
inside the starved tier — was **falsified by its own gate**: flow-handoff red
twice (zero flow haulers by t600) while a control draw on the pre-FIFO
additive ranking stayed green. The agenda mirror, surfaced into the probe
(now permanent there), named both mechanisms in one draw: cold start seeds
every demand in the same tick so raw age degenerates to collection order
(miner buys round-robin across sources, no source completes, minerPrecedence
never unlocks a hauler), and the no-walls walk variant let the tier's builder
eat the blocking hauler's accumulating bank (`exec=[miner@260 builder@325]`,
hauler head stuck at `bank>=300` forever).

Shipped (56292a7, deployed with 540b0fa MAX_SURPLUS_DRAW=100): starved tier
ranks by **age bucket** (age / STARVATION_THRESHOLD, step 2e6 > max
spawnPriority; value doctrine orders within a bucket), purchase **resets the
demand stream's clock** (age = unserved time, restoring STARVED_TIER's
documented one-shot contract), walk walls byte-identical to the control.
Gate: 885 unit + 3 integration + 5 grid cells green. Verdict: **fixed**
(prod verification pending next capture — predicted: tender staffed within a
spawn window, upgraders refleet, storage slope negative, progress toward
plan).

**Verified t72411542 (+7329t):** tender 0→1 (24 parts), upgrader 0→1 at 15
WORK with allocated 36.3→116.3 and inflow 35→115 (the draw-guard lift,
exact), feeders 1→2, progress ~0-3→16.8 pts/t window average, receipts
rotating full-size bodies across roles (haulers 1000-1550, feeder 1552,
builder, guard). Storage slope +19→+2.2 e/t (upgrader fleet 1/8 fielded;
negative expected as it scales). Transient named, not fixed: an invader raid
plus TTL expiry collapsed miners 6→3 (both HOME miners dead, reservers 0/4),
and the rebuild drains the pre-deploy starvation backlog in bucket order -
reserver holdToFund at head (energyAvailable 1250/1300 at capture) walled the
younger home-miner demands ~1000t (~20 e/t idle home income). Self-limiting
by design: purchase resets clocks, so post-backlog ordering reverts to value
(home miners first). Watch next capture for release + hasMiner→true +
feeder/tender gates reopening.

Open finding for spec 15 (measured this cycle, not yet fixed): the GOAL plan
is **spawn-infeasible ~1.6×** — plan-implied maintenance ≈0.54 parts/tick vs
0.333 physical (producers 0.33 incl. 0.134 of scavenge/bank routes priced by
no budget; consumers/infra ≈0.21 vs the flat 40% reservation). Effective-TTL
amortization exists for producers (`effectiveLife`, `CorpPlanner.ts:393,433`)
but subtracts tiles, not ticks (~2× underweight off-road; roads halve real
ticks — the priced `paved` ratio already models the body savings).

### 2026-07-18 (later) — P4 feasibility deployed after full acquittal; hollow-gate hole found and closed

The spawn-parts ledger (P4, 69b0f63+6f23eb5) hit a red full grid twice:
4 baseline-green cells down (agenda-t2-spawns/receipts-match-head,
plan-t1-single-source-loop timeout, plan-t5-remote-pipeline). First run
was discarded as cross-contaminated (two grids shared the host after a
container restart resurrected a presumed-dead run); the clean exclusive
rerun REPRODUCED all four — contamination falsified as cause. Solo
reruns reproduced deterministically. Control runs on pre-P4 source
(bcb39f4, src ≡ the deployed FIFO build) failed **identically** (± 3-30
ticks) — **P4 acquitted on all four**; the regressions are properties of
the build already live.

Process hole found while attributing: `npm run grid -- --cell` skips the
baseline ratchet and exits 0 regardless of verdict. The bucketed-FIFO
deploy gate read exit codes, so its five grid-cell "greens" were never
actually verified — the four cells may have been red since that change.
Closed: audit command now requires marker parsing (`[P]`/`[x]`/`[T]`)
and pre-change-source attribution before any red cell blocks a deploy.

P4 deployed on its own evidence (898 unit incl. red-first feasibility
pins, integration trio green in four consecutive runs, cap arithmetically
slack in the failing cells' worlds). Predicted deltas: ledger P4 line
FAIL→ok, planAllocated ~125→feasible, upgrader target 8→small, the
miner/upgrader oscillation stops, spawn off the 0.98 pin. OPEN incident
(next cycles): the four cells vs the FIFO build — pre-FIFO control run,
then multi-draw to separate FIFO-caused from lucky-baseline margin
(agenda cells fail at t387-390/400, plan-t5 at t1246-1276/1800 — late-run
tail events; suspicion: time-varying effectivePriority lets the published
head and the buy walk diverge across a bucket boundary, and tempo margins
thinned).

### 2026-07-18 (evening) — P5 reserver duty cycle deployed

The last standing price/behavior drift closed: reservers now coast on the
intel-stamped reservation bank (RoomDiscovery stamps reservedUntil/
reservedBy - exact while blind; myReservationTicksLeft lens; demand gate
buys only below RESERVATION_REFRESH_FLOOR 800; work() orders targets by
lowest bank through the same lens). One 2-CLAIM stint nets ~+540 bank →
one stint per ~1080t = the 0.5 duty reserverTollPerRoom always priced.
Gate: trio green, def-t5 all asserts satisfied (the adjacent invader-
reservation intel path verified), plan-t5 pre-existing-unchanged (task 9).
Deployed 2574a68-era dist. Predicted: sizing stamps carry per-room banks,
ledger P5 FAIL→ok, reserver cadence halves, remotes hold 3000 throughout.
Marker-parse refinement learned: a PASSING --cell run prints satisfied
asserts, not a [P] line - absence of [x]/[T] plus satisfied asserts = pass.

Open observability item (owner question "I thought we handle raids with
fighters"): the raid post-mortem is currently unanswerable - blackbox ring
~180t, segment 3 exports no per-room harvestedSinceRaid or guard state.
Next: defense ledger line (meter + guard state export + mark-time
post-mortem stamp); fold guards into the P4 infra deduction.

### 2026-07-18 (night) — roads/surplus batch deployed (owner directive: build fast from the bank)

Deployed 741099d as ONE batch (one global reset - the warmup-churn
lesson): (1) construction burns the warchest - sink capacity includes the
bank draw, P4 fill charges builder bodies (5x cheaper per e/t than
upgrading), buildSideStock + the crew tanker read the spendable surplus
through one lens; (2) sizing doctrine (owner): consumers size MAXIMALLY
to their allocated flow - biggest bodies, relay sized to the CREW PLAN
over the true fuel round-trip (storage in surplus regime), big shuttles
(4->16 CARRY cap); the ledger shrinks the ALLOCATION when parts are
scarce, never fields an undersized consumer; (3) paving unblocked - a
warchest in surplus is a go signal (the full-bank tick never occurred
while the spawn ran pinned: zero routes judged all session), feeder-trunk
candidacy added (receipt "feeder", flow = live relay rate); (4) the
planner's last silent skip stamped: verdict "unreachable" when no spawn
paths to a source, nearestSpawn rejects non-finite distances.

Predicted: road verdicts appear in roadRoutes receipts; construction sink
absorbs the bank when sites exist (storage slope hard negative during
builds, controller pauses near floor then recovers); the remote-drop
cause discriminates (unreachable rows = path lens; absent rows = graph/
intel exclusion - the open investigation). Gate: trio + 6 cells green on
a clean host after an orphan-mockup storage crash was cleaned (restart-
killed gates leave orphans - clean before rerunning).

### 2026-07-19 — road-gate stamps + fill trace (segment 6 v4) deployed; toolchain root-caused

Cycle t72419708: allocation HOLDS at 87.8 post-batch (the 97 -> 6.4
collapse died with the deploy, attribution still open), but roadRoutes
EMPTY persists through every capture despite containersOpen=true at
RCL5 - tryPlaceFeederRoadRoute's early returns were the last verdict-less
exits in the road pipeline. Deployed a4db5bd (telemetry-only gate: 911
unit + build): every exit stamps lastSizing.roadGate (9 reasons), and
task #12 closes - partsLedger/partsLeft threaded planner -> adapter ->
segment 6, version 3 -> 4, pinned by flowPlan tests (ledger verbatim,
absent-ledger omission). Predicted: next capture names the feeder
blocker in one read; a fill-collapse recurrence is named in one read;
NO behavior deltas (stamps/exports only - movement = rollback signal).
Fixture t72419708 pins the open W43N24 anomaly (raidDebt 136,860 >
130k engine ceiling).

Verified settled (t72420516, ~2100t post-deploy): v4 ledger live
(capacity 0.333 / minerLoad 0.038 / infra 0.187 / budget 0.108),
allocation back at 87.8 exactly (zero behavior movement - telemetry-only
deploy confirmed), remotes re-funded post-warmup, util 0.39. P4's
"FAIL 1.00x" from the warmup capture was the fill running budget-dry BY
DESIGN vs the script's strict >1.0 on 0.2% recompute drift - tolerance
1.005 shipped with the boundary capture pinned WARN (the 1.32x true-FAIL
pin holds). OPEN: per-sink partsLeft values don't arithmetically match
the charges the plan carries (controller partsLeft 0.105 of budget 0.108
with 87.8 e/t allocated whose work-charge alone is ~0.097) - either the
stamp records a pre-pass remainder or the controller charge misses the
fill; needs a unit-level reproduction before the next planner change.

### 2026-07-19 (later) — repair hysteresis fixed measured-first; placement ladder stamped; concurrent cell GREEN

The concurrent cell's red third assert, instrumented (diag-concurrent):
the LONE builder wore repairDetail t20-t260 with site progress 0,
released exactly when the container crossed 60%. wantsCriticalRecovery
was one-sided - anything below the 0.6 RELEASE band read as "critical",
so the last-builder guard's emergency exception swallowed the rule for a
routine 43% container. Fixed with the in-diversion state as an explicit
input (start <0.3, hold-to-0.6 only once started); the guard override
now uses the raw critical gate. Trio green. Cell recalibrated to its
contract (staged 2-builder crew via OrphanRescue adoption + stocked
depot - a +1 e/t drained ramp can never afford the detail member) and
GREEN t242/400, baselined.

Road silence root-out (three frames up from the feeder stamps): W43N23
has 30/30 extensions + storage + NO controller container, zero sites,
zero road verdicts across 2100t, governor UNARMED, bucket 10000. The
placement pass's interior is invisible - placeSite logs failures only to
console and a rung that fails every 10t cooldown eats every rung below
it silently. Deployed (byte-verified): placeSite stamps every attempt
verbatim (type@room:x,y + return code, governor-paused gate), road-scan
energy wall stamped. Predicted: next capture's construction sizing names
the eaten rung (likely a repeating failed controller-container attempt);
lone-builder crews detailed on 30-60% structures release to build; no
other fleet movement.

Toolchain finding (why "do NOT use push-main" in the loop doc): the
container's registry mirror serves versions that do not exist upstream -
rollup 2.80.0 (real 2.x ends 2.79.2) and picomatch 2.3.2 (real 2.x ends
2.3.1) - and the fake picomatch REJECTS extglobs with an empty
alternative, so rpt2's default include (*.ts+(|x)) matched nothing and
rollup hit raw TS ("Unexpected token: declare"). Proven by probe: rollup
calls transform; rpt2's createFilter returns false; picomatch.isMatch
('main.ts', '*.ts+(|x)') === false. rollup.config.js now passes plain
globs (workaround, committed). Deploys ship the TESTED webpack bundle to
the ACTIVE branch (master) via the code API - byte-verified round-trip
this cycle. Supply-chain provenance flagged to owner: install from a
trusted network before relying on this container's node_modules for
anything security-sensitive.

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
