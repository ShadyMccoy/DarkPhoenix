# 13 — Invader economics: keep the remotes flowing

**Status:** **LANDED 2026-07-17** (phases 0–5 implemented in one pass; only
phase 5's live CALIBRATION — replacing the derived tax constant with
measured raid P&L over ≥15k-tick live windows — remains open by nature).
Landed surface: scout mark-wipe fix (+ raid-meter carry-over); spec 07
towers (TowerRunner + RCL3 placement + tender feeding,
`tower-defense.test.ts` green); the raid meter
(`utils/raidMeter.ts`, exact mirror at `HarvestCorp` harvest site, reset on
Invader sighting); transit embargo (`routeRooms`/`routeIsDangerous`,
Carry/Harvest demand gates); `RaidGuardCorp` (pre-spawn off the 65k arm
floor, blocking+income at 105 after measured starvation/racing at lower
tiers, 100t quiet-grace recycle) — grid `def-t4-raid-guard-holds-the-remote`
green (guard fielded t1, engine-driven raid killed t165, miner never lost);
`CoreBusterCorp` kill+strip with the `invaderCorePresent` phase-flip
sighting — grid `def-t5-core-buster-reclaims-remote` green (core destroyed
t93, phase flip t94, striker engaging t193, defund held); the invader tax
(`invaderTaxPerEnergy` in primitives, per-source detector in
`buildColonyProblem`, subtracted in `selectProducers`); BlackBox
`mark`/`unmark`/`raid` rows + IntelTelemetry defense fields.
Deviation from the plan as written: the strip leg lives in
`CoreBusterCorp` as a second creep phase (CLAIM "striker"), not in
ReservationCorp — the reserver's targeting needs miners present, which an
occupied room by definition lacks; a self-contained two-phase mission
avoided touching ReservationCorp at all.

Original planning document follows.

**Plan status (original):** phased plan; research digest 2026-07-17.
Research pass 2026-07-17: vendored engine source
(`@screeps/engine` 4.3.2 / `@screeps/backend` 3.3.0 / `@screeps/common` 2.16.1 —
the same code the live servers and our mockup run) plus six public bots
(license ledger at the bottom). Every engine claim below was verified against
`node_modules` at the cited file:line.
**Owner directive (2026-07-17):** "mainly I just want to keep the remote
flowing. at home, we will build towers." This flips the spec-07/12 doctrine
for the NPC scope: remotes get a small guard corp instead of flight-only,
home rooms get spec 07's towers (un-deferred), and the core buster proceeds
with corrected math. Player-military and strongholds stay out of scope.
**Priority (proposed):** tranche 1 (phase 0 bugfix + towers) = P0/P1;
tranches 2–3 (meter + guard, core buster) = P1; tranche 4 (pricing +
telemetry) = P2.
**Relation to spec 12:** spec 12 phase 1 (flight) stays landed as the
*fallback* layer. Its phase 2 (fight) is superseded by phase 4 here, with
engine-ground-truth corrections.

## The problem

Invader raids make the live economy noisy: random-looking income dips in
remotes, bodies bought into kill windows, occupations that zero a room for
thousands of ticks. Spec 12 phase 1 defunds *after* a sighting — correct but
purely reactive, and flight prices every raid at ~1500 ticks of blackout.
Meanwhile **none of this noise is visible to our harness**: raid generation
lives exclusively in `@screeps/backend`'s wall-clock cronjobs (`genInvaders`,
every 300 real seconds — `@screeps/backend/lib/cronjobs.js:18`), which
screeps-server-mockup never runs (its `tick()` drives only the engine loop;
no backend process, no crons). So:

- The grid's measured ±20–30% draw variance (spec 08) contains **zero** invader
  contribution — invader noise is a **live-only effect class**, currently
  missing from CLAUDE.md's "sim blind spots" trap list.
- The mockup engine *does* accrue the raid fuse (`source.invaderHarvested`
  increments on every harvest — journey fixtures carry values like
  `"invaderHarvested": 20638`) — nothing ever consumes it. Staged invaders DO
  run the real engine raid AI (`@screeps/engine/src/processor.js:66-70,194-206`)
  — so guard-vs-invader grid cells are real fights.

## Ground truth: how raids actually work (engine source, verified)

The trigger is **your own harvesting**, metered per room:

1. **Counter** — every harvest intent adds the mined amount to the *source*:
   `invaderHarvested = (target.invaderHarvested || 0) + amount`
   (`engine/src/processor/intents/creeps/harvest.js:45-48`). Accrues in owned
   rooms too, from any harvester.
2. **Trigger** — `genInvaders` (backend cron, every 300 wall-clock seconds,
   `cronjobs.js:18,377-441`) sums the room's source counters and fires a raid
   when `sum >= (room.invaderGoal || INVADERS_ENERGY_GOAL 100000)`
   (`cronjobs.js:386-391`; constant `common/lib/constants.js:776`), subject to
   three gates:
   - **no live invader creeps** already in the room (`:381-384`) — raids never
     stack;
   - **sector gate**: a level>0 `invaderCore` (the sector stronghold, not a
     level-0 lesser core) must exist somewhere in the 10×10 sector
     (`:393-398`) — a stronghold-free sector pays **zero** raids;
   - **exit gate**: raids enter only at exits whose neighbor room's controller
     is neither owned nor reserved *by anyone* (`checkExit`, `:247-260`); if
     every exit is blocked the raid silently doesn't fire **and the counter is
     NOT reset** (`:426-428`) — blocking is deferral, not forgiveness.
3. **Reset + reroll** — after a raid: counters zeroed, next goal =
   `floor(100000 × U(0.7, 1.3))`, then a 10% branch multiplies by
   `Math.floor(rand > 0.5 ? 2 : 0.5)` — and `Math.floor(0.5) === 0`, a falsy
   goal that falls back to exactly 100k (`:433-438`). Effective distribution:
   **90% U(70k,130k), 5% U(140k,260k), 5% exactly 100k; E[energy/raid] ≈ 105k.**
   On respawn/placeSpawn the API sets `invaderGoal = 1,000,000` (10× grace,
   `backend/lib/game/api/game.js:399-402`).
4. **Raid composition is a static table, not an estimate**
   (`createRaid`, `cronjobs.js:320-375`) — and it scales with the *victim
   room's* status, not the attacker's colony. Reserved/unowned rooms (**all
   our remotes, forever**) get **10-part "small" bodies (1000 hits), ~90%
   solo**, T1 boost at 50% per creep; groups of 2–5 only on a 10% roll (or
   always in sector-center rooms, which also get T3 boosts — `utils.isCenter`,
   coords %10 ∈ 4..6); 50-part "big" bodies require the room to be **OWNED at
   RCL ≥ 4** — i.e. big raids arrive only after towers exist. The three small
   templates: melee (2T/5M/1RA/1W/1A, ~40 DPS adjacent), ranged (2T/5M/3RA,
   30 DPS, kites at range 3 — `invaders/findAttack.js:26-28`), healer (5M/5H,
   60 HPS, 120 with LO). Invader TTL is **1500** (`:281`); they never leave
   their room and suicide when nothing is reachable (`findAttack.js:82-89`).
5. **Occupation blocks income entirely** — `harvest.js:31` returns early when
   the room controller is reserved by another user: an invader-reserved room
   yields **0 e/tick to us**, not a throttled rate.
6. **Cores** — the sector stronghold plants defenseless **level-0 lesser
   cores** (100k hits, cannot spawn creeps — `INVADER_CORE_CREEP_SPAWN_TIME`
   is 0 for levels 0-1) in the nearest room with an unowned controller
   (player-*reserved* rooms are eligible) every `INVADER_CORE_EXPAND_TIME`
   4000..2000 ticks by stronghold level (`strongholds.js:238-331`). The core
   reserves at +2/tick to the 5000 cap and re-reserves continuously; its
   lifetime is inherited from the **parent stronghold's collapse timer**
   (67.5k–82.5k ticks from erection), so occupation is bounded by the parent,
   not by 5000 ticks. Killing a core does **NOT** clear the reservation
   (`invader-core/destroy.js:11-23`) — it decays at 1/tick from up to 5000,
   and `attackController` strips only `CLAIM_parts × 1` tick per attack from a
   *reservation* (`creeps/attackController.js:33-40`; the 300×/part
   `CONTROLLER_CLAIM_DOWNGRADE` applies only to owned controllers). A 2-CLAIM
   reserver grinds out a full reservation in ~1700 ticks (2/attack + 1
   natural decay per tick).

**Planner-shaped consequences:** raid *timing* is predictable from a counter
we can mirror exactly; raid *size* for remotes is a compile-time constant
that never grows; occupations are pure structure-grinding with a known strip
phase; and defense is cheap — a 650-energy guard versus ~10k+ energy of
blackout per absorbed raid. Fighting the NPC tier is the economically
dominant strategy for any remote worth mining; the flight layer remains as
the fallback for everything else.

## Survey: what public bots do about it

| Bot | Mechanism | What we take | License |
|---|---|---|---|
| **Overmind** (bencbartlett) | Per-room invasion clock: accrue harvested energy at source-regen boundaries, `isInvasionLikely` at 90k/75k/65k by source count (ported from bonzAI's InvaderGuru); **defender pre-spawn off the prediction**; defense commissioned only after 20 consecutive unsafe ticks, decommissioned after 100 quiet; analytic defender sizing (heal-vs-damage parity with 1.5× margin); casualty EMA charging only the **unamortized remainder** of a dead body | The clock (phase 1) and the pre-spawn move — executed better here because our meter is exact, not a regen-boundary proxy, and our lead time is the existing `deliveryLeadTime` contract. Their bug to avoid: `lastSeen > 20000` compares an absolute tick, permanently disabling prediction — use ages. Quiet-period decommission (100t) for the guard's recycle gate. Casualty amortization for phase 5 | MIT (verified stock, master + dev) |
| **The International** | `abandonRemote` = lowest attacker `ticksToLive` + jitter, set-with-max; **recursive abandonment through `pathsThrough`**; lesser cores answered with fixed cheap ATTACK/MOVE demand (8 parts/core) while income is zeroed **only when the reservation actually flips** | Transit-aware defunding (phase 1b); don't-panic-on-core-sighting — keep harvesting until the reservation actually flips (phase 4). Its remote-defender sizing is commented out on Main — the guards below fill the gap TI left | MIT |
| **Grey Company** (glitchassassin / Jon Winsley) | Per-remote-source double-entry `HarvestLedger` scored in 10×1500-tick windows, disable when avg < 0, retry after 100k; **budget classes: remote defense = ESSENTIAL, core-killing = EFFICIENCY** (storage-gated); remote defenders escalate one creep at a time to score parity | The budget split maps 1:1 onto our doctrine: the raid guard is producer-protecting spend (fund it), the core buster is warchest-gated (phase 4 gate). Measured ledgers feed phase 5's calibration. Windows ≥ 10×1500 to stay outside our ±20-30% draw variance | Unlicense (public domain) |
| **TooAngel** | `attackTimer` integrator (+1/−5) with escalation ladder; consumption gates under threat, producers keep running; **defenders self-recycle when threat clears**, spawn rate-limited; civilian corps file one-shot deduped defense tickets; flee is vestigial dead code | Guard self-liquidation with a quiet-period grace (phase 3) — refundable working capital, not standing army. The negative finding stands: skip per-creep flee AI | AGPL-3.0 — **ideas only, never port lines** |
| **screeps-quorum** | **Towers-only at home**: zero combat creep roles; towers fire unconditionally, replenisher refills under drain; remote raids → total withdrawal; throttled notify (3000t/message-hash) + dedupe-windowed aggression ledger | Validates the home-room half of the owner directive: spec 07's tower is the entire owned-room answer to NPCs. Alert/event-dedupe shapes for phase 5 | MIT |
| **bonzAI** | Original InvaderGuru (the 90k/75k/65k clock) + threshold defender pre-spawn | Semantics via Overmind's MIT port | **No license — ideas only** |

**Community-wide negative finding:** nobody pre-positions off an *exact*
mirror of the engine counter (all use the regen-boundary proxy or nothing),
and nobody prices guard amortization into remote selection. Both are cheap
for us because the meter increment point is our own `recordProduction` and
all economics land in `primitives.ts`.

## Design

### Phase 0 — P0 bug fix: the scout wipes the landed defund marks

`ScoutCorp.recordRoomIntel` (`src/corps/ScoutCorp.ts:253-267`) overwrites
`Memory.roomIntel[room]` with a fresh object literal that has **no
`hostileUntil` / `invaderReservedUntil` fields** — any scout visit (or the
passive ≥5000-stale re-record in `work()`, `ScoutCorp.ts:96-101`) erases the
spec-12 defund marks. They only survive today because the `hostileRooms()`
vision pass re-stamps next tick *while the room stays visible*; if vision
drops the same tick (scout leaves/dies), funding silently resumes for an
occupied room. The flight layer is the guard system's fallback, so it must
be airtight first.

Fix: `recordRoomIntel` carries the two mark fields over from the old entry
(the vision pass keeps sole authority for setting/clearing them).

**Acceptance (write first):**
- Unit (`scoutIntel.test.ts`): a re-record of a room whose old intel carries
  `hostileUntil`/`invaderReservedUntil` preserves both; a re-record with no
  old marks stays markless; the vision pass can still clear marks afterward.
- Regression gate: unit suite + `def-t3-invader-defunds-source` +
  `def-t5-invader-reservation-defunds-remote`.

### Phase 1 — home towers: un-defer spec 07 as written

The owner directive un-defers spec 07 for owned rooms. Its minimal design
(TowerRunner fires at closest hostile; ConstructionCorp places 1 tower at
RCL3 near the core; ExtensionTender feeds below 50%) needs no changes — the
engine facts guarantee sufficiency: owned rooms below RCL4 only ever face
10-part smalls (one tower one-shots the wave over a few ticks), and 50-part
big raids begin exactly at RCL4, after the tower exists. Quorum runs this
posture with zero combat creeps as validation. Acceptance tests are spec
07's, unchanged. Optional later hardening (NOT v1): Overmind's winnability
check (don't fire when healing outpaces tower+creep damage) matters only for
player drain attacks, not NPCs.

### Phase 2 — mirror the raid meter (raid-debt intel)

Mirror the engine's counter in intel — exactly, not by Overmind's
regen-boundary proxy, because the increment point is our own code:
`HarvestCorp.runHarvester` records `WORK × 2` per successful harvest
(`src/corps/HarvestCorp.ts:417-422`, `recordProduction`).

New `RoomIntel` fields (same lifecycle discipline as the spec-12 marks):

- `raidDebt?: number` — energy harvested by our corps in this room since the
  last observed raid. Incremented at the `recordProduction` call site (keyed
  by `creep.room.name`), written straight to Memory — **not** reconstructed
  from corp state, because corps churn on invader wipes
  (`Memory.commissionedCorps` drop path, `CommissionHost.ts:120-126`).
- `lastRaidSeen?: number` — stamped by the `hostileRooms()` vision pass when
  sighted hostiles include Invader-owned creeps; the same sighting resets
  `raidDebt` to 0 (the engine reset happened at raid-spawn time).
- Semantics: debt starts at 0 when we first mine a room (the engine counter
  may hold prior tenants' debt — the first raid can come early; the guard's
  reactive trigger and the spec-12 flight fallback cover surprises, and after
  the first observed raid the mirror is exact). `raidDebt > 130k` with no
  raid seen = `overdue`: evidence raids aren't firing here (sector-quiet or
  exits-blocked) — the guard disarms for that room and the state is logged
  for calibration.

**2b — transit-aware defunding (TI's `pathsThrough`, small and independent):**
`CarryCorp.getSpawnDemand` gates on the *pickup* room only
(`CarryCorp.ts:1083-1088`); a hauler route transiting a marked room is still
funded. Extend the demand gate: a route is defunded if **any room on its
cached path** is in `hostileRooms()`. (Seam: the route's rooms are derivable
from the cached `pathDistance` path used to build the edge.) Guards defend
their own room; transit rooms we don't mine still need the embargo.

**Acceptance (write first):**
- Unit: the debt reducer — increments on recorded harvest, resets on
  Invader-sighting, survives corp churn (write/read through Memory), `overdue`
  transition at >130k.
- Grid (fidelity pin, deterministic): stage a remote mine, run the window,
  assert `Memory.roomIntel[room].raidDebt` matches the sum of the db's real
  `source.invaderHarvested` deltas within hauling-lag tolerance — the mockup
  engine increments the true counter for free.
- Unit (2b): a two-hop route whose middle room is marked emits no hauler
  demand; pickup-room-only marking still defunds as today.

### Phase 3 — RaidGuardCorp: pre-spawned remote defense

The core of "keep the remote flowing". One guard corp kind, commissioned off
the raid clock so the guard is **standing at the source when the raid walks
in**, killing 10-part smalls in seconds; miners never stop, haulers never
stop, the hostile mark lifts on the guard's own all-clear sighting within a
few ticks. Economics: guard ≈ 650 energy + 30 ticks of spawn time per ~105k
harvested (< 1% of gross income) versus ~10k+ energy of blackout per raid
absorbed under flight — defense is ~15× cheaper for any remote worth mining.

Design (kind `raidGuard`, through the spec-00 framework, pattern of
`reservationKind`):

1. **Propose** — one corp per remote room the current draft plan mines (the
   `constructionKind` hybrid pattern: read the draft's harvest commissions,
   `constructionKind.ts:84-95`). A corp with no trigger and no creeps costs
   nothing.
2. **Demand trigger** (in `getSpawnDemand`, runtime state):
   - *Predictive*: `raidDebt ≥ RAID_ARM_FLOOR` (65k — one spawn+travel lead
     under the 70k goal floor; the crossing at ≥10 e/t gives ≥500 ticks of
     lead versus ~30+150 needed). Demand is emitted `deliveryLeadTime` early,
     the same contract miners use.
   - *Reactive fallback*: `hostileUntil` freshly stamped on a mined remote
     (surprise raids, unknown counter history).
   - *Disarm*: `overdue` rooms and rooms the plan stopped mining emit nothing.
3. **Body** — static table from the engine composition facts, no estimator:
   default `5×ATTACK/5×MOVE` (650, RCL3; 150 DPS beats every small template
   including a boosted healer's 120 HPS). A ranged variant (`3×RANGED/3×MOVE`,
   600) is the v1.1 answer to kiting smallRanged — v1 accepts that a kiter
   times out while the guard bodyguards the miner (invaders can't out-damage
   a guarded position: 30 ranged DPS < guard heal-free kill threshold on any
   engagement). Two-guard escalation only on an *observed* 2+ raid (the ~10%
   tail) — never precomputed armies.
4. **Lifecycle** — guard travels to its room, engages Invader-user hostiles
   (closest-first), holds near the source tiles; after the room is quiet for
   ~100 ticks (Overmind's decommission window) it recycles at the home spawn,
   refunding the TTL remainder (TooAngel's self-liquidation). Working
   capital, not a standing army.
5. **Demand value** — 105: below reserver 115 (income multiplier), above the
   hauler scale band's floor 90; it protects an active income stream but must
   never outbid the miner/first-hauler income tier (it doesn't — income tier
   is 1e6-tiered in `spawnPriority`, value only breaks ties within tiers).
   Never blocking, no `holdToFund` (650 is affordable at its RCL gate). Add
   the ladder-ordering unit test in the same commit (90-vs-85 lesson).
6. **Gate exemption** — the guard is military: EXEMPT from the
   `hostileRooms()` gate for its own target room (it exists to enter exactly
   the rooms the economy flees), same rule spec 12 phase 2 established.
7. **Wiring traps** (each has burned a session — confirmed at code): KINDS
   array (`CommissionHost.ts:49-61`), OrphanRescue `liveCorpIds`
   (`OrphanRescue.ts:83-93`), SpawnDirector `collectDemands` block
   (`SpawnDirector.ts:173-286`), `materialize` refreshes `spawnId`
   (conformance-enforced), new "guard" role plumbing (SpawnRole union,
   `SpawningCorp` role/workType maps + `buildBodyForRole`,
   `CreepMemory.workType`, `BodyBuilder` builder). **Recycling counts as
   staffing** — the guard's self-recycle must not double-order; count
   recycling guards via the same `staffsPost` lens as demand.

**Interaction with the flight layer:** unchanged and still live. Marks still
stamp on sightings; income-corp demand still gates on them. With a guard
fielded, the fight lasts a few ticks and the guard's standing vision lifts
the mark immediately — flight only actually bites where no guard was
commissioned (not-mined rooms, overdue rooms, guard dead on arrival), which
is exactly the intended defense-in-depth.

**Acceptance (write first):**
- Unit: arm-floor trigger table-driven (`raidDebt`, rate, lead time →
  demand/none); body picker vs observed raid subtype; quiet-period recycle
  decision; overdue disarm; ladder-ordering test (105 sits between 90 and 115
  and below every income-tier demand).
- Grid `def-t4-guard-holds-the-remote` (deterministic — we inject the raid):
  stage `raidDebt` near the floor via Memory + staged
  `source.invaderHarvested` (whole-object writes — the dotted-path `$set`
  no-op trap), mine to the crossing, inject one engine-faithful smallMelee
  (exact body from `cronjobs.js:266-273`, pinned `ageTime` as backstop) via
  `onTick`. Assert: the guard is fielded BEFORE the injection tick
  (pre-spawn, not reaction); the invader object disappears well before its
  `ageTime` (killed, not expired); no miner/hauler dies; the room's delivered
  energy over the window stays above a floor (the flow never stopped); the
  guard recycles after the quiet window; `raidDebt` reset on the sighting.
  Staged invaders run the real engine raid AI, so this is a real fight.
- Kind-conformance suite for `raidGuard`.
- Regression gate: standard trio + both def-t* cells (flight must be
  byte-identical when no guard is commissioned).

### Phase 4 — CoreBusterCorp: kill + strip (supersedes spec 12 phase 2)

Occupations, not raids, are the expensive event (income = 0 under a foreign
reservation, bounded by the parent stronghold's collapse timer — tens of
thousands of ticks). Spec 12 phase 2's design carries over with three
engine-ground-truth corrections (also noted in spec 12):

1. **Benefit is bigger**: eviction restores the room's FULL rate, not a 10-vs-5
   delta (`harvest.js:31`).
2. **The mission is kill + strip**: core death leaves the reservation
   decaying 1/tick from up to 5000. After the kill, ReservationCorp's
   reserver must `attackController` until clear (2-CLAIM ≈ 1700 ticks), then
   re-reserve — a `work()` branch on "controller reserved by Invader and no
   core present", plus the corrected payback gate reading both legs. A
   3-CLAIM body variant halves the strip when energy allows.
3. **It recurs**: the stronghold replants a lesser core every 2000–4000 ticks
   at the nearest unowned controller — our closest remotes to a sighted
   stronghold absorb them preferentially. The buster is a recurring chore
   priced per expansion cycle; remote-selection scoring should mildly
   penalize stronghold proximity. Per Grey Company's budget split, the
   buster is EFFICIENCY-class: commissioned only above a warchest floor,
   while the raid guard is ESSENTIAL-class.

Keep harvesting until the reservation actually flips (TI's insight) — a core
sighting alone must not defund; `invaderReservedUntil` (already landed)
remains the defund trigger.

**Acceptance (write first):** spec 12 phase 2's suite, extended: payback
table-driven off both legs (kill ticks + strip ticks vs full-rate blackout ×
remaining bound); grid `def-t5-core-buster-reclaims-remote` staging a real
`invaderCore` object (the engine processes hand-inserted cores — they renew
reservations) and asserting kill → strip → re-reserve → miner works the
source before window end.

### Phase 5 — price it, measure it

- **Primitives**: `INVADER_RAID_MEAN_ENERGY = 105_000` (derivation comment:
  90% U(70k,130k) + 5% doubled + 5% 100k); `invaderTaxPerEnergy(cost) =
  cost / INVADER_RAID_MEAN_ENERGY` where v1 cost = guard body + spawn-part
  price + expected buster amortization — now ~0.5-1% of gross, so it rarely
  flips a remote, but it keeps room ranking honest and prices the reservation
  **exit-blocking credit** (engine `checkExit`): reserving a neighbor that
  completes an all-exits-blocked set defers the tax entirely — a value input
  to the reservation decision, NOT a new sink value. Applied per-source via
  the `paved?`/`transient?` detector precedent in `buildColonyProblem`
  (`flowAdapter.ts:253-341`), subtracted at `CorpPlanner.ts:206`. The
  sink-value ladder is untouched.
- **Observability**: BlackBox gains `mark`/`unmark`/`raid` event kinds (room,
  bound, cause) — the vocabulary today is spawn|hold|churn|watch|gov|err only
  (`BlackBox.ts:25-31`); IntelTelemetry adds
  `hostileUntil`/`invaderReservedUntil`/`raidDebt` (currently omitted,
  `Telemetry.ts:635-666`).
- **Calibration**: per-remote income EMA through raid windows is THE success
  metric for phase 3 ("the remote kept flowing"); casualty accounting via
  Overmind's amortization (a vanished creep charges only its unamortized
  body remainder). Windows ≥ 10×1500 ticks per Grey Company and our own
  multi-draw rule.
- Doc fixes bundled here: CLAUDE.md sim-blind-spots gains "invader raids are
  live-only (mockup runs no backend crons)"; the command table's description
  of `sim:variance` ("multi-draw") is corrected — it is a single-draw
  plan-vs-actual gauge (`scripts/sim-variance.ts`); the multi-draw studies
  were repeated `ab-cold-start` invocations.

**Acceptance:** primitives pinned to 1e-9 incl. the tax and amortization
formulas; planner unit test (tax affects gate + ranking, never reorders
equal-gross flows); BlackBox emission tests; telemetry snapshot pin.

### Fallback appendix — scheduled flushes (kept, demoted)

For rooms not worth a guard (marginal margin, guard unaffordable, overdue
ambiguity), the counter still enables the pacifist trick no public bot
ships: suppress replacement spawns whose delivery lands past the 70k
crossing, align the crossing with a fleet-replacement boundary, and let the
raid trip against an empty room. One rule survives into the main path
regardless: **never staff a fresh fleet into an armed room** — reopening any
room with `raidDebt` at/above the arm floor starts with either a fielded
guard or a deliberate flush (walk-away debt never decays; `:426-428`).

## What we deliberately do NOT adopt

- **Per-creep flee AI** — TooAngel ships broken flee and thrives; guards +
  demand gating capture the value without pathing code.
- **DEFCON/threat enums and reputation ledgers** — two TTL-bounded marks +
  the meter + stock-sized consumers already produce the same behavior for
  NPCs; player-threat machinery is out of scope.
- **Strongholds and SK/center rooms** — ramparted, T3-boosted, RCL7+ squad
  territory; SK rooms stay excluded at graph level. Killing the sector
  stronghold (= sector-wide raid holiday for its remaining decay window +
  ruin-blocked respawn) is priced in the survey but stays specced-only.
- **Adaptive defender sizing** — the NPC threat table is static; bodies are
  compile-time constants, not estimators (Overmind's parity formula becomes
  relevant only if player defense is ever in scope).

## Harness notes (for whoever implements)

- Mockup never generates raids — every cell stages. Staged user-"2" creeps run
  the real engine raid AI; pin determinism with `ageTime` (existing pattern,
  `defense.ts:20`). `world.reset()` pre-seeds the Invader user. Staged
  `invaderCore` objects come alive too (reservation renewal, deploy timers).
- `source.invaderHarvested` accrues for real in the mockup — the phase-2
  fidelity cell diffs our mirror against the db's truth.
- Whole-object `$set` only (dotted paths silently no-op); staged controllers
  clear the `addBot` safeMode (stage.ts does this whenever `cell.controller`
  is present — any hostile cell must stage a controller).
- On a full backend server (not the mockup), `invaderGoal = 1` force-fires
  raids every cron pass and CLI `system.runCronjob('genInvaders')` triggers
  one manually — the E2E path if we ever stand up a full private server.

## License ledger (verified in each repo's LICENSE at pinned commits)

| Source | License | Code reuse |
|---|---|---|
| screeps/engine, backend-local, common | ISC | fine (we mirror formulas as facts) |
| bencbartlett/Overmind | MIT (stock, master+dev) | fine with notice |
| The-International-Open-Source | MIT | fine with notice |
| glitchassassin/screeps (Grey Company) | Unlicense | public domain |
| ScreepsQuorum/screeps-quorum | MIT | fine with notice |
| TooAngel/screeps | AGPL-3.0 | **ideas only — never port lines** |
| bonzaiferroni/bonzAI | none | **ideas only** (clock idiom available via Overmind's MIT port) |
| kasami/kasamibot | CC-BY-3.0 (docs repo) | n/a |
| jonwinsley.com posts | copyright retained | ideas with attribution |

Everything in this plan is reimplemented against our own primitives — no
line-copying is needed anywhere, which keeps the AGPL/unlicensed sources safe
as prior art.

## Rollout order and why

1. **Tranche 1 — phase 0 + phase 1** (scout mark-wipe fix; spec 07 towers
   un-deferred). Protects the landed fallback layer and closes the home-room
   half of the directive. Small, independent, low-risk.
2. **Tranche 2 — phase 2 + phase 3** (raid meter; RaidGuardCorp). The "keep
   the remote flowing" core: exact prediction + pre-spawned guards. This is
   where the live noise reduction lands — no more blackouts, no more bodies
   lost, raids become a <1% income line item.
3. **Tranche 3 — phase 4** (CoreBusterCorp kill + strip). Ends occupations,
   the single most expensive invader event class.
4. **Tranche 4 — phase 5** (pricing + telemetry). Turns derived constants
   into measured ones and makes the whole system visible on dashboards.

Success metric per the workflow: new def-t4/def-t5 cells green and ratcheted;
live validation = per-remote income EMA flat through observed raid windows
over a ≥15k-tick live sample.
