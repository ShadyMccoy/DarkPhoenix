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

**SESSION HANDOFF 2026-07-21 (merge point; next session starts here).**

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
