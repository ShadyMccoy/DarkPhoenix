# 13 — Invader economics: predict, price, and schedule the raid tax

**Status:** PLANNED — this document is the research digest + phased plan; no code
landed. Research pass 2026-07-17: vendored engine source
(`@screeps/engine` 4.3.2 / `@screeps/backend` 3.3.0 / `@screeps/common` 2.16.1 —
the same code the live servers and our mockup run) plus six public bots
(license ledger at the bottom). Every engine claim below was verified against
`node_modules` at the cited file:line.
**Priority (proposed):** phase 0 = P0 (bug in landed spec-12 behavior);
phases 1–3 = P1 (the actual noise reduction); phase 4 = P2; phase 5 stays P3
with corrected math.
**Relation to spec 12:** spec 12 is the reactive layer (flight on sighting).
This spec is the *ex-ante* layer: raids are deterministic-enough to predict,
price, and schedule. Spec 12 phase 2 (fight) gets its economics corrected here.

## The problem

Invader raids make the live economy noisy: random-looking income dips in
remotes, bodies bought into kill windows, defund windows of unmeasured cost.
Spec 12 phase 1 defunds *after* a sighting — correct but purely reactive, so
every raid is paid at ambush prices. Meanwhile **none of this noise is visible
to our harness**: raid generation lives exclusively in `@screeps/backend`'s
wall-clock cronjobs (`genInvaders`, every 300 real seconds —
`@screeps/backend/lib/cronjobs.js:18`), which screeps-server-mockup never runs
(its `tick()` drives only the engine loop; no backend process, no crons). So:

- The grid's measured ±20–30% draw variance (spec 08) contains **zero** invader
  contribution — invader noise is a **live-only effect class**, currently
  missing from CLAUDE.md's "sim blind spots" trap list.
- The mockup engine *does* accrue the raid fuse (`source.invaderHarvested`
  increments on every harvest — journey fixtures carry values like
  `"invaderHarvested": 20638`) — nothing ever consumes it. Staged invaders DO
  run the real engine raid AI (`@screeps/engine/src/processor.js:66-70,194-206`).

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
   (`createRaid`, `cronjobs.js:320-375`): reserved/unowned rooms (all our
   remotes) get **10-part "small" bodies, ~90% solo**, T1 boost at 50%
   per creep; groups of 2–5 only on a 10% roll (or always in sector-center
   rooms, which also get T3 boosts — `utils.isCenter`, coords %10 ∈ 4..6);
   50-part "big" bodies require the room to be OWNED at RCL ≥ 4. Invader TTL
   is **1500** (`:281`); they never leave their room and suicide when nothing
   is reachable (`invaders/findAttack.js:82-89`).
5. **Occupation blocks income entirely** — `harvest.js:31` returns early when
   the room controller is reserved by another user: an invader-reserved room
   yields **0 e/tick to us**, not a throttled rate. (This corrects spec 12
   phase 2's "10 vs 5 e/tick" payback assumption — see phase 5.)
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
   reserver therefore needs ~1700 ticks to grind out a full reservation
   (2/attack + 1 natural decay per tick).

**Planner-shaped consequences:** raid frequency is proportional to harvest
throughput (a *per-energy tax*, E ≈ cost/105k); raid timing is *predictable*
from a counter we can mirror exactly; raid size for remotes is a compile-time
constant; and there are two structural off-switches (sector has no stronghold;
all exits owned/reserved) plus one deferral lever (stop harvesting below the
70k goal floor).

## Survey: what public bots do about it

| Bot | Mechanism | What we take | License |
|---|---|---|---|
| **Overmind** (bencbartlett) | Per-room invasion clock: accrue harvested energy at source-regen boundaries, `isInvasionLikely` at 90k/75k/65k by source count (ported from bonzAI's InvaderGuru); defender pre-spawn off the prediction; DEFCON gates consumer spend (construction/repair need `safe`); defense commissioned only after 20 consecutive unsafe ticks, decommissioned after 100 quiet; dev branch: outpost suspension with typed reasons + 5000t expiry; casualty EMA charging only the **unamortized remainder** of a dead body | The clock (phase 1), the amortized-casualty accounting (phase 4), suspension-with-expiry shape (phase 3). Their bug to avoid: `lastSeen > 20000` compares an absolute tick, permanently disabling prediction — use ages. **Negative finding:** master never proactively suspends mining before a predicted raid — prediction only feeds defenders. That gap is our main opportunity. | MIT (verified stock, master + dev) |
| **The International** | `abandonRemote` = lowest attacker `ticksToLive` + jitter, **set-with-max** semantics; **recursive abandonment through `pathsThrough`** (a remote is dead if its haul path transits a hostile room); `threatened` scalar: instant max-ratchet up, ×0.99999/tick decay down; lesser cores answered with fixed cheap ATTACK/MOVE demand while income is zeroed **only when the reservation actually flips** | TTL-bounded embargo we already have (spec 12); take **transit-aware defunding** (phase 1b) and don't-panic-on-core-sighting (phase 5). Their remote-defender sizing exists but is commented out on Main — live TI answers raids with pure avoidance, validating our doctrine. | MIT |
| **Grey Company** (glitchassassin / Jon Winsley) | Per-remote-source double-entry `HarvestLedger` (deposits − harvester spawn − hauler ticks − repair), scored in 10×1500-tick windows; disable when windowed avg < 0, retry after 100k ticks; `THREAT_TOLERANCE` ladder by RCL; **budget classes**: remote defense = ESSENTIAL, core-killing = EFFICIENCY (storage-gated surplus spend). Blog: remotes at RCL4 measured **net-negative to RCL5** (−6k ticks) because spawn time, not energy, is the binding constraint | Measured-not-vibes remote valuation (phase 4 feeds phase 2's tax constant); core-kill as a warchest-gated consumer (phase 5); windows ≥ 10×1500 to stay outside our own ±20-30% draw variance | Unlicense (public domain) |
| **TooAngel** | `attackTimer` integrator: +1/tick with hostiles, −5/tick without; ladder >15 defender, >50 gates upgraders/link routing, >100 safemode, >300 escalate; **consumption shuts off under threat, producers keep running**; civilian corps file one-shot deduped defense tickets; **flee is vestigial dead code** — losses absorbed, economy gated instead | The asymmetric integrator shape if we ever need a scalar (we likely don't — our TTL marks are already bounded); the negative finding: skip per-creep flee AI, gate demand instead (already our doctrine) | AGPL-3.0 — **ideas only, never port lines** |
| **screeps-quorum** | **Invaders as weather**: zero combat creep roles; towers fire unconditionally; raids in remotes → total withdrawal (miner/hauler/reservist demand → 0, no defense ever, wait out TTL); stock-based economy tiers (CRASHED..BURSTING) gate consumers so threat couples *implicitly* through lost income; throttled notify (3000t/message-hash) + dedupe-windowed aggression ledger | Strongest doctrinal match. Their withdrawal is our spec-12 defund; their implicit-coupling insight says our `sustainableConsumptionRate` already shrinks consumers after raids — assert it, don't rebuild it. Take the throttled-alert/event-dedupe shapes for phase 4 | MIT |
| **bonzAI** | Original InvaderGuru (the 90k/75k/65k clock Overmind ported) | Semantics via Overmind's MIT port | **No license — ideas only** |

**Community-wide negative finding:** no public bot deliberately meters its own
harvest to *schedule* raid crossings or park below the goal floor. Phase 3 is
novel territory — and it is pure planning, our home turf.

## Design

### Phase 0 — P0 bug fix: the scout wipes the landed defund marks

`ScoutCorp.recordRoomIntel` (`src/corps/ScoutCorp.ts:253-267`) overwrites
`Memory.roomIntel[room]` with a fresh object literal that has **no
`hostileUntil` / `invaderReservedUntil` fields** — any scout visit (or the
passive ≥5000-stale re-record in `work()`, `ScoutCorp.ts:96-101`) erases the
spec-12 defund marks. They only survive today because the `hostileRooms()`
vision pass re-stamps next tick *while the room stays visible*; if vision
drops the same tick (scout leaves/dies — exactly the vision-loss class from
CLAUDE.md's sim blind spots), funding silently resumes for an occupied room.

Fix: `recordRoomIntel` carries the two mark fields over from the old entry
(the vision pass keeps sole authority for setting/clearing them).

**Acceptance (write first):**
- Unit (`scoutIntel.test.ts`): a re-record of a room whose old intel carries
  `hostileUntil`/`invaderReservedUntil` preserves both; a re-record with no
  old marks stays markless; the vision pass can still clear marks afterward.
- Regression gate: unit suite + `def-t3-invader-defunds-source` +
  `def-t5-invader-reservation-defunds-remote`.

### Phase 1 — mirror the raid meter (raid-debt intel)

Mirror the engine's counter in intel — we can do it *exactly*, not by
Overmind's regen-boundary proxy, because the increment point is our own code:
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
  `raidDebt` to 0 (the engine reset happened at spawn time).
- Semantics: debt starts at 0 when we first mine a room (the engine counter
  may hold prior tenants' debt — accept that the *first* raid can come early;
  the spec-12 reactive defund already covers surprises, and after the first
  observed raid the mirror is exact). `raidDebt > 130k` with no raid seen =
  `overdue`: evidence that raids aren't firing here (sector-quiet or
  exits-blocked) — phase 3 scheduling disarms for that room, phase 2 tax
  stays (conservative), and the state is logged for calibration.

**1b — transit-aware defunding (TI's `pathsThrough`, small and independent):**
`CarryCorp.getSpawnDemand` gates on the *pickup* room only
(`CarryCorp.ts:1083-1088`); a hauler route transiting a marked room is still
funded. Extend the demand gate: a route is defunded if **any room on its
cached path** is in `hostileRooms()`. (Seam: the route's rooms are derivable
from the cached `pathDistance` path used to build the edge.)

**Acceptance (write first):**
- Unit: the debt reducer — increments on recorded harvest, resets on
  Invader-sighting, survives corp churn (write/read through Memory), `overdue`
  transition at >130k, no accrual for owned home rooms with a tower (see
  phase 2 scope).
- Grid (fidelity pin, deterministic): a cell that stages a remote mine, runs
  the window, then asserts `Memory.roomIntel[room].raidDebt` matches the sum
  of the db's real `source.invaderHarvested` deltas within hauling-lag
  tolerance — the mockup engine increments the true counter for free, so the
  mirror is directly checkable against ground truth.
- Unit (1b): a two-hop route whose middle room is marked emits no hauler
  demand; pickup-room-only marking still defunds as today.

### Phase 2 — price it: the invader tax in `primitives.ts`

Because raid frequency is proportional to harvested energy, expected raid
cost is a **per-energy coefficient** — exactly the shape the planner wants:

- `INVADER_RAID_MEAN_ENERGY = 105_000` (derivation comment: 90% U(70k,130k) +
  5% doubled + 5% 100k — engine `cronjobs.js:433-438`).
- `invaderTaxPerEnergy(expectedRaidCost: number): number` =
  `expectedRaidCost / INVADER_RAID_MEAN_ENERGY`.
- v1 `expectedRaidCost` for our no-military doctrine is the **absorb price**:
  ~1500 ticks (invader TTL) of the room's income blacked out + the flush/
  restaff churn, with bodies-lost ≈ 0 *assuming phase 0+3 landed* (we stop
  buying into the window; existing creeps mostly age out). Order of
  magnitude: a d=75 remote source nets ~7 e/t → one raid ≈ 10.5k energy of
  blackout → tax ≈ 0.1 e per e harvested (~1.4% of gross at rate 10, ~10% of
  *net*). Phase 4 replaces the assumption with the measured number.
- Application point — per-source, remote-only, following the exact
  `paved?`/`transient?`/`haulPos?` precedent: an optional `PlannerSource`
  field set by a detector in `buildColonyProblem`
  (`flowAdapter.ts:253-341`) reading RoomIntel, subtracted from `net` in
  `selectProducers` (`CorpPlanner.ts:206`) so it hits **both** the
  profitability gate and the net-per-part ranking. Owned rooms with a tower
  pay ~0 (towers absorb smalls for the energy cost of the shots); SK rooms
  are already excluded at graph level.
- **The sink-value ladder is untouched.** The tax is a producer-side cost
  term, not a sink value — no ladder ordering risk (the 90-vs-85 class of
  incident cannot occur here).
- The dormant `reserverTollPerRoom`/`reserveRoomWorthIt`
  (`src/corps/economics.ts:83-102`, unit-tested, never wired) is the existing
  per-room-cost template; the tax lands next to `netEnergy` in
  `economy/primitives.ts` per the one-home rule, with the conformance suite
  extended.
- **Reservation gains a tax credit** (engine `checkExit`): when reserving a
  neighbor room completes an all-exits-blocked set around a mined remote, the
  reservation's value includes the *deferred* raid tax of that remote (a value
  input to the reservation decision, NOT a new sink value). Optional; ship
  the tax first.

**Acceptance (write first):**
- Unit (`primitives.test.ts`): `invaderTaxPerEnergy` pinned to 1e-9; the
  105k constant's derivation table-tested.
- Unit (planner): a marginal remote source flips to unfunded when taxed; an
  equal-rate pair keeps its distance-driven order (the tax must never reorder
  equal-gross flows — by construction it can't; pin it anyway).
- Grid: `Memory.economyPlan` observability — the published roster carries the
  taxed net for remote mines (plan-vs-actual gets an honest denominator).

### Phase 3 — schedule it: raid crossings on our clock

The novel lever. The counter only advances when we harvest, and the raid only
fires at ≥70k — so **when the raid happens is our choice**. There is no
avoidance (debt never decays; ~one raid per ~100k harvested is a law), only
scheduling — plus the honesty that a walked-away room keeps its debt frozen
(`re-entry rule` below).

- **Armed window**: `raidDebt ≥ RAID_ARM_FLOOR` (65k — under the 70k goal
  floor by one spawn+travel lead, per bonzAI's margin logic) puts the room's
  income corps in *scheduled-defund* mode: `SpawnDirector` demands for
  replacement miners/haulers whose `deliveryLeadTime` would land them inside
  the predicted raid window are suppressed (reuses the spec-11 NOW-plan
  machinery — this is an agenda transition, not a GOAL-plan change; the
  planner still opens the mine, same non-vacuity doctrine as spec 12).
- **Flush**: the crossing is aligned to the fleet's replacement boundary —
  the last pre-window generation ages out, the raid trips against an empty
  room (or a single expendable runt), invaders find nothing, TTL out in
  ≤1500, `hostileUntil` (already landed) covers the tail, successors spawn
  on the all-clear. The raid still costs its blackout — but zero bodies, at
  a chosen time, with a known size (10-part small, 90% solo — the static
  composition table).
- **Re-entry rule** (walk-away liability): reopening any room whose
  `raidDebt` is at/above the arm floor *starts* with a flush — never staff a
  fresh fleet into an armed room. One check at commissioning time.
- **Traps that apply** (from the checklist, confirmed at code): suppressed
  corps must keep counting surviving creeps via the same `staffsPost` lens
  (churn loop otherwise); suspension must ride the existing `retiring`/
  commission flow so OrphanRescue's 25t grace doesn't recycle the fleet;
  recycling counts as staffing.

**Acceptance (write first):**
- Unit: the window scheduler — table-driven `(raidDebt, harvestRate,
  deliveryLeadTime) → suppress/allow` decisions; `overdue` rooms never arm;
  re-entry rule.
- Grid (deterministic — we inject the raid): stage `raidDebt` at 68k via
  Memory + staged source `invaderHarvested` (RoomBuilder `.obj()` passes
  arbitrary attributes verbatim; whole-object writes only — the dotted-path
  `$set` no-op trap), run mining to the crossing, inject one engine-faithful
  small invader (exact 10-part body from `cronjobs.js:266-273`, pinned
  `ageTime`) via `onTick`: assert **no replacement is bought into the
  window**, no fielded creep dies, funding resumes after TTL, and the debt
  resets on the sighting.
- Regression gate: standard trio + both def-t* cells (the reactive layer must
  be byte-identical when the scheduler is cold).

### Phase 4 — measure it: raid P&L, live calibration

Everything above runs on a derived constant until live data replaces it:

- **BlackBox** gains `mark`/`unmark` event kinds (room, bound, cause:
  creep|reservation|scheduled) — defund windows become measurable durations
  (today the marks never leave Memory; the event vocabulary is
  spawn|hold|churn|watch|gov|err only, `BlackBox.ts:25-31`).
- **IntelTelemetry** adds `hostileUntil`/`invaderReservedUntil`/`raidDebt`
  (currently omitted, `Telemetry.ts:635-666`) so dashboards can see the
  defund state that already exists.
- **Casualty accounting** (Overmind's amortization, tombstone-free): a corp
  creep that disappears with TTL ≫ its delivery lead charges the
  *unamortized remainder* of its body cost to its room's raid P&L — an old
  creep dying to an invader is nearly free, a newborn is a full loss. This
  is the correct marginal number for `expectedRaidCost`.
- **Windows**: per Grey Company and our own multi-draw rule, calibration
  windows are ≥ 10×1500 ticks; single-raid numbers are anecdotes.
- Doc fixes bundled here: CLAUDE.md sim-blind-spots gains "invader raids are
  live-only (mockup runs no backend crons)"; the command table's description
  of `sim:variance` ("multi-draw") is corrected — it is a single-draw
  plan-vs-actual gauge (`scripts/sim-variance.ts`); the multi-draw studies
  were repeated `ab-cold-start` invocations.

**Acceptance:** unit tests for the casualty amortization formula (primitives)
and the BlackBox event emission; a telemetry snapshot test pinning the new
intel fields.

### Phase 5 — fight economics, corrected (stays P3; replaces spec 12 phase 2 math)

Engine facts change the core-buster ledger materially:

- Income under occupation is **0**, not "throttled" (`harvest.js:31`) — the
  benefit of eviction is the room's full rate, bigger than spec 12 assumed.
- Killing the core does **not** restore income: the reservation survives and
  decays 1/tick from up to 5000; a CLAIM creep strips only claimParts×1 per
  attack (~1700 ticks for our 2-CLAIM reserver). The buster mission is
  therefore **kill + strip**: the attacker kills the core (100k hits,
  defenseless, deploy-invulnerability wait), then ReservationCorp's normal
  reserver *attacks* the controller before it can re-reserve. Payback window
  must count both legs.
- Occupation is bounded by the **parent stronghold's collapse timer** (up to
  ~82.5k ticks), not 5000 — "wait it out" is far more expensive than spec 12
  assumed, which *strengthens* the buster's case for high-value remotes.
- The stronghold replants a lesser core every 2000–4000 ticks somewhere in
  the sector (nearest unowned controller — our closest remotes to the
  stronghold absorb them preferentially), so busting is a recurring chore
  priced per expansion cycle, not one-and-done. Remote-selection scoring
  should mildly penalize proximity to a sighted stronghold room.
- Suppression levers priced but not built: stronghold kill = sector-wide raid
  holiday for the remaining decay window + ruin-blocked respawn (weight class
  far beyond P3 — leave specced); tower v1 stays spec 07.

## What we deliberately do NOT adopt

- **Per-creep flee AI** — TooAngel ships broken flee and thrives; Overmind's
  flee-with-drop is its weakest layer. Demand gating + scheduled windows
  capture the value without pathing code.
- **Defender corps for remotes** — military stays P3; quorum ships zero
  combat creeps successfully; TI's sizing code is commented out on Main.
  The static composition table means if this ever changes, defender sizing is
  a lookup, not an estimator.
- **DEFCON/threat enums and reputation ledgers** — our two TTL-bounded marks
  + the tax + stock-sized consumers (`sustainableConsumptionRate`) already
  produce quorum's implicit response; assert it in a cell before ever adding
  explicit threat state.

## Harness notes (for whoever implements)

- Mockup never generates raids — every cell stages. Staged user-"2" creeps run
  the real engine raid AI; pin determinism with `ageTime` (existing pattern,
  `defense.ts:20`). `world.reset()` pre-seeds the Invader user.
- `source.invaderHarvested` accrues for real in the mockup — the phase-1
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

0. Phase 0 (scout mark-wipe) — protects what spec 12 already paid for.
1. Phase 1 (+1b) — pure intel, zero behavior risk, enables everything else.
2. Phase 2 — one primitive + one detector; remotes get honest margins; the
   planner stops opening remotes whose margin was fictional (that alone
   removes a live noise source: marginal remotes that flap between profitable
   and raided).
3. Phase 3 — the scheduling win; the largest expected noise reduction
   (no bodies into kill windows, dips become planned maintenance).
4. Phase 4 — turns the derived tax constant into a measured one.
5. Phase 5 — deferred until the owner changes the military doctrine; the
   corrected math sits ready.
