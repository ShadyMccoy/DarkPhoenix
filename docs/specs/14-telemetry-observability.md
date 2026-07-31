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
