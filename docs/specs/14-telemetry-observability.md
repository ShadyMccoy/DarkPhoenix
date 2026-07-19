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

### 2026-07-19 (Routine cycle) — stamp prediction verified in ONE capture; eaten-ladder loop fixed and deployed

t72420637 (80t post-stamps-deploy): the placeSite stamp named the rung
immediately - link@W43N23:48,13 -> -7 (near-exit rule) retried every
10t cooldown, the invisible loop that starved every rung below (zero
road verdicts in 2100t downstream of it). Fixed red-first and deployed
(byte-verified): bestAdjacentTile clamps to 2..47 (engine rejects
non-road structures on near-border tiles beside exits; core infra never
belongs there), and placeSite blacklists ERR_INVALID_TARGET tiles in
room.memory.deadTiles which the generator excludes - the second instance
of the bad-candidate-retry class (source tiles bit identically before);
the backstop ends the class. Gate: 916 unit, trio green, cons-link-core-
first pass@60 under the clamp, concurrent cell pass@242 (same tick as
its baseline run). Predicted next capture: no link@48,13 repeats; W43N23
shows either a legal link placement or road verdicts (the scan finally
running); E2's 94 stranded parts (deploy-reset churn) clears.

Same capture, ledger milestones: FIRST GREEN P4 (0.77x under the
budget-dry tolerance) and green P5 at priced duty 0.50 with reservation
banks read live (W42N22:279 W42N23:318 W43N24:167 W44N23:72).

### 2026-07-19 (cron cycle) — dead-tile fix VERIFIED in prod; E2 discriminator armed; no deploy

t72420978 (~50t post-deploy): placeAttempt link@W43N23:46,11 result 0 -
the clamp rejected the cursed border tile, the generator proposed a
legal one, the site PLACED. The eaten ladder is unstuck; road verdicts
now sit behind one 5k link build (wantsLink -> false on completion,
wantsRoadWork drives the pass to rung 4). P4 holds 0.77x; P5 banks
GROWING (W42N22 279->609, W44N23 72->402 - reservers actively banking);
P1 stable; storage -18/t. E2 88 parts / same 4 fleets as last capture -
but three deploys in 90 min re-randomize route ids faster than hauler
lifetimes, so the cohort may be deploy-cadence coupling. Discriminator
armed (task #15): next capture rides a NO-deploy window; clears = churn,
persists = haulers need route reassignment on replan. Cycle verdict:
verified + instrumented, deliberately no deploy.

### 2026-07-19 (Routine cycle, clean window) — FIRST NO-FAIL LEDGER; delivery meters live

t72421515 vs t72421124 (dt 391, no deploy in the window - the E2
discriminator's clean read): NO FAIL LINES. P6's maiden cycle: all four
rooms pumping (W42N22:426 W42N23:244 W43N24:514 W44N23:374, 1558 ticks
banked/384t) - the zero-pump churn is intermittent; the gated one-way
batch ends its mechanism. P7 maiden: 2.54x the floored plan (residual
stock burning per doctrine). E2 DECAYING through the clean window
(94 -> 88 -> 48 parts, fleets 4 -> 3): leaning churn-artifact; the
stranded cohort's lifetimes expire ~t72422400 - E2 -> 0 without
replacement closes #15 as churn. P4 0.67x, P5 staffed (banks all
climbing), P1 stable. Road chain self-advancing: link@46,11 at
4250/5000; completion opens the roads rung with nothing left in the
way. Cycle verdict: verified; no fix needed from this capture; batch
gate mid-run (deploy on its green).

### 2026-07-19 (Routine cycle) — recovery COMPLETE; E2 decaying on a stable plan

t72424403 (batch-2 build; roads-2 not yet deployed - its gate still
running): the colony is fully recovered. Upgraders 2 -> 6 (full fleet),
controller progress +32,385 over the window, P7 ramping 0.37 -> 0.46 as
the fresh upgraders bite (stock 1882 -> 1435 burning). Reservation
economy healthy: P5 banks all high (775/813/771/619), P6 all four
pumping hard (5949 banked/870t). Assembly stable 38/38, P1 0 flips,
S3 queue empty, storage draining -36.7/t. The ONE FAIL is E2 (90 parts,
7 fleets) - DOWN from 186 two cycles ago on a now-stable plan: the
home-only->remotes-back transition strands aging out, not regenerating.
PREDICTION (falsifiable): next capture E2 < 90; if it plateaus/grows on
a stable plan it is a real hauler-rebind gap and #15 reopens. No fix
this cycle - verified.

### 2026-07-19 (cron cycle, post-marathon) — recovery on script; E2 decay prediction armed

t72423594: P7 0.23 -> 0.34 -> 0.37 (upgraders 2/6 fielded, stock
BURNING 2367 -> 1882), E4 slope -34.3/t, P6 all four rooms pumping
(1201 banked/219t), P5 staffed 4/4 banks rebuilding, X3 2, E5 0, P4
0.78. E2 GREW 142 -> 186 (9 fleets) - but the ids are transition-era
(the plan churned home-only -> re-funded -> equilibrium; each shift
manufactures strands). Plan now STABLE (P1 0 flips, 87.8 equilibrium):
PREDICTION - E2 decays by next fire, or hauler rebind-on-replan
(revisiting #15's close with better data) becomes a work item. No fix
this cycle.

### 2026-07-19 (marathon close) — stall basin instrumented: the frozen-bank hold (incident #18 narrowed)

diag-runt-stall, two draws, one of each basin. STALLED draw: from t375
the head is miner@400! (the upsize, correctly holding) while spawnE sits
FROZEN at exactly 200 for 825 ticks - income flowing, one hauler
fielded, nothing spawning, and the bank never moves. HEALTHY draw:
identical to t450, then one delivery surge crosses 400 -> upsize buys
t460 -> runt recycles -> cascade to a full economy by t700. The graph
plans a flat 10 e/t spawn-sink demand (FlowGraph:156), so a frozen bank
means DELIVERY stopped, not the plan: two checkable candidates - (a)
the single funded hauler binds the UNSTAFFED source's route (zero
pickups forever; draw-dependent by binding), (b) the hauler serves the
controller while miner self-delivery equilibrates at 200. Next
instrument: positions + corpId in the diag creep tags; one red draw
names it. Pre-existing, non-gating; evidence: task output b2uwp6el7,
scripts/diag-runt-stall.ts committed.

### 2026-07-19 (Routine cycle) — FEEDER CLAMP VERIFIED LIVE; transition tracking predicted

t72423329: the feeder stamp carries the clamp's full arithmetic -
planFlow 68.3 (the controller allocation), surplusRate 115, relayRate
73.3 = min(surplus, plan+5), wantedFeeders 2 and TRACKING the plan as
the allocation recovers. Task #16 verified in prod. E4 slope negative
again (-6.4/t, prediction landed); untracked 6 -> 3; P7 0.23 -> 0.34
with upgraders queued behind the remote rebuild (S3 watch: head
upgrader@1750 AFFORDABLE+IDLE at util 0.91 - if upgraders have not
fielded by next capture, S3 escalates); reservation network rebuilding
from zero banks (gate demand, staffed 1/4). Assembly stable 38/38,
7 funded, P1 stable. Cycle verdict: verified, no fix; stall diag
(incident #18) draw 2 in flight.

### 2026-07-19 (cron cycle) — REMOTES BACK, lens live on the healed state; paving COMPLETE

t72423161 (~250t post-batch-2): assembly {graphSources:38, mined:38,
transient:1, bank:1} - the lens's first live read, on a HEALED plan: 37
candidates, 7 funded (2 home + 5 remote), miners rebuilding (3),
reserver re-fielding (1), untracked 10 -> 6 (re-adoption). Batch-2's
own reset healed at the normal ~300t pace, so the 1300t-stuck window's
mechanism stays unnamed - the lens now stands guard for the next
occurrence (stuck-state read: graphSources=2 means the graph layer,
38/2 means the assembly filter, full counts + 2 candidates means the
solver). P8: sites 1 -> 0 - THE PAVING PROJECT IS COMPLETE (all 8 road
tiles + the link built this session). Ledger FAILs are all the
post-reset transition: E2 142p deploy-churn (decays ~1500t), X3 6
(re-adopting), E4 slope +8.3/t and P7 0.23x = income recovered before
the 1750-cost upgraders finish queueing (spawn 0.90 busy, head
upgrader@1750 banking). Predictions carried to next fire: feeder stamp
planFlow + shrunk wantedFeeders; P7 >= 0.75; E4 slope negative;
opportunistic-topup gates once banks re-establish. Incident #18: the
agenda-mirror stall diag (2 draws) running in parallel.

### 2026-07-19 (marathon) — batch-2 DEPLOYED after control acquittal; runt-stall incident opened

runt-economy red on both batch-2 gate runs but GREEN twice earlier on
the deployed dist - then a CONTROL draw on the deployed commit (93fcca3
src, current tests) reproduced the red with the IDENTICAL signature:
one 2-WORK miner the whole 1200t, second source never staffed, no
recycle ever. Identical-failure-pre/post acquits the batch (protocol);
the stall is a pre-existing draw-dependent basin on the DEPLOYED build
(4R/~5G today) - incident #18, agenda-mirror instrumented draw queued,
NOT deploy-gating. Batch-2 deployed byte-verified: feeder relay clamped
to the plan's controller flow (stamp gains planFlow/surplusRate),
opportunistic reservation banking (never-walling never-starving topup,
accumulation-runway deferral), flow v5 assembly counts. Predicted:
feeder wantedFeeders tracks the controller allocation (3 -> fewer while
construction preempts); opportunistic-topup gates appear only in idle
windows once remotes return; THE KEY ONE - the next capture carries
assembly {graphSources, mined, transient, bank} and NAMES the layer
dropping the remotes (still home-only at +1300t, four reservations
expired, ~20-40 e/t bleeding).

### 2026-07-19 (Routine cycle, +750t) — E2 CLOSED as churn; ROADS BUILT; the remote-drop persists past its heal window

t72422418 vs t72421818 (dt 600): E2 -> 0 ("every fielded hauler serves
a planned route") - the stranded cohort expired with no replacements
through clean windows; task #15 closed, deploy-cadence churn confirmed,
no route-reassignment gap exists. P8's first live read: completion
window, sites 8 -> 1 - SEVEN ROAD TILES BUILT (the owner's roads are on
the ground); the ambiguity guard worked (skipped, no false alarm).
Upgrader allocation healed to 53.5 as construction wound down
(targetCount 4, stock 2959); P7's 0.0 read spans the construction-peak
floor + a 1-upgrader fleet trough - next window is the meaningful read.

THE FINDING: the warmup remote-drop did NOT heal this time (+750t vs
the usual ~300t): candidates still home-only (2), reservation
"no-targets", reservers 0, the four remote reservations now EXPIRED,
10 orphaned remote-fleet creeps untracked (X3 FAIL), 4x hauler@100
runts (E5, micro-route minimums from a drained spawn), transient
scavenge at 202p (eating the dead remotes' piles). P5's structural FAIL
is the same signature (no banks stamp without targets). Colony
contracting to home-only at ~-20-40 e/t opportunity cost. The v5
assembly lens (graphSources/mined/transient/bank counts) is BUILT and
sits behind the batch-2 gate - the very next capture after its deploy
names the dropping layer. Attribution note: the first batch-2 gate red
(runt-economy) did not reproduce on rerun - draw variance or my own
mid-gate dist rebuild; the pending-affordable deferral fix stays on its
unit-proven merits and the clean gate (dist frozen) decides the deploy.

### 2026-07-19 (marathon, +143t) — ROADS PLACED; tick-rate correction; warmup reframe

t72421818, 143t after the one-way deploy (server at ~4s/tick tonight -
verification windows stretch 4x; the loop cadence in TICKS is what
matters, ~450t per 30min fire). CONFIRMED: core v6 live (siteProgress/
siteTotal/siteCount), partsLeft now truthful (controller 0.014 of a
drained budget - the dry-exit stamp working), and EIGHT ROAD SITES
standing (siteTotal 2400 = 8 x 300): the link completed and the roads
rung finally judged and placed a route. Home builder corps rebuilt
114 parts (runt self-heal worked). The 37->2 candidate collapse +
reservation "no-targets" + miners 7->2 is the DOCUMENTED post-reset
warmup remote-drop at +143t, not a regression - durable predictions
(builders march, P6 pump, relief-churn gone) wait for the settled
capture. OPEN (instrument next telemetry batch): stamp problem-assembly
counts (graph sources vs problem sources vs candidates) so the warmup
remote-drop mechanism itself gets named - it is the last recurring
invisible transition.

### 2026-07-19 (marathon) — one-way batch DEPLOYED on a fully green gate

Gate: trio green (flow-handoff 4m, runt-economy 12m, storage-depot 7s)
+ 4 cells pass (cons-link-core-first t60, concurrent t242 - identical
to baseline, deterministic; spawn-reserver-started-income t353,
def-t5-invader-reservation-defunds-remote t300). Deployed byte-verified
with the telemetry riders (dry-exit partsLeft stamp, v6 site progress).
The seven filed predictions (below) are checked by the next loop fires.

### 2026-07-19 (marathon, pre-deploy) — one-way reserver batch: predictions on file

Batch under gate (trio + 4 cells): reservers one-way (latch for life,
per-room demand coverage + wildcards), spawn-adjacency keep-clear
(tower/storage/link generators), vision-march for cross-room builders,
plus telemetry riders (partsLeft dry-exit stamp, v6 site progress,
ledger P6/P7/P8). Predicted post-deploy deltas, checked by the next
loop fires:

1. The four idle remote builders MARCH within ~50t (positions leave the
   Spawn1 cluster; by next capture in/near their corps' rooms).
2. P6: no zero-pump rooms while claim parts are fielded (W43N24/W44N23
   pump > 0 by the second post-deploy window).
3. Reserver relief-churn ceases: no reserver leaves a post; no
   back-to-back reserver purchases for already-assigned rooms.
4. placeAttempt stamps never name a spawn-adjacent tile for
   tower/storage/link.
5. Core segment reads v6 (siteProgress/siteTotal/siteCount); P8 row
   appears from the second v6 capture.
6. Flow sinks' partsLeft is monotone with fill order (no stale
   pre-pass values).
7. No other behavior movement: P4 <= 1.005x, util comparable; movement
   elsewhere = rollback signal.

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

### 2026-07-19 (marathon) — #19 mining-not-routed: production-first + storage-as-hub batch

Owner-caught (image): "miner + complete container, no haulers" at remote
sources. Root-caused from the live plan (t72425058/t72424537): 7 funded
mined sources = 70 e/t produced, ZERO mined-source haulers, only bank +
scavenge routes. The 555k bank surplus sits ON the home sinks (distance
~0), and the value fill was nearest-first, so it drained the bank to feed
the controller while the funded mined energy rotted at remote containers.
The leak had NO ledger line — it scattered across E2 (strands), E4 (idle
capital, −63/t) and P7 (0.59× controller). The fix, three interlocking
parts (owner reframed the design mid-cycle: "consumption takes from the
storage, so it IS a viable sink for remotes"):

1. **Production-first routing** (CorpPlanner routeToSinks): bank sources
   (`bank-` prefix) sort LAST in the per-sink fill, so real production
   fills every consumer before the warchest draw. This alone restores the
   mined-source haulers #19 was missing.
2. **Storage-as-hub** (flowAdapter): the storage sink STAYS open in a
   surplus room (was dropped whole) so remote surplus banks instead of
   rotting; its capacity is the bank's physical room-remaining. The
   anti-pump is now STRUCTURAL — bank sources are excluded from the storage
   sink (the bank IS the storage; withdraw-then-deposit is impossible by
   construction), replacing the old "drop the sink" hack.
3. **Storage-full defund** (selectProducers): the all-or-nothing rule —
   when total sink capacity cannot absorb the funded mining, whole corps
   are dropped (worst net-per-part first, keep ≥1), stamped `no-sink`.
   Naturally gated by (2): with a storage sink soaking `totalSupply` there
   is always room, so it fires only once storage tops out. NOTE: in the
   current model the surplus-controller is uncapped (`totalSupply`), so
   (2)/(3) stay DORMANT on plan-allocation until the controller gains a
   physical upgrade-spot bound (the owner's separately-flagged "upgrading
   is spot-capped") — that bound is the keystone follow-up (#21) and is NOT
   in this batch. What ships LIVE here is (1): #19's observed remote rot.

Verification metric added: **ledger P9** (mined-produced vs mined-routed).
On the #19 fixtures it reads 0.00 (7 src / 70 e/t, 0 routed) and LEADS the
ledger as the top line — the leak is now caught by `audit:ledger`, not by
an owner's eye. Predicted post-deploy deltas (checked next loop): mined-
source haulers APPEAR in the flow plan (P9 → ≥0.8×); E2 strands and E4
drain ease as the mined energy finds a home; P4 ≤ 1.005×, no other
movement (else rollback).

**DEPLOYED c88898f (2026-07-19, overnight run).** Gate green: unit 952,
build clean, trio (flow-handoff/runt-economy 12m/storage-depot) all 1
passing, 13/15 batch grid cells `[P]`. The two non-pass cells were
ATTRIBUTED against the pre-batch tree (76646e5, parent of roads-2, rebuilt):
`plan-t5-remote-pipeline` fails the SAME refill-SLA invariant pre-batch
(@1238) and post-batch (@1240) — pre-existing, tracked by #9, NOT this
batch. `haul-t4-feeder-fields-for-bank` is a boundary straddle: its relay
lands at t158–160 against a 160t window — pre-batch it passed @160 (the
last tick), on the batch build it passed 1/3 re-draws (@158) and timed out
2/3 (@160); tempo noise at a too-tight window, not a regression (the feeder
fields @107 and its regime activates @143 every draw). Pre-deploy live
baseline t72425884 (the "before" for verification): P9 0.20× (7 src / 70
e/t produced, 14.1 routed), E4 479k @ −44.5/t (already DRAINING,
feederActive true), E2 42 parts, P7 0.53×, P4 0.76×. Verification at the
next audit loop (~200 ticks) against these numbers.

**VERIFIED t72428914 (dt 3030) — partial success, net-positive, NO
rollback.** P9 0.20→**0.43×** (routed 14→30 e/t via 2→3 mined-source
haulers: the fix routes real production, directionally confirmed, but 4 of
7 sources still rot — consumer sinks total ~30 e/t and storage-as-hub is
DORMANT as predicted, so the residual 40 e/t has no plan sink → keystone
#21). P7 0.53→**1.41×** (actual controller 18.3 e/t — delivery recovered
hard). E4 still draining (−11.8/t, decelerating). P4 0.78× stable (the
plan now carries a budgeted `source-route haulers` line). The game score
(controller progress) IMPROVED — not a harmful regression. FALSIFIED
prediction (recorded per epistemic honesty): **E2 did NOT ease — it grew
42→82 parts** and is the new top line. E2 growth tracks P9's rise (more
remote haulers fielded to route the newly-funded production); with plan
flap P1=0 (stable plan) it is a plan-vs-actual accounting lag or a real
remote strand, not oscillation — the next cycle's work item (incident
#15). The residual P9 rot and E2 both point at the same root: mined
production still exceeds the plan's consumer sinks, so keystone #21
(cap surplus-controller → activate storage-as-hub soak) is the follow-up
that closes both.

**Deeper read of t72428914 (segment 6 + spawn meter) — the spend-path
hypothesis (needs a 2nd capture to confirm).** The plan sinks are
controller 12.99, **spawn 75**, storage 0 (storage-as-hub dormant). So the
plan DOES route all 70 e/t (spawn+controller demand 88 ≥ 70) — P9 rot is an
EXECUTION gap, not planning. Only 3 dedicated `source-` haulers exist; the
other 4 sources drop and 5 SCAVENGE haulers pick up (carry 7.9/12.8/12.9/
17.6) — so P9 (counts only `source-` haulers) OVER-reports rot: the energy
moves via drop-and-scavenge, not dedicated routes (a real inefficiency —
decay loss + hops — but not zero-routing). The live anomaly: spawn util
0.29 over 1070t, queueDepth 8, **eAvail 504** while **storage 444k** drains
only −11.8/t. The flow plan has NO `bank-` source and NO bank→spawn hauler,
so the 444k surplus is NOT drawn to fund the spawn's 75 e/t alloc; the only
storage outflow is the feeder's ~13/t controller relay (ControllerFeederCorp
clamps the relay to the PLAN's controller flow by design). Pre-deploy the
bank drained −44.5/t; post-deploy (part-1 sorts `bank-` LAST) −11.8/t.
HYPOTHESIS: part-1 correctly deprioritizes the bank, but real production
execution-lags (remote, dropping to scavenge), so the spawn under-fills and
idles at 504 while 444k sits idle — a spend-path throttle, possibly a part-1
interaction. COUNTER: controller delivery ROSE (P7 1.41) and the game score
climbs, so it may be a benign built-out near-equilibrium (low util is fine
when little is blocking). FALSIFYING 2nd capture (~200t): if eAvail stays
~500, queueDepth stays 8, storage barely drains, and P9 stays ~0.43 →
sustained spend-path starvation (fix the bank draw so it funds the spawn
when real production is short); if the queue drains / controller keeps
climbing → benign equilibrium. One hypothesis, next capture decides.

**ROLLED BACK to 76646e5 (pre-batch) — part-1 is a spawn-starvation
regression.** The 2nd capture t72429045 (dt 131) DECIDED it: eAvail stuck
504→504, queueDepth stuck 8→8, storage FLAT (444183→444258, +0.6/t — bank
draw is ~0), ctrlStock draining 1231→812, util falling 0.29→0.26. Not a
benign equilibrium — a sustained stall. The attribution is a clean A/B on
`bankHaul` (planned bank→sink haulers in flow seg 6): pre-deploy t72425884
had **2 bank haulers, eAvail 1186, util 0.86, queue 2** (bank feeding
sinks, spawn BUILDING — the owner's "great" humming state); post-deploy
**0 bank haulers, eAvail 504, util 0.26, queue 8** (bank draw killed, spawn
starved). Production-first (part-1) sorts `bank-` sources LAST, and the
stabilized plan then never commissions a bank hauler at all — so the 444k
surplus stops funding the spawn's 75 e/t alloc, which real production
(remote, dropping to scavenge) can't cover. The #19 rot fix was only
partial (P9 0.43) and cost the spend path; net-negative. Per the regression
rule, redeployed the known-good pre-batch bundle (restores 2 bank haulers /
util 0.86). NEXT: fix part-1 red-first — the bank must still FILL a sink's
deficit after real production (bank-last ≠ bank-never); reproduce the
"0 bank haulers when the spawn under-fills" shape in a routeToSinks unit
test, fix, re-gate, redeploy only when a mockup confirms the spawn stays
funded. The #19 batch (roads-2 + repair + part-2) rides with the part-1 fix
on the next deploy.

**MECHANISM CONFIRMED by faithful repro (`scripts/diag-bank-draw.ts`),
correcting the parts-exhaustion guess above.** The naive shape (7 mined +
home bank, no scavenge) does NOT reproduce — the planner correctly draws
the bank for the residual (18 e/t) and fills the spawn. It reproduces only
when the DROPPED energy of the un-hauled miners is added as co-located
SCAVENGE supply: then the spawn fills from mined 55 + scavenge 20, the
controller from mined+scavenge, and **bank draw → 0** (partsLeft 0.14, so
NOT budget exhaustion). Root: 7 miners are funded but only ~3 get dedicated
haulers; the other 4 drop, and the drop is re-counted as scavenge supply —
a DOUBLE-COUNT (miner rate + its own drop) that inflates apparent
production. Part-1's bank-last then makes the plan rely on that inflated
(and lossy: decay + slow scavenge) supply instead of the reliable home
bank, so the plan promises 88 e/t the execution delivers ~70 of → spawn
starves. Pre-deploy nearest-first drew the reliable home bank first, so the
plan was DELIVERABLE. The fix is doctrine-level (kill the drop/scavenge
double-count, and/or make the bank a reliability backstop for the spawn,
and/or the #21 controller cap so mined surplus has a real storage home
instead of dropping) — overlaps the owner-flagged #21, so it is DEFERRED to
owner review, not deployed autonomously overnight. The colony runs the
known-good rollback in the meantime.

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
