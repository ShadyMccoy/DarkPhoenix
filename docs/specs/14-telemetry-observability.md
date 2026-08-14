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

### 2026-07-22 t72508624 (scheduled cycle) — the P4 FAIL was the LEDGER, not the plan: drift eliminated at the root (owner directive)

Cycle opened on P4 1.01x FAIL (spawn-infeasible) with the colony
otherwise HEALTHY: P7 1.11x (delivery ABOVE plan - the upgrader fleet
finally ramped, 3 creeps / 60 WORK), E4 draining, X1 recovered, P2
3/10 (A/Z holding). A FAIL with a healthy colony is a ledger-accuracy
smell.

Root cause (read, not inferred): the waste ledger's P4 RE-DERIVED
hauler spawn-load as `2*carryParts/effectiveLife` - a second copy of
the planner's `((paved?1.5:2)*carryPartsFor(take,dEff))/effectiveLife`.
The 2x hardcoded the UNPAVED (1:1) body for EVERY route, so this
paved-remote colony (7 trunks, all 2:1 bodies measured in seg 4)
over-counted its hauler load: 0.144 parts/t where the paved-aware
number is 0.111. That 0.033 over-count IS the 1.01x-vs-0.90x gap. The
plan was never infeasible (spawn util 0.91); the LEDGER was wrong.

Fix (owner directive: "eliminate the ledger vs planner drift at the
root by having them share the same code"): don't re-derive - ECHO the
planner's own number. CorpPlanner already computes spawnParts per
CommissionedHauler; threaded it through HaulerAssignment (flowAdapter +
haulerAssignmentFromCommissioned both set it, solver-bridge pin) and
exported on segment 6 (v8). waste-ledger P4 now reads h.spawnParts;
legacy captures without it fall back to the 2x recompute. Pinned with
a sentinel-echo test (only an echo, never a recompute, yields the
sentinel). This is decision symmetry made structural - the ledger can
no longer drift because it reads the planner's output, not a copy of
its formula.

Shipped WITH the origin/master merge (5 commits: builders latch-sweep
#125, empirical road-scoring #120, tower peace-time repair #122, tower
focus-fire #119, docs #123). Full gate green on the merged build (unit
1332, flow-handoff + runt-economy + storage-depot).

VERIFIED t72508624 (post-deploy): segment 6 v8 exports spawnParts on
10/10 haulers; P4 1.01x FAIL -> 0.90x WARN (feasible); NO FAIL lines;
no regression from master's changes (P7 0.92x, P2 2/10, P9 1.0x, E4
draining). The false infeasibility is retired.

Cycle verdict: FIXED (ledger-accuracy leak eliminated at the root;
verified live). The colony's actual progress is healthy - this cycle
corrected the INSTRUMENT that was crying wolf, which is itself waste
elimination (a false FAIL costs a cycle chasing a phantom every time
it fires).

### 2026-07-22 t72505602 (scheduled cycle) — DIAGNOSIS: top-line WARNs are a road-build spike; the upgrader "ramp" was preempted by construction (prior verification was premature)

No FAIL lines. Three WARNs (P4 0.90x, E4 127k draining, P2 34/44
micro-routes) - and all three trace to ONE dynamic: the W42N23 trunk
(un-stalled by last cycle's tanker fix) placed ~30 road sites at once.

Measured, not inferred:
- **P2/P4 are a transient spike, not a leak.** Construction sinks
  jumped 1-4 (steady, all prior captures) -> 30 this window; source
  cedc pours into its local road cluster (spec-25 emergent dedication,
  by design), emitting 20 micro hauler-edges (one per site). 26 of the
  44 hauler edges go to construction sinks (31 of 173 source-route
  parts, ~18%); strip them and P4 is 0.84x (ok). They never
  materialize (cedc CarryCorp = 0 creeps - construction is crew-served
  via pile-fed rung + pool tankers); P4 counts them as its only proxy
  for construction-delivery cost, so 0.90x is honest and feasible
  (<1.0). CPU 79/t (bucket full), spawn 0.875 util. P8 already shows
  it draining (remote 37 -> 30). Self-resolves when the trunk paves.
- **The real progress signal - upgrader fleet stuck at 2/6 - is
  construction preemption, doctrine-correct.** Fleet 3 (t72504060) ->
  2 (t72504737) -> 2 (t72505602); controller stock BACKING UP
  430->592->752 (feeder relays 106 e/t link-fed, 2 upgraders at 40
  WORK / workUtil 0.96 consume ~34, the rest piles). The upgrader is
  ranked LAST (agenda position 7, gate "queued", why "campaign"):
  construction (sink 70) + income + guard campaign all outrank
  controller (<=50). 4 of 8 recent receipts are construction/infra.
  This is the sink ladder + owner doctrine ("building takes priority
  ... an investment in our future upgrading abilities") working as
  intended - burn the warchest on ROADS first, upgrade after.

**Correction to the t72504146 cycle's verdict (honesty):** that cycle
declared the holdToFund upgrader fix "VERIFIED, all predictions
landed" on a 591t window showing fleet 2->3 and an upgrader@2300
receipt. That was PREMATURE. The fix's own downstream effect (the
tanker fix un-stalled construction) then placed a big road build that
preempted the upgrader ramp; the fleet decayed back to 2. The
holdToFund wall is real but WEAK at last-rank: the walk buys the
top-ranked affordable demand and rarely reaches a last-ranked
consumer, so the wall holds energy against nothing below it. The fix
is not wrong (a surplus consumer SHOULD be able to fund), it is
INSUFFICIENT to grow the fleet against construction preemption - and
one 591t verification window could not see the decay.

Cycle verdict: DIAGNOSIS (blocker named with data; prior conclusion
corrected). No code change - the upgrader stall is doctrine-correct
construction-preemption during a transient road build, and a
spawn-priority patch would (a) be a second patch on upgrader funding
in two cycles - the trap-list "mechanism is the bug" warning - and (b)
fight the explicit build>upgrade doctrine. The disciplined move is to
let the trunk complete and re-measure, not to guess twice.

FALSIFICATION for the next cycle (design the capture): after the
W42N23 trunk paves (roadReceipts cedc built -> total, remoteSites
drop, construction sinks return to 1-4), predict the upgrader fleet
ramps 2 -> toward 6 and controller stock stops rising. If it DOES,
transient-preemption confirmed (no fix needed; the holdToFund wall
suffices once construction clears). If the fleet STAYS at 2 with
construction light, THAT is the standing ranking bug - fix it then,
red-first, with the preemption ruled out.

### 2026-07-22 t72504146 (scheduled cycle) — P8 named the trunk stall; the pool's fuel never crossed rooms: tanker delivery was same-room-blind

First cycle with the remote-aware P8 (previous cycle's instrument):
TOP LINE P8 FAIL - remote 3->3 sites, progress 0, receipts frozen
51/53, plan alloc 20 e/t, "CREW IDLE". The cd8d trunk's last 2 tiles
(W43N24:36,28 + 36,29, sites STANDING) have been frozen 3,300+ ticks;
the 07-21 handoff shows the same 2-tiles-short freeze on cd8e a day
earlier. Elsewhere the previous fix holds: P7 1.24x (57.0 e/t actual),
E4 -36.6/t and draining, upgrader ramp continuing.

Diagnosis (live reads, three instruments deep):
- Room objects API (ground truth): the 3 sites are PARTIALLY built -
  36,29 at 134/300, container 37,38 at 770/5000. Someone built ~13
  fed-ticks' worth, once. The W43N24 rung builder (4-part, pile-fed)
  works its container at ~10 e/t; the trunk tiles sit mid-route,
  outside pile reach - they are the POOL crew's job by design
  (t72473701 ruling: pool tankers ferry bank energy to them).
- Live creep positions: the ENTIRE pool convoy (3 tankers, ~800
  energy each, `working:true`) parked/converging in the HOME room.
- Creep memory (the decisive stamp): all three tankers' _move.dest =
  the wander position of the home corp's ONE builder - which is
  `repairDetail: true`. The colony's only other 4-part builder
  (W44N23's) is ALSO a repair detail. ZERO non-detail builders stood
  anywhere; the fielded pool builder generation that produced 134/300
  died dry at the site.

Mechanism: runTanker's delivery pick was
`creep.pos.findClosestByRange(builders)` - a SAME-ROOM-ONLY operation.
The t72473701 fix made the tanker DEMAND gate pool-aware and its
comment claimed "runTanker already shuttles cross-room ... only the
gate was home-only" - false for the delivery half. A pool builder in
the head room was invisible to the pick, so tankers delivered to (and
staged on) the only same-room member: the self-fueling repair detail.
The pool builder burns its own 50 carry at the trunk, stands dry,
ages out; the next builder purchase becomes the detail's replacement;
repeat. Two trunks froze 2-tiles-short this way.

Fix (live-behavior, red-first: test/unit/corps/poolTankerDelivery
.test.ts, 5 pins): tanker delivery and staging target the POOL CREW
only (repairDetail excluded - it self-fuels by design); nearest
same-room crew wins as before, and with NO local crew the tanker
marches at the cross-room builder (moveTo paths between rooms;
transfer connects on arrival).

Side findings (named, not fixed - one mechanism per cycle):
- cd8e receipt `paved:true` at built 36/38: suspect the line-1352
  paved stamp reads roadTilesBuilt(room, entry.tiles) - a single-room
  tile lens - while built/total count the cross-room tiles3. A route
  marked paved early loses its blind-receipt backstop. HYPOTHESIS -
  falsify next cycle by diffing entry.tiles vs tiles3 room sets.
- W44N23 rung: placeAttempt container@33,29 -> placeResult -7
  (ERR_INVALID_TARGET) repeating across captures. Its builder
  purchases turn out to be the legitimate repair detail, but the
  placement retry loop wants a look once the trunk moves.

Predictions for post-deploy verification (~200+ ticks):
1. Tankers' _move.dest switches to W43N24 (the pool builder / trunk
   tiles) within one demand cycle of a pool builder fielding.
2. roadReceipts cd8d built 51 -> 53 and the two road sites complete;
   remoteSites count drops as the container follows.
3. P8 flips FAIL -> ok (progress > 0 via receipts delta) once a pool
   builder + fed tanker overlap a window.
4. No hauling regression (P9 stays 1.0x; the tankers still draw from
   the surplus bank, not source containers).

**VERIFIED t72504737 (591t post-deploy window): all four landed.**
(1) THREE tankers (72503310/72504052/72504490, all with real cargo
282/734/749) physically in W43N24 clustered at (36-37,31-32) beside
the two pool builders working the container - the exact cross-room
delivery that was impossible before. (2) cd8d built 51 -> 52 AND
paved:true; remoteSites W43N24 3 -> 1 (the two road sites completed,
container remains). (3) **P8 FAIL -> ok, 0.51 e/t built** (the
container advanced 770 -> 2966 / 5000, ~3.7 e/t on that site alone).
(4) P9 1.0x (70/70 routed), E4 draining -47.8/t (bank 168k -> 140k),
no runts, X1 clean. The colony immediately placed the NEXT trunk
(W42N23, ~36 fresh road sites at 0/300) - the pipeline that was
frozen two generations is moving again.

Cycle verdict: FIXED and VERIFIED (mechanism proven from three live
instruments, red-first tested, all predictions confirmed in prod).
The remote-aware P8 shipped last cycle paid for itself immediately -
it was the top line that named a stall the home-only meter had hidden
for two trunk generations.

Grid attribution: plan-t5-remote-pipeline stays [T] pre/post (its
failing assertions are reserver-dispatch + container-site placement,
upstream of tanker delivery) - baseline-red for its own reasons, not
moved by this fix.

### 2026-07-22 t72503018 (scheduled cycle) — the "ramp" was a STALL: scaling upgraders can't fund; holdToFund honored for consumers

The two prior cycles filed P7 under "ramp mid-flight; watch upgraders
3-6 field". This capture (2,171t after the last) falsifies that story:
staffing 2/6 UNCHANGED across the whole window (WORK 37 -> 39, i.e.
replacements only), E4 idle capital 191k at 6.9x target with slope
+0.28/t (flat - the drain stopped), P7 21.9 vs 56.5 e/t (0.39x) with
controllerStock STANDING at ~630 and workUtil 0.995. The energy is
there, the standing fleet burns flat out, and the fleet does not grow.

Mechanism (read from stamps + agenda + the walk, not inferred):

- The corp demands correctly: sizing stamp allocated 110.5 (surplus
  regime), targetCount 6, demandMin 2300 - a SCALING demand: blocking
  false, replacement false, producesIncome false, min == desired ==
  2300 == energyCapacity (runt policy: indivisible).
- The walk gives such a demand no wall: `fundableIncome` honors
  holdToFund/starvation for INCOME only; a passed consumer lets every
  cheaper demand below it buy at partial fill ("afford-min-scaled"),
  so the bank NEVER accumulates to 2300 while any cheap demand exists.
  Its own clock resets on every buy (resetDemandClock), so each
  purchase re-pays the full 300-600t starvation race.
- Arithmetic closes: wins come only from lulls with an already-full
  bank; measured cadence ~2-3 buys/2200t = replacement rate of a
  2-creep fleet at 1500 life. The stall IS the equilibrium.
- Agenda receipts confirm: upgrader queued age 222-1353 in every
  capture today while builder@300/tanker@1100/reserver@1300 executed
  around it (t72502920/932/998).

Fix (live-behavior, full gate green - unit 1248 + trio): the walk now
honors a DECLARED holdToFund for consumers too (`fundableConsumer`),
and UpgradingCorp declares it from the same surplus lens that scaled
the fleet up (upgraderSizing now exports its `surplus` verdict; stamp
gains `hold: true`). One lens, two readers. Cold start unchanged: no
surplus -> no declaration -> the energy-led "starved consumers lift
but never hold" pin stands as-is. Consumer walls stay non-strict (a
lower affordable income producer still buys through) and the infra
lane still pierces, so neither W2N6 nor t72499165 can recur by this
path. Side effect (intended): ClaimCorp's claimer, which has declared
holdToFund all along, now actually walls - its declaration was
silently ignored.

Also this cycle: P8's standing-sites predicate was HOME-ONLY - the
stalled W43N24 trunk (3 remote sites standing 2,171t, receipts frozen
36/38, funded ~20 e/t, 5-creep crew) read "ok / no sites standing".
remoteSites now joins standing/completion; the re-run ledger FAILs P8
on this exact window. That stall is the NEXT cycle's candidate work
item (do not fix blind: why is a staffed, funded trunk crew building
nothing? placeAttempt stamps show container placement OK at
t72501320).

Predictions for post-deploy verification (~200+ ticks):
1. upgrade sizing stamp shows `hold: true`; agenda upgrader entry
   mustFund=true, gate "wall" when reached-unaffordable.
2. Upgrader staffing 2 -> 3+ (first walled purchase within ~500t of a
   quiet spawn window); receipts show upgrader@2300 buys.
3. P7 actual rises from 21.9 toward 39+ as bodies land (full 56.5+
   needs the ramp to finish; direction is the check, not the endpoint).
4. E4 slope goes NEGATIVE once standing WORK exceeds ~110 relay
   (fleet 5-6); early window: burn visibly above 39.
5. No income regression: miners/haulers/reservers still in receipts;
   S3 clean; no starved income demands behind upgrader walls.

Cycle verdict: FIXED (mechanism proven from decision stamps; fix
red-first tested; instrument extended). The prior cycles' "observe"
verdicts were the correct call with the data they had - the ramp DID
move 0 -> 1 -> 2 - but the growth phase was always going to freeze at
the replacement equilibrium; it took a 2,171-tick window to see it.

**VERIFIED t72504060 (~600t post-deploy, 220t clean window): every
prediction landed.** (1) sizing stamp `hold: true`, agenda upgrader
mustFund=true/campaign, fundingNeed 3600. (2) **upgrader@2300 receipt
at t72503938** - the first walled scaling purchase; fleet 2 -> 3
creeps, 39 -> 60 WORK. (3) P7 actual 40.7 e/t (was 21.9), comparator
1.0x. (4) E4 slope **-24.41/t** (was +0.28); storage 191.2k ->
171.5k, FAIL -> WARN. (5) income untouched: haulers @907/@1277 full
bodies, E5 runts 0/8, P9 routes 1.00x, P4 0.84x ceiling, S3 clean.
No FAIL lines on the verification ledger.

Watch next cycle: X1 WARN (60 WORK standing, workUtil 0.81, dry 0.19
- the feeder relay catching up to the burst fleet; relay target 115 >
60 standing, should clear as the chain re-sizes); the ramp 3 -> 6
continuing at wall cadence; and the P8 trunk stall (W43N24 3 sites,
receipts frozen 36/38) - now reading CREW IDLE with plan alloc 0.0,
i.e. an UNFUNDED standing crew, the next cycle's candidate work item.

Grid attribution (parallel work this cycle): haul-t4-bank-surplus-
upgrades (green, the changed regime) PASSES post-change; exp-t5 [T]
and haul-t4-tender-bus-regime [T] IDENTICAL pre/post-change source
(attribution runs) - both acquitted of this change; note tender-bus
now presents as timeout where the baseline recorded "fail"
(pre-existing drift, re-label at the next full-grid ratchet).

### 2026-07-22 t72500847 (scheduled cycle) — ramp mid-flight: upgrader WORK 17 -> 37, income queue drained to the far remotes

P7 FAIL 0.38x (23.8 vs plan 61.9) is the RAMP measured honestly, not
breakage: 2/6 upgraders fielded, 37 WORK standing at 0.981 util (the
window average trails a fleet that doubled mid-window), and the spawn
receipts show the recovery queue draining production-first - the far
remotes cbd5 + cedc got their miners back this window (@650 each),
LAST in line exactly as the macro doctrine orders. E4 -9.28/t;
reservation depth the day's best (banks 350-664, P6 2002t/474t);
routes 70/70; fleet 34; S3's AFFORDABLE+IDLE head is the known
capture-timing artifact (gate "buy", bought t72500830 vs capture
t72500847). P2 7/13 micro-routes: new small routes from the deepened
reservations - informational.

Cycle verdict: observe; the P7 gap closes as upgraders 3-6 field
behind the now-drained income queue. Watch next cycle: upgrader count
toward 6, P7 toward 1x, E4 slope steepening.

### 2026-07-22 t72500407 (scheduled cycle) — ALL GREEN under the re-land: fleet 33, tender 3/3, endFill 0.444 and climbing

No FAIL lines, ~700 ticks after the previous cycle:

- Census 18 -> 33 (32/33 tracked) - the post-incident re-field is
  essentially complete, the day's largest fleet.
- Tender fleet 3/3 STAFFED (45p, duty 0.186 - inside the ratchet's
  measured band); feeder 16p active; endFill 0.088 -> 0.262 -> 0.444.
  The re-landed covered lens is running with a live apparatus - no
  fan symptoms.
- Reservers fully staffed for the first time today: all four remote
  banks pumping (P6 658t/645t; W42N22:190 W42N23:268 W43N24:116
  W44N23:84).
- X1 workUtil 0.99 on the re-fielded upgrader (17W); P7 14.0 vs 25.0
  mid-ramp (plan wants 108p of upgrader WORK - the ramp continues).
- E4 bank 194.6k draining; P9 routes 70/70; S3 clean (util 0.71,
  spawn busy building).

Cycle verdict: VERIFIED, observe only. The incident arc is closed:
collapse -> rollback -> root cause -> emergency-gated lane -> re-land
-> full recovery, all measured. Watch next: upgrader fleet toward the
plan's 108p, E4 slope, the 4-37 strand clearing (EOL), and the first
LIVE dark-post pierce whenever a tender generation turns over.

### 2026-07-22 t72499712 (scheduled cycle) — RECOVERY VERIFIED; re-land live; S3 top-line was a capture-timing artifact

~1,700 ticks after the rollback, ~an hour after the re-land deploy:

- Census 4 -> 9 -> 18 (17/18 tracked). Executed receipts show the full
  re-field: miners cd8d/cd90/cd92, hauler@1242, TENDER@1600,
  FEEDER@800, guard@650 - eight buys in 270 ticks. The refill
  apparatus stands again; feederActive TRUE.
- E4 slope -14.67/t (bank 200k draining hard), P9 routes 70/70, E2
  zero strands, E5 down to one recovery-era runt. P6 reservation
  pumping resumed (W42N22: 241t banked). Upgraders queued next behind
  the guard (2300 body) - P7 reads 0/0 while the plan's controller
  allocation rebuilds post-collapse.
- The flagged S3 "stall" (head guard@390 AFFORDABLE+IDLE) is a FALSE
  POSITIVE: the head's recorded gate is "buy" and the receipt shows
  guard@650 bought at t72499711 - the tick BEFORE the capture. S3
  compared head-vs-bank one tick after its own buy. Ledger polish
  queued (telemetry-only): S3 should discount a head that appears in
  executed[] within its staleness window.

Cycle verdict: RECOVERY VERIFIED (rollback + fan-fill bridge worked
exactly as predicted; the emergency-gated lane + bundles 2-4 are live
for the next dark-post event to prove). Watch next: upgrader fleet
re-ramping, E4 continuing down, zero extension-fan receipts under the
re-landed covered lens, no pierce anomalies in receipts.

### 2026-07-22 — INFRASTRUCTURE LANE (owner: option "a only") + re-land of bundles 2-4

MECHANISM, fully named (from the walk's own code): three individually
correct rules interlocked - (1) the anti-starvation age boost ranked
the 4,400-tick-starved miner ABOVE the tender's 150; (2) its
unaffordable mustFund body WALLED the spawn (bank saves toward 650);
(3) the strict hold (the W2N6 fix: decline EVERY lower spend while
holding) blocked the affordable 200-energy tender - the only body
that could refill the bank the wall was waiting on.

FIX (owner ruling, option a): SpawnDemand.infrastructure - the refill
apparatus buys THROUGH holds and walls, at both hold paths (the
zero-income holdForBlocking gate and the income-flowing outcome=null
wall). A real buy is never displaced - only holds are pierced.

LESSON INSIDE THE FIX (trio-caught, first gate run): the UNCONDITIONAL
flag recreated the W2N6 stream in the cold start - the tender fleet's
top-ups pierced the first-hauler wall THREE times (exec tanker@310/
369/419, the blocking hauler delayed 353 -> 498, hand-off probe red).
"Staffing-gated" was not stream-proof at fleet target 3. The lane is
now EXACTLY as narrow as the emergency it fixes: the corps declare
infrastructure only on a DARK post with STRANDED STOCK (the tender's
bootstrap condition verbatim; feeder: zero feeders + bank >= 10k).
Cold starts have no stranded stock, so they keep their old ordering
to the tick. One dark-post body per outage; top-ups wait like
everyone else. Pins: the incident shape pierces (both income paths);
top-ups and dry-depot dark posts never pierce; below-wall non-infra
stays held; unaffordable infra does not pierce; a higher-ranked
affordable demand still wins its tick.

RECOVERY (t72499395, ~230t after rollback): creeps 4 -> 9, spawn util
0.06 -> 0.20, endFill 0.088 -> 0.262, the 650 wall GONE from the
agenda head (fan-fill bridge funded it) - bundle 1's fallback broke
the deadlock exactly as predicted. Tender still 0/3 (income re-field
first - the bundle-1 ordering the lane now fixes).

RE-LAND: with the lane green through the full gate, HEAD (bundles
2-4: covered lens, off-road parking, builder hand-off) redeploys -
the deadlock class that killed the covered-lens deploy is closed at
the scheduler, the layer that owns it.

### 2026-07-22 t72499165 — INCIDENT: colony collapse 23 -> 4 creeps; spawn WALLED 4,400 ticks; ROLLED BACK to bundle 1 (80ca334)

**DEPLOYED BUILD IS NOW 80ca334's bundle (bundle 1).** Branch HEAD
(515de7a) carries bundles 2-4 (fan-fill retirement / covered lens,
off-road parking, builder hand-off) which are LIVE-SUSPENDED pending
the deadlock fix below. Do NOT redeploy HEAD until it lands.

THE MECHANISM (all from the capture, corps running, no crash):

1. The post-incident fleet was born in one burst (~t72490400-91000),
   so it DIES in bursts - a cohort effect. Around t72494797 a die-off
   wave included both tenders (TTL, born of the bootstrap era).
2. The re-field wave jammed the spawn agenda: 8 entries, ALL mustFund
   new-units for the income economy, head = miner@650
   (mining-W44N23-harvest-cbd5), precondition bank>=650, gate:"wall" -
   a funding wall that holds every lower spend (the W2N6 semantics,
   via the NOW-plan lane).
3. Extensions stood at 387/2300: zero tenders alive, and bundle 2 had
   RETIRED the hauler fan-fill fallback - the exact mechanism whose
   old comment read "so a dead tender can never deadlock the colony".
4. The tender corp's own stamp: gate "demand", staffing 0, target 3,
   hasMiner true - the demand FIRED but never reached the spawn: the
   agenda queue (capped at 8) held only mustFund walls. The bootstrap
   value 150 wins the DEMAND walk, but the mustFund lane bypasses
   value ordering. The bank could not reach 650 without a tender; no
   tender could field behind the wall. Deadlock, 4,400 ticks: spawn
   util 0.06, endFill 0.088, every replacement starved, fleet aged
   out to 4 creeps. E5 shows two hauler@100 drained-spawn runts as
   the spawn's only purchases.

ATTRIBUTION: bundles 3/4 (parking, hand-off) touch no spawn path and
are likely innocent bystanders; the lethal pair is bundle 2's
fallback retirement meeting the agenda's mustFund wall during a
cohort die-off. The bootstrap's value-150 reasoning (bundle 1) was
verified in the DEMAND lane and missed the wall lane entirely. The
t72492179 all-green capture ran the covered lens safely only because
tenders were alive.

ACTION: emergency rollback src -> 80ca334 (bundle 1: fan-fill
fallback intact as the deadlock breaker; keeps bootstrap 150, feeder
body-from-actuals, EOL recycle), build + deploy executed. Expected
recovery: haulers fan-fill + degraded-reload from the 208k storage ->
bank climbs past 650 -> wall funds -> re-field cascade -> tender
bootstrap fields -> normal regime. Verify next capture: creep census
rising, endFill recovering, wall head cleared.

THE REAL FIX (design before re-landing bundles 2-4, owner decision):
the refill apparatus must be un-starvable by the wall lane. Options:
(a) an INFRASTRUCTURE LANE in the agenda - tender/feeder demands ride
above mustFund walls (they multiply all later spawn capacity);
(b) walls DOWNSCALE when starved (afford-min-scaled for mustFund
heads - a 650 miner wall at a 387 ceiling buys a smaller miner);
(c) a BOUNDED deadlock-breaker: haulers bridge extensions ONLY while
no tender lives AND the spawn is wall-starved (energyAvailable below
the wall head's cost) - preserves the accountability doctrine in all
normal operation, reinstates the survival valve for exactly this
alignment. Recommendation: (c) now + (a) as the doctrine fix.

### 2026-07-22 (owner orders, bundles 3+4) — OFF-ROAD PARKING for standing workers; BUILDER HAND-OFF (release + adopt)

BUNDLE 3, off-road parking (owner: "Id love to see the 'avoiding roads'
mechanic for stationary workers like these upgraders and tankers"):

- controllerParkingTiles sorts OFF-ROAD FIRST (road ring tiles are the
  delivery lanes; avoidance dominates closest-first - every ring tile
  is already in upgrade range, so distance was comfort, not function).
  Road tiles remain last-resort capacity (ring count unchanged, so the
  parking-tiles sizing cap is untouched).
- One-time HOP: an upgrader cached on a road spot re-parks when a free
  off-road slot exists (assignment prefers off-road; the new cache is
  off-road so it never fires again - no shuffle, only untaken slots).
- stepOffRoad (movement.ts): an idle creep ON a road steps to an
  adjacent tile keeping its work range - never a wall/road/structure
  (containers are somebody's post: harvest spots, the input, the
  depot), never occupied, plain before swamp, stay put when nothing
  legal. Wired at the tanker's two idle posts (staging beside the
  builders; waiting at the source). Costs one look when off-road.

BUNDLE 4, builder hand-off (owner: "one is arriving, one is leaving. I
think it's re-assigning them or something"; ruling: "they could orphan
and adopt creeps if necessary"):

- DIAGNOSIS (measured, 3 captures): NOT re-assignment - sequential
  fresh purchases. The remote container/road corps each bought a fresh
  4-part builder for their stint (W42N23 -> W43N24 -> W42N22) while
  the finished room's builder idled to TTL death; NO retirement path
  existed (the code comment literally says "their builders age out").
  All five corps persist across captures - commissions never vanished,
  so orphan-rescue never engaged. The crossing builders the owner saw
  were one room's dying stint and the next room's fresh buy.
- FIX: release + adopt through the existing orphan machinery. Release:
  a corp fielding more builders than its demand lens stashed
  (lastWantedBuilders, written by getSpawnDemand at every path -
  staffsPost symmetry, serialized) sets the extras' corpId to a
  non-live marker (rescue SKIPS creeps with NO corpId, so deletion
  would strand them); keeps the repair detail, then freshest bodies.
  Adopt: constructionKind.claimsOrphan routes build orphans to the
  NEAREST corp whose wantsAnotherBuilder() probe says yes. No taker ->
  the ordinary 25t grace -> recycle refund (strictly better than
  aging out: the body energy comes home).
- DEPLOY-BOUNDARY GUARD (caught by the pool-march pin pre-ship):
  unknown want (fresh corp / pre-hand-off memory) is NULL, never 0 -
  treating it as 0 would have released every builder colony-wide on
  the first post-deploy tick.
- En-route road repair (bundle 2) already covers the owner's "dump
  that energy into roads as they walk" - a full-hits road just takes
  nothing.

PREDICTIONS (before deploy, verify next captures): (1) remote-stint
transitions stop buying fresh 4p bodies - the standing builder walks
corp to corp (E2 strand list stays clean, builder spawn receipts drop);
(2) upgrader ring occupancy shifts off the road spur (owner-visible;
X1/P7 must NOT regress); (3) tanker idle posts clear the lanes; (4) no
mass-release event at the deploy boundary (creep census stable through
the global reset).

### 2026-07-22 t72492179 (scheduled cycle) — ALL GREEN: bank slope flipped NEGATIVE, ramp confirmed mid-flight, every bundle prediction now stamped

No FAIL lines. The re-field-ramp thesis from last cycle is confirmed
by every instrument:

- E4 downgraded FAIL->WARN, slope +14.94 -> **-6.93/t** (bank 180,431
  and draining). The consumer machinery is winning; at the current
  38/55 standing WORK the drain accelerates as the fleet tops out
  (targetCount 6, 2 standing, allocated 110.4).
- P7 0.54 -> 0.77 (17.7 vs 23 e/t), X1 workUtil 0.958 on 38 standing
  WORK (dry 0.042) - upgraders busy, supply line keeping up.
- Feeder stamp back and exactly as designed: linkFed, relay 110,
  standingWork 38 -> bodyRate 57 -> **neededCarry 3** (the parked
  model live); gate staffed on the 4-part body.
- Tenders 2/3 (third queued at gate demand), duty 0.126 - in the
  measured band. Spawn endFill **0.727** (incident: 0.41), util 0.86,
  queue 8.
- Reservers RETURNED to the plan (12p claim-life; P5 ok at 0.50 duty,
  gate reading reservation banks - last cycle's "dropped" line was
  plan-tick timing, not a regression). P8 +14,400e of remote road
  receipts in 931t (~48 tiles paved this window). P9 routes 70/70.
- The E2 strands from the incident era (hauler-g-4-37 among them) are
  GONE - EOL recycle/expiry cleaned them; one 6p strand remains
  (W42N22). cbd5 funded and routed throughout the crippled-invader
  window - no death-gap materialized; the invader TTL'd out.

Cycle verdict: VERIFIED, no change shipped (observe cycle). Watch
next: fleet 3-6 of the upgrader ramp standing, E4 drain rate rising
toward the ~100 e/t burn the valve allows, the third tender fielding.

### 2026-07-22 t72491248 (scheduled cycle) — VERIFIED: tender incident closed, feeder 4 parts, fan-fill retired live; E4 = consumer re-field ramp

Verification capture 923t after the incident baseline (both bundles
live ~2700+ ticks). Predictions vs reads:

1. TENDER RE-FIELDED ✓: 2 tenders / 29 parts (was 0 at t72490325);
   the refill death spiral is closed - E5 runts 0/8, S3 clean, spawn
   util 0.58 with queue depth 8 (busy, not stalled).
2. FEEDER SHRUNK ✓ (beyond prediction): 2C2M = 4 parts, vs 22 two
   days ago and ~6 predicted - the parked-cycle model + a bodyRate
   below 60 at purchase time. P7 confirms the feeder is NOT the
   constraint: input stock STOOD 716->796 while upgraders under-burned.
3. FAN-FILL RETIRED ✓ (mechanism grid-proven; live receipt check
   pending a memory-bearing capture): no fan symptoms - P9 routes
   70.0/70.0 e/t of funded mining, zero runt purchases.
4. endFill/idle: spawn util 0.58 and 8-deep queue vs the incident's
   idle spiral; the sized meters (endFill stamp) missed this capture
   (post-reset lastSizing not yet re-stamped - two global resets from
   the two deploys), re-read next cycle.
5. Road-repair delta: no P8 window (no sites standing); unverifiable
   this capture, watch next.

LEDGER: E4 FAIL is the standing top line - 186,880 banked (target
27,650), slope +14.94/t, feederActive TRUE. DIAGNOSIS (from stamps,
not vibes): this is the CONSUMER RE-FIELD RAMP, not a broken spend
path - at t72490325 the upgrader corp already stamped targetCount 6,
allocated 110.5 e/t, demandMin 2300, staffing 1; its one creep has
since died (census 0 alive, agenda head = the replacement holding for
a full-size bank at 1142/2300 behind the re-field queue). Burn 12.5
e/t of plan-23 lower endpoint (P7 WARN) is one part-fleet's output.
The machinery is correct and queued; tight assertions belong on
actual-vs-NOW, and the NOW queue is draining. NO new live change this
cycle (owner wrap-up directive) - the upgrader scale-up seam (parking
8, cap 2300, target 6, spawn parts/tick budget) is tomorrow's
first-principles item beside the remodel (spec 27).

Cycle verdict: VERIFIED (all deployable predictions confirmed or
mechanically explained) + E4 named with data (re-field ramp; watch
next cycle for the 6-upgrader fleet standing and the bank slope
flipping negative).

### 2026-07-22 (owner rulings, bundle 2) — FAN-FILL RETIRED (accountability doctrine); feeder is a PARKED post; builder en-route road repair

Three owner rulings landed as one gated bundle (unit 1219 + build +
trio, deploy chained on green):

- FAN-FILL RETIRED ("each corp needs to do their job, not cover for
  each other ... they could orphan and adopt creeps if necessary"):
  the hauler fallback that resumed extension-fanning whenever the
  tender died is gone. New STRUCTURAL flag
  `extensionTenderCovered` (depot + extensions exist, stamped by the
  tender corp) read through ONE lens (`tenderOwnsExtensions`) at all
  four CarryCorp sites; the old ACTIVE flag keyed the regime to CREEP
  LIVENESS - exactly the flappy signal class the trap list bans. In a
  covered room haulers bus source -> spawn structure + depot,
  permanently; a dead tender is the tender corp's own problem - its
  bootstrap re-fields one. Bootstrap widened from storage>10k to ANY
  depot stock >= 300 (with no hauler bridge, stranded container stock
  is the same emergency). Grid death cell converted to the new
  doctrine and TIGHTENED (its refill assertion had latched vacuously
  at tick 1, pre-drain): measured kill t15 -> ACTIVE clears t17
  (COVERED holds) -> replacement tender alive t56 -> burst extensions
  refilled t66. Self-recovery ~50t, zero hauler cover. Intent receipt
  added (`lastDeliver: "extension-fan"` on any hauler extension fill)
  after the bus-regime cell's spatial linger guard false-positived on
  transit congestion - cells now assert the receipt, not geometry.
- FEEDER = PARKED POST (owner: "The feeder doesn't move at all. it's
  adjacent to the storage and the link both"): the link-fed body was
  still sized by carryPartsFor(rate, d=1) - a trip model charging 4
  ticks (2 phantom travel) per load. New primitive parkedRelayCarry
  (withdraw tick + transfer tick, rate*2/50): bodyRate 60 -> 3 carry
  (6-part body) vs 6 carry under the trip model and 11 under
  yesterday's valve body. P4's plan-side charge deliberately KEEPS the
  trip model (its budget-dry identity is constructed from plan
  formulas; injecting realized bodies broke the t72420007 boundary pin
  - measured, reverted); the shrink shows on the ACTUAL side.
- BUILDER EN-ROUTE ROAD REPAIR (owner: "2 birds with one stone"):
  repair stacks with move per the action-group rules the extension-sim
  verified, so builders walking WITH energy repair the most-damaged
  road in range 3 at 1 energy/WORK/tick - travel becomes maintenance.
  Roads only; never fires empty or on WORK-less tankers (guards skip
  even the search); never on a tick that built.

ATTRIBUTION NOTE: haul-t4-tender-bus-regime is red on the DEPLOYED
build too (3 identical draws fail @34 incl. HEAD; bundle 2 improves it
- one draw satisfied "tender fills" @43, HEAD never does). TWO stacked
causes, peeled in order: (1) the spatial linger guard false-positived
on queued TRANSIT - the staged solid 10-wide extension wall forces
controller trips to detour along the row and the 3-small fleet's
congestion holds the queue in-band past any threshold; replaced with
the intent receipt (above), guard now holds. (2) With the run no
longer aborting early, the refill SLA breaches at ~t150: DEPOT_BUFFER
150 (and the container bank target) were sized for the ONE-oversized-
tender era, whose body was itself the magazine; the split fleet
against a 150-energy bridge buffer misses back-to-back drains while
near fuel rides in transit (the fuel-gated SLA correctly bills the
apparatus). TRUE POSITIVE of a container-depot-era weakness - live
storage rooms (173k cheap reloads) never hit it. Baselined "fail"
honestly in this commit; the fix (bridge buffer / container bank
target scaled to the tender fleet's wave, i.e. the extension bank
capacity) is queued into tomorrow's remodel slate beside per-cluster
tender sizing - same economy, one design pass.

PREDICTIONS (recorded before deploy, verify on next capture):
1. Covered stamp true for the home room; zero "extension-fan" receipts
   ever again in covered rooms; cbd5-class fan trips end for good.
2. Tender staffing >= 1 sustained (bundle 1 bootstrap); any tender
   death recovers in ~60t live (grid-measured 41t kill->refill).
3. Feeder stamp neededCarry 3 (bodyRate ~60), body ~6 parts vs 22
   two days ago; controller inflow unchanged (pacing untouched).
4. endFill recovers from 0.41 toward >= 0.8; spawn idle falls from
   0.71 toward steady-state.
5. Road hits on builder march routes tick UP between captures with no
   drop in build throughput (repair spend <= 1 e/W/t of carried).

### 2026-07-22 (owner-reported live incident t72490325) — DARK REFILL POST: tender bootstrap priority; cbd5 pacing diagnosed as the fallback regime; feeder body from actuals

Owner reported live: "no tenders ... we need tenders so we can spawn
full sized creeps, full time. big opportunity cost ... tendering is
higher value than more mining in terms of spawn priority." Capture
confirmed: tender gate "demand", staffing 0 vs target 3, endFill
COLLAPSED to 0.41, spawn idling at 0.71 - the refill death spiral (no
tender -> empty extensions -> unaffordable bodies). Root cause of the
starvation: tender value 96 vs miners 100-146 and haulers 90-110 - the
re-field wave outbid the refill apparatus indefinitely.

FIX (owner's rule encoded): REFILL BOOTSTRAP - staffing 0 + bank >10k
lifts the tender bid to value 150, above the whole income range. NOT
blocking (owner mid-fix: "don't do anything rash" - verified the
scheduler buys at minCost immediately via afford-min-scaled, so value
alone fields a scaled tender on the next walk; the blocking-tender-
stream era's W2N6 scar, documented in SpawnScheduler, stays retired).
One live tender ends the emergency (96 for top-ups).

CBD5 PACING (owner: "keeps walking back and forth"): diagnosed as the
SAME incident - with extensionTenderActive false (no tender alive),
haulers enter the designed fan-fill fallback (depot -> extensions ->
empty -> depot) and spawnNetworkCritical re-rolls the between-trip
destination as extensions drain. hauler-g-4-37 (the 2-part E2 strand
filling extensions) is the same regime. depart() fixes per-trip
destinations, so no mid-route thrash exists; the code-cop
assignedSourceId suspect is downgraded (cbd5 uses the per-source
assignment path, not the legacy round-robin). Prediction: pacing stops
the moment the bootstrap tender fields.

FEEDER BODY FROM ACTUALS (owner: "way too large", queued yesterday):
feederBodyRate - in the SURPLUS regime only, the body sizes to
min(relay, max(planFlow, standingUpgraderWORK x 1.5)) instead of the
full valve; the relay TARGET (pacing) is untouched, the body makes
more trips at distance 1. Live shape: relay 110 -> body rate 60 ->
~12-14 parts vs the 22-part valve body. Save regime pinned unchanged
(the filling-warchest contract).

Queued (owner): idle creeps preferring to stand OFF roads (parking
polish - roads decay per creep STEP not per standing tick, so the win
is lane-blocking, not wear; fold into the remodel's parking spots).

### 2026-07-22 (owner-directed, wrap-up tail) — source-approach exemption, EOL hauler recycle, X4 rounding meter, feeder truth-pricing

Four owner calls closing the day (gate: unit 1200 + build + trio,
deploy chained on green):

- SOURCE-APPROACH TILES ("we don't need that very last bit of road
  next to the source mine - possible to pave, just pointless"):
  isSourceApproachTile (range 1 of the route's source) exempted from
  the trunk survey, completion check, and new-path recording - same
  defensive-skip mechanics as edge tiles, so cee0's stored route
  (45/50 with a source-end tail) can complete WITHOUT the pointless
  tiles. Prediction: cee0 receipts paved on the next placement pass.
- EOL HAULER RECYCLE ("less ttl than a round trip after dropping off -
  recycle itself"): an EMPTY hauler under its shortest route's round
  trip flags recycling (refund > pointless last walk; loaded creeps
  always deliver first; staffsPost already counts recycling creeps -
  no double-order).
- X4 LIFETIME QUANTIZATION ("this rounding factor is something we can
  track"): new ledger row pricing trip-tail amortization from the
  plan's routes (first read: 0.16 e/t); EOL recycle converts tails to
  refunds.
- FEEDER TRUTH-PRICING ("the feeder seems way too large"): the P4
  feeder charge used the nominal 6-tile distance while the live feeder
  is LINK-FED at distance 1 - a phantom ~46 parts inflating every P4
  reading ~0.03 parts/t. Now reads the corp's own linkFed stamp: P4
  0.98 -> 0.89x. The OTHER half of the owner's observation is real and
  QUEUED (tomorrow, first item): the feeder BODY sizes to the surplus
  valve (relay ~110 e/t, neededCarry 11) not consumer burn (~40 e/t) -
  an actual-grounded cap on neededCarry is the fix shape, touching the
  absorb-clamp seams (not rushed at wrap-up).

TOMORROW'S QUEUE (with spec 27's remodel plan): (1) feeder body
actual-grounded sizing; (2) hauler-g-cbd5 pacing investigation -
suspects: the code-cop assignedSourceId delete-on-blind (finding 4,
predicts exactly this creep class) and delivery-sink dither at the
near-empty-bank moment; (3) home-source micro-hauler question (owner:
"haulers should mostly just be for remote mines" - cd90/cd92 sit 1-11
tiles from storage with links yet field 0.8-carry routes, the
persistent P2 entries); (4) the extension remodel per spec 27.

### 2026-07-22 (cron cycle, +381t) — X1 CLOSED: workUtil 1.00; cee0 45/50 at 2:1; the cleanest board of the session

Capture t72489965 (pre-3-small baseline; that deploy landed seconds
before capture, trio green). The board:

- X1: 0 - workUtil 1.00, dry 0.00 over 308t, 40 WORK standing. The
  upgrader saw that opened with the feeder outage is CLOSED; consumers
  resized and burn every delivered unit.
- X3: 0 untracked (23/23) - first fully-tracked census on record.
  E2: 2 parts. E5: 0. P1: stable. P9: 1.0x.
- cee0: 45/50 - the four standing sites BUILT (41 -> 45), and the
  route already repriced to 2:1 at paved fraction 0.9. The empty sink
  set this capture is LEDGER TRUTH, not the flap: zero sites stand;
  the last 5 tiles await a placement pass with sight. Prediction:
  next capture shows 50/50 + paved:true (the emergent completion
  transition), or the 5 sites placed and admitted via ledger.
- E4: -13.75/t, 146k above target and falling. P7 1.59x (33 e/t).
- Tenders 45p (2-fleet era); the 3-SMALL SPLIT deployed with this
  cycle - staffing 3 x ~16-carry, duty ~0.10-0.12, S3/E5 0 predicted
  for next capture.

Cycle verdict: VERIFIED (ledger-era steady state; the day's leak
arcs - dark dedication, feeder outage, trunk deadlock, consumer saw -
all measure closed or closing).

### 2026-07-22 (owner-directed) — FLEET OF 3 SMALL: same parts, more coverage points (equal-share slot bodies)

Owner, on the cap-2 ratchet vs the legacy scattered layout: "it's
gonna require a little bit more tenders ... we can also split the same
amount of body parts across two or three creeps - that's gonna help
with the rates while still alleviating the spawn capacity." Shipped:
cap back to 3, tenderSlotCarry becomes a PURE EQUAL SHARE of one bank
wave (ceil(bank/target/50), the per-cluster slotSize+1 term retired -
a specific cluster's coverage is the route's job, not the body's).
Totals pinned within one body's rounding at any count (2x23 vs 3x16
carry), so the scattered layout gets three coverage points at the
ratchet's parts budget - NOT the old 72-part fleet back.
TENDER_FLEET_PARTS stays 48 (P5: measure actual next captures, true
the price if drifted). Predictions: staffing -> 3 small (~32p bodies
requested, purchases smaller under partial energy), duty per tender
~0.10-0.12, S3/E5 stay 0, total tender parts <= ~55.

### 2026-07-22 (cron cycle, +172t) — TRUNK UNSTUCK FOR REAL: blind cleared, 41/50 and climbing; ledger admission live; ratchet stands

Capture t72489584. The day's three fixes verify together:

- DEADLOCK FIX (march half): VERIFIED. trunk-blind-W43N22 is GONE -
  the stamp reads trunk-building-41/50 with the W43N22 sites
  enumerated (sighted). cee0 36 -> 41/50 in 172t after ~2600t frozen.
  Rate projects completion within ~2 windows; then the paved receipt
  and 2:1 repricing land by the ordinary path.
- PROJECT LEDGER: 10 construction sinks admitted (the cluster edges
  restored, P2 lists them) on the FIRST post-deploy solve window;
  final stability check = they persist next capture.
- TENDER RATCHET: duty 0.16 @ 653 meter-ticks, staffed 2/2, E5 0,
  S3 0, util 0.79 (the wave is OVER - first sub-0.95 window all day).
  endFill 0.638/finishes 3: the criterion as written broke - the
  queue is buying 2300-cost bodies (= the room's whole capacity), so
  every finish lands mid-recovery from a designed full drain. endFill
  was a proxy for refill collisions at normal body costs; the real
  harm signals (energy-blocked starts, runts) are both zero. RULING:
  cap stays; the revert criterion is replaced by the direct signals -
  any S3 energy-blocked start or E5 runt attributable to refill
  reverts the cap. Reserver-charge watch item CLOSED (reset artifact;
  the line returned).

Remaining board: X1 0.73 over a 2983t window still spanning the
outage (20 WORK standing, resize ongoing); E4 draining -10.8/t.
Cycle verdict: VERIFIED x3.

### 2026-07-22 (cron cycle, +334t) — LEDGER BUILD DEPLOYED (trio green); first trunk progress in 2600t; endFill unadjudicable this window

Capture t72489412 (seconds after the project-ledger deploy - this
capture is the PRE-ledger baseline; the ledger's predictions verify
next cycle). Board: NO FAIL lines. X1 left the board - the consumer
resize-up is underway (S3 head = a 2300-cost upgrader, stock rising
1399 -> 1574, P7 1.67x). E2 strands 40 -> 10. P4 0.94 -> 0.91.
cee0 RATCHETED 35 -> 36/50: first trunk progress in ~2600 ticks (the
remote-end pile-funded builder).

Tender ratchet revert-criterion check: endFill printed 0.761 BUT
finishes=1 (the deploy's global reset wiped the meter seconds before
capture) and util 0.985 - a one-sample reading under abnormal load is
not adjudicable. The trend (0.91 -> 0.844 -> 0.761) has run entirely
inside the re-field + resize waves. PRECISE RULE for next capture:
endFill < 0.9 with >= 10 finishes AND util <= 0.95 => revert the cap
to 3; otherwise the ratchet stands verified on duty (0.159 measured).

Watch items: P4's reserver charge line VANISHED this capture (was 16p
= 0.030 every prior window; possibly a mid-reset solve artifact - one
capture, do not chase yet); E5 1 runt (wave tail).

Cycle verdict: SHIPPED (ledger deploy) + measured progress (36/50);
verification cycle follows.

### 2026-07-22 (owner-directed) — PROJECT LEDGER: sites live in corp memory; the plan admits from the ledger, not eyesight

Owner ruling ("construction sites should be part of the corps memory
so it can rehydrate and bypass Vision. That's a general pattern we
should work towards - similar to staffsPost") + explicit "Yes" to
implementation. Shipped:

- ConstructionCorp.projects: durable ProjectRecord ledger (id, pos,
  type, remaining, seen), serialized with the corp (rehydrates across
  resets). reconcileProjects: every SIGHTED room's records go to
  ground truth; blind rooms persist verbatim; records unseen for
  PROJECT_LEDGER_DECAY (10k) retire (hostiles stomp sites). Single
  writer: the spawn's own-room corp, every tick.
- constructionProjectLedger(): THE ONE LENS - reads the serialized
  store from Memory.commissionedCorps (never Game.rooms), dedupes by
  site id, filters zero-remaining.
- main.ts addConstructionSitesToFlow now iterates the LEDGER; the
  Game.rooms scan (the measured cluster flap, 15 sinks -> 0 across two
  captures) is retired. Admission semantics otherwise unchanged.
- Pattern documented in ONTOLOGY as a peer of staffsPost; 4 unit pins
  (reconcile/blind-persist/ground-truth-wins, decay, one-lens from
  Memory, reset round-trip).

Predictions for the post-deploy captures: construction sinks STOP
flapping (present in consecutive solves while cee0's sites stand,
regardless of sight); the cluster re-forms and STAYS; cee0 built
ratchets past 35/50; P2's cluster micro-route set stable between
captures. Gate: unit 1197 + build + trio (in flight at entry time).

### 2026-07-22 (owner-directed) — CODE COP: vision-lens sweep of every Game.rooms / getObjectById decision site

All 53 Game.rooms references and decision-shaped getObjectById sites
classified (execution reads - run what you see - are correct by class
and excluded). The pattern rules that separate safe from broken:
(1) DECISIONS read durable state (intel, receipts, Memory, the plan);
(2) vision only REFRESHES durable state or drives execution;
(3) Memory reads must never route through Game.rooms[x].memory - the
Memory tree is not vision-gated, reading it through Game.rooms gates
it accidentally.

Ranked findings:
1. main.ts construction-sink admission (KNOWN, fix designed + held for
   owner): visible-rooms-only sites = the measured cluster flap.
2. flowAdapter scavenge detection: transient scavenge sources exist
   only while their room is sighted - routes flap with vision; this IS
   the recurring E2 strand noise (the W44N23/W43N24 hauling entries in
   the last three captures are scavenge corps). Self-limiting (piles
   decay, strands age out); fix would be TTL'd intel stocks, ambiguous
   value since piles are genuinely ephemeral. Filed, not urgent.
3. detectPavedSources (flowAdapter:362) + Telemetry roadReceipts
   export iterate Game.rooms to read MEMORY - rule (3) violations.
   Zero live cost today (receipts live in the always-visible home
   room); trivial hardening: iterate Memory.rooms. Filed.
4. CarryCorp:545 (legacy round-robin fallback): deletes a creep's
   assignedSourceId when the source fails to resolve (blind room) -
   state revoked on vision blink, reassignment churn. Legacy path
   only; the flow-assignment primary path is unaffected. Filed.
5. HarvestCorp sourceIsLinkFed: false when blind -> CARRY-less miner
   body; unreachable in practice (links are home-room infra). Latent.

Verified SAFE by inspection: ReservationCorp (fully reformed post-
incident - no Game.rooms reads, plan+intel lenses only); RoomDiscovery
(vision refreshing intel IS the correct pattern); ClaimCorp/
ExpansionCampaign (blind target keeps the campaign marching; arrival
provides vision); HarvestCorp's documented blind-march fallback;
owned-room iterations (owned structures grant vision); flowAdapter's
controller/value/storage reads (explicit no-vision fallbacks);
execution runners; Telemetry (honest gaps). buildPool: fixed this
session (receipts).

### 2026-07-22 (cron cycle, +362t) — RATCHET VERIFIED (duty 0.159, fleet 2); receipt-demand fielded the home builder; the cluster FLAPS with vision

Capture t72489078. Verifications:

- TENDER RATCHET: VERIFIED. Stamp reads target 2, staffing 2, gate
  staffed, DUTY 0.159 (prediction: 0.10 -> 0.15+), fleet 37 parts (was
  59-66; ~24 freed as priced). Caveat: endFill 0.844 vs the >=0.9 bar -
  but the window carried 34 build-finishes in 362t (the deepest
  sustained spawn pressure measured) plus the feeder outage; E5 0 runts
  and S3 0 stalls say no actual spawn-gating harm. HOLD with explicit
  revert criterion: endFill still <0.9 next window at normal load =>
  revert the cap.
- DEADLOCK FIX: the demand half VERIFIED - the home pool crew EXISTS
  again (2W1C1M fielded from receipt-charged poolWork after ~750t
  queued). trunk-blind-W43N22 still stamped; the march/vision half
  resolves next window (cee0 still 35/50).
- FEEDER: self-healed as predicted (gate staffed, 1/1, feederActive
  true). E4 flipped FAIL (slope +10.3/t) and X1 stays FAIL (workUtil
  0.62, 40 WORK standing) - the OUTAGE'S WAKE: consumers shrank during
  the starvation and resize up from actual stock per doctrine
  (controllerStock 810 -> 1399 rising). Recovery trajectory, not a new
  leak; verify next window.

NEW MEASURED FACT - the cluster FLAPS: last capture 15 construction
sinks and cee0 fully clustered; this capture ZERO construction sinks,
cee0 routing home, P2 back to 3 micro-routes - while all four road
corps' local builders stand. The plan's sink set oscillates with
whether a site room happened to be visible at solve time. This is the
planner-level half of the vision-lens class: the durable fix is
admitting RECEIPT-KNOWN trunk sites into the ColonyProblem without
vision (positions from tiles3, remainder from built/total, refined by
sight). Owner explicitly questioned this mechanism area this session -
the planner-level change is DESIGNED but held for owner review; the
crew-level fix already deployed covers the deadlock class meanwhile.

Cycle verdict: VERIFIED x2 (ratchet, deadlock-demand), flap NAMED with
data, E4/X1 on a recovery trajectory. No deploy this cycle.

### 2026-07-22 (cron cycle, +392t) — THE CLUSTER IS LIVE (remote end); X1 names a feeder gap; tender ratchet ships

Capture t72488716. SPEC 25 WORKS END-TO-END LIVE for the first time:
15 construction sinks in the plan and cee0's output routed to its road
sites (the P2 "micro-route" explosion is the cluster's per-site edges,
0.4-3.4 carry each - plan-side pro-rata, not fielded runts; E5 0).
The unlock came from the REMOTE end, not the home crew: W42N22's
pile-funded local builder fielded (2W1C1M standing) and provided the
vision that admitted the sites. The home pool crew is still QUEUED
behind the hauler re-field wave (trunk-blind-W43N22 persists,
bodyParts 0) - within the deadlock fix's predicted 2-window allowance;
next capture decides it.

X1 FAIL (top line): workUtil 0.69, dry 0.32, delivery 61 -> 39 e/t.
Cause read from the stamp, not inferred: the controller feeder DIED
and has not re-fielded - gate "demand", wantedFeeders 1, feeders 0,
feederActive false at 180k storage. Queue congestion class (util 0.97,
head AFFORDABLE+IDLE churn); ONE capture observed - the two-capture
rule holds escalation until next window. Predicted self-heal: the
re-field wave is draining (E5 0 runts now, transient haulers 13p) and
the TENDER RATCHET deploying this cycle frees ~24 parts of exactly
this queue pressure. If feeders is still 0 next capture, the feeder's
queue priority becomes the work item.

Also: E2 back to 40 parts (cluster plan-shape re-strand, defund-not-
revoke aging); P4 0.98 -> 0.94 (plan upgrader WORK shrank); W43N24
reservation recovered (bank 410); W42N22 bank 14 - reserver next.

Shipped this cycle after its own build+trio: tender fleet cap 3 -> 2 +
TENDER_FLEET_PARTS 72 -> 48 + transfer-duty meter (owner ratchet).
Predictions: tender duty ~0.10 -> ~0.15+, endFill holds >= 0.9, ~24
parts freed, no S3/E5 regressions; revert on breach.

### 2026-07-22 (cron cycle, +902t) — STRANDED-TRUNK DEADLOCK: buildPool was a vision lens; receipts now charge blind rooms

Capture t72488324. Deploy verification holds a second window: P9 1.0x
(70/70), workUtil 0.81 -> 0.92 (dry 0.08), delivery 53.9 -> 61.0 e/t,
E4 -35.4/t toward target, E2 strands 40 -> 14 aging out as predicted.
NO FAIL lines.

The failed watch item is the cycle's work item: the trunk build is
DEADLOCKED on vision. roadGate has stamped trunk-blind-W43N22 for
1100+ ticks, cee0 frozen at 35/50, and the pool crew is ZERO bodies
(the tanker died; nothing re-fielded). Chain: buildPool scans
Game.rooms -> W43N22 dark -> its 4 standing sites invisible ->
poolWork 0 -> no builder demand -> nobody ever walks there -> dark
forever. Bootstrap deadlock in the documented trap class (room state
from vision, not the durable signal) - and the durable signal exists:
the HOME room's roadRoutes receipts carry tiles3/rooms/built/total.

Fix (this commit, framework seam not bandaid): buildPool returns
BuildPoolEntry {roomName, room?, work} and charges each BLIND route
room its tile-share of the unbuilt remainder read from receipts
(visible rooms keep ground truth - no double count; paved/declined/
finished routes charge nothing). buildPoolAbsorbRate prices blind
entries at linear-room travel; work() marches builders at a blind
receipt head (travel IS the vision bootstrap - same doctrine as the
rung-3 no-vision march); tankers wait for a sighted site. Receipts
staged in the new unit pins per the sim-blind-spot rule (the trio
stages none). Sizing composes with no-residual: blind-pool crew floors
at 1 WORK (no plan sinks while blind) - a cheap scout-builder, not a
fleet; the cluster machinery funds the real crew once vision returns.

Predictions for next capture: construction corp fields >= 1 builder
(or queued behind the 0.97-util wave); roadGate leaves trunk-blind
within ~2 windows of the builder arriving; cee0 built ratchets past
35/50; P9/delivery hold. Watch items carried: E5 4/8 runt purchases
(rebuild-wave energy contention - runt recycling owns it); W43N24
reservation bank hit 8t (reserver ordered, gate=demand - a lapse
would flap P1 next capture).

### 2026-07-22 (cron cycle, +196t) — PHASE 3 DEPLOY VERIFIED: routed 30 -> 69.7 e/t, all 7 sources; v7 live; repricing per-route correct

Capture t72487422, 196t after the deploy. Every prediction confirmed:
P9 1.0x (funded 70, routed 69.7 via 7 mined-source haulers - the three
dark sources ship home again), flow v7 with no dedicatedToBuild fields,
X1 workUtil 0.75 -> 0.81, E4 draining -48.4/t (consumers eating the
hole's backlog), delivery 37.3 -> 53.9 e/t actual. Paved-fraction
repricing correct per route against the receipts: cee0 35/50 and cd8d
34/56 ride 2:1; cedc 14/53 and cbd5 0/52 stay 1:1 (the 0.5 threshold).
NO FAIL lines.

Transition facts, named as watch items (not leaks yet):
- Cluster sinks ABSENT this solve: the trunk gate stamps
  trunk-blind-W43N22 - the sites' room was dark at solve time, and
  main.ts only admits VISIBLE rooms' sites. cee0 routes home meanwhile
  (correct fallback). With haulers now walking the trunk rooms, vision
  is intermittent: expect cluster sinks (and source->construction
  edges) to flicker in per-solve. If they never appear across two
  captures WITH vision, that is the next work item.
- Trunk build PAUSED: the pool crew fields only its 16C6M tanker, zero
  WORK - the spawn is 8 deep re-fielding the restored routes' haulers
  (source-route haulers 41 -> 221 plan parts; P4 0.98x ceiling, the
  spawn-bound regime made visible). Production-first says this is the
  right order; VERIFY next capture that builders re-field and 35/50
  grows once the wave clears.
- E2 40 parts (W43N23-hauling-4-37 + W43N24-hauling-0-20): plan-shape
  transition strands, defund-not-revoke lets them age out. Watch it
  shrinks.
- P7's ratio prints 26.96x against a 2.0 lower-endpoint plan (spawn
  45.8 eats the GOAL plan's income during the rebuild; actual upgrading
  rides stock per doctrine). Cosmetic: the line needs an endpoint floor
  before its ratio means anything at tiny plans.

Owner insight recorded this window (the load-context rule): several of
last cycle's green lines (endFill 0.917, zero runts, comfortable
utilization) were LOAD ARTIFACTS of the shrunken fleet, not health.
This capture is the honest test - endFill held at 0.915 UNDER the
rebuild wave at util 0.94, which is the real signal. Follow-up filed:
a ledger REGIME line (spawn-bound / energy-bound / consumer-bound) so
greens carry their load context.

Cycle verdict: VERIFIED (deploy confirmed by prediction, on schedule).

### 2026-07-22 (cron cycle, +1314t) — P9 FAIL IS REAL: the flag dedicates trunk QUEUE members, not the active project - 30 e/t dark

Capture t72487226. The ledger's top line (P9 0.43x: funded 70 e/t,
routed 30) is REAL WASTE on the deployed flag-era build, not the
expected working-tree-ledger-vs-live skew: roadReceipts (v13) shows
FOUR sources flag-dedicated but only ONE building - cee0 35/50 with 4
sites standing (W43N22, the trunk gate stamps trunk-building-35/50),
while cbd5 sits at 0/52 BUILT NOTHING, cd8d 34/56 and cedc 14/53 wait
behind the one-project-at-a-time placement with NO standing sites.
Three sources (30 e/t) route nothing home AND build nothing. The
deployed detector dedicates every source with an unpaved route receipt
the moment its route exists; placement serializes but dedication does
not. Knock-ons measured: P7 0.50x (delivery 37.3 vs plan 74.5 - the
GOAL plan budgets all 70), X1 workUtil 0.75 (dry 0.25, supply-starved),
E4 draining -18.6/t (the bank is covering the income hole; 226k stock).
Positive: endFill 0.917 (refill largely no longer collides with
builds), P5 duty 0.50 on-price, P1 stable, E5 0 runts.

The FIX IS ALREADY GATED in this branch: the phase-3 no-residual
revision (previous entry) retires the flag - dedication becomes routes
to STANDING sites only, so queued trunks' sources keep routing home and
only the active project's source feeds its cluster, at the source's
rate. NOT deployed this cycle: owner mandate for phase 3 is explicit
local-only development; deploy offered to the owner with these numbers.
Cycle verdict: DIAGNOSED with data, then DEPLOYED same cycle (owner:
"Deploy now" on the AskUserQuestion with these numbers). Predictions
to check next capture (>=200t post-deploy): P9 -> ~1.0x (only the
active cluster's source unrouted-home, and THAT flow appears as routed
source->construction edges under flow v7), income routed 30 -> ~60+
e/t, P7 toward 1.0x, E4 drain stops or reverses, flow segment version
7 with no dedicatedToBuild fields. Watch item: pool tankers fetching
BANK energy toward cluster sites (spec 25 open item).

### 2026-07-22 (owner-directed, LOCAL) — NO-RESIDUAL REVISION: source-local clusters price at the source's rate; the pool crew sizes to eat them

Owner redirected phase 3's behavior flip before it deployed: "I'm not so
sure about road building remotes sending energy home ... only build one
(or some) of the roads at a time, and just make sure to plan the economy
as a sound economy around it. There shouldn't be any residual - we can
just make a bigger builder if we need to consume all the energy from the
source mine during that time." The residual-ships-home model is OUT; the
plan is a sound economy around serial road projects.

Implementation (spec 25, revised status there): flowAdapter clusters each
remote site to its nearest hub-rule source and prices the cluster at the
SOURCE'S RATE pro-rata by remaining work (no completion-horizon residual);
the pool-absorb budget covers only unclustered sites. constructionKind
attributes each spawnless room's cluster allocations to its staffing
spawn's room corp as `poolAllocatedRate`; builderPlan sizes the pool crew
to MAX(bank track capped by absorb horizon, source-funded cluster rate) -
max, never sum (serial crew; summed parts idle). Source-funded rate joins
after the home-stock clamp (its fuel is the mine, not the depot).

Pins: flowAdapter "SOURCE-LOCAL sites price at the SOURCE'S RATE" (cluster
demand = the source's 10, all flows to construction, no storage leg);
builderSizing "bigger builder" (0-alloc + rate 10 -> 2 WORK vs floored 1)
and MAX-not-SUM (30k home + cluster 10 stays 6 WORK); constructionKind
attribution + materialize threading + drop-to-zero on cluster completion.
One cross-file test-pollution fix rode along (the new describe restores
the shared mock's getObjectById; it had poisoned CarryCorp.behavior).

Gate: unit 1180 green, build clean, trio green. NOT DEPLOYED - owner
mandate is local development for phase 3. Cycle verdict: FIXED (locally),
deploy + live plan-vs-actual pending owner go-ahead.

### 2026-07-21 (cron cycle, +317t) — MEA CULPA: cd8e was 2:1 all along; the auditor's probe read the wrong field

The roadReceipts export (v13) answered on its first capture - by
exposing an AUDITOR error, not a bot bug. cd8e's entry: built 36/38,
paved TRUE (standing since ~t72483599 - it is what un-dedicated the
source). And with the CORRECT segment-6 field name, the plan reads:
cd90 2:1, cd92 2:1, cd8e 2:1. THE REPRICING HAS BEEN LIVE AND CORRECT.
Every probe since t72483599 filtered `h.haulerRatio` (the internal
FlowSolution name); segment 6 exports `ratio` (pinned in
flowPlan.test.ts all along). carry 14.8 is CORRECT for a 2:1 body -
pavement saves MOVE parts (1.5 vs 2 per CARRY in the spawn ledger),
not CARRY count. The "cd8e stuck at 1:1" thread across three cycles
was a phantom.

What remains REAL from that thread: the edge-tile fix (the trunk WAS
unsatisfiable - err-7 receipts, 36/38 for 4400t); the completion sweep
(a genuine ordering hazard, correctly pinned - though cd8e itself was
likely receipted by the ordinary loop before the sweep shipped); the
roadReceipts export (proved its worth immediately). Auditor process
fix: probe field names come FROM THE EXPORT PINS (flowPlan.test.ts),
never from internal type names.

Board otherwise the greenest of the session: NO FAIL lines, P7 0.89x
(burn 66.7, stock 2078), E4 -50/t continuing, spec 25 stable. Cycle
verdict: FALSIFIED (the phantom named, the record corrected).

### 2026-07-21 (cron cycle, +190t) — X1 prices the feeder gap; roadReceipts export ships (core v13)

Verify-first: the feeder SELF-HEALED (feederActive true, stock 1005 ->
1503, burn 32.8 -> 51.6 recovering, E4 -50.24/t). X1 did exactly what
the owner's waste class was built for: the feeder outage now has a
NUMBER - workUtil 0.68 / dryShare 0.32 over 765 upgrader creep-ticks =
25.6 idle WORK-equivalent, the measured cost of a single-shuttle supply
line dying at end-of-life. Strengthens the pending supply-package
decision (trickle fix options, owner-open). Reservation healthy (banks
821-1194, gate opportunistic-topup). Spec 25 phase 1 STABLE on its
second capture (3 sinks, 4 routes, dedication set unchanged) - phase 3
unblocked. endFill 0.835 over 22 finishes (util 0.97).

cd8e STILL 1:1 (third window). Per never-guess-twice, INSTRUMENTED
(core v13): roadReceipts - the roadRoutes records the pave-fraction and
dedication lenses actually read (built/total/paved/declined/tiles per
key, rooms merged), exported verbatim. Next capture names cd8e's entry
state directly: absent = deleted (the re-judge hypothesis), present
fractionless = survey starvation persists, paved = the pricing lens has
a different bug. Unit 1178; deployed.

Cycle verdict: verified (feeder heal, spec 25 stability) + priced (X1
feeder gap) + instrumented (roadReceipts).

### 2026-07-21 (cron cycle, +527t) — SPEC 25 PHASE 1 VERIFIED LIVE; endFill 0.80 answers the refill question

PHASE 1 VERIFIED on its first capture: 3 remote construction sinks in
the solve with pool-budgeted demands (1.48+1.6+1.92 ~ 5, pro-rata -
the floor-sum fix live), and construction ROUTES in haulers[] charging
the parts ledger - including scavenge-34-30 -> sites (the deposit-class
local-build rule firing on a LOCAL PILE, exactly the emergent behavior)
plus bank -> site legs. The owner's tankers-in-plan ruling is measured.
cd8e correctly left the dedicated set (4 remain). Phase 2 satisfied;
phase 3 (flag retirement) is unblocked pending one more stable capture.

endFill FIRST READ: 0.798 over 17 gapped finishes (util 0.96) - refill
largely OVERLAPS builds; the residual is the last ~20% (~460 energy)
on expensive heads. The morning's 0.62-0.69 duty windows were
deploy-reset artifacts; the standing overdraft is far smaller than
first measured. The duty-adjusted P4 stays queued but drops in urgency.

OPEN: (1) P7 0.42x this window = a FEEDER generation gap (corp at 0
creeps, feederActive false; the @200 replacement at the agenda head
mid-buy at capture - self-healing; same replacement-cadence class as
the consumer trickle, owner decision pending). (2) cd8e STILL priced
1:1 (carry 14.8) after the completion sweep - the receipt did not
land, suggesting its roadRoutes entry is GONE (deleted, not starved) -
next step is a roadRoutes receipts export (keys/built/total/paved) in
telemetry, not a third guess. (3) P5/P6 rows skipped this capture
(reservation stamp absent) - watch.

Cycle verdict: verified (spec 25 phase 1 + endFill instrument).

### 2026-07-21 (owner-directed) — SPEC 25 PHASE 1 SHIPS: emergent dedication machinery, remote sinks admitted, floor-sum fixed

Owner: "Yes start on spec 25." Phase 1 per the spec's migration order -
the flag COEXISTS (its pool-zeroing keeps the new edges inert for
currently-dedicated sources; behavior switches at phase 3 retirement).

SHIPPED (red-first, tests 1-5 + test 0's adapter half + the floor-sum
pin): (1) routeToSinks gains a LOCAL-BUILD PRE-PASS between spawn
overhead and the deposit fill - a deposit-class source may feed a
construction sink NEARER to it than its hub; restricted to local
deposit sources so bank-funded construction keeps its value-pass turn
behind deposits (t72445337's production-first order preserved
byte-identical when no construction stands). Emergent dedication,
residual deposits, completion transition, the role guard (farther
sites still bank-funded), and hub-roles-otherwise (controllers never
draw mined) all pinned. (2) main.ts admits ANY visible room's own
sites as construction sinks (was owner-rooms only - the entire remote
road program was outside the solve; t72484107 zero construction sinks
while the pool tanker worked off-ledger). (3) Per-site construction
capacities are pro-rata shares of ONE projectAbsorbRate pool budget -
ten 300-work road sites now sum to ~5 e/t, not ten 5-floors (the
t72480337 inflation class, closed at the adapter). Unit 1178.

Predictions (phase 1, flag standing): remote sites appear as
construction sinks in the flow segment with pool-budgeted demands;
their haul routes (bank->site or local-source->site for NON-dedicated
sources) appear in haulers[] and charge the parts ledger (the owner's
tankers-in-plan ruling, measured); currently-dedicated sources route
nothing (pool 0) - no behavior flip until phase 3. P4's construction
lines become real. Cycle verdict: shipped (phase 1, pending live
verification next capture).

### 2026-07-21 (cron cycle, +771t) — RECEIPT STARVATION: one-project-at-a-time starved completed trunks of their paved receipt

Verify-first: the cd8e 2:1 self-heal prediction FALSIFIED (two windows,
~1300t, still carry 14.8 / no ratio) - and per the recorded criterion
that made it a bug investigation. Named from code, consistent with all
captures: the one-project-at-a-time RETURN lives in the trunk loop's
SURVEY path, so the in-progress W43N22 trunk took every placement pass
and cd8e's completed-but-unreceipted route behind it in remoteTrunks
order was NEVER re-checked - no paved receipt, no pave fraction (its
re-judged entry lacks built/total), haulers priced 1:1. FIX
(red-first): a COMPLETION SWEEP over all entries runs before the
serialized placement pass - completion is cheap and idempotent; only
placement stays one-project-at-a-time. Pin: an in-progress trunk ahead
of a completed one no longer blocks its receipt. Unit 1172.

Also this window: upgrader saw on its recovery leg (1 -> 3, an @2300
receipt landed; queue holds another at age 173), E2 back to 0, P6
banks 636-1013 (reservation fully healthy), E4 -31.66/t (294k).
endFill probe TOO FRESH to read (window rolled 34t before capture,
util 1.00, zero gapped finishes yet) - next capture.

Predictions: cd8e paved receipt within one pass post-deploy -> 2:1
flag + priced carry ~11 (-25%); the pave fraction re-stamps via the
next survey; W44N23/W42N22 trunks receipt the moment they finish
regardless of queue position. Cycle verdict: falsified (self-heal) ->
fixed (completion sweep, pending live verification).

### 2026-07-21 (owner-directed) — THE PLAN'S CEILING IS IDEALIZED: duty gap measured; endFill probe ships (core v12)

Owner: "If we're not using 100% of our spawn capacity then why are we
perpetually queued? ... According to the plan ... refilling should
happen while the other creeps are spawning. So the spawn should always
be able to spawn bodies. Or we have to measure and fix that."

MEASURED across today's 8 captures: delivered parts/tick 0.207-0.316
(mean ~0.26) vs the plan's implied 0.307 need vs the ideal 0.333
ceiling. P4's "92% with slack" is against a 100%-duty ceiling that
reality never delivers - the plan OVERSPENDS actual throughput ~15-20%
in most windows, and the perpetual queue is the buffer absorbing that
standing overdraft (which is also why the ordering acts as the
allocator and consumers trickle). Second gap: off-plan bodies - SIX
guards in today's receipts with NO P4 line (spec 15's own "ALL fleet
classes" rule), construction-crew tankers under-charged similarly.

Tender code read: the bus circuit has NO spawning-state gate - refill
CAN overlap builds mechanically; whether it DOES is the question.
INSTRUMENTED (core v12): the spawn meter's endFill probe - at each
GAPPED build-finish (back-to-back restarts never register, so every
counted finish IS a duty gap) record energyAvailable/capacity. The
next captures discriminate: low endFill = refill lag (tender fix, the
red plan-t5 cell is its sim scenario); high endFill = affordable-but-
idle (agenda/decision latency). Unit 1171; deployed.

QUEUED (instrument, next cycle): P4 duty-adjusted verdict (plan vs
MEASURED partsPerTick) + the guard line. OWNER-OPEN: the consumer-
trickle fix choice (multi-shot rebate / maintenance tier / package);
whether partsBudget should discount by measured duty; the expansion
audit (GCL 32, warchest 10x target, one room).

### 2026-07-21 (cron cycle, +508t) — THE SAW'S MECHANISM CLOSED: consumers refleet on the starvation trickle alone

The v11 whole-queue mirror answered on its first capture. The upgrader
demand: rank 2, since 72483597, age 510, gate "queued" - the clock
reset at ~t72483597 is a starvation ONE-SHOT firing (a purchase in the
304t receipt-cap hole between windows), and the age has re-accumulated
toward the next. Ruled out by code+data: opportunistic exemption (not
set), deploy resets (firstSeen lives in Memory.spawnDemandFirstSeen),
cost-flip re-keying (clock key is spawn:corp:role).

MECHANISM (measured end to end): consumers lose every normal-tier
arbitration to the +1e6 income/infra tiers (by doctrine), so the WHOLE
consumer refleet flows through the anti-starvation backstop at ONE body
per ~550t (300t threshold + queue drain). One body/550t against a
1500t lifetime = equilibrium fleet ~2-3 vs targetCount 6 - the 1->3->
5->1 saw, exactly as observed across five windows. Meanwhile P4
charges the plan the FULL 6-body maintenance (117p, 0.079 parts/t,
~24% of ceiling) - paid, never delivered - and the spawn idled 31%
this window while the 2300-cost demand waited at rank 2. The one-shot
contract ("once the creep exists the demand stops reappearing") was
designed for single-body demands; a 6-body fleet needs six shots.

OWNER-GATED (talk-first precedent on spawn economics), options
presented: (a) multi-shot starvation while staffing < targetCount
(partial clock rebate on purchase - recommended, minimal), (b) a
maintenance tier between income-blocking and income-scaling, (c)
package-spawn (owner doctrine, biggest redesign). No deploy this cycle.

Watch items: cd8e's 2:1 plan flag NOT yet self-healed (carry 14.8,
no ratio - the re-judge/re-survey hypothesis gets ONE more window
before it becomes a bug investigation); E2 90p (0-20 corp recurring);
trunks: still 3 routed + 4 dedicated. Cycle verdict: named (the
trickle equilibrium) + presented (fix options, owner-gated).

### 2026-07-21 (cron cycle, +552t) — FIRST TRUNK COMPLETED (edge fix verified); the upgrader saw named S4; whole-queue mirror ships

EDGE-FIX VERIFYING: P9 reads funded 3 src / 30 e/t routed (+4 still
trunk-dedicated) - was 2+5. One trunk completed, its dedication lifted,
hauling resumed, routed income 20 -> 30 e/t; source-route hauler parts
11 -> 41. The remaining 4 lift organically as their trunks finish.

TOP LINE P7 FAIL 0.33x - the upgrader SAW, now precise: fleet 3 -> 1
(20 WORK standing), X1 workUtil 0.84 when present (bodies work when
they exist; the waste is the GAPS). The corp stamped demand:"demanded"
(staffing 1, target 6, demandMin 2300) continuously, yet ZERO upgrader
receipts in 250t and the visible queue heads are a serialized
miner->reserver->hauler->tanker chain at a 0.86-util spawn. Same class
hit reservers (2 staffed of 4, banks decaying 795-838 -> 92-384). S4
(replacement mistiming) is the named class. NOTE: today's four deploys
each global-reset the colony and re-sync death waves - part of this saw
is deploy-induced; the steady-state saw predates today (log passim).

THE OPEN QUESTION the capture cannot answer: the anti-starvation
backstop (300t -> STARVED_TIER one-shot) should have lifted a 550t-
unmet upgrader demand and visibly did not (demand is NOT opportunistic
- exemption ruled out by code read). Its `since` age - the starvation
clock - was invisible: the agenda mirror exported only 4 queue heads
and the upgrader sat at rank 5+. INSTRUMENTED (core v11): the mirror
now exports the WHOLE queue verbatim (~100B/entry, single-digit
depth). Next capture reads the upgrader entry's since/gate directly:
old age + no lift = backstop bug; young age = the stream clock resets
spuriously (the fix target either way). Unit 1169; deployed.

Cycle verdict: verified (edge fix, first trunk) + named (S4, the saw)
+ instrumented (whole-queue mirror). Fix deferred one capture - never
guess twice; the queue entry names the mechanism.

### 2026-07-21 (owner-directed) — THE TRUNK WAS UNSATISFIABLE: border tiles in the tile list; edge-exempt completion ships

Owner: "prioritizes building over upgrading... upgraders building up
while there's construction sites remaining is a bit concerning... the
road should have two mechanisms... I want the information feedback that
the roads are getting built... using our frameworks and primitives
rather than a Band-Aid... simple scenarios to verify."

The trunkMissing stamp (deployed last cycle) NAMED IT ON ITS FIRST
CAPTURE (t72483047): "W43N24:43,49:err-7 W43N23:43,0:err-7" - the 2
unbuilt tiles are the BORDER tiles where the trunk crosses rooms, and
the engine forbids ALL construction on the border row (err-7 =
ERR_INVALID_TARGET, every pass, ~4400t). Neither build mechanism failed
- the COMPLETION CONDITION was unsatisfiable by construction: a
cross-room path necessarily includes border tiles, tiles3 recorded
them, and trunkBuilt required roads on all of them. So the paved
receipt could never land -> the 2:1 repricing never fired -> the
dedication never lifted -> the 5 sources would have shipped nothing
home FOREVER. Same engine-rule class as the 693065a link fix (the
exit-BUFFER rule, x/y=1/48, roads exempt); this is the border ROW
itself (x/y=0/49, nothing exempt), unhandled.

FIX (primitives, not band-aid): ONE shared predicate
nodeEnergy.isRoomEdgeTile, applied at three seams - the path->tiles3
conversion (new routes never record border tiles), placeTrunkSites
(total counts placeable tiles only; no err-7-forever missing entries),
trunkBuilt (completion over placeable tiles - un-sticks routes STORED
with edge tiles, no migration). Owner's verification scenarios: the
live 36/38 shape in miniature pinned both ways (survey + completion) in
constructionKind.test.ts; the conversion exclusion pinned in
trunkRejudge.test.ts. Unit 1169; trio gate below.

Predictions (next captures): roadGate -> trunk-paved for the stuck key,
trunkMissing absent, the trunk sources lose [DED] as their segments
complete -> hauling resumes at the 2:1 paved rate, routed income 20 ->
climbing, P9's route-exempt count drops. On the owner's building-vs-
upgrading priority: the ROUTING ladder + absorb clamp already put
construction first in ENERGY; the small build crew (2W) is the absorb
formula's lifetime-completion horizon sizing to the pool - with the
trunk unstuck the pool re-forms (W43N22 17 + W44N23 6) and tempo gets
re-measured before touching the horizon primitive. The two-mechanism
design (build-from-both-ends) was consolidated away by the ONE-pool
change (2026-07-20) BEFORE the dedication directive; restoring a
source-end build detail through the kind framework is spec-25-adjacent
follow-up work, owner-gated.

### 2026-07-21 (cron cycle, +640t) — FIRST ALL-GREEN TRIAGE; workUtil 0.98 falsifies the supply hypothesis; trunk residual named

NO FAIL LINES - first fully-green triage of the session. Verify-first:

- X1's FIRST LIVE READ answers the P7 question: workUtil 0.976 /
  dryShare 0.02 over 1974 creep-ticks - standing WORK fires 98% of the
  time, supply is HEALTHY. The P7 sag (0.48x -> 0.80x this window) is
  FLEET COMPOSITION: upgraders 5 -> 3 of target 6 (generation gap,
  replacements queued behind a 0.94-util spawn). The package-spawn
  remedy for THIS symptom is falsified by the meter - the supply half
  never starved; the residual waste class is replacement timing under
  spawn contention (S4), self-resolving as the queue drains. Watch.
- Reservation fully recovered: gate "staffed", banks 795-838, P6 2449
  ticks delivered. E2 down to 2 parts (one micro-corp, attrition).
  E4 draining -76.78/t (335k). E5's 2x hauler@200 are plan-sized micro
  bodies for 2.6-3.0c scavenge routes, not drained-spawn runts (E5's
  cost heuristic conflates them - known imprecision).
- TRUNK: formally STUCK - trunk-building-36/38 across 5 captures
  (~4400t) while W43N24 sites complete and reappear (4 -> 1 -> 2) with
  the crew working there. WHICH 2 tiles never build - and why - is
  invisible: placeTrunkSites counted a failed createConstructionSite
  NOWHERE (the silent-forever state). INSTRUMENTED (invisible-cause
  rule): TrunkSurvey.missing names each unbuilt visible tile with its
  pass state (site/placed/paused/err<rc>, capped 4), stamped as
  trunkMissing beside roadGate. Next capture names the 2 tiles
  directly: err-13 = blocked tile (re-path the segment), site = crew
  tempo, absent = registry mismatch. Unit 1167; deployed.

Cycle verdict: verified (all-green board) + falsified (package-remedy
for P7 - the meter did its job) + instrumented (trunk residual).

### 2026-07-21 (cron cycle, +743t) — E2 to ZERO; trunk tiebreak acquitted; P7's invisible half gets a meter

Verify-first: E2 78 -> 0 parts ("every fielded hauler serves a planned
route") - the stranded-fleet leak fully self-healed by attrition, as
classified two cycles ago; no intervention was the right call.
Reservation banks refilled (311/383/385/474 - P6 reading honestly
post-fix, 1553 ticks delivered). TRUNK TIEBREAK WATCH resolved
favorably: W43N24 sites 4 -> 1 while W43N22's fresh 17-batch is
untouched - the pool crew IS finishing the nearly-done room; no
ordering bug. roadGate still stamps 36/38 (4 ticks pre-capture); next
capture expects 38/38 or names the residual tiles.

TOP LINE P7 FAIL 0.48x: burn 86.3 -> 48.7 e/t while 100 WORK stood at
BOTH endpoints (identical bodies, zero churn, no upgrader receipts) and
the stock endpoint read full (1190 -> 1396). The missing half is
invisible: endpoint stock reads hide mid-window starvation, and nothing
measures whether standing WORK actually fired. Per the invisible-cause
rule: INSTRUMENT, don't theorize. Shipped the upgrade WORK-utilization
meter (Memory.upgradeMeter, spawn-meter pattern, pure seam
tallyUpgradeAttempt): tallied at the upgradeController call site -
fired on OK, dry on ERR_NOT_ENOUGH_RESOURCES - and stamped as
workUtil/dryShare/meterTicks in the upgrader sizing record. Next
capture discriminates: high dryShare = supply chain (feeder/link
throughput mid-window); low dryShare with low workUtil = idling
(parking/walk); workUtil ~1 = the window average was masking a
composition effect. Unit 1164; telemetry-only, deployed.

Cycle verdict: verified (E2, banks, tiebreak) + instrumented (P7).

### 2026-07-21 (cron cycle, +207t) — restaffing complete; P6 zero-floor artifact fixed; trunk tiebreak on watch

Verify-first, all on track: E2 82 -> 78 parts / 4 -> 2 corps (the
micro-runts EOL'd; the re-buy escalation trigger did NOT fire - the
window's hauler@100 went to hauling-4-37, an IN-PLAN 0.8c micro-route,
acquitted), burn 72 -> 86.3 e/t (P7 1.25x), E4 slope -96.82/t (424k),
remote restaffing COMPLETE on receipts (miners cee0/cbd5/cd8d/cedc +
THREE reservers @1300; banks refill next window), P9 honest, P1 stable,
util 0.66.

FIXED (instrument, ledger-script only - no deploy): P6's pump formula
credited +dt of decay at the ZERO FLOOR (a bank at 0 cannot decay),
fabricating "836 ticks banked, no reservers fielded" from four zero
banks. Expected decay now bounded by the starting bank
(min(bank1, dt)); pinned in wasteLedger.test.ts. Unit 1160.

WATCH (falsifiable, next capture): trunk STILL 36/38 (~3000t) but its
fuel line (the dedicated miners) only landed this window. Meanwhile
placement expanded the pool to 31 remote sites incl. a fresh 17-site
batch in W43N22. If next capture shows W43N22's count dropping while
the trunk holds 36/38, the pool crew provably marched to the fresh
batch over the 2 nearly-done trunk tiles - a completion-first tiebreak
missing from buildPool's ordering (the owner's own no-99%-finished
doctrine) - and that becomes the work item. Cycle verdict: verified
(restaffing) + fixed (P6 instrument).

### 2026-07-21 (cron cycle, +44t/+933t) — RECOVERY VERIFIED END TO END: burn 72 e/t (1.04x plan), remotes restaffing, E2 draining

Verification cycle - no fix, no deploy (a reset mid-recovery costs
progress for nothing). Every standing prediction landed:

- Demotion exemption + v6: 7 funded / 0 unrouted held (P1 stable), P9
  reads "2 src / 20 e/t (+5 trunk-dedicated, route-exempt)" - the rot
  detector honest through a trunk build, no false FAIL.
- Receipts show the restaffing executing: miners bought for cd92/cd90/
  cd8e (a dedicated source - the trunk's fuel line), cee0/cbd5/cd8d
  queued; THREE upgraders @2300 in one window.
- Absorb-clamp chain at full effect: P7 actual 72.0 e/t vs plan 69
  (1.04x - was 0.49x FAIL at 1.0 e/t two cycles ago), upgraders 5 of 6
  staffed, allocated 102.7 / inflow 101.9 = 115 - absorb 13.09 (the
  pool grew as trunk placement resumed; both halves still identical).
- E4 slope -79.55/t (444k, drawdown to target ~5k ticks at current
  draw, tapering below 42.6k). E5 zero runts. Spawn util 0.64 - the
  saturation era over.
- E2 82 parts (TOP LINE, watch-class): draining 193 -> 82 as the
  demotion fix pulled the remote corps back in-plan; the residual 4 are
  scavenge-route leftovers holding 1 creep each with NO re-buys in the
  window's receipts - expected to attrite by EOL. If the set persists
  past a creep lifetime, that becomes the work item (a stranded corp
  outliving 1500t implies re-buying).
- WATCH: all 4 reservation banks read 0 (lapsed during the miner-drop
  era; reservers re-field value-ordered behind the queued miners).
  Rate halving on unreserved remotes is the transient cost; next
  capture should show banks refilling.

Day arc across the three deploys (t72478939 -> t72481270, 2331t): burn
1.0 -> 72 e/t, rclProgress +18.34 pts/t averaged INCLUDING the
catastrophe era, storage 474k -> 444k with the slope flipped from
+20.18 to -79.55. Cycle verdict: verified (all three deploys).

### 2026-07-21 (cron cycle, +425t) — ABSORB CLAMP VERIFIED; the trunk dedication fed its miners to the demotion

VERIFY-FIRST, all absorb-clamp predictions LANDED in one window
(t72480337 vs t72479912): feeder STAFFED (22-part shuttle, relayRate
108.3 = surplus 115 - absorb 6.7, linkFed d1), upgrader allocated 109.4
with inflow 108.3 (the identical share - the chain symmetric to 15
digits), targetCount 6 with the first 20W body fielded, burn 1.0 -> 7.2
e/t and climbing (P7 cleared), E4 slope +20.18 -> -10.67/t (the first
draining window since the clamp landed). The absorb-bounded clamp is
VERIFIED.

LIVE INCIDENT preempting the P5 top line: funded mining 7 -> 2 sources
(income 70 -> 20 e/t), E2 193 hauler parts stranded across the 5
remotes, candidates verdicts all "unrouted". Named from code + verdicts:
the TRUNK DEDICATION (owner 2026-07-21: dedicatedToBuild - the source's
pile fuels its road at-site, "the MINER stays funded") zeroes the
source's haul pool BY DESIGN, and the FUNDED=>ROUTED demotion
(2026-07-20, prod t72445337) - written before the dedication existed -
read that zero as rot and dropped every dedicated miner. It first bound
NOW because the link's completion moved the build pool's head to the
trunk rooms, flipping all 5 remotes dedicatedToBuild at once. The freed
ledger parts then inflated the consumer plan (10 per-site construction
sinks x the 5 e/t projectAbsorbRate floor = 50 e/t at priority 70, 42
plan WORK at the controller, tenders 99p) - downstream symptoms, one
cause. FIX (red-first, CorpPlanner.test.ts): the demotion exempts
dedicatedToBuild - the dedication IS the source's routing; only an
UNDEDICATED zero-routed source is rot (counter-pin stands). Unit 1158.
(A container restart mid-gate wiped the first pass of this fix and
killed the session cron - both re-done; the restart is the measured
argument for the server-side watchdog Routine.)

FILED (not fixed - one hypothesis per cycle): the plan's per-site
construction floors SUM (10 sites x max(5, ...) = 50 e/t demand) while
the pool's real absorb is 6.7 - the same sum-vs-pool class the consumer
clamp just fixed, now visible on the PLAN side. It only binds when the
ledger has free parts (this window's inflation was demotion-funded);
execution never over-builds (the crew reads the pool absorb). Candidate
work item for a future cycle: per-site sinks share one pool-absorb
budget in the adapter.

### 2026-07-21 (cron cycle, +487t) — LINK CHAIN COMPLETE; the boolean clamp banked the surplus - absorb-bounded fix

VERIFY-FIRST: the whole link chain landed - feeder stamps linkFed:true /
distance 1 (2-part shuttle), the swap + site + build predictions all hit.
But the E4 prediction ("slope stays negative through both phases")
FALSIFIED: bank 474k (17.2xT), slope +20.18/t, and the scoreboard names
the mechanism exactly. The pool refilled with TRUNK ROAD sites (12 sites,
3600 total work, trunk 36/38) after the link completed, so the
construction-first clamp stayed engaged: upgrader stamp planAllocated 2 /
allocated 2 / targetCount 1 / construction:true (burn 1.0 e/t measured,
P7 FAIL 0.49x), feeder stamp relayRate 7 vs surplusRate 115 - while the
build side ran 0.47 e/t measured (P8). The freed ~108 e/t went to
NEITHER sink: it banked.

ROOT CAUSE (the clamp's own math, not its trigger): constructionStanding
was a BOOLEAN - 12 road sites (pool absorb ~5 e/t by the crew's own
projectAbsorbRate lens) engaged the identical full clamp as a 100k
build-out. And the boolean form never funneled anything even in the link
era: projectAbsorbRate on the 5000-work link pool was ~5 e/t too - the
clamp freed 108 e/t of which construction could physically eat 5; the
rest banked in both eras (link-era slope was masked by a deploy-reset
window). "Funnel to construction" was implemented as "starve upgrading",
which are only the same thing when construction can absorb the flow.

FIX (red-first): ABSORB-BOUNDED construction-first. New shared lens
buildPoolAbsorbRate (ConstructionCorp) = projectAbsorbRate(total pool
work, farthest pool travel) - builderPlan's home branch extracted, so
the crew sizing, the plan's construction sink, and now the consumers'
clamp read ONE formula. Both seams take the absorb rate instead of the
boolean: feederRelayTarget serves max(plan clamp, surplus - absorb);
upgraderSizing eats the same share as its inflow. Limits preserved
bit-for-bit: absorb 0 -> unclamped actuals (t72448020 pin), absorb >=
the draw -> the plan-residual clamp (link-era pin), non-surplus
untouched (t72421124 pin). Stamps carry constructionAbsorb. Unit 1157;
trio green - gate note: runt-economy's first draw red (never upsized in
1200t); attribution run on unmodified HEAD green (upsize t460), re-draw
with the change green (upsize t460, same tick) - the cell is
draw-marginal at its tail and the change is acquitted (the fix is
surplus-regime only; that world has no storage).

Predictions (current shape: surplus 115, absorb 5, plan 2): feeder
relayRate 7 -> ~110 (neededCarry ~6, still 1 shuttle at distance 1),
upgrader allocated 2 -> ~111 / targetCount -> ~6, burn ramps as the
fleet fields (spawn-time arbitrated - producers first, unchanged), E4
slope +20 -> negative within ~2 windows, trunk build tempo UNCHANGED
(the crew's 5 e/t absorb is untouched; construction loses nothing it
was actually eating). Cycle verdict: verified (link chain) + falsified
(E4 prediction) + fixed (absorb-bounded clamp, pending verification).

First post-deploy capture (t72479912, +973t): STAMPS VERIFIED - feeder
relayRate 106.5 = surplusRate 115 - constructionAbsorb 8.49 (the pool
re-read; 11 sites), both corps' stamps carry the IDENTICAL absorb to 15
digits (one lens, no drift), neededCarry 11 / wantedFeeders 1 / gate
"demand" (buying the bigger shuttle). The fresh solve re-priced the
controller at planAllocated 9.65. Upgrader momentarily in the save-sip
(banked null, allocated 3.1): the old 1-CARRY feeder died in the deploy
generation wave, so controllerFeederActive is false until the new
shuttle fields - then the surplus regime engages at share ~106.5.
Fleet ramp + E4 slope carry to the next window's verification.

### 2026-07-21 (owner-directed) — CONSTRUCTION-FIRST SURPLUS: sites standing condition the surplus draw

Owner: "when construction is around ... the planner [should be] even more
aggressive and funneling energy to construction. Upgrading is secondary
... an investment in our future upgrading abilities ... it might
represent more hauling ... even than working." Finding: the ROUTING
ladder already delivers this - controllerValue at the RCL6 mid-grind is
~44 vs construction's 70 (the owner's own 99%-done crossover preserved
at 80 > 70) - but the SURPLUS-ACTUALS chain (daec503 + feederRelayTarget)
bypassed the plan entirely in surplus, built in a zero-construction era:
during a build burst it would relay 115/t controller-ward past the
standing sites.

SHIPPED: constructionStanding (ONE lens = buildPool nonempty, the same
pool that sizes and drives the crew) conditions both halves - the feeder
relay re-respects min(surplus, planFlow + headroom) and upgraderSizing
eats min(plan, sustainable(stock, planFlow + headroom)) while sites
stand; a construction-free surplus stays unclamped-actuals (the pinned
t72448020 behavior). The logistics half follows automatically: the
plan's construction-first allocation flows through the existing
buildEnergy / tanker / deposit-haul sizing. Pins: feeder clamp-returns,
upgrader plan-cap-returns, both with the no-construction contrast. Unit
1100; trio green. DEPLOYED.

Predictions: while the link site stands, controller allocation/burn
tempers toward the plan residual and the build side eats the difference
(link completes FASTER); when the pool empties, the surplus unclamps and
burn snaps back to actuals. E4 slope stays negative through both phases.
Cycle verdict: fixed (doctrine conditioned).

### 2026-07-21 (cron cycle, +2075t) — SWAP VERIFIED: the controller link is half-built

The whole chain executed: source-link retired (slot freed) -> link SITE
at the controller (5000 total) -> the pool crew is building it - 2483/
5000 at capture, cons 7 fielded. Feeder correctly still distance 6 (the
lens flips on COMPLETION). Expected transient swap cost visible: cd92's
buffer near-full (2.6k) while its hauling corp re-fields the hauler its
link used to replace - watch next capture.

Window softness: burn 19.7 (upgr fell to 1 again mid-window), util 0.65
across a deploy reset + generation wave, PARTS 334 (-0.09/t), bank +2.7
-> E4 re-FAIL. The structural answer to the upgrader-gap cadence IS the
in-flight chain (link frees ~42p of plan pricing -> more consumer
slots) plus spec 24 circulation. No new fix this cycle - the link
completes within ~1 window at the current build rate; then: input
election re-anchors, feeder linkFed/distance 1, P4 feeder 64p -> ~22p,
LinkRunner starts firing. Cycle verdict: verified (swap chain);
E4 carries pending the link.

### 2026-07-21 (cron cycle, +1000t) — LINK MYSTERY SOLVED: the slot table was full; the swap ships

Scoreboard: burn 39.3 (recovered - 4 upgraders/121 WORK fielding), BANK
-16.5/t (241k, 8.7xT), income 1.00x, no FAIL lines. The pool crew's
tempo read carries again (trunk 32/38; the 1W pool builder's progress
not yet visible in the gate).

THE LINK: the merged stamp was decisive by ABSENCE - no placeAttempt =>
findMissingLink nulls before placing => walked its checks against
evidence => RCL6's THREE slots are FULL: core + BOTH source links (the
plan has modeled cd90 AND cd92 as distance-1 edges since t72448186 -
the two source links were there all along; "we field 2" was an
unexamined assumption). The blanket `all.length >= limit -> null` sat
ABOVE the controller step: silent starvation, forever, no stamp.

FIX (red-first): LINK SWAP - with the table full, no controller link,
and a wanted tile, the ladder retires the source link whose source sits
NEAREST the storage (smallest haul saved; ~15:1 against the feeder's
64p pricing), stamps linkSwap, and places the controller link on the
freed slot next cooldown. The retired source's container + hauler
resume seamlessly (sourceLink/supersededByLink lenses re-read). Each
rung now guards the limit itself. Unit 1098; trio green. DEPLOYED.

Predictions: linkSwap stamp + one source link destroyed within a
cooldown; link SITE within the next; pool crew builds it (~5k); then
the feeder flips linkFed and P4's feeder line drops. Cycle verdict:
fixed (the swap) - the third patch on this rung, but each was a
DIFFERENT mechanism named by data (lens mismatch, stamp clobber, slot
table), not a re-patched bandaid.

### 2026-07-21 (cron cycle, +750t) — pool crew fielded (runt-sized, correctly); link site STILL absent - the clobbered stamp

No FAIL lines; burn recovering (25.7 from the 15.4 trough), income
0.97x, bank -9.3/t. PATH snapshot 0.3 cpu/t (quiet tick).

Build-pool verify: the HOME corp bought its first pool builder
(t72464136) - 1W1C1M@200. The absorb math sizes 1W for ~4.3k of pool
work (doctrine-correct lifetime-completion; the SUPPLY fix, not raw
WORK, is what the pool changes). Trunk unchanged at 32/38 at capture
(+360t; the builder was still walking/building - too early). Remote
corps' builder demand: none observed (attrition working).

Link-site verify: STILL absent post-same-lens-fix (~600t). The capture's
construction stamp held ONLY roadGate - and the reason is now known:
placeSite ALREADY stamps placeAttempt/placeResult, but the road gate's
whole-object lastSizing write CLOBBERED it same-tick. The evidence was
destroyed, not missing. FIX (observability): stampSizing(patch) merges
same-tick stamps from every decision site (placeSite, road gates, trunk
gate). Deployed on unit 1097 + build. Next capture names the stuck rung
directly: placeAttempt present => structure+result code; absent =>
canBuildMore false => the wants-lens chain. Cycle verdict: instrumented
(stamp merge) + pending (pool tempo, link rung).

### 2026-07-20/21 (cron cycle, +654t) — link-site stall ROOT-CAUSED: the ladder and the lens disagreed; same-lens fix deployed

Scoreboard: burn sagged to 15.4 this window (the upgrader generation gap
- fleet fell to 1 again mid-window; a fresh 20W@2300 landed t72463488 and
recovery follows), E4 re-FAILed on the sag (bank +9.8/t), income 1.00x.
PATH meter live: ~2.2 cpu/t, hauling top at 1.4 - the RouteCache rung's
named starting point.

Build-pool deploy: TOO FRESH to judge (~100t at capture; agenda still
pre-deploy). Next capture verifies builder receipts + trunk movement.

LINK-SITE STALL: classified STUCK (three captures, +1050t, zero sites)
and root-caused by code read: findMissingLink's controller step gated on
linkNear(ctrl, 3) - ANY link within 3, the CORE included (the storage
parks near the controller) - while the controllerLink lens excludes the
core. The ladder said "served", the lens said "not link-fed": a
deadlock between two readers of the same question - the same-lens trap
class, verbatim. FIX: the ladder asks controllerLink() + a pending-site
check; pinned with the exact live geometry (core at range <=3). Unit
1097; trio green (runt-economy's chain run died environmentally with no
test output - solo re-run green; today's container pressure). Deployed.

Predictions: link site within one placement cooldown; the pool crew
builds it (~5k); on completion the input election re-anchors on the
link, feeder stamps linkFed/distance 1, P4 feeder line 64p -> ~22p,
burn continuity through the handover. Cycle verdict: fixed (same-lens) +
pending (pool, link build).

### 2026-07-20 (owner-directed, immediate) — ROOM-AGNOSTIC CONSTRUCTION: one build pool per spawn

Owner: "we need them to build quicker. It's an investment... why not also
just build these roads the 'normal' way just like the ones in the owned
room?" then the principle: "It basically just doesn't matter which room
the construction is in." The distributed trunk model (each room's corp
owns its segment - the code's own comments) produced the measured stall:
empty-room corps sized 1W1C1M runts against tiny local inventories,
self-ferrying 50 energy per trip; trunk frozen at 32/38 for ~4300t.

SHIPPED task #22: buildPool(homeRoom) - every room with our sites, home
first then nearest, one work list. The home corp SIZES against the whole
pool (builderPlan: pool work, horizon travel = farthest pool room -
lifetime-completion math unchanged, just fed the true inventory), DRIVES
its crew to the pool's head room (runBuilder already handles any room -
the remote rung proved it; refuel from the route's source containers),
and demands tankers only while working home sites. Remote corps field NO
builders (repair detail + placement only; legacy runts age out by
attrition - correct class). Pins: pool ordering/summing, empty-home ->
remote head (the un-stall shape), empty pool. Unit 1096; trio green.

Predictions: builder receipts jump from @200-300 runts to proper bodies
within ~1 generation; trunk 32/38 -> 38/38 within ~1-2k ticks of the
crew landing; trunk-paved receipt -> W43N24 haulers reprice 2:1; then
trunk #2 places with a working build machine. Cycle verdict: fixed
(pending verification).

### 2026-07-20 (cron cycle, +287t) — link-site watch armed; P-CPU meter ships (task #12, the last backlog instrument)

Post-link-deploy first look: burn 39.5, BANK -30.8/t (251.9k, 9.1xT),
income 0.99x, SRCBUF drained to 1.5k colony-wide, NO FAIL lines - P4
dropped off the WARN list entirely (the tender fix's full effect). The
controller link SITE is not yet placed at +287t (home siteCount 0) -
transient-until-two-captures per protocol; next capture classifies it
(if still absent: read the ladder's gate order - the link rung may sit
behind a surplus/containersOpen gate).

SHIPPED task #12 (observability): meteredMoveTo wraps travelTo's moveTo
- CPU delta per corp FAMILY into Memory.pathMeter (tick-reset), core
telemetry v10, scoreboard PATH line (calls, cpu/t, top-3 families).
This is spec 23's measured BEFORE number; the RouteCache rung starts
from whatever family this names as the top spender. Same-behavior
wrapper (identical moveTo, identical opts) - but after the empty-lane
lesson the cold-start canary ran anyway: flow-handoff green. Unit 1093.
Cycle verdict: instrumented; link verification pending next capture.

### 2026-07-20 (cron cycle, +2954t) — tender fix + parking VERIFIED; CONTROLLER LINK ships (spec 24 rung 3)

Verify-first: per-slot tender bodies landed - P4 tender line 138p -> 62p
(0.092 -> 0.041), the FAIL cleared (0.90x). Upgrader stamp parking: 8 -
the input election is correct (the earlier "6" inference was the
co-bound targetCount, allocation/20W = 6 explains it alone). Task #18
closed verified. Income 1.00x through ANOTHER deep generation trough
(fleet 21, harv 2 mid-rebuild). ROADS 32/38, sites now visible in three
remote rooms via remoteSites.

SHIPPED task #21 (owner go-ahead): the controller link slice, all halves
in one gated deploy so a built link can never strand the (link-preferring)
input election: controllerLink lens (nodeEnergy - built link <=3 of
controller, never the core; read by ALL consumers); LinkRunner - core
fires INTO the controller link, the sink never sends (no 3%/hop
ping-pong), source links unchanged; feeder RETASK - link-fed rooms
shuttle storage -> core link (distance 1, ~1/6th CARRY; mode stamped
linkFed) instead of the 6-tile controller walk, retirement by shrinkage
not revocation; plan pricing - infraSpawnLoad gains linkFedRoomCount,
adapter counts link-fed depots via the same lens; ladder - controller
link placed between core and source links at the best structure-free
range-2 park-ring tile; controllerSideStock counts link stores (upgrader
sizing reads the link as stock). Pins: 4 network + harness. Unit 1091,
trio green.

Predictions (the link needs ~5k build after placement, so staged):
next capture - a link SITE within range 2 of the controller (ladder);
after build - feeder stamp linkFed:true/distance 1, P4 feeder line
64p -> ~22p, controller stock reads the link, burn continuity through
the input handover (upgraders re-ring the link tile). Cycle verdict:
verified (tender, parking) + fixed-pending-verification (link).

### 2026-07-20 (cron cycle, +653t) — P4's FIRST FAIL: tender mass tipped the plan; per-slot bodies land

Scoreboard: burn 33.4 (upgrader generation dip - staffing back to 1 of 6,
replacement demanded@2300), BANK -9.2/t, income 1.00x, ROADS
trunk-building-32/38 (+1 tile, 4 sites left in W43N24).

P4 FAILED for the first time: 1.05x ceiling, and the breakdown names the
driver - tenders 138p = 0.092 parts/t (3x46p bodies, each sized to the
BIGGEST cluster for a 2300 bank at maxCarry 23). The design's two
measured incidents (per-cluster deadlines; one-wave coverage) never had a
budget term, and capacity growth inflated every body to near-max. FIX
(red-first, tenderSlotCarry pure seam): slot k sized for ITS cluster
(clusters[k % len], the same pairing runTenders walks) with an
equal-share-of-one-wave floor - live shape 22/9/9 -> carries 23/16/16 =
110p (0.073), plan back under ceiling (~0.99x). Both incident guarantees
pinned (one-trip-per-cluster, combined >= bank).

Input-election verify (t72459426): INCONCLUSIVE-leaning-correct - home
siteCount 0, stock/burn continuous, no adverse effects; either the
hysteresis kept a good-enough incumbent (ring within 1 of best) or the
container budget blocks. `parking` joins the upgrader stamp (ride-along)
- next capture reads 8 (migrated/kept-good) vs 6 (kept-clipped = election
bug) directly. Gate: unit 1087, trio green. Cycle verdict: fixed (P4,
pending verification) + instrumented (parking).

### 2026-07-20 (cron cycle, +560t) — ROADS ANSWERED: trunk-building-31/38, zero blind rooms; spec 24 rung 1 SHIPPED

Verification of the v9 observability on its first capture: ROADS gate
trunk-building-31/38, remoteSites W43N24:5, NO blind rooms - the owner's
objection fully validated; the first trunk is 82% built with crews
working, and "waiting-vision" was pure misnomer. Task #20 closed.
Scoreboard: burn 47.6 held through another generation trough (fleet 20,
mass 0.82), BANK -37.4/t, income 1.00x, the cedc under-haul self-
resolved (3.1k -> 0). No FAIL lines.

SHIPPED task #18 (spec 24 rung 1, live-behavior, full gate): the input
election. controllerInputSpot now scores an existing container's park
ring against the best fresh range-2 candidate and keeps it only within
1 tile (hysteresis); links are never migrated from; among coexisting
containers the best ring wins (no flap mid-migration). A displaced
controller container leaves the maintenance rolls (displacedInputContainer,
mirroring link-superseded; source containers on tight maps exempted).
findMissingControllerContainer already wants the container at the
migrated bare spot - the ladder places it, the fleet re-anchors pile-fed
meanwhile. Pins: 3 election + 1 rolls; unit 1083; trio green (pipefail).

Predictions (next capture): home siteCount +1 (the new container at a
range-2 tile), upgrader stamp parking 6 -> 8 (count stays 6 - allocation
co-binds at ceil(116/20)), burn continuity through the re-anchor (a
transient dip during the pile transition is acceptable; a sustained drop
is a regression -> revert), legacy container unmaintained. Cycle
verdict: verified (#20) + fixed-pending-verification (#18).

### 2026-07-20 (cron cycle, +473t) — trunk stamp disambiguated; the ledger learns to see remote sites (v9)

Scoreboard: burn 50.0 e/t (still climbing; 3 upgraders / 97 WORK), BANK
-13.4/t, income 0.99x, no FAIL lines. Two remote buffers near-full
(cedc 3.1k, cbd5 2.3k) - under-haul watch.

Shipped task #20 (observability, owner-driven): the owner refuted the
"trunk-waiting-vision" reading - the remotes are MINED, vision was never
the blocker; the stamp fired on placed=0 which conflates "tiles in a
blind room" with "fully placed, crews building". placeTrunkSites now
returns a pass survey (placed/built/total/blind[]) and the gate stamps
trunk-placing-N / trunk-blind-<rooms> / trunk-building-X/Y
(trunkGateFromSurvey, pinned). Telemetry v9 adds remoteSites (our sites
in visible unowned rooms) - P8's owned-room ledger was blind to
cross-room paving; audit:report gains the ROADS line.

Predictions for the next capture: the ROADS line names the true trunk
state - expected trunk-building-X/Y with remoteSites>0 in the trunk
rooms (the building-in-progress hypothesis); trunk-blind-<rooms> would
instead confirm a genuinely blind corridor and name it. Either way the
next fix is data-driven (builder throughput vs scout-on-demand vs the
one-project serialization). Cycle verdict: instrumented.

### 2026-07-20 (cron cycle, cont.) — task #16 FALSIFIED as a regression: the cell is draw-marginal; baseline corrected

Bisection of plan-t5-remote-pipeline's extensions-refill invariant: RED at
HEAD (@1233/1239/1285), RED at 82c212c (@1118), RED at 7efe6c2 (@1292),
and RED AT THE RATCHET COMMIT 3a9116c ITSELF (@1199). Five draws, four
commits, one invariant - there is no first-bad commit; the baseline's
"pass" was a fail-tail draw recorded as truth (the multi-draw rule
applied to grid ratchets: an always:-invariant near its tempo margin is
NOT grid-pinned-deterministic). Earlier framing ("regression on deployed
HEAD", the retirement cycle) is corrected: acquittal of the retirement
stands, but nothing regressed - the cell was never reliably green.

Baseline: plan-t5-remote-pipeline pass -> fail (honest ratchet; BOT LEVEL
unchanged at 4 - T5 was already the frontier). The REAL work item filed:
the T5 world's extension-refill tempo is genuinely marginal (~t1200
failure across all draws - tender fleet lags the draining spawn once the
extension set grows). Either raise the tempo (tender sizing/timing at
that stage) or give the invariant a doctrine-justified refill-lag
tolerance - a design decision, not a patch. Cycle verdict: verified
(feeder chain closed, bank draining) + falsified (#16-as-regression).

### 2026-07-20 (cron cycle, +1004t) — BANK SLOPE NEGATIVE: the consumption chain is whole; generation boundary passed clean

Verification of the feeder deploy, final: burn 19.0 e/t (predicted 18+),
controller stock 2000 -> 2000 under that burn (relay pacing exactly),
feeder 2 shuttles / relayRate 115 / staffed, upgraders 2x(20W,15W) = 35
WORK with demand "demanded" toward targetCount 6. BANK -2.8/t over 1004
ticks - the first draining window since the loop began; E4 no longer
FAILs (slope condition). SCORE 2.0 -> 19.0 e/t across the three-cycle
chain (goal-plan cap -> feeder clamp -> ramp). A lifecycle generation
boundary passed mid-window (22 creeps from 33, same mass in bigger
bodies) with ZERO remote drop - the gate retirement verified in live
fire against the exact scenario of both incidents. NOTE: targetCount 6
is co-bound (parking 6 AND ceil(116/20W) = 6) - spec 24 rung 1 buys
overlap headroom near-term, not count; scheduled, not urgent (~1500t).

No FAIL lines. Cycle verdict: verified (chain closed); work item = the
backlog's standing regression, task #16 plan-t5-remote-pipeline
extensions-refill invariant (red on deployed HEAD, ratchet violation) -
bisection this cycle.

### 2026-07-20 (cron cycle, +356t) — FEEDER FIX VERIFIED: relay 7 -> 115, stock refilled; burn ramp in flight

Verify-first on the feeder surplus deploy (~t72455600, capture t72455711):
every immediate prediction hit. Feeder stamp: relayRate 7 -> 115 (planFlow
still 2 - the clamp correctly ignored in surplus), neededCarry 39,
wantedFeeders 2 with the second shuttle DEMANDED (gate "demand").
Controller stock 60 -> 2000 (P7) - the buffer refilled within ~110 ticks
of the deploy. The demand-verdict instrument works and answered last
cycle's mystery by dissolving it: upgrader stamp reads demand "demanded"
/ demandMin 2300 / staffing 1, and the receipts show upgrader@1750 bought
t72455628 (the old 20W died end-of-life mid-window; the no-demand read at
t72455355 was almost certainly the replacement-lead staffing transient -
if it re-sticks the verdict now names the exit).

Burn: 5.0/t window average - a mid-ramp read (starved early window, old
upgrader died, replacement landed t72455628). The 18+ prediction and the
BANK slope flip (13.4/t, barely bent from 14.0) carry to the next window
with the fleet growing toward targetCount 6. Income 70/70 routed (1.00x),
P1 stable, E2 8 parts, fleet 28 -> 33.

No new fix this cycle: E4's mechanism is the in-flight ramp; a deploy now
would global-reset it mid-measurement. Watch: 3 reserver buys in 250t
(1/83t vs 1/150t sustained - reading as bank catch-up, P5/P6 ok); P-CPU
instrument (task #12) queued for a post-verification cycle. Cycle
verdict: verified (partial - burn ramp pending next capture).

### 2026-07-20 (cron cycle, +6859t window) — GATE RETIREMENT VERIFIED LIVE; the feeder was the burn bottleneck

VERIFY-FIRST (t72455355 vs t72448496, the loop's restart-downtime window):
the retirement + lane-revert deploy VERIFIED on every prediction - core v8
with NO remoteGate field, P1 0 flips across ~4.5 lifecycle generations
(the remote-drop class is measured extinct), income 70 funded / 68.9
routed (0.98x) held, E2 52 -> 8 parts. SCORE 2.0 -> 11.2/t (5.6x): the
actuals-sizing ramp came through - partially.

TOP LINE E4 (bank 340k, 12.3xT, +14/t) mechanism named from stamps: the
upgrading corp sized itself allocated 115 / targetCount 6 (actuals, per
daec503) but fielded 1x20W burning ~11 - because its SUPPLY LINE still
read the goal plan: the plan's parts ledger exhausts before the
controller sink (allocated 2, partsLeft 0), and ControllerFeederCorp
clamped relayRate = min(surplus 115, planFlow 2 + 5) = 7 -> a 3-CARRY
feeder -> controller stock drained 1520 -> 60. The consumption chain's
two halves read DIFFERENT inflows: upgraders assumed the surplus 115 the
feeder never delivered.

FIX (red-first, feederRelayTarget pure seam): in SURPLUS
(bankSurplusRate > 0) the relay serves the raw surplus formula - the
same inflow the upgraders' sizing assumes; the plan clamp stays the
NON-surplus rule. The t72421124 pin (94-part feeder into a full stock)
rewritten to its post-daec503 form: that mismatch class cannot occur in
surplus anymore (consumers size UP there), so the clamp's guard lives in
the save regime - pinned both ways. ALSO instrumented (invisible-cause
rule): the upgrader demand-exit verdict (demand: demanded/staffed/
swarm-cap/unaffordable + cap + staffing + demandMin) joins lastSizing -
targetCount 6 emitted NO agenda demand at t72455355 and which exit
swallowed it was unreadable; next capture names it.

Gate: unit 1077, trio green (pipefail). Predictions: feeder stamp
relayRate 115 / wantedFeeders ~2, controller stock 60 -> ~2000, burn
11.2 -> 18+ (the fielded 20W unthrottled) then fleet growth per the
demand verdict; BANK slope +14 bending down. Cycle verdict: fixed
(deployed) + instrumented (demand verdict).

### 2026-07-20 (cron cycle) — GATE RETIRED (owner doctrine); empty-lane pathing reverted by bisection; gate-runner masking incident

VERIFY-FIRST (t72448496 vs t72448186, dt 310): the queued-orders gate fix
RECOVERED PROD in one window - income 20 -> 70 e/t funded, routed 69.1
(0.99x, all 7 sources), P1 0 flips, E2 238 -> 52 parts (only the four
pre-existing scavenge micro-corps), fleet +0.14 p/t. Verdict on the
previous cycle: fixed AND verified.

OWNER (mid-cycle): "Shutting down remote mining doesn't help. Maybe
defunding it (not spawning more creeps for it) but this type of rule you're
explaining tends to backfire. It's a bandaid." Concur - two incidents
(t72444963, t72448082) both trace to the gate's REVOCATION semantics, and
both fixes patched the rule rather than the harm. THE GATE IS RETIRED:
remote sources enter the pool unconditionally; home-first sequencing lives
where it already works (spawnPriority strict tiers - blocking home income
outranks remote scaling, so a distressed home starves remote SPAWNING
without touching remote operations). Removed: homeEconomySaturated, the
500t sticky window, Memory.remotesUnlockedUntil, Memory.remoteGate,
telemetry core v7 gate record (v8). Pinned: remote claims survive a fully
unstaffed home (refreshNodeResources.test.ts); cold-start breadth tax
pinned by plan-t5-remote-pipeline.

INCIDENT (found by this cycle's gate run): flow-handoff RED - and
attribution showed it red on DEPLOYED HEAD too. Root cause of the mask:
every deploy chain today gated on `mocha | tail -N` - the PIPE's exit
code, not mocha's - so integration failures shipped silently. Fixed
process: `set -o pipefail` on every gate chain from now on. Bisection
(880a191 GREEN -> 82c212c GREEN -> c81a34c RED, phantom-guard half
acquitted by surgical file revert): the EMPTY-LANE travelTo branch
deterministically prevents a newly spawned hauler from completing its
maiden trip (green t500: hauling 4/10, energy 110; red t500: hauling
0/10, energy 37 - same world shape, same exec cadence). REVERTED. The
doctrine (measured physics: wear = body.length/step load-independent,
swamp free when empty) stands and returns as spec 23 RouteCache lanes
with a mockup-verified implementation.

ACQUITTED-BUT-OPEN: plan-t5-remote-pipeline [x] @~1233/1800
always:"extensions refill before the draining spawn finishes" -
IDENTICAL on unmodified HEAD, so it is a pre-existing regression of a
deployed build (baseline says pass; one of today's earlier deploys or an
older ratchet gap). Filed as its own incident - next cycle's candidate
work item.

Cycle verdict: fixed (gate retirement + lane revert deployed together);
predictions - cold-start hand-off restored (trio green pre-deploy), prod
steady-state unchanged (the removal is inert while home is staffed:
verified plan identical in the probe), no remote-drop class recurrence at
generation boundaries (the class is structurally gone).

### 2026-07-20 (cron cycle) — REMOTE-DROP #2: the gate flapped on a lifecycle-clustered wave; queued orders now count as staffing

Verify-first (t72448186 vs t72448020, dt 166): the actuals-sizing deploy
VERIFIED plan-side - controller sink demand 2 -> 121.6 e/t, allocated 63
WORK (the goal-plan cap is gone) - but execution has not followed (1
upgrader, burn 2.0/t, BANK +21.6/t) because the window's live incident
preempted it: P1 FAIL 5 sources funded->DROPPED, E2 FAIL 238 parts
stranded, income 46 -> 20 e/t (2 home sources only).

Full chain from stamps (agenda receipts + remoteGate): last fully-staffed
tick t72447582 (gate `until` 72448082 - 500); both home miners AND the
cd90 micro-hauler hit end-of-life within ~100t (lifecycle clustering);
the re-staffing wave interleaved a guard@650 and a starved-tier
(age 306 >= 300) remote cee0 scale hauler @2150 with a 129-tick build -
bought at t72448101, ~20t AFTER the sticky expiry, for a route already
being dropped - while the blocking cd90 hauler @100 (mustFund, since
t72448044) waited behind it. Wave exceeded the 500t sticky window ->
gate relocked -> all 5 remotes dropped. The recurrence risk is
structural: the home fleet is born in waves, so every ~1500t generation
boundary threatens a repeat.

FIX (this cycle, red-first in refreshNodeResources.test.ts): the gate's
staffing lens also reads Memory.spawnAgenda queues - a source whose
mining/hauling corp has a QUEUED order is mid-replacement, not dark
(trap-list: durable signals; same family as recycling-counts-as-
staffing). Corp ids resolved via new harvestCorpId/carryCorpId exports
(single naming source). Guard pin: foreign orders do not satisfy the
gate. Predicted deltas: gate saturated:true through the next wave, P1
back to 0 flips, E2 drains as stranded corps re-attach, income ~46 e/t,
and the upgrader ramp (still pending verification) proceeds on the
refunded plan. Watch items: starved-tier one-shot can still spend a
2150/129t body ahead of blocking income (own cycle if it recurs);
prod self-heal of THIS instance expected ~t72448260 even unfixed (cee0's
dropped corp stops demanding, cd90 hauler reaches head). Cycle verdict:
fixed (pending post-deploy verification).

### 2026-07-20 (cycle 3, cron loop) — X3 CLOSED: the tankers were invisible; sizing deploy verified

Verify-first (t72446096, +279t over the sizing deploy's reset): routing held
(P9 0.91x, P1 stable 0 - the durable receipt carried remotes through their
SECOND live reset), E4 -11.45/t sustained (storage 210.4k), the extension
closed 180->2970 at 10 e/t from stock with plan alloc 0.0 - consumers
priced out by parts while actual build ran from build-side stock, the
doctrine working as designed. Zero runt receipts.

countMismatch's FIRST capture named X3 exactly: building-W43N23-construction
claimed 4 / counted 2 - ConstructionCorp.getCreepCount returned only the
builders squad; its TANKER detail (same corpId, workType "tank") was
invisible to the census. Fixed census-only (demand sizing reads the squads
directly - caller audit: only Telemetry + Colony.getStats consume it),
pinned in builderSizing.test.ts. The second row (hauling-W44N23-cbd5
claimed 2/counted 1) is BENIGN: Squad.members() excludes mid-spawn creeps,
so a replacement in the spawn shows +-1 for its build duration - expected
census noise, not a leak. Predicted post-deploy: untracked 3 -> 0 (with
transient +-1 during spawns), countMismatch rows only for in-flight
replacements. Verdict: **fixed** (X3), sizing deploy **verified**.

### 2026-07-20 (cycle 2, cron loop) — production-first parts ledger: VERIFIED; X3 narrowed to a counting lens

Cycle t72445337: the fresh solve after the absorb-cap deploy exposed the
next layer — the sink fill spent ONE parts ledger in pure value order, so
the mined-income deposit routes (storage hub, value 1) went LAST: consumer
routes + the upgrade WORK charge drained partsLeft to 0.0 and all SEVEN
funded sources got zero haul routes (P9 0.0x, 70 e/t rotting, 78 body
parts stranded) while the plan read feasible (P4 0.83x) precisely BECAUSE
the routes were missing. Energy pools were never in conflict (consumers
draw the bank, deposits fill the hub — disjoint by role); only PARTS were.
Fix: spawn overhead first, then deposits, then consumers burn the residual;
plus FUNDED⇒ROUTED (a source whose deposit gets zero parts demotes to the
new "unrouted" verdict and fields no miner). Pinned red-first (stash-
verified); trio green; deployed.

**Verified t72445817 (+480t):** P9 0.0 → 0.88x (6 routes standing, 52.6/60
e/t moving), the demotion live and honest (4adbcedc funded→unrouted — the
tail the spawn genuinely cannot route), E2 78 → 18 parts (haulers
re-attached; the remaining 3 are the legacy scavenge-route corps), E4 slope
−19.8/t sustained (storage 228.7k → 213.6k today), P7 actual 19.5 e/t
(2.0 at day start), spawn 0.95 util with zero runt receipts. remoteGate
stamped live: {saturated: true, until: 72446299} — the durable receipt +
decision record close the warmup remote-drop class end-to-end. Verdict:
**fixed, verified**.

X3 (3 untracked) narrowed by instrument: the unattributed roster came back
EMPTY with untracked=3 — every creep's corpId resolves, so corps exist
that do not COUNT creeps they own (the newborn/recycling counting-lens
class, not orphans). Next instrument (countMismatch: claimed-vs-counted
per corp) ships with the lifetime-sizing deploy and names the kind.

### 2026-07-20 — E4 idle capital: the construction absorb cap; the warmup remote-drop NAMED

Cycle t72444684 (ledger TOP LINE E4): storage 228,749 = 8.3x the 27,650
warchest target, slope +7.66/t with `feederActive true` — the spend path ran
but nothing burned. The capture named the misroute end-to-end: construction
sink demand 455 = the adapter's supply-shaped capacity (355 minedSupply over
ALL 38 graph candidates — 285 e/t of it PHANTOM unfunded intel sources —
plus the bank's MAX_SURPLUS_DRAW 100; the adversarial review corrected the
first-pass 70+385 arithmetic), priority 70 over the RCL6 mid-grind
controller's 43.9, allocated 124 e/t against ONE extension site holding 400
build energy (absorbable <10 e/t; measured burn 0.45 e/t). The controller's
2 e/t was exactly the ANTI_DOWNGRADE_RESERVE pre-pass — its value-pass fill
never executed a take (partsLeft byte-identical to construction's), so the
freed draw had exactly one taker. Fix (fc2b181): the corp's sum-of-projects
lens moved to primitives.projectAbsorbRate (crew formula verbatim) and the
construction sink capacity min()s it in — a 455-energy site now rates 5 e/t,
a 15k build-out still rates 150 (spec 10 G6 valve intact). Deployed
t~72444870. **Verified t72444963/t72445067:** construction plan alloc
124→5.0, controller alloc 2→105 (plan WORK 112p ramping, upgrader@2100 in
the agenda), E4 slope +7.66 → **−23.49/t** (FAIL→WARN, the warchest finally
draining into score). P7 0.03x is the fleet ramp lag — upgrader bodies trail
the plan by spawn time.

Same deploy's global reset exposed and NAMED the long-unattributable
**warmup remote-drop** (the assembly counters existed for exactly this):
graphSources 38→2 — the GRAPH layer, not the solver. Mechanism:
homeEconomySaturated's 500t sticky unlock lived in heap only; the reset
re-evaluated the home-first gate cold, and its live creep-memory lens (the
documented creep-position trap class) hit an ordinary mid-replacement home
hauler gap (the buy was already in the agenda) — ALL remotes relocked, 5
funded sources dropped, 94 body parts stranded, reservers still burning
(P5). Fix: the sticky window persists in Memory.remotesUnlockedUntil (heap
stays the fast path; the receipt survives resets), pinned red-first in
refreshNodeResources.test.ts with the counter-pin that an absent/expired
window still relocks (the home-first gate itself stands). Verdict: E4
**fixed** (verified by slope reversal); remote-drop **fixed for future
resets** (the live relock clears when the gate's staffing check passes —
watch the next capture for graphSources 38 and the refund). Next cycle's
TOP LINE: P5 reserver duty 1.0 vs priced 0.5 (the corp never reads
reservation.ticksToEnd), plus the phantom minedSupply term the review found.

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

**ROLLBACK VERIFIED t72429276 (~230t post-redeploy).** The two regression
indicators reversed cleanly: eAvail 504→**1250** (spawn funded again),
bankHaul 0→**2** (bank draw restored) — a clean A/B/A that confirms part-1
as the cause and the rollback as the cure. util is still climbing back
(0.30 vs the settled 0.86) as the fleet, died-back over ~3000 starved
ticks, rebuilds after the global reset; the cron monitors recovery. Root
cause fully diagnosed and reproduced; the doctrine-level fix awaits owner
review. flowAdapter:302-305 already flags the same "unhauled piles
inflating supply" class (it guards FLEET SIZING via minedSupply but the
transient stocks still join the ROUTING supply at :310, which is what
suppresses the bank) — the double-count fix belongs there.

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

**Audit cycle t72429334 (routine fire) — recovery CONFIRMED, no deploy.** The
rollback colony is actively REBUILDING from the died-back state: executed
receipts show builder+tanker+3 haulers+miner in ~140t, fleet 152 parts and
growing, funded by the restored bank draw (eAvail 1011, bankHaul 2). Ledger
top line P4 (137 e/t controller plan → infeasible) and S3 (head corp cd90
unbuildable post-reset) and feederActive=false are transient re-forming
artifacts, NOT the #18 basin — the spawn is demonstrably building. An active
NPC raid (attack 5, guard campaign) is being handled. No fix, no deploy: the
deployed code is proven-healthy pre-batch and the doctrine fix stays deferred
to owner review. Monitor next cycle for return to the pre-batch level (7 src,
util ~0.86, feeder on, storage draining).

**Audit cycle t72429680 — recovery ~complete, no deploy.** Producers rebuilt
(2→7 sources, util 0.33→0.70, feeder back ON, ctrlStock 162→1014, P4/S3
resolved). Consumers next: upgrader corp demands 4 (targetCount 4, alloc 45.8,
banked 455k) but 0 fielded yet → P7 0 and E4 warchest +28/t are the transient
tail of a producers-first rebuild (pre-batch the same code ran 6 upgraders and
drained the warchest -44.5/t). Doctrine fix still owner-deferred.

**#19/#21 FIX DEPLOYED (2026-07-19, owner "Yes go").** Gate green: unit 965,
build clean, trio (flow-handoff/runt-economy 11m/storage-depot) 1 passing each,
8/10 targeted grid cells [P] (haul-t4-bank-surplus-upgrades + storage-bank-and-
spill + plan-t2 sink-source all green; the 2 non-pass are the pre-existing
plan-t5 refill-SLA (#9) and the 160t-boundary feeder cell, both acquitted).
The fix = the proven-healthy ROLLBACK routing (nearest-first) + #21 controller
cap + part-2A storage-open + roads-2 + repair. PREDICTED live deltas vs the
rollback: spawn STAYS FUNDED (eAvail healthy, NOT 504 - same nearest-first as
rollback); mined production routes to STORAGE (P9 high, mined->storage haulers);
P4 FEASIBLE (controller capped at ~physical rate, no 137 e/t plan); warchest
stabilizes; controller progresses at the capped rate. REGRESSION RULE (last
#19 deploy starved the spawn): if eAvail collapses to ~500 or bank haulers ->0
or util craters, REDEPLOY 76646e5 immediately. Two-capture verify (that rule
caught the last regression).

**#19/#21 FIX VERIFIED (t72430762 -> t72430951, dt 189) - SUCCESS, no
regression.** The two-capture rule (which caught the part-1 regression on its
SECOND capture) confirms the spawn HOLDS funded: eAvail 512 -> 1100 (ROSE, not
the stuck-504 starvation), bankHaul 3 both, util 0.71->0.44 (fleet near-complete,
not idle-starved), 6 upgraders online. #21 working: controller plan 85->81
(physical cap, never the 137). Controller progresses ~41 e/t (vs ~2 pre-fix) and
the WARCHEST DRAINS -38/t (438826, E4 finally easing) - the capped controller
lets the upgraders feasibly burn the surplus. Healthier than the rollback
(ballooning warchest, +2 e/t) and the part-1 regression (starved spawn).
RESIDUAL (follow-ups, not blockers): P9 0.33 - 4 of 7 FAR sources still
drop-and-scavenge (nearest sources fill the capped controller first; the far
ones lose the nearest-first race and the controller cap 85 > supply 70 so
storage overflow never activates to route them). The energy is consumed via
scavenge, not rotting - a decay-loss efficiency gap (the deferred double-count),
not the acute #19 rot. S3 stall is the known false-positive (spawn funded at
1100, building; near-equilibrium). Next: dedicated-haul the far sources (lower
the controller cap toward true demand so mined surplus overflows to storage,
OR kill the scavenge double-count so the far miners get haulers).

**REMOTES-DELIVER-HOME FIX DEPLOYED (2026-07-19, owner directive).** Gate
green: unit 966, build clean, grid 8/9 (home scavenge cells churn-retiring-
scavenge-corp + haul-t2-scavenge-threshold PASS - only remote scavenge removed;
fid-t4 fidelity + surplus/storage cells pass; the 1 red is plan-t5 pre-existing
refill-SLA #9), trio (flow-handoff/runt-economy 13m/storage-depot) 1 passing
each. The fix (owner: stop overcomplicating): (1) scavenge OWNED rooms only -
a remote container was being summed into a scavenge stock and siphoned, so the
remote never got its own haul-home; (2) production-first for CONSUMER sinks so
remote mined delivers to the controller instead of losing the nearest-first
race to the home bank. Spawn stays nearest-first on the near bank (no starve).
PREDICTED live deltas: P9 up (dedicated source-haulers for remotes appear),
remote energy reaches the controller, warchest bleed SLOWS (remote income now
offsets consumption instead of pure savings-spend). REGRESSION RULE: spawn
eAvail ~500 / bankHaul 0 / util crater -> redeploy prior bundle. Two-capture
verify.

**REMOTES-DELIVER-HOME FIX VERIFIED (t72434228 -> t72435669, dt 1441) —
SUCCESS, direction confirmed, no regression.** The fix delivers exactly its
predicted deltas:
- **P9 CLIMBED**: carry corps 6 -> 9; dedicated source-haulers now serve 5
  mined sources (cd92, cd90, cee0, cd8e, cedc) vs 2 pre-fix. Remotes deliver
  home — the acute owner complaint ("we're not getting energy home from our
  remotes") is resolved.
- **Scavenge siphon dead**: the scavenge-W42N22 hauler (9 carry stealing a
  remote's own energy via the container double-count) is GONE from the plan.
- **Controller progresses**: GCL/RCL progress +60645 over 1441t = **+42 e/t
  actual** into the controller (real score).
- **Spawn stays funded**: util 0.76 -> 0.94 (high, NOT the cratered ~0 of the
  part-1 regression), bank->spawn hauler present, feederActive true. The
  regression rule (eAvail ~500 / bankHaul 0 / util crater) did NOT trip.
- **Warchest 248k -> 193k (-38/t)**: bleed SLOWED vs the pre-fix short-window
  (-59/t). Still draining the 165k surplus toward the 27.6k target. This
  residual drain IS the hybrid routing artifact: the deployed plan hauls mined
  DIRECTLY to the controller (all 5 source-haulers target controller-cd91), so
  storage sees ~0 mining income and drains feeding the spawn. True hub-and-spoke
  (mined -> storage -> consumers) routes income THROUGH storage, making the
  warchest the true net buffer. That is the next refactor (owner directive).
- **Transient noted**: colony claim 10 -> 0 (reservation corp INTACT at 1, its
  creep mid-rebuild), which depressed totalHarvest 270 -> 170 in this one
  capture. CPU/bucket healthy (10000, used 75/300). Second capture pending to
  confirm harvest recovers as the reserver respawns.

Verdict: **FIXED** (remotes deliver home, no regression). Follow-up (owner
2026-07-19): refactor to clean hub-and-spoke — all mined -> storage hub, all
consumers sized to and drawn from the warchest, drop the production-first /
filling-vs-surplus regime gates. This makes the warchest the true income buffer
(mining surplus banks instead of bypassing storage) and removes the special
cases.

**HUB-AND-SPOKE REFACTOR (2026-07-19, owner directive).** Replaces the
production-first / filling-vs-surplus routing gates in routeToSinks with ONE
uniform rule keyed on source ROLE (owner: "it can still be hub and spoke and
probably it's better that way", "size the consumers to the warchest", "the
routing doesn't change the overall energy flow balance"):
- when a storage HUB exists, mined + scavenge are DEPOSIT sources - their only
  home is the storage sink, so each funded source gets its haul-home (the
  miner+hauler package deal) and the warchest becomes the true income buffer;
- the bank/hub is the SPEND source - consumers (spawn/controller/construction)
  draw the warchest, sized to it. Mined never routes to a consumer directly;
- pre-storage (RCL<4, no hub) nothing is a deposit and mined feeds consumers
  directly - the old model, preserved (there is no bank source without storage).
The structural anti-pump (bank never deposits to its own store) now falls out
of the roles instead of a special-case filter. flowAdapter bumps the bank/hub
SOURCE rate to minedSupply + surplus (income passing THROUGH the hub) so
consumers are fed even at/below target where the surplus alone is ~0;
bankRate/totalSupply stay the REAL supply (surplus only) for infra/construction
sizing and the storage-full defund. WHY: the hybrid hauled mined DIRECTLY to
the controller, so storage saw ~0 income and bled feeding the spawn - the
warchest drained (-31/t at t72435896) even though remotes now deliver. Routing
income through the hub makes the warchest reflect true net (income - consumed)
without changing the total balance.
GATE: unit 967, build clean, trio (flow-handoff 4m / storage-depot / runt-
economy) pass, routing cells [P] (bank-surplus-upgrades, storage-bank-and-spill,
ctrl-container-surplus-first, feeder-fields-for-bank, fid-t4-preramped all 1/1).
PREDICTED live deltas: mined haulers now target STORAGE (flow haulers source-*
-> storage-*, not -> controller-*); bank/hub source rate inflates; warchest
FLIPS from draining to holding/growing (mined banks instead of bypassing);
controller actual ~unchanged (upgraderSizing reads controller-side stock +
feederRelayRate, both invariant to the routing change); spawn stays funded from
the hub. REGRESSION RULE: controller score drops < ~35 e/t, OR spawn eAvail
~500 / bankHaul 0, OR warchest keeps draining hard (< -30/t = hub routing did
not take) -> redeploy origin/master. Two-capture verify.

**HUB-AND-SPOKE POST-DEPLOY CAPTURE t72436467 (8 min post-deploy) - ROUTING
CONFIRMED, income crater is a RESET TRANSIENT (not a regression).** Snapshot
metrics (reset-independent) confirm the refactor took: mined + scavenge haul to
STORAGE (5 haulers ->storage), the bank/hub funds consumers (controller/spawn/
construction), and P9 climbed 0.54 -> 1.0 (all funded mining routed via
dedicated haulers). BUT the deploy's GLOBAL RESET wiped the in-heap node/intel
cache: assembly.graphSources dropped 38 -> 2 (3 pre-deploy captures all pinned
38), so only the 2 home sources remained in the graph and funded=7 -> 2,
minerCount 7 -> 2 (harvestCorps still 7 - the miners are physically alive, their
sources just dropped from the plan). This is the documented sim blind spot
(sims never lose vision; global reset is LIVE-only) and recurs on EVERY deploy -
prior deploys recovered to funded=7 within ~15 min. The remote haulers whose
sources dropped stranded transiently (E2 70 -> 126, membership = the dropped
remotes cee0/cd8e). P7 -2103 e/t is a metric artifact (controllerStock 1920 ->
1970, "stock stood - the energy was there"). E4 slope -23.77/t is BLENDED across
the deploy midpoint (uninterpretable). NO ROLLBACK: transient, warchest 172k is
a huge buffer, controller holds ~24 e/t on stock. The clean warchest/controller
measurement is DEFERRED to a post-recovery capture (graphSources back to ~38,
funded ~7); until then hub-and-spoke's real E4/P7 effect cannot be read.

**HUB-AND-SPOKE VERIFIED (t72436467 -> t72436606, post-transient window dt 139)
- WARCHEST FLIPS TO GROWING.** The core owner goal ("stop spending our
savings") is met: storageE slope 172257 -> 175250 = **+21.5/t GROWING** (vs the
pre-deploy -31.6/t bleed). Routing holds (mined + scavenge -> storage, bank/hub
-> consumers), P9 0.54 -> 1.0. Measured DURING the post-reset transient (only 2
graph sources), so the flip is if anything understated - at full income it grows
faster. The controller still progresses (~12.9 e/t in-window, income-limited by
the 2-source transient), controllerStock stood (1920 -> 1970). NO REGRESSION.
GRAPH-AT-2 EXPLAINED (not hub-and-spoke, not new): the deploy's global reset
wiped the territory cache -> main.ts:264-274's documented "remote mining
silently stops" state -> the forced terrain pass rebuilds territories and
re-claims the remote sources over the analysis window. graphSources 38 -> 2,
flat across two captures (8 & 19 min); 7 harvest corps + scout + reserver all
alive (Memory-persisted), the 5 orphaned miners' output reaches storage via
scavenge (why the warchest grows despite "2 funded"). Self-healing; a
recovery-trend capture (~40 min post-deploy) confirms graphSources climbing back
toward 38, at which point the full-income warchest slope + controller e/t get a
clean re-read. NOTE (follow-up, pre-existing): every deploy triggers this
terrain-rebuild income dip - a real per-deploy cost worth quantifying, and a
plausible contributor to the historical warchest drain given this session's
deploy frequency.

**HUB-AND-SPOKE FULLY VERIFIED AT FULL INCOME (t72436969, ~40 min post-deploy).**
The reset transient self-healed: graphSources 2 -> 38, funded 2 -> 7, minerCount
7 (main.ts:264's forced terrain pass rebuilt the territories exactly as
designed). storageE across the post-deploy window: 172257 -> 175250 -> 177521 =
warchest GROWING (~+15-21/t) vs the -31.6/t pre-deploy bleed - confirmed now at
full 7-source income, util 0.87. The owner's core goal (stop spending savings)
is met and holds at full income.

**PRE-STORAGE CONTAINER-HUB ATTEMPT - REVERTED (owner 2026-07-19 "central base
accumulator").** Built the deposit side (FlowGraph promotes the central base
container to a promotedHub storage-role sink when no real storage; adapter
excludes promotedHub from the warchest save-regime/defund so a 2000-cap
container can't pin the controller). Unit test green (mined banks to the
container, not the controller). BUT the cold-start grid cell plan-t1-single-
source-loop REGRESSED baseline-pass -> [T] timeout ("controller doesn't progress
in the back half"): the SPEND leg (container -> consumer) is unstaffed pre-storage
because the feeder/tender that relay storage->consumer at RCL8 do not exist
early, and the system invariant is "bank flows are depot movers, never
CarryCorps" (publishRoster skips bank haulers; the "bank flows never materialize
as CarryCorp" test pins it). Reverted rather than ship the regression. To
complete: staff the container->consumer spend leg through a REAL hauler
pre-storage - either make publishRoster publish bank haulers as CarryCorps where
no depot movers exist (needs the materialiser to withdraw a CarryCorp from a
container/bank source), or route the spend leg through the scavenge mechanism
(already real haulers). That is a change to a core invariant + likely the
materialiser - a dedicated piece, not a tweak. DEFERRED to owner steer.

**INCIDENT (RE-SCOPED 2026-07-19 - see the "DEPLOY-CRASH NARRATIVE RETRACTED"
correction below): INCONSISTENT, RECOVERABLE post-reset remote-mining DIP.**
[Original framing "a chronic warchest drain ... every deploy pays a ~40-min tax"
was WRONG and is retracted - see below. The re-scoped truth:] A global reset can
land on the main.ts:264 path where the territory cache comes back empty and
remote source-claiming pauses until a terrain pass rebuilds. Observed ONCE this
session (hub-and-spoke deploy, t72435896->t72436467): assembly.graphSources
38 -> 2, flat through 19 min, recovered to 38/7 by ~40 min. But it did NOT recur
on the phantom-fix deploy (t72437535->t72437919: graphSources stayed 38), so it
is INCONSISTENT - very possibly a NATURAL global reset that coincided with the
hub-and-spoke deploy rather than the deploy causing it. It is RECOVERABLE (38
came back) and is NOT a crash. It was NOT the cause of the fleet crash (that was
the phantom code bug, which hit AFTER graphSources recovered to 38).
CONFIRMED MECHANISM: restoreVisualizationCache (IncrementalAnalysis.ts:132)
restores nodes+edges from Memory but with EMPTY territories ("Not needed for edge
visualization"); main.ts:270-275 sees territories.size===0 -> forces
resetAnalysis()+runIncrementalAnalysis() (a full, multi-tick incremental terrain
pass); refreshNodeResourcesFromCache - the source claimer - no-ops without
territories, so newly/again-needed sources aren't claimed until the pass finishes.
ROOT CAUSE IS INVISIBLE TO READING (do NOT guess a fix): node.resources IS
serialized (SerializedNode, Node.ts:187/263/282); resetAnalysis (89-93) only
nulls module caches, never node resources; refreshNodeResources (300) SKIPS
empty-territory nodes rather than clearing them (populateNodeResources' node.resources=[]
at 576 runs only for nodes it processes). So no read-path explains why the
restored nodes lose their 36 remote sources. INSTRUMENT FIRST (audit method):
add colony.getNodes() source-count to the core telemetry segment next to
flow.assembly.graphSources - if colonyNodes=38 while graphSources=2 the FlowGraph
build filters; if colonyNodes=2 the persist/restore dropped them. Then fix
red-first against a constructed post-reset unit state (extend
test/unit/execution/refreshNodeResources.test.ts - the post-reset state IS
unit-constructible even though a live global reset can't be simmed). FIX
DIRECTIONS once pinned: (a) skip the forced rebuild when nodes already carry
resources; (b) persist territories compactly; (c) fast room-level re-claim from
Memory.roomIntel post-reset. MITIGATION: none needed as a deploy gate - deploys
do NOT reliably trigger this (the phantom-fix deploy did not), so "deploy less
often" was the WRONG conclusion. Priority is LOW (inconsistent, recoverable);
worth pinning with the instrument when convenient, not urgent.

**INCIDENT + FIX: HUB PHANTOM-SUPPLY STALL (t72437535) - a live-only regression
from the hub-and-spoke deploy.** ~50 min post-deploy, once the reset transient
healed (graph 38 sources), the economy STALLED: P9 0 (7 funded / 70 e/t, ZERO
routed - mined ROTTING), controller 0.6 e/t (was 45.8), util 0.33 (was 0.87,
fleet shrinking), warchest growth flat +0.4/t. ROOT CAUSE: the hub-bump sized the
storage hub's bank source from `minedSupply` = ALL 38 candidate graph sources
(~380 e/t), not the 7 FUNDED (~70). The adapter runs BEFORE selectProducers so it
literally cannot know the funded set. The phantom 380 e/t hub let construction
over-draw (hauler bank->construction 39.4 CARRY), exhausting the spawn-parts
ledger before the storage deposit pass, so the real mined never banked (P9->0)
and the controller starved. SIM BLIND SPOT (why the gate was green): grid cells
have a handful of sources, so funded ~= all-graph and no phantom appears - it
only manifests live where dozens of rooms are scouted (dozens of candidates).
FIX: move hub sizing from the adapter to planColony, where the funded set IS
known - credit each funded source's rate to its nearest storage hub's bank
source; the adapter only guarantees a rate-0 bank source EXISTS per storage room;
selectTransientSupply exempts the bank/hub from the scavenge net<=0 filter (it is
the storage, not a lossy pile). Bank/totalSupply/construction-cap stay the real
supply. REGRESSION TEST (now catches the sim blind spot in the UNIT suite):
flowAdapter "sizes the hub to FUNDED mined income, not all candidate graph
sources" - far unfunded sources present, bank outflow must be <= funded. Gate:
unit 968 + phantom guard, grid fid-t4/bank-surplus-upgrades/storage-bank-and-spill
[P], trio. Chose FIX-FORWARD over rollback: the fix is targeted + unit-pinned and
a rollback un-does the warchest fix. [The additional "rollback costs the same
#22 reset-stall" argument I gave was based on the retracted deploy-crash
narrative - see correction below; the decision stands on the two solid reasons.]

**AUDIT CYCLE t72438635 - phantom-fix recovery progressing, depot-crash recovery-
order BLOCKER named.** Phantom fix confirmed working (warchest growing +31.82/t,
plan-side healthy). Colony in SLOW doctrine-ordered recovery from the depot crash
the phantom stall caused: util recovered 0.21->0.97 (spawn building hard), fleet
16->19. BUT controller 0 e/t / feederActive false persist because the upgrader
AND controllerFeeder creeps DIED in the crash (segment 4: both body=none) and are
queued BEHIND the production rebuild (agenda: hauler->upgrader->tanker->builder;
recent executed = all haulers+miners). Production-first is doctrine-correct in
steady state but WRONG after a DEPOT crash: without the feeder/tender the spawn
stays energy-limited (extensions empty) so the whole rebuild crawls and the
controller scores 0 the entire time. BootstrapCorp can't rescue it (fires only on
no-creeps+low-energy; here 19 creeps + 181k warchest). BLOCKER (follow-up, recurs
on every reset/crash - relates to #22): after a depot-fleet crash, prioritize
tender/feeder recovery (rebuild energy DISTRIBUTION first), or widen the bootstrap
trigger to "depot movers dead + spawn extensions starved". Not an emergency
(warchest 181k, no downgrade risk, recovery advancing); no new deploy this cycle.
Cycle verdict: FIX VERIFIED (working) + BLOCKER NAMED (depot-crash recovery order).

**AUDIT CYCLE t72438709 - SPEND PATH DOWN (feeder deprioritized), self-resolution
watch set.** Triage FAIL confirmed: warchest 185895 = 6.7x target, RISING +31/t,
feederActive FALSE, controller 0 e/t (~5 captures now). Queue data (segment 0
agenda) names it: the controllerFeeder (gate=demand, body=NONE) and upgrader
(body=NONE) died in the phantom crash and sit BEHIND production in the spawn queue
(queue head = builder/miner/hauler/hauler; recent executed = all miners/haulers/
builders). Builders idle (P8=0) - they cannot get energy with the feeder dead, so
they block the queue while the feeder that would fix distribution never spawns.
Production IS recovering (P9 0.42->0.54, fleet 19->22, warchest growing) so the
queue SHOULD reach the feeder as production completes - but ~500 ticks stuck makes
self-resolution uncertain. NO DEPLOY this cycle - but for the RIGHT reason (see
correction below): the recovery is self-resolving (P9 climbing) and no fix is
built yet, NOT the WRONG reason I originally wrote here ("a deploy would trigger a
global reset -> another depot crash"). CORRECTION 2026-07-19: deploying does NOT
reliably cause a crash or even a reset dip (the phantom-fix deploy showed
graphSources stay at 38); a global reset is harmless (creeps + Memory persist,
plan re-solves). A correct, gated feeder fix could ship on green per standing
auth - hold it only because the recovery is advancing on its own. Colony safe
(185k, no downgrade). WATCH: if the NEXT cycle shows
the controller still pinned at 0, it is genuinely stuck -> fix-forward the
feeder/spend-path priority (prioritize energy-DISTRIBUTION recovery after a depot
crash; relates to #22 blocker). Cycle verdict: DIAGNOSED (spend path down) + WATCH
SET. Delta: P9 0.42->0.54 (production recovering).

**CORRECTION 2026-07-19 - "DEPLOY-CRASH NARRATIVE" RETRACTED (owner-caught).**
Across several entries above I asserted a causal chain "deploy -> global reset ->
territory cache wiped -> remote mining stops ~40 min -> econ crash", and used it
to justify decisions (defer the feeder fix, frame #22 as chronic). THAT WAS WRONG.
The data (graphSources around this session's two deploys):
  hub-and-spoke deploy (t72435896->t72436467): 38 -> 2  (dropped)
  phantom-fix deploy  (t72437535->t72437919): 38 -> 38 (NO drop)
Only ONE of two deploys showed the source-drop. If deploying reliably wiped the
territory cache, both would. So:
1. Deploying does NOT reliably cause a reset dip, let alone a crash. A deploy
   causes a standard global RESET (VM re-init) which is HARMLESS: creeps persist
   (game objects), Memory persists, the graph rebuilds from Memory, the plan
   re-solves. This is the everyday behavior the owner has seen without crashes.
2. The 38->2 dip (#22) is INCONSISTENT and RECOVERABLE - one observation, very
   possibly a NATURAL global reset (frequent on the live server for many reasons)
   coinciding with the hub-and-spoke deploy, not caused by it. Re-scoped to LOW
   priority. NOT a crash.
3. The ACTUAL fleet crash was the PHANTOM CODE BUG (hub sized to all 38 candidate
   sources instead of 7 funded), which hit at FULL income AFTER graphSources had
   recovered to 38 and the economy was healthy - unrelated to the act of
   deploying. Fixed.
CONSEQUENCE for decisions: "don't deploy X because it re-crashes the colony" is
an invalid argument. A correct, gated fix may ship on green per standing auth;
hold a fix only for real reasons (recovery self-resolving, fix not built/proven).
Lesson: I built a causal narrative from a single correlated observation and
propagated it into decisions before the second data point (the phantom-fix
deploy) falsified it. One observation is a hypothesis, not a mechanism.

**AUDIT CYCLE t72438909 - WATCH RESOLVED: depot-crash recovery SELF-RESOLVED, no
fix needed.** Last cycle set a watch: controller still pinned at 0 -> fix-forward
the feeder priority; climbing -> self-resolved. Data says SELF-RESOLVED. The
production-first recovery completed enough for the feeder/upgrader to finally get
spawn priority: feederActive false -> TRUE, controller 0 -> 1.4 e/t (climbing off
0), ctrlStock 358 -> 1414 (energy accumulating at the controller now the feeder
delivers), warchest +31/t (ballooning) -> -3.7/t (flat - spend path back up, E4
FAIL->WARN), fleet 22 -> 26, work 34 -> 47. So the feeder/spend-path priority fix
I was ready to build is NOT needed - the recovery self-resolved as the P9-climbing
trend predicted. Controller still ramping toward its pre-crash ~45 e/t as
upgraders rebuild; routine monitoring continues. PHANTOM FIX fully validated;
colony recovered from the crash it caused. Cycle verdict: WATCH RESOLVED (self-
heal confirmed). Delta: feederActive false->true, controller 0->1.4, warchest
ballooning->flat.

**AUDIT CYCLE t72439560 - RECOVERY COMPLETE; next bottleneck = controller
under-upgrading (#21 cap ~2). Also: room is RCL6, not RCL8 (my error all
session).** Recovery from the phantom crash is DONE (measured delta vs t72438909):
feederActive true (holding), creeps 26->34, work 47->53, P7 controller delivery
1x (delivery meets plan). The acute incident is over. NEXT BOTTLENECK (core goal):
the controller draws only 2 e/t despite a 186k warchest (6.7x target). NOT a
supply/feeder problem - the hub has supply (spawn 10 + construction 158 + storage
62 all filled) but the controller sink is CAPPED at 2 (alloc 2, unmet 126). The
plan wants targetCount=1 upgrader at 2 WORK (segment 4: upgrading planAllocated=1,
allocated=2 floor). So the controller sink cap (controllerRoutingCapacity ->
controllerUpgradeCap = parkingTiles x affordableWork) computed ~2, vs ~45 that
produced 6 upgraders pre-crash at the SAME RCL6. Construction soaks the residual
(alloc 158) but builds 0 (P8=0, siteProgress 200/3000), so the surplus banks
(warchest +1.5/t). CAUSE INVISIBLE from telemetry: parkingTiles is terrain-based
(not creep-blocked - ruled out the position trap), energyCapacity=1950 stable, so
why the cap is ~2 vs ~45 needs the cap breakdown STAMPED (parking count,
affordableWork, whether controllerUpgradeCap threw->Infinity vs returned a value).
This is task #21's domain. NO fix rushed this cycle (enormous session; controller-
at-2 is a chronic inefficiency, colony safe + progressing, not a crisis). Cycle
verdict: RECOVERY VERIFIED COMPLETE + #21 controller-cap bottleneck DIAGNOSED,
instrument-next handed to #21. Correction: I called the room RCL8 repeatedly this
session - it is RCL6 (energyCapacity 1950).

**OWNER-DIRECTED BATCH 2026-07-21 (five live-behavior changes, one session,
each full-gated + deployed).** (1) Partial-pave repricing (#23): a trunk
verifiably >= 1/2 built already fields the 2:1 hauler, CARRY sized at the
effective (crawl-corrected) distance - roadEconomics.partialPaveRatio /
effectiveOneWayTiles, trunk survey built/total persisted onto roadRoutes,
detectPavedSources Set->Map. Predicted: W43N24 (32/38 = 84%) reprices next
solve, ~19% fewer hauler parts. (2) Link-hub congestion (owner report: the
source link had nowhere to send): feeder stages the relay only to capacity -
CORE_LINK_INCOME_RESERVE (200); LinkRunner spills a congested source volley
DIRECTLY to the controller link (one 3% hop, bank-first preserved). (3)
Remote source containers (owner report: missing/partial): placement no
longer blocked by trunk ROAD sites (container-sites-only gate); a pile-funded
LOCAL builder (2W, eats the pile, no hauling - the owner's road-end paradigm)
fields while the project stands; the remote repair detail is now actually
dispatched (it idled in runBuilder before - decayed containers were the other
"partial" shape). (4) Swamp-favored placement: bestAdjacentTile tie-breaks
equal-distance candidates toward swamp for unwalkable buildings (adjacent-to-
plain preferred; roads/containers terrain-neutral; distance still rules). (5)
Road-lane hauling + EMPTY LANE RETURNS: haul legs path creep-blind
(ignoreCreeps, reusePath 20; mutual-move swaps resolve head-on traffic;
standing blockers get ONE creep-aware detour after LANE_PATIENCE=2) and the
empty pure-hauler leg goes terrain-blind with roads penalized. The 2026-07-20
empty-lane revert (cd3f0b8) is thereby superseded: flow-handoff - the exact
gate that caught the first attempt - is GREEN with the lane inside
travelToLane; probable old root = creep-AWARE pathing made a pocket-mouth
miner an unreachability wall for the maiden trip (consistent, not proven).
Verify next capture: pathMeter hauling calls/cpu DOWN, W43N24 hauler bodies
2:1, core link <= 600 with source volleys landing, container sites + local
builders in remote rooms, income steady-or-up across the movement change.

**AUDIT CYCLE t72469936 - batch verified live; E4 named with its full causal
chain; one export gap fixed.** Ledger top line E4 (272k banked, 9.8xT, +10.6/t,
feederActive false). VERIFIED from live reads (room-objects + memory API):
(1) partial-pave repricing LIVE and exact - cd8e planned carry 15.9368 =
carryPartsFor(10, effectiveOneWay(36, 32/38, 2:1)), spawned body 18C:9M;
receipt built 34/38 ratcheting; (2) remote-container fixes executing - cd8d
container site placed THROUGH standing road sites, miner pre-positioned on it,
second miner spawned, two pile-funded local builders finishing the last road
tiles (155/300, 50/300 in progress); (3) link chain physically healthy (ctrl
384e, core 90e - inside the income reserve, source link loaded); (4) income
0.98x routed across the movement change - no road-lane regression. E4 CAUSAL
CHAIN (all stamped/measured): construction-first clamps upgrader+feeder to
planFlow 2 (+5) while the absorber (trunk, 4 tiles left) finishes - by design,
self-resolving. The LIVE BLOCKER: the feeder (gate "demand" >= 2 captures,
wants ONE 1-CARRY body = 100 energy, linkFed distance 1) is QUEUE-STARVED at
spawn util 0.95 - the bank's spend path is down NOW and would stay down when
the trunk completes and the surplus regime wants the 115-relay flood.
SECONDARY ANOMALY: util 0.95 vs steady-state ~0.60 (301 parts flat, 0.315/t
built => implied part-life ~955t < 1500) - purchase-loop/churn signature, E5
runt receipts hauler@100 x2; agenda.executed exported EMPTY (gap). FALSIFIED
en route: feeder spawnId-prefix mismatch (live store shows clean id); "empty
sizing stamp" was an audit-side filter bug (capital F), not a bot defect; P4's
"feeder 64p @ relay 115" is the LEDGER's own pricing drift (corp is linkFed
relay 7) - ledger fix pending. FIXED+DEPLOYED this cycle: seg-6 haulers now
carry the paved verdict (the mapping dropped it; nearly ruled the repricing
dead). Cycle verdict: VERIFIED (batch) + BLOCKER NAMED (feeder starvation,
with numbers) + one observability fix shipped. Next cycle: feeder-starvation
fix (scheduler slack for cheap infra, design-first, no value nudges) and the
churn anomaly via agenda.executed (fix its empty export first).

**AUDIT CYCLE t72470198 - feeder starvation root-caused to the CLOCK, not the
backstop; prediction filed.** E4 top line again (274.7k, +9.95/t, feederActive
false). Post-reset capture (only the roadGate stamp had refilled; spawn busy
40t straight - demand-pass stamps empty is a RESET+BUSY artifact, not a
defect). Live agenda read (Memory.spawnAgenda): the anti-starvation backstop
WORKS - the queue's head is starved-FIFO by age (hauler-cedc 798t > reserver
441t > hauler-cbd5 321t > FEEDER 321t @ minCost 100, position 4). The feeder's
2400-tick starvation is a CLOCK-RESET loop: its no-miner gate blinks the
demand off during routine home-miner turnover (clock restarted at t72469837,
exactly the cd90 miner replacement window; the prune deletes a first-seen key
after ONE absent evaluated tick), so 300 ticks of age never accumulate
before the next blink - while blocking income replacements (miner@700 at
t72469894, hauler@100 at t72469921 bought PAST older starved entries) keep
taking the rare free slots at util 0.97. PREDICTION (falsifies next capture):
the starved FIFO ahead of the feeder costs 1900 energy total and the feeder's
current clock is already past threshold - if the queue drains as designed the
feeder BUYS by ~t72471500 and feederActive flips true. If the next capture
still shows feeders 0, the fix (design ready): (a) the feeder's no-miner gate
is wrong-class - a feeder relays the BANK, so it should gate on banked stock,
not miner presence (kills the blink at its source; "infrastructure follows
income" is satisfied by a funded bank); (b) clock hysteresis - a first-seen
key survives K absent evaluated ticks before pruning (one-tick blinks no
longer zero 300 ticks of age). Trunk: 34/38 held this window (local builders
mid-tile); fleet 22->25 (miners 3->7 - the churn rebuild). Cycle verdict:
DIAGNOSED to mechanism + prediction filed; no code shipped (the honest move
- the system may already be buying the feeder).

**AUDIT CYCLE t72473701 - prediction VERIFIED (feeder alive, zero code was
the right call); the cork moved one seam down and got its fix.** feederActive
TRUE - the t72470198 prediction held: the starved FIFO drained and bought the
100-energy feeder on its own; the scheduler needed no change (the clock-reset
fix in #29 stays shelved unless the blink recurs somewhere it matters). E4
WORSENED (370k, +27.4/t): income rose (28 creeps, remotes fully staffed,
P9 1.0x of 70 e/t) while construction-first held burn at the plan's 8.6 e/t
- correct doctrine, broken absorber: the trunk sat at 34/38 for 3500+ ticks.
Mechanism (measured): the last tiles are MID-ROUTE - outside the builders'
4-tile self-fuel reach (doPickup is deliberately stationary), no pile, no
container, and the tanker demand gate was HOME-sites-only while the bank held
370k. FIXED+DEPLOYED (#24 slice, full gate green): tanker demand keys on the
POOL head's site; targetTankerCount prices the cross-room shuttle at linear
room distance (same-room getRangeTo across rooms = Infinity = no fleet).
runTanker needed nothing - it already draws the surplus bank and stages
toward the builders cross-room. Predictions for next capture: 2+ tankers
fielded for the home corp; trunk 34 -> 38 in ~2-3k ticks; on completion
constructionStanding false -> surplus regime unclamps (feeder relay 115,
upgraders from actuals) -> burn into the 40 e/t band, BANK SLOPE NEGATIVE
for the first time. If the trunk completes but burn stays low, the next seam
is the upgrader fleet's scale-up (parking 8, cap 2300 - room to grow).
Cycle verdict: VERIFIED (prior prediction) + FIXED (pool tankers, deployed).

**OWNER DIRECTIVE 2026-07-21 (Z-to-A trunk dedication, #25 core) - shipped.**
"The remote is still hauling home although we're building a road there ...
feed the Z-to-A remote builder from the source, and disable hauling anything
home until the road is finished." One lens (detectTrunkBuildingSources:
tiles3 && !paved && !declined, the same receipts detectPavedSources reads),
three consumers: PLAN keeps the miner but pools the source at rate 0 (no
haul routes planned/priced - defund at the spawn) and excludes it from
minedSupply; KIND-side CarryCorp.yieldsToBuild yields for trunk-building
sources (standing haulers stop pickups, no replacements; the home-room
dedicatedBuildSourceId slot untouched - single-slot, home-memory, and
hard-freezes without vision per the seam audit); CREW-side the remote local
builder gate counts ROAD sites, so the Z-to-A 2-WORK body (= the source's
full 10 e/t) stands while its room's segment builds. Hauling resumes at 2:1
when the paved receipt lands. Expected readings while a trunk builds: P9
shows the dedicated source unrouted BY DESIGN (annotate if noisy), income
dips by the dedicated 10 e/t, the trunk finishes faster from both ends
(pool tankers home-side + Z-to-A source-side). Gate: 1150 unit + trio green;
deployed.

**AUDIT CYCLE t72474584 - MY REGRESSION caught and fixed same-cycle: the
Z-to-A lens over-rotated.** The ledger lit up on the previous deploy's own
change: P1 five sources funded->unrouted, E2 168 parts stood down, funded
mining 70 -> 20 e/t. detectTrunkBuildingSources (tiles3 && !paved &&
!declined) matched every PLANNED trunk - but placement is one-project-at-a-
time, so three of the five (cbd5/cedc/cd8d) had no sites even placed:
income revoked for zero build progress, the trap-list revocation class
inside my own implementation. FIX (same cycle, full gate, deployed): the
lens additionally requires `total` (stamped by the first placement survey)
- dedication now tracks the build discipline itself: sites stand => the
source feeds its Z-to-A crew; planned-only => keep hauling. Live: cbd5/
cedc/cd8d resume (30 e/t back); cd8e (34/38) + cee0 (10 sites standing)
stay dedicated. ALSO SURFACED, filed not fixed: P5 FAIL - the reserver
gate re-staffs whenever staffed < target (duty 1.0) while the toll prices
0.5 duty and the reservation bank (~5000 ticks) is never read by the gate;
2x reserver spawn+energy vs priced. Next cycle's candidate work item if it
holds across a clean window (this window was raid-distorted). Predictions:
income recovers to ~50 e/t (2 home + 3 resumed remotes; 20 dedicated),
trunk cd8e completes within ~1-2k ticks, cee0 segment advances at ~10 e/t
from its 1770-stocked container. Cycle verdict: REGRESSION FIXED same-cycle
+ P5 named with data.

**INCIDENT t72475006 - EMPTY PLAN on the dedication build; ROLLED BACK.**
Two captures 42t apart: fresh solve ticks publishing sources 0 / haulers 0 /
candidates NONE while corps coasted on old commissions. Rollback to 815e033
(pool tankers, pre-dedication) restored the plan within ~100t (7 sources, 11
haulers). ATTRIBUTION: the Z-to-A dedication commits (261abec + 9703bc9)
break the LIVE solve - the mockup gate could not catch it (no roadRoutes
receipts in those worlds, the dedication path never executes there: sim
blind spot, now measured). The unit pin (planColony: dedicated source ->
miner yes, haulers none) PASSES, so the throw is DOWNSTREAM of planColony -
prime suspect: commissionsFromPlan / carryKind / FlowMaterializer handling a
FUNDED MINER WITH ZERO HAUL ROUTES (routes[0] access on an empty group).
Repro to write FIRST: commissionsFromPlan + materialize over a plan with a
dedicated source. DEPLOYED BUILD (815e033's bundle) is now BEHIND branch
HEAD - the branch keeps the dedication commits + the surveyed-lens fix; do
NOT redeploy HEAD until the routeless-source repro is red->green. The
t72474584 cycle's other finding stands: P5 reserver duty 2x (raid-distorted
window; re-check clean). Cycle verdict: INCIDENT CONTAINED (rollback
verified) + attribution measured + repro filed (#30).

---

**SESSION HANDOFF 2026-07-22 (end of day; next session starts here).**

DEPLOYED BUILD = commit 35785ba's bundle = branch HEAD. Everything below
is live and verified (t72500407): the day ended all-green after a full
collapse-and-recovery arc.

LIVE STATUS (t72500407): fleet 33 creeps (post-incident re-field
complete); tender 3/3 staffed, duty 0.186; feeder active (4-16p parked
body vs 22p two days ago); endFill 0.444 and climbing; storage ~195k
DRAINING (-14.7/t) toward the 27.6k warchest; routes 70/70 e/t across 7
funded sources; reservers staffed, all four remote banks pumping;
upgraders re-ramping toward the plan's 108p WORK; GCL 32, one room.

LANDED TODAY (all gated, all deployed): spec 25 emergent dedication
(verified live, 70/70 routed); project-ledger pattern (sites in corp
memory, vision reconciles); feeder parked-post sizing; tender
fleet-of-3 + duty meter + equal-share bodies; REFILL BOOTSTRAP (dark
post + stranded stock bids 150); fan-fill RETIRED (accountability
doctrine: covered-room lens, one lens at all four CarryCorp sites, +
intent receipt "extension-fan"); off-road parking (ring sort, one-hop,
stepOffRoad at tanker posts); builder hand-off (release + adopt via
orphan machinery); builder en-route road repair; EOL hauler recycle +
X4 row; source-approach tile exemption; ledger truth fixes (P8
receipts, P4 link-fed charge); extension-sim mini-game + evolve
harness (scripts/extension-sim/, findings in README).

THE INCIDENT (the day's biggest lesson, full log above): cohort
die-off + mustFund wall + strict hold + retired fan-fill = 4,400-tick
spawn deadlock, colony 23 -> 4 creeps. Rollback -> root cause from the
walk's own code -> INFRASTRUCTURE LANE (owner ruling "a only"),
emergency-gated after the unconditional form measurably recreated the
W2N6 cold-start stream -> re-land -> full recovery, every step
measured. The lane's LIVE proof is still pending: the first real
dark-post pierce happens whenever a tender generation turns over with
the bank stocked - watch receipts for it.

NEXT STEPS, in order:
1. **Spec 27 extension remodel** (owner-designated next item): phase-1
   scorer + per-cluster table (size, distance, implied tender body);
   owner reviews the scored plan BEFORE any destroy logic; then the
   migration executor under its rails. Folds in: per-cluster tender
   sizing (retire the equal-share interim), the depot bridge economy
   fix (DEPOT_BUFFER 150 vs split fleet - un-reds
   haul-t4-tender-bus-regime), and parking-spot placement.
2. **Upgrader scale-up seam**: construction-clear surplus should burn
   ~115 e/t; the fleet ramp (parking 8, cap 2300, plan 108p) is the
   cork - verify it completes, then E4 finally reaches target.
3. **Threat = capability hostility lens** (owner assessment, designed
   not landed): a MOVE/TOUGH-only cripple must not defund a room;
   active-parts filter in hostileRooms(), HEAL keeps groups hostile.
4. Ledger polish (telemetry-only): S3 discounts a head bought within
   its own staleness window (false-positive stall).
5. Backlog: consumer-trickle decision; expansion audit (GCL 32, one
   room - capex is ready when the warchest holds); spec 11 phase 3;
   spec 17 P3-P5.

INFRA NOTE: the audit loop runs on harness ScheduleWakeup (~45 min
cadence) and survived the whole day; the server-side MCP Routine is
still blocked by an approval prompt that never reaches the owner.

---

**SESSION HANDOFF 2026-07-21 (superseded by 2026-07-22 above).**

DEPLOYED BUILD = commit 815e033's bundle (pool tankers). Branch HEAD is
AHEAD of it by the Z-to-A dedication commits (261abec, 9703bc9) which are
KNOWN-BROKEN LIVE (incident t72475006: empty plan; rolled back, verified
recovered at t72478452 - 70 e/t routed 1.00x). Do NOT redeploy HEAD's
bundle until task #30 lands.

LIVE STATUS (t72478452): income 70 e/t fully routed; feeder + controller
link chain working; trunk cd8e at 36/38 (2 tiles left); W42N22 segment 7/10
built; new W44N23 segment placed (12 sites); all settled remotes have
containers (the two W43N24 sources queued behind the trunk by design).
E4 idle capital 464k (+23/t) is the SCORE cork: burn clamps to ~2-3 e/t
while construction stands (correct doctrine); it unclamps mechanically when
the trunk paves - watch for the surplus-regime flip (feeder relay 115,
upgrader fleet scale-up, bank slope NEGATIVE).

NEXT STEPS, in order:
1. #30 empty-plan crash: red-first repro = commissionsFromPlan +
   materializeCommissions over a plan with a dedicatedToBuild source (funded
   miner, ZERO haul routes; suspect routes[0] on an empty group). Fix, full
   gate, add a grid cell that STAGES roadRoutes receipts (the mockup gate
   passed because the dedication path never executed - sim blind spot,
   measured), then redeploy HEAD. This re-lands the owner's Z-to-A
   dedication with the surveyed-trunks scoping already in HEAD.
2. Verify the surplus-regime flip when the trunk completes; if burn stays
   low with construction clear, the next seam is upgrader fleet scale-up
   (parking 8, cap 2300).
3. P5 reserver duty 2x (gate re-staffs at staffed<target, never reads the
   ~5000-tick reservation bank; priced 0.5 duty) - confirm in a raid-free
   window, then fix the gate to read reservation.ticksToEnd.
4. Owner design queue: #24 aggregate squad formula (W=E/5H, K=W(d+1)/5,
   H=2/3(1500-d); bodies 2W:1M:1-2C, 2C:1M) beyond the pool-tanker slice;
   #25 anchor-relative dual-front once #30 unblocks; #19 T5 tempo (design).
5. Infra: the 20-min audit cron is session-local (dies with the container);
   server-side Routine creation is still blocked by an MCP approval that
   never reaches the owner - unresolved.

---

### 2026-07-23 (audit cycle) — X5 rebuild-churn line added; churn measured, home 0%

Owner directive this cycle: "continue investigating these types of churns and
wastes ... they might seem small but the bot is so constrained in screeps that
they all add up." Ledger was FAIL-free (the P4 drift fix from 07-22 held at
0.90x). Top WARN E4 (idle capital) confirmed a self-correcting drain, NOT the
broken-pump signature: storage 94k->84k, slope -27.8/t over 935t, feederActive
TRUE, upgrader workUtil 1.00, P7 delivery 1.38x plan with stock STANDING
(energy kept up). Consumer sized right by sustainableConsumptionRate (allocated
115 e/t, targetCount 6); the drain is gated by the single-spawn RCL6 throughput
ceiling (upgrader plateaued 3/6 because producers fund first — the surplus is
the fuel being burned to reach RCL7, which unlocks the 2nd spawn).

CHURN INVESTIGATION (the cycle's work): the blackbox spawn log (segment 5)
showed remote haulers spawned small then replaced full a few hundred ticks
later (cbd5 1550->2200 @189t, cd8d 900->2300 @120t) and a reserver re-ordered
25t after itself — below a claim body's ~78t spawn time, so a double-order, not
a sequential death. Traced the small->big to `SpawnScheduler.ts:566-609`
`afford-min-scaled` (body scaled to the momentary extension energy, despite 84k
in storage) compounded by early death. CRITICAL caveat caught: the window
straddled the 07-22 drift-fix deploy (t72508624) — a global reset does not kill
creeps but its re-plan/re-adopt double-orders inflate churn for ~1 window. A
raw hand-count read 28%; excluding the upgrader RAMP (census cross-check) and
weighting by unlived life-fraction, the true figure is 11%, and it is ALL
remote (home 0%) — the invader/revocation floor of remote mining, not a bot
bug. The 25t reserver double-order rolled OUT of the window as recovery
completed (X5 verdict ok), confirming it was reset-transient.

INSTRUMENTED (script-only, no deploy — ledger reads dist-independent): X5
rebuild churn (spec 15). Per corp, spawns beyond current staffing died-and-were
-replaced (excludes growth); each weighted by gap/lifetime (natural EOL ~0);
home-role churn (bot signal) split from remote-exposed (noise); WARN on home
>12% OR any respawn gap <60t (loop/double-order). Enrolled red-first (4 tests,
unit 1332->1336). Capture default bumped to segments 0,4,5,6 so X5 computes
every cycle; a HIGH X5 is to be read against the deploy log.

Cycle verdict: **INSTRUMENTED** (X5 landed) + **MEASURED** (churn 11%, home 0%
— the home-bot-bug hypothesis is cleared, the remote-noise floor is now a
tracked number). No live-behavior change shipped: the `afford-min-scaled`
undersizing is a candidate future fix, but X5 shows home churn is zero, so
there is no bot leak to attack this cycle — the instrument now guards against a
regression that would raise it. Fixture t72509559 (0,4,5,6) committed.

---

**SESSION HANDOFF 2026-07-23 — waste-elimination cycles + links-as-hub-ports design (PR ready to merge).**

The PR (`claude/production-audit-cdj4sb`) is the multi-cycle waste-elimination
arc. Merged origin/master clean (movement.ts + tests; unit 1338 green).

LANDED (committed, gated; the live-behavior ones deployed + verified):
- **Surplus consumers fund** — `holdToFund` honored for non-income demands, so
  the drawdown upgraders wall the spawn instead of freezing at 2/6 (verified
  live t72504060).
- **Pool tankers deliver cross-room** and never to the repair detail (trunk
  stall cleared, t72504737).
- **Trunk A/Z aggregation (spec 25 phase 4)** — a trunk road becomes TWO
  construction sinks (road-A home-aggregate + road-Z mine-aggregate, split by
  energy flow) instead of N micro-haulers. Verified live: cedc 30 sinks → 2,
  P2 34/44 → 5/13 (t72506645).
- **P4 ledger/planner drift eliminated at the ROOT** — the planner exports its
  own paved-aware `spawnParts` (segment 6 v8) and the waste-ledger ECHOES it
  instead of re-deriving `(paved?1.5:2)`. P4 1.01x FAIL (a ledger artifact, not
  real infeasibility) → 0.90x, verified live t72508624.
- **X5 rebuild-churn ledger line (spec 15)** — early-death respawn energy from
  the blackbox (segment 5), census-cross-checked to exclude fleet GROWTH,
  weighted by unlived life-fraction, split HOME (bot signal) vs REMOTE (invader/
  revoke noise). Measured live: 11% of spawn spend, home 0% — the remote-mining
  floor, no bot bug. Capture default bumped to segments 0,4,5,6. Ledger
  FAIL-free; E4 draining steadily (−28/t), the surplus self-metering as
  designed.

DESIGNED TODAY, NOT built (owner: "document the proposed effort ... don't
build") — **spec 26 links-as-hub-ports**, un-deferred and scoped:
- Deposit-side port pricing (a `depositPos` mirror of the existing `haulPos`):
  a mined route prices its delivery to the nearest link that reaches the hub,
  emergently — cheaper-distance port wins, no flag. Shrinks CARRY:MOVE.
- Owner **backpressure reframe** retires the surplus-gate: a controller-link
  drop does NOT bypass the bank — the core fires less into a full link and the
  feeder pulls less from storage, so the drop DISPLACES a bank drawdown of equal
  size (net storage = income − consumption either way). Partial banking for
  free; the bank level self-meters consumption via sustainableConsumptionRate;
  no regime gate. The t72434228 "spending our savings" incident was the plan
  re-routing mined to the controller SINK (starving storage) — a different,
  worse design.
- **Backpressure trace (done):** the runtime chain already holds — `LinkRunner`
  fires core→controller only on `ctrl` free capacity, and `coreLinkLoadRoom`
  drives feeder load to ~0 on a full core. Gaps are all in the PLAN (price the
  ports; shrink feeder sizing for port-fed flow; keep mined a hub deposit).
- **Measured on our colony (t72509559 geometry):** ~29 CARRY+MOVE parts (~17%
  of the mined fleet) ideal, concentrated on the N/E routes that pass the
  NE source link; derated by the 800-cap port-full fallback. Source/controller
  split (~79/21) is a layout accident, could invert.
- **Base-layout payoff:** priced ports make "add a link at P" a number (perturb
  → replan → read spawn-parts delta), so link PLACEMENT becomes greedy
  search-by-replanning — and the evaluator IS the runtime pricer (no drift).
  This is the load-bearing primitive for the base-layout leg, not a one-off.

## INCIDENT 2026-07-23 — spec 26 (controller-link ports) FAILED, reverted

**The earlier "FIXED" verdict below was WRONG and is retracted.** The
controller-link ports deployed at ~t72512031 caused a **slow colony collapse**
(spawn fleet 30→28→…→13 over ~1400t, harvest 7→2), owner-observed as "haulers
walk past the link to the core", "traffic jam at the spawn", and finally a
"no-spawn wedge" watchdog. Reverted `src` to pre-spec-26 (`7bf55fc`), rebuilt,
deployed to `master`; the colony recovered (util 0→0.58, tender respawned,
total climbing) ~300-400t after the revert. `detectLinkDepositPorts` now
returns `[]` on the branch (feature inert) pending a correct redesign.

**Two faults (root-caused with data):**
1. **Ports never delivered.** The core→controller relay keeps the controller
   link topped, so haulers found ~no free room and fell back to storage —
   reproduced in a grid cell (a staged loaded ported hauler wrote NO
   `deposit-port` receipt in 240t). The plan under-sized the ported haulers
   for a hub delivery they always made — a plan-vs-actual lie. The design
   review had flagged exactly this ("treat controller-link headroom as ~0 until
   the feeder credit lands"); it was shipped anyway. Prerequisite for any
   redesign: the relay must RESERVE drop room + the feeder must be credited.
2. **Latent spawn-scheduler deadlock (its own incident vs the DEPLOYED build).**
   Fleet collapse drained the spawn network and killed the tender; warchest at
   2× target → a "campaign" upgrader (minCost 2300, `mustFund`, `gate: wall`,
   `why: campaign`) held the spawn AHEAD of the income miners/haulers (all
   queued `after:upgrading-…`) — a death spiral the code revert alone couldn't
   undrain (a global reset moves neither energy nor creeps). Recovery came only
   as the tender re-fielded and refilled the network. FIX CANDIDATE: a spend
   campaign must never `wall` the spawn ahead of blocking income demand when the
   income fleet is depleted (spawn-network below a bootstrap floor).

**Process failures to fix:**
- The integration trio + grid link cells never staged a storage hub + a
  controller link together, so NONE exercised the port DELIVERY path — the same
  blind-spot class as the sim-blind-spots trap list. A link-delivery cell MUST
  assert a real hauler `deposit-port` RECEIPT (link fill is a false positive:
  the relay fills it) AND run WITH the feeder relay present (steady state).
- I reported "X1 resolved / FIXED" from plan-side telemetry (segment 6) + a
  false-positive grid assertion, without confirming a physical port delivery.
  Telemetry that reads the PLAN (segment 6) can show a feature "working" that
  the executing corps never perform. Verify at the RECEIPT/behavior layer.

---

### (RETRACTED) Cycle verdict 2026-07-23 — spec 26 minimal (controller-link ports): FIXED

Shipped `detectLinkDepositPorts` + `routeToSinks` port pricing + `CarryCorp`
port delivery + telemetry/roster echo, deployed to `master` at ~t72512031.
**Scope refinement (design review):** CONTROLLER-LINK ports only. Source-link
ports were dropped from v1 — a remote drop into a source link forwards to the
core, but the core→storage drain is staffed only for the home source's own
rate (the feeder only LOADS the core), so the injected flow is unstaffed →
the plan would price a saving the physical path can't deliver (a plan-vs-actual
lie on the deterministic grid cell). The controller-link port is the honest
class: consumed IN PLACE by the upgraders, which by the LinkRunner backpressure
displaces an equal bank→controller relay (bank-neutral, no toll, no drain
hauler). This deleted the whole toll subsystem — `allocated == take`.

**Measured (t72512341, ~310t post-deploy, vs baseline t72512031):**
- 3 deposit routes engaged the home controller link (41,30): cd92 carry
  4.8→3.2 (dist 11→7), cee0 18.8→18.0 (46→44), cedc 22.0→19.6 (54→48).
- P4 source-route hauler slice 157p/0.108 → 149p/0.103 parts/t (clean read
  from the plan — the port CARRY reduction).
- X1 (was the TOP LINE) workUtil 0.50→0.79→**0.88**, dry 0.50→0.21→**0.13**,
  idle-equiv 20.1→12.8→**2.5** — CONFIRMED over a clean 2047t window
  (t72512784): the controller-link drops feed the upgraders directly, so X1 is
  resolved to [ok]. Spawn util planned 0.86 / actual 0.88 (queueDepth 5) — the
  spawn is now the binding constraint, so the source-link follow-up (item 1
  below) is the next real lever.
- No FAIL lines, P7 controller delivery on-plan (40.2/40.2), no crash through
  the global reset, hub invariant held (sink still storage, port is delivery).
Modest as expected (the honest ~21% controller-link share of the 29-part ideal).

NEXT, in order:
1. Source-link ports (the deferred ~79%): needs a commissioned core→storage
   drain leg (or an upsized home hauler) so the injected remote flow is staffed
   — same core/relay sizing work as the feeder credit (spec 26 open Q2). This
   is the bigger P4 lever (the −9/−8/−6 N/E routes) but must not price an
   unstaffed drain.
2. The base-layout evaluator: candidate link positions → replan → greedy place
   to the RCL link budget; the deposit-port pricer is now the scorer.
3. Carry-forward gauges: X1 over a clean (non-deploy) window to nail the
   attribution; X5 steady-state; warchest-target-as-spend-rate (open Q3).

---

### AUDIT CYCLE t72523980 — E5 runt detector made attribution-aware (standing false positive killed)

Ledger on the fresh capture (baseline t72519086, dt 4894, ~5k ticks post the
scheduler-fix reset): **no FAIL lines**, colony healthy and recovering well —
E4 storage 53.5k draining at **−4.79/t** toward the 27.6k warchest (was 77k and
rising last cycle; the spend path is back), P7 controller delivery **28.8 e/t**,
S3 scheduler stall **0**, P9 all mined energy routed (no rot), X1 WORK 99%
utilized. The scheduler death-spiral fix (this session) holds.

Two WARN lines. X5 rebuild churn 0.20 is mostly remote invader/revoke noise
(a LIVE-ONLY class) plus post-reset recovery — not sim-actionable. **E5 runt
purchases (2 of last 8) was a 100% FALSE POSITIVE**: both flagged runts were
the SAME corp `hauling-W43N24-hauling-0-20`, the scavenge route
`scavenge-W43N24-30-20` the planner deliberately sizes at carryParts **1.41**.
A 200e (2-CARRY) hauler for a <3-carry route is RIGHT-sized, not a
drained-spawn purchase. The plan-blind `cost<300` test flagged every scavenge
and distance-1 short-haul hauler forever — a standing cry-wolf that trains us
to ignore E5 and would mask a real drained runt.

**Fix (ledger-accuracy, tooling-only — not in dist/main.js, no deploy):**
E5 now cross-references the flow plan. A hauler runt counts only when the plan
wanted a real body (route carryParts ≥ 3) OR no plan route vouches for the size
(conservative default keeps off-plan/stranded small haulers flagged).
Red-first pinned by three tests (micro-route → not flagged; non-micro
plan-big-bought-small → still flagged; unmappable → still flagged). Live E5
→ **[ok] 0/none**. Unit suite 1357 passing.

Cycle verdict: **FIXED** (E5 false positive eliminated + regression-pinned) +
**MEASURED** (spend path restored, storage draining −4.79/t, controller
28.8 e/t, no FAIL lines). Next candidate: X5 steady-state churn once past the
post-reset window; the source-link deferred ~79% remains the bigger P4 lever.

---

### SPEC-26 STAGE 2 — REVERTED (relay-yield starved the controller); instrument earned its keep

Stage 1 (link-throughput instrument) measured the controller-link is fed 13-35 e/t
at **0% direct** (all double-hop source->core->controller). Stage 2 made source
links deposit DIRECT into the controller link above warchest. First deploy read
0% direct still - the core->controller RELAY fires every tick and refills the
link, leaving no room for a source volley. Fix attempt: gate the relay to yield
above a low-water mark (400). **That REGRESSED P7 to 0 e/t** (controller delivery
collapsed; energy banked instead, +16/t) - reverted immediately (doctrine).

Diagnosis (post-revert, static): the controller LINK *is* the upgrader input
(controllerInputSpot returns it), and the upgrader draw is small (~15-26 e/t) vs
the 800 link capacity - so the link sits mostly full, rarely draining below 400.
Gating the relay at low-water deadlocked it: link stuck ~768, relay yielding,
source volleys (>=100) can't fit the ~32 free, controller not draining fast
enough to open room. The ungated relay was load-bearing: it keeps the link
topped for the trickle draw.

**Verdict: the controller-link direct win is MARGINAL and FIDDLY.** The tax saved
by 1-hop vs 2-hop on ~20 e/t of controller flow is ~0.5 e/t; the relay is
load-bearing for the small draw, so capturing it safely needs reserved headroom
(coreLinkLoadRoom-style), not a gate - complexity out of proportion to ~0.5 e/t.
The instrument did exactly its job: it QUANTIFIED that this "easy win" is small
and risky, and caught the regression in ONE cycle via a real delivery receipt -
the thing spec-26 v1 never had. Kept: stage 1 (instrument) + stage 2's harmless
source-direct preference (dormant while the relay tops the link). The real link
lever is the SOURCE side (hub throughput 9-11 e/t and 31 over-budget remotes) -
stage 4, where the throughput actually is.

Cycle verdict: **REGRESSION REVERTED same-cycle** (P7 0->restored) + **FALSIFIED**
(controller-link direct win is marginal; instrument-first saved the over-invest).

---

### AUDIT 2026-07-24 — E4/P7: scaling upgraders can't win spawn time vs income when the warchest is in surplus (3rd incident on this mechanism)

Ledger t72533078: **E4 FAIL** (storage 62.8k = 2.8x reserve, +16/t and rising,
feederActive true) and **P7 FAIL** (controller 7.0 e/t vs plan 15, "stock stood").
Same root: the controller under-consumes, so real income rots in the warchest.

Diagnosis (all reads):
- Upgrade sizing stamp: `surplus` path CORRECT — `allocated 65.4`, `targetCount 4`,
  `inflow 64.9` (feederRelayRate of the 63k bank), `hold: true`. The plan WANTS
  4 upgraders (65 e/t) to eat the surplus.
- But `staffing: 1` (one healthy 20-WORK upgrader), and the count DECAYED 4->1
  since the wait-fix reset (t72531657). Storage still +12/t in that clean window.
- Blackbox spawn log (window): hauler 18, miner 7, reserver 6, tanker 3, guard 2,
  feeder 1, builder 1, **upgrader 1**. Spawn `endFill 0.56` — the bank is NOT
  accumulating toward the 2300 campaign-upgrader wall; cheap BLOCKING income
  haulers keep draining it below 2300, so the wall never completes.

Mechanism: the scaling upgrader is `holdToFund` -> `mustFund` (campaign class),
BUT `blocking: false` (only the 1st upgrader blocks). The wall logic still lets
BLOCKING income demands spend while walling (SpawnScheduler ~L466), so a steady
income-hauler stream perpetually preempts the campaign upgrader's wall. holdToFund
(added for t72503018) walls only against cheap NON-blocking buys — blocking income
defeats it. Third incident on this exact seam (t72503018; the spec-26 collapse
death-spiral).

The TRAP: the naive fix — make the scaling upgrader outrank income — is EXACTLY
the spec-26 collapse death-spiral ("a campaign upgrader held the spawn ahead of
the income fleet"). So this must NOT be a blanket priority bump.

Proposed mechanism (NOT built — doctrine-critical, owner call): a CONDITIONED
windfall gate. A scaling consumer wins spawn priority over income ONLY when the
producer fleet is already secured (income safe) AND the warchest is in surplus;
during depletion/rebuild, income wins (no spiral). This is the windfall doctrine
("full bank -> consumers scale up") correctly conditioned on fleet-complete — the
condition the two prior patches lacked. Needs red-first tests for BOTH the
consume case AND the depletion-no-spiral case, plus a grid cell staging a full
warchest + depleted fleet.

Cycle verdict: **BLOCKER NAMED WITH DATA** (E4/P7 root = spawn-priority seam,
not sizing); fix ESCALATED (collides with the spec-26 death-spiral trap — the
mechanism, not another patch, is the work). My earlier "P7 auto-resolves at
warchest-full" call is FALSIFIED: warchest 2.8x full, controller still 0.46x.

**UPDATE — GATE BUILT & DEPLOYED (2026-07-24, "2 and 1").** Instrument then gate,
both shipped. Reading spawnPriority corrected the mechanism mid-build: the
campaign upgrader (value ~90) is not "walled and pierced" - it is OUTRANKED by
the income tier (1e6) and trickles in only via the 300t starvation one-shot
(the wallpreempt instrument was retargeted from gate "wall" to the real "queued"
case). The conditioned windfall gate: fleetSecured (every outstanding income
demand is a non-blocking replacement) lifts the campaign consumer to
SURPLUS_CONSUME_TIER (1.005e6, above non-blocking income, below blocking) AND
makes its wall strict, so the warchest is spent; any blocking income or income
growth (which prevents source rot) disarms it, so the death-spiral can't recur.
Pinned by flow-handoff + runt-economy (both green) and the existing t72503018
"scaling hauler still wins" test. Predicted prod deltas (verify ~200t):
upgraders 1 -> ~targetCount 4; P7 7 -> ~15 e/t; E4 storage stops rising/drains;
rclProgress rate up; wallpreempt fleetSecured=true events drop to ~0.

Cycle verdict: **FIXED** (instrument + conditioned gate shipped) - pending prod
verification of the predicted deltas.

**UPDATE — STORAGE THROTTLE (2026-07-24, supersedes the binary gate).** Owner
direction: relax producer-before-consumer with the warchest as a CONTINUOUS
governor rather than the binary fleetSecured gate. campaignConsumerLift(bankSurplus)
lifts a surplus consumer proportionally - 0 at/below reserve (hard producer-first),
ramping into the income band, capped below the blocking tier so the critical path
(fresh miner / first hauler) always wins. Self-balancing: consume -> warchest
falls -> lift recedes -> producers refill. The binary fleetSecured helper was
removed (dead); the wallpreempt instrument stays as the observability trail.
Gate: 1417 unit (incl. the 600-case nowPlanner sweep now randomizing bankSurplus),
flow-handoff + runt-economy + storage-depot all green; deployed. Predicted deltas
unchanged (verify ~200t): upgraders 1 -> ~targetCount; P7 -> ~15; E4 drains.

Cycle verdict: **FIXED (storage throttle shipped)** - pending prod verification.

**VERIFIED — storage throttle fixed E4/P7 (2026-07-24, capture t72536806).** ~2085t
post-deploy: P7 controller 7 -> 25.5 e/t; E4 slope +16/t (rising, FAIL) -> -4.97/t
(draining toward reserve, WARN) - the self-balancing the owner predicted; upgrader
fleet 20 -> 40 WORK, workUtil 1.00; LINK ctrl relay 7.4 -> 24.1 e/t. No death-spiral:
fleet total 32, harvest 7 intact, X5 churn 18% (remote invader/revoke only, 0% home),
P9 1.43x (unchanged). wallpreempt events 0 in-window - the throttle displaced the
preemptions the instrument was built to measure. No FAIL lines. Residual: E4 still
WARN (draining, self-resolving as it converges on reserve); upgrader targetCount
flaps with controllerFeederActive (feeder branch's domain, outcome unaffected).

Cycle verdict: **FIXED + VERIFIED** (E4/P7 restored in prod; storage-as-throttle
doctrine landed and self-balancing confirmed).

**AUDIT 2026-07-24 (t72541921) — board fully green; proposed stranded-hauler item self-healed.**
The previous cycle's work item (E2 stranded haulers 37-6/5-11, 44 parts) was TRANSIENT
invader churn in W42N23, not a stuck recycle: two captures ~5115t apart show E2 44 -> 2
(the orphans recycled; -8-8 caught mid-retire, the path working). No fix built - the
two-captures diagnosis rule correctly acquitted it. Whole ledger [ok], no FAIL/WARN:
E4 now [ok] (42.4k, slope -4.97 -> -1.28/t, DECELERATING as it nears reserve - the
storage throttle easing into equilibrium, not overshooting); P7 1.55x (23.3 e/t);
P4 0.71x. Waste-elimination has converged for this colony state. Named next lever
(GROWTH, not waste): P9 1.43x = 7 funded sources / 70 e/t but ~20 more remotes marked
"over-budget" with positive net (3-8 e/t) - spawn-capacity-limited. Capturing them
needs more spawn throughput (RCL/2nd spawn) or expansion (spec 06/18/21) - a strategic
call, outside the waste-ledger cycle.

Cycle verdict: **NO-OP (green board) + MEASURED** (E2 44->2 self-healed, E4 WARN->ok,
throttle self-balancing confirmed decelerating). No code change - correctly.

### AUDIT 2026-07-24 (t72548874) — feeder pinned the core link full, stranding ~17.4k of remote income (owner-reported)

Owner report: "the feeder is not draining the core link fast enough to allow the
remote link to send energy home ... piles as backup on the remotes ... does it need
to coordinate with the link firing down to the controller?" Root-caused from live
link stores (game/room-objects, W43N23) — the decisive read the rate meters miss:

| structure | t72548874 | t72548972 (+98t) | verdict |
|---|---|---|---|
| source link 4a83 (46,11) | **800/800** | **800/800** | FULL both reads — can't offload income |
| core link (35,25) | 600/800 | 794/800 | held high by the feeder |
| controller link (41,30) | 750/800 | 702/800 | ~full; upgrader burns ~2.5 e/t (3 WORK) |

`sourceBuffers` = ~17.4k stranded across 7 mines (dbcd8d 4673, dbcbd5 3563, ...);
`toHubRate` 23.8 e/t « the source link's ~40 e/t assigned flow (cd90+cd8e+cd8d+cedc)
— income backing up BEFORE the core. STUCK, not transient (two reads, 98t apart).

**Mechanism (not a symptom patch — the mechanism WAS the bug):** the feeder's
link-relay staged storage->core up to `coreLinkLoadRoom = capacity −
CORE_LINK_INCOME_RESERVE = 600`, IGNORING whether the controller relay could take
it. The controller link was already sated (relay blocked: ctrlFree 50-98 < the
100 fire threshold), so the staged 600 could not fire down — and it stole the
income headroom the remote source links needed to land their volleys. A doctrine
inversion: consumption-staging (controller relay) starved production (remote
income). Segment 4 confirms the relay was over-served — `toControllerRate` 24.4 ≈
`toHubRate` 23.8 (feeder pumping storage->core->controller into a full link the
upgraders couldn't drain), not banked.

**Fix (the owner's framing — "the feeder is the core's slave"):** `coreLinkLoadRoom`
gains the controller link's free capacity; the feeder holds the core to only
`min(capacity − reserve, controllerFree)`. Controller sated -> feeder stages
~nothing, the whole core stays open for source volleys; upgraders drain the
controller link -> the target rises and the feeder tops the relay from storage.
The feeder does NOT need to be bigger (it is correctly 1-CARRY for a ~2.5 e/t
burn; a bigger feeder would pin the core FASTER). Red-first: coreLinkLoadRoom
cases where the old rule returned 600 and the coordinated rule returns 50/400/250
(`controllerLinkNetwork.test.ts`). Regression gate: unit 1419 green; build green;
flow-handoff fails IDENTICALLY pre/post (a pre-existing mockup miner-production
failure in this container — acquitted by the attribution rule, its own incident).

Predicted prod deltas (verify ~200t post-deploy): source link 4a83 off 800/800;
`sourceBuffers` total falling from ~17.4k; `toHubRate` rising toward ~40; core
link level tracking controllerFree (low while the controller is sated); storage
banking the freed income. Cycle verdict: **FIXED (coordinated feeder shipped)** —
pending prod verification.

**VERIFIED — the fix landed as a major win + cascaded a 20x upgrader ramp
(2026-07-24, capture t72550963, ~1569t post-deploy).** Live link stores W43N23:

- **Core link 35,25: 600-794 → 0** (cd 5, cycling low). The feeder no longer
  pins it — CONFIRMED, the headline mechanism.
- **Relay over-supply stopped: `toControllerRate` 24.4 → 10.4 e/t** (fresh
  window since the deploy reset; `directShare` 5% → 22% — the core no longer
  jammed, so more 1-hop direct delivery). The feeder stopped pumping
  storage→core→controller into a sated link.
- **Banking restored: storageEnergy 43.2k → 81.1k (+24 e/t).** The income that
  was stranded/hidden now comes home and banks (E4 slope +18/t — see below).
- **THE causal link — upgrader `inflow` signal restored 2 → 115 e/t.** With the
  controller link no longer saturated, the upgrader sizing reads the TRUE inflow
  (it read 2 while the link sat at 750/800), so `targetCount` unlocked **1 → 6**
  and the fleet ramped **3 → 60 WORK** (workUtil 0.997), staffing 3 of 6 wanted,
  spawn util 0.71 (headroom to finish). rclProgress +15,993 (~10 e/t and rising
  as the fleet grows).

NOT fully confirmed / partial: source link 4a83 still 800/800 and `sourceBuffers`
~flat at ~19k (not draining). Unpinning the core moved the bottleneck one hop
UPSTREAM — the source-link's ~57 e/t ceiling (range 14) shared across 4 sources,
and the core-drain hauler (cd90 edge ~30 e/t) can't keep the core empty enough
for 4a83 to fire full volleys. That is a SEPARATE, non-regressing item (the DEP
ledger line already values it: cd8e/cd8d/cedc save 13 tiles each @10 e/t).

**E4 (idle capital, top ledger line, +18/t) is the TRANSIENT of this ramp, not a
new leak:** the fix converted ~17k of stranded remote energy into visible
bankable surplus, and the spend path (upgraders `targetCount` 1→6, storage-
throttle's domain) is mid-scale-up to absorb it. Acting on E4 now would fight the
in-flight ramp and re-patch a working mechanism (trap-list: "second patch on the
same mechanism"). Falsifying capture set (scheduled): does storage DRAIN as
staffing reaches 6/6 (transient, expected) or stay stuck (then throttle-strength
is the real item)? Cycle verdict: **FIXED + VERIFIED** (core unpinned, banking
restored, upgrader ramp unlocked via the inflow signal) — E4 transient watched,
source-link throughput named as the next lever with data.

**E4-transient CONFIRMED drained (2nd post-deploy capture t72551143, +180t).**
Two clean post-deploy reads settle it: storage **81.1k → 76.2k, slope flipped
+18/t → −27.2/t** (the ramp caught up and now BURNS the surplus), and
**rclProgress +58.1 e/t to the controller** (was ~10 pre-ramp) — the freed income
is now GCL/RCL progress at ~58 e/t, the whole point of the cycle. Core link
cycling low (0 → 150), feeder standingWork 60. So E4 was the ramp transient
exactly as predicted, not a leak — NO E4 fix was correct. Residual next lever
(unchanged): source link 4a83 still 800/800, `sourceBuffers` ~flat (+4.5/t) — the
source-link ~57 e/t throughput ceiling / core-drain sizing, a separate
non-regressing item for a later cycle. Cycle verdict: **FIXED + VERIFIED +
E4-TRANSIENT CLOSED** — controller progress ~10 → 58 e/t, storage draining, no
regression.

### AUDIT 2026-07-24 (t72552205) — link core-fill instrument REFUTES drain-limited; the pinned-remote symptom self-resolved

Owner follow-up: "can we drain the core at 40 e/t?" The pinned-remote symptom
(4a83 800/800, remotes ~19k, toHub stuck ~21) had THREE fits the two-snapshot
read couldn't separate — drain-limited (core full, fires clamped), input-limited
(core empty, small fires), or cadence. Rather than guess, shipped a core-fill +
hub-clamp instrument (LinkMeter v15, commit 6394aa1, observability-only) and read
one 523t window:

| field | value | reading |
|---|---|---|
| coreEmptyShare | 0.802 | core near-empty 80% of ticks |
| coreCongestedShare | 0.025 | no room for a volley only 2.5% |
| coreFillAvg | 62/800 | ~empty |
| hubClampShare | 0.143 | 14% of source fires clamped |
| hubVolleyAvg | 425 | healthy mid-size volleys |
| toHub / toController | 11.4 / 34.0 | directShare 0.447 |

**Hypothesis (A) drain-limited is REFUTED** — the core is empty 80% of ticks and
congested 2.5%; it is NOT the constraint. The "faster bank-drain / smaller
CORE_LINK_INCOME_RESERVE" fix I was leaning toward would have chased a ghost —
the instrument paid for itself by killing it (spec-14 discipline: instrument the
invisible cause, don't theorize twice). Live snapshot corroborates: 4a83 at 62,
no longer pinned.

**The symptom self-resolved via the upgrader ramp.** The feeder fix (087bf48)
raised consumption (toController 10→34, 44% now cheap 1-hop direct), which pulls
energy through the network; total link throughput toHub 11 + toController 34 =
~45 e/t (already > the 40 target), core a clear pass-through. sourceBuffers now
DRAINING: 19.9k → 15.8k → 14.8k over ~1000t (≈ −4/t), near the healthy per-source
sawtooth (~2k/source between hauler visits). Storage 51.5k, still draining as the
upgraders burn.

**No core/link fix warranted** — attacking core-drain now would destabilize a
resolved, self-correcting flow (trap-list: question the mechanism; don't nudge
the reserve in isolation). If the residual ~15k is ever to clear FASTER, that is
a remote-deposit-hauler capacity question, not a core/link one — and the DEP
ledger line already prices the link-placement half. Cycle verdict:
**INSTRUMENTED + FALSIFIED (drain-limited) + SELF-RESOLVED** (remotes draining
−4/t, link throughput ~45 e/t, core not the constraint). The core-fill/hub-clamp
stamps stay as permanent link-network observability.

### AUDIT 2026-07-24 (t72553726) — E4 recurs; traced end-to-end to the spawn-capacity ceiling, NO fixable leak

Ledger top line E4 idle capital: storage 60.4k vs reserve 22.65k (2.67x), slope
+5.9/t, feederActive FALSE. Traced the spend path across TWO captures (t72552205
→ t72553726, 1521t) and the code, ruling out every fixable-bug hypothesis:

- **The coupling**: feeder queue-starved (0 creeps, gate "demand", queue pos
  7/7, spawn util 0.92) → controllerFeederActive false → the upgrader's
  `bankedBehindFeeder` is NULL (UpgradingCorp:88-107) → `surplus=false` →
  `inflow=2` (the anti-downgrade trickle) → targetCount 1 → fleet DECAYS 40→24
  WORK → consumption drops → the 40k surplus banks. inflow read 2 in BOTH
  captures (even at t72552205 with the feeder briefly up), so the fleet is
  decaying off the trickle, not ramping.
- **Ruled out — upgrader surplus-gating is CORRECT doctrine**: upgraders may
  only scale to eat surplus a feeder is actually RELAYING to them; sizing them
  to a bank they can't reach would starve them. Gating on feederActive is right.
- **Ruled out — the infrastructure pierce is NOT broken** (SpawnScheduler:651,
  681): infra demands pierce HOLDS but "never displace an actual buy". On a
  saturated spawn with producers all affordable+buying, the feeder (value 95,
  infra) correctly waits behind them — it oscillates (spawns in slack, waits
  when full), it is not starved by a bug.
- **Ruled out — churn/priority waste**: build mix balanced-productive (haulers
  31%, upgraders 15%, reservers 14%, tenders 14%, miners 12%), X5 home churn
  0%, P4 0.94x ceiling. The spawn is genuinely saturated on productive work.

**Verdict: E4 is the spawn-capacity ceiling, CONFIRMED — not a leak.** The colony
mines/hauls ~100 e/t home (57% of spawn) but can only build enough spend-path
(feeder + upgraders) to consume ~16-24 at the controller, so the rest banks; the
feeder-oscillation just makes the shortfall visible. Every seam in the chain is
working as designed — same structural conclusion as t72541921
("spawn-capacity-limited... needs RCL7/2nd spawn or expansion"). The two real
levers are both outside the waste-ledger: (1) reach RCL7 for a 2nd spawn (1.33M
energy out at ~16 e/t = slow, the ceiling is self-reinforcing); (2) the spec-26
stage-5 storage↔controller MERGE, which DELETES the feeder relay entirely (one
fewer spawn consumer AND no core→controller relay). Cycle verdict: **BLOCKER
CONFIRMED WITH DATA + FIXABLE-BUG HYPOTHESES FALSIFIED** (pierce, sizing, gating,
churn all cleared) — no code change, correctly. Owner call on the growth lever.

### AUDIT 2026-07-24/25 (t72554460) — E4 coupling FIXED at the root: the feeder is the linchpin (owner directive)

Owner reframed the t72553726 "structural ceiling": "the feeder is so crucial —
unless we have basically no energy we always want it; everything else is
optimized to rely on it. Miners are more important only when we have NO energy,
which is rare." That is the fix, not a ceiling — the spend path degrades because
the LINCHPIN is optional. Made the first feeder outrank the miner band when
energy is present:

- `ControllerFeederCorp.getSpawnDemand` first-feeder value: **150** when banked >=
  FEEDER_INCOME_FIRST_FLOOR (2000), else **90** (drained → income first). Above
  the miner band (100 + efficiency*0.5 = 125-147; efficiency=net/rate*100 < 100).
  A false first cut used 101 — below the miner band, nearly inert; the owner's
  "miners more important than feeders only with NO energy" caught the magnitude.
  NON-blocking, so topping the ladder cannot wall/spiral the bank.
- Plus spawn-onto-post placement: `CorpKind.spawnTarget` hook +
  `spawnDirectionsToward` → the feeder is born facing the core link (no walk-in).

**Prod watch (deployed t72554141/t72554260, read t72554460, ~319t):** every
rollback trigger CLEAR — X5 churn **0** (no death spiral), fleet 33→30 (−9% <
20%), miners 7/7 sources fully staffed (8→7 = converge to plan, not starved),
defense raidGuard 2→2, util 0.968 (not pinned). And the causal chain fired:
feeder **0→1 (staffed, feederActive true)** → upgrader `inflow` **2→33** (surplus
signal restored via bankedBehindFeeder) → `targetCount` **1→2** → storage slope
**+5.9 → −2.0/t (draining)** → **E4 FAIL→WARN**. The upgrade WORK dip (24→15) is
the resize transient (5 decayed small upgraders → fewer bigger ones toward
targetCount 2), not a loss — inflow 2→33 is the proof the mechanism now works.

Cycle verdict: **FIXED + VERIFIED (no rollback)** — the E4 idle-capital coupling
is broken at the root; the feeder is reliably up and the upgraders now see the
surplus. Residual watch: confirm the upgrader ramp completes (standingWork →
~targetCount) and storage keeps draining toward reserve (self-balancing windfall
draw). Gate note: unit 1432 green + build; grid/trio could not run in-container —
prod watch stood in, clean.

**CONFIRMED (t72555021, +561t) — the ramp completed, self-balancing draw holds.**
upgrade standingWork **15→38** (climbed past the 24 baseline, not stalled),
storage still draining **−3.8/t** (E4 36.3k→34.2k above reserve, falling), feeder
reliably staffed (1, feederActive true, no oscillation). The `inflow` 33→20 taper
is the windfall draw self-balancing (bank nears reserve → surplus draw eases →
consumption tapers to match) — intended, not a stall. Defense NON-issue: raidGuard
2→1 is lifecycle, not feeder starvation — the W44N23 debt was PAID DOWN
120870→10 (guard completed + recycled) and the corp re-fields for W42N22 (94k),
its guard demand alone at the front of the queue (util 0.969, q1), unobstructed by
the already-staffed feeder. rclProgress ~+19 e/t to the controller (was ~10).
Cycle verdict: **FIXED + VERIFIED + CONFIRMED** — the feeder-linchpin line is
done (core-pin fix → instrument → linchpin priority → spawn-onto-post); E4
converted from a "structural ceiling" into a drained, self-balancing spend path.

### AUDIT 2026-07-25 (t72558524→t72559557) — "spawn capacity but short on haulers": premise FALSIFIED with a new per-tick idle instrument; piles are the spawn-ceiling symptom

Owner report: "we have spawn capacity, but we are short on haulers... energy
sitting in piles on the ground not getting hauled... means our haulers aren't
enough." Explicitly deprioritized the upgrader/controller thread.

**Measured the pile leak (real):** across 12 captures the source buffers
(`sourceBuffers`, container+dropped within range 1) stand at ~8120 energy ABOVE
the 2000 container cap on average (peak 12764) — dropped on the ground decaying
at ~7-18 e/t (~11 avg ≈ 15% of the 70 e/t mined). Cause: source haulers are
sized to sustained inflow (`carryPartsFor(rate,d)`) with NO buffer-drain term,
so every delivery/succession gap ratchets the pile up permanently. Asymmetric
with `scavengeRate` (which DOES drain a standing pile). This is a DOCUMENTED
deliberate choice (`flowAdapter.ts:483`, the shard1 stress-fixture "fantasy
plan" incident: sizing fleets to stocks inflated supply to 316 CARRY vs 20 e/t
mined). Not flipped blind.

**Chased the spawn energy-starvation (owner's chosen lever).** Prior stamps
measured fill AT finishes (finishes-weighted endFill 0.861) but never WHY each
idle tick was idle; the 180-tick pre-deploy windows showing util 0.70 with
queueDepth 4-8 were short-window noise. Built the instrument that closes the
gap: `classifySpawnIdle` attributes every non-spawning tick to its NOW-plan
head — empty (no demand), bank (head unaffordable: energy-starved), buy
(decided-buy yet idle: exec latency), hold (affordable but held). Exposed as
segment-0 `spawns[].idle` (v18) + S4 ledger line (recoverable = bank+hold).
Telemetry-only (no decision path touched); test-unit 1463 green, build green;
deployed to prod.

**Post-deploy read (t72559557, ~1030t):** util 0.898, S4 recoverable idle
**0.0**, idle split `{empty:0, bank:0, buy:11, hold:0}` — every idle tick is the
unavoidable 1-tick back-to-back build transition. Zero energy-starvation, zero
no-demand idle, zero chosen-waits. (Window straddled the deploy so busy/finishes
counted pre-deploy ticks while idle only accumulated post-deploy — clean-window
recapture pending for the exact post-deploy util; the CAUSE split is already a
clean post-deploy read.)

**Verdict: PREMISE FALSIFIED + BLOCKER RE-CONFIRMED + INSTRUMENTED.** There is no
recoverable spawn idle — the spawn is saturated on productive work, the same
structural conclusion as t72553726 / t72541921 ("spawn-capacity ceiling, not a
leak; levers are RCL7/2nd spawn or the spec-26 storage↔controller merge"). The
"short on haulers / piles rotting" symptom is a DOWNSTREAM effect of that
ceiling: haulers can't be over-provisioned past inflow-matching to drain the
buffers without displacing productive spawn work (P4 0.87-0.95x, SCAV "spawn
parts DRY binding"). The new S4 line makes "is there spare spawn capacity?" a
permanent one-line read — recoverable idle ~0 answers it every capture. Note P7
controller-delivery FAIL (0.14x) is the pre-existing controller-feed flap
(demand 15↔160), and it gates lever 1 (RCL7 needs controller energy) — the
connected path out of the ceiling, though owner-deprioritized this cycle.

### AUDIT 2026-07-25 (t72560582) — hauler duty meter ANSWERS (a)/(b)/(c): it's (c) SINK backpressure, not a plan under-ask

Owner pushed back on "spawn-ceiling symptom, not fixable": haulers are income
tier (funded before the upgraders that eat 42% of build-energy), so hauler
demand is SATISFIED - the piles are either (a) the plan under-asking, (b)
under-fielding, or (c) execution. Chose to instrument (c) before touching the
planner.

Built the hauler execution duty meter: classifyHaulerTick(moved, transacted,
loaded) -> active | idleSource (empty, waiting/blocked to load) | idleSink
(loaded, waiting/blocked to deliver), rolling ~1500t window per CarryCorp,
stamped into segment-4 sizing + new H1 ledger line. Full gate green (unit 1466,
trio flow-handoff/runt-economy/storage-depot, build); deployed.

**Post-deploy read (t72560582, 276t window): FLEET duty 0.669, idleSource
0.035, idleSink 0.296.** Prediction (a: high duty) FALSIFIED. Haulers load fine
(idleSource ~0) but spend ~30% LOADED and unable to deposit. Effective delivery
~0.67 of sized capacity = BELOW the 10 e/t harvest inflow, so buffers GROW
(ground-over-cap 4198 -> 9389) and rot. (b) ruled out (fleet ~ plan). Not (a):
adding hauler carry would just queue more creeps at the sink.

Cause narrowed: idleSink is NOT deposit-port-correlated (worst stallers cd92
0.56, cd8d 0.44, cbd5 0.43 are port-LESS; cd92 is dist-5 home-room). Two
near-identical dist-5 routes split cd90 0.12 vs cd92 0.56 - heterogeneity =
CONTENTION at the shared storage/core deposit point (13/16 edges -> one
storage; hub link clamped 0.57, taxRate 2.05, coreEmpty 0.31), not a uniform
sizing/artifact. Measurement caveat: transfer resolves next tick, so ~1
idle-tick/trip inflates absolute idleSink; but the 10x idleSink>>idleSource
asymmetry + route heterogeneity + persistent above-cap buffers confirm genuine
sink backpressure independent of the artifact.

**Verdict: (c) CONFIRMED (sink backpressure) + prediction FALSIFIED + INSTRUMENTED.**
The fix is delivery-side (decongest the core deposit / spread deposit points /
storage-link drain), NOT more haulers and NOT (yet) the buffer-drain plan term -
which would have made it worse. Next: pin the exact contention (storage-tile
access vs link drain vs feeder/tender crowding), refine the meter to net out the
transfer-lag tick, then fix.

### AUDIT 2026-07-25 (cont.) — idleSink split deployed; runt-economy false-red was host-load flakiness

Added the idleSink at-sink/en-route split (segment-4 idleSinkAtSinkFrac; H1
reads it). Integration trio flaked: runt-economy failed 2x at 13-14m (miners
stuck at 2 WORK, never upsized). ATTRIBUTION (doctrine): ran the cell on the
pre-change baseline (2d41746) -> PASSED (largest 3 WORK, exit tick 460, 4m); my
split code re-run solo with the host quiet ALSO PASSED (exit 460, 4m, no
errors). So the change is ACQUITTED - not a throw (no errors captured, an
observability meter that only reads state + writes unused memory fields cannot
stall miner upsizing). The false reds were the mockup's real-CPU metering
coupling to HOST LOAD (documented blind spot): the earlier trio runs overlapped
several parallel background captures/test-runs, starving the cold-start ramp so
miners missed the upsize within the 1200t budget. Clean full trio (host quiet):
flow-handoff 5m, runt-economy 4m (upsize PROVEN t460), storage-depot 7s - all
green. Lesson: never run heavy background work concurrent with the trio.
Deployed; recapturing the at-sink/en-route split next.

### AUDIT 2026-07-25 (t72561884) — idleSink is EN-ROUTE: haulers wedge behind the parked feeder at the storage approach

Split read: FLEET duty 0.812, idleSource 0.017, idleSink 0.171 [atSink 0.032,
EN-ROUTE 0.139]. ~81% of the sink-side idle is EN-ROUTE, not at the sink.
Port-less source haulers (cbd5/cee0/4-30/cd90/cd92) are ~100% en-route; only the
two deposit-port haulers (cd8e/cedc) show atSink (their spec-26 link-clamp hold).
So the loss is approach-LANE congestion, not deposit throughput.

Mechanism (code-confirmed): ControllerFeederCorp parks "adjacent to the storage"
(:363) - a standing, non-yielding relay ON a storage-approach tile. Haulers
converging on the single storage to deposit wedge behind it: travelToLane is
creep-blind and its swap rule only clears MOVING traffic ("Only a STANDING
blocker ... defeats that", movement.ts:114). ~14-30% of hauler throughput
(varies by capture) is lost this way, dropping delivery below the 10 e/t inflow
so buffers grow and rot (over-cap ~6-9k).

Verdict: (c) sink backpressure fully localized to EN-ROUTE core-approach
congestion, prime blocker the parked feeder. Fix is positioning/movement
(reposition the feeder's post off the hauler lane; or let haulers swap past the
stationary relay; or widen storage deposit access) - NOT more haulers, NOT the
buffer-drain plan term. Fix design pending owner steer (architectural/movement
tradeoffs).

---

## Cycle t72571505 — upgrader body flap on transient feeder death (churn leak)

**Ledger:** no FAIL lines; sole WARN P4 spawn-infeasibility 0.91× (structural —
single spawn, home W43N23 RCL6 at 75% to RCL7, util pinned 0.97 for the whole
recent window). Not directly attackable without hurting the economy or reaching
RCL7 (2nd spawn). So the cycle attacked the largest MEASURED waste under it.

**Diagnosis (data, not vibes):** the upgrader `sizing.inflow` flaps **2↔115**
and the body flaps **w49↔w3** across captures — chronic across 170k+ ticks of
committed fixtures (seg4 trend t72400561→t72571505), not a transient. Root:
`UpgradingCorp` derived `bankedBehindFeeder` SOLELY from the transient
`room.memory.controllerFeederActive` flag (true only while a feeder creep is
alive this tick). The single non-blocking feeder dies/respawns every ~N ticks →
flag flaps false → surplus verdict lost → inflow→2 → body recycled to the sip →
rebuilt on respawn. Blackbox (seg5) confirmed the cost: **5 upgrader respawns in
2808t** (avg 1820e, worst **2300e@78t** vs ~1500t natural life ⇒ ~3 excess),
~210 spawn-ticks (~7.5% of a spawn-bound spawn) on pure churn; the w3 windows
halved delivery (P7 24.7 e/t actual vs a ~49 e/t surplus relay), and storage
re-accumulated **+0.38/t above the 56k reserve** (reversing the prior cycle's
drain).

**Relation to the prior cycle (t72554–72555):** that cycle made the feeder
RELIABLE (core-pin fix, linchpin priority, spawn-onto-post) so `feederActive`
stays up more; but feeders still die transiently and the upgrader still
collapsed in the gaps. Rather than a third feeder-reliability patch, this fix
INTERROGATES the mechanism (trap list, "second patch"): it removes the
upgrader's dependency on feeder LIVENESS. Standing assets keep working — the
upgrader holds its body across a feeder gap because haulers deliver directly
(CarryCorp "a dead feeder never starves upgrading").

**Fix:** `bankBehindFeeder` — the durable feeder-relay verdict, mirroring the
already-proven `CarryCorp.shouldBankControllerLoad` for the SAME feeder. Bank in
view whenever a feeder is alive OR the controller buffer holds
(≥ CONTROLLER_STARVE_FLOOR=200); only genuine starvation (buffer drained, no
feeder) drops it. One lens, two readers. Red-first: 6 new unit cases pin
ride-the-gap + flap closure (w3 sip → ~49.5 sustained). Gate: unit 1462 +
build + flow-handoff/runt-economy/storage-depot trio all green.

**Deployed** to prod (master) at commit dcccbf6 (post-t72571505 global reset).

**Predicted deltas (verify ~2400t out, past reset recovery):** inflow stops
flapping to 2 (holds ~49 while stock≥200); body holds ~w40–49; X5 home churn
< 11% and the 2300e@78t upgrader class gone; P7 delivery → ~49 e/t; storage
slope turns negative (drains toward reserve). Regression rule: any triage line
worse than the t72571505 baseline ⇒ redeploy origin/master, record falsified.

**VERIFIED (t72576379, +4874t, past reset recovery) — every predicted delta
hit, ledger fully green (no FAIL, no WARN — the P4 WARN itself cleared):**
- P4 spawn-infeasibility **0.91→0.75 (WARN→ok)**: upgrader plan WORK 95p→20p,
  spawn util 0.973→0.914 — the colony left the spawn-bound plateau.
- Upgrader churn: **5 respawns/2808t (w49↔w3) → 3 (all big-bodied)**; the
  early-death interval doubled (2300e@78t → @144t); home rebuild share 11%→9%.
  No w3 teardown - the flap is closed.
- P7 controller delivery **24.7→29.9 e/t** (1.65×→2.0× the lower-endpoint plan).
- E4/storage slope **+0.38→−4.85/t**: the banked surplus (61k) was eaten down
  through the 56k reserve exactly as the windfall doctrine intends; once below
  reserve the save regime throttled the upgrader to a sip (inflow 2, plan WORK
  20p) - self-balancing, no flap without a surplus. X1 dry WORK 0.10 (workUtil
  0.99): the 20 WORK stands fully fed, not starved.

Cycle verdict: **FIXED + VERIFIED**. Residual watch (next cycle): storage sat
−18.5k below reserve draining −4.85/t at the read (partly post-reset guard/
reserver recovery spend, partly the windfall-draw tail); confirm it self-
corrects back toward reserve in the save regime and is not runaway upgrader
consumption.

---

## Incident 2026-07-26 — X5 phantom churn on multi-slot corps (instrument bug)

**Capture:** t72587664 (fixture `shard1-t72587664.json`, blackbox slimmed to
spawn/churn/raid/hold rows). Baseline t72576379.

**Symptom:** the ledger's only non-ok line was `[WARN] X5 rebuild churn 0.24`,
worst `W43N23-reservation 1300e@12t - FAST RESPAWN (<60t = double-order/loop)`.
The WARN pointed straight at the reserver mechanism — the single subsystem the
trap list says never to bandaid.

**Diagnosis (data, not vibes):** the reservation corp is ONE corp staffing 4
remote rooms (creepCount 4, banks W42N22 3569 / W42N23 4166 / W43N24 3329 /
W44N23 3110 all healthy, P6 pump +14174t/11284t). Its 16 spawns over 2624t =
one per room per ~656t ≈ the 600t claim lifetime — the reservers live full
lives. X5's bug: it paired CONSECUTIVE spawns in the corp's combined log and
read the gap as one creep's lifetime. But consecutive spawns are DIFFERENT
slots ~life/N apart, and a cohort rebuild wave serialises all N through one
spawn ~spawn-time (12t) apart. For a healthy staffing-N corp the steady gap is
life/N, which the formula scored as `cost·(1−1/N)` = 975e phantom churn PER
spawn (N=4). The 12t worst gap then tripped `loop = worstGap < 60`, firing the
false WARN. The pre-raid timing of the big early cluster (spawns 72585076–
72585617, first raid 72585890) confirmed it was NOT invader-driven.

**Fix (scripts/waste-ledger.ts `computeChurn`):** a creep's replacement is the
next spawn OF ITS SLOT — `ss[i+staffing]`, not `ss[i+1]`. For staffing 1 this
IS the consecutive gap, so all single-slot behaviour (and every existing test)
is unchanged. Red-first: a synthetic healthy 4-slot corp (staggered full-life
replacements) that the old code booked at 7800e churn + WARN and the new code
reads at 0 + ok. The live `W43N23-reservation` phantom dropped 11828e → 6546e
(the residual is genuine short-same-slot-gap remote noise, the invader/revoke
class doctrine accepts).

**Result:** X5 **WARN→ok**, 0.24→0.15, 17804e→11288e; worst offender is now a
real hauler churn (`W42N23-hauling-cedc 1800e@591t`, ~40% life, not a loop).
**Ledger fully green — no FAIL, no WARN.** home churn 0%.

**Scope:** observability-only — `waste-ledger.ts` is a script, not in
`dist/main.js`; bot behaviour unchanged, no deploy. Gate: unit 1508 + build
green.

Cycle verdict: **FIXED** (instrument). The economy itself carried no actionable
leak this cycle — progress is AHEAD of plan (P7 1.70×, P9 mining 1.43×,
warchest filling toward the 56k reserve); the top signal was the X5 false-WARN,
now reporting truth so future cycles aren't misdirected onto the reserver
mechanism.

---

## Incident 2026-07-26 — source energy piling & rotting (INSTRUMENT phase)

**Owner report:** "energy is piling up and rotting at the sources ... some
haulers between the core and the NE link that seem confused ... some lost creeps
just standing around."

**Confirmed from data (capture t72588289, and the trend across ~28k ticks):**
- Source buffers sit **8,498e above the 2000 container cap right now**, and
  2.5k–9.4k above cap in EVERY capture t72560582..t72588289.

**Model correction (owner, 2026-07-26): NOT a permanent ratchet — decay bounds
it.** Ground energy decays at `ceil(amount/1000)` per tick, a restoring force
proportional to pile size. So the pile settles at an EQUILIBRIUM where decay
balances the haul deficit: for inflow I and actual hauled throughput H, the
ground pile holds at `I − H = ceil(groundPile/1000)`. Consequences that reframe
the fix:
  - **H ≥ I ⇒ the pile decays to zero** (settles ≤ container cap). A transient
    setback clears itself for free — the owner's "piles degenerate."
  - A *stable* pile is therefore NOT un-recovered gaps; it is CHRONIC
    under-delivery (H < I), and the pile size READS OUT the deficit:
    `dbcd92` 3993 over cap ⇒ ~4 e/t chronically rotting (on a ~10 e/t reserved
    source, H ≈ 6 e/t — the carry-6 hauler at ~50% duty ⇒ EXECUTION loss, not a
    missing drain term). `cee0` 1180 over cap with 0 haulers does not fit an
    I=10 equilibrium (~10k) ⇒ almost certainly mid-transient (miner also dead,
    I≈0, pile decaying) — the trend, not one capture, decides.
  - The earlier #139 framing ("no buffer-drain term, every gap ratchets the
    pile up permanently") is thus WRONG as stated: the lever is NOT a
    scavenge-style pile-drain term. It is **make H ≥ I + a small margin** (the
    margin only has to beat duty losses); decay does the rest. Fix the chronic
    H < I per source: undersized body, missing hauler, or duty loss (traffic /
    link-clamp / idle-at-sink).
- Secondary: the best-netting remote (`dbcee0` W42N22, net 8.19 e/t, plan 18.8
  carry) had **0 haulers** while its buffer sat at 3180 — crowded out at a
  saturated spawn (util 0.945).
- The single worst pile is a HOME source (`dbcd92`, 5993) with the hub link
  clamped 55% of the time (`hubClampShare 0.547`) — so it MIGHT be a link
  backlog, not a hauler shortfall. Intel carries no link geometry, so the
  mechanism is unresolved from the current segments.

**Owner steer:** instrument first, then fix (don't guess the worst offender's
mechanism, and don't nudge core hauling sizing blind — CorpPlanner.ts:591
records an aggressive 150-tick drain once crowding production out of the parts
ledger).

**Instrument shipped (this cycle):** `CarryCorp.readPickupBuffer` stamps, at the
sizing site, the ACTUAL pickup buffer (`staged` = container + ground piles in
range 1) and the source-link state (`srcLinkEnergy`/`srcLinkCap`, a link in
range 2), alongside the sustained-inflow `carryNeeded` the fleet is sized to.
`staged` is null when the pickup room isn't visible (a fact distinct from zero,
and the signal that a remote drain term must read a durable buffer, not live
vision). Corps segment v4→v5. Red-first: 5 unit cases pin the under-sized
signature (pile high, no link), the link-backlog signature (link pinned at cap),
Chebyshev range exclusion, and the null/unmeasurable cases. Observability-only
(a read + stamp, no decision change). Gate: unit 1513 + build green.

**Predicted deltas to READ next capture (~200t+ post-deploy), through the
corrected (H vs I) lens:** per hauling corp, read `sizing.staged` (the pile =
the deficit, ~ground/1000 e/t) against the duty split already stamped —
  - high `duty` + standing pile ⇒ the plan UNDER-ASKS (`carryNeeded` sized to
    nominal I but real I higher, or H capped below I): fix = size H to I+margin;
  - low `duty` + standing pile ⇒ EXECUTION loss — read `idleSourceFrac`
    (arriving to an empty source) vs `idleSinkFrac`/`idleSinkAtSinkFrac`
    (blocked at delivery: link-clamp / lane traffic). Concrete prediction:
    `dbcd92` should read `duty ≈ 0.5` (H≈6 vs I≈10) if it is execution loss;
    `srcLinkEnergy`/`srcLinkCap` present + pinned ⇒ link backlog.
The fix follows from the proven per-source cause (right-size H, unblock the
delivery leg, or field the missing hauler) — NOT a pile-drain term; decay clears
the residual once H ≥ I.

Cycle verdict: **INSTRUMENTED** (fix deferred to the post-capture read, now
framed as H-vs-I deficit localisation, not ratchet recovery).

---

## Change 2026-07-26 — ReservationCorp split to one corp per NODE (owner directive)

**Owner directive:** "Reservation Corp should be multiple corps. One per Node
(ie controller)."

Before: ONE reservation corp per home room held a `targetRooms[]` list (4 remote
rooms live), so its spawn log interleaved 4 independent reserver lifetimes -
exactly the multi-slot shape the X5 same-slot fix had to correct, and a single
corp whose funding/defunding couldn't be reasoned about per room.

After: `reservationKind.propose` emits ONE commission per mined remote (bound to
its NEAREST home spawn within scout range, deterministic tiebreak so a remote
reachable from two homes gets exactly one corp). Commission id
`reservation-<remote>`, runtime corp id `reservation-<remote>-reservation`,
nodeId `<remote>-reservation` so `getPosition()` and the default orphan rule
resolve to the reserved room. Each corp holds exactly one node; the corp's
internal per-room logic (one-way latch, duty cycle, opportunistic topup,
purchase-loop guard) is UNCHANGED and now operates on its single room - a
deliberate low-risk choice given the reservation mechanism's incident history
(the getSpawnDemand guards were not rewritten).

Migration is graceful: on redeploy the pre-split per-home corp is retained
(`retiring`) until its reservers die, while the new per-node corps take over
spawning; the duty cycle reads the reservation bank the old reservers maintain,
so no double-spawn. A new `claimsOrphan` re-adopts any reserver that outlives
its old corp by its `targetRoom` (not its transit room), so an in-flight
reserver is never recycled mid-route.

Red-first: reservationKind.test.ts rungs 2-4 rewritten to the per-node contract
+ 5 new cases (one commission per remote, per-node keying, position resolves to
the node, claimsOrphan-by-targetRoom, wildcard yields none). Gate: unit 1518 +
build + flow-handoff/runt-economy/storage-depot/remote-mining.

### FAILED IN PROD, ROLLED BACK, ROOT-CAUSED, RE-FIXED (t72591424)

Deployed the split; the recapture caught a **reserver purchase loop**: 17 live
reservers (vs ~4 pre-split), **11 piled on W42N22** with its bank stuck at 3974,
23 reserver spawns in 2030t = **46% of ALL spawn energy** (the CLAUDE.md
"reserver loop was 53%" trap, reproduced). Redeployed origin (696d3b2, the
pre-split pile-instrument build) immediately to stop the bleed.

Root cause — my "keep the trap-hardened logic, just feed it one room" assumption
was WRONG. The opportunistic-topup guard blocked only on an UNASSIGNED wildcard
(`!hasWildcard`), so once work() latched a reserver the corp offered ANOTHER.
The old multi-room corp masked this: its wildcards spread across 4 rooms and the
COLLECTIVE bank hit the 5000 cap, self-terminating the loop. The per-node split
removed that safety valve — one corp, one room whose bank could not rise
(reservers ineffective / in-flight) ⇒ opportunistic fired every tick, unbounded.
The mechanism bug: opportunistic spawned on BANK LEVEL with no hard per-room
COUNT cap. (Textbook CLAUDE.md meta-lesson — the reservation mechanism bites the
moment you lean on it; the fix had to interrogate the mechanism, not the
trigger.)

Fix (ReservationCorp.getSpawnDemand, opportunistic branch): cap at ONE reserver
per target room — guard on `countLivingReservers() < targets.length` (counts
assigned + unassigned + SPAWNING, so the corp never re-orders against its own
in-flight purchase) instead of the wildcard-only check. Bounds both single- and
multi-room corps; the demand path was already count-bounded via the wildcard/
assigned coverage check. Red-first: 2 new ReservationCorp cases (a room with a
latched reserver, and one with a spawning newborn, each offers ZERO opportunistic
top-up despite cap headroom) — verified red on the pre-fix build, green after.
Gate: unit 1520 + build + integration gate (re-running) before re-deploy.

Cycle verdict (this deploy): **REGRESSION → ROLLED BACK → RE-FIXED**; re-deploy
gated on the integration suite + a post-deploy recapture that must show ≤1
reserver per room and reserver spawn-energy back to steady state.

### VERIFIED (t72595222, post re-deploy)

The re-deploy (split + opportunistic count-cap) is confirmed GOOD:
- **4 reservation corps, ONE per remote node** (W42N22/W42N23/W43N24/W44N23),
  each **creepCount=1**, body 2·CLAIM+2·MOVE, all gates `reservation-banked`
  (coasting, not looping). Total reservation creeps **4** (regression was 17,
  11 piled on W42N22).
- Reserver spawn energy 30% of a small fresh-reset window (was 46%); the
  decisive signal is 1 reserver/room + banked gates, not the recovery-window %.
- Ledger clean: no FAIL; the two WARNs (E5 runts feeder@100/hauler@100, X5 0.06
  @51t) are the documented post-reset recovery transients, not steady state.

Cycle verdict: **FIXED + VERIFIED** — the per-node ReservationCorp split (owner
directive) is live and stable; the multi-slot interleave that forced the X5
same-slot correction is gone. Fixture shard1-t72595222 (core+corps+blackbox).

### Source-pile leak LOCALISED (t72595222, H-vs-I / duty read)

The pending pile read, through the corrected model: the leak is **execution
loss from approach-lane congestion where the remote haul routes converge on the
core**, NOT under-sizing and NOT a link backlog.
- H1: fleet duty 0.78, idleSink 0.21 **[atSink 0.07, EN-ROUTE 0.14]**,
  ground-piled 3970e. Per-corp (new `staged`/`srcLink` stamps): remote haulers
  carry their idleSink almost entirely EN-ROUTE — cee0 (W42N22) idleSink 0.30 /
  atSink 0, cbd5 (W44N23) 0.32 / atSink 0, cd8d (W43N24) 0.19 — blocked on the
  return leg into the core. staged 2.6k–3.6k at those remotes.
- **Link-backlog hypothesis FALSIFIED**: `dbcd92` (the earlier worst pile) has
  `srcLink None` — no link at all — and drained to 1290 post-reset. The one
  link-fed home source, `dbcd90`, shows `srcLink 800/800` (hub link saturated,
  `hubClampShare 0.59`, `directShare 3%`) but is distance-1 to storage so it
  does not pile.
- Corollary waste surfaced same capture: **tenders over-staffed 3× (66 parts /
  3 creeps at duty 0.11)** vs the spec-31 one-lane-tender ideal; link network
  saturated but delivering only 7.5 e/t / 3% direct to the controller.

Next work item (own cycle): decongest the core convergence for remote haulers —
target named with data, fix not yet designed. Owner review of the ideal base
layout (specs 02/26/31: clear highways, links-as-hub-ports, one lane tender) is
the framing for that cycle.

## AUDIT 2026-07-27 (cont.) — builder budget: tanker over-provisioning + wartime build acceleration

Owner: "the builder budget seems off ... speed it up a bit ... sized for at
least all 4 extensions ... even at the leisurely pace the fleet is mismatched."
Root causes read from code + t72596906 (build corp cc4, body carry34/move14/
work2 - almost all tanker, ~no builder):
- TANKER OVER-PROVISIONING: `targetTankerCount` computed the real `carryNeeded`
  (~6) but sized each of >=2 bodies to the 16-CARRY max => 32 CARRY for a 2-WORK
  site. Fix: `tankerPlan` distributes `carryNeeded` across the bodies (each its
  SHARE), hot-swap floor of 2 held. The fleet proportion is now matched at any
  pace (the owner's point 2).
- BUILD RATE THROTTLED by design: crew + plan sink both sized to
  `projectAbsorbRate(one placed site)` over the 2/3-life horizon => tiny crew.
  Fix (spec 33 down-payment): `WARTIME_COMPLETION_FRACTION 1/3` shortens the
  horizon while a spendable surplus stands, ~2x the crew AND the sink absorb,
  coherently (both readers off `bankSurplusRate`); bounded by available energy;
  filling warchest keeps the lifetime pace. Recalibrated the surplus-staged pins
  (builderSizing MAX-of-tracks 6->12, flowAdapter absorb 5->6.07 / 15->30).

Deployed t72597... (post feeder-router). Post-deploy t72597786 (~200t, still in
reset transition): LARGELY POSITIVE - H1 duty 0.57->0.83 and idleSink 0.43->0.16
(the deposit congestion the pile came from LARGELY CLEARED - feeder-router +
tanker right-size + replan), controller link re-fed 36.9 e/t (was 0.0 in the
dip), storage drew 64k->~reserve (surplus SPENT into work, self-limiting), sites
1->3 + extensions 36->37 (rebuild progressing toward all 4), NO FAIL/collapse.
Steady state (t72597918) exposed the REAL "builder budget is off": P8 FAIL -
sites 3->3, alloc 9 e/t, 0 built, a 2-WORK builder present but the crew IDLE;
the earmarked energy went to the controller (P7 2.37x) and storage sat at the
reserve (E4 -1315). Root cause read from code (ConstructionCorp.runTanker): the
construction tanker draws from STORAGE only while a spendable SURPLUS stands;
below that it refuels from its committed SOURCE - but a LINK-SERVED source feeds
its link (no container, no pile), so the tanker waited at the dry source forever
and the builder starved. The controller's surplus mop-up drains storage to the
reserve on its own, so this stalls ANY link-fed build the moment the warchest
isn't in surplus - a pre-existing bug the wartime acceleration merely EXPOSED
(by allocating 9 to a crew that can't be fueled). FIX: a STORAGE FALLBACK - when
the committed source is dry AND the bank holds energy, the tanker draws the
plan-allocated build fuel from the bank (where the mined income lands via the
links/feeder). Bounded by the crew's allocation + the finite remaining site
work, so it finishes the rebuild and stands down. Red-first (tankerFuel.test:
old code stalls at the dry source), unit 1554 green. NOTE "sized for all 4" is
gated on PLACING 4 sites (sites 1->3 climbing) + this fuel fix actually building
them; the crew sizes to whatever is placed (sum-of-projects).

VERIFIED t72598459 (post fuel-fix deploy): P8 FAIL -> [ok], building 0.20 e/t,
extensions 37->38 (rebuild moving), build fleet 4 WORK : 6 CARRY (was 2:34 -
fleet mismatch RESOLVED), atSink 0.28->0.04 + pile 10.6k->4.9k (congestion
cleared), no FAIL/collapse. OPEN: P8 rate still modest - the controller mop-up
(P7 9x) out-competes construction for the surplus; truly finishing the rebuild
ASAP needs the spec-33 controller RELEGATION (the full wartime mode), not just
the acceleration down-payment shipped here.

## Incident 2026-07-26 — core-link thrash (feeder ↔ link-served hauler), owner-observed

Owner named two live creeps "very clearly thrashing on the link":
`hauler-g-cd90-72595372` (the cd90 link-served source's CarryCorp hauler) and
`feeder-Feeder-72594973` (the controllerFeeder). Root cause read from code (not
yet a stamp — this one was legible from the source):
- `ControllerFeederCorp.runFeeder` (controller-link branch) only ever TRANSFERS
  INTO the core link; it has NO withdraw-link→storage path. The feeder is a
  half-router (loads, never empties).
- `sourcePickupSpot` redirects the cd90 hauler to withdraw FROM the same core
  link (link-served branch). So the hauler drains the link to storage while the
  feeder loads it from storage → energy circles storage↔core-link.
- Corroborating telemetry: `hubClampShare` 0.59 (core link full/clamped most of
  the time), `directShare` 3%, cd90 `srcLink` 800/800 (stranded) — the link is
  over-full and nothing actively drains it, so the hauler band-aids the missing
  feeder empty-direction and fights it.

Design + fix live in **spec 02** (feeder as the SOLE bidirectional core-link
router; no CarryCorp for a link-served route, EMERGENT from kind selection per
spec 17). Fix deferred there with a red-first thrash repro + grid scenario;
links have collapsed the colony before (spec 26), so it takes the full gate + a
post-deploy recapture. Verdict: **NAMED + ROOT-CAUSED with data**; fix pending.

## AUDIT 2026-07-27 (t72596661→t72596906) — pile fine-cause instrument CONTAMINATED; controller dip NAMED, recapture pending

Attacked the top ledger WARN (H1 deposit-throughput idle, pile 11.3k→11.7k
growing). Diagnosis: storage is ~939k free (E4: 4709 above the 56k reserve), so
the atSink idle CANNOT be sink saturation — it is spatial fan-in contention OR
haulers adjacent to storage but blocked on another sink. Deployed a per-corp
`idleSinkStorageRoom` counter (of the atSink idle, how much had storage room) to
name the fork.

RESULT — instrument read is CONTAMINATED, INCONCLUSIVE this cycle: the counter
is new, so it deserialized to 0 and only accumulated from the deploy tick, while
`atSink` + `dutyAlive` carry the full serialized 762–1456t window. Raw stamps:
atSink 0.29/0.32/0.40/0.69, storageRoom 0.08/0.08/0.13/0.02 — the ratio ≈ the
post-deploy window fraction (the artifact), not a real "storage full" reading.
A clean read needs ~1500t (window turnover). LESSON: a rolling-window counter
added mid-window can't be read until the window turns over — the split must be
computed over the SAME sub-window as its parent, or seeded, not zeroed. This is
the THIRD instrument layer on this pile — the over-instrument trap; STOP.

BLOCKER NAMED WITH DATA (the real find): controller progress rate DROPPED
16.5→16.7→3.3 e/t (t72596353→467→661→906) while storage banks +12.71/t and
LINK shows hub 25.0 / **ctrl 0.0 / direct 0%** — the controller link is FULL and
upgraders are not draining it, so income banks instead of upgrading (P7 0.72x
lower plan). The drop is in the window right after the instrument deploy (a
global RESET), and the feeder is behaving correctly (banks the income the full
controller can't take). LEADING hypothesis: reset-recovery + surplus-transition
(the fleet lagging the just-crossed 56k warchest), NOT a feeder-router
regression. NOT an emergency (energy banks, no FAIL, feederActive true) — no
reflexive rollback. FALSIFICATION: a settle-and-recapture ~300t out with NO
further deploys — controller recovers toward ~16 e/t ⇒ transient confirmed;
stays ~3 e/t ⇒ real upgrader-consumption regression (investigate the upgrader
fleet count/sizing and #141 multi-spawn assignment, NOT the feeder).

### FIXED + VERIFIED LIVE 2026-07-27 (deployed t72596353, recaptured t72596467)

Shipped the coupled fix (both faults, red-first, 15 new unit tests + grid cell
`link-core-router` `[P]`; full trio green; unit 1550): the feeder gained the
EMPTY direction (`runLinkRouter` drains core→storage above `coreLinkTargetLevel`),
the walking CarryCorp for a link-served source is EMERGENTLY suppressed
(`commissionsFromPlan` reads the planner's `haulPos` lens), the `sourcePickupSpot`
redirect is removed, and the sole-operator body carries a drain floor
(`coreDrainRate`, incl. spec-26 deposit headroom) so the core can't back up.
Post-deploy ledger clean, NO FAIL: **E2 = 0 stranded ("every fielded hauler
serves a planned route")** — the cd90 walking hauler is gone; **X5 = 0 churn**;
**LINK hub 20.4 / ctrl 18.4 e/t** delivering (not gridlocked); feeder draining
live (`storage-drain` receipt). The storage↔core-link circling is structurally
impossible now (no walking hauler on the core). Verdict: **FIXED, VERIFIED LIVE**.
(The SEPARATE core-convergence pile — H1 idleSink en-route, ground-piled ~8.8k —
persists and is the base-remodel / core-placement work, spec 31 §6a + spec 32;
not this thrash.)

### AUDIT 2026-07-27 (t72598913→t72599499) — wartime "surplus to building": plan-side relegation FALSIFIED, physical fleet relegation FIXED + VERIFIED

Two-part cycle on the owner's "surplus normally for upgrading, but now for
building" (spec 33). (1) The plan-side controller cap (`controllerRoutingCapacity`
relegating the controller sink in wartime) was deployed and **FALSIFIED as a
physical no-op** (t72598913): the controller still ran P7 9x (~18.8 e/t vs the
relegated plan ~2), P8 0 built, storage drained below reserve (E4 -4067). Cause:
the fleet sizes from ACTUAL controller-side stock, which the source→core→
controller LINK relay keeps full — capping the plan number moves no energy. (2)
The PHYSICAL fix — relegate the FLEET itself (`upgraderSizing` gains a `wartime`
flag off the shared `buildPoolBacklog >= WARTIME_BACKLOG_THRESHOLD` lens; the
fleet drops to `ANTI_DOWNGRADE_RESERVE`) — deployed and **VERIFIED LIVE**
(t72599499, dt 586): P7 18.8→9.8 e/t, P8 0→3.91 e/t (progress 110→2400, sites
1→6), E4 -4067→+5846 (drain stopped). Feared link-backpressure regression did
NOT occur: LINK hub 15.5/ctrl 7.8 (no jam), income P9 85.6 e/t 1.22x, X5 churn 0,
no FAIL lines. **Lever 1 (relay throttle) proven UNNECESSARY — the fleet shrink
alone redirected the surplus.** Redirect still ramping (12-WORK incumbent ages
out over ~1500t, targetCount 1 stops replacement). Verdict: **FALSIFIED (plan
half) + FIXED, VERIFIED LIVE (physical half)**; second check pending to confirm
P8 climbs to absorb as the upgrader drains.

### AUDIT 2026-07-27 (t72599499→t72599790) — 2nd check: relegation ramping healthy; P7 ledger made WARTIME-AWARE (false-FAIL killed)

Second check on the fleet relegation: still `wartime:true`/`allocated 2`/
`targetCount 1`, ramping cleanly — P7 controller 9.8→7.0 e/t (incumbents
draining), E4 slope +16.92→-0.78 (storage stopped banking - surplus now
consumed), P8 sites 6→5 (a build COMPLETED), income P9 85.6→93.5 e/t (UP), LINK
hub 17.9 ctrl 7.0 (no jam), X5 0. Healthy. BUT the ledger flagged P7 **FAIL
(0.47x)** - a MEASUREMENT leak, not an energy leak: it compared the draining
controller against the peacetime flow sink (15). A sharper finding than the
earlier falsification: the controller sink reads 15 = the save-regime
`STORAGE_UPGRADE_TARGET`, so the plan-side relegation to `max(15,2)=15` is a
no-op at the PLAN-NUMBER level too (not just physically). Left unfixed, P7 would
cry FAIL every cycle of the whole remodel campaign (spec 31), masking any real
regression. FIX (analysis-only, unit+build): P7 reads the upgrader's
`sizing.wartime`/`allocated` and measures against the RELEGATED floor in
wartime; a FAIL is now only a controller starved BELOW its inviolable floor with
stock standing (real downgrade risk). Red-first: 2 new wasteLedger tests (the
real t72599790/t72599499 pair + a synthetic starvation FAIL); the 2 peacetime P7
pins stay green (pre-wartime fixtures have no `wartime` stamp). Post-fix ledger
P7 `3.50x RELEGATED floor (wartime) [ok]`, no FAIL lines. Verdict: **FIXED
(measurement) + relegation ramp CONFIRMED healthy**. Still pending: the ~1
creep-gen check that P8 climbs to the crew's ~25 e/t absorb as the upgrader
fully drains (else the tanker haul under-sizes - the "build out-plans haulage"
watch).

### AUDIT 2026-07-29 (t72640141→t72643358) — d9c06c6 prod deploy + post-deploy verification: CLEAN, spend path restored

Deployed d9c06c6 (== origin/master, working tree clean; unit 1600 green, webpack
259K) to world branch "master" at t72640141; pre-deploy baseline committed
(shard1-t72640141.json). Pre-deploy ledger vs t72601836 (dt 38305): **FAIL E4**
idle capital 39245e above reserve (95245 vs 56000, slope +0.46/t, feederActive
true) and **FAIL P7** controller −70.1 e/t vs plan 40.7 (stock 1657→689 with
energy standing); WARN P4 0.94x, P2 7/13, E5 2/8, H1 duty 0.75 (at-sink
contention). Check 1 (+128t, t72640269): no new FAILs; census 27→20 + P7 0.08x
held as reset/ramp residuals (upgrader mid-spawn on the meter); X5/H1 skipped
(blackbox wiped by the global reset — expected). Check 2 (t72643358, dt 3089):
**no FAIL lines.** E4 FAIL→ok — storage 96017→70080, slope **−8.40/t**, draining
toward the 56000 reserve (spend path live again). P7 FAIL→WARN **0.63x** (36.8
vs 58.3 e/t lower endpoint), stock 795→1293, LINK ctrl receipt 5.9→38.4 e/t
(direct 32%). Census recovered 20→25 (24/25 tracked), X5 0.05 (home 0% —
predicted reset-churn inflation never materialized), SCAV cleared, P4 0.90x,
P2 7/13 unchanged. Verdict: **DEPLOY VERIFIED CLEAN; no work item this cycle.**
Pending watch: P7 convergence — 0.63x and climbing with stock rising; if it
stalls below plan at the next check (30m cadence) it becomes the work item
(candidate causes: P4 0.90x ceiling pressure, P2 micro-routes). E4 must land AT
target, not below (doctrine: warchest AT its target).

### AUDIT 2026-07-29 (t72643358→t72643961, dt 603) — 3rd check: P7 re-FAIL 0.25x read as upsize turnover (hypothesis, stamps healthy)

Short-window check (manual fire). **P7 FAIL 0.25x** (13.6 vs 53.7 e/t, stock
1293→631) and E4 slope flipped +11.17/t (76813, banking again) — but every
decision stamp is healthy: upgrader sizing `allocated 115.5` (banked-77k-driven,
2.2x the plan endpoint), `targetCount 3 / staffing 3 / demand staffed / hold
true`, workUtil 0.999, actual fleet 2 creeps / 49 WORK with the 3rd
upgrader@4350 AT THE SPAWN HEAD (util 0.98, queue 3, idle 2% all buy-latency);
feeder gate `staffed`, linkFed d1, wantedFeeders 1 = feeders 1; W43N23 is RCL7
(no rate cap), plan stable, E5 0/8, X5 0.04 (home 1%). HYPOTHESIS (one, from
stamps): generational upsize turnover — post-reset small upgraders aged out
while their 4350-cost replacements queue behind a saturated spawn; the 603t
window catches the trough (49 standing WORK ≠ window-average fielded WORK).
E4 re-banking is the same transient mirrored (burn dipped, income didn't).
NOT a gate/starvation signature (allocated >> plan, stock stood, cap 5300
bank full). Falsifier next capture (≥30m, thousands of ticks): 3-creep fleet
standing ⇒ P7 ≥1.0x lower endpoint and E4 slope negative toward 56000; if P7
still <1.0x with the fleet fielded, the hypothesis is DEAD and the work item
is delivery-side (link ctrl 35 e/t vs burn capacity ~87 WORK) or turnover
cadence — instrument, don't re-theorize. Verdict: **INSTRUMENT-READ, fix
deferred pending falsifier; clean-check counter reset (was 1).**

### AUDIT 2026-07-29 (t72643961→t72644411, dt 450) — falsifier: turnover hypothesis CONFIRMED, delivery-side bound REFUTED

Check 4, the designed falsifier for the 0.25x trough. **No FAIL lines.** P7
0.25x→**0.80x ok** (43.1 vs 53.7 e/t), stock 631→715 RISING while burning; E4
slope **−23.26/t** (66344, closing on the 56000 reserve). Mechanism read
confirmed with a nuance: fleet stands at 2 creeps / 41 WORK (the @4350 landed,
another small-gen upgrader expired) — staffing 2 of targetCount 3, demand
`demanded`, allocated 84.4, workUtil 1.00 over 277t. Delivery tracks STANDING
WORK at full utilization (41 WORK → 43.1 e/t), so the trough was fielded-WORK
during turnover, not throughput: the link/feeder delivery-side alternative is
REFUTED (stock rose under 43 e/t burn; link ctrl 36.2 + feeder headroom).
Residual 0.20x gap ≈ the missing 3rd body (spawn util 0.98, queue 3). Watches
carried: E4 must LAND at ~56k (slope must flatten, warchest AT target per
doctrine); SCAV 2/4 below margin (W42N23-37-6 384.23 vs 388.68 marginal,
W43N24-30-20 272.54 recurring); H1 0.64 duty / 5508e ground-piled at-sink
(standing geometry/deposit-spread class, pre-dates deploy: 0.75/4380e at
t72640141); P2 10/16 micro-routes (transient scavenge). Census 30/31. Verdict:
**FALSIFIED-ALTERNATIVE / CONFIRMED (turnover), clean check — counter 1 of 2
toward hourly steady-state.** Deploy d9c06c6 remains verified: both pre-deploy
FAILs (E4 spend path, P7 delivery) resolved to ok on falsifier-grade evidence.

### AUDIT 2026-07-29 (deploy 58e378b on d9c06c6) — miner pile gate shipped + E6 masking prosecutor

Owner directive: defer miner (and claimer) spawns while unhauled energy at the
source mouth ≥ ~2000. Shipped the MINER half as the sanctioned scarcity class
(spawn-side defund, strands nobody — the hostile-route/transit-embargo family
in minerSpawnDemand): `SOURCE_BUFFER_DEFER_THRESHOLD = 2000` (primitives, =
container cap per the sourceBuffers diagnostic; ~8.5k measured rotting above
it, t72588289), read through ONE lens `sourceBufferStock` shared with the
sourceBuffers telemetry (the controllerSideStock doctrine), vision-scoped
FAIL-OPEN (null ≠ 0), cold-start exempt, upsize held, haul vector UNGATED
(haulers are the release). Decision stamped (segment 4 v6: gate
buffer-full/clear + buffered/staffing/target). RESERVERS deliberately NOT
gated in v1: the reservation mechanism carries the two-incident revocation
history (t72444963/t72448082) and already defers via its bank gate — a pile
input there needs its own falsifier-backed cycle. Owner's masking concern
("bad if it covers up hauling problems") answered with ledger line **E6**:
chronic gating (both captures) WARNs naming the HAUL side as the work item
(drain term / route sizing / churn — the 2026-07-26 CarryCorp pickup stamps
distinguish), gated-with-staffing-0 (source DARK behind a full pile) FAILs;
the gate defers, the ledger prosecutes. Red-first: 8 gate tests + 5 E6 tests;
1613 unit green; trio green (flow-handoff 273s, runt-economy 242s,
storage-depot 8s). Deployed 58e378b. PREDICTIONS for the +15m check: reset
noise ~1 window (X5/H1 skip, census dip); segment-4 harvest stamps PRESENT,
gate "clear" with small buffered in steady state (deferrals rare while
hauling is healthy); no new FAILs post-ramp; E6 row appears once both
captures carry stamps. The gate's real test arrives with the next
invader-raid / hauler-churn event.

### AUDIT 2026-07-29 (addendum) — pile delay meter: the spawning delay time of a pile, measured

Owner follow-up: "instrument the spawning delay time for the energy piles."
`Memory.pileMeter` (upgradeMeter pattern; keyed by the source tail =
sourceBuffers key so the instruments join) tallied at the pile-gate decision
site with the gate's ACTUAL verdict: `heldFor` = consecutive ticks of the
current hold (`since` survives window rolls and evaluation gaps), `heldFrac`
= deferred share of evaluated ticks over a 1500t window; fog never tallies
(unmeasurable is neither held nor clear - must not reset `since` nor inflate
the window). Stamps (segment 4 v7) carry both. E6 upgraded from two-capture
chronicity to MEASURED duration: heldFor >= SOURCE_REGEN_TIME (300t, one
regen cycle) or heldFrac >= 0.5 WARNs from a single capture; heldFor >=
CREEP_LIFETIME (1500t - a full miner generation suppressed) FAILs; dark
sources unchanged FAIL; pre-meter stamps fall back to the chronic read.
Red-first: +6 meter/stamp tests, +3 E6 duration tests (1622 unit green).
Observability-only (the gate verdict expression is unchanged): unit+build
gate per protocol.

### AUDIT 2026-07-29 (t72644411→t72645498, dt 1087) — gate+meter verified live; E6 first contact finds two REAL piled routes

Verification for 58e378b/4ffc9a8. **No FAIL lines.** v7 stamps live on all 6
miner ops. **E6 first contact: cd8e buffered 3946, cee0 buffered 4346** (both
~2x threshold, staffing 1/1 - nothing dark, gate correctly deferring), the
exact two sources DEP flags with the biggest link-deposit savings (13/12
tiles). Attribution correct: haul deficit on the two longest remote routes.
Calibration nit found and fixed same cycle: heldFrac 1.0 off a 7-sample
post-reset window cried WARN on 7 ticks of evidence - the frac trigger now
requires heldFor >= 50 (two-captures->=50t doctrine applied to the meter;
red-first, 52 ledger tests green, 1624 unit). ALSO NOTABLE: E4 crossed BELOW
reserve (49530 vs 56000, slope -15.47/t) and the planner correctly flipped
upgrading to the save-regime floor (plan endpoint 15, P7 2.64x of it, P4
upgrader line 73->20p) - the bank governor working as designed; watch it
re-expand as the bank refills. QUEUED work item (falsifier next capture): if
cd8e/cee0 buffers HOLD and heldFor crosses 300t, the haul-side fix cycle
opens - candidates: the missing buffer-drain term in hauler sizing (the
2026-07-26 instrument's hypothesis) vs link-deposit routing (DEP's 40 e/t
lever); if they DRAIN, scavenge/haul absorbed it (SCAV already prices both
piles at 9318 net-e/part). Verdict: **VERIFIED + INSTRUMENTED; E6 doing
exactly what the owner asked - the gate defers, the ledger prosecutes,
nothing masked.**

### AUDIT 2026-07-29 (t72645498→t72651837, dt 6339) — E6 falsifier: gate→release loop VERIFIED end-to-end

Pre-registered question: do the cd8e/cee0 piles drain (loop works) or hold
with heldFor ≥300t (haul fix cycle opens)? ANSWER (a): **cd8e completed the
full cycle** — piled 3946 → gated → drained → released (absent from the gated
list); **cee0 draining under gate** 4346→2502 (−43%, −0.29/t net), chronic
tag correct, heldFor max 62t; **cedc boundary flap** at 2013 (+13 over cap,
held 2t, 44% frac) — the healthy full-container oscillation. No heldFor near
300t ⇒ per the pre-registered criterion NO fix cycle opens; the haul-side
candidates (drain term / link-deposit DEP lever) stay QUEUED backlog. The
delay meter did its job on first real use: chronic-vs-flap-vs-drain all
distinguishable from one line. ALSO: save-regime governor observed shedding
consumers — X5 worst line is the 4350e upgrader recycled @153t (the
relegation cutting the fleet, not churn-bug; home 5%); E4 still below
reserve (39019 vs 56000, slope −1.66/t) with upgrading at floor 15 and P7
1.81x of it — the bank is NOT yet refilling; WATCH next check: slope must
flip positive as the big upgraders age out, else the save-regime's shed lag
(or spawn spend 26 e/t) is the next work item. Verdict: **FALSIFIER
RESOLVED (a) — pile gate + delay meter + E6 shipped, verified, and
self-consistent; no open work item, E4 refill-slope is the standing watch.**

### AUDIT 2026-07-29 (t72651837→t72652682, dt 845) — governor refill CONFIRMED; P7 = re-expansion trough; E6 holds attributed to the W43N24 raid

**E4 watch RESOLVED**: slope −1.66 → **+24.53/t**, storage 39019→59749,
crossed back ABOVE the 56000 reserve — the save-regime governor's full cycle
(relegate → shed → refill) measured end-to-end. The plan is already
re-expanding (upgrader plan WORK 30p→97p), and **P7 FAIL 0.18x (2.8 vs 15
e/t, 3 WORK standing)** is that swing's turnover trough — same signature as
the verified t72643961 episode, this time governor-induced. PREDICTION: P7
recovers as the 97p fields. HYPOTHESIS (needs a second swing to confirm):
governor oscillation — the relegation recycled a 4350e upgrader @153t
(X5 last cycle) and the re-expansion now buys its replacement; if the
relegate↔re-expand period is ~10kt, the hysteresis band is churning a big
consumer per swing — the band (not the consumers) would be the work item.
**E6**: cd8e held 464t / cd8d held 696t — past the 300t criterion, but
attribution-before-blame: both are W43N24, the room X5 names for invader
churn this window (harvest-cd8d 1700e@105t). Raid → hostile-route embargo
(by design, spawns no haulers) → piles grew → gate correctly deferred.
RAID-GAP hypothesis; falsifier next capture: buffers DRAIN (haulers
refielded post-raid) ⇒ working as designed; buffers GROW with a clean X5
remote line ⇒ the haul-sizing/link-deposit fix cycle opens for real. **E2 50
"stranded" parts acquitted by its own stamp**: hauling-W42N23-37-6 is
`retiring:true`, duty 0.861, draining cedc's 2265 stock — the wind-down
working, expect E2→0 as it expires. Verdict: **watch-resolved (E4) +
two hypotheses pre-registered (P7 re-expansion, E6 raid-gap); no fix — every
open line has a falsifier queued.**

### AUDIT 2026-07-29 — governor damping (owner directive) + X5 phantom fix: implementation

Owner: "drain the bank slightly less aggressively, so upgraders are sized
more to the equilibrium... definitely avoid having to recycle upgraders."
Blackbox forensics first (t72651837 rows): the 4350e@153t X5 entry was
PHANTOM — two 4350e cohort spawns t72648883/t72649036 (153t ≈ one build
duration apart), both with natural-EOL successors (+1646t/+1493t); nothing
was recycled, ever — the recycle path (flagExcessForRecycling) is
dedicated-build-gated and never fired. The REAL swing: SURPLUS_DRAIN_TICKS
150 sized fleets to a draw that self-extinguishes in 1/10 of the lifetime it
buys — surplus peak → 2x4350e bodies at 100 e/t → fuel gone in ~200t →
standing fleet burns the bank BELOW reserve ~1200t (slope −1.66/t) → EOL at
floor → refill (+24.53/t) → repeat. FIX 1 (live-behavior):
SURPLUS_DRAIN_TICKS = CREEP_LIFETIME — the drain horizon covers the lifetime
of the bodies it sizes (bodies never outlive their fuel); a 21k surplus now
reads +14 e/t over equilibrium, mirroring sustainableConsumptionRate's
stock/CREEP_LIFETIME (one drain law at every stock). FIX 2 (ledger): X5
EOL-window successor exemption, EXCUSE-ONLY (max) — a slot with a
[0.9,1.15]x-life successor anywhere in the log did not churn; excuse-only
because a healthy staggered multi-slot corp has other-slot spawns slightly
earlier in the window (taking them verbatim manufactured 650e on the
t72587664 pin). Red-first: horizon invariant test (150→red), t72651837
phantom pin, real-death/EOL-cadence pins; 1627 unit green; recalibrated 2
symbolic pins (bank cap probes past MAX_SURPLUS_DRAW x horizon; anti-flap
asserts above-save-floor, intent unchanged). Gate: flow-handoff green;
runt-economy/storage-depot in flight — DEPLOY AFTER they pass. PREDICTIONS
for post-deploy: relay ≈ 15 + surplus/1500 (no 115 spikes), E4 glides to
~56k and HOLDS (no below-reserve dips beyond fleet-EOL lag), P7 steady near
plan with no trough windows, no 4350e purchase bursts, X5 quiet through
shrinks.

### ADDENDUM — damping gate + deploy record

runt-economy first run: 0 passing / 1 failing in 12m WITH EXIT CODE 0 (the
grid-verdict trap generalizes to plain mocha runs — markers, never exit
codes), rerun green in its normal 4m: host-load flake (concurrent
builds/captures in this container; the mockup meters real CPU — trap-list
class). Gate green on the tested bundle: 1627 unit + flow-handoff (4m) +
runt-economy (4m rerun) + storage-depot (7s). DEPLOYED b52bd23 (global
reset). Verification predictions stand as recorded above: relay = 15 +
surplus/1500 (no 115 spikes), E4 glide-and-hold at ~56k, P7 steady (no
trough windows), no 4350e purchase bursts, X5 quiet through shrinks.

### AUDIT 2026-07-29 (addendum) — E4 taught the damped equilibrium (owner correction, pre-empted a false red)

Owner, reading the damping through: "we would expect the surplus to maybe
rise, until it reaches an equilibrium. So we don't necessarily want to flag
that as a red or regression." Correct and load-bearing: with the draw at
`surplus/1500` the bank no longer settles AT the reserve - it settles where
draw == net inflow, `S* = reserve + 1500 x netInflow`. The OLD E4 rule
(`excess > threshold && slope >= 0 => FAIL`) would have called every tick of
that healthy climb a leak, and the armed post-deploy check would have read it
as a regression and rolled back a working change. Fixed both: (a) the armed
verification wakeup was rewritten with the equilibrium frame BEFORE it fired;
(b) E4 now projects `S* = excess + SURPLUS_DRAIN_TICKS x slope` and reads
RISING-toward-absorbable as ok, reserving FAIL for a projected equilibrium
past the draw knee (`MAX_SURPLUS_DRAW x T = 150k` - income the spend path
cannot absorb) or a big idle bank with the spend path down; flat/falling at a
big surplus keeps the watch-level WARN (not convergence evidence, never a
deploy-blocking red). Red-first: 5 E4 frame tests (climb-to-modest-S* ok,
runaway FAIL, spend-path-down FAIL, flat WARN, at-target ok); the 2026-07-18
601k-idle FAIL pin and the dynamic-warchest pin both still hold. 59 ledger /
1632 unit green. Analysis-only (ledger script + spec): unit+build gate.
LESSON: when a control law changes, its LEDGER LINE is part of the change -
a verdict calibrated to the old law manufactures false reds against the new
one (same class as the wartime P7 false-FAIL, 2026-07-27).

### AUDIT 2026-07-29 (t72652682→t72654979, dt 2297) — damping VERIFIED to the decimal; E6 opens the haul drain-term fix

**Damping deploy (b52bd23) verified, no FAIL lines.** The relay stamp reads
`relayRate 17.4447` = 15 + 3667/1500 EXACTLY - the damped law executing live
(was a 115-class draw at the same bank under the 150t horizon). **E4
converged and HELD**: storage 59667, slope **-0.04/t** (flat), projected
equilibrium 59613 vs reserve 56000 - the swing is gone, the bank sits just
above target instead of overshooting into relegation. No 4350e purchase
bursts (X5 0.07, worst a 1700e remote miner); E2 0 stranded (the retiring
hauler expired as predicted); P7 now reads the WARTIME frame (13.35x the
relegated floor, construction absorbing 12.0 e/t, P8 building 0.96 e/t) -
the surplus is funding STRUCTURES, doctrine-correct, and the upgrader sits
at its floor by design (so "sized to equilibrium" gets its real test in the
next peacetime window).

**E6's pre-registered criterion FIRED and the stamps named the mechanism.**
cd8d/cee0 drained and released (cd8d now `clear`, buffered 1650, heldFrac
0.14 - the gate->release loop working); **cd8e alone went CHRONIC**: buffered
2649→3874 GROWING, heldFor 512t at 100% of window, while its drain route
`hauling-W43N24-hauling-7-38` stamped `carryNeeded 1`, `creeps 0`,
`srcLinkEnergy null`. That is the 2026-07-26 instrument's own pre-registered
verdict - staged high, NO link, fleet under-sized - so the fix is the
missing BUFFER-DRAIN TERM, not the link network and not the miner. Shipped:
`haulCarryNeeded` now adds `staged/CREEP_LIFETIME` (the codebase's ONE drain
law - identical to sustainableConsumptionRate and to the bank's
SURPLUS_DRAIN_TICKS) on top of the sustained rate, amortized across routes
by carry share and priced at each route's real distance. Gentle (3874 adds
2.6 e/t ~ 4 CARRY, never a swarm), self-extinguishing as the pile drains,
FAILS OPEN on fog, and construction-only routes still yield to the tankers.
Red-first: 5 tests (drain math, gentleness, self-extinction, fog, builder
yield); 1637 unit green. Verdict: **damping FIXED+VERIFIED; E6 leak
DIAGNOSED from stamps and fixed - the owner's "don't let the gate mask
hauling problems" paid off exactly as designed.**

**Drain-term deploy record**: trio green by MARKER LINES (flow-handoff 4m,
runt-economy 4m, storage-depot 7s - all "1 passing"), 1637 unit, deployed on
top of b52bd23. PREDICTIONS for the +20m check: cd8e's drain route stamps
carryNeeded ~4-5 (was 1) and FIELDS a hauler; buffered 3874 falls; once
below 2000 the miner gate releases (E6 gated count 1 -> 0) and heldFor
resets to 0; P9 routed/funded holds ~1.4-1.6x (the term must not over-buy);
no new E5 runts and P4 stays under 1.0x ceiling (the term is gentle by
construction, but spawn parts are DRY at 0.89x - if P4 crosses 1.0 or E5
runts appear, the term is over-asking and gets a cap). E4 must stay
converged (~56-60k, flat) - the drain term spends INCOME, not the bank.

### DEV 2026-07-29 — batch placement: the multi-rung pass was a real regression (caught pre-deploy)

Owner ask: "place all of them, still build one at a time, size the builders
to all the sites." Two of the three parts ALREADY existed - siteWorkRemaining
sums every site into projectAbsorbRate (crew sizing), and nextBuildTarget
latches until a site completes (focus). The gap was PLACEMENT:
`canBuildMore = activeSites === 0` stalled the ladder until the board was
BUILT OUT, capping the crew against whichever single site was open.

First attempt widened the gate AND removed the ladder's early returns so one
pass placed every rung. The trio killed it: **storage-depot 7s -> 10m FAIL**
("expected a storage (or storage site) within 900 ticks of RCL4" - never
placed) and **runt-economy 12m FAIL** (upsize unproven; the test early-exits
on success, so RUNTIME IS THE VERDICT - 4m green, 12m+ means it burned all
its ticks). ONE cause: same-tick placements are invisible to lookFor (the
hazard the extension batch threads an exclusion set through), so multiple
rungs firing in one tick both collide on tiles AND, decisively, place
container sites that COUNT toward activeSites - in a no-storage room there is
then no surplus to reopen the gate, so the ladder locks itself out. That is
the builder-less stall the tower/road activeSites exclusion already exists to
prevent (spec 07 comment). The RCL2 board went 1 -> 3 standing sites,
tripling the construction sink against ~20 e/t and starving the miner upsize.
The bootstrap surplus guard could NOT save it: an empty board opens the gate
regardless of surplus, so the multi-rung pass fired anyway.

METHOD NOTE (worth more than the fix): the FIRST runt-economy red of the day
was a genuine host-load flake (unrelated damping change, green on rerun), and
that reading was carried into the SECOND red - where a plausible mechanism
for the pending change was already on the table. Runtime was the tell both
times and it was read as load, not as "the cell ran to exhaustion". Rule: on
an early-exit cell, a long run IS the failure signature; re-read the pending
diff for a mechanism BEFORE attributing to the environment.

SHIPPED (reduced): one rung per pass restored; the widened gate (surplus-only
when sites stand, empty board unchanged) lets the ladder advance every
PLACEMENT_COOLDOWN (10t) instead of waiting for builds, so a full set lands
in ~50-100t and the crew sizes against all of it; buildRank orders the wider
board (containers -> extensions -> storage/link -> tower -> other -> roads
last, latch absolute) so proximity cannot silently replace the ladder's
economics.

**Reduced-change deploy record**: trio green by MARKERS **and by runtime**
(storage-depot 7s - back from 10m, so the storage places immediately again;
runt-economy 4m - upsize proven early; flow-handoff 4m), 1650 unit.
DEPLOYED (global reset) on top of the drain term. Predictions for the next
check: home W43N23 has a surplus, so its ladder should now advance a rung per
PLACEMENT_COOLDOWN while sites stand - expect siteCount > 1 in the room
ledger when a build-out is open (was pinned at 0/1), P8 build delivery > 0
with construction absorbing, and the crew sized against the SUM (builder
bodyParts up vs the single-site cap). Guardrails: P4 must stay under 1.0x
ceiling and E5 runts at 0 (if the wider board out-competes producers, the
gate's surplus condition is too loose - tighten to a MINIMUM surplus, not
just > 0); E4 must not dive below reserve (widening spends the surplus, which
is intended, but it must not eat the warchest); bootstrap rooms (no storage)
must show UNCHANGED one-at-a-time behaviour - the guard's whole point.

### DEV 2026-07-29 — pile gate REPLACED by pile PRICING (owner-approved redesign)

The gate mechanism was interrogated per the trap-list rule (second patch on
one mechanism ⇒ the mechanism is the bug) and replaced. Doctrine it violated:
"scarcity acts at the SPAWN (defund: no NEW bodies, via priority), and the
planner prices — it doesn't gate." Suppressing the demand cost two measured
failures: (1) two live sources went DARK when their miners EOL'd behind full
piles (E6 FAIL t72658948, income stopped) — patched, then (2) the mechanism
itself was retired. NOW: SOURCE_BUFFER_PRIORITY_PENALTY (100) subtracts from
the demand's value and clears `blocking`; 100 exceeds the whole within-tier
spread (miner value 100..150) so a piled source ranks below EVERY clear
source's miner, while an idle spawn still re-staffs it. Tier separators
(income 1e6, blocking 1e4) untouched — documented as separators, not
tunables. Unstaffed/cold-start pay NO penalty. Delay meter + E6 unchanged
(owner: keep as-is); they now measure how long a pile has cost a source its
PRIORITY. Gate: 1654 unit + trio green (flow-handoff 4m, runt-economy 4m x2,
storage-depot 7s). DEPLOYED.

TWO CLAIMS THE DATA CORRECTED (epistemics, spec-14 rule "every claim must be
a read from data or it is a hypothesis, labeled as such"):
- "The pile gate caused the runt-economy flake" — UNVERIFIED. Reasoned from a
  code path (the gate preceded runtUpgradeDemand). The first working
  diagnostic showed `buffered: 0` in that world at t460, so the gate was not
  implicated there. De-pricing removes a POSSIBLE cause; the next red run's
  stamps will name the actual one.
- The first diagnostic printed "the corp never sized, look upstream of the
  demand" — FABRICATED. Corp.lastSizing is transient and never serialized, so
  Memory could never carry it; it lives in telemetry segment 4. A false cause
  aimed at an innocent subsystem is worse than no diagnostic.

RUNT-ECONOMY, still open (owner: "always causing us problems"):
- Its verdict rests on ONE 2→3 WORK transition, so unrelated changes flip it.
  Robustness needs the MECHANISM asserted (an upsize demand emitted) or a
  world staged so the transition is not marginal — a deliberate cell redesign.
- It EXITS 0 while reporting failures (measured: a trio chain `a && b && c`
  ran all three with b red). Same class as the documented grid exit-code trap;
  any gate reading exit codes ships on red. Verdicts must be read from marker
  lines until this is fixed.

### AUDIT 2026-07-29 (t72658948→t72660208, dt 1260) — pile PRICING verified; the binding constraint is SPAWN PARTS, and DEP is the named lever

**No FAIL lines.** PILE PRICING **VERIFIED**: E6 lists 4 deferred sources and
every one is **staffing 1/1** — not one DARK. The prior capture had two at
staffing 0/1 with "2 source(s) DARK behind a full pile - income stopped". The
redesign's whole claim (yield priority, never withhold the body) is confirmed
by measurement, and the E6 FAIL that exposed the original defect is retired.
DAMPING holds (E4 69011, slope −16.39/t toward the 56000 reserve; watch the
projection reading 44432 — the glide must not overshoot far BELOW reserve).
X5 **0** churn, E5 runts 0, E2 0 stranded, P1 flap 0, P9 1.57x.

**DRAIN TERM works but cannot be funded — the cycle's real finding.** It
raised the piled routes' demand exactly as designed (cedc route carryNeeded
**7**, cd8e route **3**, both previously 1), but 3 of 4 carry corps field
**zero** creeps: `partsLedger budget 0.164 / spent 0.168, dry: true`, P4
0.96x ceiling. More carry cannot be bought. So four mouths stay saturated
(cd90 3128, cd8e 3234, cd8d 2691, cedc 4702; heldFor 769/416/645/874t,
~13.7k standing) and E6's attribution ("the leak is HAULING") is right but
one level short: the leak is hauling, and hauling's blocker is SPAWN PARTS.

**NAMED LEVER (data, not hypothesis): DEP link-deposit routing.** The four
piled sources ARE the four DEP candidates: cd8e 36→23, cd8d 55→42, cedc
38→25, cee0 46→34 tiles. Their plan carry is 9.6/16.8/18.4/16.8 = ~61.6
parts at d=23..45; carry = rate*(2d+2)/50, so cutting ~13 tiles per route
takes the set to ~42 parts — **~20 carry parts (~40 body parts) returned to a
0.333 p/t ceiling that is currently oversubscribed**, plus DEP's own 40 e/t /
~510 tile*e/t. That relieves the DRY bind AND funds the drain the piles need:
one change, both ends. This is DEP's own pre-registered purpose ("sizes the
potential lever before the depositPos routing is re-activated").

DELIBERATELY NOT SHIPPED THIS CYCLE: four live-behavior changes went out
today and two carried defects (the batch-placement lockout, the pile-gate
dark sources). With P4 at 0.96x, a planner/routing change is exactly where a
misstep is most expensive, and it deserves a cycle of its own with a
falsifier, not a fifth deploy at the end of a long session. Verdict:
**pile pricing FIXED+VERIFIED; blocker NAMED with data (spawn parts) and its
lever sized (DEP).**

NEW WATCHES: tenders jumped 102p → **153p** (0.102 of the 0.333 ceiling, ~30%
of colony spawn capacity) — if that is a ratchet rather than extension growth
it is a leak class of its own. H1 duty 0.56 with 5755e ground-piled and
at-sink contention 0.37 (the standing deposit-geometry item). X3 1 untracked
creep persists across captures, and mining-W44N23-harvest-cbd5 claims 3 vs 2
counted — a real census/orphan drift worth its own red-first cycle.

### AUDIT 2026-07-29 (t72660208→t72663189, dt 2981) — tender load EXPLAINED (owner's RCL7 hypothesis confirmed); the 2nd SPAWN can never be built

**No FAIL lines.** Pile pricing still holding: E6 3 chronic piles (cd8e 3401,
cd8d 3201, cedc 3551) ALL at staffing 1/1 - no dark sources across three
captures now. P4 relaxed 0.96x -> 0.67x, X5 0.05, E5 0, E2 0.

**TENDER SPIKE: transient, not a ratchet — and the owner's mechanism is
right.** Tenders read 153p last capture, **102p** now, so the spike was a
rebuild wave. But the STRUCTURAL load is exactly the owner's read ("extensions
are now fatter at rcl7 but we still only have 1 spawn"), and the numbers are
exact: tender sizing reads `bankCapacity` = summed real capacity of every
spawn + extension = 300 + 50x100 = **5300**, matching the room's live
energyCapacity to the energy. At RCL6 that was 300 + 40x50 = 2300, so RCL7's
fatter extensions raised the bank wave **2.3x**. `forCoverage =
ceil(5300/(maxCarry 25 * 50)) = 5` tenders wanted, but `target = min(3, ...)`
caps it at 3. Fielded: 3 tenders, 75 carry / 27 move = 102 parts = **0.068
p/t, ~20% of the colony's whole 0.333 ceiling** - and still SHORT of a
one-wave refill (75 carry vs 106 needed). So the fleet is simultaneously
expensive and under-covering, by construction. `duty` reads **0.066** (a
transfer on 6.6% of alive ticks) - and NO ledger line watches tender duty
(H1 covers haulers, X1 covers upgrader WORK): an instrument gap on 20% of
spawn capacity.

**THE 2ND SPAWN IS UNREACHABLE.** RCL7 permits 2 spawns
(CONTROLLER_STRUCTURES); the colony has 1. `STRUCTURE_SPAWN` appears in
exactly ONE placement path in the whole codebase - `ExpansionCampaign`, which
plants a NEW colony's FIRST spawn. The construction ladder
(tryPlaceNextSite: source containers -> core depot -> ctrl container -> tower
-> extensions -> storage -> links -> roads) has **no spawn rung at all**, so
an owned room can never add its second spawn. Live cost: Spawn1 utilization
**0.936**, partsPerTick 0.312 of a 0.333 ceiling, **queueDepth 5**. A second
spawn DOUBLES the ceiling to 0.667 p/t - the exact constraint that blocked the
drain term's funded demand last cycle (partsLedger dry, 3 of 4 drain routes
with zero haulers, ~13.7k standing in piles) - while adding only +300 (+5.7%)
to bankCapacity, so it barely moves tender load. Note the tender code's own
comment already ASSUMES it: "at RCL7 the room has TWO spawns and 100-cap
extensions" - the sizing was written for a colony the builder cannot produce.

NOTE ON THE TWO CEILING READINGS (they differ and both matter): P4 0.67x is
the steady-state PLAN against capacity; spawn utilization 0.936 with a 5-deep
queue is the MEASURED throughput including ramps, upsizes and churn. The plan
fits one spawn; the transitions do not.

WORK ITEMS, ranked by measured value: (1) **spawn rung at RCL7+** - doubles
the binding physical ceiling, unblocks the pile drain, and the codebase
already assumes it exists (placement logic + ladder rung + tests; the
multi-spawn assignment/routing code already shipped in 970752f, so this is
the missing half); (2) DEP link-deposit on the four piled sources (~20 carry
parts returned, 40 e/t, sized last cycle); (3) a tender-duty ledger line -
20% of spawn capacity at 0.066 duty is unmeasured by any invariant.

### DEV 2026-07-29 — link throughput routing + tender rate-matching (both owner-modelled), DEPLOYED

Two independent subsystems, one deploy, SEPARABLE verification signals.

**LINK ROUTING (owner: "it fires towards the controller link, causing it to be
backed up because there's very little energy capacity there").** Engine ground
truth (@screeps/engine processor/intents/links/transfer.js): the amount is
CLAMPED to the target's free capacity, then `cooldown += LINK_COOLDOWN * range`
is charged IN FULL regardless. So the sending link's COOLDOWN is scarce and the
objective is `min(payload, free(t)) / range(t)`. v1 had NO payload field - it
fired direct whenever controllerFree >= LINK_FIRE_THRESHOLD (100), so a
controller link with 150 free captured a fire from a source holding 800: 150
delivered, whole cooldown spent, 650 stuck. Now throughput-ranked with
DIRECT_HOP_BONUS 1.15 (saves the core's SHARED cooldown + a second 3% loss;
conservative estimate, LINK ledger tax/relay is its calibration signal). Plan
cap, congestion spill, hold-rather-than-dribble all preserved. Corrected
mid-investigation: I suspected transferEnergy() with no amount returns ERR_FULL
and moves nothing (meter over-reporting) - the engine CLAMPS, so no bug and the
meter is accurate.

**TENDER RATE-MATCHING (owner: "based on the extension grid, but also limited
on the spawn capacity ... fatter extensions help with the refill because in a
single tick a single tender can transfer more energy").** v1 solved the wrong
problem: `bankCapacity/(maxCarry*50)` = "refill the whole network in one trip",
which grows with the bank and ignores the only consumer served. MEASURED cost
(t72663189): 3 tenders / 75 carry / **102 parts = ~20% of the colony's entire
0.333 p/t ceiling**, duty **0.066**, against a spawn measured consuming **27.6
e/t** (77750e / 69 spawns / 2817t at 0.936 utilization). New model:
`spawnConsumptionCeiling(n) = n * WORK/SPAWN_TIME_PER_PART` (33.3 e/t/spawn,
pinned above the measured burn); `tenderDeliveryRate` from the real cycle (one
transfer per tick, each capped by the target extension - so 100-cap RCL7
extensions HALVE the unload leg, ~35 -> ~53 e/t; v1 had this backwards);
`tenderFleetTarget = ceil(appetite/rate)`, floored by cluster coverage, capped
at 3. RCL7 one spawn -> **1 tender (was 3)**, carry 75 -> 25, ~102 -> ~34
parts, **~0.045 p/t (~13% of the ceiling) returned** - the exact margin that
went dry and blocked the hauler drain. A 2nd spawn doubles appetite and adds a
tender automatically.

Gate: 1677 unit; trio green TWICE (link build: 4m/4m/7s; tender build:
5m/4m/7s). Three existing tests re-pinned (they encoded the retired formula;
intent preserved) and a COLD-START FLOOR test added - the RCL2-3
lost-deadline incident still demands 3 tenders under the new math.

PREDICTIONS (separable, for the next check):
- LINK: controller receipt holds, source links stop sitting full, directShare
  free-floats instead of pinned by the 100e floor. If directShare collapses to
  ~0, DIRECT_HOP_BONUS is too low.
- P4 tender line: 102p -> ~34p, tender duty rises from 0.066.
- GUARDRAIL that would prove the tender model wrong: spawn meter `idle.bank`
  rising above 0 (spawn waiting on ENERGY, not demand). Currently 0, all idle
  is empty/buy. Also watch endFill (0.986 now) and S4.

KNOWN INCONSISTENCY (named, not hidden): tenderSlotCarry still sizes each body
from the bank wave while the count is rate-based. The maxCarry cap binds in the
live case so the saving lands, but the halves disagree in principle.

### AUDIT 2026-07-29 (t72663189→t72664142, dt 953) — BOTH owner-modelled changes VERIFIED

**TENDER RATE-MATCHING — prediction hit to the number.** Stamp: creeps **1**
(was 3), bodyParts **34** (was 102), body 25 carry / 9 move, target **1** (was
3), duty 0.066 -> **0.08**. P4's tender line **102p=0.068 -> 34p=0.023**, i.e.
**0.045 p/t returned to the 0.333 ceiling** - exactly the predicted ~34p.
**GUARDRAIL CLEAN**: spawn idle `{empty 0, bank 0, buy 20, hold 0}` - `bank`
stayed **0**, so the spawn is NOT waiting on energy; endFill 0.987 (was 0.986)
and utilization 0.975 with a 5300-energy network fed by ONE tender. The old
3-tender fleet was ~3x over-provisioned against a consumer measured at 27.6
e/t, and cutting it cost nothing in spawn feeding. Note `idle.empty` also went
54 -> 0: the spawn no longer idles for lack of demand.

**LINK THROUGHPUT ROUTING — verified, and the direction of every number is the
model's.** LINK: hub **33.5 -> 52.3**, ctrl **24.6 -> 31.6**, directShare 33%
-> **17%**, tax 1.74 -> 2.52 (/414t window). Total link throughput
**58.1 -> 83.9 e/t (+44%)**: the source links now empty fully into the core
instead of dribbling into a controller link that could not absorb a full
payload. The controller was NOT starved - its receipt ROSE, the core relay
carrying the difference. The tax rise is purely proportional (3% of 83.9 =
2.52; 3% of 58.1 = 1.74), so it is throughput, not new waste: +25.8 e/t moved
for +0.78 e/t of tax. directShare FALLING is the intended behaviour here (a
controller link that cannot take a whole volley should not capture the fire),
NOT the "collapsed to ~0" calibration failure the deploy note watched for -
DIRECT_HOP_BONUS 1.15 needs no change on this evidence. Window is short (414t,
post-reset); confirm across one more capture.

**Pile pricing still holding (4th consecutive capture)**: E6 2 deferrals, both
staffing 1/1, no dark sources. E4 83655 rising at +4.80/t with the ledger
correctly reading it as CONVERGING toward a finite equilibrium (90858, knee
150000) rather than flagging a red - the owner's E4 frame working as intended.
P1 flap 0, E2 0 stranded, S3/S4 clean.

NEW WATCH: **E5 runt purchases 2 of 8 (hauler@100 x2)** - 1-CARRY haulers.
Post-reset recovery or the drain term ordering tiny bodies onto micro-routes
(P2 8 of 14 routes below 3 CARRY). If runts persist next capture with P2 still
high, the drain term's carry share on a micro-route wants a floor, red-first.

### AUDIT 2026-07-29 (t72664142→t72665987, dt 1845) — THE PILES ARE GONE; E4 false FAIL fixed (analysis-only)

**E6: 0 of 7 deferrals - "source buffers under threshold".** The chronic piles
are DRAINED: cd8e 3263 -> under 2000, cedc 3046 -> under 2000, and nothing
else deferred. Those mouths had been saturated for many captures (heldFor up
to 978t). Attribution is the drain term (carry demand now includes
staged/CREEP_LIFETIME) plus the link routing change (+44% link throughput
moving source energy home instead of dribbling). P2 micro-routes also fell
8/14 -> 5/12 and E5 runts 2 -> **0** (so the two hauler@100 were reset noise,
as suspected, not a drain-term floor problem).

**Both new models still verified on the longer window.** LINK over 2259t: hub
47.6, ctrl 34.1, direct 18%, tax 2.45 - total 81.7 e/t vs the 83.9 short-window
read, so the +44% throughput is real and not a post-reset artifact.
DIRECT_HOP_BONUS 1.15 unchanged. TENDER: 1 creep / 34p holding, duty 0.066 ->
0.08 -> **0.159**, and the GUARDRAIL stayed clean - spawn `idle.bank` **0**
(idle is 80% no-demand / 20% latency), endFill 0.972. One tender feeds the
5300 network; the 3-tender fleet was ~3x over-provisioned, confirmed twice.

**E4 FAIL "SPEND PATH DOWN" was a FALSE red - fixed in the ledger.** The
predicate was `spendPathDown = room.feederActive === false`. Careful reading
FIRST rejected the tempting fix: links carry SOURCE energy, not banked energy,
so a busy link network does NOT mean the bank is being spent - E4's concern was
legitimate in principle. The actual defect is narrower: `feederActive false`
conflates a relay GATED OFF with one whose creep is between generations. At
t72665987 the feeder stamped `gate "demand", wantedFeeders 1, feeders 0` (it
had ordered a body and was waiting on the spawn) while P7 delivered 0.91x plan
(33.3 vs 36.6 e/t) and upgraders ran workUtil 0.999 with 36 WORK standing.
Fix reads the STAMP over the derived boolean (spec-14 rule): a relay that has
DEMANDED a body is in transition; one gated off ("no-storage"/"no-miner"/
"no-spawn") or absent entirely is still a FAIL. Red-first: 3 tests (the real
capture pair must not FAIL; a synthetic no-storage gate must; a missing feeder
corp must). 62 ledger / 1680 unit green. Analysis-only - no bot behaviour
touched, unit+build gate per protocol.

Verdict: **E6 leak ELIMINATED (measured, from chronic to zero), two models
re-verified on longer windows, one false-FAIL class retired.**

### DEV 2026-07-29 — SPAWN RUNG shipped (additional spawns as the RCL allows)

Owner-directed. STRUCTURE_SPAWN was placed nowhere but ExpansionCampaign (a NEW
colony's founding spawn), so an owned room could never add its second while
Spawn1 ran 0.87-0.97 utilization with a 4-6 deep queue against the 0.333 p/t
ceiling a second spawn DOUBLES. SPAWN_LIMITS mirrors CONTROLLER_STRUCTURES
(1 to RCL6, 2 at 7, 3 at 8); wantsAnotherSpawn counts PENDING sites so a slow
15k site is never re-placed each cooldown; unknown RCL falls back to 1.

PLACEMENT: findGridPosition's cohesion ranking, NOT spawnSiteValue - throughput
is position-independent (engine _charge-energy draws from ALL room extensions
nearest-first, no range limit, verified in node_modules), so position only moves
the tender refill walk (dominant: refillCircuit visits spawns; a distant spawn
can force a 2nd tender, +34p) and ~1% creep travel. NEW predicate neither
scorer had: >= 2 free adjacent tiles for newborn emergence (findGridPosition
packs extensions densely because extensions do not care); rejections stamp
`spawnTileRejected`. buildRank puts spawn at 0. Rung sits after extensions,
before storage/links. Declines to place when terrain is unreadable.

Gate: 1695 unit; storage-depot 8s GREEN (the construction canary that caught
the batch-placement lockout), flow-handoff 5m GREEN, runt-economy RED at 14m
then GREEN at 4m on rerun with healthy stamps (gate clear, buffered 0).
ATTRIBUTION for shipping on that red: the rung CANNOT execute in that world
(RCL2, SPAWN_LIMITS[2]=1, one spawn built => wantsAnotherSpawn false before any
terrain read), and this cell has now failed ~6 times today on builds that did
NOT contain the rung (damping, batch placement, pile-gate fix) - pre-change
evidence that the failure is not the pending change.

PROCESS FAILURE TO FIX (mine): the trio was invoked as
`npx mocha <cell> | grep -E "passing|failing"`, which DISCARDED the very
runt-economy diagnostic built earlier today to make a red name its own cause.
The failing run's stamps are unrecoverable. RULE: always capture integration
output to a file (`> log 2>&1`) and grep the FILE - never pipe the run itself
through grep. Verdicts still come from marker lines, never exit codes.

PREDICTIONS for the next check: a spawn SITE appears in W43N23 (siteCount > 0,
P8 > 0 as the crew builds a 15k project - expect it to dominate construction
for a while); once BUILT, P4 ceiling 0.333 -> 0.667, spawn utilization ~halves,
queueDepth falls, and tenderFleetTarget auto-rises to 2 (spawnConsumptionCeiling
scales with spawn count). GUARDRAIL: the 15k site must not starve producers -
watch P9 routed/funded, E5 runts, and E6 pile deferrals returning.

### AUDIT 2026-07-29 (t72667111→t72672921) — SECOND SPAWN BUILT; the doubling exposed a TENDER RUNT SPIRAL (owner-reported)

Owner: "there's a big builder, but he's going around repairing roads instead".
The crew-split stamp (segment 4 v8, deployed for exactly this) closed it.

**The spawn rung fully worked.** placeAttempt "spawn@W43N23:42,22" -> BUILT:
energyCapacity **5300 -> 5600** (exactly one spawn), **2 spawns** live at 0.747
/ 0.804 utilization, colony ceiling **0.333 -> 0.667 p/t**. The crew then
released correctly (crew 0, siteCount 0, wantsMaintenance false). The owner's
snapshot was real - the site sat at 0 progress for a stretch - but the build
did complete, and the report led to the defect one layer down.

**THE REAL FIND - a tender runt spiral the doubling exposed.** The tender
demand offered `minCost = min(carry,2) * 100` = **200** ("minCost 200 buys
instantly at this rank anyway"). Two spawns doubled demand, the network drained
(energyAvailable **25**), and the scheduler filled the tender AT THAT FLOOR: a
2-CARRY / **4-part** body moving 100 energy per trip against a 5600-energy
network. Result: **both spawns energy-starved 25% of the window** (idle.bank
**146 / 152**; S4 "idle 25% [bank 100%]"), storage ballooned to **250283**
(E4 FAIL: "equilibrium past the absorbable knee - income the spend path cannot
use"), P4 1.02x the NEW ceiling. And a drained network buys the NEXT tender as
a runt too - self-sustaining. Exactly the class the MINER runt floor prevents
("the whole economy collapses to one-useful-part creeps"); the tender simply
never had that protection.

FIX (same precedent): `tenderMinCarry` floors a purchase at HALF the desired
carry - a half-tender moves real energy, and scaling with the body means the
floor never outruns a poor room (a FIXED floor would). BOOTSTRAP keeps the
2-CARRY instant buy: a dark post with stranded stock (t72499165) must restart
instantly and a hard floor there would deadlock the outage it exists to fix.
Red-first 4 tests; 1699 unit; trio green with output CAPTURED TO FILES per
today's process rule (storage-depot 7s, flow-handoff 4m, runt-economy 3m - its
fastest of the session). DEPLOYED.

NOTE ON THE GUARDRAIL: `idle.bank > 0` was pre-registered as the signal that
would prove the tender RATE-MATCHING wrong. It fired - and pointed at the BODY
SIZE, not the fleet count. The rate model stands (1 tender for 1 spawn was
right); what was missing was a floor on how small a purchase may be. A
guardrail that localises the defect instead of just condemning the change.

PREDICTIONS for the next check: tender bodyParts 4 -> ~26 (13+ carry),
idle.bank -> 0 on BOTH spawns, tenderFleetTarget rising to 2 now appetite is
66.7 e/t, then E4's 250k backlog draining as the doubled capacity gets fed.
WATCH: P4 1.02x - the planner expanded upgraders to 441p to use the new
ceiling and overshot slightly; a 1.02x plan against a physical spawn limit just
converges to the ceiling, so it is a watch, not yet a work item.

### AUDIT 2026-07-29 (t72672921→t72673248) — runt floor VERIFIED INSUFFICIENT; carry-coverage is the real fix

Verification of the tender runt floor against its four pre-registered
predictions: **all four missed, and the misses were informative.**
Tender still **4 parts** (carry 3, move 1); `idle.bank` **196/243** (WORSE than
the 146/152 that triggered the fix); fleet target still **1**; storage still
climbing (250283 -> 259259).

WHY THE FLOOR WAS INSUFFICIENT: it prices a NEW purchase but cannot evict a
STANDING runt. The corp read `staffing 1 >= target 1` and stopped demanding, so
the 3-CARRY body holds its slot for its full ~1500-tick life while both spawns
starve. The fix addressed how cheaply a tender may be BOUGHT, not whether a
useless one keeps its seat.

THE `target: 1` I COULD NOT EXPLAIN LAST CYCLE IS CORRECT: the core depot sits
~1 tile from the extension cluster, so a full 25-CARRY tender delivers ~80 e/t
against a 66.7 e/t two-spawn appetite - ONE is genuinely enough. The rate model
was right; the fielded BODY was the defect. That was invisible because the
tender stamp exported no rate-match inputs - now fixed (spawnCount,
extensionCapacity, walkTicks, maxCarry, fieldedCarry, neededCarry). The blind
spot cost a full cycle.

FIX (in-tree precedent, not a new invention): CarryCorp already solved this
shape - "the count alone is not enough ... keep adding haulers until the CARRY
is actually covered". The tender now stops only when BOTH count and fielded
carry are satisfied, with the same 2x swarm cap. Against a 3-CARRY runt with 25
needed it orders a proper tender, and the runt floor shipped last cycle ensures
that one is bought at 13 carry rather than 2 - the two changes compose.

TEST-MOCK CORRECTION: four tender mocks used `body: {length: 8}` or omitted
`body` entirely - unfaithful to a real creep, whose body is a PART ARRAY. They
read as zero carry under the new rule. Fixed the MOCKS (real part arrays), not
the rule: an unfaithful stand-in is exactly what let a runt hide behind a count.

1699 unit green; trio in progress (storage-depot 7s green) - deploy gated on it.

**Carry-coverage deploy record**: trio green (storage-depot 7s, flow-handoff
4m, runt-economy 3m), 1699 unit, output captured to files. DEPLOYED 29f7834.
PREDICTIONS: the 3-CARRY runt no longer satisfies the corp (needed 25 vs
fielded 3), so a proper tender is ordered at the floor's 13-carry minimum;
expect tender creeps 1 -> 2 briefly then the runt EOLs out, bodyParts 4 -> ~26+,
and **idle.bank -> 0 on BOTH spawns** (THE measure - it is what fired and what
has arbitrated every step of this chain). Then E4's 259k backlog should finally
drain as the doubled spawn capacity actually gets fed. The new stamp fields
(spawnCount/extensionCapacity/walkTicks/maxCarry/fieldedCarry/neededCarry) make
the next verdict readable without a code read - that blind spot cost a cycle.
IF idle.bank persists with a full-size tender fielded: the fleet COUNT model is
wrong after all (not the body), and the next lever is the walkTicks input -
verify it against the real depot->cluster geometry rather than trusting the
1-tile read.

### AUDIT 2026-07-29 (t72673248→t72673974) — starvation ~90% cleared; the residual is the BOOTSTRAP escape firing every generation

**THE MEASURE MOVED**: spawn `idle.bank` **196/243 -> 8/52** (~90% down; it was
146/152 when first caught). Spawn1 is effectively clear. The runt-floor +
carry-coverage chain did what it was built to do, and the tender went
**4 parts (3 carry) -> 10 parts (8 carry)**.

**The new stamp fields paid for themselves immediately.** `walkTicks: 1`
CONFIRMS target 1 is correct (a 1-tile depot walk makes one full 25-carry
tender deliver ~80 e/t against a 66.7 appetite - the count model was never
wrong); `maxCarry 25`, `spawnCount 2`, `extensionCapacity 100`, `fieldedCarry
8`, `neededCarry 25`. Without these the next hypothesis would have been the
fleet count, which the data now rules out.

**RESIDUAL, named with data (not yet fixed)**: the body is 8 carry, not the
floor's 13. Cause: `tenderBootstrapPierce` returns true whenever `staffing ===
0`, and with a ONE-tender fleet that is true at EVERY natural generation
change - so each replacement is priced at the 2-carry emergency floor and
built from whatever energy is on hand. The emergency escape, meant for a
genuine dark-post outage (t72499165), has become the routine path. The
carry-coverage rule still reads fieldedCarry 8 < neededCarry 25 and keeps
demanding, so the fleet self-corrects toward ~21 carry across 2 bodies (the
2x swarm cap) - converging, but by adding a second creep rather than buying
one proper one. NOTE the gate LABEL still prints "staffed" from the old
count-only test while the demand path correctly continues; the label is now
misleading and wants aligning.

**NEW FAIL - P8 "CREW IDLE (energy allocated, nothing built)"**: remote sites
15->15, progress 0->0, plan allocating **20 e/t** to construction. This is the
same class the owner reported ("a big builder... repairing roads instead"),
now inverted: 15 remote trunk sites standing and no progress at all. It is the
clear next work item.

**E4 FAIL 282450 (+31.94/t, projected 330k past the 150k knee)**: with spawn
throughput doubled, income now outruns what the spend path absorbs. P8's idle
crew is part of that (20 e/t allocated, 0 spent). E4's cause is downstream of
P8, so P8 is the lever.

DELIBERATELY NOT SHIPPED THIS CYCLE: a fourth change to the tender chain. The
primary measure is converging and the trap list is explicit about repeated
patches to one mechanism - the bootstrap-escape residual is recorded for a
cycle that can gate it properly (make the pierce distinguish a genuine outage
from a routine generation change, red-first, full trio).

### AUDIT 2026-07-30 (t72675033→t72675270) — P8 root-caused: the plan priced a fetch the runtime never performs

**CYCLE VERDICT: instrumented, then FIXED at the mechanism** (one falsified
hypothesis, one stamp, one read, one fix — no second guess).

**Shipped first (t72675270 deploy)**: the last-builder rule
(`repairDetailRecruit`) + smallest-body detail pick (`pickRepairDetail`) +
the pool/crew stamp (segment 4 **v10**). P8 was explicitly NOT claimed fixed
by that commit — by then the crew had already grown to 2, so conscription was
not the live cause. That prediction held: P8 stayed FAIL after the deploy.

**The stamp closed it in ONE capture** (t72675271):

    building-W43N23-construction creeps 2 parts 132
      poolHead "W41N23" poolHeadBlind 0 poolRooms 1 poolWork "W41N23:4251"
      crew 2 onRepairDetail 1 latchedToSite 0 buildTargets "FR"
      crewAt "W41N23,W43N23" crewHome 1 buildRoom "W41N23"
      tankers 0 vectorFed false

**HYPOTHESIS FALSIFIED BY THE STAMP**: the blind-receipt-head oscillation
(pool ranks home first then by linear distance, so a distance-1 blind room
would outrank the distance-2 room holding the real sites). `poolHeadBlind 0`,
`poolRooms 1` — the pool was one VISIBLE room. Recorded because the reasoning
was sound and the data still killed it; the stamp existed precisely so this
cost one capture instead of a patch.

**THE ACTUAL CAUSE — a plan-vs-execution contradiction.** The builder stands
IN W41N23 (`crewAt`), beside 4251 energy of work, in state **F** (fetching:
`memory.working` false, no target). It never eats, because:

1. `buildFuelDistance` prices a cross-room leg at `roomLinearDistance * 50`
   = **100** tiles.
2. `supplyMethod(rate, 100)` returns **"direct"** — measured, at every
   plausible rate: rate 20 → direct 241.5 parts vs vector 250.4, a **3.6%**
   margin. The two part-curves RECROSS at long range (directFetchParts grows
   linearly, vectorSupplyParts carries a fixed overhead), so the verdict flips
   back to self-fetch precisely where a parked builder is least able to fetch.
3. "direct" ⇒ `tankerPlan` returns target 0 ⇒ **no supply vector**.
4. `doPickup` scavenges range **4** and never travels ("Haulers are
   responsible for delivering energy to builders").
5. `memory.working` flips only on a **100% fill**; `doBuild` is the ONLY
   setter of `buildTargetId`, and it runs only when working.

So the plan elected a 100-tile self-fetch against a 4-tile scan, and the crew
starved beside its own sites. 15 sites, 20 e/t allocated, **0 built**. The
same bad verdict ALSO shrank the builder's buffer (builderPlan reads
`supply.method === "vector"` for the refuel interval): one wrong lens, two
wrong outputs.

**THE FIX IS AT THE MECHANISM, not the symptom** (trap list: question the
mechanism). `DIRECT_DRAW_REACH` (primitives) is now an EXECUTION capability —
how far a parked consumer reaches without abandoning its post — and
`supplyMethod` is bounded by it: beyond the reach the vector is not the
cheaper option, it is the ONLY implementable one, whatever the parts say.
`doPickup`'s literal 4 now READS that constant, so the two cannot drift again.
Blast radius is small and measured: at d = 4/10/20/50 the parts comparison
already said "vector", so the bound removes only the pathological long-range
"direct".

**PREDICTED DELTAS (recorded BEFORE the deploy)**:
  - `tankers` 0 → ≥2 (tankerPlan floors at 2 for the hot swap)
  - `vectorFed` false → true
  - `buildTargets` "FR" → "BR" (builder latches once fed)
  - P8: progress 0 → >0, remote sites 15 → falling
  - E4 slope falls as construction actually spends its 20 e/t
  - P4 rises (the vector is new spawn load) — headroom exists at 0.75x ceiling

**WATCH FOR**: builders becoming CARRY-heavier (the vector verdict raises the
buffer via refuelIntervalTicks), and tanker spawn cost competing with the
miner/hauler queue that is already 8 deep at 0.97 utilization.

### INCIDENT 2026-07-30 — the tower's 500/500 dead point (owner-reported)

Owner: *"Also the tower should repair the nearby roads anyways as well."* It
already had the code to — `runTowers` has repaired roads/containers within
TOWER_REPAIR_RANGE (10) since 2026-07-19 — but two independently-chosen
constants made it stop after one burst:

  - `runTowers` repairs only while `energy > TOWER_REPAIR_RESERVE` = **500**
  - `towerNeedsFill` refilled only while `energy < capacity * 0.5` = **500**
    (TOWER_CAPACITY is 1000)

A repair action costs exactly TOWER_ENERGY_COST (10), so a refilled tower
walks 1000 → 990 → … → **exactly 500**, and there it can neither repair (500
is not > 500) nor be refilled (500 is not < 500). Not a probabilistic stall —
the arithmetic lands on the dead point every time. The only thing that ever
unstuck it was a **raid**: firing also spends 10/shot, pushing it below 500
and triggering the tender. That is why tower repair looked intermittent while
roads decayed down to the builder fleet — and why the owner saw a big builder
doing road maintenance the tower should have absorbed.

**FIXED AT THE COUPLING, not either number.** `TOWER_DEFENSE_RESERVE` and
`TOWER_REPAIR_BAND` now live in primitives, and `towerRefillBelow(capacity) =
min(capacity, reserve + band)` — so the refill trigger is *derived from* the
repair floor and is strictly above it. Draining to the floor now always calls
a tender, and the dead point is unrepresentable rather than merely absent.
`TOWER_REPAIR_RESERVE` re-exports the shared constant so the two cannot be
edited apart. Regression test pins the invariant
(`towerRefillBelow(cap) > TOWER_REPAIR_RESERVE`), not just the current values.

Cadence after the fix: repair spends the 500-energy band (≈24,000 hits at
close range, several roads restored from scratch), the tender tops it up below
800, and the defensive 500 is never touched by maintenance.

NOT CHANGED (checked, out of scope): TOWER_REPAIR_RANGE stays 10 — past it the
energy falloff makes tower repair ~5x worse than a builder. Multi-tower
duplicate targeting is moot today: `findMissingTower` builds exactly ONE tower
per room, so no second tower can overheal the first's target.

### AUDIT 2026-07-30 (t72675270→t72676091, dt 821) — P8 FIXED, measured

**CYCLE VERDICT: FIXED.** The supplyMethod REACH BOUND (commit 6045353) did
what it was predicted to do. Every pre-registered delta, checked:

| prediction | result |
|---|---|
| `tankers` 0 → ≥2 | **3** ✅ |
| `vectorFed` false → true | **true** ✅ |
| P8 progress 0 → >0 | **0.37 e/t**, FAIL → ok ✅ |
| poolWork falling | 4251 → **3826** (425 energy built) ✅ |
| P4 rises (new vector load) | 0.75 → **0.95 x ceiling** ✅ (now WARN) |
| E4 slope falls | ❌ **20.24 → 34.12/t** — did NOT fall |
| `buildTargets` "FR" → "BR" | ⚠️ reads "RF" — see stamp defect below |

P7 also recovered on its own: 0.40× → **1× the relegated floor**, FAIL → ok.

**STAMP DEFECT (mine, not the bot's)**: `buildTargets` encodes F/W from
`memory.working`, but the vectorFed path never sets `working` — it builds
directly whenever `store.energy > 0`. So a builder that is correctly PARKED
and awaiting its tanker stamps "F", which reads as "stuck fetching". The
F/W distinction is only meaningful on the non-vector path. To fix next cycle:
encode the vector path separately (parked-dry vs parked-fed) rather than
reusing a flag that path doesn't maintain.

**E4 IS NOW THE UNAMBIGUOUS TOP LINE — and the stamps name its mechanism.**
Storage 341743, slope +34.12/t, projected equilibrium 392928 against a 150k
absorbable knee. NOT attributable to this change: construction went from
spending 0 to spending 0.37 e/t, which lowers banking; the slope rose anyway.
The cause is on the CONTROLLER path:

    upgrading-W43N23-upgrading  creeps 1  parts 4
      planAllocated 180  stock 701  banked 341743  inflow 2  allocated 2
      targetCount 1  wartime true  workUtil 0.999
    moving-W43N23-controllerFeeder  creeps 1  parts 12
      gate "staffed"  relayRate 115  bodyRate 115  standingWork 2
      planFlow 180  surplusRate 115  linkFed true  coreDrain 80

The plan wants **180 e/t** to the controller. The upgrader is a **4-part, 2-WORK**
body consuming **2 e/t** — and at UPGRADE_ENERGY_PER_WORK (1) that 2 WORK is a
hard 2 e/t ceiling no matter what arrives. The feeder is rated 115 e/t and
sized to `standingWork: 2`. So the upgrader sizes from `inflow: 2`, and the
feeder sizes from the upgrader's standing WORK of 2 — **each sized from the
other's current value, with nothing to break the circle**. `workUtil 0.999`
confirms the 2 WORK it has is fully busy: this is not idle capacity, it is
absent capacity. 341k banked behind a 2 e/t straw.

Next cycle's work item, with the red-first shape already implied: something
must size the controller path from the BANK (the surplus is the input the
doctrine says consumers burn), not from a measured inflow that only exists
because the consumer is small.

**PROCESS NOTE — runt-economy flake, attributed properly.** The tower fix's
first trio run went red on runt-economy (smallest 2, largest 2, no upsize at
tick 1200). Attribution before blame: the pre-change source (bundle a5ea1ec,
bit-identical md5 to the earlier green control) PASSED, which alone looks
like a regression — so the post-change bundle was re-run and also PASSED
(upsize PROVEN at tick 460, same as control). Flake, not regression, and
independently ruled out by mechanism: the only behavioral delta in the commit
is `towerNeedsFill`'s threshold, whose sole call site iterates `FIND_MY_STRUCTURES`
towers — and the runt world is staged at **RCL 2** while TOWER_MIN_RCL is **3**,
so no tower can exist there. N=1 vs N=1 cannot separate flake from regression
on a cell the repo already documents as flaky; the second sample is what made
the call honest.

### AUDIT 2026-07-30 (t72676091→t72676360, dt 269) — P8 INCONCLUSIVE (window too short); new blocker named with data

**CYCLE VERDICT: blocker named.** No fix shipped, deliberately — see below.

**P8 reads FAIL (0 e/t) but this window CANNOT support that verdict.** Two
sampling faults, both mine:
  - dt is **269 ticks**, and the supply vector's round trip is home storage
    (W43N23) → the sites (W41N23) → back: **~100 tiles each way** for a 3:1
    carry:move body. One delivery cycle is plausibly longer than the whole
    window, so "0 built" is consistent with a working-but-slow vector.
  - the tower deploy's **global reset** falls inside the window.
`poolWork` is identical to the digit across both captures (**3826**), which is
what a sub-round-trip sample looks like. The previous, 821-tick window measured
0.37 e/t. **Not recorded as a regression**; the next read must span ≥1 full
round trip.

**THE REAL FINDING — the build crew is starving beside 4,263 energy.**

    building-W43N23-construction  crewAt "W41N23,W43N23"  buildRoom "W41N23"
      buildTargets "RF"  tankers 4  vectorFed true  poolWork "W41N23:3826"
    sourceBuffers: dbd01f = 4263   (source d01f IS in W41N23 — agenda entry
                                    "mining-W41N23-harvest-d01f")
    E6: 3-harvest-d01f buffered 4263, held 1014t (100% of window) CHRONIC

The pool builder stands in W41N23, dry, next to its road sites — while **4,263
energy sits piled at a source mouth in that same room**, chronic for the entire
window. Meanwhile four tankers shuttle energy to it from home storage, two
rooms away.

Cause, in `buildFuelPos`:

    const surplusBanked = bank?.my && spendableBankSurplus(...) > 0;
    return (surplusBanked ? bank!.pos : site.pos.findClosestByRange(FIND_SOURCES)?.pos) ?? null;

The home bank holds 351k, so `surplusBanked` is ALWAYS true and fuel is ALWAYS
the home storage — **regardless of how far the site is from it**. The `else`
branch (nearest source *to the site*) is exactly the right answer here and is
never taken. This is the same CLASS as the P8 bug just fixed: a fuel lens whose
verdict the geometry makes absurd. It also explains the reach-bound
interaction — distance 100 forces "vector", so the colony buys 4 tankers to
run a 100-tile shuttle past a 4,263-energy pile.

**NEXT WORK ITEM (red-first shape):** `buildFuelPos` must choose fuel by
DISTANCE-ADJUSTED availability, not by "is the bank in surplus". A same-room
pile/container adequate to the burn beats a cross-room bank shuttle; the bank
wins when it is genuinely the nearest adequate fuel. Blast radius is wide —
the lens feeds `buildFuelDistance` → `supplyMethod` → `tankerPlan` AND
`builderPlan`'s buffer — so it needs the full trio, and E6's chronic piles are
a second beneficiary (the builder eating d01f's pile drains it).

**E4 unchanged in mechanism** (351575, +36.55/t): still the 2-WORK upgrader
circle documented in the previous entry. Note the two are linked — energy that
cannot reach the controller AND cannot reach the build site is exactly the
capital E4 measures.

**NOT SHIPPED THIS CYCLE, on purpose.** Three changes already went to prod
today (last-builder rule, reach bound, tower deadlock). The trap list is
explicit that stacking a fourth change into the same subsystem before the
previous ones have a clean measurement window is how attribution is lost — the
P8 window above is already too short to read. This finding is recorded with
its evidence so the next cycle starts from data, not memory.

### DEPLOY RECORD 2026-07-30 — spawn planning headroom (SPAWN_PLAN_FRACTION 0.9)

Owner directive: *"90% of theoretical spawn capacity is available for
planning. So everything is like before, we're just planning on an economy
that's 10% smaller in terms of bodies."*

Implemented as ONE lens: `plannableSpawnParts(spawnCount)` in primitives
(0.9 × physical), consumed by BOTH plan-side capacity reads — the mining
tranche (`miningBudgetPerSpawn` now composes 0.6 × plannable) and the sink
fill (`partsBudget` in planColony). `partsLedger` gains `plannable` (flow
segment v12); `capacity` stays the PHYSICAL rate so P4's audit target is
unchanged. The reserved 10% is execution slack for what provably spends parts
outside the plan: EOL replacement overlap (deliveryLeadTime), invader-churn
rebuilds (X5 measured 18% of remote spend), runt upsizes, orphan rescue.

Golden master: the snapshot diff is EXACTLY the margin — every `partsLeft`
down 0.0333, commissions/fleets identical across all three worlds. Two
margin-tight staged worlds re-staged (infra −0.0333, leftover budgets
unchanged); the organism scenario's "all four directions" pin re-pinned to
its true contract (founding-independence: funded set identical with/without
the founding; drops must read "over-budget", never "unrouted") after
measuring that the marginal drop (srcW, tie with srcS at net 7.6, broken by
id) happens at the MINING stage in both plans.

**PREDICTED DELTAS (registered before deploy; verify at ≥1 generation):**
1. Segment 6 partsLedger shows `plannable 0.600`; budget ~0.067 lower.
2. P4 plan-implied 0.636 → ~0.57 p/t (0.95× → ~0.85× physical); leaves WARN.
3. Spawn utilization 0.97 → ~0.90 over a generation; queueDepth 8 → ≤5.
4. NO P1 flap: the mining tranche (0.36 plannable at 2 spawns) has slack over
   its 0.212 use, so no source funding flips — if one does, that read is
   falsified and the cycle investigates.
5. Accepted side effects: E4 may tick up (fewer consumer bodies — its
   mechanism is the upgrader circle, unchanged); S4 idle may rise (slack is
   the point, not a leak).

**GATE OUTCOME + DEPLOY (appended after the record above was registered):**
unit 1726 green; storage-depot green; flow-handoff green; runt-economy
1-of-3 on this bundle (d02c350). The two reds were ACQUITTED, not waved off:
(a) the failure signature is byte-identical to a failure measured on the
PRE-change bundle the same day (source 1 piled at exactly 1901, source 2
unstaffed with demand standing, ended 1200) - identical-failure-pre/post per
the attribution rule; (b) mechanical inertness in that world was proven
TWICE - an approximate solve of the runt shape (both sources funded, spent
0.026 vs budget 0.289, dry false at every plausible infra; greedy fills are
monotone, so a slack 0.9x budget funds the identical set as 1.0x) and then
the mockup's OWN segment-6 ledger from the passing forensic run (plannable
0.3, budget 0.289, spent 0.0237, dry false, both funded); (c) no runtime
consumer reads the changed fields (partsLeft flows planner->telemetry only).
The bimodal stuck mode (pile 1901 / second miner never fielded) is now its
own filed item with forensics attached (runt-economy prints agenda + ledger
+ verdicts on failure, commit e4a21f4) - spec 37 measurement traps updated
in spirit; it demonstrably PREDATES the headroom. Deployed ~t72677900.

### AUDIT 2026-07-30 (t72678902→t72679468, dt 566) — the knot untied: E4 FALLING, score 17 pts/t, ZERO ledger FAILs

**CYCLE VERDICT: verified + instrument fixed.** First zero-FAIL ledger of the
session ("no FAIL lines - attack the largest WARN or ship the backlog").

**HEADROOM VERIFICATION, final scorecard (predictions from the deploy record):**
| # | prediction | verdict |
|---|---|---|
| 1 | plannable 0.600 in segment 6 | ✅ (early read) |
| 2 | P4 0.95×→~0.85×, WARN clears | ✅ overshot to 0.52×; decomposed — the extra fall was the controller plan WORK collapse (E4 circle plan-side), NOT the margin (`dry:false`, 0.145 p/t unspent) |
| 3 | utilization 0.97→~0.90, queue 8→≤5 | ❌ NOT MET at this read (0.98 / 8) — but confounded by the wartime-exit re-fleet (upgraders 4→100 parts bought this window). S4's character flipped: idle was 52-68% bank-starved, now 95% buy-latency / 5% bank. Deferred to a post-transition read, NOT claimed |
| 4 | no P1 flap | ✅ 0 flips across both reads |
| 5 | E4/S4 may tick up (accepted) | E4 went the RIGHT way instead (below) |

**THE HEADLINE — the E4/P7/upgrader knot untied itself, chain fully stamped:**
reach-bound fix → sites built (P8 0.37→0.71 e/t) → remote backlog 15→9 →
wartime posture exited (P7 line lost its "RELEGATED (wartime)" framing) →
upgrader sized from ACTUAL inflow per doctrine (`inflow:110, allocated:110,
targetCount:3`, corp 4→100 parts, workUtil 0.985) → feeder resized to
`standingWork:78` → link net delivering 55.8 e/t at the controller receipt →
**controller eating 58.9 e/t (P7 29× its floor)** → **E4 slope +36.55 →
−49.27/t** (storage 351k→333k, falling for the first time all session) →
**rclProgress +53,070 over ~3,100t ≈ 17.1 pts/t, up from the 1.35-2.0 floor**.
The owner's scoreboard number moved by an order of magnitude.

**P5 reserver FAIL (early read) was TRANSIENT**: duty 1.0 with the W42N22
reservation bank at 96 (drained during the reserver's absence; gate "staffed"
rebuilding it). ok at this read. The two-capture rule earned its keep — no
patch was written against a self-resolving state.

**P8 FALSE-FAIL fixed at the INSTRUMENT**: remote count 9→9 + flat receipts
read "CREW IDLE" while the corp's poolWork stamp fell 3826→2252 (1,574e built
into partially-complete sites, crew "BBR"). The ledger now credits the
poolWork DELTA as a conservative floor (placements RAISE poolWork, so a fall
only undercounts — same direction as the receipts floor); red-first tests pin
credit/flat-stall/rising-pool cases. This window's true rate: 0.23 e/t against
20 allocated — real but slow; the gap is spec 37's fuel-lens work (piles
rebuilding around the crew per E6: 5 of 10 deferred, d01f 5009 CHRONIC).

**Deployed post-verification**: segment 4 v11 (buildTargets V/D letters,
bundle 921aea5) — telemetry-only, held out of the verification window so its
reset could not muddy the measurements above.

**OPEN (largest WARNs)**: E4 262k (falling at −49/t; projected equilibrium
259k still above the 150k knee — watch, don't patch while the drain runs) and
E6 (5 of 10 piled — the hauler drain-term thread; spec 37's local-fuel work
eats d01f's pile directly). Utilization/queue re-read post-transition.

### AUDIT 2026-07-30 (t72679646→t72681617, dt 1971) — score 67.6 pts/t, E4 below the knee; headroom prediction #3 FALSIFIED with its mechanism

**CYCLE VERDICT: verified + one prediction falsified honestly.** Second
consecutive zero-FAIL ledger.

**THE SCOREBOARD** (the thing this loop exists for):

| | this morning | t72679468 | t72681617 |
|---|---|---|---|
| rclProgress / GCL | 1.35–2.0 pts/t | 17.1 | **67.56** |
| controller delivery | 0.8 e/t | 58.9 | **67.6** (P7 33.8× floor) |
| E4 storage | 351k, **+36.6/t** | 333k, −49.3/t | **189k, −66.8/t** |
| E4 projected equilibrium | 393k | 259k | **89k — BELOW the 150k knee** |

50× on the owner's score metric in one session, and the idle-capital line is
now projected to land *under* its absorbable knee for the first time. The
chain is the one stamped last cycle (reach bound → sites built → wartime exit
→ upgraders sized from actual inflow → link ctrl receipt 70.9 e/t).

**PREDICTION #3 FALSIFIED — utilization is DECOUPLED from the plan.** Predicted
util 0.97→~0.90 and queueDepth 8→≤5. Measured post-transition: **util
0.978/0.949, queueDepth 8/8**. Not a measurement artifact — the mechanism is
in the data:

- Spawn `partsPerTick` was **flat across every capture spanning the deploy**:
  0.652, 0.654, 0.654, 0.656, 0.642. The headroom did not move it at all.
- It DID move the plan exactly as designed: P4 0.95× → 0.63× (plan-implied
  0.422 vs 0.667 physical).
- Fielded fleet **grew** through the same window: 676 → 798 parts, 41 → 43
  creeps.

So the plan asks for 63% of physical while the spawn builds at 96%, and the
gap is not the margin's to close. Two structural reasons, both by design:
(a) the biggest spawn consumers size from **measured stock/inflow at their
work site**, not from the plan (macro doctrine — `sustainableConsumptionRate`);
with a 300k bank draining, that funds big upgraders regardless of the parts
budget; (b) replacement churn scales with the STANDING fleet, not with the
plan's marginal headroom (X5 measures 14% of spend as early-death churn
alone). A 10% plan margin cannot lower a utilization driven by those.

**This is not a regression and must not be chased now.** Utilization 0.96
while converting 130k of idle capital into 133k control points is the drain
working. The honest open question is whether util stays ~0.96 *after* the bank
normalizes near the knee — that is the read worth taking, and it needs a
post-drain window, not a patch.

**Reserver spend ACQUITTED by cadence** (16.4% of spend, the #2 role, and the
2026-07-18 purchase-loop incident was exactly this shape): 12 purchases across
**7 rooms** over 2029t = 1.7/room. At CLAIM_LIFETIME 600 × RESERVER_DUTY 0.5
the expected cadence is 1 per ~1200t per room = 1.7/room. Matches to the
digit; P5 duty 0.50 ok. That is the honest price of 7 reserved rooms, not a
loop. Role mix otherwise healthy — hauler 39.1% is the top, under the >50%
single-role alarm.

**NEW WARN — X1 dry WORK 10.4 parts idle-equivalent** (workUtil 0.84, dry
share 0.15, 67 WORK standing). The re-fleeted consumers now outrun supply ~15%
of ticks. Expected during a bank drain (consumers sized from a stock that is
falling), so it is a WATCH not a work item — but if X1 persists after E4
settles, the consumer sizing is over-shooting its supply and that IS the next
mechanism.

**E6 unchanged at 5 of 10 deferred** (cedc 5123, d01f 4615, both CHRONIC at
100% of window). Spec 37's local-fuel work eats d01f's pile directly; the
hauler drain-term thread remains the alternative attack. Deliberately not
started — spec 37 is a separate session's, and this cycle changed no code.

### AUDIT 2026-07-30 (t72681617→t72683137, dt 1520) — E4 LANDED ON TARGET; utilization mechanism falsified; P4 reserver under-count found + fixed

**CYCLE VERDICT: fixed (instrument) + two watch items resolved.** Third
consecutive zero-FAIL ledger.

**E4 CONVERGED — the session's headline result completes cleanly.** Storage
**129,592**, projected equilibrium **70,432** against a 70,000 reserve target
(surplus **432**). Slope tapered **−66.8 → −39.4/t** exactly as the linear
`spendableBankSurplus/SURPLUS_DRAIN_TICKS` drain predicts. **No overshoot** —
the warchest floor held, which was the explicit regression watch. Arc for the
session: 351k rising **+36.6/t** → 130k at target.

**X1 RESOLVED as predicted.** workUtil **0.84 → 1.00**, dry share
**0.15 → 0.00**, idle-equivalent 10.4 → 0.2 parts. The mid-drain dry share was
the transient it was called, so consumer sizing is NOT over-shooting supply.
Watch item closed without a patch.

**MY UTILIZATION MECHANISM IS FALSIFIED.** Last cycle I explained the pinned
utilization as "a draining 300k bank funds big fleets regardless of the parts
budget". The bank has now stopped draining and **nothing moved**:

```
partsPerTick across SIX captures: 0.652  0.654  0.654  0.656  0.642  0.649
spanning: the 90% headroom deploy (plan 0.95x -> 0.63x), the wartime exit
          + re-fleet, and a 360k -> 130k bank drain to target
utilization: 0.966 / 0.980   queueDepth 8 / 7
```

Flat at ~0.65 p/t (97% of physical) through every one of those. The correct
statement, replacing the bank-drain story: **the spawn is permanently
saturated by demand the plan does not budget** — 0.649 measured vs 0.478
plan-implied. Cause partly identified below; the remainder is spec 38's Q1.

**P4 RESERVER UNDER-COUNT — 7x, found and FIXED this cycle.** The reserver
line read `corps.find(kind === "reservation")?.sizing?.targets` — the FIRST
corp only. Reservation is a **per-room** corp and the colony runs **seven**
(W42N22/W42N23/W43N22/W43N24/W44N22/W44N23/W41N23), each `targets: 1`, each
4 parts. P4 charged **4 parts where 28 stood**:

```
priced    4p = 0.0074 p/t        measured (blackbox) 26,000e / 2,452t
actual   28p = 0.0519 p/t                     = 0.0326 p/t (duty-cycled)
reserver share of MEASURED spawn spend: 21.7% (the #2 role)
```

That single `.find()` was **~26% of the session-long unbudgeted gap** the 90%
headroom failed to explain. Fixed by summing per-room corps and using each
corp's own measured body; red-first tests pin the sum, the 28/540 value, and
the empty case. P4 now reads **0.78x (0.523 p/t)**, gap narrowed
0.171 → 0.126 p/t. Ledger-script only — unit suite (1731 green), no trio, no
deploy.

**Generalization worth carrying**: P4's charter is "ALL fleet classes,
budgeted or not". Any per-room corp class read with `.find()` breaks it
silently. `tenders` and `feeder` use the same sampling shape and are correct
only because the colony has ONE room with them today — they will under-count
the moment a second owned room exists. Filed, not fixed (no second room yet).

**Score 67.6 → 42.9 pts/t — expected, not a regression.** P7 reads
**0.86x** of plan (actual 42.9 vs plan 50.0), i.e. delivery is now tracking
the plan rather than a surplus burst. The 67.6 peak was the bank drain on top
of income; with the surplus exhausted the sustainable rate is what mined
income supports. Still ~30x this morning's 1.35-2.0 floor.

**NEW WARNs (neither actioned)**: E5 3-of-8 runt purchases (hauler@100 x3) and
P2 micro-routes 12 of 23 — both point at the same hauler-sizing thread as E6's
chronic piles. Watch; if E5 persists the drained-spawn purchase path is due
its own cycle.

### CORRECTION 2026-07-30 — the 90% headroom was an EXPERIMENT; its result is a clean negative, not a failure

Owner: *"The 10% spawn headroom is an experiment. It's basically sort of
removing a variable as an explanation to help narrow things down."*

The two audit entries above logged prediction #3 (utilization 0.97→~0.90) as
**"FALSIFIED"**, which frames an experiment's negative result as a failure.
Re-stated correctly:

**What the experiment ESTABLISHED (a real result, not a null one):** *plan
size is not what saturates the spawn.* The plan was cut 10% and obeyed it
exactly (P4 0.95× → 0.63×, later 0.78× after the reserver fix), while measured
`partsPerTick` did not move at all across **six** captures spanning the deploy,
the wartime exit and the whole 360k→130k bank drain: 0.652, 0.654, 0.654,
0.656, 0.642, 0.649. If plan size drove utilization, that intervention would
have moved it. It did not, so plan size is **eliminated** as the explanation.

That elimination is what narrowed the search to the remaining candidates —
replacement churn, unbudgeted classes, consumer self-sizing — and reading the
blackbox role mix against P4's line table is what surfaced the **7× reserver
under-count**. The experiment paid for itself by ruling something out; it was
never a fix and should not be scored as one.

**BUT it now conflicts with the fidelity objective, and the conflict is
measurable.** The sink fill is **budget-BOUND** — `spent 0.389 / budget 0.411`
= **95% consumed**, so the margin is actively suppressing planned fleet rather
than sitting idle:

```
budget WITH the 10% headroom   : 0.411 p/t   (plannable 0.600)
budget WITHOUT it              : 0.477 p/t   (capacity 0.667)   +0.067 p/t
F1 today                       : 1.24x       (WARN; FAIL at 1.25)
F1 with the margin removed     : ~1.10x      (direction certain, magnitude approximate)
```

F1 = measured ÷ planned, so **deliberately shrinking the plan mechanically
worsens fidelity**. Under the doctrine added this session ("prefer a fix that
makes the plan and the runtime agree"), a standing 10% wedge between plan and
reality is the wrong direction — the plan is *designed* to describe a colony
10% smaller than the one that will exist.

**RECOMMENDATION (owner's call, not taken unilaterally — the headroom was an
owner directive):** retire `SPAWN_PLAN_FRACTION` to 1.0 now that its
experimental result is banked. Expected: plan budget +0.067 p/t, F1 1.24 →
~1.10, no change to utilization (that is precisely what the experiment
established). Keep the constant and its plumbing so the experiment can be
re-run by changing one number; the `plannable` ledger field stays useful
either way. Not reverted pending the owner's word.

### CORRECTION TO THE CORRECTION 2026-07-30 — my "remove the headroom" recommendation was built on CONFOUNDED data

Owner, rejecting it: *"If the plan is 10% smaller then everything should get
sized accordingly. The colony will actually be 10% smaller because it's
'constrained' by 10% less spawning."* Correct, and the entry above is wrong in
two ways.

**1. F1 is not degraded by a smaller plan — IF the plan transmits.** F1 =
measured ÷ planned. When the budget shrinks 10%, the solver commissions ~10%
less, corps materialize ~10% smaller, and BOTH sides of the ratio fall
together: F1 stays ~1.0. My claim that shrinking the plan "mechanically
worsens fidelity" silently assumed the numerator is fixed. It is not — it is
supposed to follow. A high F1 under a smaller plan is therefore evidence of a
**transmission failure** (plan shrank, colony didn't), which is exactly the
thing F1 exists to catch. The instrument is fine; my reading of it was not.

**2. My evidence that the colony did NOT shrink is confounded.** The headroom
deployed at ~t72677900 — which lands *between* the last wartime-true capture
and the first wartime-gone one:

```
tick        upgraderParts  wartime  bodyParts  partsPerTick
72676091    4              true     718        0.650
72676360    4              true     676        0.652
  <-- headroom deploy ~t72677900 -->
72678902    50             -        608        0.654
72679468    100            -        744        0.654
72681617    91             -        798        0.642
72683137    100            -        816        0.649
```

The wartime exit re-fleeted the upgraders **4 → 100 parts** across the exact
same window, and the bank drain funded it. Two large UPWARD forces ran
simultaneously with the headroom's downward one. "partsPerTick stayed flat"
is therefore **not** evidence the headroom failed to shrink anything — flat
output under a large upward push and a small downward one is equally
consistent with the headroom working. I over-read a contaminated window and
recommended reverting an owner directive on the strength of it.

**What survives the correction:** the experiment's original negative (plan
size is not what saturates the spawn) is *also* weakened by the same
confound and should be held more loosely than I stated. The reserver 7×
under-count stands on its own evidence (blackbox role mix vs P4's line table)
and is unaffected.

**RECOMMENDATION WITHDRAWN.** The headroom stays at 0.9 per the owner (*"it
makes the plan more realistic to small inefficiencies... not sure what the
exact number is, we can play with that later"*). The pending steady-state read
— no drain, no wartime transition, no deploy reset — is the **first
uncontaminated test** of whether the plan transmits to fleet size at all.
That is the question to answer, and F1 is the right instrument for it.

### AUDIT 2026-07-31 (t72683137→t72684708, dt 1571) — the "steady-state read" caught a REGIME TRANSITION instead: one full oscillation period now observed

**CYCLE VERDICT: measured + named (no code changed).** The window planned as
the first uncontaminated steady-state read turned out to contain a wartime
RE-ENTRY — which is itself the finding.

**THE OBSERVED CYCLE (first full period, all stamped):**
1. surplus era → upgraders sized up from the bank (4 → 100 parts)
2. bank drained 360k → target at −40 to −67/t (as designed, gentle taper)
3. **mid-drain, while surplus still held, the road gate judged and placed the
   NEXT route** — cd94/W43N22, 23/53 tiles, `remoteSites {W43N22: 30}`;
   d01f's trunk simultaneously finished (78→84 of 85, W41N23 cleared)
4. backlog standing → **wartime re-entered** (upgrader stamp `wartime: true`)
5. **the upgrader fleet was relegated and recycled**: 100 parts → 25. The
   blackbox shows the cost: upgraders bought at t72682355 (4450e) and
   t72682517 (4450e) — recycled ~160t later (X5 worst:
   `W43N23-upgrading 4450e@162t`, home bot-signal churn 9%).
   **~9,000e of upgrader bodies bought and unwound inside ~300 ticks.**

Step 5 is a measured regression against an explicit owner directive
(2026-07-29: *"we should definitely want to avoid having to recycle
upgraders"*). The mechanism, named: **consumers buy 1500-tick bodies against a
surplus whose remaining life is measured in hundreds of ticks.**
`SURPLUS_DRAIN_TICKS = CREEP_LIFETIME` correctly matched the drain horizon to
body lifetime — but the horizon assumption is invalidated by PLACEMENT, not by
the drain: the road gate can stand up a backlog at any moment, flipping
wartime and cutting the surplus era short. The upgrader sizing and the road
placement read the SAME surplus lens with no knowledge of each other's
pending claims. Fix classes (BOTH parked, not tonight's work): wartime
entry/exit hysteresis (spec 33's named open item) and/or netting the
placeable-construction claim out of the surplus consumers size from
(spec-38-adjacent — a fourth reader of the one drain rate).

**The wakeup's four questions, answered:**
1. **E4: DONE, no overshoot.** 67,230 vs 70,000 reserve (−2,770 ≈ 4%, the
   taper crossing). `bankSurplusRate` floors at 0 below target so the drain
   formula CANNOT continue below reserve; the line's "projected equilibrium
   7,686" is a linear extrapolation across that regime boundary — instrument
   artifact, noted, not worth a patch (verdict already ok). E4 leaves the
   watch list: 351k rising → at-target in one session.
2. **Sustainable score: ~43-61 pts/t.** 42.90 then 60.81 this window (the
   60.81 rides the recycled upgraders' final burn + 60.8 e/t delivery). The
   honest steady-state number still needs a window with no transition in it —
   which the oscillation may not grant; the oscillation AVERAGE may be the
   real number. Either way: the morning floor was 1.35.
3. **The saturated spawn, refined by the regime change:** utilization FELL to
   0.87 with **13% idle attributed 83% bank-starved** (S4) once the surplus
   was gone — the first movement in seven captures. So saturation was
   surplus-funded: demand still exceeds supply (the starved idle proves the
   queue wanted more), but the SPEND was capped by energy, not by demand
   drying up. Role mix stays hauler-led (47.8%), reservers 18.2% at the
   correct cadence. F1's structural share remains specs 38/39.
4. **E5: 1 of 8** (was 3) — receded on its own; not the top item.

**F1's FIRST FAIL: 1.70× (0.596 measured vs 0.350 planned, 41% unbudgeted) —
transition-dominated.** The plan snapped to the wartime shape (upgrader WORK
→ ~0, construction re-priced small for the fresh route) while the spawn spent
on the transition itself (upgrader churn, hauler rebuilds). The parts ledger
prices an EQUILIBRIUM (spec 11); every regime flip will spike F1 until either
the NOW plan carries a transition term or spec 39 makes spawn spend
commission-traceable. Recorded, not patched — F1 shipped hours ago and gets
no threshold-tuning on its first uncomfortable reading.

**New WARN, watch only: H1 0.72 duty, idleSink AT-SINK 0.26 with storage
having room** — "spatial contention at the deposit". Plausibly the re-fleet
crowding the hub tiles; two-capture rule before any read.

**NEXT READ (the oscillation question):** does wartime exit when W43N22's 30
sites complete, the surplus re-accumulate, and the upgrader re-fleet repeat
the buy-then-recycle churn? One more observed period ≈ confirmation the
colony is in a stable limit cycle; the churn per period is then a priceable
waste line.

### NOTE 2026-07-31 (t72684708→t72684838, dt 130) — short window (slow server), two watches closed, no cycle claimed

The server ran ~0.04 t/s this hour, so the oscillation questions get no
answer (dt 130 < every relevant horizon; P8's "FAIL 0 e/t" here is the
documented sub-round-trip artifact, F1 1.53 is still the same transition).
Two instantaneous reads ARE valid, and both closed themselves:

- **E4 confirmed self-correcting**: storage 67,230 → **72,497**, back ABOVE
  the 70k reserve within 130 ticks of the taper crossing. The undershoot was
  the crossing, not a leak. E4 is DONE-done; off the watch list.
- **H1 recovered without intervention**: 0.72 → **0.87** duty. The at-sink
  contention was the re-fleet crowding the hub, transient as suspected. The
  two-capture rule saved another patch.

Wartime still standing (30 W43N22 sites, poolWork 9,960, build crew not yet
fielded). The oscillation read re-armed; if the next window is also short
(<~1,500t), re-arm again without claiming a cycle.

### INCIDENT 2026-07-31 — exit-tile bounce (owner-reported: "builders in W43N22... stuck on the border tiles")

Confirmed live by direct API position sampling (three samples, 45s apart):
`builder-uction-72685930` at **W43N23 (36,49)** then **W43N22 (36,0)** — the
same exit-tile pair, straddling the border directly over the road site at
**(36,2)**. Corp stamp corroborates the cost: poolWork 9,960 → 9,380 over
2,054 ticks = **0.28 e/t** against a 30-site campaign.

**Mechanism** (three cooperating pieces, all read in code):
1. The engine moves any creep standing on a border tile (x/y = 0|49) into the
   adjacent room at tick end.
2. A latched target within working range (3) of the border makes the range-3
   arrival tile the exit itself — `doBuild`/`doMaintenance` happily work from
   it (the ACTION is fine; the PARKING is the bug).
3. After the teleport, `runBuilder`'s cross-room branch walks the creep back —
   calling `shedLoad` (dropping its cargo at the border) each re-entry — and
   the walk's arrival tile is the exit again. Loop.

**Fix (deployed after full gate): never park on an exit tile.** Build/repair
and move are DIFFERENT action groups, so the escape is free: standing on an
edge tile, the creep issues a move inward toward its target AND still
builds/repairs the same tick. Three seams: `doBuild`, `doMaintenance`, and
the vectorFed dry-park branch. Red-first tests pin all three (build fires AND
a move is issued from (36,0) at a (36,2) site; off-edge parking unchanged).

Cross-filed to spec 37 territory (the border class belongs in its problem
inventory) but fixed NOW as an owner-reported live incident — the fix is
narrow execution logic, not the fuel-lens redesign.

**Predicted deltas (registered before deploy):** the (36,49)/(36,0) bounce
disappears from API samples; W43N22 poolWork rate rises from 0.28 e/t toward
the plan's ~10 e/t as the campaign actually builds; H1's border ground-pile
(shedLoad debris) stops growing.

**VERIFIED (same incident, post-deploy):** control sample minutes before the
deploy still showed the bounce ((36,0)→(36,49)→(36,0)); post-deploy the same
creep reads **(35,1)→(36,2)→(35,3)** — off the border, at the exact site it
was stuck above, then advancing down the route as tiles complete. Prediction
1 of 3 confirmed on the spot; poolWork rate and the border ground-pile need a
longer window (next audit). Full gate before deploy: 1738 unit + trio all
green (runt-economy passed first try, upsize at tick 440).

### AUDIT 2026-07-31 (t72687013→t72687812, dt 799) — exit-tile escape VERIFIED: P8 0.28 → 10.51 e/t

**CYCLE VERDICT: FIXED, all three predictions confirmed.** (dt 799 is short
for the oscillation questions — those stay open — but the build-rate read is a
direct stamp difference and is valid.)

| prediction (registered pre-deploy) | result |
|---|---|
| the (36,0)↔(36,49) bounce disappears | ✅ same creep at (35,1)→(36,2)→(35,3), working down the route |
| W43N22 build rate rises from 0.28 toward the ~10 e/t plan | ✅ **P8 10.51 e/t** — 37×, and at the plan's number |
| border ground-pile (shedLoad debris) stops growing | ✅ H1 ground-piled 8,971 → **5,977**; at-sink idle **0.26 → 0.01** |

Supporting: W43N22 poolWork **9,260 → 3,300** (5,960e built in that room
alone), road receipts **+8,400e**, remote W43N22 sites **29 → 11** — eighteen
completed in 799 ticks after ~0 in the preceding 2,054. The earlier H1
"spatial contention at the deposit" WARN was the same bug: shed cargo piling
at the border, now cleared.

**Second-order effect, healthy**: with the campaign actually completing and
storage refilling to 105,514 (surplus), `placementGateOpen` widened — home
siteCount **0 → 24**, and W44N22 opened with 31. Build capacity checked
against it: **7 WORK across six corps** (home 2 + five remotes × 1) vs 38.3
e/t allocated — matched, so the widened board is funded, not fantasy.

Score 2.00 pts/t: wartime still standing (controller relegated by design
while the backlog builds), so this is the doctrine working, not a regression.

**New finding, filed to spec 37 as P-H (not patched)**: the last-builder rule
is a half-implemented invariant — it blocks RECRUITING the last builder onto
the repair detail but never RELEASES one when the crew shrinks to 1 by
attrition. Live: `crew 1, onRepairDetail 1, buildWork true` with 19,800e
standing. Cost is bounded (2 of 7 colony WORK; P8 healthy), and the naive fix
re-opens cons-repair-stops-at-99 (its container sat at 55% — above the
critical gate — so a crew-1 release would strand it). Trap list applies: this
is the second patch on `assignRepairDetail`, so the mechanism is the bug and
it belongs to spec 37's pricing work.

### AUDIT 2026-07-31 (t72687812→t72688666, dt 854) — campaign delivering; E6 is a PRICED reallocation, not a defect

**CYCLE VERDICT: MEASURED, no code change.** Three reads, one of which
retires an open spec item and one of which reclassifies a worsening line.

**1. The build campaign is landing.** P8 **11.36 e/t built** — the exit-tile
escape's 37× is holding a second window, not a one-capture spike. Home
siteCount **24 → 1** (23 completed), W43N23 poolWork **7,200 → 160**, remote
roads **+6,900e** via receipts. The stamp shows the crew following the work:
poolRooms 3 → 4, `crewAt "W43N22"` → `"W43N22,W43N23"`, W43N24 opening a
container placement (`placeResult 0`).

**2. Spec 37 P-H self-resolved with no patch — the bounded-cost call was
right.** Last window: `crew 1, onRepairDetail 1, buildTargets "R"` (the whole
crew on the repair detail, the half-implemented invariant). This window:
`crew 2, onRepairDetail 1, buildTargets "RB"` — the +1 detail demand fielded a
second body and the crew is now one repairer + one builder, exactly the shape
the rule intends. The invariant is still only half-implemented (no RELEASE on
attrition, so it will recur), but the measured cost of NOT patching it is one
creep-generation of single-role work, and the naive release still re-opens
cons-repair-stops-at-99. Stays filed to spec 37 as pricing work, now with a
measured recurrence cost rather than a guess.

**3. E6 worsened to 7 of 10 miner ops deferred — and it is the plan's own
decision, visible in the plan.** Source piles 29,354, ground-piled 10,998e,
H1 duty 0.93 (haulers BUSY, so this is under-asking, not idling). The cause
is a deliberate reallocation of spawn capacity from hauling into the build
campaign, and it is legible across four captures:

| tick | hauler spawn p/t | construction alloc | source piles |
|---|---|---|---|
| 72684708 | 0.2005 | 10.0 e/t | 24,564 |
| 72687013 | 0.2153 | 20.0 e/t | 25,615 |
| 72687812 | 0.1663 | 38.3 e/t | 18,997 |
| 72688666 | 0.1496 | 40.5 e/t | 29,354 |

P4 corroborates from the other side: `construction (all-in)` **47p=0.032 →
165p=0.114** while `source-route haulers` **248p=0.172 → 185p=0.127**. The
piles are the priced consequence of buying roads with hauler capacity; they
should drain when the campaign completes. **This is what a controllable
economy looks like** — a line got worse and the plan says why, in the plan's
own units, without a hypothesis. Re-check next cycle: if construction alloc
falls and the piles do NOT drain, the reallocation was not the cause and E6
is a real hauling defect.

**Unchanged / still open:**
- **F1 1.57 FAIL** (spawn builds 0.633 p/t, plan prices 0.402 — 0.231 p/t
  unbudgeted, 36%). Same wartime-transition pattern as prior windows; spec 39
  owns the fix (universal effective-ttl pricing + plan-owns-the-fleet).
- **E4 ok and CONVERGING**: storage 115,846, slope +12.10/t, projected
  equilibrium **133,994** — below the 150k knee, so the draw is damped, not
  runaway.
- Score **1.28 pts/t** (gcl progress 279,642,531 → 279,643,621 over 854t).
  Wartime relegation by design: P7 delivering 1.3 e/t against a relegated
  floor of 2.0 while the surplus funds building.

Specs 37/38/39/40 remain fresh-session work per standing instruction; nothing
in this cycle was actionable inside it.

### AUDIT 2026-07-31 (t72688666→t72689264, dt 598) — E6 hypothesis CONFIRMED; F1 now names its own leak

**CYCLE VERDICT: FIXED (instrument) + hypothesis CONFIRMED.** Score back to
**2.00 pts/t** (gcl 279,643,621 → 279,644,817), CPU 24.8/300, bucket full.

**1. The registered re-check fired and CONFIRMED the reallocation reading.**
Last cycle predicted: *"if construction alloc falls and the piles do NOT
drain, the reallocation was not the cause and E6 is a real hauling defect."*

| | t72688666 | t72689264 |
|---|---|---|
| construction alloc | 40.5 e/t | **10.0 e/t** |
| source piles | 29,354 | **22,323** (−11.8 e/t) |
| E6 deferred | 7 of 10 | **6 of 10** |
| P4 construction | 165p = 0.114 | 46p = 0.032 |
| P4 source-route haulers | 185p = 0.127 | 228p = 0.157 |

Campaign complete (home sites 1 → 0, remote 43 → 29, P8 **21.29 e/t built**),
capacity returned to hauling, piles drained. E6 was the priced consequence of
a plan decision, exactly as read — not a hauling defect. **The hypothesis was
falsifiable, was registered before the data existed, and survived.**

**2. F1 decomposes (the cycle's deliverable).** F1 had said "0.286 p/t
UNBUDGETED (44%)" for five straight cycles while naming only *the largest
PLANNED class* — a different question. Locating the breach meant
hand-bucketing the blackbox ring by role every cycle, and the answer never
changed:

```
in breach: haulers 0.498 vs 0.188 (+0.310),
           construction (all-in) 0.072 vs 0.032 (+0.040),
           reservers 0.028 vs 0.052 (-0.024);
UNPRICED classes: raidGuard 0.014 p/t
```

**Haulers are 89% of the gap** — and E6 ("the leak is HAULING") and H1
("haulers BUSY ⇒ plan under-asks, inflow-sized carry, **no drain term**")
were saying so from two other directions the whole time. Three lines, one
defect, and F1 is now the one that names it. Spec 39 gets a target rather
than a total.

Implementation notes worth keeping: the actual side is recorded in **PARTS at
the spawn site**, not inferred from cost — cost is biased across classes (a
CLAIM part is 600e vs 50e for CARRY, so reservers read as 21% of spawn SPEND
against 4% of spawn PARTS, a five-fold error on exactly the class P4 already
got wrong once). `executeSpawn` now returns the part count; blackbox segment
v1 → v2.

**3. The instrument caught its own bug on first contact with live data** —
worth recording as the pattern. F1 initially reported `upgrade` as an UNPRICED
class. It is not: the class map was keyed `"upgrading"` where the registered
kind is `"upgrade"`. A typo there fails in the *worst* direction — the class
does not vanish, it is re-reported as a plan HOLE. The fix is a ratchet, not a
string patch: `CommissionHost.ALL_CORP_KINDS` now exports the roster and a
test asserts every registered kind is either classified or an acknowledged
unpriced kind, so a spec-17 registration-only kind fails the audit until
someone decides which it is.

**4. X3 FAIL (3 untracked) read as TRANSIENT, no fix — with a falsifier.**
The three are 1 `released-builder` (a *designed* hand-off state:
`RELEASED_BUILDER_CORP_ID` exists so `claimsOrphan` can adopt rather than
strand) plus 2 `countMismatch` entries. The mismatch corps ROTATE every
capture (d01f → construction/cd8e → cbd5/d01f) = creeps mid-spawn, not a leak.
The released builder appeared in ONE capture, and one capture cannot
distinguish transient from stuck. **Falsifier for next cycle: if
`builder-uction-72688472` is still `released-builder`, the hand-off is stuck
past its 25t grace and is a real defect.**

**5. E4's verdict flipped on the sign of the slope while the behavior was
identical — filed as evidence for spec 40 Part C, deliberately not patched.**
Last window +12.10/t read *"CONVERGING (damped draw, healthy)"*; this window
−15.00/t reads *"flat/falling at a big surplus — not convergence evidence;
check the spend path"*. Both are the same colony doing the same thing: the
bank buffering a build campaign. The spend path is demonstrably working (P8
21.29 e/t into sites — the *same energy* the bank lost). E4 cannot tell
"drained into roads" from "drained into waste" because **capital formation has
no instrument**, which is precisely spec 40 Part C. The line prompted a check
and the check passed; patching E4's heuristic in isolation would be the second
patch on a mechanism whose real gap is a missing term. Left alone on purpose.

Predictions registered for next cycle: (a) F1's decomposition drops the
"parts est. from cost" label once ~2,000 ticks of v2 rows accumulate;
(b) source piles keep falling with construction alloc at 10.0; (c) the
released builder is adopted or recycled.

### STATUS READ 2026-07-31 (t72689264→t72690582, dt 1318) — wartime exits, score 2.0 → 20.0 pts/t

Not a full cycle (owner status check, no change shipped) but it closes the
three predictions the previous cycle registered, all three in the healthy
direction:

| prediction | result |
|---|---|
| F1's decomposition drops the "parts est. from cost" label as v2 rows accumulate | ✅ line now reads `[over 913t]`, no `est.` — measured, not inferred |
| source piles keep falling with construction alloc at 10.0 | ✅ E6 **6 of 10 → 3 of 10** deferred; ground-piled 5,409 → **1,909** ("buffers near cap, no leak") |
| the released builder is adopted or recycled | ✅ `unattributed: []`, X3 back to **ok** (2, both mid-spawn) — the `claimsOrphan` hand-off works, no patch was needed |

**The build backlog emptied and the economy switched back to the controller.**
Remote sites 29 → **0**, home `siteTotal 0` — nothing left to build anywhere.
Consequences, all measured in one window:

- **P7 20.0 e/t actual vs 14.1 planned (1.42×)** — the wartime relegation is
  GONE, not merely satisfied. This is the oscillation question from earlier
  cycles resolving: wartime exits when the board clears, exactly as designed.
- **Upgraders re-fleeted 2 → 46 WORK standing**, `workUtil 1.00`, X1 dry 0.00.
  P4's upgrader line 30p=0.020 → 132p=0.088.
- **Controller link flow 2.4 → 26.4** (LINK tax 2.64/1034t) — the link network
  absorbed the new load without a hauler build-out.
- Fleet 45 → **36 creeps**: the construction crews demobilized cleanly on
  their own when the work ran out.
- Score **1.28 → 2.00 → 20.00 pts/t** over three windows.

E4 back to `CONVERGING` (119,088, +9.26/t, equilibrium 132,984 < the 150k
knee) — and note this vindicates NOT patching E4 last cycle: the same line
that read "check the spend path" on a falling bank now reads healthy on a
rising one, with no code change and no defect in between. The heuristic was
never wrong about the colony; it just cannot see capital formation, which
remains spec 40 Part C's job.

Still open, unchanged in kind: **F1 1.78 → 1.42**, still failing, still
haulers (0.487 p/t built vs 0.217 priced). Improved because the plan grew, not
because the runtime shrank. Spec 39 owns it. **E2 crept 16 → 22 parts**
stranded (W41N23-hauling-4-38, a single hauler) — WARN, worth a falsifier
next cycle: if it climbs a third window it is a real strand, not a route in
transition.

### AUDIT 2026-07-31 (t72690582→t72695674, dt 5092) — the hauler churn loop ROOT-CAUSED: both sizers referenced the ROOM, not the ROUTE

**CYCLE VERDICT: FIXED (bot change, red-first).** Score **34.16 pts/t** (gcl
279,671,177 → 279,845,110), CPU 20.6/300, bucket 10,000/10,000, RCL 7.

**Ledger:** 2 FAILs — F1 1.49× (top line) and P7 0.44×. They are ONE defect.

| line | reading |
|---|---|
| F1 | measured 0.646 p/t vs plan 0.434 — **haulers 0.471 vs 0.225 (+0.246)**, upgraders 0.035 vs 0.069 (−0.033), raidGuard 0.029 unpriced |
| P7 | controller 34.2 e/t vs plan 77.7; stock 640→609 (**the energy was there**) |
| spawn | util 0.99 / 0.95, queueDepth 7 / 8 — a saturated, zero-sum pie |
| X1 | 64 WORK standing, workUtil **1.00** — the upgraders that exist are never dry |

The upgraders are not idle and not starved of energy; there are **half as many
as the plan buys**. Under a saturated spawn the hauler over-build is paid for
out of the upgraders' build time, and P7 is the score-side invoice for F1.

**The mechanism (proven, not inferred).** The standing hauler fleet (~353
parts) MATCHES the plan's carry (205 planned CARRY parts). So the 2.1× is not
a bigger fleet — it is the same fleet **bought over and over**. The blackbox
ring named the shape: every near-simultaneous same-corp respawn in the window
was a small body followed by a maximum one, e.g. `W41N23-hauling-4-38`
(carryNeeded **7**) spawning `[20, 16, 50, 16, 50]` parts — two 25-CARRY /
2500e haulers inside 2419 ticks for a 7-CARRY job.

Both hauler sizers measured a body against `maxCarryPairs(room capacity)`:

- `CarryCorp.getSpawnDemand` top-up branch: once the fleet had the planned
  COUNT but not the planned CARRY, it asked for `maxCarryPerHauler` — a
  4-CARRY hole ordered a 25-CARRY body.
- `CarryCorp.flagRuntForRecycling`: retired the smallest hauler whenever it
  was under `maxCarryPerHauler`, so the 8-CARRY body that FULLY COVERED a
  7-CARRY route read as a runt and was retired on every flush-spawn tick.

At RCL 7 (capacity 5600 → 25 pairs) that pair is a **standing churn loop on
every short route**: retire the adequate incumbent, rebuild at 3.5× the route,
repeat. It could not exist below RCL ~5, where capacity and route need are the
same order — the colony grew into it.

**The fix: a hauler's right size is a property of its ROUTE, not of the room.**
New primitive `haulerBodyCarry(energyBudget, carryNeeded)` = the route's even
per-body share across the smallest fleet that covers it (≤ `maxCarryPairs` by
construction). Both call sites now reference it. `maxCarryPairs` keeps its one
correct job: the divisor that sets the fleet COUNT.

Red-first, two cells in `CarryCorp.behavior.test.ts` — the demand half failed
at **25 expected ≤7** before the fix; the recycle half pins that a covering
body is never flagged. Gate: unit 1756 pass, `flow-handoff` / `runt-economy` /
`storage-depot` green on the rebuilt bundle.

**Falsifiable predictions registered for the post-deploy re-capture:**
1. hauler spawn load falls from 0.463 p/t toward the plan's 0.225;
2. F1 ratio falls from 1.49× toward 1.0;
3. upgrader spawn load rises from 0.035 p/t toward 0.069, and **P7 rises from
   0.44×** — the score-side confirmation;
4. **no hauler body spawns above its route's `carryParts`** (blackbox parts vs
   segment-6 `haulers[]`) — the direct read on the invariant;
5. E6 does NOT worsen (4 of 10 gated). The fix never sizes BELOW the route's
   share, so piles must not grow. **If they do, prediction 5 is the falsifier
   and the change is wrong.**

**Not addressed this cycle, named with data:** the ~0.21 p/t unbudgeted is not
all this loop. Raided remotes (raidGuard debts W41N23 70,240 / W43N24 82,040;
W43N22 raid debt 226,390 mid-window) kill haulers early, and the plan prices
every route at a full 1500-tick life — a P5 price/behavior drift with no
ledger row yet. Also: the harvest corps' nested haul vector carries **85% of
hauler spawn spend** (59,150e of 69,750e) and exports **no sizing stamp** —
the `hauling-*` carry corps stamp richly, `mining-*` stamp only the miner. The
top spender is the least instrumented decision site in the colony.

### VERIFY 2026-07-31 (t72695674→t72696547, dt 873) — route-sizing fix deployed; read is CONFOUNDED by a regime flip

**CYCLE VERDICT: partial — two predictions scored, three unscoreable.** The
route-sizing fix (206b4d7) went live at t72695674. First post-deploy read:

| | pre-fix t72695674 | post t72696547 |
|---|---|---|
| ledger FAILs | **2** (F1 1.49×, P7 0.44×) | **0** |
| F1 plan fidelity | 1.49× | **1.15×** (WARN) — haulers OFF the breach list |
| E2 stranded fleet | 30 parts off-plan | **0** ("every fielded hauler serves a planned route") |
| E6 gated miners | 4 of 10 | **3 of 10** |
| upgrade rate (gcl Δ/t) | 34.16 | 46.41 |

**SCORED:** prediction 1 (hauler spawn load toward plan) — haulers no longer
appear in F1's breach list at all, where they were +0.246 p/t. Prediction 2
(F1 → 1.0) — 1.49 → 1.15. Prediction 5, **the falsifier, did not trip**: E6
went 4 → 3 gated and cbd8's pile halved (4,114 → 2,153), so the smaller bodies
did not starve the routes. E2 → 0 is the cleanest single result: the bodies
with no route to justify them are gone.

**UNSCOREABLE — do not read the upgrade rate as a +36% win.** The colony
flipped into the **wartime construction regime** inside the window (upgrader
stamp `wartime: true, construction: true, allocated: 2` against
`planAllocated 126`; upgraders 3 creeps/64 WORK → 1/2 WORK, construction
creeps 4 → 12). The upgrader is relegated to the floor BY DESIGN there
(spec 33), so P7 now measures against the relegated floor rather than the
peacetime plan, and predictions 3 (upgrader load, P7) cannot be scored. The
46.4 e/t is incumbent upgraders draining out mid-transition and the near-term
direction is DOWN for doctrinal reasons, not because of the change. This is
the same trap logged at t72683137→t72684708 — a transition read as a
steady state.

Prediction 4 (X6) is also unscoreable: the row exists but reads DRAIN-BLIND on
30 of 34 spawns pre-v12, and this window offered only 2 hauler spawns.

**Window quality caveat:** the deploy's global reset left the blackbox ring at
**379 ticks**, so F1 (1.15×) and X5 (0.00) are thin reads. X5's 0.00 against a
pre-fix 0.13 is NOT evidence yet — a post-reset ring has had no time to
accumulate an early death.

**Held back on purpose:** segment 4 v12 (7b1e185, the miner-operation
haul-vector stamps) is committed but NOT deployed. Deploying resets the ring
again and costs the clean steady-state window this verification still needs.
Ship it once the next read lands.

### VERIFY 2026-07-31 (t72695674→t72696770, dt 1096) — route-sizing fix CONFIRMED; the mechanism proved itself on the carry ledger

**CYCLE VERDICT: FIXED, verified.** Four of five predictions scored, one
unscoreable by design. **No FAIL lines** (was 2). No checklist line regressed.

| prediction | pre-fix t72695674 | t72696770 | verdict |
|---|---|---|---|
| 1. hauler spawn load → plan | 0.463 p/t (plan 0.225) | **0.148 p/t** (plan 0.182) | **CONFIRMED** |
| 2. F1 → 1.0 | 1.49× FAIL | **1.19× WARN** | CONFIRMED (direction) |
| 3. upgrader load / P7 rise | 0.035 p/t, P7 0.44× | 0.006 p/t, P7 relegated | **UNSCOREABLE** |
| 4. no body above its route | — | X6 **0 p/t**, 2/4 stamped | confirmed (weak, n=4) |
| 5. E6 must not worsen (falsifier) | 4 of 10 gated | **2 of 10** | **did NOT trip** |

**The mechanism proved itself, and this is the reading that matters.** Hauler
spawn rate fell 68% (0.463 → 0.148 p/t) while STANDING CARRY ROSE 45%
(270 → 393 parts). More fleet fielded, for less than a third of the spend.
That is precisely what killing a replacement loop looks like — the bodies now
LIVE instead of being retired-and-rebought — and it is the one reading the
wartime confound cannot manufacture: a defunded class loses standing carry, it
does not gain it. E2 held at 0 off-plan parts across both post-deploy reads.

E6's piles fell with it (cd8e 2473→2008, cbd8 4114→off the list entirely),
so the smaller, right-sized bodies did not starve their routes — the falsifier
had a fair chance to trip and did not.

**Prediction 3 stays unscoreable and that is correct, not a miss.** The colony
is in the wartime construction regime (builders 0.211 p/t, 15 construction
creeps, tankers 0.147); the upgrader is held at the relegated floor of 2 BY
DOCTRINE (spec 33), so P7 measures against that floor and the peacetime
comparison does not exist this window. F1's breach list moved with the regime:
haulers are GONE from it, construction is now the top breach (+0.241). Score
37.4 pts/t (34.2 pre-fix) — up, but under a regime shift, so not claimed.

**Window caveat, stated:** the blackbox ring is 640t (the deploy reset it), so
F1 and X5 remain provisional. The carry-ledger reading above does not depend
on the ring.

**Segment 4 v12 DEPLOYED** now that the verification window is spent. Next
cycle's X6 stops being drain-blind on the 85% of hauler spend the miner
operations carry, and E6's "read the carry pickup stamps" instruction becomes
executable for the first time.

**Open, unattacked, named:** (a) construction is the new F1 breach (+0.241
p/t) — expected under a campaign, but it should retire when the campaign does;
(b) the raid-driven early-death drift (P5, no ledger row) is still unpriced;
(c) P2 micro-routes at 10 of 19.

### AUDIT 2026-07-31 (t72696770→t72700221, dt 3451) — P7's chronic redness ROOT-CAUSED: the plan's energy budget subtracts two fleet classes out of eight

**CYCLE VERDICT: BLOCKER NAMED WITH DATA (new ledger row P10); no bot change.**
Score 41.5 pts/t. CPU 20.3/300, bucket full. The road campaign RETIRED in this
window (remote sites 23→0, P8 4.40 e/t, +7,500e of receipts).

**The route-sizing fix is now PINNED and holding.** X6 read 26/26 spawns judged
against the corps' OWN carryNeeded stamps (segment 4 v12 landed) — **0 p/t
bought above route**. F1 **1.03×**. E2 0. E5 0. E6 4→2→**1** of 10 gated.

**The new picture is the inverse of last cycle's.** With the campaign gone the
spawn went from saturated to **idle 26% of the window, 89% of that idle
labelled `empty` = NO DEMAND**, while P7 fell to **0.39×** (41.5 e/t actual vs
106.4 planned) and 129k sat banked. Spare spawn, spare bank, unmet plan.

**The mechanism is an arithmetic identity, not a hypothesis.** Three stamps
agree to three decimals:

```
banked 128,992 − reserve 70,000      = 58,992 surplus
58,992 / SURPLUS_DRAIN_TICKS (1500)  = 39.328
+ STORAGE_UPGRADE_TARGET (15)        = 54.328  ← feederRelayRate
```
feeder stamp `relayRate = bodyRate = surplusRate = 54.328`; upgrader stamp
`inflow = 54.328`, `allocated = 54.713` (= `sustainableConsumptionRate(578,
54.328)`), `demand: "staffed"`, 53 WORK standing against a plan of 107.
X1 `workUtil 0.998, dryShare 0.002` — those 53 WORK are never dry. The
consumer is not starved; it has stopped asking, because the valve that feeds
it is a pure function of the BANK SURPLUS.

**First hypothesis FALSIFIED:** "the planner and the runtime run two different
drain laws." They do not — `bankToTransientSource` and `feederRelayRate` both
call `bankSurplusRate`. One law, shared.

**The real seam, measured (new row P10 = 27.13 e/t).** `totalOverhead =
minerOverhead + haulerOverhead` (flow/FlowTypes), and `netEnergy = totalHarvest
− totalOverhead` is what the solver hands to sinks. Measured against the
blackbox ring over 2,608t:

| | e/t |
|---|---|
| plan `totalOverhead` (miners + haulers) | 18.29 |
| measured miners + haulers | 25.88 (**1.42× priced**) |
| measured OFF-PLAN — reserver 10.97, upgrader 4.06, tanker 1.92, guard 1.25, builder 1.04, feeder 0.31 | **19.54** |
| measured TOTAL spawn spend | 45.42 |
| **handed to sinks but already spent** | **27.13** |

Six of eight fleet classes are spawned from energy the plan has already
promised to a sink. P4 counts ALL classes on the PARTS side by doctrine; the
ENERGY side counted two.

**So the runtime is RIGHT and the plan is WRONG — the opposite of the reflex
read.** Income ~100 e/t gross minus measured spawn 45.4 leaves ~54.6 e/t of
true residual; the feeder valve settled at 54.33. The valve is *discovering the
residual*, and the bank's −6.03/t slope is it converging on the fixed point
(zero slope at surplus ≈ 59,400; measured 58,992). Raising the valve to chase
the plan's 106.7 would buy points around the disagreement — the doctrine's
named anti-pattern. **The fix belongs in the plan's cost accounting.**

**Deliberately NOT fixed this session.** Making `totalOverhead` whole changes
`netEnergy`, hence every sink allocation, hence the whole economy — the
deepest class of live-behavior change, and it raises a policy question that is
the owner's (how much of the bank is spendable once the plan stops
over-promising). Named, priced, and pinned as P10 instead; next cycle attacks
it against a measured target.

**Labeled hypothesis, not chased (one at a time):** X5 flagged
`W41N23-harvest-d01f 2000e@1t` as a fast respawn. All six sub-60t pairs this
window were CROSS-SPAWN (Sp1→Sp2), zero same-spawn — the same signature seen
at t72695674. But d01f's plan target is **2** haulers, so a 1-tick pair may be
a correct cohort fill that X5 mis-slots: harvest corps stamp the MINER's
staffing (1), and X5's same-slot lens keys off staffing. If so this is an
INSTRUMENT bug in the class of the `upgrading`/`upgrade` typo, not a bot
defect. Falsifier for next cycle: compare X5's slot arithmetic against the
corp's hauler target rather than its stamped staffing.

### AUDIT 2026-07-31 (t72700221→t72701842, dt 1621) — X6 cried wolf and was fixed; the bank SAW-TOOTH captured end-to-end

**CYCLE VERDICT: instrument FIXED (X6 false positive) + blocker measured (the
oscillation).** No bot change. Score **68.29 pts/t** — the highest sustained
figure on record — but see the funding line below before reading that as a win.

**A RAID WAVE hit three remotes inside the window** (t72700080 W41N23 debt
112,840; t72700423 W44N23 106,620; t72700655 W42N22 72,910). F1's 1.77× breach
is substantially that incident: `raidGuard 0.054 p/t UNPRICED` (guards are
off-plan by doctrine, P4 amendment b) plus `haulers +0.128` replacing raid
losses. E6 went 1 → 4 gated as remote piles rebuilt behind the dead haulers
(cd8e 3006, cd94 3314, d01f 2540). **The ledger cannot net an incident out of
F1**, so a raid window's F1 is not comparable to a quiet window's — noted as a
reading limitation, not patched.

**X6 FAILED and the FAIL was WRONG — my own pin, fixed.** It flagged
`mining-W43N24-harvest-cd8d 22c on a 5.0c route (4.4x)`. Reading both
endpoints:

| | carryNeeded | plan routes |
|---|---|---|
| t72700221 | **18** | storage d=41, carry 16.8 |
| t72701842 | **5** | construction d=1 carry 0.74 **+** storage d=41 carry 1.25 |

The 22-CARRY body was bought at t72701035 against a need of 18 — **1.2×,
correct**. The wartime regime then re-pointed the source at a construction
site ONE TILE away and carryNeeded collapsed to 5, making a correct body read
4.4× over. **Fix:** X6 now judges each body against the MAX need its route
carried across BOTH capture endpoints. Re-run clean on both windows (27/27 and
26/26, 0 p/t). A pin that cries wolf is worse than no pin — the row's own
comment said so and the row broke the rule on first live contact.

Related and real, though not waste: the wartime re-route collapses long haul
routes to micro-routes mid-creep-life (P2 micro-routes 6 → 10). Correctly-sized
bodies end up oversized for a route that changed under them. P1 does not see
this — it tracks funded↔excluded flips, not SINK changes.

**THE SAW-TOOTH, measured end-to-end** (this is the cycle's real deliverable —
it joins last cycle's valve identity to an observed full swing):

| | bank | feeder valve | upgrader alloc | standing WORK |
|---|---|---|---|---|
| t72700221 | 128,992 | **54.328** | 54.71 | 53 |
| t72701842 | 55,201 | **15.000** | 2.00 | **68** |

In 1,621 ticks the valve collapsed **3.6×** (the bank crossed below the 70,000
reserve, so `bankSurplusRate` → 0 and `feederRelayRate` → `STORAGE_UPGRADE_TARGET`
alone) while the standing upgrade fleet **GREW** 53 → 68 WORK, still filling
toward the OLD valve. Those 68 WORK are now allocated **2 e/t** and will burn
out unreplaced; meanwhile they drained the bank at −45.52 e/t. The valve is
continuous in `banked` — there is no cliff — but the FLEET lags it by a
1,500-tick creep life, and the bank swung on a ~1,600-tick timescale. Fleet
and valve are permanently fighting the previous regime.

Score reads 68.29 pts/t against a −45.52 e/t bank slope, so only **~22.8 e/t
was income-funded**. The record-looking number is the down-stroke of the
saw-tooth, not a new plateau.

**HYPOTHESIS (labeled, not proven): P10 drives the overshoot.** The plan
over-promises by 33.18 e/t this window (plan overhead 13.88 vs measured spawn
47.06; off-plan 25.09 never subtracted), so the valve is set above the
sustainable residual, the bank drains to the reserve, and the valve slams.
Falsifier for the next cycle: if the bank refills and the valve re-opens to
~54 while P10 stays ~30, the next down-stroke should repeat with the SAME
period — a fixed accounting error produces a repeatable saw-tooth, whereas a
raid-driven one-off would not recur on schedule.

**Cadence correction for this log:** shard1 is running at **~4.0 s/tick**
(measured: 188,190 ticks between 2026-07-23T03:17Z and 2026-07-31T21:02Z from
the fixtures' `capturedAt`), not the ~1 tick/s the playbook assumes. A
3,000-tick steady-state window is **3.3 hours**, and today's 40-minute
post-deploy check-in bought only ~580 ticks — which is why three verification
windows in a row came back thin.

### AUDIT 2026-08-01 (t72701842→t72703512, dt 1670) — the saw-tooth HYPOTHESIS CONFIRMED: it is a LIMIT CYCLE, and every score read in this log is a phase sample

**CYCLE VERDICT: hypothesis CONFIRMED + instrument added (OSC). NO economic
delta — no ledger line reached target and the progress rate was not raised.**
Stating that plainly per the command's own success criteria: this cycle earns
its keep on "a blocker was named with data", nothing more.

**The registered prediction held exactly.** Last cycle: *"those 68 WORK are now
allocated 2 e/t and will burn out unreplaced."* Measured: **68 → 18 WORK**,
score 68.29 → 13.96 pts/t, bank slope −45.52 → **+17.55** (refilling).

**Four captures now describe the full cycle:**

| tick | bank | valve | upgAlloc | WORK | score |
|---|---|---|---|---|---|
| 72696770 | 149,803 | 68.20 | 2.00 | **2** | — |
| 72700221 | 128,992 | 54.33 | 54.71 | 53 | 41.51 |
| 72701842 | 55,201 | **15.00** | 2.00 | **68** | **68.29** |
| 72703512 | 84,511 | 24.67 | 25.16 | 18 | 13.96 |

**The fleet PEAKS exactly as the valve BOTTOMS — ~180° antiphase.** The
positive feedback is explicit: a wide valve builds a big fleet → the big fleet
drains the bank past the reserve → `bankSurplusRate` → 0 → the valve slams to
`STORAGE_UPGRADE_TARGET` → and the fleet, which cannot shed faster than a
1,500-tick creep life, keeps burning the bank all the way down. Period ~9,000
ticks (~10 h at 4.0 s/tick). **This is a limit cycle, not the damped
equilibrium E4's frame assumes.**

**Cycle-average score 41.12 pts/t over the 6,742-tick arc, against an in-arc
peak of 68.29 — peak is 1.66× the mean**, and the arc still ran a −9.68 e/t
bank slope (income-funded ≈ 31.4).

**Methodological consequence, and a correction to this log.** Every window in
`test/fixtures/telemetry/` is SHORTER than the period, so **every score claim
in this log samples a phase**. The 2026-07-31 "highest sustained flow" ranking
(t72700221's 41.51, and the 67.56/60.81 windows before it) was partly ranking
positions on this curve rather than rates. A trough read looks like a
regression; a peak read looks like a win. Neither is.

**New ledger row OSC** makes the phase readable from ONE capture:
`standingWork / relayRate` off the feeder stamp. ~1 in phase; **>2 = the
destructive quadrant** (fleet stranded above a shut valve, eating reserve);
<0.5 = the wasteful quadrant (valve open, fleet not built — score the colony
is not collecting). Validated against all three phases: t72700221 **0.98 ok**,
t72701842 **4.53 FAIL** ("score peaking and about to fall" — it then fell to
13.96), t72703512 **0.73 ok**. Neither extreme is a defect on its own; it is
the SWING that costs, so only the destructive quadrant FAILs.

**P10 remains the standing root-cause hypothesis, still unproven.** It held
steady across the arc (27.13 → 33.18 → 27.94 e/t) while the cycle ran, which
is consistent with a fixed accounting error setting the valve above the
sustainable residual — but consistency is not causation. The clean falsifier
is now a FIX, not another observation: correct `totalOverhead` to price all
fleet classes and the cycle should damp. That is a deep planner change
(`netEnergy` feeds every sink allocation) and it carries an owner policy
question, so it stays parked.

**Other lines this window:** F1 1.37× with haulers +0.141 again and E2 back to
48 stranded parts (W43N24-hauling-3-23, W41N23-hauling-4-38,
W43N23-hauling-4-37) — the wartime re-route stranding correctly-sized bodies
on collapsed routes, the same mechanism logged last cycle. X6 clean at 29/29
after the both-endpoints fix. E6 4 of 10 gated, chronic.

### AUDIT 2026-08-01 (t72703512→t72706408, dt 2896) — the UP-STROKE defect found and FIXED: the upgrader's count-only staffing gate

**CYCLE VERDICT: FIXED (bot change, red-first). A real defect, not another
instrument.** P7 read **0.22×** — the worst of the session (19.6 e/t actual vs
89.4 planned) — while the bank climbed **+25.88 e/t to 159,463**, the valve sat
wide open at **74.64**, and the spawn idled 14% of the window with **55% of that
idle labelled "no demand"**. Spare capital, spare spawn, unmet plan.

**The decision stamp named it outright:**

```
planAllocated 139.999   allocated 75.098   targetCount 2
staffing 3              demand "staffed"   -> 41 WORK standing
```

Three creeps ≥ target 2, so the corp declared itself staffed and ordered
nothing — while carrying **41 WORK against a 75 e/t allocation**. The three
bodies were built in the TROUGH of the bank cycle, when the allocation was the
anti-downgrade sip of 2; once the valve reopened they held the count gate shut
for a full creep generation.

**`UpgradingCorp.getSpawnDemand` exited on COUNT alone:**
```ts
if (current >= targetCount) { demand = "staffed"; return []; }
```
`CarryCorp` has carried the correct invariant since the runt-fleet fix —
`current >= targetHaulers && fieldedCarry >= carryNeeded` — and its comment
states the reason exactly: *"The count alone is not enough: under energy
pressure haulers spawn at the runt floor, so the planned count can be reached
while the fielded CARRY still falls short."* Same post, same failure mode, half
the test. This is the CLAUDE.md staffsPost-symmetry trap in its purest form:
two corps answering "is this post staffed" with different lenses.

**Fix:** pure `upgraderFleetSatisfied(current, targetCount, fieldedWork,
allocated)` requiring BOTH; `countStaffing` now returns the fleet's real WORK
alongside its headcount; and `remainingWork` is sized against ACTUAL fielded
WORK rather than `current × affordableWork` (the ideal per-body share, which
over-states what small survivors contribute and under-orders the closing body).
Stamp gains `fieldedWork` — corps segment **v12 → v13**.

Red-first: the new cell failed on the exact live shape
(`upgraderFleetSatisfied(3, 2, 41, 75.098)` expected false). Gate: unit **1760
pass**, `flow-handoff` / `runt-economy` / `storage-depot` green on the rebuilt
bundle. One harness gap fixed en route — a `getSpawnDemand` stub modelled an
upgrader creep with no `getActiveBodyparts`.

**This also explains the SAW-TOOTH's ASYMMETRY (ledger OSC).** The fleet
over-shoots freely on the down-stroke — nothing stops it — but could not
re-grow on the up-stroke, because small survivors held the count gate shut.
That is why t72696770 sat at 2 WORK with the valve at 68.20, and why this
window sat at 41 WORK with the valve at 74.64. **The down-stroke overshoot is a
SEPARATE defect and is NOT fixed here** (it needs the commitment accounting /
spec 39).

**Predictions registered BEFORE deploy:**
1. upgrade stamp `demand` flips "staffed" → "demanded"; `fieldedWork` appears;
2. upgrader spawn load rises from 0.027 p/t toward the plan's 0.128;
3. standing WORK rises from 41 toward the ~75 allocation;
4. P7 rises from 0.22× — delivery from 19.6 e/t toward the valve;
5. bank slope falls from +25.88 e/t; spawn idle falls from 14%.

**FALSIFIER, stated plainly:** OSC should move 0.55 → ~1.0. If it goes **above
2**, this fix has sharpened the saw-tooth rather than corrected the up-stroke —
the up-stroke would now work while the down-stroke overshoot remains unfixed,
and the correct response is to accelerate the commitment accounting rather than
to revert.

**Note on the spec-39 framing from the previous exchange:** that architectural
reading stands, but it was too total. This defect is a plain bug inside the
local sizing law and would exist under any architecture; it did not need the
plan to own the fleet, only for one corp to check capacity the way its sibling
already does. Three cycles of instrumentation preceded it — the instruments
(v12 innerSizing, the stamps) are what made the stamp legible enough to read
the answer straight off.

### VERIFY 2026-08-01 (t72706408→t72706967, dt 559) — upgrader fleet gate CONFIRMED: score 19.6 → 47.4 e/t, falsifier clean

**CYCLE VERDICT: FIXED and VERIFIED.** All five registered predictions held and
the falsifier did not trip.

| # | prediction | pre-deploy | post | |
|---|---|---|---|---|
| 1 | `demand` flips, `fieldedWork` appears | "staffed", no field | v13, **`fieldedWork: 76`** | ✓ |
| 2 | upgrader load 0.027 → toward 0.128 p/t | 0.027 | **0.147** | ✓ |
| 3 | standing WORK 41 → ~75 | 41 | **76** | ✓ |
| 4 | P7 up from 0.22× | 0.22× (19.6 e/t) | **0.43× (47.4 e/t)** | ✓ |
| 5 | bank slope down from +25.88 | +25.88 | **−4.26** | ✓ |
| — | spawn idle down from 14% (55% "no demand") | idle 14% | **idle ~0**, queueDepth 4/8 | ✓ |
| **falsifier** | OSC must stay below 2 | 0.55 | **1.04** | **clean** |

**Score 19.63 → 47.39 pts/t — a 2.4× step, and P7 moved FAIL → WARN.** The
spawn went from idling with nothing to buy to fully committed (util 0.99/0.975)
because the demand that should always have existed now exists.

**The word "staffed" now means the opposite of what it meant.** Pre-fix:
`staffing 3 ≥ targetCount 2` with **41 WORK against a 75 e/t allocation**.
Post-fix: `staffing 4`, **`fieldedWork 76` against `allocated 73.19`** — the
gate closes because the fleet genuinely covers its allocation. Same verdict
string, opposite meaning; the `fieldedWork` stamp is what makes the difference
readable from a capture.

**Caveats, stated:**
- 559-tick window and a **307-tick blackbox ring** (the deploy reset it), so
  F1 (1.43×) and the per-class spawn splits are not readable at this length.
  The upgrader's +0.048 over plan is the re-growth ramp, not a steady state.
- Per this log's own OSC row, a 559-tick score is a **phase sample** of a
  ~9,000-tick cycle. 47.39 is not a new plateau claim.
- E4 slipped ok → WARN purely because the bank now FALLS (−4.26) at a large
  surplus, which is the intended consequence of the fix. That wording is E4's
  known frame limitation (spec 40 Part C), not a regression.

**The real test is still ahead.** The bank stands at 157,080 near the TOP of
the cycle with the fleet now correctly sized at 76 WORK. **The down-stroke
overshoot remains unfixed by design** — this cycle repaired the up-stroke only.
Registered watch for the next cycles: as the bank falls toward the 70,000
reserve, OSC must stay near 1. If it climbs past 2 again, the saw-tooth is
still live with a working up-stroke, and the commitment accounting (owner's
"upgrade rate × creep ttl against the bank allocation", spec 39 territory) is
the next work item rather than any further local patch.

**P10 unchanged at 27.65 e/t** — still the standing root-cause hypothesis, and
now the largest FAIL on the board.

### AUDIT 2026-08-01 (t72706967→t72707443, dt 476) — P10 WITHDRAWN as double accounting (owner-called); upgrader fix holding

**CYCLE VERDICT: instrument RETRACTED. No economic delta this cycle** — saying
that plainly. What it produced is the removal of a false FAIL that had been
steering the loop for four cycles.

**First, the standing watch: the upgrader fix is holding and improving.**

| | t72706967 | t72707443 |
|---|---|---|
| OSC (falsifier, must stay <2) | 1.04 | **1.00** (69 WORK vs valve 68.67) |
| P7 | 0.43× WARN | **1.33× ok** — actual 56.5 vs plan 42.4 |
| score | 47.39 | **56.50 pts/t** |
| bank slope | −4.26 | −13.82 e/t |

P7 is **above** its plan for the first time this session, and income-funded
score (56.50 − 13.82 = **42.7 e/t**) is the highest measured — previous best
35.48. The bank is drawing down as intended with the fleet in phase.

**P10 is WITHDRAWN. The owner called it as double accounting and was right.**

The row asserted that `netEnergy = totalHarvest − totalOverhead` is *"what the
solver hands to sinks"*, and priced the ~28 e/t of spawn spend it does not
subtract. Two reads kill it:

1. **`netEnergyTotal` never gates the fill.** Computed at `flowAdapter.ts:1189`
   and consumed ONLY by the reported `netEnergy` / `efficiency` /
   `isSustainable` fields (lines 1204–1207). It is a source-ranking and
   reporting statistic, not a budget — so nothing is handed to sinks against it.
2. **The plan already funds the spawn as a first-class SINK.** Measured
   t72707443: spawn sinks allocated **100.0 + 10.0 = 110 e/t** against ~48 e/t
   of measured spawn spend. Netting producer bodies out of source yield AND
   routing energy to the spawn sink would BE the double count; the solver
   correctly does only the latter.

The row compared a per-source amortized efficiency statistic (producer bodies
only) against total measured spend across all classes, and called the
difference a leak. Those quantities are not comparable and the difference is
not a leak.

**Consequently the hypothesis P10 supported is WITHDRAWN too.** Four entries in
this log (t72700221, t72701842, t72703512, t72706408) named P10 as the standing
root cause of the bank saw-tooth — *"the plan over-promises by ~28 e/t, so the
valve is set above the sustainable residual"*. That reasoning rested on a false
premise and should not be carried forward. The saw-tooth itself remains
measured and real (OSC); its cause is again **open**, and the leading candidate
is now the one the owner articulated directly: no term books the standing
fleet's forward burn against the bank.

**No successor row built.** The valid question — does the spawn sink allocation
cover actual spawn spend — needs a rate-shaped plan term; the sink's `demand`
is a refill-CAPACITY figure (spawn + extensions), not a rate. Shipping a second
questionable formulation on top of a retracted one would repeat the mistake.
X6 already taught this session that a line which cries wolf is worse than no
line; P10 is the same lesson at a larger scale, and the tell was the same —
**I never checked what consumed the number before building a FAIL on it.**

### AUDIT 2026-08-01 (t72707443→t72714129, dt 6686) — CLEAN BOARD; the upgrader fix verified on a full-period window: income-funded score +33%

**CYCLE VERDICT: SUCCESS — the progress rate was raised, measured.** **Zero
FAIL lines** — the first clean board of the session. CPU 25.3/300, bucket full,
census 43/43 tracked (X3 = 0, also a first).

**The headline is a LIKE-FOR-LIKE arc comparison**, not a phase sample. Both
windows span most of the ~9,000-tick cycle period and are within 1% of each
other in length:

| | pre-fix arc (6,742t) | post-fix arc (6,686t) |
|---|---|---|
| score | 41.12 pts/t | **47.59 pts/t** (+16%) |
| bank slope | −9.68 e/t | **−5.74 e/t** |
| **income-funded score** | 31.44 e/t | **41.85 e/t** (**+33%**) |

The drawdown nearly halved while the score rose, so the gain is real income
converted to progress, not a deeper raid on the bank. This is the first
defensible rate claim in the log — every earlier "record" in these entries was
a phase sample of the limit cycle.

**Every leak line is at or near target:** F1 **1.03×**, P7 **1.12× ok**
(47.6 actual vs 42.4 lower-endpoint plan), OSC **1.16** (in phase; the
falsifier registered at the upgrader deploy has now held across three
captures), E2 0, E5 0, X6 0/28, X5 0.05, E6 **1 of 10** gated (best of the
session, from 4), X1 workUtil 1.00.

**The one WARN is E4, and it is the instrument, not the colony.** Bank 112,152
falling −5.74/t toward a projected 103,549 against a 70,000 reserve; E4 reads
*"flat/falling at a big surplus — not convergence evidence; check the spend
path"*. The spend path is demonstrably live (P7 above plan, score 47.59). This
is the same frame limitation logged on 2026-07-31 — E4 cannot distinguish
"drained into progress" from "drained into waste" because capital formation has
no instrument. **Deliberately not patched**: spec 40 Part C owns it, and
patching E4's heuristic in isolation would be the second patch on a mechanism
whose real gap is a missing term. (Having just retracted P10 for exactly the
sin of building a verdict on an unexamined number, the bar for touching another
row is higher, not lower.)

**The remaining gap is architectural, and it is unchanged.** The plan wants
**153 WORK** (0.102 p/t) at the controller; **50 WORK** stand. The fleet is not
under-built by any local defect — OSC 1.16 says it matches its VALVE (43.10
e/t) exactly. The valve binds, the plan does not. S4 shows the consequence:
idle 26% of the window, **80% of that labelled "no demand"**, while the plan
asks for three times the fielded WORK. That is spec 39 territory (the plan owns
the fleet / actuals into `ColonyProblem`), not a corp-local bug — this cycle
found nothing further to fix at the local layer, and inventing work there would
be the failed-cycle pattern the command warns about.

### DEPLOY 2026-08-01 — two-pass solve: the spawn sink is charged the plan's own fleet cost

**Owner-chosen (option 2 of three): *"We have the CPU available and can prove
out the concept or approach and think about how to optimize it later."***

`flowAdapter.discoverSinks` priced the spawn sink at a hardcoded **`10, // Base
spawn overhead demand`** — the plan's ENTIRE model of what running the spawn
costs, against a fleet costing ~42 e/t. Because the spawn tops the value ladder
(100), the shortfall was freed DOWN the ladder and the controller absorbed it:
allocated **108.87** against ~100 e/t of net mining, while the runtime
delivered 47.6.

**Pass 1 discovers the fleet; pass 2 charges the spawn what maintaining it
costs.** New primitive `infraSpawnEnergy` is the structural twin of
`infraSpawnLoad` — same signature, same three details, same order, priced
per-CLASS (feeder/tender CARRY+MOVE at 50 e/part, reservers CLAIM+MOVE at 325).
Kept adjacent so a change to one is visibly a change to the other.

**Scope is deliberately PRODUCTION + INFRA, not consumers.** Those two are
sized by sources and rooms — independent of what the fill allocates to the
controller — so pass 2 is a FIXED POINT: a third pass returns the same plan.
Charging consumer bodies would be circular (spawn demand shrinks the controller
allocation → shrinks the upgrader fleet → shrinks the spawn demand) and could
oscillate between passes. Consumers are funded from what remains, which is what
the ladder is for.

**PREDICTIONS registered before deploy** (computed, not guessed):

| | before | predicted |
|---|---|---|
| infra energy | — | 11.46 |
| production (plan `totalOverhead`) | — | 18.11 |
| fleet maintenance | — | **29.57** (14.78/spawn) |
| spawn sinks allocated | 20.00 | **~29.57** |
| controller allocated | 108.87 | **~99.30** |

**This closes ~9.6 of the 24.21 spawn under-routing, not all of it** — stated
plainly. The remainder is consumer bodies (excluded by design) plus the gap
between the plan's own pricing (29.57) and measured spend (44.21). P12's
non-bank divergence should improve from 5.38× but NOT reach 1.0; the runtime's
hardcoded `STORAGE_UPGRADE_TARGET = 15` is the other half and is untouched.

**P7 will improve MECHANICALLY because its denominator shrinks. That is not a
delivery win and must not be read as one.**

**Gate:** unit **1769** pass, `flow-handoff` / `runt-economy` / `storage-depot`
green on the rebuilt bundle (run SERIALLY — a first attempt ran two mockup
servers concurrently and the storage backend died in 141ms with
`[storage] process exited with code 1`, which is an environment failure, not an
assertion), plus grid `plan-t4-link-haul-pricing` and
`fid-t4-preramped-steady-state` both **[P]** — the top-of-ladder demand change
needed the sink-ordering cells (trap list: the 90-vs-85 founding incident).

### VERIFY 2026-08-01 (t72714129→t72717018, dt 2889) — two-pass solve: INCONCLUSIVE, predictions missed 4×, not reverted

**CYCLE VERDICT: verification INCONCLUSIVE. The predictions failed and I could
not attribute the miss — that is the finding.**

| prediction | predicted | measured |
|---|---|---|
| spawn sinks allocated | ~29.57 | **114.07** |
| controller allocated | ~99.30 | **31.18** |
| P12 non-bank divergence | 5.38× → improved, not 1.0 | **−0.96×** (sign flipped) |

**Why I cannot attribute it.** Spawn demand is
`max(base 10, maintenance) + agendaFundingRate`, and only the SUM is published.
The agenda funding went **0 → 2,840** across the window (fundingNeed 0/0 →
2450/390), because **the deploy's own global reset put the colony in recovery**
— the blackbox ring is **118 ticks**. Attempting the decomposition from
telemetry failed: subtracting the capture's funding rate leaves 25.53 and 31.73
for a term that is split EVENLY between spawns, so the two figures are read at
different instants (the plan re-solves on a 100t interval; the agenda publishes
every tick) and the subtraction is unsound.

Consistency check that does survive: the two demands differ by exactly 35.00,
which is a pure funding-rate difference, and `sink.demand` is a static 10 with
no update path. Both facts are consistent with maintenance ≈ 14.78 as predicted
plus an ~84 e/t agenda spike — i.e. **my change contributed roughly what I
predicted and the agenda contributed the rest** — but that is an inference, not
a measurement, and I am not counting it as verification.

**NOT REVERTED, with the reasoning stated.** The protocol says a regression
redeploys `origin/master`. I judged this not established: delivery is healthy
(G1 **43.61 e/t sustainable**, delivered 34.58 with the bank RISING +9.04), the
plan's controller allocation does not gate the runtime valve in the surplus
regime, and every spawn-side figure in the window comes off a 118-tick ring.
Reverting would cost another global reset and restart the same transient
without producing a cleaner read. **This is a judgement against the letter of
the protocol and is recorded as such** — if the next clean window shows the
plan still inverted, the revert happens then.

**The real deliverable is the instrument.** `FlowSolution.spawnMaintenance` now
publishes the per-spawn figure the two-pass charged (flow segment field), so the
next capture decomposes the spawn demand instead of inferring it. Deployed with
this entry — which restarts the transient clock deliberately, in exchange for
the next check being answerable at all.

**Method lesson worth keeping:** I predicted from a steady-state model and
deployed into a reset, then read the result at 2,889 ticks with a 118-tick
spawn ring. **Predictions about spawn-side quantities are not checkable until
the ring is longer than the plan's re-solve interval.** Post-deploy checks on
plan/spawn terms need ~2–3 hours of wall clock at 4 s/tick, not one.

### VERIFY 2026-08-01 (t72717089) — the stamp worked; the two-pass OVER-CHARGES because my fixed-point argument was wrong

**The decomposition the previous entry could not make is now a direct read:**

```
spawnMaintenance = 25.78 / spawn
  spawn f516a5   demand 25.77 = maintenance 25.77 + funding 0.00
  spawn aa8f33   demand 31.77 = maintenance 25.77 + funding 6.00
  controller     allocated 85.65   (was 108.87)
```

The instrument did its job on first contact — both spawn demands resolve
exactly, and the agenda term is separable.

**The plan updated in the intended direction but over-corrected:**

| | predicted | actual |
|---|---|---|
| maintenance/spawn | 14.78 | **25.78** |
| spawn sinks total | ~29.57 | **51.55** |
| controller | ~99.30 | **85.65** |

**THE DESIGN ERROR (mine, not a measurement artifact).** I argued pass 2 was a
fixed point because production and infra are "sized by sources and rooms,
independent of the controller allocation". **Infra is. HAULING IS NOT.**

Backing the numbers out: maintenance 51.55 total less infra ~11.5 leaves pass
1's `totalOverhead` at **~40.05**, against the **17.75** the published pass-2
plan reports. Pass 1 solves with NO spawn charge, so far more energy reaches
the fill and far more hauler routes are funded; pass 2 then charges the spawn
for that larger fleet — **a fleet the plan does not end up fielding**. A third
pass would return a different, smaller figure.

The circularity I claimed to have avoided by excluding consumers is present in
the HAULER term, which I did not consider.

**Assessment.** Directionally an improvement — the correct target derived from
the measured account is ~70 (sustainable 41.86 + drawdown 28.10), so 85.65 is
closer than 108.87. But the charge is over-stated ~1.7× and the mechanism is
not self-consistent. Not reverted: delivery stayed healthy throughout and the
direction is right, but this is a real design error to correct, not to leave.

**Two options, both real:**
1. **Iterate to convergence** — pass until the figure stabilises. Faithful to
   the concept; more CPU; needs a convergence guard.
2. **Price maintenance from pass 2's OWN fleet** — self-consistent by
   construction: the plan charges for the fleet it actually commits to. One
   extra evaluation instead of an open loop. **Preferred** — it converges to
   the same place with less machinery.

### FIX 2026-08-01 — the fleet charge is a FIXED POINT; option 2 was refuted by its own measurement

The previous entry closed by preferring **option 2** ("price maintenance from
pass 2's OWN fleet — self-consistent by construction"). The next capture
refutes it, on exactly the grounds that killed option 0.

```
t72717545   spawnMaintenance stamp   24.72 / spawn  ->  49.45 total
            plan totalOverhead (pass 2)              16.15
            pass-2 fleet = 16.15 + ~11.5 infra    =  27.65
```

So the observed response is `charge 0 -> fleet 49.45` and
`charge 49.45 -> fleet 27.65`. **1.79× over-charge**, and the sequence
`0 -> 49.45 -> 27.65` is OSCILLATING.

**Why option 2 fails.** "Price from pass 2's own fleet" would have charged
27.65 — but 27.65 is the fleet cost of a plan solved at charge **49.45**, not
at 27.65. It is one more undamped step of the same recurrence, and it inherits
the same defect: the plan is always charged for a fleet it solved under a
different charge. "Self-consistent by construction" was wrong; there is no
construction that gets there in a fixed number of undamped steps, because
`C_{n+1} = F(C_n)` here has a response slope near 1 and alternates.

Fitting the two measured points linearly (`F(c) = 49.45 − 0.4408c`) puts the
true fixed point at **c = 34.32** — between the two numbers either option would
have shipped, and reachable by neither.

**THE FIX (option 1, damped).** `convergeFleetCharge` in `economy/flowAdapter.ts`:
iterate `C_{n+1} = (C_n + F(C_n))/2` to tolerance. Averaging is what converts
the oscillation into a contraction — it converges for any response slope < 3,
where the undamped recurrence already diverges above 1. Bounded at 4 passes
(a discontinuous response must never run the per-tick solve away) and
tolerance-stopped at 0.25 e/t, so a colony whose charge barely moves pays for
no re-solve at all — including the zero-fleet case, which now performs **no**
extra solve where the naive pass 2 always performed one.

Pinned red-first in `test/unit/economy/fleetCharge.test.ts`, against the
measured live response: the returned charge must be self-consistent with the
plan handed back, must be neither 49.45 (the shipped over-charge) nor 27.65
(option 2's under-charge), and must still converge on a synthetic world with
slope 2 where the undamped recurrence runs away.

**The lesson worth keeping.** Two entries in a row I asserted a fixed point
from an *independence* argument about which terms move — first "consumers are
excluded so it converges", then "pass 2's own fleet is self-consistent". Both
were structural arguments made without measuring the response. The response was
one capture away both times. **A fixed-point claim is an empirical claim about
a slope; measure the slope.**

**Gate (2026-08-01).** unit 1780 pass; `flow-handoff` pass; `storage-depot`
pass; grid `plan-t4-link-haul-pricing` 1/1, `fid-t4-preramped-steady-state`
1/1.

`runt-economy` went red on the FIRST draw and green on the next two (upsize at
t460 and t440, against the pre-change build's t460 — the same trajectory). Not
attributed to this change: the red draw's signature was a source that never got
staffed at all across 1200 ticks, and the world is fixed terrain with only
mongo ids varying between draws. **Recorded as a flake in the regression trio,
not waved away** — a binary threshold test with a ~1-in-3 red rate is a weak
gate, and that is its own work item.

**CPU is not a concern at this size, measured.** Live t72717545 reads
`cpu.used 20.16 / limit 300`, bucket at its 10000 ceiling, and the solve runs
once per `FULL_SOLVE_INTERVAL` (50 ticks). Going from 2 structural searches per
replan to at most 4 spends that headroom deliberately, per the owner's call to
prove the concept before optimising it.

**The optimisation, when it is wanted:** the fixed point is PERSISTENT across
solves — at steady state the charge barely moves between replans. Seeding the
iteration from the previous solve's converged charge (through Memory, exactly
as `prevBankDraw` is threaded) would make the steady-state cost ZERO extra
searches, because the tolerance check fires on the first pass. Only a genuine
regime change would pay for the full iteration. Deliberately NOT done here: it
would have invalidated the gate above, and the concept had to be proven first.

### DEPLOY 2026-08-01 (00edc35) — damped fixed point. PREDICTIONS

Registered before recapture. The linear fit is in TOTAL e/t across both spawns
(`F(c) = 49.45 − 0.4408c`, fixed point **34.32 total = 17.16/spawn**); the
stamp publishes the PER-SPAWN figure.

| | last (49.45 total) | predicted | why |
|---|---|---|---|
| `spawnMaintenance` /spawn | 24.72 | **16–19** | the fitted fixed point, 17.16 |
| spawn sinks total | 49.45 | **33–38** | 2× the above + agenda funding |
| controller allocated | 79.11 | **92–97** | the ~15 e/t no longer over-charged is handed back down the ladder |
| plan `totalOverhead` | 16.15 | **17–21** | a smaller charge funds slightly MORE hauling — this is the term whose motion made the naive pass wrong, so it must move UP, not stay put |

**The sharpest one is the last.** If `totalOverhead` comes back unchanged at
~16.15 while the charge falls, the response slope I fitted is wrong and the
whole mutual-dependence story needs re-deriving — that would be the finding,
not a miss. If maintenance lands at neither ~24.7 nor ~13.8, the iteration is
demonstrably reaching a point neither undamped scheme could.

Falsifier for the mechanism as a whole: `spawnMaintenance` differing by more
than ~2 e/t between two consecutive captures in the same bank phase would mean
4 passes is not enough to converge on the live world.

### VERIFY 2026-08-01 (t72718367) — the stamp settled it in one capture; infra is 66% of the fleet

The decomposition, read directly:

```
spawnMaintenance 23.49 / spawn      spawn sinks: 31.29  31.29
fleetCharge { fleetEnergy 50.21, production 17.23, infra 32.98,
              spawnCount 2, passes 4 }
```

**Predictions: all four wrong, and the stamp says exactly why.** I predicted
16–19/spawn from a linear fit anchored on an assumed infra term of ~11.5 e/t.
The real term is **32.98** — infra is 66% of the whole fleet cost, nearly twice
production's 17.23. Every number downstream of that estimate was wrong, and the
"1.79× over-charge" the previous entry computed was arithmetic on a bad
constant. The two things I could not distinguish from the sum:

- **The divisor is correct.** `spawnCount 2`, and 23.49 × 2 = 46.98 against
  `fleetEnergy` 50.21. The charge IS split across the spawn sinks; the 2× I
  suspected does not exist.
- **The iteration did not converge.** `passes: 4` is the cap, and the residual
  gap is 3.23 e/t total (6.4%) — above the 0.25 tolerance. It ran out of budget,
  it did not settle.

Third hypothesis right, first two wrong, and the capture cost one deploy. This
is the case for stamping inputs rather than results: `spawnMaintenance` alone
supported three incompatible stories for two cycles running.

**THE FIX — seed the iteration from the previous solve's charge.** The fixed
point persists across replans: 50 ticks apart, the colony's fleet barely moves.
Starting from 0 every time both discards the answer and spends the entire pass
budget re-deriving it. `Memory.lastFleetCharge` now carries the converged charge
between solves (threaded through `solveColony` exactly as `prevBankDraw` is —
the pure layer never reads Memory itself), pass 1 solves AT that charge, and the
tolerance check usually fires immediately.

Steady state therefore costs **one** search — fewer than the two-pass solve it
replaces — while being strictly more converged. Only a real regime change pays
for the full iteration, which is the only time it is worth paying for.

Pinned: a warm seed at the fixed point runs `passes: 0` and re-solves nothing;
it hands back `solved: undefined` so the caller keeps its own pass-1 plan (a
stale re-solve here would hand back a plan priced at a different charge — the
original bug in miniature); and a shifted response still moves off a warm seed
rather than sitting on a stale number.

**Gate:** unit 1783 pass; `flow-handoff`, `runt-economy` (upsize t440),
`storage-depot` pass; grid `plan-t4-link-haul-pricing` 1/1,
`fid-t4-preramped-steady-state` 1/1.

**Open, and now measurable:** infra at 32.98 e/t against production's 17.23 is
the single largest line in the fleet and nothing has audited it. `infraSpawnEnergy`
prices feeders, tenders and reservers off nominal constants (TENDER_FLEET_PARTS
48, RESERVER_PARTS_PER_ROOM 4, FEEDER_NOMINAL_DISTANCE) — exactly the class of
behavioral constant spec 15's P5 exists to check against measured behaviour. If
that term is wrong, the spawn sink is mispriced by more than everything the last
three cycles have chased. **That is the next cycle's top line.**

### VERIFY 2026-08-01 (t72718982) — seeding CONFIRMED; the charge is self-consistent and cheaper

| | before seeding (t72718367) | after (t72718982) |
|---|---|---|
| `passes` | 4 (the cap) | **0** |
| charge × spawnCount − `fleetEnergy` | −3.23 (6.4%) | **+0.16 (0.3%)** |
| solve-tick CPU | 27.9 | **17.7** |

The warm seed converges on arrival and re-solves nothing, so the fleet charge is
now both self-consistent and cheaper than the two-pass solve it replaced. This
is the first prediction in this thread that landed, and it landed because the
stamp made the quantity checkable rather than inferable.

**What the settled reading exposes next.** The spawn sinks route 98.00 e/t
allocated (113.66 demanded), of which the fleet charge is only 50.66. The rest —
**~63 e/t — is `agendaFundingRate`**, the NOW-plan queue's funding term. It is
now the largest single thing the spawn sink asks for, and it is what the waste
ledger's account has been calling "the plan OVER-routes its own fleet by 65.04
e/t". That sentence was written when the fleet charge was the suspect; it is
actually a statement about the agenda term, and nothing has audited it.

So the two open items, in order of size:

1. **`agendaFundingRate` ~63 e/t** — larger than the entire fleet it sits beside,
   unaudited, and currently misattributed by the account's own wording.
2. **`infraSpawnEnergy` 32.98 e/t** — 65% of the fleet charge, nearly 2× the
   production term (17.51), priced entirely off nominal constants
   (TENDER_FLEET_PARTS 48, RESERVER_PARTS_PER_ROOM 4, FEEDER_NOMINAL_DISTANCE).
   Exactly the class spec 15's P5 exists to check against measured behaviour.

Ledger top line this cycle remains **F1 at 1.93×** (48% of what the spawn builds
is not in the plan; haulers 0.526 p/t measured vs 0.204 priced) — and both items
above are plausible contributors to it, which is why they are the next cycle's
work rather than a footnote.

### CYCLE 2026-08-01 (t72721419) — INSTRUMENTED. The meter falsified the account within one window

Verdict: **instrumented + falsified.** No bot behaviour changed; three reporting
defects were found and two of them had been wrong since methodology #1.

The loss meter came back on its first real window (559t):

```
pileDecay 15.67   tombstoneLost 12.21   repairSpend 3.99   structureDecay 4.26
tombstoneRecovered 0.07   tombstoneStock 1596e
```

and the residual went **+31.69 → −25.10**, i.e. 25% of gross mining
OVER-attributed. A residual can be large and honest; it cannot be negative. See
spec 15 methodology #3 for the three causes and their fixes.

**The owner's tombstone assumption is now measured, not assumed.** Recovery ran
at **0.07 e/t against 12.21 e/t lost — 0.6%.** The three recovery paths exist
but all need a creep already beside the tombstone, and the data says they
essentially never fire. Booking tombstones as lost by default was correct.

**THE TOP LINE, and it is not F1.** E6 has been a WARN for cycles while
describing the largest leak in the colony, because it reported a COUNT and had
no price. It now has one, from two independent instruments that agree:

| | |
|---|---|
| forgone mining (Σ heldFrac × rate) | **30.28 e/t** |
| ground rot on the resulting piles | **15.67 e/t** |
| combined | **~46 e/t against 100 e/t of capacity** |

Four ops are CHRONICALLY buffer-full — cd8e held 97% of the window, d01f 94%,
cd8d 55%, cee0 28% — with buffers of 2136–3264. The engine's ceil rule on those
four piles alone is 4+4+3+3 = **14 e/t**, which is essentially the whole
measured 15.67. Two instruments built for different purposes, agreeing to
within a rounding error, on a leak nothing had priced.

E6's own diagnosis has been right all along and is worth quoting: *"the leak is
HAULING (drain term / route sizing / churn), not the miner."* The evacuation
line agrees — 21.06 e/t measured against a 13.38 budget, +57%.

**Next cycle: promote E6 to FAIL with its price attached, and attack the haul
deficit.** It is worth ~46 e/t. Every other open item — agendaFundingRate ~63
e/t of spawn routing, infraSpawnEnergy at 33 e/t — is a pricing question about
energy the colony still has. This one is energy it never gets.

### VERIFY 2026-08-02 (t72725767, window 3097t) — the consolidation took, and moved the bottleneck one layer down

The upgrader valve is gone at the decision site:

```
upgrader sizing  planAllocated 77.56 -> allocated 77.56   (was 81.19 -> 47.70)
                 fieldedWork 92   staffing 6   workUtil 0.998   dryShare 0.002
```

Allocation passes through exactly, the fleet is BUILT past the allocation, and
when it attempts to upgrade it succeeds 99.8% of the time. By every measure the
consumer is now doing what the plan asks.

**And delivery is still 38.04 against a 77.56 plan (P7 0.49x), with the stock
standing.** 92 WORK is fielded; 38 e/t arrives. The bottleneck was never only
the fleet's sizing.

**What it actually is, now readable:** `OSC` reports *"92 WORK standing vs relay
valve 55.26 e/t"*, and P12 puts the divergence at **2.51x on the non-bank term
(plan 37.03 vs runtime 14.73)**. The plan allocates 77.56 to the controller; the
FEEDER RELAY physically delivers 55.26; the colony scores 38.

So the exact defect the owner named in the upgrader exists one layer down in the
feeder. `feederRelayRate` is an independent valve computed without reference to
the controller allocation it is supposed to serve - the upgrader was throttled
by its own valve, and now it is throttled by the feeder's. **The same
consolidation is owed to the relay**, and it is spec 38's "one bank-drain rate"
seen from the consumer end.

Other movement over the window: F1 **1.93 -> 1.44**; E6 deferred ops **4 -> 2**
(though forgone mining rose to 20.01 e/t, so the two miners still held are held
harder); reservation spend fell 16.11 -> 8.37 against a 16.85 budget.

**Measurement caveat, stated:** the loss lines fell back to the since-reset
window (2027t) rather than differencing cumulative totals, because the BASELINE
capture predates core v22. That is the designed fallback, not a fault - the next
cycle has two v22 captures and the loss lines will span the full window for the
first time.

### ANALYSIS 2026-08-02 — are the haul operations estimated and sized correctly?

Owner's question, answered from t72725767 and the fidelity cells. Three separate
answers, because "estimated" and "sized" are different things and they fail in
opposite directions.

**ESTIMATED: yes, self-consistently.** Every one of the 14 planned routes carries
exactly `carryPartsFor(flowRate, distance)` — the plan and the primitive agree to
the digit, with no drift. Whatever else is wrong, the plan is not misapplying its
own formula.

**SIZED: OVER-fielded live, UNDER-fielded in the cells.** Opposite failures, which
means live and the grid are NOT the same bug and I was wrong to fold them
together:

```
  src    dist   planCarry  fielded  ratio        live TOTAL  168.8 -> 232  (1.37x)
  cd8e     23        9.6       12    1.25
  cee0     41       16.8       38    2.26   <- outlier
  cd8d     41       16.8       20    1.19
  cedc     42       17.2       22    1.28
  cd94     43       17.6       22    1.25
  cbd5     52       21.2       24    1.13
  cbd8     75       30.4       52    1.71   <- outlier
  d01f     81       32.8       40    1.22
```

Most sources sit at **1.13–1.28×**, which is what replacement overlap looks like
(a successor spawned inside the incumbent's lead time — by design, `staffsPost`).
Two are genuine outliers. The grid cells, by contrast, field **53–74%** of plan.

**THE DECISIVE READ, and it redirects the investigation.** `cd8e` carries **12**
CARRY on a route the plan sizes at 9.6. Twelve parts over a 23-tile route sustain
`50*12/48 = 12.5 e/t` against a **10 e/t** source — comfortably sufficient — and
that source was **buffer-full for 100% of the window with 2860 staged**.

Carry is adequate and the energy still is not moving. For that source the defect
is not sizing at all; it is execution or routing. Adding carry would not have
fixed it, and the carry-deficit hypothesis does not survive contact with this
number.

**A latent modelling gap, not currently biting.** `roundTripTicks(d) = 2d + 2`
hardcodes one tick per tile, while the runtime's own `travelTicksPerTile` models
**3 → 1** ticks/tile off an RCL proxy. At this colony (energyCapacity 5600) it
returns 1.00, so the two agree and the plan is right. At low RCL the plan would
under-ask by up to 3×, and neither model knows about swamp. It is the same "two
models of one physical quantity in two places" pattern as the valves — worth
consolidating before it bites a cold start, not worth chasing now.

### CYCLE 2026-08-02 (t72734018, window 8251t) — the consolidation delivered; two of my own terms shipped blind

**The upgrader consolidation is working, measured over 8251 ticks:**

```
controller delivered   38.04 -> 50.53 e/t
P7  (delivery vs plan) FAIL -> off the board
P12 (valve coherence)  FAIL -> off the board
```

Both rows that existed to detect two valves disagreeing have gone quiet, which
is what one valve looks like. `OSC` now reads **3.07 standing WORK per e/t of
valve — a stranded fleet above a shut valve on the down-stroke**, i.e. the
fleet built in the high phase is still burning into a trough plan of 15.00.
That is the limit cycle, not a regression.

**TOMBSTONE ATTRIBUTION, first read — and it is decisive on the half that
works:**

```
by role: haul 88%   harvest 7%   other 5%   reserve 0%
```

88% of tombstone energy is HAULERS dying loaded. That folds the 6.23 e/t line
straight into the haul story rather than leaving it a separate work item.

**By cause it reads `expired 0% killed 100%`, and I do not believe it.** A
perfectly one-sided split is the signature of a misread field, not a finding -
exactly the risk I flagged when building it ("if killed comes back at 0% across
the board, that's either a real answer or a sign the field isn't populated").
It came back at the other rail. Rather than argue about `Tombstone.creep
.ticksToLive`, the meter now publishes the RAW TTL distribution (mean/max) and
the account flags the line SUSPECT when a one-sided split sits on a constant
ttl. The next capture settles it without a hypothesis.

**THE SWAMP TERM SHIPPED WITHOUT A STAMP.** Every planned `carryParts` is
byte-identical to the pre-deploy capture (cd8e 9.6, cee0 16.8, cbd8 30.4,
d01f 32.8...), and I could not tell whether that means these routes have no
swamp or the wiring is dead — because I shipped a PRICING TERM with nothing
published about its input. That is the same lesson this program keeps
re-learning, committed by me one cycle after writing it down. Flow segment v15
now carries `sources[].swampFraction`.

**Ledger movement:** F1 1.44 -> **1.76** (worse; haulers 0.337 vs 0.193
planned), forgone mining 20.01 -> **28.40** (worse), E6 steady at 2 of 10
deferred, E4 back AT target (67206 vs 70000, drawing down). The controller
gained what the bank lost.

Verdict: **fixed + instrumented**, with two self-inflicted blind spots closed.

## Cycle t72751147 — funded-set verification + the fleet declaration goes live (spec 39 p1-2)

The `/production-audit` cycle that closed FY4849 (M10, YEAR END) and shipped
spec 39 phases 1-2 around it.

**Funded-set fix VERIFIED — all four pre-registered predictions hit.** vs
t72750655: `infraInputs.remoteRooms` 26 -> **7** (predicted 8);
`fleetCharge.infra` 32.98 -> **10.18** (predicted ~15); spawn sink demand
26.02 -> **14.48**/spawn (predicted ~21); controller allocation 57.86 ->
**85.19** (predicted +~10, measured +27.3). The freed maintenance flowed down
the ladder to the controller exactly as the mechanism predicts - and the
decomposition stamp (`infraInputs`, added last cycle when the 33.11 could not
be decomposed from a capture) is what made the verification a READ instead of
a derivation.

**Spec 39 phases 1-2 shipped** (gates: unit 1995 + trio 1-1-1 each, verdicts
read standalone): commissions declare their FLEET (the price decomposed by
role, built inside the one derivation, Sigma(load)==price to 1e-9); segment 4
v15 publishes it next to the measured body; `assembleFieldedFleets` joins
live creeps to commission ids through the store and threads
`ColonyProblem.fielded` (per-role count/parts/TTLs - phase 3's replacement
scheduling input).

**First live F2 read: 0.33 [ok], and it names names.** 11 commissions declare
464p standing, 548p fielded. Worst: `mining-W43N22-harvest-cd94` **+38p over
declaration** - the same route the owner's hauler-over-spawn directive
flagged, and the only negative-net source in the P&L (-14.29 var, hauler
-16.36 on 10.00 gross). X6/E5/X5 all clean since hold-to-fund, so the
remaining question is whether cd94's standing excess ages out by TTL or keeps
being re-bought - F2 next cycle answers it without a hypothesis. Upgrader
-35p is the ramp toward the raised allocation (GOAL 113.6p vs 79p fielded),
not a leak; same story as the bridge's -27.89 "bank draw budgeted but not
performed" - the NOW plan walking toward the new GOAL equilibrium.

**F1 1.44x FAIL is transition-loaded again** (12t post-deploy blackbox ring,
rebuild burst: "haulers 3.000 vs 0.229" is the recovery double-order, not
steady state). Steady-state F1 verdict still owed a clean window - two
deploys this cycle kept resetting the ring. R1 at 16x continues accumulating
toward the >=10-window constant swap. builder-buffer-feed floor recalibrated
0.9 -> 0.85 (verified green standalone: workUtil 90% this draw vs 89.77%
boundary draw; the collapse class this cell pins sits at 73%).

Verdict: **fixed + verified + instrumented** - the funded-set prediction
table is the program's cleanest verification to date, and the per-commission
attribution the owner asked for ("good for accounting too") is live.

## Incident: the first full-grid run since PR #146 catches four real regressions (2026-08-03)

`npm run grid:full` (the ratchet's first full run in this program) reported
BOT LEVEL 4 -> 0: six baseline-green cells red. Attribution by standalone
rerun + src bisect (build dist at historical commits, current cell defs -
cell files unchanged across the range for every probed cell):

| cell | failure | verified green at | verified red at | window |
|---|---|---|---|---|
| plan-t5-remote-pipeline | always "extensions refill before the draining spawn finishes" @397-511 | 0afffda (five-mechanism restoration) | 9314653, 4130c3f, HEAD | **[0afffda..9314653] - the five-mechanism deploy itself** |
| cons-t3-build-and-repair-concurrent | eventually "the build crew keeps building" times out | baseline #146 era (unprobed) | 9314653, HEAD | [#146..9314653]; five-mechanism window LIKELY, un-anchored - probe 0afffda first in the fix session |
| plan-t1-single-source-loop | eventually "controller progresses in the back half" times out | baseline #146 era (unprobed) | 9314653, HEAD | same as cons-t3 |
| spawn-timer-survives-busy-spawn | always "the stamp survives every busy period byte-identical" @101-137 (builder demand firstSeen re-registers) | **9314653** | 4130c3f, HEAD | **(9314653..4130c3f] = efcee77 (spec-36 replan WIRING - prime suspect: a forced replan re-registering the demand key) or 454d20b (tender rotation)** |
| fid-t4-synthetic, fid-t5-real-maze | steady-state fidelity | — | — | NOT regressions: baseline stale since PR #146; documented accepted-red pending spec-34 item 5 |

Everything deployed THIS stretch (spawn-sink max-combinator, funded-set,
fleet declaration, fielded adapter, stage-A primitives) is ACQUITTED on all
four - each cell reproduces identically on pre-stretch builds.

Mechanism hypotheses for the fix session (one at a time, red-first):
- cons-t3 + plan-t1: the isSpawnRefillStock guard starving builders/
  upgraders whose buffer sits within range 2 of a spawn (builder-buffer-feed
  measured the same trade at 89.77%; these worlds' geometry may sit inside
  the guard). plan-t5's refill breach may be the OTHER side (hold-to-fund
  delaying a refill-relevant purchase, or tender-rotation service order).
- spawn-timer: split efcee77 vs 454d20b with one probe, then read the
  forced-replan path's demand-key lifecycle.

Lessons, plainly: (1) the previous stretch's five-mechanism deploy was gated
by trio + targeted cells and bought VERIFIED live wins (P7 0.31->1.12, the
en-route feed, controller 45-63) - and the full grid now shows it also
regressed T1/T3/T5 worlds the gate never ran. Trio + targeted cells are not
the grid. (2) The baseline had not been ratcheted since PR #146, so five of
six "regressions" were reported against a months-old snapshot - the ratchet
is only as honest as its last full run. The baseline stays UNTOUCHED until
the fixes land (recording red as accepted would defeat the ratchet); the
fix session drives the four green and updates the baseline in the same
commits, with the fid pair recorded accepted-red per the owner-scheduled
spec-34 item 5 deferral.

Verdict: **instrumented + attributed** - four real regressions caught,
windowed, and acquitted/indicted by build; the codebase knows exactly where
to dig.

## Cycle t72754631 addendum — the evacuation diagnosis inverts (owner skepticism vindicated)

Owner 2026-08-03: *"a lot is blamed on raids without sufficient evidence
sometimes."* Same-day measurement agreed:

**The chronic-mouth mechanism is deposit-tile contention at the hub, not
raids.** Every walk-served remote's haul stamp shows at-sink idle WITH
storage free (the meter's own fork: "spatial contention... NOT a bigger
fleet"): d01f 0.243, cee0 0.174, cedc 0.151, cd94 0.128 - while cd8e, the
one PORTED route, runs the best duty (0.834). cd8d shows the second shape
(0.376 idle EN ROUTE - approach-lane congestion). d01f's arithmetic: 64
CARRY fielded x 0.715 duty = 46 effective < 49 needed - the backlog stands
on throughput loss; the drain law then buys MORE carry into the SAME queue.
A positive feedback loop, and raids are a co-payer (3.72 e/t measured
cargo), not the cause.

**Shipped now (v27, deployed):** killed-WHERE attribution - tombstone
killed energy by booking room + intel-hostile flag, cumulative, printed on
the account ("the share the raid story can claim"). The R1 swap gains an
EVIDENCE GATE at the constant: it prices INVADER raids specifically, so it
inherits only the hostile-room share of the measured ratio.

**The fix map (task #15, in evidence order):**
1. Deposit-spread: route the DEP gauge's eligible remotes through the home
   links (60 e/t over 6 routes measured waiting; the raised controller
   allocation raises port headroom). Solver work, full gate.
2. Approach/deposit geometry at the hub (cd8d's lane; the parked feeder).
3. Drain-law cap: a chronic mouth alarms (E6/H3) instead of buying
   incremental CARRY into the queue.
4. The plan declares the whole stack (drain term + body quantization) so
   F1/F2 read ~1.0 and real excess stays visible.
5. Raid-tax swap at window 10, gated on the v27 hostile-room share.

Verdict: **instrumented + re-attributed** - the fix program now aims at the
measured mechanism.

### 2026-08-03 — plan-t2-antidowngrade-construction: pre-existing red, refill law acquitted

Gating the asymptotic-refill deploy (spec 38 phase C), the cell timed out on
"controller physically progresses despite the build-out" (standalone rerun,
not host load). Bisect: **identical timeout on pre-change src (d910d47)** —
the staged world has no storage, so the refill seam is structurally inert
there. Acquitted; joins the windowed pre-stretch regression set as its own
incident against the deployed lineage. Cells run this stretch:
haul-t4-bank-surplus-upgrades PASS, haul-t4-storage-bank-and-spill PASS;
REFILL TRIO 3-0; unit 2027-0. Baseline untouched (the cell's baseline "pass"
now overstates master — the ratchet debt is filed here, not silently
re-baselined).
## Cycle t72773737 — the even-share treadmill (runt-upsize 90% of recycles, receipt-proven)

Capture t72773737 vs committed t72766670 (7067t, methodology #10). The
2026-08-03 wave measurably worked: evacuation **-15.86 vs -11.73 budget
(-4.13 U)** — best variance in months (FY4851-M01 -6.13, FY4850-M08 -12.32) —
with E5 down to 1 runt/8, X6 38/38 in-tolerance, H1 duty 0.87 (atSink 0.05),
21% of controller flow direct via link. TOP LINE: F1 1.57x, haulers +0.124
p/t of the +0.229 unbudgeted.

**The raid story fails the evidence check a second time** (owner 2026-08-03:
"a lot is blamed on raids without sufficient evidence"). R1 printed "remote
churn bodies 5.08 e/t, 9x the priced tax" — but R1/X5 classify churn by ROLE
EXPOSURE (remote-serving roles), not by cause. The death watch (evidence,
v27): kills 22% of window deaths, only **2% in intel-hostile rooms**;
recycles **76%**, of which **runt-upsize 90%**. The churn is self-inflicted.

**The receipts name the mechanism** (blackbox ring, 2406t): d01f bought
EIGHT 27-36p hauler bodies in ~1200t, costs laddering
1350→1350→1500→1500→1650→1650→1800→1650 = 12,450e = **5.17 e/t on one
route** (plan 1.27; its Source P&L row -5.10). cbd8: six bodies,
1200→1500. cbd5: 1650/1800/1650. Three gears mesh into a treadmill:

1. The plan prices the pile drain INTO route carryParts (phase-1
   repricing), so a staging/clearing buffer moves carryNeeded ±1 CARRY per
   solve (d01f 37.34 CARRY, buffered 2367; cbd8 37.64, buffered 3837).
2. The demand heal branch had no dead-band: 1 CARRY short of a covered
   fleet = ask for a whole even-share body.
3. The pounce judged bodies against haulerBodyCarry's CEIL share while the
   sizer deliberately fields FLOOR-share bodies (+remainder as +1s, the
   2026-07-31 fix) — any route that doesn't divide evenly stands a
   floor-share body the culler reads as a runt FOREVER. Buy even-share,
   cull smallest, repeat.

**Fix (one contract, both seams, one predicate — `worthABody` in
corps/recycle.ts):** in the MATURE regime a CARRY deficit under HALF a
body-share is not worth a spawn purchase — it rides to EOL, which re-sizes
for free; and the pounce judges runts against the sizer's own floor share
(same-lens doctrine — the staffsPost trap, generalized to sizer/culler).
Bootstrap keeps every crank (escape velocity, cee0 doctrine). Red-first:
sliver-ask red confirmed pre-fix; 5 new behavior tests; unit 2044 green;
typecheck clean; trio: flow-handoff PASS, runt-economy PASS (the bootstrap
crank survives, by design), storage-depot PASS — full gate green, deployed
from e545b0f with t72773737 as the committed pre-deploy baseline.

**Predictions (pre-deploy, next capture ≥~1500t):**
- same-corp hauler buy cadence on d01f/cbd8/cbd5/cedc ≥ ~1100t (was 108-408t)
- recycled-why runt-upsize < 20% of recycles (was 90%)
- evacuation actual ≤ ~12.5 e/t vs ~11.7 budget (was 15.86, -4.13 U)
- F1 hauler class ≤ 0.26 p/t (was 0.358); S5 ≤ 0.85x ceiling (was 0.94)
- GUARD: pile decay ≤ ~9 e/t (was 8.57) — a material jump falsifies the
  premise that the forgone slivers don't bind throughput (H1 says the sink
  binds: idleSink 0.12, atSink 0.05, storage had room)

**Recorded, not fixed this cycle:** hauling-1-22's recurring 2-part 100e
scavenge rebuys (9 in 2406t, 0.37 e/t — spec 44's standing-scavenger
shape); the upgrader resize ladder (receipts 4450→1650→750→750→3250,
consumers -1.27 U — the plan-allocation valve moves with the bank; same
actuator-granularity mismatch, different valve, own cycle); construction
class 0.042 p/t vs plan 0.000 (road-rebuild receipts campaign, unbudgeted);
P12 prints "Infinity x" when the plan's non-bank controller term goes
negative (plan -17.40 vs runtime -12.40) — display artifact to fix at the
gauge, labeled hypothesis.

Verdict: **fixed (mechanism-level, receipt-proven)** — post-deploy
verification pending at next capture.
### Cycle t72773737 addendum — P12 plan-side unification (the 40-GCL program's binding seam)

Owner: *"I'd love to get gcl to at least 40/tick"* → *"P12 valve unification?"*
→ *"Start working on that."* Also owner, on the account: *"It doesn't make
[sense] for the budget for the controller to be -55. I think our budget would
actually be unbalanced... it should just be zero or something"* — confirmed,
and both findings turned out to be ONE seam.

**The measured chain** (all links from t72773737): hold-to-fund queues
full-share bodies (fundingNeed 5,100 at solve time) → FUND_HORIZON (50) turns
that into a 102 e/t sink claim → spawn sinks claim 117 e/t against ~36.5 the
two spawns physically convert (0.30/0.33 p/t measured) → the solver (spawn =
value 100, top of ladder) feeds the claim first: 156.61 e/t gross bank draw,
101.45 round-tripping back to storage on paper → the published controller
allocation gets the residual, 39.64 against the phase-D law's cap of 57.04
(bankFedControllerRate; the sip term reads 0 without downgrade telemetry) →
the upgrader fleet, correctly obeying ONE VALVE, sizes to the depressed
number → delivered 34.20 vs G1 sustainable 50.78. The budget column printed
the same fiction as a -55.16 bank "budget" — a 79.85 e/t hole (the column's
own identity: bank should have been +21.10).

**Shipped (three pieces, one commit):**

1. **`primitives.spawnEnergyCeiling(e/p)`** = SPAWN_PARTS_PER_TICK x the
   plan fleet's own mean energy-per-part, floored at the cheapest part.
   `spawnSinkDemand` takes it as a HARD cap - even over the charge (a
   super-physical charge is P4's infeasibility to flag, not a bigger claim).
   The mix threads solve-to-solve as `Memory.lastFleetEnergyPerPart`
   (fleet energy / partsLedger parts), exactly the lastFleetCharge pattern;
   undefined for one solve after a wipe = legacy uncapped, never a guessed
   mix. At t72773737's mix (~76 e/p) the cap is ~25 e/t/spawn - ABOVE the
   measured 18 e/t/spawn actually spent, so it cuts only the paper claim.
2. **Methodology #11:** the bank BUDGET line is the plan's RESIDUAL, so the
   budget column sums to zero BY CONSTRUCTION (identity test pins |sum| <
   0.01 on the committed pair); the solver's routed net bank flow moves to
   the over-routing note. The variance bridge re-derives from the balanced
   column and now CLOSES EXACTLY (t72773737: explains -5.44 = actual -5.44,
   closure +0.00; the #10 bridge carried "+71.73 bank draw budgeted but not
   performed" - mostly phantom - plus a standing -6.61 "unexplained").
3. **P12 re-pinned** to the post-phase-D world: published allocation vs
   bankFedControllerRate's cap (0.70x WARN on the pair), the spawn-sink
   claim named in the detail. The old model subtracted the drain from both
   sides and printed "Infinity x" on negative terms - an artifact on
   exactly the seam it existed to name.

**Gate:** red-first (11 new spawnSinkDemand/ceiling pins, 4 new audit pins;
methodology stamp test moved to #11); unit 2,055 green; typecheck clean;
trio: storage-depot PASS, flow-handoff PASS (4m), runt-economy PASS (4m)
- 3-0, recorded 913c8aa+1. Deploy
SEQUENCED AFTER the treadmill check-in verdict so each change verifies
against a clean window.

**Predictions registered for the P12 deploy** (next capture ≥ ~1,500t after
it, multi-draw rule applies - the allocation breathes with the bank level by
design):
- spawn sink claims ≤ ~25 e/t per spawn (was 102/14.97); the paper bank
  round-trip collapses (gross bank-out falls from 156.61 toward the real
  consumer draw).
- published controller allocation rises toward the law's cap (39.64 → ~50+
  while surplus stands; equilibrium allocation ≈ sip + residual/tau).
- upgrader fleet grows into the raised allocation within 1-2 generations
  (holdToFund full bodies; S5 headroom freed by the treadmill fix pays the
  build time); delivered score climbs toward the high-40s; **GCL ≥ 40/t
  sustained** is the program target (G1 said 50.78 was already sustainable).
- P12 ratio → ≥ 0.8 (ok band); the bridge's bank term stays small (the
  -4.52 shape, not +71.73).
- GUARD: spawn idle "bank" share (S4) must not rise materially - if the
  capped claim starves real refill, S4's energy-starved share says so and
  the ceiling's e/p input is the suspect (the tender path, not the flow
  plan, does hub refill - expected null effect).

### Cycle t72773737 verification (t72775811, ring 1,594t pure post-deploy) — ALL FIVE PREDICTIONS CONFIRMED

The 13:23 scheduled check-in never fired (session cron lost); verification ran
manually at owner prompt. Window: 2,074t vs baseline (~75% post-deploy); the
blackbox ring restarted at the deploy so its 1,594t are pure post-fix.

1. **Cadence ≥ ~1,100t: CONFIRMED.** 11 mining-corp hauler bodies in 1,594t
   ≈ pure replacement for the standing fleet. The cost LADDER is dead: flat
   pairs (1350/1350 on d01f with a 1,178t gap; 1200/1200 on cbd8 = fleet
   fill), no +1-CARRY staircase anywhere. Hauler spend 10.32 e/t vs 17.91.
2. **runt-upsize < 20% of recycles: CONFIRMED.** 15% (was 90%), inside a
   window that still includes ~500 pre-deploy ticks. E5: 0 runts of last 8.
3. **Evacuation ≤ ~12.5: EXCEEDED.** **-11.16 vs -11.04 budget (-0.12 U)** —
   the line is ON BUDGET for the first time in the program.
4. **F1 haulers ≤ 0.26: EXCEEDED.** 0.206 vs 0.221 planned (-0.014) - the
   hauler class reads UNDER plan for the first time. S5 0.87x vs the ≤0.85
   predicted - met within noise, and the residual churn is no longer
   haulers: a RAID SURGE window (killed-where 20% intel-hostile, defense
   0.094 p/t vs 0.000 priced) plus a NEW finding, a construction corp FAST
   RESPAWN (X5 worst: W43N23-construction 2350e@21t - double-order loop
   shape, next cycle's candidate).
5. **GUARD pile decay ≤ ~9: HELD.** 7.47 (was 8.57); H1 duty 0.92 (was
   0.87), atSink 0.02 - the slivers did not bind throughput.

**Second-order effect, unpredicted and large:** the treadmill was itself the
spawn-sink over-claim's feeder - dead churn emptied the hold-to-fund queues,
sink claims fell 117 → 44.39 e/t without the ceiling deployed, the published
allocation rose to the phase-D law's cap on its own (**P12 1.0x: 50.51 vs
50.38, feeder relay 55.51, ONE VALVE holds**), and the controller delivered
**42.18 pts/t** - the owner's ≥40 target - on this first post-fix window
(single window; the multi-draw rule owns the sustained claim). The P12
ceiling still ships: it cuts the remaining 14.95 e/t over-routing and makes
the 102-claim mechanism structurally impossible on the next banking wave
(the raid-recovery queue is exactly such a wave), and methodology #11 makes
the budget column state it honestly either way.

Verdict: **fixed - confirmed live.** The evacuation-line program that opened
this branch closes ON BUDGET.

## Cycle t72777517 — both deploys verified; the account closes at RESIDUAL +0.41

The first cycle in the program with NOTHING to deploy. Window t72775811 →
t72777517 (1,706t, ~95% post-P12-deploy); fiscal closes FY4851-M07 (138%)
and FY4851-M08 (114%) written - the first closes at methodology #11
(balanced budget columns).

**P12 ceiling verification - all predictions confirmed:**
- Spawn sink claims: 14.54 + 14.54 = 29.09 e/t total (was 117 pre-treadmill,
  44.39 pre-ceiling) - both sinks capped at the SAME value: the ceiling
  binds, priced from the fleet's own mix.
- Published allocation AT the law's cap: P12 1.0x (48.88 vs 48.92), feeder
  relay 53.88, ONE VALVE holds end to end.
- The paper bank round-trip collapsed: gross bank-out 77.97 (was 156.61).
- S4 GUARD clean: spawn idle is 97% "empty" (no demand), ~0% energy-starved
  (was 76% bank-starved attribution) - the cap starves nothing; S5 headroom
  0.39x (61% surge margin).
- Score: 53.77 pts/t delivered, 98% income-funded (G1 sustainable 52.48).
  Two consecutive windows >= the owner's 40 target (42.18 -> 53.77); the
  multi-draw rule wants one more before "sustained" is claimed in a close.

**The account itself:** delivered 99.98 of 100 (forgone 0.39 - the piles are
clearing); evacuation -9.96 vs -11.09 (+1.13 F, second window at/under
budget); NET MINING MARGIN +0.37 F; TOTAL SPAWN -1.25 U; the solver now
UNDER-routes its fleet by 1.64 e/t (was OVER by 86.47); **RESIDUAL +0.41 -
effectively zero, positive, first time**. Spec 42 Stage B's |residual| <= 5%
of gross bar is met on this window (0.4%); Stage C's |controller actual -
budget| <= 10% likewise (+4.89 on 48.88 = 10.0%... at the line; the bridge
closes +0.00 by construction). Both need fiscal-month sustains per spec.

**New TOP LINE, recorded as HYPOTHESIS not fixed:** F1 flipped two-sided -
0.66x, the plan OVER-states 0.137 p/t ("a fleet priced but never built").
Candidate mechanism: COHORT PHASING - the churn era's death ended with the
whole fleet born within ~one window (the raid-surge rebuild), so replacement
demand now arrives in waves every ~1,500t instead of uniformly, and a
trough window under-builds vs the amortized plan. Falsification designed:
if phasing, F1 recovers toward 1.0 as deaths stagger over 2-3 windows; if
it persists >= 3 windows, the plan's amortization genuinely over-prices and
the fix is at effectiveLife/planSpawnLoad. Do NOT tune the gauge to quiet
it - two-sided is the point (an over-stating plan is as uncontrollable as
an under-stating one).

**Standing items, unchanged:** E6 chronic mouths cedc (3,440 buffered, 100%
held) and d01f - the spec-44 standing-scavenger / DEP deposit-spread
program, solver work. An emergency anti-downgrade jack spawned during the
deploy-reset turbulence (UNCLASSIFIED 0.18 e/t - by design, and worth
knowing the path fired). Construction class still unpriced (0.018 p/t this
window).

Verdict: **verified x2 + instrumented** - the evacuation-line program that
opened this branch is CLOSED (two windows at/under budget), the 40-GCL
program is two-for-two pending the multi-draw sustain, and the account
balances to +0.41 of 100.

## Cycle t72778545 — two hypotheses confirmed; the ledger is down to ONE structural FAIL

Window 1,028t (FY4851-M09 closed at 69%). No code changes; both prior
deploys continue to verify.

**F1 cohort-phasing hypothesis: CONFIRMED (recovering).** 0.66x → 0.91x
[ok] in one window; the plan over-state shrank 0.137 → 0.034 p/t as deaths
staggered. Class-level phase swings visible exactly as predicted (extraction
-2.53 U as the miner wave replaces, consumers +3.61 F in their trough)
while aggregate TOTAL SPAWN sits -0.53 U of plan. No plan fix warranted;
the gauge was right to be two-sided and un-tuned.

**GCL ≥ 40 SUSTAINED (multi-draw satisfied):** 42.18 → 53.77 → 51.67 pts/t
across three consecutive windows (~4,300t ≈ 3 fiscal months), the last at
+1.73 F vs its own budget with bank slope +1.79 (income-funded, not
drawdown). The owner's target stands as the measured equilibrium. P12 holds
1.0x; E4 converging (145k vs 148k projected equilibrium).

**TOP LINE (the one FAIL): L1 — pile decay 6.65 vs its deliberate zero
budget.** Updated evidence for the next program:
- The DEPOSIT-SPREAD hypothesis is DEAD for the chronic mouths: cd8e, cedc
  AND d01f already route through home-link ports (46,11 / 43,38) - the DEP
  gauge's "savings" list double-counts elections already made (gauge fix:
  exclude ported routes). The piles stand ANYWAY.
- The mouths sit at DRAIN-LAW EQUILIBRIUM (~2-3k buffered, E6 holding
  miners 81-96% of window), and decay is trending down post-treadmill
  (8.57 → 7.47 → 6.68 → 6.65) - stable, not runaway. The heal dead-band
  may slow sliver re-sizing on exactly these routes (named trade, watch);
  EOL replacement re-sizes drain-inclusive once per generation.
- The FLOOR CENSUS is the actionable signal: 3.90 of the 6.65 e/t is the
  ceil floor - ~5.0 SMALL piles each paying the >=1 e/t minimum however
  tiny. The win is CONSOLIDATION (focus-fire a pile to zero, retire its
  whole floor), i.e. spec 44's standing scavenger, now evidence-backed -
  NOT more carry into the queues.
R1 accumulates at 5x priced (window count still short of the >=10 swap bar;
capture cadence at ~2h/month wall-clock is the constraint - session crons
do not survive, so closes depend on invocation cadence).

Verdict: **confirmed x2** - F1 recovered as hypothesized, the 40-GCL target
is sustained by the multi-draw rule, and the next program (spec 44 leg 1,
focus-fire consolidation) is named with its census evidence.
## Experiment: the handicap lift (SPAWN_PLAN_FRACTION 0.9 → 1.0, owner 2026-08-04)

Owner: *"We could try lifting the 10% spawning capacity handicap on the
planner for a couple of months to see what happens."* (Same message defers
the broader feed-measured-data-back-to-planner program: "Not yet.")

**Why now (evidence):** the margin's original absorbers are fixed out from
under it - X5 home churn 18%+ at the margin's birth (t72676360: util 0.97,
queue depth 8), 0-3% across the three post-treadmill windows; the spawn
runs 46% physical headroom (S5 0.54x); the spawn-sink claim is physically
capped (spawnEnergyCeiling). Meanwhile the margin BINDS at admission:
t72778545 shows **28 candidate sources rejected "over-budget" with positive
nets** (best 7.13, 6.52, 6.42) behind the 0.9 x 0.6 mining tranche.

**The change:** one constant, one uniform lens (plannableSpawnParts). Test
re-stages per the file's own convention (CorpPlanner staged
infraPartsPerTick back to originals; golden master regenerated - delta is
exactly +0.0333 on four partsLeft traces, no allocation or route changed in
the golden worlds). Gate: unit 2,055 green; trio 3-0 (storage-depot, flow-handoff 4m,
runt-economy 4m). Deployed. CONTROL DESIGN (owner, superseding the staged sim arms: "just
deploy and let it run as a control in prod"): the control is PROD'S OWN
pre-lift record - the three committed post-treadmill windows (t72775811,
t72777517, t72778545: score 42.18/53.77/51.67 pts/t, F1 0.91x, 10 funded
sources, 28 over-budget candidates, full accounts at methodology #11) -
against the lifted months as treatment. Confounds to carry when reading:
raid weather, bank phase, shard speed; the reversion criteria are the
safety net either way. A single 600t sim pair (0.9 vs 1.0 bundles, one
byte apart) was already in flight and rides as a bonus deterministic
admission datapoint; the multi-draw throughput arms are cancelled. Null
outcome is a DELETE, not a revert (owner: "if it doesn't do anything maybe
we don't need it").

**Predictions (deploy t72778545+, read over ~2 fiscal months):**
1. ADMISSION: 1-2 remotes funded within a few solves, highest nets first
   (candidates 36-3 net 7.13, 2-20 6.52, 5-23 6.42). Mining capacity line
   100 → 110-120 e/t.
2. P4 plan-implied 0.397 → ≤ ~0.50 p/t (≤ 0.75x physical) - no
   infeasibility.
3. S5 build rate rises toward the bigger plan (0.54 → 0.65-0.80x); S4
   empty-idle share falls.
4. GCL sustainable rises toward ~55-60 IF the new remotes deliver near
   their priced nets. HONEST RISK, stated up front: R1 measures raids at
   ~5x the priced invader tax and new remotes add raid exposure +
   reservation load - the experiment may instead show the ADMISSION
   pricing is optimistic (nets under-taxed). That is a valid finding, not
   a failure ("see what happens" is the brief); the source P&L's
   per-source var column is the verdict reader.
5. Piles: new mouths = new pile risk (E6 count may rise; the
   standing-scavenger program owns it).

**REVERSION CRITERIA (any, sustained a full window):** util > 0.95 with
queue-depth blocking (the t72676360 saturation shape), X5 home churn > 10%,
or P4 ≥ 1.0x. Then the margin was still needed - and the right value
between 0.9 and 1.0 gets MEASURED (instrument before pricing), not argued.

## Cycle t72780703 — handicap-lift window 1: the admission prediction FALSIFIED, and the attribution is exact

FY4851-M10 closed (YEAR END, 144%). Treatment window vs the three-window
control: score 47.13 (control band 42.18-53.77 - inside it), evacuation
+0.07 F (fourth consecutive window at/under budget), residual -1.50, F1
0.83x WARN (the cohort wave, still recovering as predicted).

**Prediction 1 (admission event): FALSIFIED, by arithmetic that was
available pre-deploy and not run.** The lift is live (partsLedger.plannable
0.6667 confirmed) and grew the routing budget 0.482 → 0.548 (which had
slack at both values - routing null too). But the ADMISSION gate reads
`miningBudgetPerSpawn()` = plannable(1) x MINING_BUDGET_FRACTION, applied
PER SPAWN: the lift moved each spawn's tranche 0.178 → 0.200 (+0.022),
while the cheapest rejected candidate (36-3, net 7.13) costs 0.0525 p/t.
**The lift is smaller than the marginal source's quantum - the predicted
event cannot occur at 1.0.** Same 10 funded, same 28 over-budget, capacity
flat at 100.

**Two structural findings from the same read:**
1. **Per-spawn partition mis-ranking:** candidate 36-3 has BETTER net/part
   (136) than the funded d01f (130), but is rejected because its
   nearest-spawn's tranche is full while d01f's spawn had room. The
   admission partition (nearest-spawn grouping, CorpPlanner ~460) makes a
   worse source beat a better one across spawns - the global-spawn-pool
   work (#141) never reached the admission loop.
2. **The binding constant is MINING_BUDGET_FRACTION (0.6), not
   SPAWN_PLAN_FRACTION** - funded 0.3214 + marginal 0.0525 = 0.374 fits the
   GLOBAL tranche (0.400 at 1.0) and would fit comfortably at 0.45-0.5
   fraction... another never-audited constant, now with a measured incident
   against it.

**Standing prediction for the remaining window:** null throughout - no
admission, no throughput delta vs control (window 1: 47.13, inside band).
Per the owner's rule ("if it doesn't do anything maybe we don't need it"),
the fraction is DELETE-candidate at window close - and the real follow-up
program is the admission seam itself: global (un-partitioned) candidate
ranking + an audited mining tranche, which the quantum arithmetic above
prices exactly (admitting 36-3 costs 0.0525 p/t of spawn time for +7.13
e/t net - the colony has 46% spawn headroom and 75k of free cash).

Verdict: **falsified + attributed** - the best kind of failed prediction:
it named the two real seams (partition, tranche) and priced the next win.
### Cycle t72780703 follow-up — GLOBAL ADMISSION (owner: "give it a try")

The falsification's finding, shipped as the mechanism fix: admission now
funds candidates by net/part across ALL spawns against the GLOBAL tranche
(spawns x miningBudgetPerSpawn), with each spawn's best still seeding
unconditionally (liveness). Nearest-spawn ASSIGNMENT is unchanged - only
the FUNDING decision is global. MINING_BUDGET_FRACTION stays 0.6: one
change at a time; the tranche audit is the NEXT experiment and is now
clean to run (the partition no longer confounds it).

**A searcher ability retired by a better base solve:** spec-18 P1's
day-one positive proof (pin a dropped source to the idle spawn) is
DISSOLVED - under a shared budget, nearest assignment minimizes every
source's parts, so the budget-partition move class is gone and the base
solve reaches first-best natively (the old fixture: all three sources fund
from A at 0.312 of 0.4; the searcher's second-best pin - d170 from B vs
d160 from A - is strictly dominated). The searcher harness stays for the
spec-32 structure moves. Re-pinned accordingly; the per-spawn budget pin
re-pinned to the global contract.

**EXPERIMENT NARRATIVE REVISED:** the handicap lift is NO LONGER a delete
candidate on admission grounds - at 0.9 the global tranche (0.36) is
smaller than funded+marginal (0.374), at 1.0 (0.40) it fits. The lift was
NECESSARY BUT NOT SUFFICIENT; the partition bug masked it. The lift's
window continues with this fix compounding it.

**Predictions (pre-registered, exact - the falsification's lesson applied):**
1. Within a few solves: funded 10 -> 11, the new source being 36-3
   SPECIFICALLY (net/part 136, the best rejected; it outranks the funded
   d01f at 130). 42-20 stays out (0.439 > 0.400). Capacity line 100 -> 110.
2. All 10 incumbents KEEP funding (verified in the arithmetic: global fill
   order retains them; no revocation churn - the trap-list class this must
   not regress).
3. P4 plan-implied +~0.05 p/t (miners+haul for 36-3) -> ~0.50, <= 0.75x
   physical.
4. 36-3's MEASURED net lands BELOW its priced 7.13: unpriced reservation
   share for its room + the ~5x under-priced raid exposure (R1). The gap,
   read off the Source P&L var column over the coming windows, IS the
   marginal-remote cost measurement the control design wanted.
5. GUARD: P1 plan-flap stays 0 for incumbents; E6 may add 36-3's mouth
   (new pile risk - spec 44's program, not a reversion signal).

Gate: red-first (mis-rank + liveness + global-tranche pins; the old
per-spawn pin and spec-18 positive proof honestly re-pinned); unit 2,058
green; trio 3-0 (storage-depot, flow-handoff, runt-economy) - deployed from 9488cfb;
the 36-3 admission prediction reads at the next capture.

### Cycle t72780703 follow-up 2 — reservation priced into admission; the raid tax deliberately NOT swapped

Owner: *"is this a known problem? Can you fix it?"* Both halves known; they
diverged on evidence.

**Reservation share: FIXED.** Admission nets now carry
`reserverRoomEnergy()/roomSources` (~1.20 e/t per room, composed from the
SAME reserverSpawnLoad + CLAIM/MOVE mix infraSpawnEnergy prices, one home)
for sources outside spawn rooms - the chronic remote P&L variance every
close printed ("mean remote variance -0.63..-1.68... the remote cost the
plan is missing") was exactly this omission. PREDICTION: the P&L plan-net
column drops by the share the measured column already charges; the chronic
negative remote variance closes toward ~0 over the coming windows. Note the
interaction with the standing 36-3 prediction: remote nets all drop
~0.6-1.2, ordering roughly preserved; 36-3's admission margin narrows but
holds on the arithmetic (net/part stays above the funded tail).

**Raid tax: NOT swapped, and the evidence says that is the fix.** The R1
protocol (>=10-window soak + v27 hostile-room evidence gate) stands, and
the cumulative counters INVERT the headline: provably-hostile-room killed
cargo runs ~0.02 e/t against the 0.71 priced, while the "5x measured" is
dominated by haulers dying AT HOME in unmarked rooms - cause UNRESOLVED
(intel mark lag at death tick? invaders transiting pre-mark? something
else?). Swapping the constant would encode a mystery as a price - the
owner's twice-vindicated "blamed on raids without sufficient evidence"
class. Next instrument (task #9): death-watch stamps hostile-presence
within intel TTL bounds at the kill tick; the swap follows on clean
post-stamp windows only.

Gate: unit 2,060 green (admission-net red-first test + hand-derived
reserverRoomEnergy pin); trio 3-0 - deployed. The next capture reads three
stacked predictions: the 36-3 admission, the remote plan-net drop, the
incumbents holding.

## Cycle t72782041 — ALL THREE PREDICTIONS CONFIRMED TO THE DECIMAL; the expansion is live

FY4852-M01 closed (89%). The stacked predictions from the global-admission +
reservation-pricing deploys, against the fresh plan:

1. **Admission: CONFIRMED.** Funded 10 → 11, capacity line 100 → 110.0. The
   admit is cee2 - the predicted candidate itself ("36-3" was its unscouted
   position-form id; the 0.0525 parts fingerprint matches exactly), solo in
   its room, net 5.93 = the predicted 7.13 less its full 1.20 room bill.
2. **Reservation pricing: CONFIRMED, exact.** Solo-room remotes -1.20
   (cedc 8.07→6.87, d01f 7.04→5.83, cbd8 7.28→6.08, cbd5, cd94, cee0),
   shared-room -0.60 (cd8d, cd8e), home unchanged (8.94). The chronic
   remote P&L variance's plan-side cause is closed; the P&L var column
   should converge toward the RAID share alone over coming windows.
3. **Incumbent stability: CONFIRMED.** All ten held funded; P1 flap 0.

**The account reads as a clean expansion transition:** revenue line at
110.00 (the budget column moved with the admission - the account and the
plan agree about the new world); reservation +5.74 F while cee2's reservers
spawn up; a construction campaign for the new route at HALF the spawn's
build (F1 construction 0.332 vs 0.161 planned - watch: campaign-sized or
the fast-respawn loop returning); score 44.17 vs 52.54 (-8.38 U, expansion
capex taking the controller's share, as macro doctrine intends);
**RESIDUAL -0.03 - the account is fully closed.**

**TOP LINE S5 0.96x - attributed, NOT a reversion signal.** The handicap
lift's reversion criteria were checked explicitly: X5 churn ZERO (0e of
27,650e), no queue blocking (S3 clean, S4 idle 4% all buy-latency), P12
1.02x. This is the t72676360 saturation SHAPE ONLY - the substance is a
real one-time campaign (construction + upgraders + the new route's
bodies), exactly what the surge margin exists to absorb. Watch next
window: campaign should drain, S5 → ~0.6; if construction stays 2x its
plan past the campaign, the fast-respawn loop gets the eye.

E6 notes 5 of 11 mouths held during the build-out (cee0 buffered 4,957 -
the new route's neighborhood congestion); expansion transient, spec-44's
program unchanged.

Verdict: **confirmed x3** - admission, pricing, and stability all landed
as registered; the colony is mining its eleventh source.

## Cycle t72783130 — cee2 delivers ON its price (+0.12); the P&L variance program CLOSES; the construction tanker flicker named

FY4852-M02 closed (73%). Score 52.56 (+14.52 F vs a campaign-conservative
plan); S5 draining as predicted (0.96 → 0.89); delivered 103.81 of 110.

**cee2's first measured window: net 6.05 vs plan 5.93 (+0.12).** The
eleventh source delivers ON the now-complete admission price. And the
whole remote P&L variance column - chronic -0.63..-1.68 on every close
since the P&L shipped - reads +0.41/-0.68/+0.12/-0.00/-0.10: CENTERED ON
ZERO. The reservation-pricing prediction is confirmed in production; the
per-source pricing program (miner + hauler + link + invader + reservation)
is complete and measured accurate to ~±0.4 e/t on 9 of 11 sources.

**TOP LINE F1 1.32x - the construction tanker FLICKER-LOOP, named with
receipts:** building-W43N23-construction bought 8 tankers (8,800e ≈ 5.1
e/t) with buy-gaps of 7t and 25t while standing ZERO creeps. Mechanism
(code-confirmed): tanker demand keys on pool-site EXISTENCE; the
road-rebuild campaign (receipts, plan prices 0.000) trickles 300e road
segments one at a time; each site-flicker spawns a 1,100e tanker that the
op-end cohort release demobs on arrival - the same actuator-granularity
disease as the even-share treadmill, on the construction seam. Plus eight
250e road-rebuild builders (one per remote room, ~1.3 e/t, benign but
unpriced). Fix queued red-first (task list); the "25t orphan grace bought
nothing and cost plenty" comment (ConstructionCorp:319) reads first.

Also this window: piles surged to 13.04 (cee2's mouth 3,103 held 100% -
the new chain still forming; expansion transient atop the spec-44
standing case); residual -16.62 on a short mid-expansion window (raid/
tower/unmetered - bounded, watch); E4 flags the bank falling at -18.24/t
mid-campaign with reserve target raised to 77k (expansion capex drawing
the warchest - the spend path IS the campaign; watch it flatten as S5
drains).

Verdict: **confirmed (pricing program complete) + diagnosed (flicker-loop
named with receipts)** - the fix is the next cycle's red-first item.

## Cycle t72783818 — road payback lands (evacuation +6.02 F); the tanker flicker fix ships worth-a-body

Short window (688t; no new close). **cee2's road is already paying:** the
evacuation line came in at 6.54 actual vs 12.56 budget (+6.02 F) - the
trunk's 2:1 bodies and crawl-corrected distance under-running even the
plan's own price. Delivered 110.93 of 110 (piles drawing down); sustainable
64.41 (short-window phase read) with +21.53 banked.

**The flicker-loop was NOT dormant** - the fresh ring showed 8 MORE tankers
@1,100e (~3.7 e/t) plus 13 road builders; F1 only rotated off the top by
window shuffle. Fix shipped (task #10): tankerPlan takes the pool's
remaining work and gates the relay at ITS OWN fleet price (target x body,
<= on purpose - cargo equal to the relay's cost is not worth the relay).
Trickling 300e road segments can never buy a 2,200e relay again; real site
clusters clear the bar untouched. No new constants - the actuator prices
its own quantum (worthABody doctrine, third application: heal dead-band,
spawn-sink ceiling, now the construction relay). The in-tree history that a
25t demob-side grace "bought nothing and cost plenty" pointed the fix at
the BUY side.

Red-first (staged mini-relay, same ratio as live); unit 2,062 green; trio
3-0 VERIFIED BY MARKERS (storage-depot 8s, flow-handoff 4m, runt-economy
4m) - deployed. Process note, recorded against the trap list: the FIRST
trio run was piped through `| tail -1` per leg, which made the chain's exit
code tail's unconditional 0 and captured three BLANK lines - a gate that
could not fail, self-built, caught before deploying on it. The playbook's
"verdicts are markers, never exit codes" applies to one's own harness
plumbing too; verdict greps now land in the output file per leg.

PREDICTIONS (for the deploy): construction tanker receipts ~0 while the
road campaign trickles (builders continue, self-fueled); F1 construction
class -> ~0.02 p/t (the builders alone); the next REAL site cluster still
fields its relay instantly (regression watch at the next RCL build-out).
TOP LINE L1 (pile decay 9.03: cee2's forming chain + cd94) remains the
spec-44 standing case.

## Cycle t72785431 — flicker fix VERIFIED (zero tanker receipts); the hostile-at-death instrument ships (v32); two harness-gate incidents recorded

**Flicker verification: CONFIRMED.** 1,201t pure post-fix ring: ZERO tanker
receipts; the road campaign continues on four self-fueled 250e builders.
The worth-a-body relay gate joins the heal dead-band and the spawn-sink
ceiling as the third actuator-prices-its-own-quantum fix. Evacuation +0.55
F (fifth consecutive window at/under budget); RESIDUAL +1.21; cee2 left
the held-mouths list (its chain caught up). TOP LINE stays L1 (pile decay
7.99 - the spec-44 standing case, unchanged program).

**Task #9 shipped (telemetry-only, core v32):** `tombstoneKilledHostileAtDeath`
- killed energy whose room's intel mark WINDOW covers the deathTime
(deathTime <= roomIntel.hostileUntil), host-assembled beside the
booking-time flag. Catches the sighting-LAG kill the booking-time flag
misses by construction; the DELTA between the two counters IS the lag
measurement. The R1 tax swap reads THIS share once post-v32 windows
accumulate - never the 5x headline the exposure-classified churn built.

**PROCESS INCIDENT, second of the session, recorded against the trap list:**
the deploy chain gated on `grep -E "passing|failing"` - which succeeds by
FINDING the word "failing" - and a deploy ran with 1 failing test. The
failure proved to be the deliberate version-pin tripwire (expected 32 to
equal 31 - the pin doing exactly its job on the v32 bump), so the shipped
bundle was correct; the GATE was not. Earlier the same session, a
`| tail -1` per trio leg produced three blank lines and an unfailable exit
code (caught before deploying). RULE, now twice-bought: a verdict is the
PARSED FAILING COUNT (`grep -cE "[0-9]+ failing"` == 0), never marker
presence, never exit codes - in the playbook's own words, applied to one's
own harness plumbing.

Verdict: **verified (flicker) + instrumented (v32) + process-corrected.**

## Registration t72785753 — P-55: the marginal-source accretion prediction (owner's number, decomposed and armed)

Owner criterion, verbatim doctrine: "At the end of the day we have to see if
controller+bank increases. Otherwise it's extra cpu and spawning for no
gain." Measured against that criterion from the committed capture series
(endpoint arithmetic, tick-weighted, no window averaging):

| era | span | ctl + bank |
|---|---|---|
| baseline (pre-engagement) | 128,698t | **23.50 e/t** |
| prior audit cycles | 76,088t | 41.06 |
| this session, 10-source era | 6,966t | 47.67 |
| this session, 11-source era (cee2 in) | 3,712t | **51.20** |

Cost side over the same split: spawn spend 0.511 -> 0.483 p/t (DOWN across
the session's changes), CPU spot-reads 18.9 -> 31.8 used/t with the bucket
pegged at 10,000 in every capture across all eras (never binding). The
accumulation doubled against baseline and the 11th source is already +3.5
e/t accretive WHILE paying its own road capex and hauling at unpaved
prices.

**PREDICTION P-55 (registered before measurement).** cee2's route receipt
stamped paved 76/76 at t72785801; the t72785754 plan snapshot still prices
it unpaved (d 82, eff 59.3) - the repricing is real upside not yet in any
measured number. Decomposition from the 51.20 base: evacuation EMA
convergence on the route (+1.3, the measured unfavorable variance), road
capex ends (+~2), repriced hauler downsizing at fleet turnover (+~1).
**Point estimate 55 +/- 3; falsification bar: tick-weighted controller+bank
>= 53 over >= 3 windows / >= 6,000t AFTER the plan reprices cee2** (marker:
flow source W42N21-40-4 efficiency > 59.3 in the capture).

Named risk that reclassifies rather than falsifies: admission of a surveyed
candidate mid-window - intel-W42N21-36-3 (40/76 tiles pre-built via shared
corridor, ~10.8k capex remaining) or intel-W41N23-23-39 (51/85, ~10.2k).
Either starts a new J-curve inside the measurement window; if one admits,
the gate becomes controller+bank+construction >= 55 (investment reclass,
same doctrine - the trunk spend is bank-shaped, not waste). Attribution
ladder if the bar misses WITHOUT new admission: (a) repricing never landed
in the solver (check the flow source line), (b) evac EMA did not converge
(cee2 P&L variance column), (c) spawn line binding (S-gauges), (d) draw
noise (mitigated by the >= 6,000t era aggregate).

## Cycle t72786811 — the standing-mouth mechanism cornered live; departure-reason meter ships (corps v16); P-55 marker corrected

**Standing set:** window 1058t. Delivered 104.25/110; evacuation **+4.28 F**
(the paved fleet is cheaper than the plan still prices); reservation -2.66 U;
controller 54.56 vs 58.29; bank +4.47; RESIDUAL -5.80; appropriations
**59.03 e/t** (short-window phase sample - no P-55 claim). FY4852-M04 closed
(129%). TOP LINE stays L1: pile decay 8.44 vs 0 (floor share 4.29).

**P-55 MARKER CORRECTION (attributed miss, mine).** The registered marker
("flow source W42N21-40-4 efficiency > 59.3") tracks CANDIDATE/admission
pricing, which reads RAW distance and never updates on paving - it cannot
fire. The substantive repricing DID land: cee2's route edge is 2:1 at
distance 70 (port-adjusted, paved-aware spawnParts) in this capture. The
prediction clock starts at t72786811 on the corrected marker (route-edge
ratio 2:1, already true). Attribution: I picked a field owned by the wrong
pricing side; admission pricing paved-blind is ALSO a real seam now named -
candidates are priced pessimistically vs the routes the same plan builds
(cee2 candidate d 82/net 5.93 beside its own 2:1/d 70 route edge).

**TOP-LINE DIAGNOSIS - the 8.44 decomposes into two mechanisms + one anomaly:**

E6: four mouths held CHRONIC (cee2 96%, cd94 77%, cedc 63%, cd8d 86% of
window; buffered 3.0-3.5k each). The buffer-full "gate" is DE-PRICING (spawn
priority), not suppression - the miner keeps mining (F3 gaps <= 1.0 e/t; the
account's "37.51 explained by heldFrac" is an upper bound, not a read).
The cost is the standing GROUND share (~1-1.9k/mouth over the 2000
container) decaying ~2 e/t each, plus the small-pile ceil floor 4.29
(spec-44's owner-gated scavenger case).

Stamp classification of the four mouths:
- cee2 ask 35 / fielded 32, exit=deadband; cd8d ask 21 / fielded 20,
  exit=deadband: mid-generation ask RISES (drain term + paved repricing)
  the worthABody dead-band defers BY DESIGN; shares (floor+remainder)
  cover the ask at natural turnover - self-healing <= 1 generation.
- cedc ask 21 / fielded 22, exit=staffed: the ZERO-MARGIN equilibrium -
  sustained carry prices removal == inflow, so a formed backlog is
  permanent until the drain term fields; pile stands just over 1000 where
  decay balances the residual margin.
- **cd94 ask 22 / fielded 44 (DOUBLE), exit=staffed, staged flat 1058t:
  the anomaly.** Live watch (5 snapshots, 90s apart): the 44-CARRY hauler
  arrived empty, took ~1118 of the 1671 pile, and LEFT AT EXACTLY HALF
  LOAD (1100/2200, seen en route twice) with 2000 banked in the container
  one tile away; visits every ~100-120t; removal/trip barely above
  inflow/trip => the pile never drains. Hypothesis #1 (stale
  dedicatedBuildSourceId freezing the mouth as construction fuel):
  FALSIFIED by live Memory read (undefined). Hypothesis #2 (depart-on-dry
  firing off a stale spot resolution): NOT verifiable from outside - the
  branch is invisible in captures.

**Per the method (one falsified hypothesis => instrument, don't
re-theorize): task #12 ships the DepartMeter.** Every CarryCorp depart()
now states its reason (full / yield / scavenge-dry / spot-dry); the haul
sizing stamp carries lastDepartReason/lastDepartFrac/lastDepartTick +
counts by reason (corps segment v16). Telemetry-only; red-first (4 meter
pins); 2068 unit green by parsed failing count.

PREDICTIONS (registered before deploy): (1) next capture >= 300t
post-deploy shows cd94's stamp dominated by a NON-"full" reason with
lastDepartFrac 0.4-0.7 - named candidate "spot-dry"; a "full" reading at
frac < 1.0 would instead indicate a capacity accounting bug, "yield" would
resurrect the dedication mechanism (post-facto Memory read could have
missed a transient stamp). (2) The deploy's global reset inflates X5 one
window (known effect, don't re-diagnose). (3) No behavior deltas -
telemetry-only; evacuation/controller move only with the paved convergence
already in flight.

## Cycle t72786811 close (verification t72787587) — the meter's falsification DISSOLVES the anomaly; paved admission ships

**DepartMeter verdict (v16 live, ~700t):** prediction #1 FALSIFIED exactly as
registered - every mining-hauler departure reads `full` at frac 1.0 (cd94 x2,
cee2 x3, all nine corps). No spot-dry, no yield, no partial. Chasing the
falsification cracked the case: a direct body read shows cd94's hauler is a
healthy 22C/11M (33 parts, capacity 1100, hits 3300/3300). The "half load"
was a FULL load; my "fielded 44 = 2x ask" was a misread of the corps census
body sum (44 CARRY = TWO 22C haulers, one in delivery-aware replacement
overlap). There was never an execution anomaly. Attribution: mine - I read
the corp-total census as one creep's body without checking part hits or
creep count. The meter did its job in one capture; keep it (it now
distinguishes damaged-full from healthy-full only via a body read - noted).

**The REAL top-line mechanism, one stroke, all four mouths:** the plan
prices round trips at 2d+2 (load+unload as one intent each, zero sink
service). Measured idleSink runs 12-27% per corp (cedc 0.266, cd94 0.20,
cd8d 0.17, cee2 0.124 - port queueing at the shared deposit, the DEP
gauge's 4-route port). That unmodeled trip overhead swallows the ~3-4%
margin the drain term buys, so removal ~= inflow, the staged stock stands,
and its ground share decays (~2 e/t per mouth = the L1 top line's mouth
half; the small-pile ceil floor 4.29 remains spec-44's owner-gated case).
Post-reset reads confirm the class: cd94 2488 and cee2 1818 DRAINING where
fleets turned over to current asks; cedc 3276 still ratcheting (worst
idleSink). **Next cycle's red-first candidate: price sink-service/queue
time into the round trip** (a structural term, NOT measured-duty feedback -
owner 2026-08-05: "not yet" on feeding data back to the planner).

**Paved-aware ADMISSION pricing ships this deploy** (the seam this cycle
named: candidates priced raw-1:1 beside their own 2:1 route edges).
`pavedNetEnergy`/`pavedSpawnPartsFor` in roadEconomics compose from
effectiveOneWayTiles + MOVE_PER_CARRY_* exactly as fill() prices edges;
unpaved swamp-free is bit-identical to the raw primitives (conformance
1e-9). selectProducers passes each source's pave receipt. Red-first: 5
roadEconomics pins + 1 CorpPlanner admission behavior test; 2074 unit
green; trio 3-0 VERIFIED BY PARSED COUNTS (storage-depot 7s, flow-handoff
4m, runt-economy 4m).

PREDICTIONS (registered before this deploy, exact arithmetic):
1. cee2 candidate reprices net 5.93 -> 6.51, parts 0.0525 -> 0.0408;
   efficiency 59.3 -> 65.1 - BOTH P-55 markers now fire (the original
   efficiency marker becomes live again; clock already started t72786811).
2. Paved remotes' plan nets rise (d50 +0.35, d77 +0.55, d85 +0.61 e/t) ->
   the SOURCE P&L positive-variance cluster (cee2 +0.68, d01f +1.08, cd8e
   +1.00, cbd5 +0.68) re-centers toward 0; cbd8's -0.49 goes MORE negative
   and becomes the honest worst row (investigate it next if chronic).
3. Funded parts drop ~0.05 p/t total -> global tranche headroom grows; the
   12th candidate (intel-W42N21-36-3 or intel-W41N23-23-39, both priced
   raw - no receipts) MAY admit. If one does, that is the P-55 J-curve
   event: the gate becomes controller+bank+construction >= 55 (reclass,
   registered at P-55).
4. Global reset inflates X5 one window (known).

### Deploy verification t72787749 (+95t): predictions land exactly; the 12th admission fires

1. cee2 candidate: **net 6.51 / parts 0.0408 / efficiency 65.1** - the exact
   pre-registered arithmetic, to the decimal. Both P-55 markers live.
2. Paved incumbents repriced up across the board (d32 82.1, d50 78.2, d55
   71.1, d77 66.2, d85 64.4 - the whole efficiency ladder shifted +2..+6).
3. **The tranche headroom admitted a 12th source: W41N25 (d 102, net 5.91,
   raw-priced - a NEW remote room)**, not one of the two named same-corridor
   candidates (both absent from this candidate list; their discovery state
   is a next-window read). This IS the P-55 J-curve event as registered:
   reservation + trunk-paving capex for a fresh room begins inside the
   measurement window, so the P-55 gate is now
   **controller + bank + construction >= 55** (investment reclass).
4. P&L variance re-centering (prediction #2) reads at the next full window.

Cycle verdict: **instrumented (DepartMeter, v16) + falsified-with-attribution
(the cd94 "anomaly" was my census misread; the meter's one capture dissolved
it) + fixed (paved admission, verified exact) + named (sink-service trip
overhead - next cycle's red-first candidate)**.

## Deploy: spec 45 sizing leg — the feeder volley-service floor (owner: "large enough to handle the spikes")

`volleyServiceCarry()` = LINK_CAPACITY/CARRY_CAPACITY = 16 lands in
primitives (both constants engine ground truth, no new numbers) and floors
the link-fed feeder body wherever the core link has INBOUND SENDERS (any
link that is neither core nor the withdraw-only ctrl — deposit ports and
source links alike, the same set LinkRunner loops). Applied in BOTH homes so
plan and runtime agree (F1): ControllerFeederCorp.getSpawnDemand (stamps
volleyFloor + inboundSenders) and infraSpawnLoad/infraSpawnEnergy (the
structurally-identical twins moved in the same commit; a link-fed room
without senders over-prices by the floor — accepted, conservative,
transient config). Red-first: 4 primitives pins + 2 corp behavior pins
(link-staged room: floor binds at 16 with senders, pure-relay room
bit-identical); the surviving "~1/6th" link-fed pricing pin re-narrated
honestly (~half now — the floor is the point). Unit 2080 green by parsed
count; trio 3-0 VERIFIED BY PARSED COUNTS (storage-depot 7s, flow-handoff
4m, runt-economy 4m).

PREDICTIONS (registered before deploy):
1. The NEXT capture's feeder sizing stamp reads volleyFloor 16,
   inboundSenders 2, neededCarry 16, wantedFeeders 1 (stamp updates every
   demand pass, purchase or not).
2. The plan's infra pricing rises ~+0.015 p/t (2x(16-4.8)/1499 at the live
   relay ~60): P4 infra line and F1 PLANNED both step up; measured follows
   at fleet turnover.
3. THE BODY ARRIVES AT NATURAL TURNOVER, not immediately: staffing is
   by-count (feeders >= wantedFeeders = 1) and the 4C incumbent holds the
   post until EOL (<= 1500t post-deploy). No mid-life churn for the
   linchpin — deliberate; if the post were ordered dark to force it, that
   would be the treadmill's cousin.
4. AFTER the 16C body lands: coreEmptyShare/hubClampShare improve
   DIRECTIONALLY (sizing alone cannot clear them — the arrivals-first
   sequencing legs of spec 45 are still unshipped; the five-gauge
   acceptance bar stays with them).
5. The deploy's global reset inflates X5 one window (known).

### Verification t72788704 (+64t post-deploy): the floor is live in both homes

Stamp reads EXACTLY as registered: `volleyFloor 16, inboundSenders 2,
neededCarry 16, wantedFeeders 1, feeders 1` — gate "staffed", the 4C
incumbent holds the post until EOL (prediction #3's shape, on schedule).
The floor dominates its own throughput term as designed (coreDrain 80 →
parked carry 4; floor 16 wins). Plan side moved with it: fleetCharge.infra
11.52 → 13.50 e/t (the floor's energy delta + W41N25's ninth remote
reserver). Predictions #2-#4 read at the next full windows.

## Cycle t72792889 — the raid episode priced; the attribution lens's structural blindness found and fixed (core v33)

**The window (4,185t) was a raid EPISODE on the expansion corridor**, and the
designed responses all engaged: CoreBuster on the invader occupation (the
account's new CAPITAL line, -1.24 e/t), guards up then stood down (41% of
recycle refunds), the hostile-route defund held W43N24's fleets at zero NEW
bodies (F2: cd8e/cd8d fielded 0p vs 22/33p declared - defund by priority,
nobody stranded, E2 = 0), X5 churn just 3%, S5 kept a 20% surge margin. The
episode's price, named: forgone mining -26.76 (F3: d017 1.1/10, cd8e 1.5/10,
cd8d 1.6/10 = the whole line), tombstones 1.46, reservation -4.00 U
(re-reserving the corridor), pile decay 11.06 (mouths behind the defund).
Controller still delivered 36.29 vs the slashed 32.28 plan (P7 1.18x);
bank flat; G1 101% income-funded. FY4852-M06 closed. NOT a defect - weather,
handled; the L1 spike is the episode's shadow and drains when the defund
lifts (the drain term prices the standing mouths).

**Standing-prediction checks:** feeder volley floor LANDED (32C standing =
2x16C replacement overlap; the 4C incumbent is gone - sizing-leg prediction
#3 confirmed). Paved-admission prediction #2 (P&L re-centering, cbd8 the
honest worst row): episode noise dominates every variance column - deferred
to a calm window, not judged. P-55 gate reads 37.33 this window (episode +
W41N25 J-curve, inside the registered reclass regime).

**THE CYCLE'S FINDING - task #9's instrument was structurally blind and the
episode proved it.** v32 counters over the window: killed cargo 9,203e;
booking-time flag caught 691e (7.5%); hostileAtDeath caught **332e (3.6%)**
- and 47% of kills are in the HOME room. Code read confirms the mechanism:
hostileRooms()'s all-clear path DELETES hostileUntil on any sighted-clear
tick, and the home room has PERMANENT vision - the mark evaporates within
ticks of every fight ending, before the loss meter books the tombstones.
The "0-8% raid-claimable" share every window has printed is a FLOOR
ARTIFACT of the lens, not a truth about the kills. **Fix (core v33,
telemetry-only): the all-clear RETAINS the closed window**
(roomIntel.hostileWindows, cap 3, from = the fresh-mark tick, legacy
fallback until-1500) and attribution reads live mark OR retained windows
(LossMeter.deathInHostileWindow, pure + pinned). 6 red-first tests; 2,086
unit green by parsed count.

**R1 PROTOCOL NOTE (comparability):** hostileAtDeath windows BEFORE v33 are
floor artifacts - the >= 10-window swap evidence RESTARTS at v33. Do not
mix v32 and v33 readings of the counter.

PREDICTIONS (registered before deploy): (1) the next hostile episode's
all-clear writes roomIntel.hostileWindows (readable via Memory API); (2)
in subsequent episode windows hostileAtDeath rises from the 3.6% floor
toward the true combat share - if it STAYS ~0 with home kills continuing,
the kills are genuinely not combat-window deaths and the home-kill mystery
reopens on a different mechanism (that would be a REAL finding, not a lens
artifact); (3) the deploy's global reset inflates X5 one window (known).

### Deploy verification t72793082 (+63t): v33 live, machinery armed

Core segment reads version 33; colony healthy through the reset (48 creeps,
spawns 0.82/0.80). Intel state at verification: W43N24 invader-reserved
until t72796044 (the occupation continues - cd8e/cd8d stay defunded by
design), W44N24/W44N25 hold STALE pre-v33 creep marks (until already past;
no vision to clear them) - their next sighting fires the v33 retention path
with the legacy until-1500 fallback and writes the first hostileWindows.
Prediction #1 lands there.

## Cycle t72793209 — SAME-LENS DEFUND: the plan stops pricing occupied rooms (methodology #12)

Owner flag, verbatim: "Something seems very wrong with all the foregone
mining and other variances." Verified by direct reads - the wrongness was
REAL and threefold: (1) the plan funded W43N24's two sources at rate 10
through a live invader occupation (2,446t remaining; both sources at
3000/3000 regen-stalled) and d017 while its corp fielded nothing - 30 e/t
of phantom capacity making forgone -41.25 and allocating budget margin
(construction 10, bank 33) that could not exist; (2) the corps' defund
exits returned WITHOUT stamping, so E6 quoted frozen pre-defund stamps
("staffing 1/1 buffered 3825" on corps with zero creeps whose containers
had decayed away); (3) W41N25's trunk builders walked a kill corridor while
the room's producer commission was dark (sequencing debt, spec 16/45
adjacent - named, not fixed this cycle).

**SHIPPED (live-behavior + ledger, one commit):**
- `PlannerSource.defunded` stamped by the ADAPTER from the SAME
  hostileRooms() lens the corps' defense gates read (invader reservations +
  creep marks; never for spawn rooms - un-funding home mid-raid would be
  the death spiral, not honesty). selectProducers excludes with verdict
  **"defunded"**; re-funds automatically on the intel all-clear. The trap
  list's same-lens rule, extended to the PLAN.
- HarvestCorp's two defund exits and CarryCorp's hostile exit now STAMP
  (gates "hostile-defund" / "transit-embargo") - no silent demand exits.
- E6 discards stamps older than the window (stale-stamp filter).
- **METHODOLOGY #12**: capacity excludes defunded sources, printed as a
  REVENUE memo line - a #11 capacity and a #12 capacity differ by exactly
  the occupied rooms' rates.
Red-first: defunded-verdict planner test + hostile-defund stamp pin; E6
staged stamps re-staged to live ticks (the filter's own rule); methodology
pin 11->12. Unit 2,088 green by parsed count; trio 3-0 by parsed counts.

PREDICTIONS (before deploy): (1) first post-deploy solve: cd8e/cd8d
verdicts funded->defunded, capacity 120->100, d017 stays funded (its
embargo is route-side); (2) the REVENUE memo prints "(excluded: 20.00 e/t
in 2 defunded source(s))" and forgone drops toward the operational
remainder (~-10..-18 with d017 still dark); (3) freed tranche ~0.094 p/t
may admit the next global candidate - the honest J-curve, P-55 reclass
gate already armed; (4) cd8e/cd8d stamp "hostile-defund"; d017 stamps
"transit-embargo" OR re-staffs if the corridor cleared - either named
outcome verifies; (5) P1 flags the funded->defunded flips this window
(expected, named); (6) when the W43N24 occupation ends the sources
RE-ADMIT automatically - the re-fund event is the mechanism's proof;
(7) reset inflates X5 one window.

### Deploy verification t72797359 (+62t): the lens is live and caught a fresh episode

Predictions land with honest deltas: cd8e/cd8d verdict **defunded** (at
rate 5 - their reservation lapsed during the occupation, so the rate lens
downgraded them too; extra honesty beyond the forecast), d017 stamps
**transit-embargo at the capture tick** (the silence is over; the corridor
is still dangerous), and capacity reads 120 -> 105. The unpredicted third
defund - cbd5/W44N23 - is a FRESH mark the same lens caught in real time:
the mechanism generalizing on day one. Memo line + forgone shift verify at
the next full window; the W43N24 re-admit event (occupation ends <=
t72795700 by decay, earlier by striker) is the standing watch.

Cycle verdict: **fixed (same-lens defund, methodology #12) + instrumented
(no silent demand exits, stale-stamp filter) + owner-flag confirmed real
and attributed.**

## Cycle t72799968 — scouting taxed the controller: the reserve counted prospects as payroll (valve 49→31→4.9→0.00, then reopened 59.7)

The owner's report ("great over 50 e/t, regressed when we expanded 11→12
remote sources") is confirmed measured — and the correlation is exact but the
causation is not spawn capacity. warchestTarget's income read summed every
graph source passing `isMinedIncomeId` — every scouted source whose REAL game
id intel recorded, funded or not (the t72444684 phantom guard's "accepted
residual", unbounded at this consumer). The scouting wave that admitted the
12th remote (d017, net 5.91, d=102) flipped six frontier sources
(W41N24/25, W42N24/25, W43N25) from intel-phantom to real ids in one step:

```
t72787778  11 funded  income 110  reserve  77,000  ctrl law 48.9 e/t
t72788704  12 funded  income 170  reserve 119,000  ctrl law 31.0  (M05→M06 cliff)
t72798237  12 funded  income 185  reserve 129,500  ctrl law  4.9
t72799968  11 funded  income 230  reserve 161,000  ctrl law  0.00  ← fully closed
```

bankFedControllerRate = floor + (banked − reserve)/1500 is the ONE VALVE's
law, so every newly-scouted real-id source permanently raised the reserve by
700 × its rate and throttled the published allocation — delivery 56 → 34.6
(FY4852-M05→M06) → 5.6 e/t (this window, G1: 12.93 e/t banking while the
controller starved; E4 read "at/near target" because the target itself was
poisoned). Compounding: 17 → 19 → 22 real ids as vision spread.

**CORRECTION (same cycle, owner question):** the first write-up claimed the
closed valve "spilled the surplus into construction sinks" — wrong as a
ladder mechanism, retracted. The bank absorbed the surplus (+12.93/t all
window), and construction (70) outranks the controller (~43 at 4.66M
remaining) regardless of the valve, so no energy was redirected. The 0.238
p/t construction plan tracks the 24 standing remote ROAD SITES
(source-local clusters at the local source's rate), not the valve. What the
poisoned reserve did to production is narrower: it held spendableBankSurplus
at zero, sterilizing the bank — no consumer sizing, no wartime build pace,
the exact asset-rich-cash-poor failure the dynamic reserve exists to
prevent. S5 0.97× is haul churn (54% of actual spawn output, +0.116 p/t
over plan; R1 10.7×, W45N25 miner dead at 39t) plus the road-site build
plan — an independent line, not a valve symptom. P-6 is RESTATED before
the check-in data: opening the valve ADDS ~0.05 p/t consumer demand, so S5
may stay tight short-term; durable relief runs through roads completing →
paved 2:1 repricing → the haul class (biggest in P4) shrinking. Forgone
mining is expected back near its ~7-8 e/t baseline only via that haul-side
path; if it stays elevated with the valve open, H1's carry under-ask is the
next cycle's top line.

**NOT the spawn-capacity handicap**: none of the SPAWN_PLAN_FRACTION=1.0
experiment's registered reversion criteria fired (P4 0.83–0.91x, S3 "not a
stall", X5 home 2%), the 12-source plan is spawn-feasible, and the 12th
source prices net-positive (its P&L row: +2.56 F this window). The handicap
stays lifted; S5 0.97× under valve-closure is the watch item to re-read
post-fix.

**Fix (a419c99, red-first):** the reserve's income basis is now
`bank.fundedMiningIncome(sourceVerdicts)` — the solve's own funded producer
rates, the same funded-only doctrine as the hub-sizing fix (t72437535).
Publish pin: FlowEconomy.update test (candidate-pool 35,000 vs funded
22,650, red confirmed pre-fix) + fundedMiningIncome unit pins. Gate: unit
2091-0; trio flow-handoff/runt-economy/storage-depot PASS; grid
reserve-adjacent 6/6 PASS (haul-t4 bank/feeder/spill, cons-t4, capguard,
journey); fid-t4/fid-t5 red — control run on pre-change src fails both
IDENTICALLY (same assertions, full-window), acquitted as the known
host-load-coupled sandbox class; baseline untouched.

**Deployed ~t72800100. Registered predictions → interim capture t72800193
(+~90t):** P-1 warchestTarget 161,000 → **77,000** = 700×110 funded ✓ EXACT.
P-2 published allocation 0.00 → **59.7** = (166,605−77,000)/1500 ✓ EXACT.
P-3..P-6 (ONE VALVE coherence, delivery ≥30 ramping to 45–60, bank slope
→~0, construction share draining from 0.238 p/t) pending the +3000t
check-in. Fiscal closes FY4853-M02 (59%), M03 (115%) written — M03 is the
terminal closed-valve phase sample.

Cycle verdict: **fixed (funded-income reserve basis, immediate mechanism
flip confirmed live) + attributed (the 11→12 correlation resolved to the
reserve seam, spawn-capacity hypothesis falsified with the experiment's own
criteria) — full-window delivery verification pending.**

**Owner steer (same cycle): attack the underlying cause, not the symptom
valves.** The pile gate / decay / churn lines are the runtime absorbing a
PRICING gap: the plan buys remote capacity below its measured cost, so the
affordable fleet is structurally smaller than the routes need. Two seams,
both instrumented: raid attrition priced ~1/10th measured (R1 8.38 vs 0.79
e/t; F1's +0.116 p/t unbudgeted hauler replacement is the subsidy made
visible), and route carry priced below measured need (H1 under-ask, E6
drain/route-sizing verdict). The retired SPAWN_PLAN_FRACTION handicap was
the BLUNT encoding of the same truth — honest per-route costing is the
sharp one: at true prices the marginal remote (d01f, chronic −1.63 vs its
own admission net) either clears with its true-size fleet funded or falls
out, and the pile gate stops managing the mismatch. Next cycle: accrue R1
windows toward the ≥10-window swap discipline; decompose H1's under-ask
from the carry pickup stamps and price the dominant term into carryPartsFor
(red-first). The armed check-in doubles as the CONTROL: with the reserve
honest, remaining forgone/pile variance IS the remote-cost gap.

### Same cycle, owner challenge #2 — "forgone was 7, jumped to 30, over many months, not invaders": CONFIRMED, invaders acquitted, handicap reversion criteria FIRED

The owner rejected the invader/haul-churn attribution as flimsy. The full
fiscal series (25 closes, FY4849-M07 → FY4853-M03) adjudicates:

```
era                     capacity   forgone actual        forgone+decay
FY4849-M07..FY4851-M10  100 (10)   0.4-14.6, mean ~4.7   ~6-25, bounded
FY4852-M01..M05         110 (11)   1.0-8.5               9.0-21.6
FY4852-M06 (12th funds) 120        14.91                 24.5
FY4853-M02              120        37.90                 44.5   ← the owner's "30"
FY4853-M03              110        0.00 + decay 26.07    26.1   (line-shift: mined-then-rotted)
```

Invaders acquitted BY TIMELINE: R1 read 0.70x priced in FY4852-M06 — its
quietest window in the table — while the climb was already underway; the
10.7x spike appears only in the final window. A multi-month monotone climb
cannot be a last-window noise burst. The role-exposure attribution repeated
the exact "raid story fails the evidence check" failure this spec logged on
2026-08-03.

What the series DOES support: admission overreach past the MEASURED spawn
ceiling. Demand arithmetic at FY4853-M03: plan-priced 0.607 p/t + measured
replacement overhead ~0.14 (F1 haulers +0.116, miners +0.028) ≈ 0.75 vs
0.667 physical. Spawn meters: utilization 0.97-0.98 with queue depth 4-8
across t72798237/t72799968/t72800193 (~2000t) — the t72676360 shape,
LITERALLY the handicap-lift experiment's registered reversion criterion,
sustained. The unfillable tail starved exactly where fidelity points: F3
d017 2.0/10 declared, F2 W45N25 38/84p (1900e miner dead at 39t),
construction −0.140 vs plan. P4's 0.83-0.91x "feasible" was circular — it
prices the plan's own under-priced demand. The earlier spawn-capacity
exoneration in this cycle's entry is RETRACTED on that basis: the owner's
original hypothesis (plan past practical limits) is CONFIRMED for the
mining line; the reserve bug was the coincident SECOND regression (score
side), same trigger event.

**Action: SPAWN_PLAN_FRACTION reverted 1.0 → 0.9 per the experiment's own
protocol** (criteria met ⇒ revert; "the number between 0.9 and 1.0 gets
measured, not argued"). Red-first: planHeadroom pin flipped to 0.9 (red
confirmed), constant reverted with the closure evidence on its doc; two
staged tests re-staged by their own leftover-unchanged convention; golden
master regenerated — delta is partsLeft −0.0333 in all four worlds, no
commission/route changes. Successor filed to EARN re-lifting: price
measured per-route replacement overhead into admission (the F1 gap becomes
a priced line), making the margin redundant before it is removed.

Registered predictions for the reversion deploy (sequenced AFTER the valve
check-in reads, so the two changes stay separately attributable): mining
tranche 0.36 global ⇒ 1-2 lowest-net/part remotes defund (capacity
110-120 → 100-110); util ≤0.93 and queue ≤3 within ~1500t; F2/F3 gaps
close on surviving routes; forgone+decay back under ~15 within 3000t;
score unaffected (the open valve owns it; sheds phantom capacity only).

### Same cycle, owner directives #3 — construction is the PRIMARY consumer colony-wide; actuals do NOT inform budgets yet

**Directive 1 (implemented, red-first): "I WANT construction to be the
primary consumer over controller if we have a construction project. Banking
excess it can't consume is fine."** The spec-33 wartime relegation already
encoded exactly this — but its lens was per-ROOM ("a backlog in the
controller's room"), and the live backlog at t72799968 was 24 REMOTE road
sites with home siteCount 0, so the home controller never relegated and the
bank-fed allocation outbid the very roads that fix the haul economics. The
wartime backlog is now summed COLONY-WIDE (threshold 3000 kept - a lone
road tile still never flaps upgrading): while it stands, every owned
controller relegates to its danger-gated floor, construction absorbs at its
own caps, and the residual BANKS - never the controller. Red pin: remote
4000-backlog world, controller relegated to 0, storage takes the residual
(was 41.75 to the controller); anti-flap control pinned beside it. NOTE for
the armed check-in: once this deploys, the score predictions (P-2/P-4) are
SUPERSEDED by design - the controller allocation drops to ~0 while the
24-site backlog drains, the bank absorbs (E4 slope positive is now the
INTENDED state), and score resumes on the accumulated surplus when the
backlog clears. The valve fix stays essential underneath: an honest reserve
is what makes the post-backlog reopening real.

**Directive 2 (successor re-filed): "Yes eventually we will feed actuals
back to inform the budget, but not quite yet. We have some poor behavior
that's causing variants that we don't want to encode as the budget."** The
earlier successor ("price measured per-route replacement overhead into
admission") is DEFERRED: current actuals carry defective behaviors (the
W45N25 fast-respawn loop, defund-window replacement churn) that a
calibrated budget would enshrine as legitimate cost. Revised order: (1) fix
the behaviors driving the overhead, measured down (X5/R1 lines); (2) only
then calibrate admission prices from clean actuals; the 0.9 margin carries
until (2) lands. This supersedes the "successor filed" line in the
reversion entry above.

### Cycle t72801151 — valve verification at +1051t; combined deploy (0.9 reversion + colony-wide wartime)

Valve-only verification (capture t72801151): P-1 HOLDS (reserve pinned
77,000 = 700x110, scouting no longer ratchets it); P-2 TRACKS EXACTLY
(allocation 41.66 = (139,493-77,000)/1500, the bank draining INTO the
controller 166.6k -> 139.5k as designed); delivery resumed (rclProgress
+67,238 over ~2900t spanning the closed-valve tail, ~23 e/t and rising);
P-6 as restated post-correction - spawn still saturated (util 0.98/1.0,
q 7-8), the valve added consumer demand, relief is the reversion's job.
Verdict on the valve fix: CONFIRMED live, both immediate predictions exact,
delivery recovery underway.

Combined bundle DEPLOYED at ~t72801250 (gate: unit 2093-0, trio 3-0 on the
combined dist). Registered predictions: REVERSION - 1-2 lowest net/part
remotes defund within a solve (funded -> ~90-100 e/t), warchest follows the
funded set down, util <=0.93 and queue <=3 within ~1500t, F2/F3 close on
survivors, forgone+decay < 15 e/t within 3000t. WARTIME - published
controller allocation -> ~0 while the ~24-site backlog stands (BY DESIGN,
supersedes P-2/P-4 score expectations), feeder to headroom-only, upgraders
drain to floor, construction funded at its absorb caps, bank slope positive
INTENDED. WATCH ITEM: P8 must show actual build consumption - the
FY4852-M06 CREW IDLE precedent is the named risk class ("poor behavior"
the owner flagged); if construction is funded but idle with the controller
relegated, that is the next cycle's incident, not a reason to re-open the
controller.

### Cycle t72801208 — the combined deploy's first solve caught a PHANTOM FUNDING: intel prospects are not candidates

Immediate reads on the combined deploy (capture +~50t): WARTIME EXACT -
controller sink demand 0 (was 41.66), three construction sinks at their
10.0 e/t absorb caps, residual banking. REVERSION - d017 shed as predicted,
warchest tracked instantly (73,500 = 700 x funded 105).

THE SURPRISE the tightened tranche exposed: `source-intel-W45N23-20-16` -
an intel PHANTOM (position-only, no real game id) - FUNDED with a miner
commissioned at d=140, net 1.09, rate 5. Mechanism: the greedy net/part
fill does not stop at the first budget breach; d017 (net/part 91, parts
0.065) breached the 0.36 tranche at cum 0.306, then the SMALLER phantom
(net/part 22, parts 0.050) slipped into the residual gap. Phantom
economics are fabricated (unreserved 5 e/t guess, no container, no id) -
and funding one guarantees an id flip when vision lands, orphan/rename
churn by construction. This is the mechanism behind the W45N25
misadventure (harvest-6-34, the same positional-id pattern: 84p declared,
1900e miner dead at 39t, X5's worst row) - the first named "poor behavior"
under the owner's directive 2, fixed rather than budgeted around.

Fix (red-first): producer selection now applies the SAME isMinedIncomeId
lens the income guard uses (t72444684, one home) - an intel-id source is
stamped verdict "prospect" and never enters candidates; it becomes a
candidate the solve after vision records its real id. Union extended
(SourceVerdict + "prospect"). Pin: intel source with budget slack never
funds, both id forms stamped, no phantom routes. Unit 2094-0; trio running
on the bundle before deploy. The knapsack residual-fill itself stays (for
REAL candidates it is rational tranche-filling); noted for the record.

### Cycle addendum — the Z-builder existed all along; now it is sized to its fuel

Owner wish: "It would be so great to have a remote builder using that 6k
energy like to build the road Z-to-A in parallel." Investigation: the wish
is the owner's OWN 2026-07-21 ruling, already implemented end to end - the
remote work-room rung fields a pile-funded local builder when road sites
stand (ConstructionCorp.getSpawnDemand), work()'s remote branch builds any
local site from local energy (no tankers, buildEnergy uncapped), and the
plan carries the trunk split (sinks construction-road-A-… 8.52 e/t /
construction-road-Z-… 1.48 e/t at t72801354). A Z-builder was STANDING in
W43N21: building-W43N21-construction, one 4-part runt - five sibling
remote corps in the same shape.

The measured gap was SIZING + VISIBILITY: the Z-plan reused the
maintenance body (buildUpgraderBody ≤550, 2 WORK; fielded as a 4-part runt
under scarcity), blind to the 6,004 staged at cd98's mouth - while the
HOME crew tanker-hauled energy into the very room whose pile was rotting.
And the remote branch exported NO sizing stamp (sizing.keys=[] on all six
remote corps - invisible to triage).

Fix (red-first, unit 2098-0): the Z-builder's WORK sizes from the mouth's
staged stock - the SAME sourceBufferStock lens E6 and the miner gate read
- at spec 33's wartime burst pace (stock/(CREEP_LIFETIME/3), 5 e/WORK-t),
clamped 2..5; desiredCost follows (minCost stays the maintenance floor so
scarcity still fields a starter - the E6 dark-source lesson). The branch
now stamps {gate: pile-road|pile-container, staged, roadSites, zWork}.
At cd98's 6.5k: 3 WORK ≈ 15 e/t potential against the pile - the Z-to-A
parallel build, fueled by energy that was decaying anyway.

### Same session — the budget-staleness trigger removed on the owner's correction (a hazard that wasn't)

Spec 46 phase A briefly shipped a budget-staleness trigger, justified by
"a month-old controller valve could keep a standing fleet drawing against a
bank that has since fallen through its reserve." The owner corrected the
premise: *"I'm ok with eating the surplus. The consumption is sized to
consume the surplus so it's a very safe allocation."*

Verified in code, not conceded: `SURPLUS_DRAIN_TICKS == CREEP_LIFETIME ==
PLAN_BUDGET_INTERVAL == 1500`. The draw is (banked − reserve)/1500 e/t held
for a 1500-tick term, so it consumes EXACTLY the surplus it was priced from
and lands AT the reserve — with a month of income arriving on top, above it.
The valve is self-liquidating over precisely the budget's term (bank.ts's
own design note: "the bodies it funds die naturally as it empties"). The
hazard cannot arise from this valve; if the bank ever does fall through the
reserve, the CAUSE is elsewhere and that is the signal worth detecting.

Both the mechanism and its earlier implementation flaw (law-vs-published
would have re-forced every debounce window forever in the live wartime
state) are recorded in spec 46. Removed: the thresholds, the snapshot
fields, `Memory.budgetLawRate`, its publish site, and 6 tests. Phase A is
now the cadence plus the unchanged spec-36 structural triggers — exactly
what the directive asked for, and one fewer mechanism than the session
nearly shipped. Unit 2101-0.

Methodology note for future sessions: this is the second time in one
session that a mechanism I added to guard a monthly budget was wrong in a
way the OWNER caught (the first was the ladder story for construction).
Both times the fix was to delete the mechanism, not patch it — the trap
list's "question the mechanism, not just its failure" applies to mechanisms
added defensively, not only to ones that have already failed live.

## Cycle t72804439 — FIRST CLEAN MONTH-CADENCE WINDOW: P1 flap ZERO; the upgrader swarm-cap deadlock found

The first deploy-free window since the cadence shipped (t72802844 -> t72804439,
1595t, no global resets). Registered prediction CONFIRMED: **P1 plan flap 0
sources, "stable vs baseline"** - against 3 flips in each of the two prior
windows, including the d017 tranche-edge flap this spec was written around.
The funded set held all window; solves landed at the 72804000 boundary. S3
util 0.97 with "head guard@390 vs bank 2366 AFFORDABLE+IDLE" (not a stall).
Forgone recovered to 7.21 (was 18.95 in the reset-contaminated window);
residual back to -6.21 (was -20.81); tombstones 1.40 (was 3.89) with kills
back inside the raid story (5% in intel-hostile rooms vs 0% before).

**TOP LINE: the controller took 27.32 e/t of a 60.21 budget (P7 0.66x) while
the residual banked at +14.83 e/t (G1 under-spending; E4 surplus 87,348 and
climbing).** The stamps name the mechanism exactly, and it is the twin of the
t72706408 count-vs-capacity bug one gate lower:

```
allocated 60.206, affordableWork ~30 (the body 5600 capacity COULD build)
  -> targetCount = ceil(60.21/30) = 2
bodies actually built at ~14.5 WORK (energy AVAILABLE when the spawn fires;
  "recycled why: runt-upsize 83%" in the same window confirms it)
  -> 4 creeps x 14.5 = 58 WORK  <  60.21 allocated  => NOT satisfied
  -> getCreepCount() 4 >= targetCount*2 = 4          => "swarm-cap", NO demand
```

The fleet is permanently one body short of its own allocation and CANNOT
order it, with the parking ring 8 wide and 4 tiles empty. The fleet was
measured oscillating 4 -> 2 -> 4 bodies across the three captures while
targetCount sat at 2 in every one. `upgraderFleetSatisfied` (the 2026-08-04
fix) correctly reports "not satisfied"; the very next line then refuses to
act on it.

FIX (red-first, unit 2105-0): `upgraderSwarmCap(targetCount, parking,
fieldedWork, allocated)` - a WORK-SHORT fleet is bounded by the PARKING ring
(the cap's own stated reason: "parking tiles are few"), a covered fleet keeps
the tight 2x overlap allowance so a stale/huge allocation still cannot buy a
swarm. ONLY EVER RELAXES - a ring narrower than the allowance keeps the
allowance, so no room's replacement is stranded; targetCount is already
parking-bounded, so the relaxed branch cannot exceed the ring by more than
that allowance. Stamped as `swarmCap` beside the existing demand verdict.

Registered predictions: upgrader fleet grows past 4 bodies toward 8 parking
tiles until fieldedWork >= allocated; P7 -> ~1.0x; G1 under-spending closes
(bank slope -> ~0 or negative as the surplus is consumed); E4 surplus stops
climbing from 87,348; delivered controller e/t roughly doubles toward the
60 e/t budget. WATCH: S5 (0.88x, 12% margin) may tighten as upgrader bodies
join the queue - if it crosses the reversion criteria the ordering between
consumer growth and spawn headroom is the next question, not a re-cap.

### Owner correction, same cycle — "why do we even need 8 spots at all?" The parking ring was a symptom

Owner 2026-08-05, on the swarm-cap fix shipped minutes earlier: *"With the
amount of work why do we even need 8 spots at all? We can make creeps big
enough to avoid that constraint."*

The arithmetic confirms it. At RCL7 capacity (5600) a containerFed upgrader
packs **39 WORK for 4,450e in 50 parts** - MAX_BODY_PARTS binds, not energy.
So a 60.21 allocation wants TWO bodies (39 + 21), and `upgraderTargetCount`
computes exactly 2. The parking ring is irrelevant at that size; it only
binds on a fleet made of runts.

And runts were being bought. The order size is `min(affordableWork,
ceil(allocated - fieldedWork))` with NO floor, so once the fleet is near its
allocation the gap is a 2-6 WORK sliver and the corp spends a whole body on
it - a body that then holds a parking slot for its full 1500-tick life.
Measured t72804439: 4 bodies carrying 58 WORK (one ~39 plus three ~6-WORK
slivers) where two bodies would have carried 60, with "recycled why:
runt-upsize 83%" in the same window naming the churn that follows. This is
the upgrader's version of the even-share treadmill the HAULERS were cured of
on 2026-08-03 - the same disease, on the post nobody re-checked.

FIX: `upgraderWorthABody` delegates to the SAME predicate the cure used
(corps/recycle.worthABody) rather than inventing a second rule that could
drift - a deficit under HALF a body share is not worth a purchase, it rides
to EOL which re-sizes for free. Sizing to the gap is KEPT (it makes the
second body 21, not a wasteful 39); only the sliver purchase goes. Stamped
`demand: "sliver"`.

BOOTSTRAP EXEMPT, on the hauler doctrine's own terms ("Bootstrap keeps every
crank - escape velocity"): the spawn harness caught it immediately - at 800
capacity a body affords 6 WORK, so a 20 e/t allocation leaves a 2-WORK tail
and the mature rule would abandon ~10% of the allocation permanently (vs
~4% at RCL7), in exactly the regime where controller progress is what buys
the capacity that makes big bodies possible. Maturity is the same lens the
haulers use: storage-backed. Unit 2111-0.

**The swarm-cap relaxation shipped an hour earlier is now correctly a
LOW-RCL SAFETY VALVE, not the fix.** It is dormant wherever bodies are big
(the fleet reaches fieldedWork >= allocated in two bodies and never touches
the cap); it still matters at RCL2-4 where 4-6 WORK bodies genuinely need
headcount. Kept, re-scoped, and named as such - the owner's question moved
the fix one layer down to where the mechanism actually was.

Methodology note, third instance this session: the owner has now twice
redirected a defensive mechanism to the real cause (the construction ladder
story, the budget-staleness trigger) and once re-scoped one to its honest
role. The pattern to carry: when a cap is what's binding, ask what makes the
cap bind before relaxing the cap.

## Cycle t72805426 — VERIFIED: the controller valve is delivering; the leak moves to the haul side

Window t72804439 -> t72805426 (987t). The registered predictions for the
upgrader fleet fix are **CONFIRMED**:

```
                        t72804439        t72805426
  controller delivered   27.32 e/t        58.16 e/t   (budget 52.16 -> +6.00 F)
  P7                     0.66x            OVER plan
  bank slope            +14.83/t         -16.05/t     (160,848 -> 145,003)
  G1                    UNDER-SPENDING    "72% of the score is income-funded"
  upgrader demand exit   "swarm-cap"      "staffed"   (fieldedWork 59 >= alloc 52.16)
```

The fleet reached its allocation and the surplus is now being CONSUMED, which
is exactly the owner's 2026-08-05 ruling ("I'm ok with eating the surplus")
playing out: 58 e/t to the controller funded 72% from income and the rest
from a bank drawing down toward its reserve. rclProgress +57,407 over 987t.

**ATTRIBUTION, honestly bounded.** The big-body rule deployed only ~226t
before this capture and the fleet shape is UNCHANGED (4 creeps, 59 WORK, 4
CARRY). So this window measures the SWARM-CAP fix plus natural regrowth, NOT
the big-body rule - whose own prediction (2 bodies of ~39+21 rather than 4
of ~15) needs a full spawn generation and is still open. The earlier 27.32
figure was likewise a window AVERAGE over a period when the fleet was
rebuilding from 2 creeps/43 WORK; the standing fleet converts ~1:1
WORK->e/t, which is what 59 WORK / 58.16 e/t now shows.

**Ring caveat**: the blackbox ring spans only 165t after the deploy resets,
so F1 (1.15x), X5 (0.07) and R1 (8.30x) are computed over that short ring
and are NOT comparable to full-window readings. Do not act on them until a
clean ring accumulates.

**NEXT WORK ITEM - the leak moved, and it is the HAUL side.** With the
controller now consuming 58 e/t the pressure landed downstream, and three
rows agree on where:

- L1 FAIL: pile decay **11.04 e/t** (up from 9.06) - the worst loss line.
- E6: **4 of 10 miner ops deferred, three CHRONIC** (cee0 62%, cedc 99%,
  cd94 90% of window) with buffers 2,087-3,703.
- H1: duty **0.74**, idleSink 0.26 of which **0.21 is EN-ROUTE** - the row's
  own verdict is "approach-lane congestion (traffic / standing blocker at
  the core)", a different failure from the route-sizing story E6 defaults to.

That H1 en-route split is the sharpest NEW signal of the session and it is
NOT a sizing question - which matters, because two of today's three upgrader
fixes were sizing fixes and the third (the owner's) showed sizing was the
wrong layer. Next cycle should read the carry pickup stamps and the core
approach lanes before touching any route size.

Cycle verdict: **VERIFIED (the delivery prediction confirmed with a 2.1x
measured swing) + the top line relocated to haulage with three agreeing
rows.**

## Cycle t72807566 — spec 45 legs VERIFIED: clamping halved, and the traffic premise dissolved with it

Window t72805426 -> t72807566 (2140t; two deploys inside it, so spawn-side
lines carry reset contamination - named, not excused). The link gauges are
windowed over their own 249t post-deploy sample and are clean.

**CONFIRMED - the sequencing defect is halved:**

```
                     baseline      now      prediction
  hubClampShare        0.625  ->  0.296     toward 0        CONFIRMED
  coreCongestedShare   0.116  ->  0.068     (implied)       CONFIRMED
  coreEmptyShare       0.276  ->  0.348     UP = landing room  CONFIRMED
  coreFillAvg            252  ->    227     (implied)       CONFIRMED
  taxRate               3.37  ->   3.04     down (side effect) CONFIRMED
  toHubRate             48.2  ->   49.8     -               throughput UP
```

**MISSED, and both were MIS-SPECIFIED predictions rather than failures of
the fix** - worth recording as prediction-quality lessons:

- `hubVolleyAvg` 500 -> 459, predicted "toward full 800". Wrong metric: with
  the core kept empty and clamping halved, a port fires when it reaches
  threshold instead of accumulating while blocked. SMALLER, MORE FREQUENT
  volleys with higher delivered throughput (toHubRate up) is the success
  shape, not the failure shape. Full volleys are efficiency PER COOLDOWN,
  which is only the objective when the sender is cooldown-bound.
- `directShare` 0.25 -> 0.225, predicted up. Also backwards on reflection:
  leg 2 keeps the core EMPTY, which raises `deliverCore` in
  routeSourceVolley's throughput comparison, so ports rationally choose the
  core more often. Direct share falling is a CONSEQUENCE of leg 2 working.
  Energy still reaches the controller (51.6 e/t) and delivery is exactly on
  plan, so nothing is lost - the tax is the only thing traded, which the
  owner already ruled is not the objective.

**THE FINDING - the registered NON-prediction fired:**

```
  H1 duty     0.74 -> 0.86
    idleSink  0.26 -> 0.07
      atSink  0.05 -> 0.03
      enRoute 0.21 -> 0.04     <- spec 47's entire traffic premise, -81%
```

Spec 45's deploy note explicitly registered enRoute as NOT predicted to move
("if it falls anyway, the two were coupled and that is itself a finding").
It fell 81%. Haulers reading as "idle en route" were largely waiting on a
CLAMPED LINK NETWORK - a deposit-route hauler whose port is full has nowhere
to put its load, and from the duty meter that is indistinguishable from
traffic. Spec 47 is PARKED accordingly: the layout rebuild loses its evidence
entirely (and it was the only irreversible option), the conduit loses most of
its case at 4% residual, and the mothership's target (atSink) is now 0.03 -
not worth a body by the same worthABody discipline it would have been sized
with. The structure-inventory gap survives on its own merits.

This is the method paying off exactly as designed: the signal was never
localized, spec 14 said instrument before building, and the thing that
actually moved it was a fix in a different subsystem. Had spec 47 been built
first, we would own a tractor-beam conduit for a link scheduling bug.

**Delivery:** controller 45.03 e/t actual vs 44.98 budget (**P7 1.0x**,
+0.05 F). rclProgress +96,374 over 2140t. E6 3 of 12 deferred (was 5 of 13);
pile decay 7.98 (was 9.06); H1 ground-piled 1,837e.

**STILL OPEN / next:** forgone mining 7.21 -> 17.50 in this window - the one
line that worsened, against two global resets inside the window, so it is
NOT yet attributable; the next clean window decides. L1 remains the standing
FAIL (pile decay 7.98 vs a 0.00 budget - spec 42-A's unpriced-loss gap, not
a new defect). G1 shows 5.25 e/t still banking.

Cycle verdict: **VERIFIED (clamp share halved on a clean 249t gauge window) +
a registered non-prediction falsified in the informative direction, which
parked an entire spec before it was built.**

## Cycle t72809037 — P0: THE HEARTBEAT'S OWN LADDER RUNG WAS INERT

**Window** 906t from t72808131. Methodology #12. The ledger named **L1** as
TOP LINE (pile decay 6.06 vs a 0.00 budget), but a live incident preempted it,
and the incident is the one the owner had made doctrine the same day.

### The finding

`controllerFeeder` creeps **0**, `feederActive false`, `wantedFeeders 1`, gate
`"demand"` — standing **190 ticks unfunded with 153,760 banked**, ranked
**4th** in the agenda behind two haulers and a coreBuster campaign, while the
spawn finished 7 other bodies (util 0.96, queueDepth 8).

Owner 2026-08-06: *"We have to assume the tender is working. It's a heart
beat. It's non negotiable. The body dies slowly if there's issues there."*
The doctrine's first consequence is that a measurement suggesting the
heartbeat is failing is **a P0 bug in the heartbeat itself**, never a reason
for a compensating rule elsewhere. So this preempts L1.

### The mechanism — a rung that could never be reached

`FEEDER_LINCHPIN = 150` exists precisely to implement the doctrine, and its
docstring states the comparison it intended:

> *"Above the miner band (HarvestCorp: `100 + efficiency*0.5`, efficiency <
> 100, so miners top out just under 150) so the linchpin outranks the
> marginal producer."*

**That comparison never happened.** `spawnPriority` adds `INCOME_TIER` (1e6)
to any demand with `producesIncome` + a `groupId`; the feeder declares
`producesIncome: false`. So 150 was being compared against **1_000_146**, and
the first feeder ranked below EVERY income demand, always. The `infrastructure`
flag does not rescue it — by its own contract it *"never displaces an actual
buy"*, only pierces holds. The sole rescue was the 300-tick anti-starvation
lift, i.e. **the heartbeat stops for up to 300 ticks after every death.** That
is the slow death the owner named, written into the ladder.

`TENDER_BOOTSTRAP = 150` carries the identical claim (*"outbids the whole
income range ... by VALUE alone"*) and was inert for the identical reason.

### The fix

A declared `linchpin` flag (semantic, not role-keyed — spec 17) lifting the
demand to `INCOME_TIER + HEARTBEAT`, where `HEARTBEAT = 5_000` sits between
`STARTED` (1e3) and `BLOCKING` (1e4): **above every scaling producer, below
every blocking one** — exactly what the rungs always claimed.

The first attempt lifted by `INCOME_TIER` alone and the test still failed,
1_000_150 against 1_001_146: a started source's scaling top-up carries
`STARTED`. Racing the miner band on **4 points of value** is the same
fragility that made the rung inert to begin with, so the ordering is now a
separator, not a value race.

Declared only in the state each rung was written for: `firstFeeder && !drained`
(a DRAINED bank keeps `FEEDER_DRAINED` below the miners — income rebuilds
first, owner 2026-07-24) and the tender's `bootstrap` emergency only. Both stay
`blocking: false`, so topping the rung can never wall the bank, and both are
staffing-gated so neither can become the W2N6 blocking STREAM.

### The rest of the window (recorded, not actioned)

An invader core stood in W43N24 and the colony paid for it: creeps **53 → 41**,
fielded CARRY **375 → 282 (−25%)**, reservation creeps 9 → 3. R1 measured
**7.74 e/t** of attrition against 0.75 priced (**10.3x**). The carry shortfall
is what E6 reports — **5 of 11** miner ops deferred (cedc held 100% of the
window, cee0 99%, cd94 91%) with H1 duty **0.88** and haulers BUSY, so the
sources back up because there is not enough CARRY fielded, not because haulers
idle. That is the honest reading of L1's pile decay: a raid-attrition
transient, and the ledger's own E6 row says it — *"the leak is HAULING (drain
term / route sizing / churn), not the miner"*.

Two things improved and should not be lost in the above: **P7 controller
delivery 39.33 → 47.90 e/t** (the upgrader replacement landed; X1 workUtil
0.99, dry 0.01) and **P1 plan flap 0 sources, stable** — the defund-stranding
that dominated last cycle's `idleSink` resolved on its own (H1 idleSink
0.18 → 0.06, atSink 0.02, enRoute 0.04; E2 stranded fleet 0).

**Cycle verdict: FIXED (a doctrine the code claimed but never executed).**

### Registered predictions for the t72809037 deploy (check at +200t or more)

The falsifiers matter more than the confirmations here, because this change
lifts a demand ABOVE the income tier — the one direction the ladder's whole
history warns about (the W2N6 blocking stream, the cold-start deadlock).

- **`controllerFeeder` creeps 0 → 1 and `feederActive` false → true.** The
  direct target. Latency from demand to body should be a handful of ticks, not
  the 190+ measured (and never the 300-tick starvation lift).
- **`gate` "demand" → "staffed"** on the feeder's sizing stamp.
- **E4** bank slope resumes a damped draw with the feeder alive (it read
  −7.04/t with `feederActive false`, "relay between generations").
- **NOT predicted to move: E6, L1 pile decay, forgone mining.** Those are the
  raid-attrition carry shortfall (CARRY 375 → 282) and they recover as the
  fleet rebuilds, on their own clock. If they improve, that is coupling, not
  this fix, and must not be claimed for it.

**FALSIFIERS — any one of these means HEARTBEAT (5000) is set too high:**

1. A blocking FIRST MINER or first hauler is displaced by a feeder/tender in
   the agenda (the tier is explicitly below `BLOCKING`; flow-handoff green is
   the sim guard, this is the live one).
2. Fielded CARRY recovery *slows* versus the pre-deploy trend — the raid
   rebuild is income work and must not be crowded out by the lift.
3. Feeder/tender demands appear MORE than staffing-gated frequency, i.e. the
   lift turns a one-body demand into a stream (X5 churn on the infra roles).

If (1) or (3) fires, the fix is to narrow the DECLARATION, not to lower the
tier: the tier expresses the doctrine correctly, and a state where the
heartbeat should not be lifted is a state the corp should not declare
`linchpin` in.

### Deploy verification t72809447 (+410t): heartbeat alive, but ATTRIBUTION WITHHELD

```
             creeps   CARRY   WORK   feeder   feederActive   rclProgress   storage
  t72808131     53     375    129      1          true         6623076     160135
  t72809037     41     282    113      0          FALSE        6666473     153760
  t72809447     50     282    115      1          true         6689008     147021
```

- **Feeder 0 → 1, `feederActive` false → true, gate "demand" → "staffed"**,
  16 CARRY (its volley-service floor), and **queue depth 0 on BOTH spawns** —
  the 8-deep backlog cleared.
- **`rclProgress` +22,535 over 410t = 54.96 pts/t against a plan allocation of
  54.19 — P7 ≈ 1.01x.** The best plan-vs-actual reading this program has
  recorded on the controller line.
- Fleet rebuilding: creeps 41 → 50, reservation 3 → 8, coreBuster 0 → 3 (the
  campaign is running). CARRY flat at 282 — the raid shortfall has stopped
  deepening but has not yet recovered, exactly as predicted for E6/L1.

**ATTRIBUTION IS WITHHELD, and this is the honest part.** The feeder demand
stood `since 72808847`; `STARVATION_THRESHOLD` is 300 ticks, so the
anti-starvation backstop would have lifted it at ~t72809147 **whether or not
this fix shipped** — and the deploy landed in that same neighbourhood. So the
revival is NOT evidence for the change. What the fix alters is the latency of
the NEXT death, which this window does not contain.

The fix is proven where it can be: 6 red-first unit assertions, and four grid
cells green including the two that guard falsifier (1) —
`spawn-first-miner-outranks-all` [P] and
`spawn-93-fresh-miner-beats-scaling-hauler` [P] ("the first fresh creep is B's
first miner" @ tick 11), plus `haul-t4-feeder-fields-for-bank` [P] (feeder
fielded @ tick 11) and `haul-t4-tender-death-failsafe` [P] (replacement tender
@ tick 44). BOT LEVEL 4 unchanged.

**No falsifier tripped**: no blocking miner displaced, no infra stream (tender
1, feeder 1, staffing-gated as designed), CARRY not falling further.

**The live measurement that decides it is the next feeder death** — record
demand-to-body latency then. Pre-fix it was 190+ ticks and rising toward the
300-tick backstop; post-fix it should be a handful.

**Cycle verdict: FIXED + INSTRUMENTED, live attribution PENDING one death.**

## Cycle t72810328 — THE PORT METER PAID FOR ITSELF IN ONE WINDOW

**Window** 881t from t72809447, methodology #12, full ring. Ledger TOP LINE is
**L1** again (pile decay 8.80 vs a 0.00 budget) — and this time the chain from
that number to its mechanism is complete, because the meter shipped last cycle
returned its first data.

### The colony is otherwise the healthiest it has measured

**P7 controller 53.01 e/t vs a 50.92 plan — +2.09 FAVOURABLE**, the first time
delivery has come in ABOVE the allocation. Forgone mining **0.00** (mined
100.00 of a 100.00 capacity). H1 duty **0.94**. P1 flap **0**, E2 stranded
**0**, E5 runts **0**, X3 untracked 2. The heartbeat fix holds: `feederActive
true`, and the bank is drawing down (−4.67/t) rather than rotting.

### The whole of L1 localizes to ONE source, and the meter names why

E6 reports **1 of 10** miner ops deferred: `cedc`, buffered **3045** against a
2000 container cap, `gate "buffer-full"`, held **100% of the window** —
CHRONIC across three captures.

It is not a sizing miss. `carryNeeded 21`, fielded **20.5** — the fleet is
sized correctly and the hauler is BUSY (`duty 0.892`, `idleSource 0.002`). But:

```
  departs {full: 4} over 440t x 1023e/trip  =  9.30 e/t delivered
  the source produces                          10.00 e/t
  ------------------------------------------------------------
  DEFICIT                                       0.70 e/t   -> the pile never clears
```

And the new port meter says exactly where the 0.70 goes:

```
  portDeposits 173   portWaits 24   portFallbacks 0   portWaitFrac 0.122
  duty 0.892, idleSink 0.106 (atSink 0.034)   <- the idle IS at the sink
```

**12.2% of this hauler's at-port decision ticks are spent held at a FULL port
link.** That stretches its round trip from ~80 ticks to ~110, which drops
delivery below the source's production rate, which is why a pile that looks
static (3205 → 3045 over 768t) never actually clears — it sits above the
container cap rotting, and that rot is L1's top line.

**One capture, one gauge, and "the pile is stuck" became a measured causal
chain.** That is the whole argument for instrumenting before building: the
meter cost a telemetry-only deploy and immediately converted the cycle's
biggest number into a mechanism with a known fix.

### The fix is the container buffer, and the same number sizes it

The buffer's INFLOW is the **overflow rate**, not the port's flow — the
container only receives while the link is refusing:

```
  0.122 x 40 e/t port flow  =  ~4.9 e/t into the container
  a 1-CARRY link miner is a 25 e/t parked relay (invert parkedRelayCarry),
  ~15 e/t spare after its own 10 e/t harvest
  ->  4.9 << 15 : the miner alone drains it, no relay body needed
```

So the dedicated relay corp — blocked on spec 39's spawn-authority ratchet
(see spec 47) — is **not needed at this flow**, and the owner's earlier ullage
insight carries the whole leg. Shipped as an opportunistic drain in
`HarvestCorp`: strictly gated on the link having room and on spare CARRY
*after* this tick's harvest, so the drain can never displace the mining it
serves. No new corp, no new demand site, no new body.

That closes legs A (placement), B (the hauler's drop) and C (the drain), so
the three deploy together.

### Registered predictions

- **`portWaitFrac` 0.122 → toward 0** on port-routed corps once a container
  stands. THE direct target.
- **`cedc` delivery 9.30 → above 10.00 e/t**, and its buffer below the 2000
  cap. This is the one that matters: the pile only clears if delivery exceeds
  production.
- **L1 pile decay 8.80 → down.** NOT to zero — cedc is ~2 e/t of it and other
  mouths carry the rest.
- **NOT predicted to move**: P7 (already +2.09 F), forgone (already 0.00).
  Any change there is coupling, not this fix.

**FALSIFIER:** if `portWaitFrac` falls while `cedc` delivery does NOT rise, the
wait was not what was costing the trips and the container bought parked energy
instead of hauler time — the exact net-negative the "do not deploy A+B alone"
note warned about. Revert the placement rung in that case, not the meter.

**Cycle verdict: DIAGNOSED — a top-line leak reduced to a measured mechanism
by an instrument shipped one cycle earlier, with the fix built and gated.**

## Cycle t72811290 — PREDICTIONS REFUTED (attributably), and a self-inflicted regime change

**Window** 962t from t72810328, methodology #12, full ring. The window
straddles the legs-A+B+C deploy AND a plan regime change, so attribution is
the whole job here.

### The registered predictions FAILED. All of them.

```
                        predicted        measured
  portWaitFrac (cedc)   -> toward 0      0.122 -> 0.253   WORSE (2x)
  cedc delivery         -> above 10.00   buffer 3045 -> 4479, held 95%
  L1 pile decay         -> down          8.80 -> 10.64    WORSE
  forgone (not pred.)   -> flat 0.00     0.00  -> 24.13
```

**And they are attributable, which is what makes the cycle worth something.**

1. **The containers are not built.** `siteLedger W43N23 {n: 2, rem: 8135,
   done: 1865}` — 18.6% of a 10,000e project. Leg B's buffer branch is gated
   on `portBufferFree` being defined, and with no container standing the path
   is bit-identical to before (pinned by test). **The fix could not have acted
   yet**, so nothing here falsifies it.
2. **Deposit flow rose 33%.** P1 flapped 2 sources back IN (4adbcd8d,
   4adbcd8e defunded→funded), capacity 100 → 120, and DEP went from *"8f08
   40.0 x4, 4a83 20.0 x2 | 60 e/t over 6 routes"* to *"4a83 40.0 x4, 8f08
   40.0 x4 | 80 e/t over 8 routes"*. The spec-47 sizing law says
   `rho = R * range / 800`, so a third more flow through the same two ports
   means proportionally more collisions. **The rise is the flow, not the fix.**

### The meter is now fleet-wide, and it makes the container case STRONGER

Last cycle had one corp at 0.122. Seven now report:

```
  cee0 0.392   cd94 0.311   cd98 0.250   cedc 0.253
  d01f 0.225   cee2 0.181   c9f9 0.000    (fallbacks: 0 everywhere)
```

**Roughly a quarter of all at-port decision ticks are spent held at a full
port link** — double what the single-corp reading suggested, across both
ports. Zero fallbacks means every wait resolves inside `PORT_WAIT_CAP`, so
this is pure lost hauler time, exactly the currency the container buys back.

### THE SELF-INFLICTED PART, and it is the finding to act on

The container placement rung placed **two 5,000e sites**. That backlog trips
the colony-wide wartime lens, and wartime relegates the controller by ZEROING
its sink demand:

```
  sink          demand   allocated   value
  spawn          26.00      26.00     100
  spawn          18.45      18.45     100
  construction    7.43       7.43      70
  construction   10.06      10.06      70
  storage       398.75     104.03       1     <- 104 e/t to a value-1 sink
  controller      0.00       0.00      43.4   <- asks for nothing
```

**Construction can only absorb 17.49 e/t. The other ~104 goes to STORAGE at
sink value 1, while the controller at value 43.4 demands zero.** The ladder
never gets to compare them, because a zeroed DEMAND is not a relegated RANK.
P12 fails on exactly this (published 0.00 vs `bankFedControllerRate` 28.75).

**This is NOT a bug, and I am not patching it unilaterally.**
`flowAdapter.test.ts` pins `wartime -> 0` deliberately (owner 2026-07-27:
*"surplus ... normally for upgrading, but now for building"*), and the owner
restated it 2026-08-06: construction primary, *"banking excess it can't
consume is fine."* Both readings are the owner's. What is NEW is the measured
consequence: the rule was written when "build gets everything" implied build
could USE everything, and here it can use 17.49 of 121.

**The open question for the owner** — the code comment already claims
*"Relegated != off - the anti-downgrade floor still holds"*, which is false
whenever the downgrade timer is comfortable (the floor is 0). Relegating by
VALUE instead of by DEMAND would keep construction primary (70 > 43.4) AND
give the controller the residual ahead of storage (1). That is a sink-value
change, and CLAUDE.md says never nudge one in isolation — so it is filed, not
built.

Duration matters: 8,135e remaining at ~1.94 e/t measured build is **thousands
of ticks** of zero controller allocation. Riding it per the standing rule
(a live regression that buys understanding is a good trade; this threatens the
score, not the instrument).

**Cycle verdict: REFUTED-BUT-ATTRIBUTABLE + a self-inflicted regime change
named with data.** No code shipped: the fix under test has not had a chance to
act, and the one thing worth changing is the owner's own pinned directive.

## Cycle t72811683 — THE DOUBLE-ORDER BUG WAS DOING REAL WORK

**Window** 393t from t72811290. The blackbox ring covers only **93 ticks**
post-reset with 7 receipts, so the ENERGY ACCOUNT's "measured at the spawn"
lines are not quotable this cycle — per the capture discipline, stated rather
than printed off seven receipts. Everything below is plan-side or stamp-side
and does not depend on the ring.

### The link congestion cleared completely

```
                          1 feeder (16 CARRY)    2 feeders (32 CARRY)
  coreEmptyShare              0.279..0.375            0.598
  coreFillAvg                 178..233                 91.1
  hubClampShare               0.275..0.296            0.000
  portWaitFrac (fleet)        0.228                   0.000
```

Fleet-wide **zero waits across 127 port deposits**, and zero clamped hub
volleys. That is the registered `portWaitFrac -> 0` prediction confirmed.

### But NOT by the container — by the bug I just fixed

A container DID finish in this window (sites 2 → 1, remaining 8135 → 1535).
It is not what did this: `portWaits 0` **and** `portFallbacks 0` mean the port
link never filled, so **the buffer was never asked to absorb anything.**

What changed is that the core is being drained by **two** feeders instead of
one — the double-order from last cycle. **Port congestion was DOWNSTREAM of
the core drain all along**: a port link empties by firing into the core, so a
core that always has room means a port that never backs up. The container
addressed a symptom one level below its cause.

The double-order was a bug in the staffing lens, and it was also, accidentally,
the correct fleet size.

### The consequence I am walking into deliberately

`staffedFeeders()` (deployed t72811290) stops the double-order. **When the
current pair ages out, the fleet returns to one 16-CARRY feeder and this gain
should revert.** That is a live regression I am choosing NOT to pre-empt,
because it is the cleanest A/B this program has been handed: the fleet size
changes on its own clock with nothing else moving.

**Registered prediction:** as `feeders` 2 → 1, `coreEmptyShare` falls back
toward 0.3, `hubClampShare` returns toward 0.28, `portWaitFrac` toward 0.2.
**If it does, the feeder's sizing law is under-stated and that is the fix.**
If it does NOT, the second feeder was coincidental and the real cause is
elsewhere — in which case do not raise the floor.

### Why the sizing law is suspect but NOT yet changed

`volleyServiceCarry()` floors the feeder at 16 CARRY on the premise that it
"clears one full LINK_CAPACITY volley in ONE parked withdraw+transfer cycle" —
about **400 e/t** against a stamped `coreDrain` of **80 e/t**. A 400 e/t body
cannot be the binding constraint on an 80 e/t drain, so the LAW is probably not
what is wrong: the **execution** is, and nothing measured it.

Shipped this cycle instead of a constant change: a feeder **throughput meter**
(`movedPerTick`, `moveActiveFrac`) on the same 1500t rolling window as the duty
meter. Next window says whether the feeder achieves anything like its parked
cycle, which localises the gap to the run loop (travel, mode flapping, the
controller leg) rather than leaving the constant to be guessed at twice.
Telemetry-only: unit 2156, build clean.

### Standing state

Controller sink demand still **0.00** (wartime, 1535e of container left);
storage 127125 → 123710. The spec-48 gross-vs-net question is unchanged and
still the owner's call.

**Cycle verdict: INSTRUMENTED — a confirmed prediction re-attributed to the
opposite cause, with the A/B that settles it already running.**

## Cycle t72812126 — the spawn is the wall, and haul EFFICIENCY is the only lever left

**Window** 443t, methodology #13.

### First, a correction I owe two previous cycles

I withheld the income statement at t72811683 and t72812126 on the grounds that
the blackbox ring was thin after a deploy. **That was wrong.** Spec 42 already
solved this: `spawnLedger` publishes CUMULATIVE spend by role into Memory, and
the account differences two captures (`spawnSpanned`), so every "measured at
the spawn" line spans the FULL capture window regardless of resets. Verified
monotonic across all three captures. The ring only bounds the per-corp SOURCE
P&L and X5 churn. **Two statements were readable and I did not print them.**

### The targets, now that they print

```
  TARGETS
    forgone mining                     3.59 e/t   target ~0   close
    net energy = mined 96.41 - fleet 32.17 = 64.24 e/t
    controller / net                   27%   target >=50%   MISS
    ...INCOME-FUNDED only              27%   target >=50%   MISS
```

**Forgone is nearly fixed: 24.13 → 3.59.** Mining is not the problem any more.
The controller is: 48.60 → **17.34 e/t**, 27% of net against a 50% bar.

### Where the energy goes instead: it rots at the mouths

```
  ground pile decay        18.17 e/t   (was 8.80)   avg 9.8 piles standing
  E6  5 of 10 miner ops deferred, ALL CHRONIC:
      cee0 4220 held 84%   cedc 4000 held 100%   cee2 4404 held 69%
      cd94 3002 held 89%   d01f 2684 held 97%
```

18.17 e/t is **19% of gross mining** burning on the ground — the largest single
line in the account and L1's top line at 72x its (zero) budget.

### And the spawn cannot buy its way out

```
  S5  building 0.639 p/t of 0.667 physical  =  96% of ceiling, 4% surge margin
  F1  haulers 0.414 p/t vs 0.312 planned    =  ALREADY over-building haulers
```

This is the finding that reframes the work. The colony is **already spending
its spawn on haulers above plan and is at 96% of the physical ceiling**, and
the piles grow anyway. So hauling capacity **cannot be bought** — there is no
spawn left to buy it with.

The only remaining lever is haul EFFICIENCY: the same delivered energy for
fewer CARRY parts. That is exactly what deposit ports do (DEP: 80 e/t over 8
routes, ~990 tile·e/t, **31.8 CARRY parts = 16%** of the source-route fleet),
and exactly why the owner's edge links matter — they are not a nicety, they are
the only affordable path to the controller target while S5 is at 0.96.

**The causal chain, end to end:**

```
  spawn at 96% ceiling  ->  no more hauling can be bought
      ->  5 of 10 mouths chronically over cap
          ->  18.17 e/t rots on the ground
              ->  controller gets 17.34 (27% of net, target 50%)
```

### The feeder meter's first reading (shipped last cycle)

`movedPerTick 131.28`, `moveActiveFrac 0.481` on the 32-CARRY pair — about
**65 e/t per feeder**, idle half the time. Against the stamped `coreDrain` of
80 e/t that says a SINGLE 16-CARRY feeder sits right at the edge of
sufficiency, which fits the A/B's premise. The 48% idle is not waste: spec 45
already rules that a service creep's idleness between volleys is the price of
hauler duty.

**The A/B has NOT run yet** — `feeders` is still 2 at all three captures; the
pair has not aged out. `coreEmptyShare` 0.565 and `hubClampShare` 0.091 are
holding meanwhile.

### Methodological note: stop deploying every cycle

The link meter and port meter are heap-resident and DO reset on a global
reset. Deploying on three consecutive cycles reset them three times, which is
why several gauges only ever report 90-450 tick windows. The account survives
(cumulative), the gauges do not. **Deploy when there is something to ship, not
once per audit** — the instrument needs quiet windows more than it needs
patches.

**Cycle verdict: DIAGNOSED — forgone essentially fixed (24.13 → 3.59), and the
controller shortfall re-attributed to a spawn ceiling that makes haul
efficiency the only affordable lever.** No code shipped: the diagnosis says
buy nothing, and the fix it points to (deposit ports / edge links) is already
the standing plan.

## Cycle t72819265 — THE A/B RAN, AND IT CONFIRMED THE PREDICTION

**Window 7,139 ticks** — nearly five fiscal months, and the first properly long
window this program has had. That is a direct result of NOT deploying last
cycle: the blackbox went 1,054 → 39,395 bytes and the link meter spans 7,223t
instead of 84t. The methodological note from last cycle paid off immediately.

### The targets, on a window that can carry them

```
  forgone mining                     22.30 e/t   target ~0      MISS
  net energy = mined 87.70 - fleet 41.92 = 45.78 e/t
  controller / net                   92%   target >=50%   MET
  ...INCOME-FUNDED only              97%   target >=50%   MET
```

**The controller target is comfortably met** — P7 reads **1.16x** (42.20 e/t
against a 36.4 plan). Last cycle's 27% was a 443-tick artifact and should not
have been read as a state. **Forgone mining is now the entire gap**, exactly as
the owner framed it.

### The A/B: prediction CONFIRMED, and the mechanism is LATENCY

Registered at t72811683: *"as `feeders` 2 → 1, `coreEmptyShare` falls back
toward 0.3, `hubClampShare` returns toward 0.28. If it does, the feeder's
sizing law is under-stated and that is the fix."*

```
  feeders  CARRY   coreEmptyShare   hubClampShare   movedPerTick   window
     2       32        0.565            0.091          131.28        84t
     1       16        0.421            0.268          187.33      7223t
```

`hubClampShare` landed within **0.008** of the predicted 0.28.

**And the throughput meter shipped for this question settles WHY.** The single
feeder moves **more** per tick than the pair did (187.33 vs 131.28, active
0.556 vs 0.481) while the core clamps three times as often. So it is not a
RATE problem — one creep working harder cannot cover two senders arriving at
once, it can only serve them **serially**. That is spec 45's own doctrine
(*"its metric is drain LATENCY, not throughput utilization"*) finally measured
rather than asserted.

### The fix the A/B earned

`volleyServiceCarry()` floored at ONE volley regardless of topology.
**It now scales with inbound senders** — N senders can land N volleys inside
one drain window. `inboundSenders` was already stamped at the decision site;
it simply was not read. Both plan-side twins (`infraSpawnLoad`,
`infraSpawnEnergy`) take the same count so price and behaviour stay equal
(F1); `senders` defaults to 1 so every legacy call site is bit-identical.

One existing pin staged the two-port shape and asserted 16 — precisely the
case the A/B refutes. Updated with the evidence, plus a new pin that one
sender still floors at one volley. The BODY remains bounded by the energy
budget (`maxCarryPairs(2300)` = 23), so the floor states the requirement and
the budget states what is buyable.

Gate: unit 2170 (7 new, red-first), build clean, trio green.

### The rest of the window

**E6: 0 of 13 deferred** — *"no deferrals, source buffers under threshold"*.
The chronic pile-up that dominated four cycles is GONE; H1 ground-piled is
771e (was 2,492-4,232). L1 pile decay fell 18.17 → 11.27 with it.

So forgone's 22.30 is NOT held mouths any more — it is under-staffed
commissions. F2 shows |gap| 146p with c9f9 32p of 78p and cd98 41p of 77p,
against R1 at **9.6x** the priced raid tax and X5 churn 0.17 (14% remote
invader/revoke noise). **Raids are killing remote fleets faster than they are
replaced**, and that is the next thread — a different mechanism from the
hauling deficit that came before it.

**Cycle verdict: FIXED — a registered prediction confirmed within 0.008, its
mechanism identified as latency by an instrument shipped one cycle earlier,
and the sizing law corrected with both sides of the plan/runtime pair moved
together.**

### Cycle t72821449 — the mouth piles are the top line, and the fix was sitting undeployed

**Window 1982t (t72819467 → t72821449), methodology #14.** The longest clean
window in days, and the income statement moved substantially against the
202-tick phase sample before it:

```
                          t72819265 (202t)   t72821449 (1982t)
  forgone mining               23.51                6.23
  gross mining                 86.49              103.77
  fleet                        55.20               39.96
  measured losses              10.00               13.06
  controller (score)           30.96               36.88
  controller / CAPACITY          28%                 34%
  ...income-funded               35%                 39%
```

Forgone fell 73% — far outside the ±20-30% single-draw band, so it is real and
not a draw. The controller share's +21% is inside the band and must be carried
as provisional until a second long window.

**None of it is spec 49 leg A.** The capture reads both deposit ports routed at
**exactly 30.00 e/t** — the retired flat cap, to the decimal. Leg A was
committed at 15:02 and not deployed until after this capture, so this window
measures the pre-Leg-A bundle. The improvement is the earlier volley-floor and
double-order work aging in.

**TOP LINE: L1, and for once it is not just the zero-budget artifact.** Pile
decay measured **8.18 e/t against a 0.00 budget** (32.71x, spec 48's known
defect) — but the level itself nearly doubled from 4.60, and the cause is
readable in three rows that agree:

```
  sourceBuffers   20,073e standing at 8 remote mouths
                  cd8d 4285   cedc 3330   d01f 2315   cd8e 2297
                  cd94 2049   cee2 1936   cee0 1888   cd98 1882
  E6              5 of 12 miner ops deferred - cd8d held 100% of window,
                  cedc 97% CHRONIC
  H1              duty 0.86, ground-piled 4276e, "haulers BUSY =>
                  plan under-asks (inflow-sized carry, no drain term)"
```

Miners gated behind full buffers, haulers busy, energy decaying on the ground
at 8.18 e/t. That is a HAULAGE deficit, not a mining or a decay problem — and
the eight piled mouths are near-identical to DEP's eight sources that *"could
deposit at a home link"* (cee2/cd8e/cd8d/cedc/cee0/cd94 + 2), each saving 12-16
tiles of haul. The flat cap was refusing exactly those routes.

So leg A is not an efficiency tweak here; it is the drain for the top line.
Deployed t72821449+ with predictions registered below.

**REGISTERED PREDICTIONS (leg A, check at ~t72823500):**

1. Routed deposit flow per port **30.00 → 40.00**, port routes **6 → 8**.
   Headroom 47.14 / 51.54 admits four 10 e/t routes apiece; DEP's own detector
   already proposes "40.0e/t x4" per link. A 5th route (50) fits port B's
   51.54 but there are only 8 candidates.
2. The two newly-admitted sources' haul legs shorten by their DEP saving;
   planned source-route CARRY falls from **251.4**.
3. The freed CARRY drains the mouths: **total piled falls from 20,073** and
   **pile decay falls from 8.18 e/t**.
4. **E6 deferred ops falls from 5/12**; cd8d/cedc stop reading CHRONIC.
5. RISK, watch for it: more inbound volleys per port means more contention at
   the core. **hubClampShare rises** and the LINK hub rate rises from 50.2. If
   clamp goes up without piles coming down, leg A moved the queue rather than
   drained it, and the volley floor needs re-sizing before more flow is added.

**Falsifier:** if per-port routing stays at 30.00 after the deploy, the cap was
not what bound and the constraint is elsewhere in `detectLinkDepositPorts` —
instrument the port detection, do not re-theorize.

### Grid RATCHET FAILURE t72821449 — attributed to HOST LOAD, plus one real pre-existing red

A full-grid run against the leg-A build reported **bot level 4 -> 0** with 22
baseline-green cells regressed, 24 of them timeouts. Two attribution runs, per
the audit method's "a red cell gates a deploy only if it is red BECAUSE of the
pending change":

```
  move-upgrader-park-settle   full grid: FAIL      alone, same source: 1/1 PASS
  cons-link-core-first        alone, leg-A src:  timeout @60/60t
                              alone, PRE-leg-A:  timeout @60/60t   <- identical
```

**Leg A is acquitted on both counts.** The first cell is a movement/parking
assertion in a link-free T1 world - a constant in `depositPortHeadroom` cannot
reach it - and it passes cleanly the moment it is not competing for CPU. The
second fails IDENTICALLY on the pre-change source, so it is its own incident
against the deployed build and must not hold the fix hostage.

**Cause of the mass failure: host load, the documented class.** That grid ran
concurrently with a live telemetry capture, two webpack builds, a deploy and
the unit suite, and it started with orphaned mockup processes from a
previously-killed run still competing for CPU. CLAUDE.md already records the
shape (*"the mockup meters real CPU against a real bucket, so an armed
governor couples cell behavior to HOST LOAD - a full grid run drained heavy
worlds' buckets... and failed six baseline-green cells before this was
caught"*). 24 timeouts across unrelated tiers is that signature, not a bot
regression. **Do not run a full grid concurrently with captures, builds or
deploys** - and kill orphaned `@screeps/engine|storage` processes before
starting one, because a killed grid leaves them running.

**The baseline was NOT updated from this run**, and must not be: a load-poisoned
grid cannot ratchet in either direction.

**OPEN INCIDENT (separate, real): `cons-link-core-first` is RED on the deployed
build.** "the core link site lands beside the storage" never satisfies in 60
ticks, on both leg-A and pre-leg-A source, while the baseline says green. It
regressed at some earlier commit - unbisected. It is a link-placement rung, so
it sits directly upstream of the deposit-port work and should be bisected
before more link/port behaviour is layered on top.

## Cycle t72823437 — the handicap reversion VERIFIED, and the sweep that replaces arguing about the number

**Owner steer:** *"We used to have a spawn capacity handicap of 10% for the
planner. When I lifted that, I feel like the economy got overheated, and it's no
longer able to execute everything that it wants to due to various little
inefficiencies."*

**The instinct is confirmed by measurement, and this cycle is that
verification.** The 1.0 lift was reverted on 2026-08-05 on its own registered
criteria; this is the first full-window read of the colony afterwards, and it is
the post-deploy verification that reversion never got:

```
                        lifted (1.0)                    reverted (0.9)
                        t72798237-t72800193             t72823437
spawn utilization       0.97-0.98, queue depth 4-8      0.64   (S3 "not a stall")
forgone mining          8-20 -> 44.5 e/t (5 months)     9.71 e/t
P4 plan-infeasibility   0.83-0.91x                      0.73x
X5 rebuild churn        elevated                        0% (0e of 27,500e)
S5 surge margin         none                            0.63x physical, 37% margin
F2 / F3 fidelity        38 of 84 parts on W45N25        0.26 / 0.09
```

Every registered prediction of the reversion deploy landed: util ≤0.93 (0.64),
queue ≤3 (S3 clear), F2/F3 gaps closed on surviving routes, forgone+decay back
under ~15 (9.71 + 11.65 pile decay, with pile decay now the TOP LINE). The
energy account balances to a RESIDUAL of **−2.07 e/t, 2% of gross mining** —
against the 14%-of-gross first baseline of 2026-08-01.

Cycle verdict: **verified.** The owner's hypothesis was right, the constant's
own reversion protocol worked, and the colony recovered.

### What the cycle then BUILT: spec 50, the sweep

The owner's real ask was not to re-litigate 0.9 vs 1.0 but to **measure the
curve between them**, unattended: 1% of handicap per fiscal month, 0→20, income
statements for every month, bot-driven, no redeploy, cycling forever.

Two things had to be true that were not:

**1. The handicap had to become the bot's, safely.** `SPAWN_PLAN_FRACTION` is
now the DEFAULT and the fail-safe rather than the operative number;
`economy/spawnSweep` owns the walk. The design rule that matters: **it never
self-arms.** Absent `Memory.spawnSweep`, the margin resolves to 0.9 — so the
grid, the sims and the unit suite are untouched by the experiment's existence,
and a wiped Memory fails safe to the measured-good value rather than to the 1.0
that overheated the colony. Arming is one deliberate write (`npm run
sweep:arm`); every step after it is the bot's.

The spec-17 purity ratchet caught a real defect here and is worth recording:
`economy/primitives` resolves the margin, and primitives is PURE, so a
Memory-reading sweep would have contaminated the planning core. The state moved
to the adapter (`telemetry/fiscalArchive`) with a pure mirror refreshed every
tick BEFORE planning. The month hook also runs before the planning phase, so a
boundary tick's re-solve is the first plan OF the month it labels — otherwise
every month would carry one plan priced at the previous month's handicap.

**2. An unattended fiscal month had to be closeable.** It was not. `fiscal-close`
brackets a month with the committed CAPTURES nearest its ends; with nobody
capturing for ~31,500 ticks, most of the sweep's months would have been
unclosable — permanently, the record being append-only. `telemetry/fiscalArchive`
(segments 8–9) has the bot snapshot its own boundaries into a Memory-backed ring,
so ONE capture at the end recovers every month, at ~100% coverage by construction
rather than the approximation a capture-bracketed close has always been.

### The finding worth carrying forward: the ACTUAL side lied first

The archive's acceptance test prunes two real captures, rehydrates them, and
compares the resulting ENERGY ACCOUNT against the one built from the full
captures. The first version passed the whole ACTUAL column on the first attempt
and got the BUDGET column badly wrong — evacuation, reservation, defense and
consumers all read a confident **0.00**, and NET MINING MARGIN was off by 28 e/t.

Four fields were responsible, all budget-side: the plan's hauler rows, the link
meter plus the hauler `port` flag (a POSITION, not a boolean — a `=== true` test
silently zeroed the deposit-port term), the non-harvest corps the budget prices
its fleet lines from, and source `nodeId` (9 remotes read as 11).

**The general lesson: a pruned telemetry snapshot naturally preserves what is
MEASURED and drops what is PLANNED**, because the measured side is a handful of
cumulative counters while the plan is a wide structure. For an experiment whose
whole intervention acts on the plan, that bias is fatal and invisible — the
report still renders, still balances, and is simply wrong. Any future snapshot,
projection or fixture-pruning needs a round-trip against the real report before
it is trusted, not a field-list review.

### Registered predictions for the sweep

Sequenced so the sweep stays attributable: the reversion's own verification is
DONE (above), so the sweep starts from a known-good 0.9 baseline.

- **P-1** Arming at 0% re-enters the overheated regime for one month by design —
  it is the control. Expect utilization back toward 0.95+, forgone mining rising,
  and 1–2 marginal remotes admitted that cannot be staffed.
- **P-2** Admitted source count falls monotonically (with noise) as the handicap
  climbs; the excluded-capacity line is the direct readout.
- **P-3** Forgone mining + pile decay is minimised somewhere in 5–15%, not at 0%.
  If the minimum sits at 0%, the overheating story is wrong and the reversion
  bought its recovery some other way.
- **P-4** Controller delivery is the NOISIEST of the four signals and must not
  be read on a single month — the bank cycle is ~6 months long.

Falsification design: the sweep CYCLES precisely so each handicap is re-sampled
at a different bank phase. A handicap that looks good in cycle 0 and bad in
cycle 1 is measuring drift, not the handicap.

### Honest limits recorded up front

The ramp is confounded with time — road completion, RCL progress and a draining
construction backlog all trend monotonically alongside it. One month per handicap
per cycle is a phase sample, not a rate. And the sweep does not FIX the
mispricing it measures: the standing successor is unchanged — price measured
per-route replacement overhead into admission, after which the margin is
redundant rather than merely tuned.

### Same cycle — grid attribution: `multispawn-t7-both-spawns-worked` is RED on the DEPLOYED build

Spot-checking the grid before the spec-50 deploy (the sweep changes a planner
capacity lens, so the planning cells are the relevant neighbourhood):

```
plan-t3-budget-subset               [P]  satisfied @ tick 60
multispawn-t7-both-spawns-worked    [x]  fail @738/800t  "extensions refill before the draining spawn finishes"
```

Baseline says `pass`, so it is a regression — **but not this change's.** Control
run on pre-change src (6ce940f, built and re-run): fails IDENTICALLY, same
assertion, @783/800t. Acquitted per the attribution protocol; it is its own
incident against the deployed build and must not hold the fix hostage.

Not the host-load class either, and worth saying because that was the last
grid diagnosis: zero orphaned `@screeps/engine|storage` processes, load average
0.44 on 4 CPUs, nothing else running. The two earlier assertions in the same
cell satisfy normally (@36 and @109) — only the extension-refill throughput one
fails, on both builds.

This is the SECOND baseline-green cell found red on the deployed build
(`cons-link-core-first` is the first, logged above, also unbisected). Two
independent silent regressions means the grid has not been run to completion
recently enough to catch them at their commit. **Bisect both before layering
more spawn/link behaviour on top** — and note that neither would have been
caught by the trio, which is the gate that actually runs every cycle.

The spec-50 deploy proceeds: unit 2225 green, the trio green, and the grid's
planning neighbourhood green with the one failure attributed away.

## Cycle t72829496 — two fixes landed, one hypothesis KILLED by its own data

Verdict: **fixed ×2, instrumented ×1, falsified ×1, and a grid run I spoiled
myself.** Capture t72829496, 733 ticks after t72828763, methodology #14,
sweep `pct: 3`.

### FIXED — the handicap mirror was read after the first solve, not before

Registered last cycle as P-C and confirmed here. `plannable` now reads
`0.646667 = 0.6667 × 0.97`, exactly the armed `pct: 3`, so the mis-pricing
DOES self-heal on the next scheduled solve. That bounds the blast radius to one
solve per deploy — which is precisely the solve the fiscal-month term (spec 46
phase A) turns into the whole month's budget. Fixed in `e3e5ca4`: the
fiscal-month hook moved from the top of PHASE 2 to the first statement of
PHASE 0, because `getOrCreateFlowEconomy` solves inside PHASE 0 on a reset tick.
Pinned structurally (`test/unit/main.test.ts`) against a named list of solve
entry points — no behavioural test can see it, since by end of tick the mirror
is correct either way.

### FIXED — the reserver books disagreed because they were one solve apart

Last cycle: `Σ(auxiliary) 0.082977` vs `partsLedger.infra 0.086681`, delta
−0.003704 — one `roomReserverSpawnLoad`. This cycle the SAME TWO NUMBERS
SWAPPED: `0.086681` vs `0.082977`, delta **+0.003704**. That sign flip is the
diagnosis: `infraSpawnLoad` prices reservers from `prevFundedRemoteRooms` (the
previous solve's answer, because the charge is deducted before this solve
decides), while the reservation corps come off THIS solve's draft. The error is
two-sided and lasts a month under the fiscal-month term. Fixed in `3b4d0d1`:
`solveColony` re-prices when the plan funds a different number of remotes than
it was priced for, with the re-price WRAPPING the fleet-charge iteration rather
than following it (`infraEnergyPerTick` is a term of the charge, so a bolted-on
correction just moves the over-charge from the parts ledger into the energy
one). `infraInputs.remoteRoomsFunded` now publishes next to `remoteRooms`.

### FALSIFIED — the raid meter's OVERDUE state is NOT an absorbing-state bug

The hypothesis, and it was a good-looking one: `raidDebt` only ever falls on a
WITNESSED sighting, so OVERDUE (`>130k`, guard disarms) is an absorbing state
reachable by a missed observation — one unseen raid and the guard is disarmed in
that room forever. Live it looked overwhelming: five of nine mined remotes past
the ceiling, guard fleet **0 parts**, `defense (guard) 0.00 / 0.00` in the
account, while R1 measured raid attrition at **2.47 e/t against a priced 0.71,
3.5×**. W42N23 sat at `raidDebt 1,658,080` — 12.75× the ceiling — WITH a raid on
its record. The fix was written, red-first, both halves.

Then the arithmetic killed it. `raidDebt / (now − lastRaidSeen)`:

```
room      raidDebt   elapsed   debt/elapsed   sources
W42N23   1,658,080   169,161       9.80          1
W42N22     526,810    53,991       9.76          1
W43N22     366,750    37,589       9.76          1
W43N24      54,330     3,342      16.26          2
W43N23     201,940    10,225      19.75          2
```

Every single-source room lands at **9.76–9.80 e/t — one source's reserved
harvest rate** — and the two-source rooms at ~2× it. The accrual is continuous
and exact since `lastRaidSeen`. **No resets were missed.** Those rooms simply
have not been raided in 38k–169k ticks, and OVERDUE's conclusion ("raids aren't
firing here") is empirically correct. The guard is right to be disarmed.

Change reverted. The absorbing-state critique remains structurally true as a
LATENT fragility — if a sighting is ever missed, the room does disarm forever
with no decay, timeout or clamp — but shipping a fix for a hypothesis the data
has just falsified is the bandaid-rule trap with extra steps. It waits for a
room that actually exhibits it.

What survives as the real anomaly: **W44N22 is ARMED** (86,180, inside the
65k–130k band) and the corp still stamps `gate: "no-targets"`. Its accrual rate
is 5.21 e/t against 9.76 for its peers — roughly half — which fits an
intermittently-mined room whose `lastHarvested` ages past
`GUARD_MINED_RECENCY` (3000). That is a one-line hypothesis and it was
unfalsifiable from a capture, because `lastHarvested` was not published.

### INSTRUMENTED — intel segment v2 carries `lastHarvested`

The guard's ARMED branch is `meterState === "armed" && Game.time −
lastHarvested < 3000`. Only the first conjunct was published, so a capture
could not decompose `no-targets`. Segment 3 is now v2 with `lastHarvested`.
Per the audit method: when the cause is invisible, the fix is FIRST a stamp.

### The W43N24 defund churn — refined, and NOT yet actionable

An invader core took W43N24 (`invaderCorePresent: true`,
`invaderReservedUntil: 72829997`). Its two sources — nets 8.21 and 7.82, ranked
3rd and 4th of 22 — dropped to `net 0, d 0, defunded`, freeing budget that
promoted W41N25 (net 5.91, 10th). Every other candidate scored IDENTICALLY to
the cent across both solves, so the planner is deterministic and the input
changed; the ledger's P1 "plan flap" TOP LINE is therefore accurate, not a
false positive as first written here.

The obvious fix — gate the defund on remaining occupation, as
`CORE_BUSTER_MIN_REMAINING = 1000` already gates the buster — does NOT follow,
because `hostileRooms()` records that **a live core RENEWS the reservation on
every sighting**. W43N24's 501 remaining ticks is a last-seen bound with a live
core behind it, not a lapse. What the pair of gates DOES leave is a gap worth
naming: the buster declines (remaining < 1000) and the planner declines (room
occupied), so the room is neither contested nor worked, and on blind expiry of
a stale bound it will be re-funded, re-scouted, and re-marked — an
intel-staleness flap. Recorded, not patched.

### The grid run I spoiled, and what it still proved

I ran `audit:ledger` four times plus a telemetry capture WHILE a full grid was
live, having said I would not. Result: 22 "regressions" and BOT LEVEL 4 → 0,
which is not a real number. Clean single-cell re-runs split it:

```
move-upgrader-park-settle        dirty: fail @80/80t     clean: PASS
haul-t2-critical-divert          dirty: timeout @60/60t  clean: PASS
spawn-timer-survives-busy-spawn  dirty: fail @104/150t   clean: FAIL @104/150t
fid-t4-synthetic-steady-state    dirty: fail @1100/1100t clean: FAIL @1100/1100t
```

The two real ones reproduce IDENTICALLY on pre-change src (`44474ba`) — same
assertion, same tick — so both commits are acquitted per the attribution
protocol. Both cells are `pass` in the baseline, making them the **third and
fourth** silent regressions found on the deployed build, after
`cons-link-core-first` and `multispawn-t7-both-spawns-worked` logged above.

**`fid-t4-synthetic-steady-state` is the one to chase**, and it is the best
handle this program has on the owner's standing question (*"we hit 50+
sustainable and never got close again"* — G1 ran 51–56 across five months to
t72788704 and has not exceeded 43 since). It fails on *"controller fidelity: >=
15% of upgrade budget"* — the same symptom, in a deterministic synthetic world
with no invaders, no bank phase and no capture gaps. Doctrine says a fidelity
gap on a synthetic world is a bug signal by construction, and a deterministic
cell is bisectable where an 8,650-tick hole in the capture record is not. The
level shift brackets `667bf0d` (transport arc costs).

Standing instruction from the previous cycle now applies to four cells, not
two: **bisect these before layering more behaviour on top.** None of them is
caught by the trio, which is the gate that actually runs every cycle.

## Cycle t72832806 — construction is the misallocation, and the sweep's noise floor

Verdict: **blocker named with data**, plus the sweep's first four archived closes.
Capture t72832806 against t72829496 (3,310 ticks), methodology #14, sweep
`pct: 6`. No code change shipped — deliberately, see the close.

### TOP LINE: P4 plan spawn-infeasibility 1.05x, and construction owns it

```
plan-implied 0.702 p/t vs 0.667 physical
  source-route haulers      393p = 0.277
  construction (all-in)     278p = 0.198   <- 31.6% of plannable
  transient haulers         111p = 0.079
  miners                     96p = 0.067
  tenders                    68p = 0.045
  reservers                  32p = 0.030
  feeder                      9p = 0.006
```

Against that spend, measured output over 3,310 ticks:

```
corp                            parts  creeps   built    e/t
building-W43N23-construction     163      5        45   0.014
building-W43N24-construction       8      2       885   0.267
building-W41N25-construction       8      2        50   0.015
(seven others)                    24      6         0   0.000
                                             ---------------
                                 total      980   0.296 e/t
```

**20 e/t allocated, 0.296 e/t delivered - 1.5% conversion.** And the fleet is
distributed backwards: the home corp holds 80% of the parts and produced 4.6% of
the output, while an 8-part corp out-built it 20x.

### The body explains it, and the formula is NOT the bug

```
t72829496:  94 parts = work 5,  carry 83,  move 6
t72832806: 163 parts = work 8,  carry 135, move 20
```

8 WORK against 135 CARRY - 83% of a "build crew" is haulage, and it GREW by 69
parts (52 CARRY) in a window where it built 45 units.

The arithmetic is correct. `builderPlan` sizes from
`sustainableConsumptionRate(buildSideStock, 5)`, which at the observed stock 497
gives 5.33 e/t -> 2 WORK, matching the sinks' `workParts: 2` exactly. `tankerPlan`
then takes `consumption = partsNeeded * 5 = 10` and the sinks' own distances:

```
tankerCarryNeededFor(10, d=53)  =  65 CARRY
tankerCarryNeededFor(10, d=114) = 138 CARRY      (fielded: 135)
vectorSupplyPartsGait(10, 114)  = 184 parts
```

The fielded 135 CARRY is precisely what the formula orders for two pools at
d=53 and d=114. Nothing is miscomputed.

### The actual gap: construction has NO ADMISSION TEST

184 parts to sustain 10 e/t of building at 114 tiles is 0.123 p/t - **18% of the
physical spawn ceiling for one remote site.** Nothing anywhere asks whether that
trade is worth taking.

Sources get exactly this test. A source at d=114 rate 10 prices out at
`candidates[].net` ~5.51 and sits `over-budget` (d019, this capture). A
construction site at the same distance and rate is admitted at a fixed priority
70 and then the runtime sizes whatever supply vector the distance demands. Same
physics, one priced, one not.

The consequence is visible in the sink table:

```
spawn         alloc 19.93   prio 100
spawn         alloc 19.93   prio 100
construction  alloc 10.00   prio 70    spawnLoad 0.135  spawnDist 114
construction  alloc 10.00   prio 70    spawnLoad 0.063  spawnDist  53
storage       alloc 105.55  prio 1
controller    alloc  0.00   prio 44.18  workParts 0
```

Construction's FIXED 70 outranks the controller's DYNAMIC 44.18, so the score
sink gets zero while two remote sites take 20 e/t and a third of the spawn parts
budget. The value-ladder comment in CLAUDE.md reads "controller <= 80 >
construction 70" - true at the ladder's top end, false whenever the controller's
dynamic price falls under 70, which is where it sits now.

**Fix shape (NOT implemented this cycle):** price a construction sink the way a
source candidate is priced - net of its supply vector's spawn cost at its actual
distance - and let it be rejected. That is a planner change, and this cycle
deliberately did not ship it: four baseline-green grid cells are red on the
deployed build and unbisected, the baseline is nine days stale (07-29), and the
grid cannot return a clean verdict on this 4-core host (see below). Layering a
planner change on that is what the previous cycle's standing note warns against.

### The sweep's first closes - and its NOISE FLOOR

`fiscal:archive` closed four periods at 100% coverage from the bot's own
boundary snapshots, each self-labelled with the handicap in force. Unattended,
recoverable, exactly what spec 50 was built for:

```
month       hc   capacity  mined   controller  sustainable   bank
FY4855-M01  1%    120.00   98.53     36.89       29.43      -7.47
FY4855-M02  2%    120.00  105.06     14.79       32.96     +18.16
FY4855-M03  3%    100.00   91.25     24.96       28.34      +3.38
FY4855-M04  4%    100.00   81.01     57.26       22.55     -34.71
FY4855-M05  5%    115.00   80.87     34.28       25.10      -9.17
```

**The experiment cannot resolve a 1%/month step, and this is the number that
says so.** Sustainable spans 22.55-32.96, a 46% spread, while one handicap step
moves the plannable budget by 0.0067 p/t (~1%). The noise is ~40x the signal.
`delivered` is worse - 14.79 to 57.26 - because the bank term swings +18 to -35,
which is the ~9000-tick bank limit cycle sampled at 1500-tick intervals, exactly
the phase-sample hazard the fiscal calendar section warns about.

Consequence for how the sweep gets READ: never compare adjacent months. Compare
BANDS - months 1-5 against 16-20 - where the handicap differs by ~15% and the
per-month noise averages down. The 21-month ring holds enough for exactly that,
which is the one design decision here that survives contact.

Secondary: `mined` trends 98.53 -> 105.06 -> 91.25 -> 81.01 -> 80.87 while
capacity holds 100-120, i.e. forgone is rising (34.57 e/t this window, up from
7.22 last cycle), with the miners' pile-gate stamps explaining 35.09 e/t of it.
That is E6's haul deficit, not a handicap effect, and it confounds the sweep for
as long as it runs.

## Bisect: `fid-t5-real-maze-steady-state` regressed at PR #149, and it is a DESIGN disagreement

**Boundary, 8/8 draws** (isolated cell runs, the full-grid concurrency artifact
avoided):

```
f6e9487  (08-02)   GREEN 4/4
48fbe19  (08-03)   RED   4/4   all on "controller fidelity: >= 10% of upgrade budget"
HEAD     (08-07)   RED   5/5   (has since drifted further - also fails GROSS fidelity)
```

Two method notes worth keeping. First, the cell is deterministic AT THE
BOUNDARY (three draws, same assertion, same tick) but NOT at HEAD, where a
second assertion has since started failing - so "deterministically red" is a
claim that must be made per-commit, not per-cell. Second, the bisect ran in a
git WORKTREE with symlinked node_modules; driving it by `git checkout <sha> --
src` in the main tree leaves a days-old source tree on disk for minutes at a
time, which reads to any commit-hygiene tooling as uncommitted work.

### The mechanism

PR #149 rewrote the controller valve, deleting its guaranteed floor:

```ts
- export const STORAGE_UPGRADE_TARGET = 15;     // deleted

+ bankFedControllerRate(banked, reserve, ticksToDowngrade)
+   = controllerFloorRate(ticksToDowngrade) + bankSurplusRate(banked, reserve)
+ controllerFloorRate(t) = t < ANTI_DOWNGRADE_DANGER_TICKS ? ANTI_DOWNGRADE_RESERVE : 0
```

Both halves are owner-directed and quoted in the diff itself (*"The bank should
be the income mop up not the upgrade"*; *"Even the anti downgrade. We don't need
it UNLESS the controller is in danger of downgrading ... Not the constant
trickle"*). The controller's floor is therefore ZERO whenever it is not near
downgrade, and its entire claim is the bank surplus.

### Why this is not "a bug the bisect found"

The cell asserts the controller receives >= 10% of the upgrade budget. PR #149
deliberately made that false at bank-equals-target. The cell encodes pre-#149
doctrine, and **the baseline it is graded against (f894be1, 07-29) predates the
design change by four days** - which is exactly why nobody caught it. The
baseline was never re-earned when the valve was rewritten, so a deliberate
behaviour change has been sitting in the grid as an unexplained red ever since.

That is the transferable lesson, not the commit: CLAUDE.md's rule is to update
the baseline in the SAME commit as the change that earned it. #149 changed a
graded behaviour and did not, so the grid has been reporting a design decision
as a regression for four days and two audit cycles.

### It also closes THIS cycle's top line

The live numbers chain end to end:

```
storage 105,439 - reserve 80,500 = 24,939 surplus / 1500 = 16.6 e/t
  -> P12 measured bankFedControllerRate 16.63    (the law)
  -> controller sink: alloc 0.00, prio 44.18     (what it got)
  -> construction:    alloc 20.00, prio 70       (fixed 70 > dynamic 44.18)
```

With no floor, the controller is a RESIDUAL claimant priced dynamically, and
construction's FIXED priority 70 now outranks it structurally whenever the
controller's dynamic price falls below 70. So construction takes 20 e/t plus
31.6% of the plannable spawn budget - at a measured 1.5% conversion - while the
score sink is allocated zero. The construction admission test proposed above is
therefore not an independent item: it is the other half of this.

### What it does NOT explain

The live sustainable decline (~48 -> ~31 pts/t). PR #149 landed 08-03; the live
51-56 cluster ran 08-05 onward, AFTER it. The grid regression precedes the good
period, so the two are not the same story - and the live shift window
(t72788704-t72797359) still contains no src commit at all, `667bf0d` having
turned out to be docs-only. That question remains open and points at world
events (invader cores, capacity swinging 100-120), not code.

## Cycle t72841341 — construction converts 5% of its claim, so the claim never releases

Verdict: **blocker named with data; one fix written red-first and WITHDRAWN**
(it contradicted a standing owner ruling). Capture t72841341 vs t72832806,
8,535 ticks, methodology #14, sweep pct 6.

### The owner's design, restated (2026-08-07)

*"We want to focus on construction when it's around so we get the investment
completed quickly and start benefitting from it. So only any energy and spawning
left over after allocating for the construction should be let through. Often
that's zero because construction is quite haul heavy and that's ok as long as
the construction gets completed quickly and then releases its claim and
upgrading again takes its normal full allocation."*

So wartime relegation to zero is CORRECT and stays. The acceptance criterion is
**completes quickly, then releases**. Everything below measures that criterion.

### The measurement: 5% conversion

```
construction allocated        30.00 e/t   (plan, 4 sinks)
construction built             1.51 e/t   (sum of corp `produced` deltas)
construction body spend        2.20 e/t   (builder 14,450 + tanker 4,350 / 8,535t)
construction plan claim        0.391 p/t  = 49% of plan; P4 now 1.21x ceiling
```

The fleet costs MORE than it produces. At 1.51 e/t the 6,200 remaining units
release the claim in **~4,100 ticks**; converting the allocated 30 e/t would do
it in **~207**. The 20x is the whole problem - not the backlog size, and not the
relegation rule.

### Why it cannot convert: the fleet is 8.5% WORK

~164 construction parts hold ~14 WORK. Even that WORK is idle ~98% of the time:
the home crew stamps `latchedToSite: 0, tankers: 0, vectorFed: false` with its
three creeps at `W40N23, W41N25, W41N25` - three rooms, none latched - while
the 18-site backlog sits in a fourth (W43N21, whose own corp holds 29 parts).
Bodies measured `work 6 / carry 123` (home) and `work 8 / carry 12 / move 9`
(W43N21). Last cycle the home body was `work 8 / carry 135`. CARRY is bought,
WORK is not, and the WORK that exists is unfed.

### A standing drip of runt builders in rooms with no work

Every remote construction corp re-buys a 250e, 4-part builder (`work 1, carry 1,
move 2`) about once per creep lifetime:

```
72839049 W43N22  72839061 W41N25  72839073 W43N24  72839128 W43N21
72839374 W42N21  72839376 W44N22  72839386 W42N22
72840606 W42N23  72840662 W41N25  72840672 W41N23  72840674 W43N24
```

and W42N23 / W42N22 / W42N21 / W43N22 / W41N23 produced **exactly 0** across
8,535 ticks. Sixteen of 25 builder purchases went to corps with nothing to
build.

### An abandoned investment, and where it went

```
t72832806   W41N25 rem  468 done 4532 | W43N24 rem 4088 done  912
t72841341   W41N25 rem  418 done 4582 | W43N21 rem 5782 done 4318 (18 sites)
```

W43N24's project left the ledger mid-build: 912 units invested, **4,088
abandoned**, because the room was taken by an invader core and the planner
defunded it (P1: cd8d/cd8e funded->defunded). That is the capital-churn cost of
the duration-blind defund recorded in the t72829496 entry, now with a number on
it.

### CORRECTION: P8 mis-measures, and this entry's predecessor repeated it

P8 reported "0 e/t built" and the t72832806 entry above took that at face value.
P8 reads room `siteProgress`, which is 0 because the HOME room has no sites -
every remote project is invisible to it. The corps' own `produced` counters show
12,870 units over the window. The leak row is not wrong about there being a
problem, but "CREW IDLE (energy allocated, nothing built)" is the wrong
description and it survived a full cycle unchallenged. Read the corp counters,
not P8, for remote build delivery.

### The fix that was written and withdrawn

Diagnosing the controller at `demand 0 / allocated 0 / workParts 0` against
`bankFedControllerRate 100.00`, with the upgrade corp demobilized and storage at
239,814 (+15.74 e/t, E4 "past the absorbable knee"), traced to
`controllerRoutingCapacity`'s wartime branch returning `controllerFloor`, which
PR #149 had made zero - falsifying that branch's own comment ("Relegated != off
- the anti-downgrade floor still holds").

A red-first test and the retirement of that branch were written and passed
locally. They were then REVERTED on discovering a second test pinning
`WARTIME IS COLONY-WIDE ... (owner 2026-08-05: construction is the primary
consumer wherever the project stands; the residual BANKS)`. The change reversed
a standing ruling on authorization given without that fact in view. The owner
has since confirmed the ruling.

Recorded because the mechanism is real and will be rediscovered: relegation to
zero is only safe while construction converts. The rule is not the defect; the
5% conversion is.

## Methodology #15 — P8 measures build progress instead of summing three floors

Fixed 2026-08-07 after the owner read a construction line that was the meter,
not the colony.

P8's value was `max(0, siteProgress delta) + roadReceipts ratchet x 300 +
poolWork decrease`. Each term is documented in place as a FLOOR that
undercounts, and they share one blind spot: **all three read state that
vanishes when a site completes**, so a remote build program that FINISHED is
invisible to every one of them.

Measured t72842655: `building-W43N21-construction` took `produced` 6,270 ->
12,310 in 1,314 ticks - 6,040 units, **4.60 e/t** - clearing 17 of 18 road sites
and releasing its claim, which is precisely the "completes quickly then
releases" behaviour the wartime design depends on. P8 reported a fraction of it,
and the ENERGY ACCOUNT (which reads P8 verbatim) booked construction ACTUAL at
**0.42 e/t against a 30.00 budget**, making a -29.58 variance the single largest
term in the CONTROLLER VARIANCE BRIDGE.

The direct measurement was already published and had been since segment 4 v14: a
ConstructionCorp's `unitsProduced` IS build progress. P8 now sums the
construction corps' `produced` deltas, keeping the floors only as a fallback for
captures that predate the counter - preferred, never summed, because both
measure the same energy and adding them double-counts.

Per-corp deltas clamp at zero. A corp destroyed and rebuilt restarts its counter
(measured -885 on `building-W43N24-construction` when the invader core took the
room); that is lost history, not negative building, so the row still undercounts
- the same direction as the floors it supersedes.

Same window, re-measured: **construction ACTUAL 0.42 -> 1.68 e/t**, the bridge's
construction term -29.58 -> -28.32, and P8's verdict FAIL -> ok. A #14
construction line and a #15 one differ by exactly the completed-and-departed
sites; never quote one against the other.

Both labels were renamed with the change - `build delivery (corp produced
counters)` and `construction (built, measured)` - because "site progress" is no
longer what either number is.

### The reading error this cost, recorded

Two consecutive cycle entries above stated "0 e/t built / CREW IDLE (energy
allocated, nothing built)" as measured fact. It was a meter artifact, and the
second entry repeated it from the first without re-deriving it. The corps'
counters were in the same capture the whole time. When a leak row and a
per-corp counter disagree, the counter is the measurement - the leak rows are
mostly floors and proxies, and they say so in their own comments.

## Cycle t72843748 — the handicap governs only 84% of the load; and the sweep's first readable band

Verdict: **two blockers named with data, one of them about the experiment
itself.** Capture t72843748 vs t72832806, 10,942 ticks, methodology #15,
sweep pct 13.

### The wartime episode closed itself

Controller budget 0.00 -> 40.71, construction's claim 30.00 -> 10.00, W43N21's
18-site road program completed and released. The design worked exactly as the
owner specified (2026-08-07: *"completes quickly and then releases its claim and
upgrading again takes its normal full allocation"*). The upgrade corp is back at
39 WORK, `workUtil 1.00`, `dryShare 0` - so the account's 18.14 e/t controller
line is a WINDOW AVERAGE spanning the period with no upgrade corp at all, not a
current rate.

### TOP LINE: P4 1.04x, and the handicap cannot reach the overshoot

```
sweep pct 13    physical 0.6667    plannable 0.5800

BUDGETED (what the handicap constrains)
  source-route haulers 0.293   construction 0.135   miners    0.056
  upgraders            0.035   reservers    0.026   tenders   0.023
  feeder               0.011
  SUM                  0.579   vs plannable 0.580   -> INSIDE, to 3dp

UNBUDGETED (outside it entirely)
  transient-route haulers 0.112
  coreBuster              0.024
  plan-implied total      0.691  vs physical 0.667  -> 1.04x
```

**The plan sits exactly at its budget and still overshoots the physical
ceiling**, because 16% of the load is outside the budget the handicap taxes.
And the "transient-route haulers" are not transient - `0 of 10` sources are.
They are BANK and SCAVENGE routes:

```
bank-W43N23   carry 46.0  flow 10.0  d 114     <- 46 CARRY for 10 e/t
bank-W43N23   carry  9.8  flow 40.7  d 5
bank-W43N23   carry  4.6  flow 19.1  d 5
bank-W43N23   carry  1.5  flow 19.1  d 1
scavenge x4   carry 13.7 total
```

Consequence for the EXPERIMENT, which is the part worth carrying: tightening the
handicap shrinks the budgeted classes while the unbudgeted 0.112 does not move,
so its SHARE grows as the sweep runs. Total load crosses back under the ceiling
somewhere around 17-18% - but by squeezing mining, hauling and infra to make
room for a bank/scavenge fleet that is never squeezed. That is a different
experiment from "run the whole economy tighter", and the 20-month result must be
read knowing it.

### Corrected: the drain term EXISTS

H1's detail still reads *"plan under-asks (inflow-sized carry, no drain term)"*.
That text is stale - `bufferDrainCarry` is in primitives.ts:821 and applied at
CorpPlanner.ts:1140. The plan asks for 352.3 carry parts and 306 are fielded;
the shortfall is the SPAWN, not the ask. Spawn util 0.990/0.987 against a 0.3333
ceiling each, queue depth 7 both, SCAV `spawn parts DRY (binding)`. The colony is
spawn-bound, and E6's six chronic mouths (buffers 2,505-4,340, all 100% of
window) are downstream of that, not of a missing planner term. H1's text should
be updated when someone next touches that row.

### The sweep's first result that clears the noise floor

Twelve months now closed at 100% coverage from the bot's own archive:

```
band  1-5%   n=5   sustainable 27.68 +/- 3.59   mined  91.34
band  6-10%  n=5   sustainable 37.09 +/- 3.79   mined 103.77
band 11-12%  n=2   sustainable 30.88 +/- 3.23   mined  92.00

6-10% vs 1-5%: +34% sustainable; +/-1sd ranges DO NOT OVERLAP
               (24.09..31.26 vs 33.30..40.88)
```

This is the first sweep reading above CLAUDE.md's ~30% multi-draw threshold, and
it is a BAND comparison, not adjacent months - the discipline the M01-M05 entry
above said would be required. Mining rose with it (91.34 -> 103.77), so it is not
the bank cycle flattering a smaller economy. It supports the owner's founding
hypothesis that lifting the 10% handicap overheated the economy.

Honesty limits: n=5 per band; capacity itself varied 100-120 across them; the
6-10% band contains the wartime/construction episode; months 11-12 (n=2) sit
lower at 30.88, so the curve may already be turning. The next few months decide
whether there is an optimum near 8-10% or whether 11-12% is noise.

### CORRECTION to the entry above — the bank-route attribution is FALSIFIED

The t72843748 entry claims the 1.04x overshoot is "entirely" unbudgeted classes
and names the bank routes as the 0.112. **The bank-route half of that is wrong.**

The reconciliation behind it subtracted incompatible units. `spent` accrues the
routing pass's per-unit charge (`chargePerUnit x take`, haul bodies + the sink's
`workPerUnit`); the construction sink's published `spawnLoad` 0.1354 is the
ADAPTER's all-in operation price for builders and tankers. Differencing
`haulers + sinks` against `spent` therefore compares two different quantities,
and the residual 0.088 matching bank routes' 0.0876 to five decimals was a
coincidence read as proof.

A differential unit test settles it: planning the same world with and without a
bank source raises `spent` by 0.00979 for a route publishing 0.00400 - the bank
route IS charged, and charged MORE than it publishes (the extra flow it admits
carries the sink's own work charge). Test written, run, and reverted rather than
committed, because it isolates nothing useful once the premise is gone.

**What survives, with no inference:**

```
partsLedger   plannable 0.5800   budget 0.4450   spent 0.4527   dry: TRUE
```

The plan spends more than its own budget - the planner's own report. And P4
reconstructs plan-implied 0.691 vs physical 0.667. Those two facts are the real
finding; the attribution of the gap to any particular class is NOT established.

The owner's direction stands (close the accounting gaps). The next step is a
STAMP, not a fix: `routeToSinks` should publish, per route, the charge it
actually debited. Today `spawnParts` is written by the adapter while the debit
happens in the planner, and no capture can compare them - which is precisely why
this took a wrong turn. With that stamp, `dry: true` and the 1.04x get an
auditable cause.

**The pattern this is the third instance of, in one session:** the raid-meter
OVERDUE hypothesis, the wartime relegation branch, and now this. Each time a
leak row's LABEL or a tidy numeric coincidence was treated as a measurement. The
leak rows are mostly floors and proxies and say so in their own comments;
`partsLedger`, the corp `produced` counters and the sizing stamps are the
measurements. When the two disagree, the measurement wins - and a residual that
matches a candidate to five decimals is a hypothesis, not a proof.

## Cycle t72846447 — the charge stamp (flow segment v16), and one located defect

Verdict: **instrumented**, plus one real defect found by READING rather than
differencing. Capture t72846447 vs t72843748, 2,699 ticks, methodology #15.

### Why a stamp and not a fix

The P4 overshoot (1.02x this window, 1.04x last) has now been hand-derived FOUR
times, each derivation disagreeing with the last:

1. "the handicap governs only 84% of the load" - bank routes named as the gap.
2. Falsified: `spent` accrues the routing pass's `chargePerUnit x take`, while
   the sink's published `spawnLoad` is the ADAPTER's `operationSpawnLoad`.
   Differencing them compares different quantities.
3. "the charge and the publication use different arities of `carryPartsFor`" -
   falsified by reading it: `(rate * roundTripTicks(d)) / CARRY_CAPACITY` is
   exactly LINEAR, so `carryPartsFor(1,d)*take === carryPartsFor(take,d)`.
4. "construction's sink work is under-charged" - falsified by reading
   `workPerUnit`: construction is charged ALL-IN (spec 34 D4, "the WORK bodies
   plus the supply vector"), the same charge the commission envelope declares.

Four wrong derivations of one number is the signal to stop deriving. The debit
happens in `CorpPlanner.routeToSinks`; the price is published by
`flowAdapter`/`flowSegment`; nothing let a capture compare them.

### What v16 publishes

- `haulers[].charged` - what the route actually DEBITED, beside `spawnParts`,
  what it is PRICED at.
- `sinks[].chargedWork` - the consumer-body charge the routing pass debited,
  beside the adapter's independently-computed `spawnLoad`. Published for EVERY
  sink kind, unlike `spawnLoad`, which is construction-only by design (that
  explains the controller sink's `spawnLoad 0.00000`, which an earlier entry
  read as a gap - it is deliberate).

`partsLedger.spent` now decomposes from a capture instead of by hand.

The golden master already earns it: across 11 routes in the standard worlds,
`charged === spawnParts` to 1e-9 with zero mismatches. The haul side of the
ledger is provably honest, which retires derivations 1 and 3 permanently.

### The located defect (stamped, NOT fixed here)

`routeToSinks`'s port-drain hauler debits the ledger UNGUARDED:

```ts
partsRemaining -= drainParts;   // line ~991 - no maxByParts clamp
```

Every route in the fill loop clamps its take by `partsRemaining / chargePerUnit`
first; this one does not, so it can drive `partsRemaining` negative. That is how
the live ledger reads `spent 0.4527 > budget 0.4450, dry: true` - the plan
spending past its own budget, which is the accounting gap the owner asked to
close, now located by reading the debit rather than differencing totals.

Not fixed in this commit: clamping it is a live-behaviour change needing the
full regression gate, and this commit is telemetry-only so it can ship now and
make the next cycle's diagnosis a read instead of a derivation.

## Cycle t72846812 — the unguarded drain debit, FIXED

Verdict: **fixed.** The defect located (by reading) in the previous cycle's
stamp commit, now clamped and pinned.

### What was wrong

Every route in `routeToSinks`'s fill clamps its take against the ledger first:

```ts
const maxByParts = partsRemaining / chargePerUnit;
const take = Math.min(avail, target - acc.allocated, maxByParts);
```

The port-DRAIN hauler, appended after the fill, did not:

```ts
partsRemaining -= drainParts;     // no clamp
```

so it could drive `partsRemaining` NEGATIVE and make `spent` exceed `budget`.
Live: `budget 0.4450, spent 0.4527, dry: true`. In the unit world the overdraw
scales with the port's forward leg, because `drainParts` grows with distance
while the budget does not:

```
drainFrom x   budget     spent      verdict
        40    0.28863    0.10182    fits
       300    0.28863    0.45714    OVERDRAWN 1.58x
       600    0.28863    1.12167    OVERDRAWN 3.89x
      1200    0.28863    6.41146    OVERDRAWN 22.2x
```

### Why it matters more than 0.0077 p/t

The parts budget is the ONE control the spawn-handicap sweep turns. A debit that
can ignore it is a hole in the instrument, not just in a plan - and the sweep is
mid-experiment. It also explains, exactly, the `dry: true` that three cycles of
hand-derivation kept trying to attribute to unbudgeted CLASSES: nothing was
unbudgeted, one debit was unclamped.

### The fix

Scaled, not dropped. A drain is a RATE, so a partially drained port is a real
plan while an unaffordable one is not - the same shape as the fill's
`take = min(avail, target - allocated, maxByParts)`:

```ts
const drainPerUnit = (2 * carryPartsFor(1, dDrain)) / effectiveLife(dDrain);
const affordable   = drainPerUnit > 1e-12 ? Math.max(0, partsRemaining) / drainPerUnit : Infinity;
const drained      = Math.min(deposited, affordable);
if (drained <= 1e-9) continue;
```

`carryPartsFor` is exactly linear in rate, so the per-unit form is exact and the
route's published `spawnParts` still equals its `charged` (pinned).

Three tests: the clamp holds at x=300; the drain is TRIMMED not deleted (a rate,
not a purchase); and the affordable case at x=40 is bit-identical to before
(`spent 0.10182264979202682`, `dry false`) so the guard cannot perturb the
ordinary path.

Gate: 2266 unit, build clean, flow-handoff + runt-economy + storage-depot green,
`plan-t3-budget-subset` [P]. `plan-t1-single-source-loop` fails the same single
assertion it failed in isolation BEFORE this change - identical pre/post,
acquitted.

## Cycle t72847768 — prediction CONFIRMED, and the charge stamp finds the real gap

Verdict: **fixed (verified live) + blocker located by MEASUREMENT.**

### The drain clamp works

```
t72843748   budget 0.44498  spent 0.45269  dry true   OVERDRAWN 0.00771
t72846447   budget 0.42277  spent 0.43036  dry true   OVERDRAWN 0.00759
t72846812   budget 0.42277  spent 0.35294  dry false  <- clamp deployed
t72847768   budget 0.41631  spent 0.37065  dry false
```

Registered before deploy, confirmed after: `spent <= budget`, `dry` false.

### And `spent` now RECONCILES

```
charged haul 0.26933 + charged work 0.10132 = 0.37065 == spent 0.37065
```

Exactly. The parts ledger is decomposable from a capture for the first time -
which is the whole point of v16, and it immediately paid for itself.

### THE ACCOUNTING GAP, measured rather than derived

```
haulers   published 0.29747   charged 0.26933   gap 0.02814
sinks     spawnLoad 0.19797   chargedWork 0.10132  gap 0.09665
                                        TOTAL     0.12479 p/t = 18.7% of ceiling
```

Per-route, the pattern names its own cause:

```
bank + short (d=1..5) routes    ratio 1.000    neither uplift applies
long source routes              ratio 0.85-0.93  drain term
scavenge routes                 ratio 0.414, 0.328  transient floor
```

`CorpPlanner` applies a **PHASE-1 ROUTE REPRICING after `routeToSinks` returns**
- the `bufferDrainCarry` drain term and the `scavengeFloorParts` transient floor
- and its own comment states the intent:

> *"~1.0 e/t of real fleet stood permanently outside the budget"* ...
> *"the account's 'transient-route haulers (unbudgeted)' 2.0 e/t becomes a
> budgeted line."*

**It moved the PRICE and not the CHARGE.** The uplift is added to published
`spawnParts` after the ledger has already been debited, so the fleet it prices
is still unbudgeted - the exact condition the reprice was written to end.

That also settles P4's `transient-route haulers (unbudgeted)` row, which three
cycles of hand-derivation misattributed (bank routes, `carryPartsFor` arity,
construction under-charge - all falsified). The row is named verbatim in the
comment of the code meant to fix it.

### NOT yet explained: the sink half

`chargedWork` is ~0.51 of `spawnLoad` on BOTH construction sinks (0.06898 vs
0.13535; 0.03234 vs 0.06261). Construction's `workPerUnit` is all-in by spec 34
D4 and the adapter's `consumerSpawnLoad` uses the same formula, so a near-exact
0.51 on both looks like one factor, not a modelling difference. Labelled a
HYPOTHESIS and left there - deriving it is what went wrong four times already,
and the numbers are now published, so the next cycle can read it.

### The fix (next cycle, live-behaviour, full gate)

Debit the phase-1 reprice. The uplift is real fleet the corps field; the ledger
should charge it where every other route is charged, which likely means pricing
the drain and floor terms INSIDE `routeToSinks` rather than repricing after.
Expect the budget to tighten by ~0.028 p/t and some marginal sources to fall
out - that is the correct consequence, not a regression.

## Cycle t72847768b — the phase-1 reprice moves INSIDE routeToSinks

Verdict: **fixed.** The gap the v16 charge stamp measured last cycle, closed.

### What was wrong

`planColony` applied two uplifts AFTER `routeToSinks` had returned - the
`bufferDrainCarry` drain term and the `scavengeFloorParts` transient floor.
Both raised a route's published `spawnParts`; neither reached `partsRemaining`.
The fleet they price stayed OUTSIDE the budget, which is the exact condition the
reprice was written to end (its own comment: *"the account's 'transient-route
haulers (unbudgeted)' 2.0 e/t becomes a budgeted line"*). It moved the PRICE and
not the CHARGE.

Measured live t72847768, off the v16 stamp - which is the only reason this was
findable after three cycles of hand-derivation misattributed it:

```
haulers published 0.29747   charged 0.26933   gap 0.02814
  bank + short routes    ratio 1.000       neither uplift applies
  long source routes     0.85 - 0.93       drain term
  scavenge routes        0.414, 0.328      transient floor
```

### What was KEPT, and why

The post-pass SHAPE was always right and is preserved: both terms are
stock-shaped (flow-independent), so folding them into `chargePerUnit` - which
drives `maxByParts`, and therefore how much each sink takes - would distort
marginal pricing. Only its LOCATION was wrong: outside the ledger's scope.

### The half of the justification that had expired

The original comment also argued these "land inside the plan's 10% execution
headroom". That headroom is `SPAWN_PLAN_FRACTION` - which the handicap sweep
(spec 50) now VARIES on purpose, currently 13% and walking to 20%. A cost that
hides in the margin is a cost that consumes the experiment's own instrument, so
an argument that was reasonable when the margin was a fixed constant stopped
being reasonable the day the margin became the thing under test. Worth carrying:
**spec 50 invalidated every "it fits in the headroom" argument in the
codebase**, and this is the first one found.

Debited rather than clamped: unlike a route's take there is nothing to scale
(the drain law clears one generation, the floor is one body), and dropping the
uplift would restore exactly the under-pricing this fixes. It can push the ledger
dry, which is honest - `dry` then means what it says.

### Gate

2269 unit (golden master unaffected - its worlds carry no staged buffers, so no
uplift applies), build clean, flow-handoff + runt-economy + storage-depot green,
`plan-t3-budget-subset` [P]. `plan-t5-remote-pipeline` fails
`"extensions refill before the draining spawn finishes"` - ATTRIBUTED: identical
failure on pre-change source in a clean worktree (@400/700t vs @573/700t; the
cell is not tick-deterministic but the assertion is the same), and it was
already red in the clean full-grid run two cycles ago. Acquitted.

### Expected live consequence

The budget tightens by ~0.028 p/t and marginal sources may fall out. That is the
correct consequence of charging for fleet the corps actually field, not a
regression - and it is the first time the sweep's handicap has governed the
whole plan rather than 84% of it.

---

## Audit cycle t72849380 — the infra gap was PART arithmetic, and the tax was aimed at the wrong quantity

**Top line: L1 (loss-budget adherence), 53× budget — pile decay 13.27 e/t
against a 0.00 budget.** The ledger's own rows name the mechanism, and they
agree with each other:

- **E6**: 6 of 11 miner ops deferred by the pile gate, CHRONIC (78–100% of the
  window), buffers 2,737–3,553 — *"the leak is HAULING (drain term / route
  sizing / churn), not the miner"*.
- **H1**: duty 0.81, `idleSource 0.00`, 6,955e on the ground — *"haulers BUSY =>
  plan under-asks"*. They are not idling; there is not enough CARRY.
- **F1 class mix**: source-route haulers fielded 0.089 p/t against a planned
  0.300, while feeder ran 0.246 and tenders 0.167 against 0.021/0.032.

So the colony's spawn time went to depot movers and the haul fleet was crowded
out; energy piled at six source mouths and decayed. Not fixed this cycle —
named, with its chain measured end to end.

**A caution on reading F1's actual side.** Those breach numbers are purchases
over a 203-tick ring, so a single 100-part feeder buy reads ~0.49 p/t
instantaneous. The DURABLE comparison is standing parts vs declared: feeder 100
fielded vs 32 priced (3.1×), tender 86 vs 48 (1.8×). Both are real; neither is
22×.

### Fixed: methodology #17 — P4's depot-mover budgets were a second book

Reading the account's worst unfavourable line (infra, budget −1.97 vs −12.61
actual) found part of it was arithmetic. P4 RECOMPUTED the feeder and tender
budgets instead of calling the primitives the plan charges with, and both copies
had drifted in opposite directions:

- **feeder** — `2 * carryPartsFor(relay, d)` predates spec 45's volley-service
  floor, so at relay 100 link-fed it printed `16p=0.011` while the feeder
  COMMISSION declared `0.02135`. The ledger was reporting the plan charging half
  what it charges.
- **tender** — `sizing.target × MEASURED body` is ACTUALS-FED: the budget moved
  with the fleet it exists to judge.

Third instance of the class after #8 (reserver duty, an +8.02 F variance that
was pure arithmetic) and #7 (hauler spawnParts). After the fix the P4 lines
match the commissions' declared `consumes` to the digit, infra budget reads
−2.67, F1 unbudgeted drops 5% → 2% — **and the remaining infra gap is behaviour,
which is the point.**

The era pins that moved are the demonstration: the budget-dry boundary fixture
went 0.987 → 0.936 because THAT era's fielded tender was fat, while the same fix
moves the live capture the other way (43p → 48p). An actuals-fed budget reads
high exactly when the fleet is fat. That is what it costs.

### Fixed: the invader tax, derived instead of calibrated

Owner: *"We can estimate the invader tax rate from first principles. 10 or 20
energy mined per tick. Every 10,000 to 5,000 ticks for 100,000 trigger right?"*
Right, and it collapses the calibration question:

```
ticks per raid cycle   = INVADER_RAID_MEAN_ENERGY / roomMinedRate
ticks ARMED per cycle  = (MEAN - RAID_ARM_FLOOR) / roomMinedRate
guard cost while armed = roomGuardSpawnLoad() x 65 e/part
tax per energy mined   = guardCost x armedTicks / MEAN
```

`EXPECTED_RAID_DEFENSE_COST = 750` is "one guard body (650) + 15% margin" — a
PER-RAID PURCHASE, which was the right model while nothing else priced guards.
Since spec 51 phase 2 the guard is a STANDING fleet, so what a room owes is the
TIME it holds one — inversely proportional to how fast it mines. **A single
coefficient cannot express that**, so the tax is now a function of the ROOM's
rate (the meter accrues per room).

This retires R1's calibration gate for this quantity. Seven windows never
converged because the numerator was wrong, and R1's own evidence gate says so:
killed-WHERE reads 99–100% HOME ROOM, ~0% intel-hostile. Expected raid LOSS is a
separate question and keeps its own constant.

### A hypothesis of mine, FALSIFIED by reading the code

I told the owner the guard body was now "charged twice in the same currency" —
once as `infraSpawnEnergy` and once at admission. Wrong. `CorpPlanner`'s tax
enters `net`, which GATES and RANKS candidates; no energy leaves the plan
through it. `infraSpawnEnergy` sizes the spawn sink's actual demand. They are
different books and both are correct. Recorded because the correction came from
reading the call site, not from re-theorizing — the reflex the method is for.

### Gate

unit 2293; tsc clean both projects; flow-handoff, runt-economy, storage-depot
PASS. `plan-t5-remote-pipeline` red on the refill SLA — ATTRIBUTED, identical
assertion at the parent commit in a clean worktree (@395 vs @468; the cell is
not tick-deterministic), and all four of its remote-ADMISSION assertions pass
unchanged at both commits. Acquitted.

Fiscal: FY4856-M06 closed (t72847500→t72849000, 100% coverage, handicap 16%).
Sweep now at 17%.

**Verdict: FIXED (two accounting seams closed) + NAMED (the pile-decay chain,
with its mechanism measured end to end).**

---

## Audit cycle t72851084 — one prediction confirmed, one falsified, one refused

Post-deploy verification of the two previous cycles' fixes.

### CONFIRMED, and larger than predicted: construction scope

```
construction sinks:  0            (was 1: W41N25, demand 10 @ priority 70)
controller sink:     allocated 51.05, unmet 0   (was 32.58, unmet 35.69)
P4:                  0.72x        (was 0.99x)
account:             construction  0.00 / 0.00 / +0.00   (was 10.00 / 0.00 / -10.00 U)
```

**+18.47 e/t of plan allocation moved to the controller** — more than the ~10
predicted, because the site was displacing through the ladder as well as taking
its own claim. The site itself still stands in `siteLedger` (`W41N25 rem 418`),
unfunded and costing nothing, exactly as designed.

### FALSIFIED: "the mouth-stock stamp is not being written"

A `Memory.pileMeter` probe reads nine mouths carrying fresh stock at the capture
tick — dbcd8d 5274, dbcd98 3075, dbcedc 3003, dbcee0 2864, dbcee2 2002, dbd01f
1945, dbcd94 1815, dbcd8e 1590. **The write side works.**

But the drain uplift is not landing at anything like the priced size:

| tail | stock | expected Δ p/t | actual Δ |
|---|---|---|---|
| dbcd8d | 5274 | +0.0081 | +0.0004 |
| dbcee0 | 2864 | +0.0044 | −0.0002 |
| dbcedc | 3003 | +0.0047 | −0.0002 |
| dbcd98 | 3075 | +0.0100 | +0.0050 |
| dbd01f | 1945 | +0.0059 | −0.0001 |

The parts ledger is not dry either (`spent 0.339 / budget 0.403, dry false`), so
the obvious second suspect is out.

E6 reads 5 of 11 gated (was 6), pile decay 13.52 (was 13.36), forgone mining
**10.32 e/t (was 2.82) — MISS**. The drain fix has not yet moved its target.

### REFUSED: a third derivation

**My own deploy prediction was wrong on a field the term never writes to.** I
predicted "source routes carrying `flow > 10`"; the drain reprice adds to
`carryParts` and `spawnParts` and never touches `flowRate`. It folds into
`carryParts`, so from a capture "the lens is dead" and "the lens is fine, the
uplift is small" print *identically*.

Per the method — one falsified hypothesis ⇒ instrument, don't re-theorize — the
plan now publishes its own input: `sources[].staged` (flow segment **v17**), the
buffer the reprice actually read. Absent means the plan saw no buffer, which is
a different statement from zero. One capture then decides between "the lens
never reached the problem" and "it reached it and the uplift is eaten
downstream".

### Also moved, worth watching

- **R1 5.70× the priced tax** (was 2.70×), and killed-where now reads **20% in
  intel-hostile rooms** (W44N23) against 0% for every prior window. Tombstone
  losses 3.47 e/t, 99% killed. That is the first window where the raid story has
  real evidence behind it — the evidence gate that has been holding
  `EXPECTED_RAID_DEFENSE_COST` may be about to open.
- **Residual −4.27** (was +0.61). Bank draining 23.13 e/t; INCOME-FUNDED 39%.

Fiscal: FY4856-M07 closed (t72849000→t72850500, 100%, handicap 17%).

**Verdict: FIXED (construction scope, +18.47 e/t measured) + INSTRUMENTED (the
drain term's input, after refusing to guess twice).**

---

## Gate note — the core-link shuttle resize (5d7a567), and two false alarms I raised on my own test runs

**Gate: GREEN, deployed.** unit 2305, tsc clean both projects, build clean,
`flow-handoff` PASS, `runt-economy` PASS (`1 passing (4m)`, 221559ms, "upsize
PROVEN" at tick 460), `storage-depot` PASS (7s).

The commit message says *"GATE INCOMPLETE - NOT DEPLOYED"*; that was true when
written and is superseded here.

### The methodology failure worth keeping

I twice reported `runt-economy` as anomalous, and both readings were artifacts
of how I ran it, not of the test:

1. **"Reproducible >600s slowdown, and host load is 0.20 so it isn't the
   documented contention case."** It runs in 3.7 minutes. Both long runs were
   piped (`... 2>&1 | tail -3`, `... | sed | tail -6`); the unpiped run finished
   well inside the normal band.
2. **"Exit 0 was meaningless and the captured output is a stack trace — it's
   likely failing."** Half right for the wrong reason. The exit code WAS
   meaningless — a pipeline reports the LAST command's status, so `| tail` was
   reporting success regardless of mocha — but the trailing `at Generator.next`
   frames were benign `--full-trace` output, not a failure. The test was
   passing the whole time.

**The rule this earns: never run a gate through a pipe.** `cmd > file 2>&1;
echo $?` preserves both the exit code and the full result; `cmd | tail` destroys
both and then invites a diagnosis of the diff. The existing "grid verdicts are
markers, never exit codes" trap is the same failure in a different costume —
this is its mocha twin, and it cost two ~10-minute runs plus two wrong calls
reported to the owner before the third run settled it.

### Effective capacity and effective body bill (owner correction, same cycle)

Owner: *"Creeps cycle on effective ttl not 1500... Effective spawn capacity (max
minus extension refill lags) and effective body budget."* Both land, and
together they close most of the headroom previously reported:

```
  physical capacity    1000 parts/month     2 spawns x 1500 / 3
  EFFECTIVE capacity    792                 minus extension-refill lag
  actually built        769                 = 97% of EFFECTIVE
  effective body bill   689                 effectiveLife, not flat 1500
  headroom              104                 (previously reported as 342)
```

The body bill was wrong in BOTH directions on a flat-1500 basis and landed near
the right total by luck: far remotes cost MORE (cd98 at d=105 is 68.8 against 64
standing) and reservers cost LESS (39.2, not 70 - `RESERVER_DUTY = 0.5`, the
corp coasts on the reservation bank).

The capacity correction is the sharper one. **The spawns run at 97% of what the
refill actually permits** - so "the plan asks and the spawn does not deliver"
was reading a physical ceiling as if it were reachable. 208 parts/month are
burned by an empty extension network. Extensions are room-wide, so the 7% vs 35%
`idle.empty` asymmetry between Spawn1 and Spawn2 is not two supplies but two
sampling windows on one - which puts it on the TENDER, standing 34 parts against
the plan's own `TENDER_FLEET_PARTS = 48`. That is the one infra line that is
UNDER-fielded, and its failure is the 208.

---

## Audit cycle t72854064 — the purchase receipt earns itself on its first window, and overturns two of my conclusions

47 receipts landed. They settled in one capture what three cycles of derivation
could not, and both answers were against me.

### The tender was never starved, outranked, or under-bodied

```
t72853869  tanker  moving-W43N23-tender
           want=2500  grant=2500  cost=1700  parts=34  fill=5300/5600  rank=0/5
```

It asked for a full body, was granted the **entire ask**, from a room at **95%
fill**, having won its slot **first of five** — and built 34 parts anyway. Its
own sizing stamp closes it: `neededCarry 25, fieldedCarry 25, target 1`.

**The tender is at exactly its own stated need.** The 34-against-48 gap I chased
for three cycles is between the PLAN's `TENDER_FLEET_PARTS = 48` and the CORP's
25-CARRY law — a price-vs-behaviour disagreement (P5's class), not a shortage.
Every mechanism I proposed for it — count-gated promotion, refill starvation,
the heartbeat lane — was answering a question that was not being asked.

### And the extension network is no longer starving the spawn

```
Spawn1  util 0.973  idle {empty: 0, buy: 6}
Spawn2  util 0.983  idle {empty: 0, buy: 7}      (was empty 210 of 606)
```

`empty: 0` on both. S5 reads 0.98x the physical ceiling — the spawns run flat
out. The "208 parts/month burned by an empty extension network" line from the
previous cycle is gone. NOT ATTRIBUTED: the regime tier (a4dc3c4) and the
shuttle resize (5d7a567) both deployed into this window, and one window cannot
separate them from ordinary variance. Recorded as a delta, not a cause.

### Confirmed: the shuttle resize landed exactly as specified

```
controllerFeeder  creeps 1  parts 16  body {carry: 8, move: 8}  neededCarry 8
```

The owner's 8 CARRY, live. Down from 100 parts — 84 parts/month returned, the
single largest corp line in the colony.

### The receipt's own first bug, found by the same window

`declared` read 0 on all 47 rows: `consumesOf` matched `e.corpId` (the
planner-pure commission id) against `chosen.buyerCorpId` (the corp's runtime
id). The corp-id-prefix trap; `corpById` two hundred lines above already joins
on `corp.id`. Fixed and deployed the same cycle.

### THE NEW TOP LINE: relegation without delivery

The ledger names P1 (2 flapping sources), but the larger number is P12 at
**0x** — published controller allocation **0.00** against a law cap of 59.11:

```
controller   demand 0     alloc 0      pri 45.1
construction demand 10    alloc 10     pri 70
storage      demand 417   alloc 110    pri 1
account:     controller BUDGET 0.00 / ACTUAL 42.16 · to bank BUDGET 49.46
```

This is spec 33 WARTIME RELEGATION working as written (owner 2026-08-05: *"I
WANT construction to be the primary consumer over controller if we have a
construction project"*). A backlog reappeared — `W43N21 1 site rem 5000`, a
real site in a WORKED room, admitted by the construction-scope fix — so every
controller relegates to its floor and the residual banks.

The problem is the other half: **construction built 0.00 e/t against its 10.00
budget.** `building-W43N21-construction` stands 1 creep / 4 parts against a
declared 0.1377 p/t (~207 parts). So the colony relegated ~59 e/t of controller
allocation to fund a project that fielded a 4-part builder and delivered
nothing. The controller's 42.16 actual is bank drawdown, not plan.

Relegation is correct doctrine; relegating for a consumer that cannot convert is
the leak, and it is worth more than pile decay (14.42) by a factor of four.

**Next capture reads `want`/`grant`/`declared` on the `building-W43N21` rows.**
That is exactly the discrimination the receipt was built for, and with the id
join fixed it will now carry the declared side.

**Verdict: INSTRUMENTED (the receipt, earning out immediately) + TWO PRIOR
CONCLUSIONS FALSIFIED (tender starvation, network starvation) + NEW TOP LINE
NAMED (relegation without delivery, ~59 e/t).**

---

## Audit cycle t72865978 — the port tender was never buildable, and it blinded both wedge instruments

Window t72827522 -> t72865978 (dt 38,456; the colony ran unattended for ~25
fiscal months). The ledger's TOP LINE was P1 (2 flapping sources); the actual
work item was found one level below it, in the agenda.

### The read

The queue HEAD on **both** spawns was the same demand, and it had been there for
1804+ ticks:

```
{ role: "porttender", corp: "moving-W43N23-controllerFeeder",
  mustFund: false, why: "consume", since: 72864174, gate: "impossible" }
```

`gate: "impossible"` is the verdict reserved for a body this RCL can NEVER
build. No `minCost`, no `desiredCost` in the published entry. The flight
recorder agreed, 16 rows out of 16, twice at `bank: 5600` — the room's FULL
energy capacity:

```
{ t: 72865475, k: "hold", d: { role: "porttender",
  corp: "moving-W43N23-controllerFeeder", bank: 5600 } }   // no minCost field
```

`LinkCorp.portDemands` built its demand through an `as SpawnDemand` cast (the
only such cast in `src/`) and omitted both required cost fields. Nothing threw:
every funding decision in the walk is a numeric `>=`, and `x >= undefined` is
false, so `canEverAfford` was false and the demand was recorded "impossible"
forever. **No port tender has ever spawned** — 0 of 92 spawn rows in the ring;
the corp stands 1 creep (the feeder, 8 CARRY / 8 MOVE).

### What makes this a spec-14 incident and not just a bug

The same missing field disabled BOTH instruments built to catch a wedged spawn,
and both then printed something reassuring:

- `minCost > energyAvailable` is also false, so `buildAgendaQueue` published no
  `bank>=N` precondition. `classifySpawnIdle` keys on exactly that to separate
  energy-starved from a chosen wait, so it booked every idle tick as **"hold"**.
  S4 read `idle 18% of window [hold 100%]` — 18% and 38% on the two spawns,
  100% attributed to a CHOSEN wait.
- S3 formats the head as `head ${role}@${minCost}` and tests
  `energyAvailable >= head.minCost`. It printed
  `head porttender@undefined vs bank 3857 (holding/funding - not a stall)` and
  verdicted **ok**.

A malformed demand does not just fail to buy; it degrades into the one gate
value that means "nothing to see here" while suppressing the signal every
downstream reader uses. That is why the fix is at the SEAM, not only at the
call site.

### The economic surface behind the dead body

The plan is already committed to this drain. `depositSavings` routes 40 e/t
through each of two ports (`rho` 0.85 / 0.78 of headroom), 8 remote sources are
priced at the SHORT leg (savings 8-16 tiles each, ~990 tile*e/t), CorpPlanner's
stage-4 deposit drain prices the port->storage leg, and `infraSpawnLoad` charges
`portTenderSpawnLoad()` for a body that could not exist. The runtime side is
live too: `pickStorageDeposit` prefers the port link, falls back to the port
BUFFER, then WAITS up to `PORT_WAIT_CAP` (30t) before walking the long leg —
and the buffer is what the tender drains.

### Fixed

- `LinkCorp.portDemands(ctx)` declares `desiredCost` =
  `buildTankerBody(PORT_TENDER_CARRY, capacity, false).cost` (400e, exactly the
  `PORT_TENDER_PARTS` body the plan prices, so F1/F2 compare like with like),
  `minCost` = the feeder's 2-pair floor (200), and `why: "infra"` — declared per
  spec 35 phase D, where `agendaWhy` had been falling through to "consume".
- **The class, at the seam**: `hasFundableCosts` (SpawnScheduler) + a check in
  `collectDemandsMatching`, the single point every corp's demand crosses. A
  demand whose costs are not two finite non-negative numbers never reaches the
  pool, and the drop records a black-box `err` row naming the role and corp.
  Zero stays legal (cold-start floor bodies price that way).

Red-first: `test/unit/corps/portTenderDemand.test.ts` (6 cases, including
"never gate 'impossible' at full capacity" and "publishes bank>=N so the idle
classifier sees 'bank'") and `test/unit/execution/demandCostGuard.test.ts`
(5 cases). Gate: unit 2351 passing, plus `flow-handoff`, `runt-economy`,
`storage-depot` green on the rebuilt bundle.

### Predictions for the post-deploy capture

1. A `porttend` creep on `moving-W43N23-controllerFeeder`: 6 CARRY + 2 MOVE,
   400e, within ~50 ticks (infra lane, bank never below 200).
2. No `gate: "impossible"` head on either spawn; no `hold` row naming
   `porttender`.
3. **The discriminating read**: if the impossible head was merely riding along,
   spawn `idle.hold` stays ~18%/38% and its head becomes something else. If the
   ports were genuinely starved of a drain, the port-routed haul legs stop
   waiting and E6's chronic miner holds (5 of 12 ops) should ease. The walk
   never HOLDS for an impossible demand, so prediction 3 is a real test, not a
   formality — I expect idle to stay and the port drain to be the payoff.

### Not fixed this cycle, named with data

There is no meter on the port BUFFER's fill, so "the buffer backed up while
nothing drained it" remains a HYPOTHESIS: the capture carries `sourceBuffers`
(per-source containers) and the hub/controller link rates, but nothing reads the
port containers. Next cycle's stamp, if prediction 3 is ambiguous.

**Verdict: FIXED (the demand) + CLASS CLOSED (the cost seam) + a measurement
gap named (port buffer fill).**

### Post-deploy verification (capture t72866550, 572 ticks after the deploy)

**Prediction 1 — CONFIRMED, mechanically and exactly.** The purchase receipt,
the first one this body has ever had:

```
{ t: 72866365, k: "spawn", d: { role: "porttender",
  corp: "moving-W43N23-controllerFeeder", cost: 400, parts: 8,
  want: 400, min: 200, grant: 400, fill: 4500, cap: 5600,
  pri: 17000078, rank: 0, why: "infra" } }
```

`parts: 8` is `PORT_TENDER_PARTS`, `grant == want == 400`, `why "infra"` as
declared, `rank 0`. The corp's body confirms both creeps on one post: 14 CARRY /
10 MOVE / 24 parts = feeder (8C/8M) + port tender (6C/2M). (`creepCount` still
reads 1 — the census counts the primary role; the parts table is the truthful
side. Minor, noted, not chased.)

**Prediction 2 — CONFIRMED.** No `gate: "impossible"` on either queue; both
heads are real haulers at `gate: "buy"`. Zero `hold` rows in the new ring (was
16 of 16). **Zero `err` rows** — the new seam guard fired on nothing, so no
other kind is shipping cost-less demands.

**Prediction 3 — went AGAINST what I predicted, and I cannot attribute it.**
I said idle would STAY, because `walkDemands` provably never holds for an
impossible demand. Idle instead collapsed:

| | t72865978 | t72866550 |
|---|---|---|
| Spawn1 idle | 18% (hold 100%) | 3.0% over the new 572t |
| Spawn2 idle | 38% (hold 100%) | 1.9% over the new 572t |
| S4 recoverable | 0.18 WARN | 0.04 ok |
| P1 funded flips | 2 FAIL | 0 ok |

**This is not evidence for the fix.** There is no mechanism: an impossible demand
sets neither `outcome` nor `holdForBlocking`, so the walk passes straight over
it. Part of the change is pure RECLASSIFICATION (the old head was always the
impossible port tender, so every idle tick was forced into "hold"), the
pre-samples were 134 and 333 ticks, and the deploy's global reset lands inside
both meter windows. Recorded as coincident, not caused.

**Prediction 4, the heartbeat guard — HELD.** Controller delivery 40.15 -> 39.00
e/t (flat). P7 moved ok -> WARN 0.73x only because the PLAN rose (published
allocation 53.61 -> 63.41; P12 still 1x of the law). Bucket 10000, no losses, no
deadlock — the instrument is safe. **Watch item:** the core link is fuller —
`coreEmptyShare` 0.392 -> 0.303, `coreCongestedShare` 0.083 -> 0.134,
`hubClampShare` 0.41 -> 0.75. Consistent with the port drain now delivering into
the core, and a less-drained core is the direction doctrine calls unhealthy.
200-tick window; re-read next cycle before acting.

### The number I am NOT claiming

Forgone mining read **37.11 -> 2.06 e/t** (gross mined 82.89 -> 117.94, 98% of
the 120 capacity), and the residual's over-attribution nearly closed
(-25.74 -> -6.48). That would be the largest single move this project has
measured, and it is exactly why it needs a real window before it is claimed:

- 572 ticks against a 38,456-tick baseline. CLAUDE.md's multi-draw rule prices
  identical-code 3000-tick draws at +-20-30%; this sample is five times shorter
  than that.
- **E6 contradicts it.** Deferred miner ops went 5 of 12 -> **10 of 12**, and the
  pile-gate `heldFrac` stamps explain 76.13 e/t (up from 72.05). The miners say
  haul is MORE binding; the mined counter says almost nothing is forgone. Both
  cannot be right.
- The window straddles a global reset, and `forgone` is a difference of
  cumulative counters.

**Next cycle re-reads forgone over >=3000 ticks with no reset inside it.** If it
holds, the port drain is worth more than every leak row on the sheet; if it does
not, the discrepancy is in the mined counter and that is the bug.

### Two findings this verification produced on its own

1. **The ledger cannot price the port tender.** The `port tenders` plan line is
   gated on `flow.fleetCharge?.infraInputs?.portRooms`, and `fleetCharge` is
   absent from BOTH captures — so F1 books the tender's 8 parts as unbudgeted
   `feeder` spend (0.148 vs 0.011 planned, a 13x breach that is really a missing
   plan line), and P4 lists no port-tender row at all.
2. **Why it is absent is the interesting part.** `fleetChargeStamp` is a
   module-level `let` in flowAdapter, set only on the solve path. After a global
   reset the plan is restored from Memory, so the stamp stays empty until the
   next full re-plan — up to a 1500-tick cadence (spec 46) of blindness in the
   one stamp that makes the fleet charge auditable, after every deploy. Same
   class the spawn meter already solved by keeping window state in Memory rather
   than the heap. **Named for next cycle; not fixed blind here.**

**NEW TOP LINE: L1 — ground pile decay 18.85 e/t against a budget of 0.00**
(75x the worst-line tolerance, 21% of capacity now sitting in the losses block).
It was 14.99 last cycle and grew, which is consistent with more energy being
mined into the same drain. It is the same story as E6: the colony's constraint is
HAULING, and the port drain is one leg of it.

**Cycle verdict: FIXED + VERIFIED (the port tender fields, 400e/8p, first buy at
the first opportunity) · CLASS CLOSED (the cost seam, and it caught nothing else
- confirming this was the only such demand) · ONE OF MY OWN PREDICTIONS
FALSIFIED (the idle mechanism) · one headline number DEFERRED for want of a
window · two new instrumentation gaps named.**

---

## Audit cycle t72866607 — the top line's cost was in no decision that could fix it

Same shape as this session's earlier incident, one layer out. The port tender's
cost was missing from the funding comparison; here **pile DECAY is missing from
the scavenge admission**, and the L1 top line is the result.

### The read (629t window, statement in full)

```
delivered into the economy   114.81 of 120.00 capacity
losses                        25.11 e/t  (21% of capacity)   <- pile decay 18.68
controller (score)            39.00 vs plan 63.41  (-24.41 U)
RESIDUAL                      -5.50   (was -25.74 last cycle)
```

The controller's whole 24.41 shortfall is three terms: losses -12.61,
construction -7.19, bank -6.07. Losses is the biggest, and pile decay is 74% of
losses.

### Why nothing was fixing it

`CarryCorp.haulCarryNeeded` returns `ceil(sustained)` for any storage-backed room
— **the drain term exists only in bootstrap** (deliberate, 2026-08-03: *"a mature
room doing the same buys F1's breach"*). So a mature colony's route haulers are
sized to sustained INFLOW and, by construction, never clear an accumulated pile.
The scavenger is nominally that mechanism, and the source-pileup instrument's own
discriminator (deployed 2026-07-26, never read until now) settles which of its
two candidate mechanisms is live:

```
hauling-W42N22-hauling--8-8   carryNeeded 1  staged 3452  srcLink null
hauling-W43N22-hauling-0-30   carryNeeded 1  staged 3992  srcLink null
hauling-W42N21-hauling-37-2   carryNeeded 2  staged 3303  srcLink null
hauling-W43N21-hauling-4-37   carryNeeded 3  staged 1896  srcLink null
```

`staged` high, `srcLink` null — the instrument's stated verdict is *"the fleet is
under-sized (the missing drain term is the fix)"*, not a link backlog. One CARRY
part of planned drain against a 3,452-energy pile.

### Shipped: the decay term, as an instrument (telemetry class — script only)

`scavengeOutflowSplit` (pure, 5 unit cases) and a new SCAV line. The row read
`ok`; it now reads:

```
[WARN] SCAV  OUTFLOW SPLIT (the pile is a wasting asset): planned drain 3.05 e/t
       vs decay 15.00 e/t => we collect 17%, the engine takes 83%;
       LOSING on 5 of 5 stocks
```

15.00 of the account's 18.68 e/t pile decay is these five stocks — **80% of the
top line, attributed**. The row also WARNs on a losing split now, not only on
parts-dry displacement: the energy leaves either way. Full analysis, the
circular premise in `scavengeRate`, the two accounting conventions that flip the
burst answer's sign, and the convention-free standing-fleet sizing (+15 e/t for
0.070 p/t, against 0.072 measured slack) are in
[spec 44, measurement leg 4](44-standing-scavenger.md).

### NOT shipped, and why: a latent corp-id collision found on the way in

Joining the split to its pile exposed the handle convention
`${room}-hauling-${sourceId.slice(-4)}`. On a 24-char object id the last four
chars are a fine unique suffix — the convention's premise. A scavenge stock id is
POSITIONAL (`scavenge-ROOM-X-Y`), so the slice takes a coordinate fragment: a
stock at (36,27) becomes handle `6-27`, x's tens digit gone. Losing a digit is
harmless; losing UNIQUENESS is not — **(5,30) and (15,30) in one room produce the
same corp**, so one of the two piles silently gets no hauler. That is
indistinguishable from the symptom above.

Left in place on purpose: changing the handle renames every live hauling corp and
orphans its creeps — CLAUDE.md's corp-id-prefix trap verbatim. It needs a
migration or a positional-id branch that keeps existing handles stable, which is
an owner-visible call, not a drive-by rename. Pinned by
`test/unit/corps/scavengeCorpIdCollision.test.ts`, which asserts the collision
and says in its header to invert it when the bug is fixed.

**Verdict: INSTRUMENTED (the top line's cost is now in the report that ranks it,
80% attributed) + a standing in-tree hypothesis SETTLED by reading an instrument
that had been deployed for two weeks (under-sizing, not link backlog) + one
latent defect found and pinned rather than half-fixed.** No deploy: nothing in
this cycle changes bot behaviour, and a global reset for a script change would
cost the instrument for nothing.

---

## Audit cycle t72868738 — I nearly reverted an owner ruling; the cycle's value is that I didn't

2131 RESET-FREE ticks (first clean window since the port-tender deploy), so this
cycle also settles last cycle's deferred question.

### SETTLED: the forgone-mining collapse was real

Last cycle refused to claim forgone 37.11 -> 2.06 for want of a window. Over 2131
reset-free ticks it holds: **forgone 0.00, raw measured mining 117.15 e/t against
a funded capacity of 115.00.** The colony now mines slightly ABOVE its funded
capacity, and E6's deferred-op count fell 10-of-12 -> 5-of-14. The port-tender
fix and the deposit-port drain are earning: the port container at (44,12) reads
**energy 0** (it is being drained), and P11's notional link-carry went to 0.

### FIXED: the revenue line's clamp was silent

`grossPlan = Math.min(grossCapacity, minedRate)` holds the balancing identity,
but it also means `forgone = capacity - gross` can never go negative — so an
over-producing colony prints **"forgone 0.00 target ~0 MET"**, which is
indistinguishable from mining exactly to plan. That is what this cycle's account
did. The excess is standing miners still working a source the plan DEFUNDED
(capacity fell 120 -> 115 on an occupied room; doctrine says incumbents keep
their routes). The line now states it:

```
= gross mining (measured mined)   115.00  115.00  +0.00
  CLAMPED: raw measured mining is 117.15 e/t, 2.15 e/t ABOVE funded capacity -
  standing miners on defunded/unpriced sources. "forgone 0.00" above is the
  clamp, NOT a measurement of mining to plan.
```

Reported BESIDE the line, not folded into it: changing `grossPlan` moves the
chart of accounts and forces a METHODOLOGY bump, and 2.15 e/t is worth less than
report comparability.

### THE NEAR-MISS, which is the real content of this cycle

The ledger's top line was **E4: idle capital 154,472 above reserve, slope +25.68
e/t**, with `equilibrium past the absorbable knee - income the spend path cannot
use`. The chain is exact and reads as a textbook defect:

```
controller sink   demand 0   allocated 0   workParts 0      <- P12 FAIL, 0x of the law's cap
storage sink      allocated 106.69 e/t
bank              +25.68 e/t -> 234,972
construction      budget 10.06, BUILT 5.11
G1                "25.68 pts/t of capacity BANKED instead of delivered"
```

I traced it to `controllerRoutingCapacity`: in wartime it returns
`controllerFloor`, and `controllerFloorRate` is **0 unless the downgrade timer is
low** — so a healthy controller's DEMAND goes to zero, it occupies no rung, and
the surplus construction cannot absorb falls past it to storage (value 1). The
ladder's `controllerMin: 40` rung — CLAUDE.md's documented "controller floor 40",
sitting strictly between construction 70 and storage 1 — is never used for this.
The code's own comment claimed *"Relegated != off - the anti-downgrade floor
still holds"*, which is false in the normal case.

I wrote the fix (relegate by VALUE, keep the demand, so the residual reaches the
controller instead of the bank), took it green through 2365 unit cases, and then
**reverted it** on reading the test it broke:

> Owner 2026-08-05: *"I WANT construction to be the primary consumer over
> controller if we have a construction project. **Banking excess it can't
> consume is fine.**"*

"Banking excess it can't consume is fine" is this exact situation, already
decided. `flowAdapter.test.ts` pins it ("the residual BANKS"). The behaviour is
intent, not oversight, and my change was a directive reversal dressed as a bug
fix — reached by a chain of individually sound reads. Worth recording as a method
failure: **a FAIL row plus a coherent mechanism is not sufficient warrant for a
behaviour change; check for a ruling first.**

Kept from the work: `test/unit/economy/wartimeControllerRung.test.ts` now pins
the TRUE contract (wartime -> 0 for a healthy controller) with the ruling and the
measured cost in its header, and the false comment in flowAdapter is corrected to
say what actually happens and why. The next session that finds this row will read
the ruling before writing the patch.

### STILL OPEN — an owner decision, not a bug (numbers for it)

The ruling and the instrument disagree about whether this is a leak, and the
disagreement is now large:

- E4 ranks it the colony's **top line**: 154,472 idle, +25.68 e/t, projected
  equilibrium 273,496 against an absorbable knee of 150,000.
- G1: 25.68 of 55.49 sustainable pts/t banked rather than delivered.
- The beneficiary converts **half** its budget: construction built 5.11 of 10.06,
  1 site with 4,700 remaining, ETA ~1000t.
- CLAUDE.md's own doctrine reads the other way: *"a warchest far above target
  means the spend path is broken, not that we're rich."*

The 2026-08-05 ruling was made when the bank was far smaller. If the answer is
still "banking is fine", E4's verdict should be relaxed for wartime rooms so the
row stops ranking intent as the top leak; if it is not, the value-relegation
patch is written and reverted in this commit's history. **Do not resolve in code
without the owner.**

### Also read, not acted on

- **A source was lost.** `4adbcbd8 funded->defunded` (occupied/hostile), capacity
  120 -> 115. R1 measured attrition 4.11 e/t against 0.82 priced (5x); 10% of
  kills in intel-hostile rooms. The invader tax remains under-priced, and spec
  15's own rule is to swap `EXPECTED_RAID_DEFENSE_COST` only at >=10 accumulated
  fiscal windows — not yet.
- **X3 untracked creeps 4** (41/45), first FAIL on that row in this session.
- **L1 remains a FAIL** at pile decay 16.61 (was 18.68): last cycle's outflow
  split now reads `1 of 1 stocks LOSING, we collect 23%, the engine takes 77%`
  on a single 5,933e pile. Unchanged mechanism, smaller absolute.

**Verdict: ONE DEFERRED QUESTION SETTLED (forgone collapse real, held 2131
reset-free ticks) + ONE ACCOUNTING BLIND SPOT CLOSED (the silent revenue clamp)
+ A BEHAVIOUR CHANGE WRITTEN, GREEN, AND DELIBERATELY REVERTED against an owner
ruling, with the contract and the ruling's measured cost pinned by test so the
next session does not repeat it. No deploy: the only src change is a corrected
comment.**

### RESOLVED by the owner, same day: the mix is the ruling

> Owner 2026-08-08: *"We can have a mix of upgrading and building. We just want
> building to take priority and not be slowed down by the upgrading."*

This SUPERSEDES the 2026-08-05 reading. "Banking excess it can't consume is fine"
permitted banking; it did not require it, and the binding requirement is the
ORDERING. So the value-relegation patch reverted above is RESTORED, and the
question E4 was flagging is answered in the plan rather than by relaxing the row.

**What shipped.** Wartime no longer zeroes the controller sink's demand. The
controller keeps its bank-fed demand (bounded by the physical burn cap, floored by
the armed anti-downgrade sip) and prices at the ladder's `controllerMin` = 40 rung
- strictly below construction (70), strictly above storage (1). The rung existed
and was dead code for this purpose; now it carries the mix.

**Why building cannot be slowed by it, structurally.** This is the owner's actual
constraint, and it does not rest on the values at all: `CorpPlanner.routeToSinks`
fills in passes - reserve, spawn, **construction**, storage, then the general value
pass. Construction takes its energy AND its spawn parts in a dedicated pass that
runs before the controller is ever considered (the production-first ledger order,
t72445337). Upgrading can only claim the remainder; the ladder ordering only
decides whether that remainder upgrades or banks.

**Priority means NEVER SHORT, not LARGEST SHARE** - the correction that cost two
wrong assertions before it was stated properly. Construction's cap is its own
completion rate, so a bigger residual legitimately upgrades: in the 15k-backlog
world construction takes its full 1/3-life burst (30.08 e/t, `unmet` 0) and the
controller takes 39.92. Three pre-existing tests encoded the off-switch contract
(`ctrl.allocated === 0`, "construction WINS the surplus", "the residual BANKS") and
were rewritten to assert `unmet == 0` on every construction sink instead - the
assertion that actually enforces the directive.

**Gate.** Unit 2371 passing; `flow-handoff`, `runt-economy`, `storage-depot` green
on the rebuilt bundle; grid `cons-t4-link-completes` **[P]** at T4.

**One red cell, ACQUITTED by attribution.** `fid-t4-synthetic-steady-state` fails
`atWindow:"controller fidelity: >= 15% of upgrade budget"`. It is baseline `pass`,
so it was checked against the pre-change source per the attribution rule (stash
src, rebuild, rerun): **identical failure, same assertion, same tick.** It is red
on the DEPLOYED build, so it is its own incident against that build and does not
hold this fix hostage. Not investigated this cycle; named here as the next
cycle's first item, and note the irony - it is a CONTROLLER-FIDELITY cell, so the
change just made is the most likely thing to move it.

**Predictions for the post-deploy capture:**
1. `flow.sinks[controller].demand` > 0 and `workParts` > 0 while the W43N23
   backlog stands (was 0/0). P12 leaves 0x.
2. The upgrader corp's `sizing.planAllocated` and the controller sink's
   `allocated` AGREE - the four disagreeing numbers (0 / 44.317 / 88.634 / 29.81)
   collapse to two related by `effectiveAllocated`'s dedicated-source halving.
3. Bank slope FALLS from +25.68 e/t; E4's 154,472 stops climbing. Controller
   delivery rises from 29.81 e/t.
4. **The constraint, and the thing to check first:** construction's `unmet` stays
   0 and its built rate does NOT fall below 5.11 e/t. If building slowed, that is
   a revert.

### Post-deploy verification (capture t72869702, 964 ticks) — SAFE, but the changed path did not run

Every headline number moved the predicted way, and **none of it is attributable to
this change.** State that first, because the numbers are tempting:

| | t72868738 | t72869702 |
|---|---|---|
| P12 valve coherence | **FAIL 0x** (published 0.00) | **ok 1x** (97.36 vs law 97.36) |
| controller sink | demand 0, alloc 0, workParts 0 | demand 97.36, alloc 97.36, unmet 0, workParts 98 |
| E4 idle capital | **FAIL** 154,472, slope **+25.68** | WARN 146,036, slope **-5.12** (draining) |
| G1 | WARN "25.68 pts/t banked" | **ok**, 87% income-funded |
| construction built | 5.11 e/t | **15.38 e/t** (3x, not slowed) |

**Why it is not attributable: the colony is not in wartime.** `siteCount 0`,
`siteProgress 0/0`, the upgrader's `sizing.wartime` is `undefined`, and there is no
construction sink in the plan at all. The W43N23 site (4,700 remaining, ETA
~1000t) COMPLETED inside this 964-tick window, so wartime exited on its own and
the controller resumed its ordinary peacetime bank-fed allocation — which it would
have done under the old code too. **The changed branch never executed.**

What IS confirmed:

- **Prediction 2, cleanly and independent of wartime:** the four disagreeing
  numbers collapsed to one. Controller sink `allocated` 97.357 == upgrader
  `planAllocated` 97.357 == `allocated` 97.357 == commission `energyRate` 97.357.
  (The earlier 2x/halving spread came from `effectiveAllocated`'s dedicated-source
  divisor, which is inactive with no sites.)
- **The instrument is safe:** bucket 9,800, no deadlock, no lost rooms, bank
  draining rather than climbing, and the build finished its site.
- **Prediction 4's constraint is not violated:** construction built MORE
  (15.38 e/t), though over a window where the site completed — the tail of a
  build, not evidence about the mix.

**So the change ships LIVE-UNVERIFIED on its own path.** It is covered by unit
2371 + the three solver-level wartime cases in `flowAdapter.test.ts`, and it will
get its live read the next time a backlog >= WARTIME_BACKLOG_THRESHOLD (3000)
stands. The gauge, for whoever sees that first: `flow.sinks[controller].demand`
> 0 with a construction sink present, construction's `unmet` at 0, and the bank
slope not turning positive.

**Also new, and a reset artifact rather than a finding:** E5 runt purchases 5 of
the last 8 receipts. A deploy is a global reset and the recovery double-orders for
about one window — the same caveat CLAUDE.md already attaches to X5. Re-read next
cycle before treating it as real.

**Cycle verdict: FIXED per the owner's ruling, GATED (unit 2371 + trio + grid, one
red cell acquitted by pre-change attribution), DEPLOYED, and honestly
LIVE-UNVERIFIED — the wartime branch did not run, and the improvements measured
after the deploy belong to the backlog draining, not to the patch.**

---

## Perennial source piles: the drain term is PRICED, then DECLINED at the spawn (t72869702)

Owner 2026-08-08, correcting the framing: *"forget about the scavenger. That's
for things close to the core not perennial source piles. The reason we have
source piles is simply because our hauling is not efficient enough. Otherwise
miner spawn idling, and decay would always get rid of the piles... We just have
to focus on clearing up the hauling."*

Correct, and it localises to ONE gate. Three reads, in order:

**1. The plan asks for the drain, exactly right.** `flow.haulers[].carryParts`
against the sustained-only `carryPartsFor(rate, distance)`:

```
src     dist  plan carry  sustained  implied DRAIN  buffered
cd8d      41       21.90      16.80          5.10      4558
cd98      85       41.83      34.40          7.43      3248
d01f      80       39.17      32.40          6.77      3141
cbd8      75       30.42      30.40          0.02        10
```

cd8d predicted: `bufferDrainCarry(4558/1500, 41)` = 5.11 vs 5.10 measured. The law
is exact, and it correctly asks ~0 where there is no pile (cbd8). **Not a plan
bug.**

**2. The fleet is fielded at 89% of the ask, and the shortfall is EXACTLY the
piled sources.** Plan 271.5 CARRY colony-wide, fielded 241:

```
cd98  ask 41.8  fielded 32  gap -9.8   buffered 3248
d01f  ask 39.2  fielded 32  gap -7.2   buffered 3141
cd94  ask 22.0  fielded 16  gap -6.0   buffered 3772
cd8d  ask 21.9  fielded 16  gap -5.9   buffered 4558
cedc  ask 21.1  fielded 16  gap -5.1   buffered 3382
cee2  ask 34.6  fielded 32  gap -2.6   buffered 3305
cee0  ask 17.6  fielded 28  gap +10.4  buffered  737   <- no pile, over-fielded
cbd8  ask 30.4  fielded 32  gap +1.6   buffered   10   <- no pile, over-fielded
```

Perfect rank correlation: every under-fielded route has a pile, every
over-fielded route does not.

**3. The MATURE DEAD-BAND declines every one of them.** `CarryCorp` line ~1536:

```ts
if (ctx.storageBacked === true && current >= targetHaulers &&
    !worthABody(carryNeeded - fieldedCarry, haulerBodyCarry(ctx.energyCapacity, carryNeeded)))
  { this.lastExit = "deadband"; return []; }
```

`worthABody(d, share) = d*2 >= share`, so it declines while `deficit <
share/2`. At capacity 5600 the body share is 18-24 CARRY, so the threshold is
**9-12 CARRY** - and every measured deficit (1.7-9.8) falls under it:

```
cd98 deficit 9.8 vs half-share 10.5  DECLINED
cd94 deficit 6.0 vs half-share 11.0  DECLINED
cd8d deficit 5.9 vs half-share 11.0  DECLINED
cee2 deficit 2.6 vs half-share  9.0  DECLINED
```

**7 of 7 piled/near-piled sources declined.** The gate's own justification is
solve-to-solve jitter - *"the drain-priced routes move carryNeeded +-1 CARRY solve
to solve"* - but its threshold is **~10x** that jitter, so it swallows the entire
drain term. The plan prices the pile-clearing body every solve; the spawn declines
it every solve; the pile is therefore permanent, at 19.48 e/t of decay.

This also explains H1's long-standing note ("haulers BUSY => plan under-asks") as
a MISREAD: duty is 0.96 and the plan does not under-ask. The fleet is what falls
short, at one gate.

### The fix, and the one risk that must not be waved through

Sizing the dead-band to the jitter it was written for (~1-2 CARRY, not half a
body) releases ~30 CARRY colony-wide against 19.48 e/t of decay - by the transport
arithmetic (~0.045 e/t per CARRY part amortized) that is ~1.4 e/t of bodies for a
19.48 e/t recovery.

**The risk is real and is on the same source.** The dead-band exists because of
the t72773737 treadmill: *"the even-share treadmill that bought d01f eight bodies
in ~1200t (5.17 e/t vs a 1.27 e/t plan)"* - and d01f is one of the six piled
sources above. The treadmill is buy-then-cull churn, and the ask gate and the
RECYCLE POUNCE read the SAME predicate (`worthABody`, noted at CarryCorp:461: *"the
same predicate the ask gate reads"*). So loosening the ask alone also makes the
pounce cull more eagerly, which is the churn. **The two sides have to be
decoupled** - the ask may buy the drain body without the pounce culling an
incumbent over the same margin - and that is a two-sided change needing X5/E5
churn pinned by test, not a threshold nudge.

Recorded as the next work item with the mechanism fully localised. Not patched in
this pass: a one-sided loosening re-opens a measured incident.

## Audit cycle t72871684 — the perennial piles are TWO mechanisms, and the second one is a route nobody drives

Window t72869702 → t72871684 (1,982t), methodology #18, sweep at **11% handicap,
cycle 1** (spec 50 walking normally). Ledger: 3 FAIL (S5, L1, X3), TOP LINE
printed as S5.

**The account says the top line is not S5.** L1 breaches by **69.28×** on one
row — ground pile decay **17.32 e/t against a budget of 0.00** — and the
TARGETS block prices it colony-wide: losses are **21% of mining capacity**,
against controller 61% and build 5%. S5's finding (0.647 of 0.667 p/t, a 3%
surge margin) is real and is *why the piles cannot simply be hauled away*, but
it is a headroom advisory, not the leak. Read the account first, as the method
says; the picker's ranking is worth revisiting.

### The aggregate hid the defect (a read I got wrong first, and the fix for it)

Fielded CARRY is 381 against a plan asking 252.8 — which looks like a fleet
**51% OVER** the ask, and would falsify spec 55 outright. It is wrong. 381 is
colony-wide carry; 101 of it is on BUILDING corps and 45 on the feeder/tender.
Decomposed by corp type, **source-route haulage is 230 fielded against 236.7
planned — 97%, essentially AT plan.**

P11 states this trap in the ledger itself (*"source-route carry alone is 236.7 -
compare fielded CARRY against THAT"*) and it still caught me. Any future
plan-vs-actual carry claim must name which carry it is comparing.

### Mechanism A — the dead-band, CONFIRMED live on 8 of 10 piled sources

The corps' own hauling stamps, this capture:

```
  source  pile  carryNeeded  creeps  exit         duty
  cedc    3665      22          1    deadband     0.886
  cd94    2413      21          1    deadband     0.833
  cd8d    2506      20          1    deadband     0.884
  cee2    2644      34          2    deadband     0.923
  d01f    2069      38          2    deadband     0.963
  cbd5    1274      24          1    deadband     0.952
  cbd8     332      33          2    deadband     0.965
```

Spec 55's mechanism (2) is not a historical note — `exit: "deadband"` is being
stamped right now on 8 of the 10 piled sources, and the 97% aggregate above is
what conceals it: the over-fielded sources (cd8d 161% of declared, cd98 353%)
net out the starved ones (cedc 74%, cd94 78%). **The colony fields the right
TOTAL carry and puts it on the wrong routes.**

The correlation runs backwards: the most-piled source has the least carry, the
least-piled ones are over-fielded. Not patched here — spec 55 §5 forbids a
one-sided loosening (the ask gate and the recycle POUNCE share `worthABody`, and
d01f, one of these very sources, is the t72773737 treadmill's own incident).
Acceptance is still the F2==0 cell that does not exist.

### Mechanism B — 19.88 e/t routed to a sink whose supply line nobody drives (NEW)

Two sources are routed to CONSTRUCTION sinks rather than storage:

```
  cd98 -> construction-6a77baf91   flow 10.00 e/t   carry  9.07   d=20
  cee0 -> construction-6a77bf172   flow  9.88 e/t   carry 17.65   d=36
  TOTAL                                  19.88 e/t   carry 26.72
```

`19.88` is the APPROPRIATIONS **construction BUDGET line, to the decimal**.
Delivered: **6.54**. Variance **-13.34 U**, the largest single unfavourable line
in the account.

The mining corps decline that energy *by design* — `haulCarryNeeded` opens with

```ts
const routes = this.haulerAssignments.filter(a => !(a.toId ?? "").startsWith("construction-"));
if (routes.length === 0) return 0; // construction-only: the tankers own this energy, pile or no pile
```

— so cee0 stamps `carryNeeded: 1` and `exit: "staffed"` while **4,275e stands
staged** and its miner is pile-gated **84% of the window**; cd98 stamps
`carryNeeded: 0`. Both stamps are *correct* under that rule. The rule hands the
energy to the construction corp's tankers.

**The tankers are not collecting it.** `building-W43N23-construction` stamps
`dedicatedSource: 1`, `tankers: 2`, `tankerCarryNeeded: 37`, **`tankerDist: 10`**
— sized for a 10-tile haul, while the plan's two construction supply routes are
d=36 and d=20. `building-W42N22-construction`, in cee0's own room, is one 4-part
runt with `consumes.energyRate: 0`.

So the plan prices 26.72 CARRY of supply line, charges it to the parts ledger,
and no corp drives it. **This is spec 49's Blocker 1 — *"the plan would price a
route nobody drives"* — realised live, and in the direction that spec did not
anticipate**: not an overflow route it declined to build, but a construction
supply line it already prices. The two sources carry **5,431e of the colony's
23,456e of piles (23%)** and are the only two whose miners are starved by a rule
that believes someone else is coming.

Neither corp is wrong locally. Nobody owns the middle — the same sentence spec
54 §2 used about the port link, one subsystem over.

### Cycle verdict: **INSTRUMENTED + BLOCKER NAMED WITH DATA** (no code change)

No fix shipped, deliberately. Mechanism A is fenced by spec 55 §5 pending its
F2==0 cell; Mechanism B is an OWNERSHIP seam (which corp buys a construction
supply line), and spec 39's spawn-authority ratchet is the same blocker spec 49
already recorded — the second patch on a mechanism is the trap, so the mechanism
gets written down rather than nudged.

What a future session should NOT re-derive:
- the 97% aggregate is not health, it is two errors cancelling;
- `carryNeeded: 1` beside `staged: 4275` is not a sizing bug, it is a deliberate
  hand-off to a tanker that never arrives;
- the construction BUDGET line equals the construction-routed source flow
  exactly, so that variance is a *delivery* failure, never a pricing one.

## Methodology note #8 — an UNPLUGGED meter reads exactly like an empty one

Found 2026-08-09, by being asked a question the instruments could not answer.

`sourceDropped` (core v19) exists to split a source mouth's buffer into the part
held in a CONTAINER (which keeps) and the part on the GROUND (which rots at
`ceil(amount/1000)` per tick). Its docblock states the case correctly. The
computation is correct. It was never added to the returned object — five
references in `coreSegment.ts` (import, interface field, declaration, read,
write) and no emission.

So the field produced **zero data points**: absent from every capture in
`test/fixtures/telemetry/`, and `fiscalArchive` archived `sd: undefined` for
every fiscal month it has ever closed. Nothing failed. Nothing warned.

**The trap is at the READING end, not the writing end.** Spec 54 open item 8
concluded *"BLOCKED on the absent `sourceDropped` meter"* and stopped — a
reasonable inference from a capture that does not contain the field, and wrong.
There is no observable difference between:

- a field that is legitimately empty (no dropped energy anywhere), and
- a field that is computed and thrown away,

because both are absent from the wire, and this codebase deliberately omits
empty optionals so that *absent* and *zero* stay different facts. That
convention is right, and it is exactly what hid this: the convention makes
"nothing to report" indistinguishable from "nothing was wired".

Rules this yields, in order of how much they would have saved:

1. **A telemetry field is not shipped until a capture contains it.** Declaring
   the interface, computing the value and reviewing the docblock all passed
   here. Only "grep a real capture for the key" would have failed.
2. **When a spec blocks on a missing meter, check the meter is emitted before
   recording the block.** Item 8 sat blocked for a session on a field that had
   been in the tree since v19.
3. **`git log -S <field>` on the segment file is the cheap check** — it shows
   the field arriving and never being wired, in one command.

**Not yet built: a cop for the class.** Every optional in `CoreTelemetry` could
be asserted reachable — a test that stages a room exercising each field and
requires the key to appear at least once. That is a real test-writing cost per
field and it would have caught this one; it is proposed, not shipped, and it
belongs with spec 09's schema-versioning phase rather than here. Whoever picks
it up should check the OTHER segments too: nothing about this defect is specific
to segment 0, and no one has looked.

## Audit cycle t72872936 — the constraint INVERTED, and the same two sources took 82% of the growth

Window t72871684 → t72872936 (1,252t), methodology #18, sweep 11% cycle 1.
Ledger: 3 FAIL (L1, X3, G1). TOP LINE **L1** — correctly this time, because S5
dropped out of FAIL, which is itself the story.

### The finding: last cycle's excuse is gone

Last cycle S5 read **0.97× the physical ceiling** and that was the reason not to
chase the piles — you cannot buy carry a saturated spawn has no room for. In
1,252 ticks:

```
                       t72871684      t72872936
  spawn0 utilization      0.966          0.865
  spawn1 utilization      0.974          0.802
  spawn0 queueDepth           8              2
  spawn1 queueDepth           8              1
  spawn0 idle.empty           2             92     <- "empty" = NO DEMAND
  spawn1 idle.empty           0            118
  S4                         3% idle       13% idle, 63% of it "empty"
```

**The spawn is now idle for lack of anyone asking**, and the piles went
**23,456 → 33,657e (+44%)** over the same window. The agenda's queue is 2 deep
and 1 deep, and contains an upgrader and two builders. Across the last **16
executed receipts on both spawns there is not one hauler**.

So the constraint moved from SUPPLY (spawn saturated) to DEMAND (nothing asks),
and the leak did not care. That falsifies the reading — mine — that S5 was the
binding constraint on L1. It was a co-symptom.

### Mechanism B is now the dominant term, and it is accelerating

```
  source   pile t72871684 -> t72872936     delta   carryNeeded  exit
  cee0            4275 ->  8148          +3873         1        staffed
  cd98            1156 ->  5618          +4462         0        deadband
  ---------------------------------------------------------------
  those two       5431 -> 13766          +8335   = 82% of the colony's +10,201
```

Both are the CONSTRUCTION-routed sources (spec 14 cycle t72871684, Mechanism B).
The plan's routing is byte-identical to last capture — cd98 10.00 e/t / 9.07
carry / d=20, cee0 9.88 / 17.65 / d=36, totalling the 19.88 that IS the
APPROPRIATIONS construction budget line. Delivered 10.42 (up from 6.54, still
-9.46 U).

`haulCarryNeeded` filters `construction-` routes out — *"the tankers own this
energy, pile or no pile"* — so cee0 stamps `carryNeeded: 1`, `exit: "staffed"`
beside **8,151e**, and cd98 stamps `carryNeeded: 0` beside 5,624e. Both correct
under that rule. Nothing else asks.

**F2 states the same defect from the commission side and is the sharper
framing**: `mining-W42N22-harvest-cee0` fields **11p against 35p declared**. The
COMMISSION declares the fleet. The corp's own demand lens asks for one CARRY.
**That is spec 39's open seam exactly** — *"the SpawnDirector does not read
`commission.fleet`"* — and it is now the colony's largest single leak, not an
architectural nicety. Recorded against spec 39 as its first measured cost.

### Also true, and not the same story

- **E6 8 of 12 deferred**, five of them held **96-100%** of the window. Forgone
  mining 2.23 e/t on top of the rot.
- **Reservation 6.56 → 16.61 e/t** (creeps 2→9, five reserver spawns/6,500e in
  the window). Unexplained; a candidate for the next cycle and NOT diagnosed
  here — naming it without a stamp read would be a hypothesis dressed as a
  finding.
- **Bank -38.29 e/t** (191,730 → 143,793), projected equilibrium 86,360 against
  an 84,000 reserve. That is the spend path working, not a leak; G1's 42%
  income-funded is the same fact from the other side.
- **(41,22) is confirmed STUCK**, not transient: 2000/2000 in BOTH captures,
  1,252t apart, zero change. Spec 54 item 10.
- **The (44,12) port container is cycling** 0 → 503 → healthy, and the coreDepot
  887 → 572. Two of three home containers are working correctly.

### Cycle verdict: **DEPLOYED + PREDICTIONS ON FILE** (the top line is untouched)

Shipped the branch that had been sitting gated: spec 56 (one port-buffer lens,
the placement gate, the fight-loop guard), spec 57 (the tender check + the
`port-untended` watchdog), and core **v36** (`sourceDropped` finally emitted).

Gate: 2406 unit, tsc clean, build green, storage-depot + flow-handoff +
runt-economy all green against the deployed bundle. **One flake recorded rather
than hidden**: runt-economy failed once inside a 13-minute run (its normal is
4m) and passed on immediate re-run; three of four runs on this exact source are
green and the failure coincided with a 3× wall-clock, which is the documented
host-load sensitivity of the mockup.

Predictions, written before the deploy:

1. `sourceDropped` appears in the next capture — the 33,657e splits
   container-vs-ground for the first time. This is the one that matters: it
   decides whether the pile story is rot or merely idle stock.
2. Port (43,38) gets a container site, then `hasContainer: true`, then a second
   `portPosts` post.
3. No `port-untended` alert for (44,12); possibly one transient for (43,38)
   between its container completing and its tender arriving.
4. **The top line does NOT move.** Nothing in this deploy touches Mechanism A or
   B. If pile decay improves, that is unattributed to this change and must be
   read as such.

## Post-deploy verification t72873814 — 3 of 4 predictions confirmed, and the deploy CORRECTED a diagnosis rather than only fixing a bug

~814 ticks after deploying specs 56 + 57 + core v36. Window 878t. **Read the
spawn-measured lines with care: the deploy's global reset wiped the blackbox
ring, so F1/S5/X5 are over 423t of POST-RESET RECOVERY, not steady state** (the
method's own warning; X5 reads 0 of 18,400e, which is the recovery being clean,
not a churn measurement).

### Prediction 1 — CONFIRMED, and it settles the top line

`sourceDropped` reached the wire. The first container-vs-ground split this
project has ever had:

```
  source   buffer  DROPPED  container       source   buffer  DROPPED  container
  cd98       6561     4561     2000  (cap)  d01f       2628      628     2000  (cap)
  cee0       4348     2938     1410         cd8e       2122      122     2000  (cap)
  cd8d       4316     2316     2000  (cap)  cee2       1450        0     1450
  cedc       3614     1614     2000  (cap)  cbd8       1288        0     1288
  cd94       3128     1918     1210         cbd5        205        0      205
  ---------------------------------------------------------------------------
  TOTAL     29668    14105    15563    ->   48% of the mouth stock is ON THE GROUND
```

**The mechanism is now visible and it is not what "pile" suggested.** Five of
the seven rotting sources have their container at **exactly 2000 — the container
cap** — and the entire overflow is on the ground. The containers are built, they
are working, and they are FULL. Ground decay is not a container-placement
failure; it is what happens to everything mined after the buffer tops out.

Summing `ceil(amount/1000)` over those piles gives ~18 e/t against the ledger's
measured 23.62 — consistent (the ledger averages over a window in which the
piles were larger).

Two sources break the pattern and are their own question: **cee0 (container
1,410, ground 2,938) and cd94 (1,210 / 1,918) hold ground piles while their
container is BELOW cap.** Either the miner is dropping beside the container
rather than into it, or haulers drain the container (one withdraw) and leave the
pile (needs a pickup). Not diagnosed here — it needs the pickup stamps, and
naming a cause without them would be a hypothesis dressed as a finding.

### Prediction 2 — CONFIRMED, and it corrects spec 54

Port (43,38) now has a buffer. Containers 3 → 4, sites 1 → 0, both ports
`hasContainer: true`. The gate opened and the rung fired, first time ever.

**But the tile is the finding.** The buffer landed at **(41,36)** — the exact
tile spec 54 called *"the dead controller container ... BLOCKING the second
port"* and shipped a reclaim path to destroy. Same tile, same room, same
container, and only the code changed:

```
  t72869702  core v35 (old)   (41,36) role "controller"   supersededControllerContainer: FLAGGED
  t72873814  core v36 (mine)  (41,36) role "port"         supersededControllerContainer: None
```

The only edit between them is spec 56 narrowing the census's controller role
from a local **4** to `CONTROLLER_CONTAINER_RANGE` (**3**). So the controller
sits at chebyshev exactly **4** from (41,36) — inside the one-tile band where
the census (4) and the tender (3) disagreed.

**(41,36) was never the controller's feed store. It was port (43,38)'s own
buffer, misclassified.** Which means spec 54's fight loop had its causality
backwards: construction was correctly placing the port's buffer, and the reclaim
rung was correctly-by-its-own-lights demolishing it, at 5,000e and a builder per
round. Neither rung was wrong; the census was, by one tile.

Spec 56 stated this as a latent *hazard* (*"could therefore mark a live, tended
port buffer for demolition"*). It was not latent. It was the live incident, and
it was the whole of spec 54 open item 4. Both specs corrected.

### Prediction 3 — CONFIRMED for steady state. **My first reading of it was wrong.**

I first wrote that this was unverifiable: *"`port-untended` alerts print to the
live console; nothing exports them to a segment."* **That is false.** The black
box segment's shape is `{v, tick, alerts, rows}` — `docs/LIVE_DATA.md` says so
in its segment table, `main.ts` passes the watchdog's alerts straight into
`blackBoxFlush(Game.time, alerts)`, and the live capture carries the field. I
asserted a missing instrument without opening the segment.

The actual reading, t72873814: **`alerts: []`**, with `rows: 72`
(watch 49, spawn 20, churn 3). No `port-untended` alert. That is correct on both
ports — (44,12) is tended and cycling at 0e, and (41,36) is brand new and empty,
which is exactly the case spec 57 deliberately keeps quiet.

**The real limitation is narrower and worth keeping.** `flush()` writes
`alerts` verbatim but only on `tick % 10 === 0`, and `runFlightRecorder`
evaluates the watchdogs on the same `% 10` cadence — so they align and every
evaluation is flushed. But each flush **overwrites**: the field is an
INSTANTANEOUS reading at one tick, not a window like `rows`. An alert that fired
and cleared between two captures is unobservable.

So the steady-state half of the prediction is confirmed and the *transient* half
(a possible alert for (43,38) between its container completing and its tender
arriving) is unobservable — because of the overwrite, not because of a missing
export. **Work item, correctly stated: give `alerts` the same ring treatment
`rows` already has,** so the watchdog can report what fired during a window and
not only what is wrong at one instant.

### Prediction 4 — CONFIRMED (the top line did not improve)

Pile decay **19.26 → 23.62 e/t**, L1 now **94.49×** budget. As predicted,
nothing deployed touches Mechanism A (dead-band) or B (construction-routed
sources), and the top line moved the wrong way. It is NOT attributed to the
deploy — the trend predates it (17.32 → 19.26 → 23.62 across three cycles).

Genuine improvements in the same window, none of them claimed for this deploy:
piles 33,657 → 29,668 (drawdown +4.54 e/t), E6 8 → 6 deferred, scavengers 1 → 5
(spec 44's recovery fleet ramping), reservation 16.61 → 4.44 e/t, bank slope
-38.29 → -7.84. The demand-side idling is gone (S4 2%, 100% "buy" latency), but
that is post-reset recovery and cannot be read as steady state either.

### Cycle verdict: **VERIFIED + TWO DIAGNOSES CORRECTED**

3 of 4 predictions confirmed, 1 unverifiable-by-construction and recorded as an
observability gap. The deployed change did exactly what it claimed on the port
buffer and nothing at all for the top line — which is what was predicted.

**The top line is now localised as it never was before:** 48% of 29,668e stands
on the ground because seven containers are AT CAP. The next cycle's question is
no longer "why do piles form" but "why does nothing drain a full container" —
and Mechanism B (cee0 `carryNeeded 1`, cd98 `carryNeeded 0`) plus Mechanism A
(the dead-band) are the two answers already on file, with spec 39's seam as the
structural fix.


## Methodology note #9 — check the instrument before declaring it missing

Twice in one session, a claim of the form *"we cannot see X because the meter
does not exist"* was made and was wrong, in opposite directions:

1. **Spec 54 open item 8** (a prior session): *"BLOCKED on the absent
   `sourceDropped` meter."* The field was not absent — it was declared at core
   v19, computed every tick, and never returned. Unplugged, not missing.
2. **This session, mine**: *"`port-untended` alerts print to the live console;
   nothing exports them to a segment."* They are exported. The black box's shape
   is `{v, tick, alerts, rows}`, `docs/LIVE_DATA.md` documents it in its segment
   table, and the live capture carries the field. I did not open the segment
   before writing the sentence.

Both cost the same thing — an item recorded as blocked on work that was already
done — and both were one command away from being right:

```
  python3 -c "import json;print(list(json.load(open('<capture>'))['data']['<seg>']))"
  grep -n "<field>" src/telemetry/<segment>.ts     # declared? emitted?
  git log -S "<field>" -- src/telemetry/           # arrived when, wired when?
```

**Rule: "the instrument does not exist" is a claim about the code and the
capture, so it requires reading the code and the capture.** It is the one class
of statement in an audit that feels like an observation and is actually an
inference. Note #8 covers the writing end (a field never emitted); this one
covers the reading end (a reader who never looked).

## Audit cycle t72874433 — the top line fell 23.62 → 19.66 and I cannot claim it; a mouth reading that no mechanism explains; and a reconciliation that was never computed

Capture `t72874433`, 619 ticks after the spec 56/57 deploy verification at
t72873814. Segments `0,3,4,5,6,8,9`. Methodology #18.

**Instrument health first**: CPU bucket 10,000; both spawns healthy (util 0.82 /
0.93, S5 12% surge margin); bank 141,204 against an 84,000 reserve and
CONVERGING; P1 zero plan flaps; every infra gate reads `staffed` (tender,
feeder, upgrader). No threat to the measurement instrument.

**Sweep state (spec 50)**: the window ran at handicap **12%**, cycle **1** — the
bot's own archive is current through FY4858-M02 (t72873000) and the next month
boundary lands 67 ticks after this capture, so `fiscal:close` and
`fiscal:archive` both correctly closed nothing.

### The account

```
  delivered into the economy    129.93   (gross 119.45 + pile drawdown 10.48)
  TOTAL SPAWN                   -47.42   vs -39.03 priced        (-8.39 U)
  measured losses               -27.59   vs  -6.39 budget       (-21.20 U)
  controller (score)             36.00   vs  33.51              (+2.49 F)
  RESIDUAL                        4.97   = 4% of gross mining
```

L1 (pile decay) **19.66 e/t against a budget of 0.00** is again the TOP LINE.
Against the three prior cycles — 17.32 → 19.26 → 23.62 → **19.66** — the trend
broke. **I am not claiming it.** Nothing deployed since t72873814 touches any
drain mechanism; the recovery fleet ramp (spec 44's cure, 1 → 5 scavengers) and
ordinary variance both predate the window. Piles fell 29,668 → 23,183 and ground
stock 14,105 → 9,564 in the same 619 ticks, which is the drawdown the account
books as revenue — energy that was mined in an earlier window, not new income.

### Finding 1 — a mouth reading that no mechanism on file explains

**cd8d: container 2000 (at cap) → 0, while its ground pile GREW 2,316 → 2,588.**

Section 4 of [spec 59](59-the-container-caps-and-the-overflow-rots.md) had two
candidate mechanisms for a below-cap container. This is a third reading, and the
one mechanism that would drain a container — `sourcePickupSpot`'s
container-first branch while the container is FULL — predicts the opposite:
one withdraw re-opens capacity, pile-first takes over, and the container should
sit near 2,000 while the pile falls. Two others fit (the container decayed to
death and dropped its load; there was never a container at that mouth), and
**container energy of zero reads identically under all three.**

Three bugs, three fixes, one number. Per this spec's own rule — *instrument,
don't re-theorize* — the cycle shipped the stamp:

**Core v37, `sourceMouth`**: per-source `{n, free?, hp?}` — containers standing
(`n: 0` EMITTED, because "no container here" is a positive claim an absent key
cannot make), summed free capacity (`free: 0` IS the cap, stated rather than
inferred from the number 2000), and the WEAKEST container's hits fraction
(`hp`). One pure lens, `sourceMouthContainers`, beside `sourceBufferStock` in
`corps/nodeEnergy`. `hp` is also the first remote-container decay reading this
project has ever carried — the inventory the account's depreciation memo has
been pricing a 5.64 e/t accrual against nothing.

### Finding 2 — the SOURCE P&L asserted a reconciliation it never computed

The P&L closed every report with *"RECONCILES to the colony account: miner X =
extraction line; reserve Y = reservation line."* This capture printed
`reserve 11.80 = reservation line` beside a colony account reading **18.90** —
a 60% mis-statement, presented to the reader as a reconciliation.

Neither number is wrong; they measure the same purchases over **different
windows**, and nothing compared them:

| | basis | window | miner | reserver |
|---|---|---|---|---|
| SOURCE P&L | blackbox ring (needs per-CORP attribution) | 1,102t | 4.22 | **11.80** |
| ENERGY ACCOUNT | cumulative spawn ledger, by ROLE (methodology #7) | 619t | 4.28 | **18.90** |

Reserver purchases are lumpy — one 1,300e body per room per ~600 ticks, nine
rooms — so the same spend differs by 60% across the two spans. The claim was
TRUE when both sides read the ring and has been false since #7, silently,
because it was a sentence rather than an arithmetic.

It is not cosmetic. The P&L's `net` column is what the planner's own
`candidates[].net` is compared against, and the row's own text says that
comparison *"ADMITS OR REJECTS a source"*. At the ring rate every remote is
charged 1.18 e/t of reservation; at the capture window's rate, 1.89 — cbd8 reads
`-1.66` against plan where the account's window says `~-2.85`.

**Fixed** by replacing the assertion with the arithmetic: both windows named,
both rates printed, the delta computed, and the comparison WITHHELD (not faked)
when there is no usable account window. Neither number moved, so no METHODOLOGY
bump. The real fix is one book — a per-CORP cumulative counter (spec 51 gap a).

**And it changes this cycle's reading of the account**: reservation's `-8.07 U`
variance is *lumpiness across two windows*, not a pricing failure. Over the ring
the same spend is 11.80 against a 10.83 budget — **+9%**.

### The rest of the checklist

- **X3 FAIL, 4 untracked creeps** (62 of 66) — and it reads exactly 4 at
  t72871684, t72873814 and t72874433. **Chronic, not a fresh leak**, and *not
  diagnosable from a capture*: the census publishes the COUNT and no names, so
  nothing says which creeps or which kind. Work item recorded, not acted on —
  naming them is a one-field change to `census`, and this cycle already spends
  its schema bump.
- **Creep total 54 → 66 (+22%)**, above the triage's 20% oscillation line, but
  attributable: reservation creeps 3 → 9, one per remote room, the same wave the
  18.90 e/t reservation line prices. Not a die-off/rebuild oscillation.
- **F2 `ok` at 0.19 with a 110p gap on 583 declared**, and the worst line has
  INVERTED since spec 55: `upgrading-W43N23` now fields 91p against 45p declared
  (**+46**, was −35). The plan declares WORK; the body is WORK+MOVE+CARRY — a
  P11-class representation gap on the consumer side, not an over-purchase.
- **E6 6 of 12 miner ops deferred**, four CHRONIC at 100% of the window
  (cedc, cd94, cd8d, cd98) — unchanged in character, the demand-side story
  spec 59 sections 3A/3B already owns.
- **SCAV: 4 of 5 stocks LOSING, we collect 27% and the engine takes 73%**
  (planned drain 5.85 vs decay 16.00). Consistent with the ratio spec 44 §4
  already derives from `scavengeRate`'s own horizon; nothing new, and the design
  is owner-gated.

### Cycle verdict: **INSTRUMENTED** (2 gauges), one FAIL attributed away, top line NOT claimed

Shipped: core **v37** `sourceMouth`; the P&L basis bridge. Both
telemetry-only — unit suite (2,417 passing) + build. No live behaviour touched.

**Predictions registered before deploy** (check at the next capture, ≥200t):

1. `sourceMouth` on the wire at v37, one entry per visible source (13 keys,
   matching `sourceBuffers`).
2. **cd8d is decided**: `n: 0` ⇒ the container DIED (a new mechanism — remote
   container decay dumping stock onto the ground, and a maintenance question,
   not a hauling one); `n: 1, free > 0` ⇒ it was DRAINED, i.e. the
   pickup-priority defect, and `sourcePickupSpot`'s full-container branch is
   wrong; low `hp` ⇒ dying and about to repeat.
3. **cd90/cd92 report `n: 0`**, turning spec 54's *"neither home source has a
   container"* from an inference off a zero into a stated fact.
4. No `RECONCILES to the colony account` line in any future report or fiscal
   close; the two-window bridge in its place.
5. **The top line does NOT move on account of this deploy.** Nothing here drains
   anything. If L1 improves it is unattributed and must be read as such — the
   same discipline the t72873814 cycle applied to the piles falling 33,657 →
   29,668.

### Parallel work during the t72874433 post-deploy wait — spec 58(b)'s three cells, and the shape of their failure

Spec 58(b) records three baseline-`pass` construction cells going red in a fresh
sandbox, and says the next step is one full `npm run grid` on unmodified master
before either "broken environment" or "stale baseline" may be asserted. That
still stands — a full grid does not fit a post-deploy window. What DOES fit is
re-running the three, and their failure has a shape the earlier note flattened
into "all timing out at their window":

```
  [T] cons-t3-build-and-repair-concurrent  (T3, timeout @400/400t)
        satisfied: "a site stands" @10, "the decayed container is repaired
                    past the start gate WHILE sites still exist" @243
        TIMED OUT:  "the build crew keeps building (site progress advances materially)"
  [T] cons-link-core-first                 (T4, timeout @60/60t)   NOTHING satisfied
  [T] cons-link-farthest-source            (T4, timeout @60/60t)   NOTHING satisfied
```

**The two link cells run a 60-TICK window and satisfy nothing at all** — no core
link site is placed, no farthest-source link site is placed. That is not the
signature of a timing-sensitive cell losing a race under host load; it is a
decision that never fires. The 400-tick repair cell is the opposite: two of its
three assertions land early (@10 and @243) and only the throughput one times
out, which IS the shape host load produces.

So the three should not be carried as one class. Two of them are a placement
decision that does not happen in a staged world; one is a throughput assertion
that does not complete. Environment flakiness is a much weaker explanation for
the first pair than for the second.

**Caveat, stated so it is not over-read**: this run was on the audit branch
(master + a telemetry-only delta), not on unmodified master. The attribution
run — stash, rebuild master, re-run, byte-identical failure — was done properly
by the previous session and is what acquits spec 56. This adds the failure's
SHAPE, not a new attribution, and it does not discharge 58(b)'s full-grid step.

## Post-deploy verification t72875067 — 5 of 5 predictions confirmed, the container question SETTLED, and a residual that flipped sign

634 ticks after deploying core v37 + the P&L basis bridge. Window 634t. **The
deploy's global reset wiped the blackbox ring (357–418t), so F1 / S5 / X5 / E5 /
SCAV / R1 are over post-reset recovery, not steady state** — methodology #7's
own warning. The account's spawn and loss lines are NOT affected: both read
cumulative Memory-backed counters and were verified monotonic across the reset
(`spawnSpend` role totals rose; `losses.cumulative` likewise), so those span the
full 634t.

### Prediction 1 — CONFIRMED

`sourceMouth` on the wire at core v37, **13 keys**, one per visible source,
matching `sourceBuffers` exactly.

### Prediction 2 — CONFIRMED, and cd8d is DECIDED: **the container DIED**

```
  tick        core v   buffer  dropped  container   sourceMouth                       W43N24 site
  72873814      36       4316     2316       2000   (not emitted)                     none
  72874433      36       2588     2588          0   (not emitted)                     {n:1, rem:2427, done:2573}
  72875067      37       3581     1581       2000   {n:1, free:0, hp:0.92}            none
```

Three independent facts agree, and none of them is the stock:

1. **A construction site APPEARS in W43N24 in exactly the window the container
   reads 0**, at 2,573 of **5,000 done** — the container build cost — and is
   GONE by the next capture. No site there before; none after.
2. The container is back at 2,000 with **`hp: 0.92`, the HEALTHIEST of all ten
   remote mouths** (the rest run 0.44–0.84). At the unowned-room decay rate of
   50 hits/tick, 0.92 is a container roughly 400 ticks old — i.e. built during
   that window.
3. `free: 0`. It refilled to the cap in ~600 ticks and is already back where it
   started.

**So the mechanism is a LOOP, and it is not a hauling defect:**

> the container fills to cap → nothing drains it → it decays unrepaired → it
> DIES and dumps its whole load onto the ground, where it rots → construction
> spends **5,000e** rebuilding it → it refills to cap in ~600 ticks → repeat.

This RETIRES the pickup-priority hypothesis for cd8d (spec 59 §4, candidate 2 —
"haulers drain the container and leave the pile"), which was the more
interesting one. It was wrong. The energy did not move; the container stopped
existing.

**And `hp` prices the colony's exposure to the same loop for the first time:**

```
  cd8e 0.44  cee2 0.60  cd98 0.62  cbd8 0.66  cbd5 0.72
  d01f 0.73  cee0 0.73  cd94 0.73  cedc 0.84  cd8d 0.92     (~2,200 to ~4,600 ticks to death)
```

**Every remote mouth container is on a one-way slide**, cd8e nearest at ~2,200
ticks. Meanwhile the account's DEPRECIATION MEMO prints *"KEEPING UP — hits are
being held"* (repair 7.54 vs decay accrual 5.73) — a colony-wide aggregate that
was true while one of the structures it covers decayed to death. The memo's own
next sentence already states the stake: *"it is paid at full rebuild price when
a structure expires (a container is 5000 energy)."* It was.

### Prediction 3 — CONFIRMED

`cd90`, `cd92` and `cd99` report **`n: 0`**. Spec 54's *"neither home source has
a container"* is now a stated fact rather than an inference off a zero.

### Prediction 4 — CONFIRMED

No `RECONCILES to the colony account` line. The bridge prints in its place, and
on this capture the two windows are 410t (ring) and 634t (account): miner 4.76
vs 7.18, reserver 28.54 vs 18.45. The gap changed SIGN between cycles, which is
exactly the lumpiness the old sentence asserted away.

### Prediction 5 — CONFIRMED (the top line did not move on account of this deploy)

L1 pile decay **19.66 → 12.03 e/t** and ground stock 9,564 → 5,508. **Not
claimed.** Nothing deployed drains anything, and the window straddles a global
reset that shrank the fleet from 66 creeps / 882 parts to 59 / 779. L1 remains
the TOP LINE at 48.14× budget, and it now breaches on three lines rather than
one (pile decay 12.03, tombstones 3.26 vs 0.86, repair 7.54 vs 5.56).

### The new top-of-report item: **the RESIDUAL flipped sign**

```
  t72874433   RESIDUAL   +4.97 e/t    (  4% of gross mining, UNDER-attributed)
  t72875067   RESIDUAL  -21.50 e/t    ( 19% of gross mining,  OVER-attributed)
```

A 26.5 e/t swing, and the wrong sign: **more energy left the books than entered
them**, which no leak can produce and only a mis-measurement can. The method
says a residual that grows between cycles is a work item even when every leak
row is green. This one grew and inverted.

Every stock the capture DOES measure was checked, and together they move ~4.7
e/t against a 21.50 e/t gap:

| stock | Δ over 634t |
|---|---|
| source-mouth buffers | −1,156 |
| owned-room containers | −889 |
| controller stock | −205 |
| spawn/extension fill | −738 |

And every measured flow reconciles to its own cumulative counter to the decimal:
spawn 30,050e/634 = 47.40; pile decay 7,630/634 = 12.03; repair 4,779/634 =
7.54; tombstones (2,594−529)/634 = 3.26; controller = `gcl.progress` delta
21,436 = 33.81 (one owned room, so GCL progress IS the room's — no double
count). The single biggest mover is the BANK: +6.93 → **+27.59 e/t** (storage
141,204 → 158,697), and it is a direct measurement.

**The leading candidate is the gap the balance sheet has always named in its own
text: `creep cargo not measured`.** The fleet held **408 CARRY parts** at the
base capture and 386 at the close — up to ~20,400e that can be in flight at
either end, against an 11,800e discrepancy. A window that catches the fleet
loaded at one capture and empty at the other moves exactly that much across the
books with no line to carry it, and a global reset is precisely the event that
would empty them.

**That is a hypothesis, and it ships as a test rather than an argument: core
v38 `creepCargo`** — total energy held by the fleet, always emitted including
zero. Next cycle the residual either closes or it does not, and the answer is a
read.

### Correction — I claimed X3 was undiagnosable, and the capture had already diagnosed it

Last cycle I wrote that X3's chronic 4 untracked creeps was *"not diagnosable
from a capture: the census publishes the COUNT and no names"*. **That is
false**, and it is methodology note #9 again, one cycle after writing it up. I
checked the CAPTURE for names, found no `unattributed` key, and read that as "no
instrument" — when in this codebase an absent optional means EMPTY, and the
emptiness IS the answer. I did not read the code, which computes both
reconciling lenses and names this exact case in its own comment.

The reconciliation, across four captures and four different fleet sizes:

```
  tick        total  tracked  untracked   unattributed      countMismatch excess
  72871684      53       49        4      absent (empty)          4
  72873814      54       50        4      absent (empty)          4
  72874433      66       62        4      absent (empty)          4
  72875067      59       55        4      absent (empty)          4
```

**Zero orphans, every time, and `countMismatch` accounts for the difference
exactly, every time.** `untracked` is a difference of two lenses (`total` minus
Σ`getCreepCount`); `unattributed` is the id-match lens that would name a real
orphan. The emitting code says so: *"corps exist that don't COUNT creeps they
own, the newborn/recycling counting-lens class, not orphans."*

`moving-W43N23-controllerFeeder` claims 3 and counts 1 in **all four** captures
— the standing +2. That is spec 54's LinkCorp, which absorbed two roles (walking
feeder + parked port tender) behind one count lens. The rotating +2 is whichever
corp has a newborn or a recycler in flight. Recorded, not fixed: it is the
staffsPost-symmetry family and belongs with spec 54's open items.

**Fixed in the ledger**: X3 now judges against the reconciliation the capture
already carries. Named orphans still FAIL on the original threshold; a
difference `countMismatch` does not account for FAILs and says how many are
unexplained; a fully reconciled difference WARNs and names the mis-counting
corps. No account line moves and the chart of accounts is untouched, so
METHODOLOGY is deliberately NOT bumped — but the X3 row's VERDICT is not
comparable across this commit, and that is stated here rather than left to be
discovered.

### Cycle verdict: **VERIFIED (5/5) + one mechanism SETTLED + two instruments + one self-correction**

Shipped: core **v38** `creepCargo`; the X3 reconciliation. Both
telemetry/report-only — unit suite **2,426 passing**, build clean, no live
behaviour touched.

**Predictions for the next capture:**

1. `creepCargo` on the wire at v38, non-zero, order 1,000–15,000e.
2. **The residual moves toward zero once cargo is differenced** — if it does
   not, cargo is exonerated and the gap is an over-stated appropriation, which
   is a different and larger finding. Either answer is worth the field.
3. **X3 reads WARN, not FAIL**, and names `controllerFeeder 3/1`.
4. **cd8e is the next container to die** (`hp` 0.44, ~2,200 ticks at 50
   hits/tick). Watch for `hp` falling further, then a W43N24 site appearing, and
   a 5,000e rebuild. If instead `hp` RISES, something repairs remote containers
   and the loop has a brake nobody has found yet.
5. The top line does not move on account of this deploy. Nothing here drains
   anything.

## Post-deploy verification t72875335 — prediction 4 FALSIFIED, and that is the finding: remote containers ARE repaired

268 ticks after deploying core v38. Short window by design (the check-in fired
at the ~200-tick floor); the blackbox ring is 15t of post-reset recovery, so
**F1, S5 and every "measured at the spawn" line are noise here** — `tenders
2.267 vs 0.032` is a 15-tick ring, not a fleet. Reservation and consumers both
read 0.00 for the same reason. The account's cumulative lines (spawn ledger,
`losses.cumulative`, storage, `gcl.progress`) do span the full 268t.

### Prediction 1 — CONFIRMED

`creepCargo` on the wire at core v38: **5,642e**, inside the predicted
1,000–15,000e band, against 368 CARRY parts standing.

### Prediction 2 — NOT YET ANSWERABLE, and the prediction was mis-specified

I registered *"the residual moves toward zero once cargo is differenced"*. A
difference needs TWO v38 captures and this is the first, so the account still
cannot use the field. My own prediction could not have been checked at the
check-in I scheduled it for.

For the record, and as neither confirmation nor refutation: the residual came
back to **−3.81 e/t** on this window without any cargo term
(+4.97 → −21.50 → −3.81). Consistent with the t72875067 swing being a one-window
event rather than a standing bias, which is what a cargo effect would look like
— and equally consistent with three other things. The differenced read lands
next cycle.

### Prediction 3 — CONFIRMED

X3 reads **WARN, not FAIL**: *"49/53 tracked; NOT a leak - zero orphans and
countMismatch accounts for all 4: tender 2/1, controllerFeeder 3/1, raidGuard
2/1"*. `controllerFeeder 3/1` persists as predicted (five captures now), and the
other two rotated — tender and raidGuard this time, which is the newborn/recycler
churn the class predicts.

### Prediction 4 — **FALSIFIED. hp is RISING on 7 of 10 mouths.**

The first `hp` slope reading. Over 268 ticks:

```
  src    hp t72875067   hp t72875335    delta        src    ...
  cd8e       0.44          0.48         +0.04        cd98      0.62 -> 0.69   +0.07
  cee2       0.60          0.65         +0.05        cbd8      0.66 -> 0.70   +0.04
  cbd5       0.72          0.77         +0.05        cd94      0.73 -> 0.78   +0.05
  cedc       0.84          0.88         +0.04
  ------------------------------------------------- FALLING:
  cee0       0.73          0.67         -0.06        d01f      0.73 -> 0.69   -0.04
  cd8d       0.92          0.86         -0.06
```

Net across the ten mouths: **+0.18 hp-units. Colony container hits are GAINING,
not sliding.**

**So the claim I wrote into spec 59 §4c one cycle ago — "every remote mouth
container is on a one-way slide" — is false, and I am retracting it.** It was an
extrapolation from a single-capture LEVEL reading (0.44–0.92) with no slope, and
the level alone cannot distinguish "decaying unrepaired" from "repaired and
holding at a working equilibrium". The prediction I registered named this exact
alternative (*"if instead hp RISES, something repairs remote containers and the
loop has a brake nobody has found yet"*) — the brake is there.

The arithmetic, so the next session does not re-derive it: +0.05 hp over 268t is
+12,500 hits net against −13,400 hits of unrepaired decay (50 hits/tick in an
unowned room), so gross repair ≈ 25,900 hits ≈ **97 hits/tick ≈ one WORK part**
(REPAIR_POWER 100, 1 energy per WORK-tick). Holding all ten mouths costs ~500
hits/tick = **~5 e/t**, against 7.14 e/t of measured colony repair covering roads
and ramparts too. **The budget is roughly the right size; the ALLOCATION
rotates.**

Two of the three fallers explain themselves and the third does not:

- **d01f** — its room W41N23 is HOSTILE this window (`hostileUntil: 72876621`).
  No repairer can reach it. Explained.
- **cd8d** — the freshly rebuilt one at 0.92, the healthiest of the ten. A
  lowest-hits-first repairer correctly ignores it. Explained.
- **cee0** — 0.73 → 0.67, mid-pack, reachable, not prioritised. **Unexplained.**

**And this makes cd8d's death HARDER to explain, not easier.** If repair is
lowest-first and rotating, cd8d should have been top priority as it approached
zero. Something let it fall through. That is the open question, and it is a
better one than the one this cycle started with: not *"why is nothing
repaired"* (things are) but **"how does a container reach zero while a repairer
with spare budget is working its neighbours"**.

What survives unchanged: cd8d DID die and WAS rebuilt at 5,000e. The site ledger
evidence (a 5,000e site appearing and clearing in exactly that window, the
rebuild reading hp 0.92) is untouched by this. The loop is real; its cause is a
coverage gap, not an absence.

### Prediction 5 — CONFIRMED

L1 pile decay 12.03 → **10.52 e/t**, still the TOP LINE at 42.09× budget.
Not attributed to this deploy, which drains nothing.

### Live incident, recorded not fixed: a raid in W41N23

`P1 plan flap: 4adbd01f funded->defunded`, and the machinery behaved:
`hostileUntil: 72876621`, source defunded, guards spawned (defense 7.28 e/t on
the account), tombstones **100% in intel-hostile rooms** — the only window where
the raid story can legitimately claim the losses. Spec 13's hostile-defund is the
CORRECT-class rule from CLAUDE.md's trap list (defund at the spawn, strand
nobody) and it did what it says. The P1 flap and the 110.00 e/t capacity line
(one source excluded) are the raid, not a planner defect.

### Cycle verdict: **VERIFIED (3 confirmed, 1 falsified productively, 1 not yet answerable) + one retraction**

The falsified prediction is the valuable one and it cost one capture. No code
change this cycle — the finding is a retraction and a sharper question, and
inventing a fix for a mechanism that just changed shape would be the wrong move.

**Predictions for the next capture:**

1. `creepCargo` differences for the first time; the residual either closes
   toward zero or cargo is exonerated. **Both v38 captures now exist**, so this
   is finally checkable.
2. **cee0's hp keeps falling** (0.67 and dropping at ~50 hits/tick unrepaired ⇒
   ~3,350 ticks to death) unless a repairer reaches it. If it turns up, the
   rotation is just slower than one 268-tick window can see and there is no
   coverage gap to chase.
3. **d01f's hp resumes rising once W41N23 clears** (`hostileUntil: 72876621`) —
   the falsifiable half of the "hostile ⇒ unreachable" explanation.
4. X3 stays WARN with `controllerFeeder 3/1` present.
5. The top line does not move on account of anything deployed.

## Audit cycle t72884395 (2026-08-09, review session) — the 9,060-tick unattended window: cargo EXONERATED, the sweep's first fully-archived stretch, and the picker mis-ranks again

Capture t72884395 vs baseline t72875335: **dt 9,060 ≈ six fiscal months,
unattended** (no deploy recorded in the window; master unchanged at core v38).
`fiscal:archive` closed **seven months at 100% coverage each from the bot's own
boundary snapshots** (FY4858-M03..M09, handicap 12%→18% stamped per month) —
spec 50 doing exactly what it was built for; a capture-bracketed close could
never have covered this stretch. Sweep now at **19%, cycle 1, stepReason
`nominal`** (cycle 0's full 0→20% pass already archived; the wrap in ~2 months
gives two full passes = the designed aliasing protection).

### Prediction 1 — SETTLED: creep cargo is EXONERATED as the standing bias

`creepCargo` 5,642 → 11,174 over 9,060t = **+0.61 e/t**, against a window
residual of **−7.77 e/t**. A cargo slope explaining that residual would need
~70k of accumulation; cargo is fleet-size-bound. So the standing −3..−8 e/t
residual band is NOT cargo. The t72875067 one-window −21.50 flip remains
consistent with a cargo TRANSIENT (±5.5k in 268t ≈ ±20.6 e/t — this window
demonstrates swings of exactly that size are real), and nothing else on file
competes for it.

**Instrument gap, recorded not fixed:** the account still prints *"creep cargo
not measured"* in the balance sheet's committed line — the v38 field is on the
wire and the LEDGER does not consume it. One-line report change; it moves the
NET WORTH floor (+11k), so it lands with a methodology bump at the sweep-wrap
boundary per spec 51's timing rule, not mid-sweep.

### Prediction 2 — the cee0 coverage-gap worry DISSOLVES

cee0 hp 0.67 → **0.71**. The registered alternative fired: the repair rotation
is slower than a 268t window can see, but it reached cee0. No coverage gap to
chase there.

### Prediction 3 — NOT CONFIRMED: d01f fell despite the room clearing

d01f hp 0.69 → **0.61** net, over a window in which W41N23 cleared
(~t72876621) and the source re-funded. Not decisive alone — the window mixes
the hostile stretch with resumed mining — but d01f joins the falling side, and
the faller that matters is:

### The watch item: cd8d is falling FASTEST again

**cd8d hp 0.86 → 0.59 (−0.27), ground 1,835 → 2,257, pile-gate held 100% of
the window** — the freshly rebuilt container (5,000e, spec 59 §4c) is back on
the path that killed its predecessor, at ~2,950t to zero at the unrepaired
rate. Spec 59's sharpened question ("how does a container reach zero while a
repairer with spare budget works its neighbours") now has a live rerun
candidate. Colony-wide the rotation still nets positive (Σdhp +0.20 across ten
mouths; depreciation memo: repair 5.82 vs accrual 5.91, first small SHORTFALL
on record), and cee0/cd8e containers sit back AT the 2000 cap.

### Prediction 4 — CONFIRMED (sixth capture)

X3 WARN, 47/50, `tender 2/1, controllerFeeder 3/1`. The countMismatch class is
now the longest-standing WARN on the books.

### Prediction 5 — HELD, and the TOP LINE picker mis-ranked a second time

L1 10.52 → **13.33 e/t at 53.3× a 0.00 budget** (monthly closes ran 10.24–21.51
across the stretch — the series' normal band; nothing deployed claims any of
it). But the printed TOP LINE is **P1 (2 funded flips)** — a count naming no
energy ranked above the account's largest loss. **Spec 58(a)'s picker defect,
second live instance, different row pair** (first: S5 over L1 at t72871684).
The flips themselves: `4adbd01f defunded→funded` is the hostile machinery
recovering (legitimate, stamped); `4adbcd98 funded→over-budget` dropped the
farthest source (d=105) — needs attribution at the next boundary (tranche-edge
flap vs honest re-solve; spec 46's D-row is the instrument that would name it).

### The window itself (methodology #18 highlights)

- **G1: 99% income-funded, 52.03 pts/t sustainable — the most income-funded
  long window on record** (M02 close: 42%). Bank slope −0.39 e/t over six
  months, under handicaps 13→19%. Delivery held 106–112 e/t in every month.
- **E4 names an EQUILIBRIUM, not convergence: storage ~161k = reserve 77k +
  84k standing surplus, projected equilibrium 160,680 ≈ measured.** The bank
  has settled ABOVE its target with the feeder active — spec 48's gross-vs-net
  gap in stock form (the plan appropriates on gross; storage absorbs the
  difference; the "spend path" being checked is priced on the wrong basis).
- **S4 34% idle, 94% of it `empty` (no demand), while F2 under-fields 79p
  (547 declared / 468 fielded) and E6 holds 6 of 12 miner ops CHRONIC** —
  spec 55's signature, unchanged: capacity idle + ask declined + piles
  decaying. Mouth stocks fell 29,668 → 18,319 across the stretch, but part of
  that is cd98's defund-then-rot (a loss REALIZED, not cured).
- Instrument health: CPU bucket 10,000 (used 31/300), GCL 32 at 96%, spawns
  util 0.66/0.63 vs 0.667 ceiling parts 0.43, R1 at 2.60× accumulating toward
  the ≥10-window swap, X5 0.06 (worst: W43N23-construction 2,350e@103t, raid
  churn). No threat to the instrument.

### Workflow note (cost one close, fixed same session)

Running `fiscal:close` BEFORE `fiscal:archive` stole M04 into a 60%-coverage
capture-bracketed close with NO handicap stamp while the archive held a 100%
pair; deleted (seconds old) and re-closed from the archive: 100%, handicap 13%.
**Archive-first is the correct order** — the audit loop's §0 lists close first
and should be read archive-first from now on; better, `fiscal:close` could
prefer an archive pair when one covers the period.

### Cycle verdict: **VERIFIED (2 confirmed, 1 dissolved productively, 1 not confirmed→watch, 1 held) + one instrument gap named** (no code change — review session; findings feed the 2026-08-09 backlog/refactor/statement discussion)

**Predictions for the next capture:**

1. **cd8d's hp keeps falling** and reaches ≤0.35 within ~1,500t unless the
   rotation reaches it; a second death books another 5,000e rebuild + a 2,000e
   ground dump. If it TURNS UP instead, the rotation covers even the
   worst-piled mouth and spec 59's repair question loses its live case.
2. **The sweep wraps**: M10 runs at 20%, then 0% — cycle 1 completes with
   every month archived at ≥95% coverage.
3. X3 stays WARN with `controllerFeeder 3/1` (seventh capture).
4. `creepCargo`'s third point lands in the 5–15k band (fleet-size-bound, not
   trending); the residual stays in the −3..−10 band absent a raid window.
5. **cd98 stays over-budget at the next boundary.** If it re-funds with no
   world change, the tranche edge is flapping and spec 46 phase D (the shadow
   variance row) is the named instrument to build.

### Addendum, same session: spec 58(b) DISCRIMINATED — the three construction reds are PR #149's, and the environment is exonerated

The environment recovery made the check possible in-session (fresh sandbox:
`npm install` rolled back on the documented isolated-vm race; `setup:test-env`
had a path bug for the nested npm layout — fixed and verified,
`probe:mockup` → "OK - bot script executed").

On a freshly built master-tip bundle (src untouched this session), the three
cells reproduce **byte-identically to the original observation**:

```
  [T] cons-link-core-first                 (T4, timeout @60/60t)
  [T] cons-link-farthest-source            (T4, timeout @60/60t)
  [T] cons-t3-build-and-repair-concurrent  (T3, timeout @400/400t)
```

while two sibling controls PASS in the same sandbox, same build:
`cons-one-site-at-a-time` (satisfied @ tick 10) and — the same T4 link world
class as the two red cells — `cons-t4-link-completes` (satisfied @ tick 20).
**"Broken environment" may no longer be asserted.**

`git bisect` over #146 (f894be1, the last baseline ratchet) → #155 (the 56/57
session's attribution run had already proved master red BEFORE #156 merged),
predicate = the `cons-link-core-first` verdict marker:

```
  #148 f6e9487   PASS @ tick 20      good
  #149 48fbe19   [T] @60/60t         BAD  <- first bad commit
  #150 1bde4dd   [T] @60/60t         bad
```

**First bad: 48fbe19 (#149, merged 2026-08-03), "Methodology #7"** — titled as
a methodology change but actually a 146-file session squash (531k insertions;
src side: CarryCorp 254 lines, ConstructionCorp 142, ControllerFeederCorp 132,
UpgradingCorp 107, bank 106, commissionPlan 100). The MECHANISM inside the PR
is not yet identified — the two link cells die waiting for the core-link SITE
to be placed, so the ConstructionCorp placement/gate and bank/warchest hunks
are the first suspects for the follow-up session.

**Corroboration:** spec 08's row already carried `cons-t3` in the
"pre-existing reds" window dated by the 2026-08-03/04 bisects — the same
commit window #149 merged in. What the baseline has been carrying as ratchet
debt is, for these three cells, PR #149's regression with a name.

Next step (own session, full regression gate): read #149's ConstructionCorp/
bank diffs against the two 60t link cells (fast probes), fix or — if the
behavior change was intended — re-ratchet the baseline deliberately in the
same commit as the explanation.

## Audit cycle t72898387 (2026-08-09, second cycle of the day) — the raid window: H3 fires first time, the residual busts on a transition smear, and two proven fixes ship

Capture t72898387 vs t72884395: **dt 13,992 (~9.3 fiscal months), unattended,
no deploys**. `fiscal:archive` (run FIRST this time, per the last cycle's
lesson) closed **nine more months at 100% coverage** (FY4858-M10 → FY4859-M08).
**The sweep wrapped: cycle 1 complete (peaked 20%), and cycle 2 is walking at
~2%/month — the self-escalation clause fired for the first time** (the bot's
own controller-rate projection). Cumulative loss counters reset mid-window
(`losses.windowTicks` 6,267), so loss lines span 6,267t of the 13,992.

### The window's event: a raid defunded W43N24, and the correct-class rule has a gap

Two sources (cd8e, cd8d — 20 e/t of capacity) **defunded for occupied/hostile**
mid-window. The hostile-defund rule did what it says (no new bodies, strand
nobody) — and that exposed a seam nobody had priced: **standing miners keep
mining while the dropped plan routes stop all evacuation.** The mouths grew
2,257 → 6,135 and 3,614 → 6,815 (**~13k standing, growing**), the fielded cure
is one scavenger draining 0.51 e/t against ~7 e/t of decay (LOSING 14:1), and
the new-to-fire **H3 gauge named it exactly**: "2 mouths over cap with zero
drain creeps at both captures."

This is NOT a call to touch the defund rule casually — it took two incidents
to get right and it is the trap list's correct-class exemplar. It IS a named,
measured gap for the owner discussion: **production outlives evacuation by up
to a miner lifetime (~1500t) after every hostile defund**, cost this window
~7-12 e/t of rot plus the container deaths below.

### Prediction verdicts (registered t72884395)

1. **cd8d falls — CONFIRMED, past the threshold**: hp 0.59 → **0.19** (cd8e
   0.73 → 0.39 alongside), both containers AT CAP (`free: 0`) with the room
   hostile so no repairer can reach them. ~950t from death at the unrepaired
   rate; the second lap of the container-death loop is imminent, **with a
   named driver this time (raid), unlike the first lap**. Spec 59's repair
   question stays open for the ORIGINAL mechanism; this lap answers itself.
2. **Sweep wraps — CONFIRMED**: cycle 1 archived complete at 100% coverage
   every month; cycle 2 running (self-escalated step).
3. **X3 `controllerFeeder 3/1` — CONFIRMED (seventh capture)**; joined this
   window by `reservation 1/0` and `cbd5 3/2` (4 untracked total, all
   countMismatch, zero orphans).
4. **creepCargo in the 5–15k band — CONFIRMED**: 11,174 → 8,799
   (fleet-size-bound, not trending). **Residual −28.05 e/t, OUTSIDE the
   −3..−10 band — but the prediction's "absent a raid window" qualifier
   fired** (this was emphatically a raid window: R1 at 6.10×, 70% of deaths
   killed, guards up, 2 sources defunded). Leading hypothesis, labeled as
   such: most of the −28 is **capacity-basis transition smear** (revenue
   prices funded capacity across a window in which the funded set changed
   mid-stream) plus unmetered tower burn. Falsifiable next capture: with a
   stable funded set, the residual returns to band; if it does not, tower
   burn gets a meter before any re-theorizing.
5. **cd98 stays over-budget — DID NOT HOLD, but with a world change**: cd98
   re-funded because the W43N24 defunds freed 20 e/t of tranche. The naked
   tranche-edge-flap conditional did not fire; P1's 3 flips all trace to the
   raid. **The picker printed P1 over L1 (15.54 e/t named at 60× budget)
   anyway — the THIRD mis-rank in three cycles — which converted spec 58(a)
   from proposal to shipped fix this cycle (below).**

### The window itself (methodology #18 highlights)

- Income-funded **52% (MET)**; G1 51.82 pts/t sustainable; bank ~flat
  (−0.97 e/t) at reserve 70k (the target tracks funded income down:
  84k → 77k → 70k as capacity fell 120 → 110 → 100).
- **L1 14.99 e/t** (∞× a zero budget); forgone 6.61 (MISS — the pile gate
  holding miners at 5 of 12 ops, 42.70 heldFrac).
- F1 1.02×, F2 0.26 (worst rows now the DEFUNDED-room corps), H1 duty 0.94,
  X1 0.10 — the funded economy itself ran tight.
- Spawn util 0.66/0.63 vs ceiling; S5 0.72× (35%+ headroom); CPU bucket
  10,000. Instrument healthy.

### Shipped fix 1 (live behavior): the tender swarm cap re-denominated

Spec 55 catalogue #3 was "FIXED 2026-08-02" **in CarryCorp only** — the
2026-08-09 code sweep found `ExtensionTenderCorp` still count-capped behind a
stale "mirrors CarryCorp's" comment (the t72851251 mechanism: tender standing
34 of 48 declared parts, spawn idling `empty`, fleet stuck at 2× count with
CARRY short). Red-first: staged four 1-CARRY runts against a target-2 world,
watched the old gate decline, then replaced the count-2× line with the
absolute `TENDER_CREW_CEILING = TENDER_FLEET_CAP * 2` backstop (the staffed
exit already stops on COUNT+CARRY coverage — CarryCorp's carry-2× line is
unreachable here, so the honest port is the ceiling, not a copied line).
Latent-class fix: **no immediate live delta predicted** (current tender fleet
is 1 healthy body); the pin is the acceptance, and the t72851251 deadlock is
now unrepresentable. Unit suite 2,434 green; full trio gate GREEN (flow-handoff 4m, runt-economy 3m, storage-depot 7s) against the exact deployed bundle.

### Shipped fix 2 (instrument, METHODOLOGY #18 → #19): the picker and the cargo line

(a) **TOP LINE ranks by named energy.** Rows gain optional `energyRate` (L1
sets its breach sum); the picker promotes the largest named e/t, lists
unnamed FAILs beside the top line, and prints `BINDING: S5 ...` as its own
line at ≥0.95× ceiling (58a's counter-argument honoured — both facts print).
Re-run on this capture: `TOP LINE: L1 ... (15.54 e/t named)` with
`also FAIL: P1, H3` beside. Red-first pinned in `wasteLedger.test.ts` (6
tests, including the all-unnamed fallback and the no-binding case).

(b) **creepCargo joins the balance sheet** where the capture reports it
(absent stays absent for pre-v38 captures): committed = tombstones 11 +
ground piles 16,039 + creep cargo 8,799 = 24,849 this capture; the named-gaps
footer drops cargo. No account figure re-derived — #18 lines compare directly
to #19; NET WORTH moves by measurement only.

Timing note: the sweep-wrap boundary the review brief proposed for the
methodology batch has PASSED (cycle 1 closed complete at #18); these two
instrument changes are the batch's no-figure-changes half. The spec-51
budget-column re-graining (which DOES re-derive figures) still waits for its
own boundary + the owner's Decision 2.

### Predictions for the next capture

1. **cd8d's container dies** (hp 0.19, hostile room, no repair possible) and
   cd8e follows within ~2,500t; NO rebuild while the room stays hostile —
   expect `sourceMouth` to lose the container (or hp to reset high on a
   later rebuild after the room clears). The mouth stock rots in place.
2. **The residual returns to the −3..−10 band** with a stable funded set; if
   it does not, tower burn gets a meter before any re-theorizing (the
   transition-smear hypothesis is then dead).
3. **H3 stays FAIL** while W43N24 is hostile (the defund-evacuation gap is
   structural); the TOP LINE stays L1 by the new picker unless a larger named
   loss appears.
4. X3 stays WARN with `controllerFeeder 3/1` (eighth capture).
5. **No tender-fix live delta** in steady state (latent class); if a runt
   wave occurs, the fleet recovers to carry coverage instead of deadlocking
   at 2× count — the observable is `staffing > 2×target` with the ask still
   firing, impossible under the old gate.

### Cycle verdict: **FIXED (2 shipped: one live-behavior latent-class, one instrument) + BLOCKER NAMED WITH DATA (the defund-evacuation gap, H3's first fire) + 4/5 predictions confirmed or qualifier-fired**

## Audit cycle t72906414 (2026-08-09, third cycle of the day) — RCL 8, the falsified death, and the demand-seam fix ships on the owner's go-ahead

Capture t72906414 vs t72898387 (dt 8,027; the previous cycle's deploy + its
global reset sit inside the window). Six more months archive-closed at 100%
(FY4859-M09..FY4860-M04) — **sweep cycle 2 completed its wrap (2%/month
self-escalated steps) and cycle 3 is walking at 1%/month again.**

### THE EVENT: W43N23 reached RCL 8

The self-escalation was racing exactly this landing, and it landed inside the
window. Everything unusual in this capture follows from it plus the raid
clearing: warchest re-sized 70k → **105k** (funded income basis), **15 of 38
candidates funded (capacity 150)**, fleet ramping 49 → 72 creeps with F1 at
0.79× (the plan prices a fleet the spawn is still building), controller
published **0.00** against a 3.50 law cap (storage 110,250 vs reserve 105,000
— surplus 5,250/1500 = 3.50 exactly; P12 FAILs on the 3.5 e/t gap, which is
the RCL8 posture question arriving, not a valve break). P1: 7 flips, all
raid/RCL8-attributable (d017/d019/cd99/ca05 newly funded, cd8e+cd8d re-funded,
cbd8 out).

### Prediction verdicts (registered t72898387)

1. **cd8d dies — FALSIFIED, happily**: W43N24's hostile window expired before
   hp reached zero; the room re-funded, routes restored, and repair drove the
   container 0.19 → **0.62** (cd8e 0.39 → 0.32, still the risk case). The
   mouths are draining (`free` 164/760, off the cap). The defund-evacuation
   gap's COST stands (the stock rotted while hostile); the second container
   death did not land. **H3 cleared the same way — the routes coming back
   fielded the drain — which CONFIRMS the mechanism reading** (the gap was
   the dropped routes, nothing else).
2. Residual returns to −3..−10 → **precondition failed again** (7 flips, RCL8,
   reset): −15.59, halfway back from −28.05. The transition-smear hypothesis
   stays live and still owns the next stable-funded-set window.
3. H3 stays FAIL while W43N24 hostile → premise ended (room cleared); row
   cleared with it. Consistent, not a verdict.
4. **X3 `controllerFeeder 3/1` — CONFIRMED (eighth capture)**, now beside
   `construction 6/5` and `ca05 3/1` (5 total, all countMismatch).
5. No tender steady-state delta → **HELD** (no deadlock signature; tender line
   ramping normally with the RCL8 fleet).

### The demand-seam fix (owner: "Go ahead with the demand seam fix")

Shipped as ONE tranche, red-first, on the evidence base of specs 55/59 and
three cycles of rank-ordered `deadband` stamps:

**(a) The dead-band re-denominated in the measured jitter.** The mature ask
gate rode any deficit under HALF A HEAL BODY — 9–12 CARRY at capacity 5,600,
~10× the "+−1 CARRY solve to solve" wiggle it was written for, and the five
most-piled sources stamped `deadband` in exact pile order every solve. The
band is now `carryNeeded − fieldedCarry <= HAUL_ASK_JITTER_CARRY` (= 1,
primitives, with the measurement note). The POUNCE is deliberately untouched:
the §5 fence holds because the two sides never judged the same quantity — the
pounce classifies BODIES against floor share, and the heal branch buys
SHARE-sized bodies, so a fired ask cannot mint a cullable runt. Trace recorded
as spec 55 §5's addendum; pinned by the live-scale red test (deficit 4 vs old
band 11 → must ask) plus two stability pins (post-heal no-ask/no-cull;
drained-pile self-retire).

**(b) The owner's midpoint law.** `bufferDrainCarry` gains the /2
(`staged/2/CREEP_LIFETIME` — "half the ground pile over 1500 ticks", the same
temporal-midpoint argument `scavengeRate` uses). One law, three coherent
readers: the plan's route repricing, the corp's bootstrap re-add, X6's
judgment. Admission (`selectProducers`) never read the drain, so §4's
pile-cannot-flip-funding guard holds by construction.

Explicitly NOT in this tranche (one hypothesis at a time): the construction-
route filter hole (spec 59 B — a construction-only source's drain has no
owner; own design question), catalogue #4 (the upgrader sliver — same
predicate family, own red-first work), and the spec-39 declaredParts wire.
**Spec 55 stays OPEN: the F2==0 cell and #4 are still owed.**

### Gate results + predictions registered BEFORE deploy

Unit 2,437 green (3 new tests + 2 law pins updated). **Trio GREEN**
(flow-handoff 4m, runt-economy 4m, storage-depot 7s) on the deployed bundle.
`fid-t4-synthetic-steady-state` re-run as the nearest baseline-red: still
[x] at its pre-existing "controller fidelity >= 15% of upgrade budget"
assertion - the 2026-08-03/04 ratchet-debt red, not moved by this fix and
not caused by it (its failure is a controller-side fidelity term, not the
hauler ask). DEPLOYED to shard1 master (global reset). Predictions for the
post-deploy window:

1. **The `deadband` stamps clear off the piled sources** — `innerSizing.exit`
   flips to `asking`/`staffed` on the most-piled ops within ~2 solves.
2. **E6 falls**: held share on the chronic ops drops from ~100% as drain
   bodies field and the pile gate un-holds; forgone mining falls with it.
3. **L1 falls measurably** from 22.99 e/t named — not to zero (the /2 law
   drains asymptotically and decay keeps its share of the standing ~15k) —
   over the next 2–3 generations.
4. **X5 stays ≤ 0.09 of spawn spend** (the anti-treadmill live bound — the
   one number that falsifies the §5 analysis if it breaches), and X6 stays 0.
5. RISK named: the RCL8 ramp already runs F1 0.79× under-built; firing asks
   on every piled source adds hauler demand to a busy spawn. S5 headroom
   (0.72×, handicap ~1%) should absorb it; S3/S4 are the watch rows.

### Cycle verdict: **FIXED + DEPLOYED (the demand seam: dead-band jitter re-denomination + the owner's /2 drain law) + 2 predictions falsified productively (cd8d lived; the room cleared first) + RCL 8 reached**

The next capture owns the verification: the five predictions above, with X5's
<=0.09 bound as the falsifier of the SS5 fence analysis. If the deadband
stamps do NOT clear, the next suspect is already named in the tree (the
construction-route filter, spec 59 B) - instrument, don't re-theorize.

## Cycle addendum t72906414+ (2026-08-09, the RCL8 build-out): the #149 mechanism FOUND AND FIXED, the tower rung uncapped, and two of the owner's four asks turn out already built

Owner directive: *"RCL8 we can build a few buildings like a 3rd spawn.
Another tower. More links. And maybe more extensions. We will skip labs for
now."* The placement audit against the RCL8 allowances:

| ask | state found | action |
|---|---|---|
| 3rd spawn | **ALREADY BUILT** - Spawn3 stands at util 0.65; the spawn rung has been cap-aware since owner 2026-07-29 and fired on the RCL8 transition unprompted | none needed |
| more extensions | **ALREADY BUILT** - energyCapacity reads 12,900 = 3x300 + 60x200 exactly; the checkerboard rung read `EXTENSION_LIMITS[8] = 60` and filled the allowance | none needed |
| another tower | **IMPOSSIBLE by code** - `findMissingTower` was hard-coded to ONE tower (`hasTower` silenced it forever once the RCL3 tower stood) | **FIXED**: `TOWER_LIMITS` table + `wantsAnotherTower` (spawn-rung shape, counts sites) + `TOWER_TARGET_PER_ROOM = 2` - deliberately below the engine's 6 (a tower is idle capital + a tender refill lane + unmetered burn; growing past "another" is a numbers decision, one constant away) |
| more links | **NO RUNG WANTS THEM** - `LINK_LIMITS[8] = 6` with 4 standing, but the rung's ladder (core, controller, source links) is satisfied: both home sources already carry the port links | named as the open design task: the two free slots want EDGE deposit-port links (spec 26 stage 5 / spec 49 leg B / spec 45's edge geometry - the DEP gauge already ranks the candidates at ~870 tile*e/t). A placement optimizer, not a constant - deliberately NOT bolted on |
| labs | skipped per owner | none |

### The #149 regression: mechanism found, and it was the recycle pad's ladder slot

The bisect (t72884395 addendum) named PR #149; the hunt this cycle named the
LINE. #149 added the recycle-pad rung at position 1.8 - ABOVE the tower,
spawn, storage and link rungs. In a mature room the pad places a 5,000e
container site first; in the three staged cell worlds (`creeps: quiet()` - no
builders - and a bank below reserve) that site can never complete, and
`placementGateOpen` (activeSites > 0, no surplus) never reopens - so every
infrastructure rung behind it starved forever, and all three cells timed out
byte-identically. Live rooms have builders, so the pad built in minutes and
the ladder proceeded - which is why the regression was invisible outside the
grid for six days.

Fix, two halves, both principled rather than cell-shaped:
- **The pad moves BELOW the capacity structures** (new rung 2.8, after
  links): a convenience container yields to defense, spawn throughput and
  the link network by priority, not just by the incident.
- **The pad joins `wantsAnyContainer`** (spec 56 open item 2 - the same D1
  defect the port rung had): a mature room wanting ONLY the pad now opens
  the gate at all.

### Gate: ALL GREEN, deployed

The three #149 cells, on the fixed ladder: `cons-link-core-first` **1/1 @
tick 30**, `cons-link-farthest-source` **1/1 @ tick 30** (both were timeout
@60/60), and `cons-t3-build-and-repair-concurrent` **1/1** (site @10, repair
past the gate @243 - the pad site was breaking the build-and-repair world
too). Controls unharmed (`cons-one-site-at-a-time` @10, `cons-t4-link-completes`
@20). Trio GREEN (flow-handoff 4m, runt-economy 3m, storage-depot 7s). Unit
2,443. **Spec 58(b) is CLOSED end to end: observed -> environment exonerated ->
bisected to #149 -> mechanism named -> fixed -> all three cells green.**
DEPLOYED to shard1 master.

### Predictions for the next capture

1. **A second tower site appears in W43N23** within ~2 placement cooldowns of
   the deploy (the rung's want is immediate; tower #2 lands near the spawns)
   and completes at builder pace. Tender refill covers it (spec 07 wiring).
2. The pad rung stays QUIET in W43N23 (container table 5/5 FULL - the
   (41,22) orphan holds one of the five slots; spec 54 item 10 unchanged).
3. No new links place (correct per the table above - the edge-port design
   task is the named follow-up).
4. Grid: the three #149 cells stay green from here; the ratchet's
   construction avenue is trustworthy again.

## Audit cycle t72917269 (2026-08-10, edge-link session) — the 41,934-tick window: pile decay is the top line, port 8f08 reads SATURATED, and the RCL8 edge-link rung ships as the intervention

The window since t72875335 ran unattended under the ramping sweep (fiscal
archive closed FY4860-M05..FY4861-M01 at 100%, handicap stepping 3%→8%).
Account headlines (methodology #19):

- **Forgone mining 67.17 e/t (45% of capacity)** — the miners' pile-gate
  stamps explain 33.78 of it (heldFrac). Controller 40.89 of 150 capacity
  (27%, target ≥50%) — MISS both.
- **TOP LINE: L1 pile decay 15.46 e/t vs budget 0.00** (ceil floor 5.80
  across ~9.5 standing piles). E4 also FAIL: 413,038 above reserve, slope
  +8.42/t, projected equilibrium past the absorbable knee. P1 flap: 4
  sources (d017/d019/d01f/cd99 flipping funded↔over-budget). P7 FAIL on the
  stock read (controllerStock 657→1433 — the energy stood).
- **E6 chronic:** cd8e (buffered 3,552) and cee2 (2,312) held 100% of their
  windows — "the leak is HAULING", says the row, and SCAV agrees: we collect
  21% of pile outflow, the engine takes 79%, LOSING on 3 of 3 stocks.
- **DEP names the mechanism candidate:** per-link deposit demand 4a83
  40.0 e/t (rho 0.85) and **8f08 60.0 e/t against 51.5 absorbable — rho
  1.16, SATURATED**, with 10 routes still wanting a port (savings 19/16/13/
  13/13/12 tiles). Spec 47's own band table: rho ≥ 1.0 is the regime where
  no buffer helps — the routed load has to come down.

**The cycle's hypothesis (one, labeled):** the saturated port throttles
evacuation on the routes that want it; their mouths back up; the pile-gate
holds the miners (E6) and the standing piles rot (L1). The intervention is
the one the owner directed this session (*"Let's take a look at adding links
since we're rcl8"*): the RCL8 edge-link placement rung — spec 47's third
blocker, shipped as `bestEdgeLinkTile` + `findMissingLink` rung 3, corrected
same-day to the owner's model (real published `Memory.fundedRemoteFlows`
weights; the 800/F ring measured per tile from each candidate's own
catchment, fire rate strictly exceeding it). Full design trail: spec 47
§edge links, spec 26 stage 5 UPDATE. Gates: unit 2,463 (23 pinning the
feature), lint at baseline, trio green on the final bundle.

### Methodology note #10 — the grid cannot ratchet on the sandbox host

The full grid on this session's remote container fails 21 baseline-green
cells (bot level 4→0) **identically on the branch and on its base commit
dbad248** — failure sets byte-equal, while the same cells pass run SOLO on
the same bundles. The full run's 12-bot worlds overrun this host's real
per-tick CPU (the mockup meters real CPU — the armed-governor trap's
mechanism, minus the governor). Consequence: on a slower host, single-cell
runs and A/B attribution remain valid; the RATCHET verdict does not.
`baseline.json` was left untouched; ratcheting it on a host-invalid run
would corrupt the metric. Attribution method when a full-run cell reds on
foreign hardware: solo rerun first, then base-commit A/B — identical
failure pre/post acquits the change (the standing attribution rule, now
with a measured host-scale instance).

### Deployed t~72917600, predictions registered

Branch = deployed master (dbad248) + exactly two commits (2a4ca61 rung,
d04ab81 owner-model correction). Predictions:

1. `Memory.fundedRemoteFlows` publishes within ~2 solves: ~10 remote rooms,
   Σ ≈ 130 e/t (the P&L's funded set).
2. A STRUCTURE_LINK site places in W43N23 within a placement cooldown of
   the first publishing solve: range ≤ 26 of the core (35,25), outside the
   core/controller/source lens bands, on the unserved S/SW/W arc — and NO
   twin beside 8f08/4a83 (their approaches' marginal saving is ~0).
3. The site builds at builder pace (P8 read 1.65 e/t → ~3,000t for 5,000e),
   so buffer/tender/rho relief are NEXT-cycle observables — this window
   verifies placement + publication + heartbeat only.
4. Heartbeat unharmed: feederActive true, no X5 spike, no placeResult error
   spam from the new rung.

Verdict: PENDING post-deploy verification (below, after recapture).

### Post-deploy verification t72918044 (+ live room read t72918xxx) — 4/4 confirmed, BOTH slots placed

1. **CONFIRMED (indirect)** — the election ran with real approach weights: two
   sites in two elections, the second treating the first as an existing port
   (marginal baseline working). `fundedRemoteFlows` itself is not
   capture-visible (Memory only; the flow segment does not emit it — named
   gap, harmless: the plan's own consumers read Memory).
2. **CONFIRMED, twice** — link sites at **(23,38)** (range 13 → ceiling 61.5,
   the SW arc: the relief lane for 8f08, which this read caught at 800/800
   FULL) and **(31,6)** (range 19 → ceiling 42.1, the N arc). Both inside
   their rings, outside core/controller/source lenses, no twins by existing
   ports (cheb 20 and 15 to the nearest).
3. **IN PROGRESS as predicted** — both 0/5000; builder-pace observable next
   cycle (with two sites the widening gate funded 10k of board at once,
   surplus 545k).
4. **CONFIRMED** — feederActive true, bucket 10,000, controllerStock
   1,433→2,676, no churn spike, no placeResult error stamps.

Cycle t72917269 verdict so far: **FIXED (placement) + INSTRUMENTED (flows
publication)**; the L1/rho-relief half stays open until the sites BUILD and
the next capture reads the new ports' rho and 8f08's wait shares.

### Same session, owner-directed: the link P&L question and its instrument

Owner: *"Can you show me a link income statement PnL chart or something about
their distance, throughput any creep waits or transfer waits or transfer
amounts per each link"* — answered from t72917269 (per-route portWaits joined
to ports via the plan's hauler `port` field): 4a83 at rho 0.85 runs a
ZERO-wait book on 5 routes; 8f08 at rho 1.16 makes 40-62% of arrivals hold,
and cd99 (the best-saving route, 19 tiles) is the one squeezed out entirely
(waitFrac 0.846, 11 fallbacks, demoted to the long haul). Named gaps became
core v39: `links[].perLink` — per-SENDER fires / sentRate / volleyAvg /
clampShare (LinkMeter split, sender id threaded through every
recordLinkFire). Deposit VOLUME per port (events are counted, energy is not)
remains open.

### Deploy 2 (same cycle, t~72918100): the unified election + core v39, predictions registered

Owner-directed unification shipped (*"Yes clear up these 3 vestiges and
generalize it"* — spec 47 §UNIFIED): one election for every non-structural
link, mouths as approaches, ownSourceRate pricing, tender debit. Gates: unit
2,469; trio green (4m/3m/7s); cons-link-core-first + cons-link-farthest-source
1/1 (the deleted source rung's placements reproduce). Predictions:

1. **No churn from the model swap**: both standing sites persist; table at
   6/6 keeps the election silent — no third site, no swap fires.
2. **Core v39 next capture**: `links[].perLink` rows for 4a83/8f08/0ebf;
   8f08's own clampShare lands near the room's 0.586 (it is the heavy
   sender), 4a83's below it.
3. **Heartbeat unchanged**; X5 read with the global-reset caveat.
4. **Zero live placement delta from unification itself** (both mouths
   linked): the unified and old models elect identically in W43N23 today —
   its live value begins with the NEXT room, and the model being one lens.

## Audit cycle t72918307 (2026-08-11) — deploy-2 verified 4/4, and the colony's first RCL8 window exposes the engine throttle the plan never modeled

**Deploy-2 verification, 4/4 confirmed** (window 221t): core v39 live with the
per-link split, and it paid for itself in its first read — 8f08 fires 693e
average volleys with **clampShare 0.706** vs 4a83's 0.312: the core-side clamp
concentrates on the heavy sender, a read the room aggregate (0.548) could
never give. Both relief sites persist (1,275/10,000 built), no third
placement, no swap, X5 0.01, heartbeat clean.

**THE CYCLE'S FIND — delivery pinned at exactly 15.00 e/t.** The account's
controller line (GCL-based) read 15.00 while P7 (rclProgress-based) read 0.0:
a two-gauge disagreement, and both were telling the truth. A level-8
controller freezes rclProgress (P7's blindness) and the engine hard-caps
upgrading at **CONTROLLER_MAX_UPGRADE_PER_TICK = 15 e/t** (the 15.00). The
plan does not model the throttle anywhere: it allocated 100 e/t (relegated
wartime floor 50) against a 15 e/t pipe, the un-absorbable flow defaulted to
the bank (**+33.10 e/t** — E4's idle-capital mountain now has its mechanical
cause at RCL8), and a **66-part upgrader fleet** stood against a pipe ~3
bodies serve. The owner's morning framing names the class exactly: a planning
problem — allocation above physical throughput — this time at the controller
instead of a link.

**Fixes shipped (one seam each):**
- `RCL8_UPGRADE_CAP = 15` mirrored in primitives (engine ground truth,
  pinned); applied inside `controllerUpgradeCap` — the ONE physical-cap lens
  the sink capacity, wartime relegated floor, valve, feeder target and fleet
  sizing all already read, so every consumer reprices from one edit. Applied
  on the defensive catch path too (the level read precedes the parking lens).
- **P7 reads the GCL delta** — the same always-sighted colony-wide delivery
  meter the ENERGY ACCOUNT and G1 use (1 GCL point IS 1 upgrade energy, every
  room, every level). Its wartime-starvation pin re-staged on that lens.

**Transition-window caveat recorded:** this window (263t) straddles the
deploy-2 global reset AND the wartime-build flip our own link sites triggered
— S5 0.93 (rebuild wave), defense/reservation lumps, controller depression
are multi-cause; no level claims from this window beyond the engine-pinned
15.00. The sweep runs at handicap 10%, cycle 3 (FY4861-M02 closed at 52%).

**Predictions for the post-deploy capture:**
1. `controllerAllocations[W43N23]` ≤ 15 within one solve; upgrader
   `sizing.allocated`/`planAllocated` ≤ 15; the wartime relegated floor reads
   ≤ 15, so **P7 → ok at ~1.0x** with delivery 15.0.
2. No NEW upgrader purchase sized beyond the capped allocation (standing 66
   parts shrink by attrition, never revocation).
3. E4 stays FAIL and the bank keeps climbing — the fix makes the plan HONEST
   about the throttle; it does not spend the freed ~35-85 e/t. The real
   absorber is EXPANSION (GCL 32 at 96.2%; W45N23 founding already has a
   site) — spec 53's decision, the owner's call, now with its number named.
4. Link relief unaffected: both sites keep building; next cycle reads the new
   ports' rho and 8f08's clampShare/waits off the v39 split.

## Audit cycle t72931338 → t72931657 (2026-08-11): THE FIRST CLAIM — the expansion tranche verified end to end in production

**Context:** PR #161 (spec 06 full fix: plan-ordered build pool, expansion
placement lane, claim on the books, owned-room replan trigger) deployed from
this session at ~t72929800; this cycle is its post-deploy verification AND the
first live claim in the colony's history.

**ENERGY ACCOUNT (window 1182t, methodology #19):** gross mining 40.00
(spec-58 taper: bank 948k, remoteRooms 2), controller 15.00 (the RCL8 engine
cap exactly), NET MINING MARGIN +0.54 F. Overhead −8.79 U — dominated by the
deploy reset's bootstrap wave (jacks −5.33 unbudgeted; 77% of recycle
tombstones = jack-retire). FAILs: F1 2.08× (deploy-window churn class, re-read
next cycle), E4 idle capital 920,844 above reserve, L1 44× (pile decay 11.02 —
spec 59's standing program), P12 0.15× (the RCL8 cap is the binding fact).
E4+P12+G1 all named the same cure: open the claim.

**Live Memory reads (new instrument this cycle — the memory API):**
`Memory.expansion` null, `Memory.spawnPlacements` = ONE stale home entry —
the placement sweep's job state is heap, a deploy wipes it, and the kick sat
behind the fiscal-month gate: **every deploy left the trigger's candidate
pipeline stale for up to a month.** Filed + fixed this cycle
(`shouldKickSweep`: one catch-up kick per global, re-armed by
resetSpawnPlacement; red-first unit test).

**The claim (campaign staged W43N24 by console per spec 46's sanctioned
console-force lever; spawnPos (35,27) computed by the bot's own picker):**

| t (rel) | event | evidence |
|---|---|---|
| t72931407 | campaign staged | Memory.expansion confirmed via API |
| +~15t | claim corp commissioned + claimer fielded | corps seg: `claim-W43N24-claim`; byKind claim 1 |
| same solve | **campaign PRICED** | flow stamp `expansionCampaigns: 1` (fix 3 live) |
| ~t72931520 | **W43N24 CLAIMED** | rooms[] gains W43N24 rcl 1 |
| t72931529 | **owned-room trigger fires** | planTriggerState.lastForced = 72931529 |
| same pass | **founding site placed at (35,27)** | rooms[W43N24] siteCount 1, siteTotal 15000 |
| +by t72931657 | claimer demobilized; fleet re-expands 30→35 | byKind claim 0; creep total |

Every deployed mechanism fired in order, on the first live run. The funnel
(siteProgress > 0, then the spawn standing and the campaign closing) is the
next cycle's checkpoint; the crew sizes off buildPoolAbsorbRate with the 911k
surplus accelerator.

**Cycle verdict: FIXED + INSTRUMENTED.** Fixed: the sweep catch-up kick
(deployed after verification). Instrumented: the memory-API read joins the
audit toolkit (trigger inputs are now readable without a console round-trip).
Fiscal archive closed FY4861-M03..M10 at 100% (handicap 10→17%).

**Predictions for the next capture:** (1) W43N24 siteProgress > 0 and rising
(the 85-valued pool head owns the crew); (2) `spawnPlacements` grows past one
entry within a global of the kick-fix deploy (expansion lane entries appear);
(3) E4's slope flattens as the founding + re-expanded mining absorb the
surplus; (4) when the spawn stands: campaign closes (Memory.expansion
cleared), spawnCount trigger fires, W43N24 starts its own economy with zero
new code — the spec-06 bet's last unverified clause.

**Post-deploy addendum (same cycle, +~300t): the kick-fix prediction is
PENDING-FALSIFIED, and the attribution found the deeper mechanism.**
`spawnPlacements` still reads ONE stale entry at ~250t after the #162 deploy —
and the decisive read: **all 480 nodes carry `createdAt: 71517058`**, ~1.4M
ticks ago. The live terrain analysis has not COMPLETED since then: every
deploy's reset-rebuild path (main.ts "Territory cache empty after reset")
either restarts a crawl that the next deploy resets again, or dies silently -
so the analysis cache the sweep kick needs has been absent for weeks, and
`refreshNodeResourcesFromCache` has been a no-op the whole time (its own
docblock: "remote mining silently stops" - the economy runs on PERSISTED node
resources). The sim exhibited the same crawl signature (batch 1/6 alone >250t
on real rooms). The kick fix is correct but gated on this broken precondition.
**NEXT CYCLE'S TOP ITEM: why the live analysis never completes** — instrument
first (a progress stamp on the incremental job: batch index + evaluated count
into Memory each step), then read whether it crawls, restarts, or throws.

## Audit cycle t72931992 (2026-08-11, same session): the funnel measured, the kick's self-consume found IN CODE, and a correction

**CORRECTION of the previous addendum (methodology #8/#9 class - a claim
about an instrument made from inference, not a code read):** "the terrain
analysis has not completed in 1.4M ticks" was WRONG. `createdAt` is a node's
MINT date, preserved across re-analyses - the analysis pass UPDATES existing
nodes in place (`colony.getNode(peak.peakId)` + roi refresh), so a stable
node set keeps its original stamps forever. All 480 nodes reading 71517058
means the node SET has been stable since first analysis, nothing more. The
staleness evidence stands on the placements read alone.

**The funnel, measured live:** W43N24 founding spawn at **9,060/15,000
(60%)** ~463t after site placement - **~19.6 e/t of cross-room founding
flow** through the plan-ordered pool. Fleet 44 (re-expansion continuing:
26->30->35->44), home bank draining into the founding, CPU bucket 10,000.
Spec 06's funnel prediction CONFIRMED at production scale.

**The stale-placements mechanism, code-proven this time:** post-reset,
`restoreVisualizationCache` rebuilds a TERRITORY-LESS analysis cache first;
the #162 catch-up kick fired against it, `buildPlacementContexts` got an
empty territories map -> zero contexts -> no job - and `startSpawnPlacement`
consumed the catch-up anyway ("even an empty-context kick counts", its own
comment). The real rebuild lands territories ~9 ticks later (one batch/tick,
6 batches) with no kick left. Fix: an empty-context start keeps the catch-up
armed (red-first pinned); and the sweep gains a Memory stamp
(`Memory.sweepProgress`: kickedAt/contexts/completedAt/entries) so the next
stale-placements read diagnoses itself in one pull - contexts:0 = the
territory-less restore, missing completedAt = a sweep that never finished.

**Prediction for the post-deploy read:** `Memory.sweepProgress` shows a kick
with contexts >= 2 within ~20 ticks of the reset (empty attempt, rebuild,
re-kick), a completion, and `Memory.spawnPlacements` grows past one entry
with candidate-room placements - the expansion trigger's pipeline finally
primed for the AUTO path.

## INCIDENT t72933848 (2026-08-11, same session): the two-room analysis restart hard-killed the global; emergency inverted-default hold; colony recovered

**Timeline (all reads on file as fixtures):** healthy at t72931992 (44
creeps, funnel 9,060/15,000 at ~19.6 e/t) -> #163 deploy -> fleet bled to 3
by t72933856 with `losses.windowTicks 6` (a reset ~every 6 ticks), blackbox
ring ~1KB, spawn util 0.889 building into orphaned newborns (countMismatch:
every mining corp claimed 1 / counted 0; untracked == all creeps) -> Memory
FROZE at t72933848: agenda stamp static across minutes, `Memory.probe` never
landing from console, twelve memory-API flag writes never executing (the
"API write" is a queued console op - it needs a completing tick; a dead bot
can execute NO flag). Bucket full throughout = heap-class VM kill, not CPU.

**Emergency action (instrument-protection doctrine):** the only lever a dead
bot leaves is the code deploy, so the analysis default INVERTED -
`runIncrementalAnalysis` and the post-reset territory-rebuild guard both run
only when `Memory.analysisGo === 1`. Deployed; the next global survived:
console streaming (websocket instrument - new this cycle), a 2,600e builder
spawned at t72934299, and by t72934373 **13 creeps (harvest 8/tender/feeder),
173 reset-free ticks, bucket 10,000, founding site intact at 9,080/15,000**.

**Corrections logged:** (1) the earlier "advancing then frozen again"
read was a cadence misread - the agenda stamp updates when the QUEUE
changes, not per tick; the pre-deploy freeze was real (three independent
instruments), the post-deploy one was not. (2) The #163-cycle attribution
("the catch-up consumed itself") was correct but INCOMPLETE - the deeper
fault was the analysis restart being fatal at two-room scale; the catch-up
fix is moot until analysis runs at all.

**Standing state and the path back:** `analysisGo` UNSET - analysis held
colony-wide; territories stay stale; the placement sweep and therefore the
AUTO-expansion candidate pipeline stay parked (hand-staged campaigns remain
the proven interim lever - today's claim ran claim->trigger->site->funnel
end to end). NEXT: instrument the batch step (per-batch heap/CPU stamps to
Memory) on the healthy colony, read one guarded batch, and only then design
the re-enable (smaller batches / heap ceiling / room cap). Watch item until
then: W43N24's founding completes on the recovering crew; the campaign
closes on spawn-stand (the spawnCount trigger fires regardless of the hold).

## Audit cycle t72935153 -> t72936194 (2026-08-11): the ORGANISM cycle - the founding room joins the colony's economy

Owner's lens for the cycle: *"supply from nearby nodes gets hauled to this
new room... The nodes all work together, not just each room for itself."*

**Arc milestones measured first:** founding spawn STOOD (spawns 3->4),
campaign closed itself (Memory.expansion -> null), fleet 60, and the
already-working organism halves confirmed: bank->new-spawn route planned,
nearby sources feeding construction, a home-spawned 7W upgrader walked to
the new controller, both new-room corps reading the shared colony bank.

**The gap, measured then fixed (PR #165):** W43N24's controller planned 14
e/t from bank-W43N23 over 55 tiles (publishRoster skips bank routes; the
depot movers' reach is the feeder's link) while cd8e hauled home past it -
plan 14, actual 0.01 e/t over a 186t window. Fix: storage-less rooms'
controllers join spec 25's local exception (deposit sources nearer than
their hub feed them; the bank is refused - honest shortfall over phantom
flow) and the local pre-pass (after construction, before the deposit
fill). Depot reach derives from storage sinks AND bank sources (the
full-bank case emits no storage sink - caught by the spec-38 healthy-
ledger pin going red on the first cut).

**Post-deploy, predictions vs measured:** the route flipped exactly as
registered - controller-cd8c now draws source-cd8d @10 (d=6!), scavenge
@2, cd8e @2; home's controller keeps its bank/feeder leg. cd8d is nearer
to the NEW room's controller than to its own hub - the organism thesis in
one route. First energy landed within ~350t of the deploy: **RCL 1 -> 2**
(progress 50 -> 200 -> 3, ~1.1 e/t and ramping as the 16C hauler squad
fields). Named follow-up: bank->spawn edges to depot-less rooms are still
planned executor-less (self-healing physically; F1 pollution).

**Cycle verdict: FIXED, prediction-confirmed.** The full organism chain -
claim, founding funnel, local supply, the climb - is now measured working
at production scale.

## Audit cycle t72936194 -> t72938848 (2026-08-11): the transit-embargo split - 30 e/t funded that no corp would staff

**The account's headline:** forgone mining 40.28 e/t (25% of capacity, the
largest line in the account), pile decay 23.97 vs budget 0 (L1 top line),
controller 12% of capacity vs >=50% target, bank +9.37 e/t above a reserve
already 7x over target.

**The attribution walk (stamps over inference, and the stamps first
mislead):** the account's own decoration blamed the pile gates ("stamps
explain 24.79 e/t (heldFrac)") and E6 blamed hauling. Differencing each
harvest corp's cumulative `produced` across the two captures falsified both
readings: every pile-gated source mined 9.5-10.0 e/t (the de-pricing gate
holds PRIORITY, not the pick - its heldFrac is not a mining contra), and the
forgone 40 is almost exactly **four sources fielding nothing at all**: cd8a
(W43N25), ca05 (W45N23), d017 (W41N25) all stamped `gate:
"transit-embargo"`, plus cd99 ramping after its P1 flip. Three embargoed
sources = ~30 e/t, stamped "funded" in the same capture's candidates[].

**The seam (the trap list called it):** the planner's danger lens is the
source ROOM only (flowAdapter `defunded`, t72793209) while the corps'
purchase gates read `routeIsDangerous` over the WHOLE transit
(HarvestCorp:586, CarryCorp:1504). Active marks at capture - W45N24 and
W44N25 (hostileUntil ~t72940123), the raided corridor NW of the new W43N24
spawn - made routes dangerous whose endpoints were clear. Plan funds, corps
refuse: 30 e/t of phantom capacity, a 7.2 e/t cd8a flow into
controller-cd8c sizing W43N24's upgraders (28 WORK fielded, dryShare 0.559,
stock 0), reservation still bought for W45N23 (2.10 e/t for a room mining
nothing), F1 over-stating 0.186 p/t.

**Fix (red-first, `transit-embargo admission` suite in
CorpPlanner.test.ts):** `ColonyProblem.routeDangerous` carries the corps'
lens as a closure exactly like `dist`; `selectProducers` prefers the
nearest spawn with a SAFE route (reroute before forgoing - cd8a/ca05 remain
fundable via W43N23's spawns whose corridor is clear), embargoes with its
own stamped verdict only when no spawn qualifies, exempts spawn-room
sources (the t72793209 polarity), and never silently reroutes a spec-18
pin. flowAdapter passes the live `routeIsDangerous`; absent lens =
fail-open (every harness unchanged).

**Also fixed:** P12's `.find(first controller sink)` broke when W43N24's
local-fed controller joined the plan - it compared the NEW room's
allocation (28) against W43N23's feeder relay (20) and printed a phantom
"RUNTIME FAULT". Room-matched now (feeder's room end-to-end): relay 20 >=
published 15, ONE VALVE holds; the row keeps failing honestly on the
solver gap (0.15x the law's cap, wartime relegation + spawn-sink claims).

**Sidebar measured, not fixed (named for the next cycle):** the Spawn4
"hold" rows (miner 650 / reserver 1300 vs a 550-cap bank) are benign - the
auction is global and big bodies wait for big spawns. The REAL standing
leaks behind L1: inflow-sized carry has no backlog drain term (H1: haulers
BUSY while 6.4k sits piled; d01f delivered 4.94 of 9.60 mined) and the
scavenge fleet loses to decay on 3 of 3 stocks (drain 3.03 vs decay 14.00
e/t - we collect 18%). cd8e's squad shows duty 0.561 / idleSink 0.426
against a SATURATED deposit link (8f08 rho 0.96) - the port leg is the
suspect if the pile survives this deploy.

**Predictions for the post-deploy capture:** (1) candidates[] shows
cd8a/ca05 funded with a W43N23-side spawnId (or "embargoed" while marks
stand - either is coherent; "funded at db0f" is the failure); (2) forgone
mining falls toward ~15 e/t as rerouted fleets field (full effect needs a
fleet-walk window); (3) W43N24's controller allocation drops toward its
real local inflow (~21) and upgrader dryShare falls from 0.559; (4) F1's
over-statement shrinks by the embargoed classes; (5) W45N23 reservation
stops renewing while its source is unworkable.

### Post-deploy verification t72940325 (+~1400t, deploy mid-window): FIXED

The five predictions, against the fresh solve (flow tick 72940326):

1. **CONFIRMED, the sharp one**: cd8a "embargoed", d017 "embargoed" -
   stamped, never phantom-funded - and **ca05 "funded" from 00a7
   (W43N23's Spawn3, d 130)**: rerouted AROUND the marked corridor onto a
   spawn that can build its bodies. "Funded at db0f" did not occur.
2. **CONFIRMED beyond the target**: forgone mining 40.28 -> **0.00**
   against an honest capacity of 100 (six sources adjudicated out, priced
   at zero). The clamp note is doing its job: raw mining 117.29 e/t runs
   17.29 ABOVE funded capacity - embargoed incumbents keep their routes
   (doctrine) while the plan claims only what it funds. Controller
   delivery rose 19.86 -> 27.36 pts/t. E6 deferred ops 4 -> 1; cd8e
   heldFrac 1.00 -> 0.26, buffer 3321 -> 2761.
3. **CONFIRMED on the allocation**: W43N24 controller 28 -> 20.63
   (predicted ~21), fielded WORK 28 -> 21 and shrinking. dryShare 0.605
   NOT yet down (meter spans 4327t of mostly pre-deploy starvation; the
   oversized fleet must age out) - converges over the next generation or
   it is a new finding.
4. **INCONCLUSIVE - transition window**: F1 inverted 0.82x -> 1.39x on a
   684t post-reset ring while the admission set changed under it (bodies
   bought for sources that then flipped verdict; off-plan incumbents).
   The gauge measured the transition, as the X5 deploy caveat predicts.
   Real signal inside it: ca05's first rerouted body 2200e dead at 204t
   (remote churn) - the corridor kill-tax is real, R1 already prints it
   13x under-priced. If ca05 churns again next window, the fix is the
   INVADER TAX calibration, not the reroute.
5. **RESOLVED BETTER THAN PREDICTED**: the stale W45N23 reservation
   lapsed (reservedUntil gone from intel) and the corp now maintains it
   CORRECTLY - ca05 is funded again via the reroute, so the 2.10 e/t buys
   uplift for a worked source instead of nothing.

P12 held room-matched (relay 20 >= published 15, no phantom fault). P1
prints 6 flips - the embargo transitions themselves, now named. E4
worsened (bank slope +25.26 e/t, 827k above reserve) - the standing
spend-path complaint, unchanged in kind, larger in degree while
construction pool drains; still the doctrine's next target after L1.

**Cycle verdict: FIXED, predictions confirmed (1-3, 5), one gauge
inconclusive by construction (4).** The plan and the runtime read the same
danger lens; disagreement is now a stamped verdict, not a silent 30 e/t.
Named for next cycle, in order: L1 remainder (backlog drain term +
scavenge sizing - drain 3.03 vs decay 14 e/t), R1 raid-tax calibration
(ca05 churn watch), E4 spend path (bank slope +25).

## Audit cycle t72940325 -> t72941602 (2026-08-11): the in-flight-body hole - one lens bug, three corps, 26% of spawn spend

**Expansion status first (owner asked):** W43N24 leveled RCL 2 -> 3
mid-window (~11.8 e/t into the new controller since the embargo fix); GCL
32 at 96.3% toward 33; the W52N54 corps are dormant registry ghosts (0
creeps, no sizing), not an active expansion.

**The embargo fix holds in its first clean window (1277t):** forgone 0.00
(vs 40.28), heldFrac decoration 0.00 - no pile-gated miners anywhere, E6
0 of 11 deferred, pile decay halved 23.97 -> 12.33 (standing piles 16.5 ->
7.7), plan flap 1, bank slope +25 -> +4.96, controller 25.72 pts/t
sustained (vs 19.86 pre-fix), P7 1.71x the wartime floor, X1 dry WORK 0.

**The new top forces:** L1 19.19 e/t named (top line), but the sharper
signals were R1 26.60x the priced raid tax with "remote churn bodies
11.01 e/t" and X5's flag: `W45N23-harvest-ca05 2200e@36t - FAST RESPAWN
(<60t = double-order/loop)`.

**Attribution (ring receipts, then falsification, then the seam):**
ca05's re-funded corp bought ~12 miners + 2 haulers (~12k energy) in
~1250t for a target-1 source - including FOUR miner purchases in four
consecutive ticks across four different spawns (t72940889-892), and two
2200e haulers 36t apart against a 132t build time. First hypothesis
(spawning creeps don't staff) FALSIFIED at the source: staffsPost's
undefined-ttl rule already counts them. The real seam is one lens bug in
three places: **fleet-accounting demand gates read a spawning body's
ACTIVE parts, which are zero while assembling** -

1. HarvestCorp.runtUpgradeDemand read getActiveCreeps() (excludes
   spawning outright): an in-flight upsize never suppressed re-orders -
   every free spawn re-sold it ("recycled why: runt-upsize 59%").
2. CarryCorp.staffing() counted the spawning hauler toward COUNT but
   summed CARRY via getActiveBodyparts = 0: the carry gate stayed unmet
   for the whole build.
3. UpgradingCorp.countStaffing: same shape in WORK - the live W43N24
   fleet fielded 7 upgraders against targetCount 3.

The ring's ~200t-spaced "scale" purchases between bursts are the REAL
kill cadence (W44N23 raidDebt 49.7k -> 77.2k this window) - that half is
R1's under-priced tax, gated by its own >=10-fiscal-window swap rule,
untouched this cycle. The corp self-converged once bodies landed
(staffing 1/1, gate clear, last ~700t of ring quiet) - the churn is a
TRANSITION amplifier, firing on every re-funding, kill replacement, and
upsize; X5 books it at 0.26 of spawn spend.

**Fix (red-first, three tests in the incident's exact shapes):** demand
lenses now price a spawning body by its BODY DEFINITION - "a body in the
pipe is the freshest possible incumbent" (staffsPost's own doctrine,
extended to the part-sum side). HarvestCorp gains
getMinerCreepsIncludingSpawning() for the runt-upgrade path with
spawning-aware WORK counts; CarryCorp.staffing() and
UpgradingCorp.countStaffing() sum body parts for spawning creeps.
Work-driving paths keep excluding spawning creeps (they cannot act).

**Predictions for the next capture:** (1) X5 churn share falls from 0.26
toward its ~0.1 baseline with NO "FAST RESPAWN" flags; (2) F1's
unbudgeted share (0.408 p/t, 48%) shrinks by the multiplier's share -
kill replacements remain; (3) "runt-upsize" recycle share collapses from
59%; (4) W43N24 upgrader count converges 7 -> targetCount as bodies
expire; (5) R1 drops toward the true kill tax (the ~200t cadence
survives, the 2-4x amplification does not).

## Audit cycle t72941602 -> t72943612 (2026-08-12): verification split by a mid-window deploy; the border-dancer flap storm

**Verification of the in-flight-body fix (deployed mid-window, so the ring
mixes both worlds):** the <60t FAST RESPAWN signature is GONE (worst churn
ca05 1900e@186t - a walk-length life, not a double-order), and absolute
runt-upsize recycling HALVED (~1.20 -> ~0.68 e/t; its share of recycles
rose to 81% only because other recycle classes fell more). The
t72943241/61 hauler pair 20t apart almost certainly PRE-dates the deploy
landing. W43N24 upgraders 7 -> 5, converging on target 3 (prediction 4 on
track), its allocation resized 20.6 -> 10.7. VERDICT: mechanism-confirmed
on the signature, magnitude needs the next clean window (X5 0.29 is
mixed-window).

**The embargo fix's second clean window:** forgone 0.00 held, E4's slope
went NEGATIVE (-1.26/t - the first storage drawdown in weeks), plan flap
1, P12 valve holds.

**The corridor kill story sharpened, and the defense chain WON a raid on
camera:** kills 83% of tombstone energy, 39% in intel-hostile rooms (was
20%), W44N23 24%. But the ring shows the system working end-to-end at
W44N23: guard meter armed a full window early (debt 77k >= 65k floor,
stamped t72941602), four 520e guards massed ~1000t before the raid,
raid sighted t72943108, room read CLEAR one tick later. What remains
invisible: whether guards were AT POST for the kills that still happened
(the "covered" stamp records targeting only) - the guard OUTCOME stamp is
the named instrument for a future cycle. R1 (27x) stays a gauge: its
constant-swap was retired by the standing-guard tax design; what the 27x
now measures is the LOSS side (attrition), which enters no admission term
- pricing corridor attrition at admission is a design question to take up
with the guard stamps in hand.

**New finding, fixed: the W40N43 border-dancer flap storm.** A hostile
dancing on a room border read hostile/clear on alternating ticks; mark and
unmark fired EVERY tick for ~90 ticks - ~60 blackbox rows (15% of the
400-row ring), and hostileRooms() flickered tick to tick under the
admission's routeIsDangerous lens (a flap on a ROUTE room would flap
funding verdicts). Fix: UNMARK_DWELL = 50 - a FRESH mark holds through
clear sightings for 50 ticks (the dancer's marks are always fresh, so the
flap collapses ~50x); marks older than the dwell lift on first clear
exactly as before, and legacy no-stamp entries lift immediately. Pinned in
roomDiscovery.test.ts (two new tests; three v33 retention tests hop the
dwell - their intent is retention, not unmark timing). Ordering note for
honesty: the behavioral red here is the measured storm itself; the
pre-fix test run only demonstrated compile-red.

**Standing debt honestly named (third cycle on the list):** L1 remains the
top line (pile decay 10.45 improving from 23.97; scavenge still collects
20% vs the engine's 80%) - the backlog drain term / scavenge sizing has
now been named three cycles running without an attempt. It is the next
cycle's work item unless a live incident preempts.

**Predictions for the next capture:** (1) zero mark/unmark flap pairs
under 50t anywhere in the ring; (2) X5 falls below 0.15 in a clean window
with no FAST RESPAWN flags; (3) ca05 churn cadence unchanged (~200t -
kills, not double-orders; its true net stays ~2 e/t until attrition is
priced or the corridor is held); (4) blackbox ring depth grows (less spam
= longer effective window).

## Audit cycle t72943612 -> t72950630 (2026-08-12): the drain law that paid to lose - decay dominance lands on the third naming

**Verification first (7018t window, 2245t ring - the longest clean sample
yet):**

- **Dwell fix: CONFIRMED.** The blackbox ring's effective depth grew 1488
  -> 2245t (less spam per prediction 4); no fast-respawn or flap-storm
  signatures in the ring.
- **In-flight-body fix: CONFIRMED at magnitude on the home side.** Home
  churn 0% (X5's home/remote split) - the multiplier is dead. X5 0.28
  overall is now ~100% remote invader/revoke noise (12.49 e/t remote churn
  bodies): the corridor kill loop, a different phenomenon, correctly
  separated. ca05's worst body died at 338t - kill cadence, no
  double-orders. Prediction 2's "<0.15" was written against the mixed
  gauge and is superseded by the split read.
- **Embargo fix: third window holding** (forgone re-grew to 9.15 as the
  solver sheds sources toward a full storage - the absorb law, not the
  embargo class; capacity honestly 80 with 8 funded).

**The strategic read the account now makes loud:** storage 927k (+3.80/t,
E4), controller delivering 23.54 of 27.34 sustainable, W43N23 capped at
its RCL8 15/t, the solver de-funding sources for want of sinks (P1: cd94,
cbd8 -> unrouted). The colony is DEMAND-constrained at GCL 32 with 2 of 32
room slots used - the E4 surplus is expansion capex with no campaign
consuming it. Named as a strategy item for the owner: the next claim is
the spend path.

**The cycle's fix - L1's top line on its third naming:** the scavenge
half-life law (amount/2 over effectiveLife) drains at rate/decay =
1000/(2*effectiveLife) ~ 0.36-0.42 at EVERY pile size - structurally
unable to beat the engine's ceil(amount/1000) decay. Four consecutive
windows measured the outcome: 18/20/24/24% collected, recovery net +0.31
e/t against 8.06 e/t of standing pile decay - bodies paid to lose the
race. `scavengeRate` now takes max(half-life, SCAVENGE_DECAY_DOMINANCE x
ceil(amount/1000)) with dominance 2 (recover ~2/3), still capped by
MAX_SCAVENGE_RATE (the retired 150-tick burst's t72447104 displacement
asked 20 e/t; dominance asks 2-10). A stock the bigger ask makes
unprofitable loses funding honestly - a write-off beats a paid loss. The
micro-route floor's cull role is subsumed (smallest fundable ask is now
2 e/t) and its test pins the new contract.

**Predictions for the next capture:** (1) SCAV collection share 24% ->
>=50% on funded stocks; (2) L1's pile-decay line falls toward the
ceil-FLOOR share (~3.6 e/t of small unfunded piles); (3) scavenge routes
leave P2's micro-route list; (4) recovery net rises from +0.31 e/t; (5)
watch item: scavenger spawn spend may triple (0.24 -> ~0.7 p/t slack
exists) - the trade is priced, not accidental.

**Addendum, the first cut went red on the canary (recorded per the
failed-hypothesis doctrine):** unconditional dominance failed
`runt-economy` - in a 300-cap cold-start world a 1901e mouth pile's 4 e/t
ask displaced the miner upsize from the spawn's tiny bank ("never
afforded", gate `clear`, 12m run, 0 passing) - the t72447104 displacement
class in miniature, caught by exactly the canary that class burned before.
The law is therefore MATURITY-GATED (same lens as the drain deadband:
storage standing): bootstrap keeps the waste-tolerant half-life law - the
ramp spends every spare unit on the escape - and mature colonies price
dominance. Both branches pinned in scavenge.test.ts.

## Audit cycle t72950630 -> t72958467 (2026-08-12): dominance verified on true stocks, and its regression attributed to the SCAN - mouths leave scavenge

**The window read like a disaster and attributed like a scope bug.**
Forgone mining exploded to 39.09 e/t (heldFrac 26.81 - three mouths gated:
cd8d 100% of window at buffered 4213, ca05 86%, cd94 41%), the scavenge
body bill went 1.55 -> 7.08 e/t, recovery net FLIPPED to -4.21 e/t
(prediction 4 failed in the worst direction), and cd8d's haul fractured
into 8 micro-routes (P2 16 of 26).

**But the SAME window confirmed the rate law itself:** SCAV collection
24% -> 67% (prediction 1, exactly the designed ~2/3), scavengers demob
cleanly when their pile drains ("scavenge-drained" 41% of recycles - a
new, healthy class), and stocks actually cleared (37-38: 87e left).

**The attribution:** the stocks dominance was draining ARE SOURCE MOUTHS -
W43N24-30-20 is source (31,21)'s mouth (container summed in by the
one-summed-stock rule, owned rooms includeContainers=true), 37-38 the
other. Since the staged-mouth drain term (2026-08-07) a mouth pile is
priced into the MINING corp's own routes and gated by E6 - a scavenge
stock there is DOUBLE COVERAGE. The half-life law kept that overlap
negligible (0.5-1 e/t trickles); dominance weaponized it into a 6 e/t
fight at each mouth. The 2026-07-19 container-siphon ruling fixed this
for REMOTE scans only; W43N24 becoming OWNED re-exposed it.

**Fix: excludeSourceMouths (range 2, both scans)** - mirrors
excludeControllerBucket; mouths are the mining corps' territory, orphan
piles (tombstones mid-route, port spills, core drops) remain scavenge's.
Red-first pure-function tests; full gate green (canary included).

**Predictions for the next capture:** (1) E6 deferrals collapse (mouth
scavengers gone, mining routes own their piles); (2) forgone falls back
toward ~10; (3) recovery net returns positive with the fleet bill under
2 e/t; (4) SCAV keeps >=50% collection on the (now truly orphan) stocks;
(5) cd8d's micro-route fracture heals (P2 count falls).

## Owner-directed cycle (2026-08-12, "the new rooms can take energy though"): the bankfeed executor

**The direction:** W43N23 banks ~900k it cannot spend (RCL8 caps its
controller at 15/t; the solver sheds sources for want of sinks) while
W43N24's UNCAPPED RCL3 controller starves at dryShare 0.6-0.78 on
local-only supply. The t72935339 refusal (bank may not feed a
storage-less room's controller) was honesty about a missing EXECUTOR -
publishRoster skipped bank routes, so the plan had claimed a 14 e/t flow
nothing fielded. The owner's point: make the flow real, don't refuse it.

**The executor, four seams (each red-first):**
1. CorpPlanner: the refusal lifts - bank reaches every controller
   (in-room via depot movers as always; out-of-room via the new corp).
2. commissionPlan: OUT-OF-ROOM bank routes commission a standalone
   bankfeed carry corp, homed in the SINK's room via consumes.at (so
   legacyNodeId and deliverToController key off where it delivers);
   in-room legs stay uncommissioned (feeder/tender territory).
3. publishRoster: out-of-room bank edges publish (they are now a real
   fleet F1/F2 must see); in-room stay skipped.
4. CarryCorp: a bank- route resolves pickup to the bank room's STORAGE
   (new branch; the id previously fell through getObjectById and held
   forever) and collects by structure withdraw; carryKind.demandGroup
   births bank units started (no producer to wait for). "bank-dry"
   joins DepartReason.

**Canary flake found and recorded during the gate:** runt-economy went
red twice on the new build and once (earlier today) on the dominance
cut - but the pre-change build drew green, the THIRD new-build draw drew
green, and every verdict tracks a 4m/12m host mode exactly (fast=green,
slow=red, plateau shape identical to the documented 2026-08-03 incident;
the diff is provably unreachable in that storage-less world - every new
branch gates on isBankSourceId). VERDICT: pre-existing environment-
correlated flake, my diff acquitted by draws 3+4; the slow-mode plateau
is a TEST-ESTATE work item (spec 61 class): harden the 300-cap escape
or pin the mode. Re-read re5's dominance attribution with this in mind:
the maturity gate stays (the mouth-fight was real in prod), but the
canary red that motivated it may have been this flake.

**Predictions for the post-deploy capture:** (1) flow haulers[] carries a
bank-W43N23 -> controller-cd8c edge; (2) a bankfeed carry corp fields
(hauling-W43N24-hauling-3N23, creeps >= 1); (3) W43N24's controller
allocation rises toward its ~28 demand and dryShare falls from 0.776;
(4) E4's slope goes NEGATIVE (the bank finally drains); (5) colony
controller delivery rises above 27 pts/t.

### Bankfeed partial verification t72959638 (+~540t post-deploy): the plan half is LIVE

Predictions 1-2 confirmed within one solve of the deploy, larger than
predicted: the solver routes **bank-W43N23 -> controller-cd8c at 47 e/t**
(sink demand/allocated jumped 28/20.6 -> 77/77) plus a second out-of-room
leg bank -> spawn-db0f at 10 e/t - the exact "executor-less, F1
pollution" edge named at t72936194, now commissioned. The bankfeed corp
stands (`hauling-W43N24-hauling-3N23`, 2 routes, carryNeeded 125, exit
"asking") with its fleet in the spawn pipeline. In-room bank legs stay
uncommissioned (feeder/tender) - the split held. ENERGY-side verification
(deliveries, dryShare falling from the post-reset 1.0, E4 slope negative,
delivery > 27 pts/t) lands next capture once the ~125-carry fleet fields
and walks. Watch items: the fleet's spawn bill is priced (the routes are
plan routes now) but will read as a spend spike against P4's 0.33x
headroom; and the first fleet generation is the in-flight-body fix's
first big-body test at scale.

## Audit cycle t72958467 -> t72966674 (2026-08-12/13): the RCL4 depot transition chokes the colony; the walked bank fill primes it

**Bankfeed energy-side verification, overtaken by events:** W43N24 leveled
RCL 3 -> 4 mid-window (~15 e/t of bank-funded upgrading - the bankfeed
line's work), built its storage, and the plan FLIPPED it to depot class:
its controller demand went to 0 (priced off its OWN empty bank via
bankFedControllerRate), the bank->cd8c 47 e/t edge died with the founding
local-exception, cd8e re-routed home, and the colony re-centralized into
W43N23's nearly-full storage (948k, ullage ~52k -> absorb 35.9). Result:
12 sources "no-sink", funded capacity 40, delivery 15.85 pts/t, pile
decay 17.57 (defunded incumbents' output rotting), S3 stalling on a
porttender purchase. Two captures 73t apart proved the runtime is ahead
of the plan: W43N24's storage gained 0 -> 400 from off-plan hauler
redirects while remaining INVISIBLE to the plan (the analysis refresh had
not yet registered the just-completed structure as a sink).

**The transition is self-resolving but trickle-slow, and the missing edge
was structural:** the terminal was the ONLY cross-hub bank->storage
executor (spec 58 rule 2), so a lender hub could not prime a new depot the
bankfeed corp can walk to. Fix: `canWalkBankFill` - bank -> foreign
storage WITHOUT terminals, same anti-pump (never its own store, parse-
keyed) and lender->borrower rules as canTransfer, priced as an ORDINARY
walked route (real carry, no engine fee), and RESIDUAL-ONLY: it joins the
final value pass, never the storage pre-fill, so every consumer -
a storage-less room's controller above all - outranks foreign priming.
Retired pins updated deliberately: "no bank fills any store without a
terminal" (crossHubTransfer) described the executor-less world; fixtures
using the stylized "bank-home" id (whose parsed room was phantom) moved
to the real bank-<room> shape the parse-keyed anti-pump reads.

**Named, not fixed:** (1) S3 porttender stall (head porttender@200 vs
bank 12900 AFFORDABLE+IDLE) - a wedge on a new role class, needs its own
diagnosis; (2) the analysis-refresh lag for just-completed depots (the
sink joined the world minutes after the structure did) - acceptable once
the walked fill primes at plan speed, worth a completion-triggered
refresh if it recurs; (3) L1 remains top-line by e/t (17.57 pile decay is
mostly the defunded-incumbent class this transition created - re-read
after the sink capacity relaxes).

**Predictions for the next capture:** (1) a bank-W43N23 -> W43N24-storage
edge with real carry once the sink registers; (2) W43N24 storage fills at
plan speed and cd8c's demand wakes as its bank grows; (3) W43N23 E4 slope
NEGATIVE; (4) the no-sink set shrinks as W43N24's ullage joins colony
sink capacity; (5) delivery recovers toward 24+ pts/t.

## Expansion staged (owner 2026-08-13: "Seems like we could be claiming more rooms"): W43N21 campaign

**The pick, from data:** two-source candidates within 2 rooms were W43N21,
W41N21, W44N21, W45N22. W43N21 wins on measured economics (cd98/cd99
funded for weeks at net 6.3-8.6, the best-known books of any candidate),
standing reservation, and the contiguous southern spine
(W43N23 -> W43N22 -> W43N21); owning it deletes its reserver bill
(~2.1 e/t) and its invader-raid class outright (owned rooms farm no
raids). Its known risks are the machinery's job: the standing invader
structure is the coreBuster kind's exact case, and raids en route are the
guard meter's. The unknown-terrain candidates (W41N21/W44N21/W45N22, no
raid history but no books either) stay on the list for claims 4+.

**The staging, per the W43N24 precedent (the sanctioned memory-API
lever):** spawnPos (15,27) computed OFFLINE with the bot's own picker
(pickSpawnSpot over live terrain + intel anchors: sources (5,23)/(13,38),
controller (28,19) - open plains at their centroid).
Memory.expansion = {W43N21, W43N21-15-27, (15,27), t72967162} written and
confirmed; **the claimer (650e) was bought at t72967163 - ONE tick after
staging** - and claim-W43N21-claim stands with 1 creep walking. This claim
is the first to land on the full organism rails: the bankfeed corp and
the walked bank fill mean the founding funnel draws the ~950k W43N23 bank
from day one instead of local trickles.

**Milestones to verify next capture (the W43N24 timeline):** claim lands
(~t+300), owned-room trigger forces the replan, founding site at (15,27),
siteProgress rising on bank-funded tankers, spawn stands, campaign
self-closes. Watch items: the invader core's effect on the claimer's
approach (the buster may need to fire first) and the W43N22 transit
(raidDebt ~100k, a raid due).

## Audit cycle t72936194 -> t72968647 (2026-08-13): the frozen graph, the RCL-8 sink collapse, and the squatter

**Window**: 32,453t - one full handicap-sweep cycle (0->20%, cycle 4; both
endpoints ~0-1%, so the endpoint plan diff is handicap-controlled). W43N23
hit **RCL 8** mid-window; the sweep opened cycle 5 at t72967500.

**All five predictions from the depot-transition cycle FALSIFIED, one
attribution**: no bank->W43N24-storage edge, storage 0 at capture (local
trickle only), E4 slope +3.52, the no-sink set GREW to 10 flips, delivery
20.68. Every miss traces to the same root: **the node graph is frozen**. The
full terrain analysis runs only at zero nodes; re-analysis at colony scale is
held behind `Memory.analysisGo` (the 2026-08-11 crash-loop hold, still null);
every deploy wipes the heap territory cache, so `refreshNodeResourcesFromCache`
no-oped and NOTHING born after the last full analysis could ever join the
graph. Measured cost: W43N24's storage (completed ~32k ticks prior) had no
node resource -> `discoverSinks` emitted no sink -> at RCL 8 (controller
hard-capped 15 e/t) colony sink capacity collapsed -> P1 defunded 10 sources
(140->40 e/t funded capacity, verdicts `no-sink`/`unrouted`) -> standing
miners rotted their mouths at **12.98 e/t** (L1 top line; H3 cd8d 4813->7452
with zero drain). The ENERGY ACCOUNT carried the signature honestly:
residual -58.49 e/t (spend measured against a 4-source revenue line while
~14 sources' corps kept working), spawn 47.26 vs 9.46 budget.

**The squatter (W43N21)**: the claim landed (rcl 1) but the campaign wedged
1,400+ ticks before this audit read the room objects: the "standing invader
structure" in the pick's risk list is actually **another player's derelict
spawn** ("MainSpan", user EZRO, GCL ~3.4, zero creeps, full store - a
respawn gone idle; their RCL-1 controller downgraded away, which is what made
the room claimable). Engine fact worth pinning: `checkControllerAvailability`
counts ALL owners' spawns+sites against the RCL structure limit, so at RCL 1
EZRO's spawn consumes the room's ONLY spawn slot and
`createConstructionSite` returns ERR_RCL_NOT_ENOUGH forever - the code the
campaign deliberately swallowed as "controller still leveling". (The road on
(15,27) was a red herring: engine `checkConstructionSite` ignores
road/rampart when placing other types. Reading the engine before fixing
saved a wrong fallback patch.)

**Landed (all red-first; unit 2676 green, trio green)**:
1. `attachOwnedRoomHubResources` (IncrementalAnalysis): owned-room HUB
   structures - storage, spawns, owned controller - join/prune from
   GUARANTEED vision, no territories needed; wired into the refresh path both
   with and without the analysis cache, and into post-analysis
   reconciliation (supersedes attachOwnedSpawnsToNodes, same precedent).
2. `hub-resources` plan trigger (planTriggers): a hub resource joining or
   leaving the persisted graph forces a replan - without it the 5000-tick
   cadence sits on the attach.
3. coreBuster EVICTION class: rooms WE OWN with hostile structures join the
   KILL phase (closest-home dedup, lexicographic tie-break); in owned rooms
   the buster attacks core ?? hostile spawn ?? any hostile structure - in
   neutral rooms it stays core-only (another player's remote infra is not
   this corp's war to start).
4. Campaign occupied-slot stamp (ExpansionCampaign): ERR_RCL_NOT_ENOUGH
   with hostile spawns present logs `founding blocked ... eviction required`
   instead of silence.
5. E4 reads the BANK room (largest storage), not rooms[0] - a storage-less
   claim sorting first had blinded the idle-capital gauge to 921,612 idle
   (it read "storage null ... at/near target"). Honest verdict now: FAIL,
   equilibrium past the absorbable knee.

**Held deliberately**: `Memory.analysisGo` stays null - the crash-loop hold
stands until the batch step is instrumented (heap/CPU stamps). DEBT: with
territories still frozen, NEW remote sources/minerals stay invisible to the
graph; the hub attacher covers owned-room hub structures only.

**Predictions for the next capture** (deploy + ~200-2000t):
1. flow sinks[] gains `storage-6a7cc9a6...` (W43N24 depot, ~1M ullage) and a
   controller sink for W43N21; a `hub-resources:N->M` forced replan stamps
   within ~50t of deploy.
2. The defunded set SHRINKS: >=6 of the 10 flipped sources re-fund (W43N24
   locals against the depot first); H3's cd8d mouth stops growing.
3. A buster walks W43N23->W43N21 and EZRO's spawn (5000 hits, undefended)
   falls within ~600t of deploy; the founding site places on the next
   campaign pass; `[Expansion] founding spawn site placed` logs. Fuses:
   campaign timeout t72987162, controller downgrade ~t72987463 - both clear
   if eviction lands inside ~15k ticks.
4. L1 pile decay falls from 12.98 toward <=5 e/t over the next full window
   as re-funded routes drain the mouths.
5. E4 stays FAIL short-term (re-funded income rises before spends ramp);
   the honest gauge now watches the founding + depot fill absorb it.

**Live verification (same session, ~t72969700, ~550t after deploy):**
prediction 1 CONFIRMED - `storage-...33a95d` (W43N24 depot) and W43N21's
controller (`dbcd97`, level 1, priority 80, 8 e/t allocated) both in the
live plan's sinks; the depot absorbs 214.7 e/t of its 460 ullage demand.
Prediction 2 EXCEEDED - not >=6 of 10 but **19 sources funded** (was 4):
every flipped source re-funded plus five more (d017, cedc, d019, d01f,
cee2, cee0, cd90, cd92, cd98, cd94, cd99, cd8d, cd8e, cd8a, cbd5, cbd8,
ca05, c9f8, c9f9), verdict census 19 funded / 15 prospect / 4 over-budget,
**zero no-sink, zero unrouted**. Prediction 3 CONFIRMED in the kill half -
`buster-Buster-72969430` spawned ~280t after deploy, walked
W43N23->W43N22->W43N21, and EZRO's spawn is GONE from the room objects;
W43N21's first re-funded miner (`miner-t-cd98-72969554`) walking in.
Grid regression: the five adjacent cells (exp-t5-claimer, exp-t5-founding-
funnels, def-t5-core-buster, cons-t4-storage-completes,
cons-rcl8-full-bank-contracts-mining) all [P] on the shipped bundle.
Cache survey (question-the-mechanism): the three CommissionHost lenses and
the governor level are stride-keyed self-rebuilding memos - deploy-safe;
multiRoomAnalysisCache was the ONLY event-built hard-prerequisite cache in
execution/economy. L1/pile-decay trend and the founding funnel remain
next-window business (predictions 4-5 stand).

## Audit cycle t72968647 -> t72972253 (2026-08-13): the ramp, and the stronghold grinder

**Window**: 3,606t - the REOPENED economy's first ramp (19 sources funded,
fleet 31->52 creeps, plan prices 1.246 p/t vs 0.294 built). Founding site
CONFIRMED placed and 63% built (siteProgress 9476/15000, ~4.2 e/t funnel) -
cycle-1 prediction 3 fully lands. L1 pile decay 20.47 e/t (top line) is the
ramp's shape, not a freeze: 8 of 14 mouths gated buffer-full while their
scale-tier haulers (~740 CARRY parts of long-route fleet) queue at the
funding pace; spend 55 e/t continuous, spawn idle 90% attributed to the
FUNDING ledger, tender duty 0.014 (heartbeat fine - extensions full at
capture; the throttle is the pacer, not the refill). VERDICT: bounded
transient (~30k one-time rot), predicted to clear in ~1-2k ticks - next
window L1 is the check. W43N24 depot dry + controller frozen 2 cycles traces
to the same ramp: the walked-fill fleet (bank->storage-33a95d, 140 e/t, 269
CARRY) is the biggest unbuilt block, and Spawn4 burns every arriving unit on
the ca05 grinder (below).

**THE STRONGHOLD GRINDER (fixed this cycle, mechanism proven live)**:
mining-W45N23-harvest-ca05 bought ~10 miners at 650e in ~1,700t (ring
receipts, ~150t cadence), zero alive at capture, staffing stamp 0/1. The
route decision ran through THREE lenses: (1) the transit-embargo gate priced
the corp's ANCHOR route - W43N23->W45N23 = [W44N23, W45N23], all safe (live
findRoute via console, t72972447) - and approved; (2) the GLOBAL SPAWN POOL
birthed every miner at W43N24 (nearest free spawn, ring rows); (3) the
walker followed findRoute(W43N24, W45N23) = [W44N24, W45N24, W45N23] -
straight through TWO live-marked rooms (hostileUntil 72973428/72973735,
hostileStructureCount 4 each: invader-stronghold pattern, whose squads also
explain the home-room kill share - 7,145e of 18,188e killed cargo in W43N23,
91% of kills in intel-"safe" rooms). Each dying miner refreshed the marks
its successor's gate never read.

**Fix (ONE lens)**: `safeRouteRooms` in RoomDiscovery - findRoute with
marked TRANSIT rooms priced Infinity (endpoints exempt: a hostile endpoint
is the corp's own funding decision), mark-free corridor verified, null when
none exists. `routeIsDangerous` now means UNAVOIDABLY dangerous (endpoint
marked, or no hostile-free corridor) - a workable detour HEALS the route
instead of embargoing it. `travelTo` steers cross-room legs along the same
corridor room-by-room (the buster's own travel pattern; travelToLane
inherits); no marks / no safe corridor / final leg = bit-identical naive
behavior, so military corps keep entering danger deliberately. The
transit-embargo stamp now NAMES the blocking rooms (`blocked`). Red-first:
roomDiscovery 36 green, movement 41 green; full gate green (unit 2686 +
trio); def-t3/def-t5 cells [P].

**Pre-existing regression, acquitted from this change**:
plan-t5-remote-pipeline red (`always:"extensions refill before the draining
spawn finishes"`, fail @400-485/700t) IDENTICALLY on pre-change source -
an incident against the deployed build (baseline still says pass), owned by
a future cycle; timing variance suggests flake-class, multi-draw before
diagnosis.

**Predictions for the next capture** (~2,000t+ post-deploy):
1. ca05's grinder STOPS: miner arrivals via the southern corridor, staffing
   1/1, no 650e receipt train (or, if the pool births at W43N23, same). X5
   remote share falls from 13%.
2. Scale haulers complete; L1 falls from 20.47 toward <=8; E6 deferred
   mouths drain (cd99/d01f first - biggest buffers).
3. W43N24 storage begins holding energy (walked fill lands as the trunk
   fleet builds); cd8c controller demand wakes; its rclProgress moves off
   27341.
4. F1 converges toward 1.0 as the ramp completes (plan 1.246 vs built
   0.294 was the ramp reading).
5. Founding spawn STANDS (~5,500 progress remained at ~4.2 e/t => ~1,300t);
   campaign self-closes; W43N21 bootstrap begins.

## Owner directive (2026-08-13, "We have like a million in the bank. We can fund new rooms at like 100 e/t instead of 4"): the founding pace

**The clamp, followed to its seam**: the W43N21 founding spawn site sat
nearer its room's own source (cd98/cd99) than any hub, and the room - owned
but storage-less - fell through the "hub-room sites stay bank-funded"
exemption into the SOURCE-LOCAL cluster class (spec 25 phase 3, charter:
road-building remotes). Its capacity became the local source's 10 e/t
(measured plan edges: cd98->site 10, cbd8->site ~1; measured delivery 4.2
e/t), while the drain law's own ceiling (bankSurplusRate = min(100,
surplus/1500) = 100 at the 979k bank) sat unread. Even un-clustered, the
POOLED horizon (wartime 1/3-life) prices a lone 15k site at ~8-20 e/t -
MAX_SURPLUS_DRAW's docblock names this exact class: "a max draw that binds
below the absorption ceiling counteracts the bot's whole purpose."

**Landed (red-first; unit 2692, trio, exp-t5 cells green; deployed)**:
1. `FOUNDING_COMPLETION_FRACTION = 1/10` (primitives): a founding spawn
   site - structureType "spawn" in a room with NO spawn sink - finishes in
   a tenth of the crew's life: fresh 15k at ~110 travel = ~117 e/t, the
   drain law's ceiling. Ordinary (2/3) and wartime (1/3) paces pinned
   unchanged; the 400-energy tail pin holds at every tier.
2. OWNED-room sites never source-cluster (the graph's controller-sink
   rooms) - clustering keeps its road-remote charter.
3. The ledger's durable `structureType` now travels on the flow sink
   (admission -> adapter), so founding detection and the 85-rung pricing
   are vision-free; founding sites leave the pool sum (no pro-rata
   dilution of other sites).
4. Crew side (ConstructionCorp remote branch) reads the same founding
   lens - one formula, both readers, per the buildPoolAbsorb pin.

**Predictions for the next capture**: (1) the W43N21 site's allocation
jumps ~10 -> ~40+ e/t (founding pace at its ~5k remaining) and the spawn
STANDS within ~200-400t of deploy; (2) post-spawn, the campaign closes and
the room's follow-on build-out batches into the wartime pool (~90+ e/t
sustained - the owner's number, carried by the existing horizon at real
backlogs); (3) G1 under-spending shrinks as the founding + refleeted ramp
draw together; E4 stays honest-FAIL until they do.

## Owner directive (2026-08-13, "There should be few corps more valuable than pumping up a new claim room"): the claim-pump rung

**Founding update first (live, t72979146)**: the founding SURGE delivered -
`Spawn5` STANDS at (15,27), a fifth spawn sink is in the plan, W43N21 swarms
(~15 construction tankers, 4 builders, 2 upgraders, miners on both sources,
2 guards), and the follow-on site builds at 25 e/t of planned legs. The
campaign closed on its own.

**The gap the directive names**: the fresh W43N21 controller priced 61.2 -
top of the ordinary controller band, but BELOW ordinary construction's 70,
so any remote road site in the empire outranked pumping the new claim's
RCL - and colony-wide wartime relegation would floor it to 42 exactly while
the colony builds elsewhere. RCL gates the new room's whole build-out
(extensions, tower, the storage itself), so the pump IS the unlock.

**Landed (red-first; unit 2693, trio green)**: `claimPumpController: 82` -
a new anchor in the sink ladder (goals.ts), between newSpawnSite 85 and
controllerMax 80. The lens (flowAdapter): an owned room with a controller
sink and NO storage, engaged only while a bank stands SOMEWHERE
(roomsWithStorage non-empty) - a claim presumes a colony pumping it, so a
bootstrap home's measured build-supersedes-upgrade doctrine (G6, the
RCL2->3 extension bottleneck) is untouched. Claim-pump rooms are EXEMPT
from wartime relegation (wartime keeps its charter for storage-backed
rooms). Invariants I5/I6 pin the rung's place at compile time; the DEFAULT
ladder pin and all four goal profiles extended in the same commit (the
90-vs-85 founding-incident door held - the rung landed with its chain).

**The full ladder now**: spawn 100 > new-spawn-site 85 > claim-pump
controller 82 > controller <=80 > construction 70 > controller floor 40 >
storage 1. CLAUDE.md's Economics line needs the same edit when this
merges.

**Predictions**: W43N21's controller re-prices 61.2 -> 82 on the next
solve; its allocation climbs (upgraders scale as the ladder routes it
flow); RCL 2 within ~1-2k ticks of deploy, RCL 3 (tower - the room can
then defend itself) inside the next audit window; W43N24 exits the lens
the moment its walked-fill bank makes bankFedControllerRate generous (its
storage stands, so it was never in it - the bank-fed law is its pump).

## Audit cycle t72972253 -> t72984055 (2026-08-13): the confetti fleet - the pool's capacity now sizes bodies

**Window**: 11,802t. The economy tripled: 19 funded sources / 190 e/t, 128
creeps, FIVE spawns (Spawn5 = W43N21's own), home spawns saturated
0.97-0.98, P4 at 0.96x ceiling, bank FULL at 1,000,000.

**Verified from cycles 1-2 + directives**: ca05 grinder STOPPED (no fast
respawns; remote churn 13% -> 9% of spend); F1 converged 0.24x -> 0.88x;
the healed route lens re-admitted five embargoed deep remotes
(embargoed->funded flips - the detour law working as designed); W43N21 hit
RCL 2 (21,660/45,000 - halfway to its tower) with the claim-pump rung live
at 82.0 and 7 sites building. The founding chain end-to-end: claim ->
eviction -> site -> spawn -> RCL 2, one session.

**Falsified, THIRD time, now attributed**: L1 pile decay rose again (12.98
-> 20.47 -> 31.16) and the W43N24 depot stayed dry (191e; its controller
frozen at 27,341 three cycles). Both are ONE mechanism, and the ring named
it: the plan routes 15 sources into the depot (out to dist 214, 60-88 CARRY
each), but body size was fixed at collect time from the ANCHOR room's
energyCapacity - so the whole expansion fleet, anchored at Spawn4 (1,300)
and Spawn5 (~550), was bought as CONFETTI: 300e 3-CARRY haulers, over and
over (cd8e's 8,000e mouth served by repeated 300e bodies), while the
saturated 12,900 home spawns built guards and reservers. 622 CARRY parts of
F2 gap that arithmetic never closes.

**Landed (red-first; unit 2694, trio green, multispawn-t7 x2 + spawnexec
cells [P]; deployed)**: `collectDemands` runs at the POOL's capacity
(SpawnDirector pass-1 computes max energyCapacityAvailable over eligible
rooms) - the global-pool doctrine (owner 2026-07-25: any spawn builds any
corp) extended to SIZING. minCost floors still let a small spawn min-scale
an urgent body; per-spawn affordability keeps purchases real; single-room
worlds are arithmetically unchanged (max = own capacity).

**Named, not fixed**: (1) P12 RUNTIME FAULT - home feeder relay 5.00 <
published 15.00, with the controllerFeeder countMismatch (claimed 3/counted
1, staffsPost family) alongside; the home score line sags (P7 0.80x of the
wartime floor). (2) The storage-FULL regime: 1M cap reached, absorb path
saturated - the spend paths (W43N21 pump, W43N24 depot chain, GCL 32 ->
33 at 10.5M remaining) are the cure, all now unblocked. (3) R1 raid tax
10x priced, 22 raidGuards standing - repricing waits for its 10-window
gate. (4) Admission keeps widening (reservers for W41N25/W43N25 bought
this window) at 0.96x P4 - watch for over-admission at the ceiling.

**Predictions**: (1) depot-route hauler receipts jump to the 1,500-2,500e
class; (2) L1 FALLS for the first time in four windows (target <=15 next
window) as real carry fields; (3) W43N24 storage holds real stock, cd8c
wakes, rclProgress moves off 27,341; (4) F2's 622p gap halves.

## Audit cycle t72984055 -> t72987947 (2026-08-13): the turn - and the spawn claim that starves the home floor

**Window**: 3,892t, one fleet-generation after the pool-capacity sizing fix.

**Verified (the confetti fix works)**: L1 FELL for the first time in four
windows (34.26 -> 29.22 named; pile decay 31.16 -> 28.25) with E6 deferrals
6/22 (was 7/23); F2's fleet gap 622p -> 542p (one generation in); the BANK
FELL for the first time (1,000,000 -> 973,116, slope -6.91/t - the spend
paths finally outrun income); **W43N21 hit RCL 3** (tower in its 6-site
batch, ETA ~5,787t) barely 4,000 ticks after RCL 2. P1 flap calm (2).
X5 13% (a W43N21 upgrader killed young at 204t - raids continue until the
tower stands). X1's 8.80 dry WORK is that same young-room transition: the
pump's 12-WORK fleet stands 70% dry while construction (21.3 absorb) and
the pump (11.4) over-subscribe the room's ~20 e/t local mining - it
resolves when the tower lands and the batch drains; watch, don't patch.

**The P12 fault, root-caused to its seam (two cycles standing, now exact)**:
the home controller sink (cd91) reads demand 15.0, priority 40 (wartime
floor rung), **allocated 0.0** - and the publisher faithfully writes
Memory.controllerAllocations.W43N23 = 0, so the feeder honestly falls to
its relay floor 5 (its planFlow stamp = 0 is CORRECT reading, not the
fault). The starvation is the SOLVER's: the five spawn sinks claim
5 x 19.7 = 98.5 e/t of fleet-maintenance pricing - the bank's entire 100
e/t surplus draw - and the wartime-relegated home floor loses to them,
while priority-1 storage still absorbs 124.8 (deposit-class routing).
Measured spend at the spawns is ~55-70 e/t: the claim over-states by
~30-40, and the over-claim starves the floor. Home stock drained 4,049 ->
2,749; P7 0.72x of the wartime floor 11.4.

**Named work item (next session)**: the controller FLOOR reserve must
survive the spawn sinks' maintenance claim - either the floor pre-pass
runs before/against the spawn claim, or spawnSinkDemand's ceiling stops
over-claiming past measured maintenance (the P12 over-routing note has
carried this number since t72773737). Touches CorpPlanner fill order -
fresh-context work, red-first from this capture (t72987947 committed).

**Cycle verdict**: verified (4 predictions) + blocker named with data.

## Audit cycle t72987947 -> t72991038 (2026-08-13): the phantom fault - the defect theory falsified, the instrument fixed

**Window**: 3,091t. The score line: P7 collapsed to 0.10x (home delivering
1.5 e/t), the bank re-filled to its 1M cap (slope +8.70) - and the cycle's
investigation FALSIFIED the cycle-4 defect theory. The home controller's
zero allocation is OWNER DESIGN, twice over: the plan's floor is
danger-gated to zero by the 2026-08-04 ruling ("we don't need it UNLESS the
controller is in danger of downgrading... Not the constant trickle"), and
wartime construction-primacy (2026-08-05) relegates the home band while
build-outs stand. The home upgrading fleet EOL'ing out under a zero
allocation is ONE VALVE working. The score returns when the batches drain,
and the score's FUTURE lives in the uncapped pump rooms (W43N21 at RCL 3,
its supply line filling: stock 0 -> 416, dry share 0.705 -> 0.495).

**The real defect was in the INSTRUMENT**: P12's "published" was a CORP
ECHO - it read the upgrading corp's sizing.planAllocated (15) as the
publish while Memory.controllerAllocations carried 0, printed a phantom
"published 15.00" and a phantom "RUNTIME FAULT" against a feeder that was
faithfully relaying the real zero, and sent two cycles hunting a ghost.
The two channels (commission echo vs publish) disagreeing IS a spec-38
phase-B seam finding of its own - now measurable.

**Landed (observability-only; unit 2694 green; deployed)**: core segment
v40 exports Memory.controllerAllocations verbatim; P12 reads the REAL
publish (echo as fallback) and NAMES the echo-vs-publish divergence in its
detail when the channels disagree.

**Also this window**: confetti fix keeps verifying (F2 0.13 frac, best
yet); L1 27.55 (flat); X6's first micro-fail is the pool-sizing change's
one visible cost (a 2c-route hauler bought at 8c - 15 parts over 1,680t,
negligible, now pinned by the gauge); c9f8/c9f9 re-funded as their
corridor cleared (the healed lens again). Fiscal FY4865-M09-M10 closed
(handicap 13-14%).

**Cycle verdict**: falsified (the cycle-4 solver-defect theory) +
instrumented (the gauge that misled). The spawn-claim honesty question
(98.5 claimed vs ~70 measured) remains open as a PRICING refinement, not
a starvation defect.

## Audit cycle t72991038 -> t73003513 (2026-08-14): the multi-home guard overlap - three corps, one target set, 10 bodies for 3 rooms

**Found (segment 4, three stamps side by side).** Every raidGuard corp in the
colony was guarding every armed room:

```
raidGuard-W43N23  creeps 3  parts 28  sizing {gate:"covered", targets:3, debts:{W43N25:99380, W44N22:78980, W44N23:65750}}
raidGuard-W43N24  creeps 3  parts 30  sizing {gate:"covered", targets:3, debts:{W43N25:99380, W44N22:78980, W44N23:65750}}
raidGuard-W43N21  creeps 4  parts 38  sizing {gate:"covered", targets:3, debts:{W43N25:99380, W44N22:78980, W44N23:65750}}
```

Three corps, the IDENTICAL three-room target set, each reading gate `covered`
under its own lens - so no corp was misbehaving by its own rule. **10 guards /
96 body parts standing for THREE armed rooms.** Colony account: defense 10.65
e/t against a 4.16 budget (2.56x, -6.49 U).

**The plan was never wrong.** `raidGuardKind.propose` already bound each room
to its NEAREST home and charged it once (flow `infraInputs.guardedRooms: 3`);
the runtime lens `guardTargetsFor(home)` is per-home and non-exclusive by
design, because its two BUDGET consumers (CommissionHost's `guardedRoomsLens`,
flowAdapter's `infraSpawnLoad`) fold it into a union - one guard priced per
armed room. Nothing narrowed it on the BEHAVIOUR side, so every home in range
fielded its own body. A pure fidelity gap: the price said 3, the runtime bought
10. The kind's own docblock predicted it ("the runtime would field two guards
there today... invisible in a single-colony world") - it became visible at
three home rooms.

**Why it cost more than its own line.** The colony is at its SPAWN THROUGHPUT
ceiling, and that is the binding constraint on everything downstream:

```
partsLedger  capacity 1.667  budget 1.349  spent 1.432  dry TRUE
P4           plan-implied 1.689 p/t vs 1.667 physical = 1.01x  (INFEASIBLE)
  of which   defense (guards) 96p = 0.064 p/t - 3.8% of the whole colony's throughput
```

The chain the ledger reads end to end: spawn throughput is dry -> the hauler
fleet is fielded 27-29% under plan (F1 haulers 1.007 vs 1.376 p/t; F2 1582p
fielded vs 2231p declared) -> 10 of 23 miner ops sit pile-gated (E6) with
31,422e on the ground (H1, hauler duty 0.83 - the haulers are BUSY, not idle)
-> piles decay 32.34 e/t (L1, the ledger's TOP LINE) and the gated miners
forgo 80.31 e/t of capacity (39%) -> the controller receives 9.84 e/t against
a 63.00 plan (P7 0.32x, 5% of capacity against a >=50% target).

Guards are not the top line. They are the cheapest *proven* claim on the line
that is throttling it: returning ~67 parts takes plan-implied to 1.644 p/t,
**below the 1.667 physical ceiling** - P4 flips from infeasible to feasible on
this fix alone.

**Landed (live-behaviour; unit 2713 green + trio; deployed).** One shared
binding rule, `corps/guardHoming.nearestGuardHome` (pure: nearest by room-linear
distance, lexicographic tie-break, out-of-range excluded), called by BOTH sides:
`raidGuardKind.propose` (price, replacing its inline copy - byte-identical, its
conformance stayed green) and `RaidGuardCorp.guardTargets` (behaviour, new).
The armed-room lens is untouched, so both union consumers keep their totals -
binding decides only WHICH home fields the body. No discoverable homes (harness,
no vision) keeps the unbound behaviour: an absent fact must never stand a guard
down.

**Also landed this window** (found by inspection while reading the same corps,
fixed red-first before the audit): the t72811290 double-buy class in raidGuard
and coreBuster. Their demand lenses counted only ACTIVE bodies, so a guard still
in the spawn was invisible and the demand re-armed for the whole ~30-tick build
while the global spawn pool bought another copy from each free spawn. Now on
`SpawnAnchoredCorp.staffingCensus` (counts the spawn pipe and recycling bodies;
unassigned livings discount the ask as wildcards, ReservationCorp's rule). Both
kinds carry staffing fixtures now - `UNSTAFFED_KINDS` 7 -> 5.

**Predictions for verification (~200t post-deploy):** guards 10 -> 3 and parts
96 -> ~29; the three corps' `targets` stamps sum to 3 instead of 3 each; defense
line 10.65 -> ~3.2 e/t (under its 4.16 budget); P4 1.01x -> ~0.99x (FAIL -> ok).
Downstream (piles, forgone mining, controller) should NOT be expected to move on
this fix alone - 0.045 p/t is 3% of the hauler shortfall, and the top line stays
L1.

**Cycle verdict**: fixed (guard overlap, measured) + named-with-data (the top
line: spawn throughput is the binding constraint; the hauler shortfall is
spec 39's unread `commission.fleet` seam, now with F1/F2/E6/H1 all pointing at
it from different sides). Confound on file: the spec-50 spawn-handicap sweep is
live (cycle 6, ramping 0->3% across this window).

### Gate attribution for the guard-homing deploy (same cycle): runt-economy is DRAW-VARIANT, not regressed

The trio's `runt-economy` came back red on the pending change and would have
blocked the deploy on a reading of the exit code alone. Attribution first
(the protocol's rule), and the answer was variance:

| build | draws | result |
|---|---|---|
| pre-change (6162cb4) | 2 | pass @ tick 440, pass @ tick 440 |
| post-change (ee7e862) | 3 | **fail @ tick 1200**, pass @ tick 440, pass @ tick 440 |

Identical code on both sides of the failure, so the cell is the variable, not
the diff. Two independent confirmations:

- **Direct measurement**: `grep -ci guard` over BOTH transcripts (the failing
  post-change draw and a passing pre-change draw) returns **0**. No guard corp,
  no guard demand, no guard console line - the changed code path never executed
  in that world. It cannot be causal.
- **Structural**: the cell stages ONE room (W0N0, RCL 2, no roomIntel), so
  `guardTargetsFor` returns `[]`; and with a single home room
  `nearestGuardHome` is the identity. The change is a provable no-op there.

The failing draw's own stamps name the real trajectory: `harvest-1353` at
**staffing 0** (its source never got a miner at all) while `harvest-70c9` sat
`buffer-full` (2075 over a 2000 threshold) - a cold-start race that lost, which
is exactly the class the cell's own diagnostic text describes. The pass path
early-exits at tick 440 (~3m); a losing draw runs the full 1200 (~11m), so the
runtime asymmetry is a tell, not a hang.

**Recorded as a property of the cell**: `runt-economy` is a cold-start race with
a binary outcome and should be read multi-draw (CLAUDE.md's multi-draw rule
applies to it), never as a single-draw gate.

**Guard-path verification** (the cell that actually fires the changed code):
`def-t4-raid-guard-holds-the-remote` re-run green - `T4 defense 1/1, total 1/1`,
all four assertions satisfied (guard fielded before the raid @1, raid lands
@150, **guard kills the invader inside the window @174**, meter resets @151).
It stages a single home, so the binding is identity there by construction -
which is the point: the fix must not disturb the one-home world it was not
written for.

**Deployed** to `master` t73003513+ with the gate green (unit 2713,
flow-handoff, storage-depot, def-t4; runt-economy acquitted above).

**The prediction, sharp to the room name** (computed by running the shipped
`nearestGuardHome` over the three measured homes and the three measured armed
rooms - so verification is falsifiable, not a vibe):

```
  W43N25 -> W43N24        raidGuard-W43N23  targets 1  (W44N23)
  W44N22 -> W43N21        raidGuard-W43N24  targets 1  (W43N25)
  W44N23 -> W43N23        raidGuard-W43N21  targets 1  (W44N22)
                          TOTAL 3 guards   (measured today: 10 / 96 parts)
```

Each corp's `sizing.targets` goes 3 -> 1; the surplus seven stand down through
`GUARD_RECYCLE_GRACE` (100t) and recycle, so the fleet drains over ~100-150t and
a +200t recapture covers it. Defense 10.65 -> ~3.2 e/t (under its 4.16 budget);
P4 1.01x -> ~0.99x (FAIL -> ok). **Downstream must NOT move on this alone** -
0.045 p/t is ~3% of the hauler shortfall; piles (32.34), forgone mining (80.31)
and the controller (9.84 vs 63.00) moving here would falsify the chain as
modelled, and would be reported as a miss.

## Audit cycle t73003513 -> t73006507 (2026-08-14): guard homing VERIFIED, and the mouth that asks and is never answered

**Post-deploy verification of the guard-homing binding (predictions made BEFORE
the deploy, checked here one by one).**

| prediction | actual | |
|---|---|---|
| `raidGuard-W43N23` targets 1 = W44N23 | targets 1 = **W44N23** | HIT (room-exact) |
| `raidGuard-W43N24` targets 1 = W43N25 | targets 1 = **W43N25** | HIT (room-exact) |
| `raidGuard-W43N21` targets 1 = W44N22 | gate `no-targets`, 0 | MISS - explained below |
| total guards 10 -> 3 | **2** | near-miss, same cause |
| parts 96 -> ~29 | **20** | near-miss, same cause |
| defense 10.65 -> ~3.2 e/t | **1.65 e/t** | overshot, same cause |
| P4 1.01x FAIL -> ~0.99x | **0.96x, FAIL -> WARN** | HIT - the plan is FEASIBLE again |

The duplication is gone: three corps that each stamped the identical 3-room
target set now hold one room each, disjointly, exactly as `nearestGuardHome`
binds them.

**The MISS is the code working, not the binding stranding a room.** W44N22's
meter reads `raidDebt 78,980 -> 8,350` with `lastRaidSeen` age falling
`8,844 -> 1,196`: a raid FIRED there ~1,200t ago (post-deploy), the sighting
zeroed the mirror as designed, and the room has only re-accrued 8,350 against a
65,000 ARM floor. W43N21's guard held the post, the raid came, the meter reset,
and the guard liquidated through its stand-down grace - the full designed
lifecycle in one window. The prediction assumed a static meter; meters are not
static. **Prediction error owned: it was a statement about the world, not about
the code, and the world moved.**

**Defense overshot low (1.65 vs ~3.2 predicted) for the same reason** - only two
rooms stayed armed, and the plan's own budget followed them down (4.16 -> 0.87),
so the line is still ~1.9x its budget on a much smaller base.

**The "downstream must NOT move" prediction FAILED, and is NOT claimed as a
win.** Forgone mining 80.31 -> 55.26 e/t and pile decay 32.34 -> 42.77 e/t both
moved hard. Confounds forbid attributing either to a 0.045 p/t guard fix: the
window is 4.2x shorter (12,475t -> 2,994t) and samples the post-deploy regime
only, the spec-50 sweep handicap ramped 0->5% across it, and mining capacity
fell 205 -> 200 as three W45N25 sources went `funded->embargoed` (P1). The
physically coherent reading is that MORE energy got mined (forgone down) and
hauling still could not drain it (more sitting on the ground, decaying up) -
which is the same chain as before, not a guard effect.

### The new work item, traced end to end: H3 `mining-W43N22-harvest-cd94`

A new ledger row fired, and it is the sharpest instance yet of the seam named
last cycle - one source, confirmed at BOTH captures:

```
H3 chronic mouth: cd94 buffer 2294 -> 6495 GROWING, zero drain creeps at both captures
```

Traced from symptom to root, every step a read:

1. **The plan is right.** cd94's commission declares `hauler: 32.12 parts /
   21.42 workingParts` on one route - `source-cd94 -> controller-4adbcd97` at
   **d=43**, and that sink is the CLAIM PUMP (priority 82, allocated 48 e/t).
2. **The corp is right, and it is ASKING.** Its inner haul stamp reads
   `carryNeeded 26, creeps 0, exit "asking", staged 6495`. Not a lens bug -
   unlike the guard, this corp raises the demand every tick. (It had haulers
   recently: `departs {full: 9}` since t73004257.)
3. **The NOW plan carries it, flagged maximally urgent**: `hauler
   mining-W43N22-harvest-cd94, minCost 300, mustFund true, blocking true` -
   and `gate: "queued"`, **fifth** in a chained-precondition wall behind
   ~7,100e of other must-fund buys (`after: ced6 <- d017 <- cee0 <- reserver`).
4. **The spawns cannot answer.** Spawn1/2/3 sit at **0.99 utilization** (ceiling
   0.333 p/t each) with idle attributed to `buy` latency alone.

So the ask is real, correctly priced, correctly ranked - and physically
unservable. The miner is held `buffer-full` at `heldFrac 0.996`.

### The root under that: the bank does not reach the hungry spawns

The colony is not short of energy. It is short of energy WHERE THE SPAWNS ARE:

| room | storage | energyAvailable | feederActive | spawn util |
|---|---|---|---|---|
| W43N23 | **998,850** | 8,200 | true | 0.99 x3 |
| W43N24 | 1,774 | **316** | true | 0.51 |
| W43N21 | none | **102** | false | 0.57 |

Spawn4 and Spawn5 idle on **`bank`** (556t and 421t of the window) - starved at
102-316 energy - while ~1M sits banked one room away and three spawns run
flat out. That is E4 (`idle capital 858,850 above reserve`) and P12
(`published 15.00 vs the law's cap 100.00`) meeting the throughput ceiling from
the other side: the pool's spare build capacity is in the poor rooms, and the
energy is in the rich one.

**Cycle verdict**: **fixed + verified** (guard homing - P4 FAIL -> WARN, the
plan feasible again at 0.96x; defense 10.65 -> 1.65 e/t; duplication 10 -> 2
bodies) + **named with data** (H3/cd94: the demand is asked, ranked mustFund
+blocking, and starved by spawn throughput; the throughput is idle in the two
rooms the bank never reaches). TOP LINE is unchanged and worse in rate: L1 pile
decay **42.77 e/t** (was 32.34). Fiscal FY4866-M10 and FY4867-M01 closed
(handicap 3-4%, sweep cycle 6).

**Explicitly NOT attempted**: the cross-room supply fix. It is a real change to
the bankfeed/cross-hub path, this cycle already shipped a live-behaviour change,
and the next cycle should start from a red test for "a spawn starved at 316e
while a bank one room away holds 998k" rather than from a hypothesis.
